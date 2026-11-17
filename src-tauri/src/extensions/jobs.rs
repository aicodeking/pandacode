//! Supported, explicitly authorized tools. Trusted code is not an OS sandbox.
use super::{context::{self, ContextBroker}, packages::ExtensionPackages, project_reads::{Authority, Directory}, supervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::Manager;

type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Scope { owner: String, version: String, digest: String, project: String, tool: String, handle: String }
struct Job { scope: Scope, cancel: Arc<AtomicBool>, state: &'static str, progress: Vec<Value>, result: Value, error: Option<&'static str> }
#[derive(Default)]
struct Registry { grants: BTreeMap<Scope, Authority>, jobs: BTreeMap<String, Job> }
#[derive(Default)]
pub struct ExtensionJobs(Arc<Mutex<Registry>>);
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request { Grant { tool: String, allow: bool }, Start { tool: String, args: Vec<String> }, Poll { tool: String, job: String }, Cancel { tool: String, job: String } }
impl Request { fn tool(&self) -> &str { match self { Self::Grant { tool, .. } | Self::Start { tool, .. } | Self::Poll { tool, .. } | Self::Cancel { tool, .. } => tool } } }
impl Registry {
    fn stop(&mut self, owner: Option<&str>, handle: Option<&str>) {
        let affected = |scope: &Scope| owner.is_none_or(|owner| scope.owner == owner) && handle.is_none_or(|handle| scope.handle == handle);
        self.grants.retain(|scope, _| !affected(scope));
        for job in self.jobs.values().filter(|job| affected(&job.scope)) { if job.state == "running" { job.cancel.store(true, Ordering::Release); } }
    }
    fn owned(&mut self, scope: &Scope, id: &str) -> Result<&mut Job> {
        self.jobs.get_mut(id).filter(|job| &job.scope == scope).ok_or("PermissionDenied")
    }
    fn settle(&mut self, id: &str, result: Result<Vec<Value>>) {
        if let Some(job) = self.jobs.get_mut(id).filter(|job| job.state == "running") {
            let error = if job.cancel.load(Ordering::Acquire) { Some("Cancelled") } else { result.err() };
            job.state = match error { None => "completed", Some("Cancelled") => "cancelled", Some("Timeout") => "timeout", _ => "failed" };
            job.error = error;
            if error.is_some() { job.result = Value::Null; }
        }
    }
}
impl ExtensionJobs {
    pub fn stop(&self, owner: Option<&str>, handle: Option<&str>) { if let Ok(mut state) = self.0.lock() { state.stop(owner, handle); } }
    /// The running jobs of each owner, each job once (the Running list and the quit account, R0107).
    pub fn running(&self) -> BTreeMap<String, usize> {
        let mut owners = BTreeMap::new();
        if let Ok(state) = self.0.lock() { for job in state.jobs.values().filter(|job| job.state == "running") { *owners.entry(job.scope.owner.clone()).or_default() += 1; } }
        owners
    }
}
fn dto(id: &str, job: &Job) -> Value { json!({"schemaVersion":1,"job":id,"state":job.state,"progress":job.progress,"result":job.result,"error":job.error}) }
fn arguments(tool: &Value, args: &[String]) -> Result<()> {
    if tool["executable"] != "node" || tool["cwd"] != "project" { return Err("UnsupportedCapability"); }
    if args.len() > tool["arguments"]["maxItems"].as_u64().ok_or("InvalidShape")? as usize || args.iter().any(|arg| arg.contains('\0') || arg.len() > tool["arguments"]["maxLength"].as_u64().unwrap_or(0) as usize) { return Err("InvalidShape"); }
    Ok(())
}
fn root(app: &tauri::AppHandle, project: &str) -> Result<PathBuf> {
    let state = app.state::<crate::AppState>(); let store = state.store.try_lock().map_err(|_| "Timeout")?;
    store.db.query_row("SELECT path FROM projects WHERE id=?1 AND length(path)<=4096", [project], |row| row.get::<_, String>(0)).map(PathBuf::from).map_err(|_| "NotFound")
}
pub(super) fn call(app: &tauri::AppHandle, handle: &str, raw: Value) -> Value {
    let result = (|| {
        if raw.to_string().len() > 8192 { return Err("LimitExceeded"); }
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        let snapshot = packages.snapshot();
        let (owner, version, captured) = app.state::<ContextBroker>().local_binding(app, &snapshot, handle)?;
        let project = captured["projectId"].as_str().filter(|id| !id.is_empty()).ok_or("PermissionDenied")?.to_owned();
        let manifest = &snapshot.packages.iter().find(|package| package.manifest["id"] == owner).ok_or("PermissionDenied")?.manifest;
        if !manifest["permissions"].as_array().is_some_and(|values| values.contains(&json!("tools.execute"))) { return Err("PermissionDenied"); }
        let tool = manifest["contributes"]["tools"].as_array().and_then(|tools| tools.iter().find(|tool| tool["id"] == request.tool() && tool["command"] == captured["commandId"])).ok_or("PermissionDenied")?;
        let (digest, source) = packages.executable_source(&owner).map_err(|_| "PermissionDenied")?;
        let scope = Scope { owner, version, digest, project, tool: request.tool().to_owned(), handle: handle.into() };
        let jobs = app.state::<ExtensionJobs>(); let mut state = jobs.0.try_lock().map_err(|_| "Timeout")?;
        match request {
            Request::Grant { allow, .. } => {
                if allow {
                    if state.grants.len() >= 128 { return Err("LimitExceeded"); }
                    state.grants.insert(scope.clone(), Authority::grant(&root(app, &scope.project)?)?);
                } else {
                    state.grants.remove(&scope);
                    for job in state.jobs.values().filter(|job| job.scope == scope && job.state == "running") { job.cancel.store(true, Ordering::Release); }
                }
                Ok(Value::Null)
            }
            Request::Start { args, .. } => {
                arguments(tool, &args)?;
                let directory = state.grants.get(&scope).ok_or("PermissionDenied")?.directory(&root(app, &scope.project)?)?;
                if state.jobs.values().filter(|job| job.state == "running").count() >= 8 { return Err("Conflict"); }
                if state.jobs.len() >= 64 { let old = state.jobs.iter().find(|(_, job)| job.state != "running").map(|(id, _)| id.clone()).ok_or("LimitExceeded")?; state.jobs.remove(&old); }
                let runtime = runtime(app)?;
                let id = uuid::Uuid::new_v4().to_string(); let cancel = Arc::new(AtomicBool::new(false));
                state.jobs.insert(id.clone(), Job { scope, cancel: cancel.clone(), state: "running", progress: Vec::new(), result: Value::Null, error: None });
                let mut context = captured; context["job"] = json!({"tool":tool["id"],"args":args});
                let timeout = Duration::from_millis(tool["timeoutMs"].as_u64().ok_or("InvalidShape")?);
                let registry = jobs.0.clone(); let job_id = id.clone();
                tauri::async_runtime::spawn(async move { execute(registry, job_id, runtime, source, context, cancel, directory, timeout).await; });
                Ok(dto(&id, state.jobs.get(&id).ok_or("HostUnavailable")?))
            }
            Request::Poll { job, .. } => Ok(dto(&job, state.owned(&scope, &job)?)),
            Request::Cancel { job, .. } => { let entry = state.owned(&scope, &job)?; if entry.state == "running" { entry.cancel.store(true, Ordering::Release); } Ok(dto(&job, entry)) }
        }
    })();
    match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => context::failure(code) }
}
fn runtime(app: &tauri::AppHandle) -> Result<supervisor::Runtime> {
    let path = app.path().resource_dir().map_err(|_| "UnsupportedRuntime")?.join("extension-runtime");
    supervisor::Runtime::packaged(&path).or_else(|error| {
        if cfg!(debug_assertions) { supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")) } else { Err(error) }
    })
}
#[allow(clippy::too_many_arguments)]
async fn execute(registry: Arc<Mutex<Registry>>, id: String, runtime: supervisor::Runtime, source: String, context: Value, cancel: Arc<AtomicBool>, directory: Directory, timeout: Duration) {
    let result = supervisor::run_owned(&runtime, &source, context, cancel, &directory.path, timeout, |method, value| {
        let result = (|| {
            let mut state = registry.try_lock().map_err(|_| "Timeout")?;
            let job = state.jobs.get_mut(&id).ok_or("NotFound")?;
            if job.cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
            match method {
                "jobProgress" if job.progress.len() < 32 && value.to_string().len() <= 512 => { job.progress.push(value); Ok(()) },
                "jobResult" if value.to_string().len() <= 8192 => { job.result = value; Ok(()) },
                "jobProgress" | "jobResult" => Err("LimitExceeded"),
                _ => Err("UnsupportedCapability"),
            }
        })();
        match result { Ok(()) => json!({"ok":true,"value":null}), Err(code) => context::failure(code) }
    }).await;
    if let Ok(mut state) = registry.lock() { state.settle(&id, result); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn job_authority_is_invocation_scoped() {
        let a = scope("sample.tool", "A");
        let mut b = a.clone(); b.handle = "another-invocation".into();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut registry = Registry::default();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        registry.grants.insert(a.clone(), Authority::grant(root).unwrap());
        assert!(!registry.grants.contains_key(&b));
        registry.grants.insert(b.clone(), Authority::grant(root).unwrap());
        registry.jobs.insert("owned".into(), Job { scope: a.clone(), cancel: cancel.clone(), state: "running", progress: vec![], result: Value::Null, error: None });
        assert!(registry.owned(&b, "owned").is_err());
        registry.stop(None, Some(&b.handle)); assert!(!cancel.load(Ordering::Acquire));
        assert!(registry.grants.contains_key(&a)); assert!(!registry.grants.contains_key(&b));
        registry.stop(None, Some(&a.handle)); assert!(cancel.load(Ordering::Acquire));
        assert!(registry.grants.is_empty());
    }
    fn scope(owner: &str, project: &str) -> Scope { Scope { owner: owner.into(), project: project.into(), version: "1".into(), digest: "digest".into(), tool: "test".into(), handle: "invocation".into() } }
    #[test]
    fn forged_pid_cross_owner_project_and_terminal_races_are_rejected() {
        let mut registry = Registry::default(); let a = scope("a", "A"); let cancel = Arc::new(AtomicBool::new(false));
        registry.jobs.insert("opaque".into(), Job { scope: a.clone(), cancel: cancel.clone(), state: "running", progress: vec![], result: json!("pending"), error: None });
        let unrelated = Arc::new(AtomicBool::new(false));
        registry.jobs.insert("unrelated".into(), Job { scope: scope("core.agent", "A"), cancel: unrelated.clone(), state: "running", progress: vec![], result: Value::Null, error: None });
        for (scope, id) in [(scope("b", "A"), "opaque"), (scope("a", "B"), "opaque"), (a.clone(), "1234")] { assert!(registry.owned(&scope, id).is_err()); }
        registry.stop(Some("b"), None); assert!(!cancel.load(Ordering::Acquire));
        registry.stop(Some("a"), None); registry.settle("opaque", Ok(vec![])); registry.settle("opaque", Err("Timeout"));
        assert!(!unrelated.load(Ordering::Acquire)); assert_eq!(registry.jobs["unrelated"].state, "running");
        let job = registry.owned(&a, "opaque").unwrap(); assert_eq!(job.state, "cancelled"); assert_eq!(job.error, Some("Cancelled")); assert!(job.result.is_null());
    }
    /// R0107: the Running list and the quit account count each running job once, per owner; settled jobs are gone.
    #[test]
    fn running_jobs_are_counted_once_per_owner() {
        let jobs = ExtensionJobs::default();
        assert!(jobs.running().is_empty());
        {
            let mut registry = jobs.0.lock().unwrap();
            for (id, owner, state) in [("1", "a", "running"), ("2", "a", "running"), ("3", "a", "completed"), ("4", "b", "running"), ("5", "c", "cancelled")] {
                registry.jobs.insert(id.into(), Job { scope: scope(owner, "A"), cancel: Arc::default(), state, progress: vec![], result: Value::Null, error: None });
            }
        }
        assert_eq!(jobs.running(), BTreeMap::from([("a".to_owned(), 2), ("b".to_owned(), 1)]));
        jobs.0.lock().unwrap().settle("4", Ok(vec![]));
        assert_eq!(jobs.running(), BTreeMap::from([("a".to_owned(), 2)]));
    }
    #[test]
    fn structured_arguments_never_become_executable_or_cwd() {
        let tool = json!({"executable":"node","cwd":"project","arguments":{"maxItems":2,"maxLength":1024}});
        assert!(arguments(&tool, &["a; $(whoami) & echo pwned".into(), "--eval=bad".into()]).is_ok());
        assert!(arguments(&tool, &["nul\0bad".into()]).is_err());
        for (key, value) in [("executable", "cmd.exe"), ("executable", "../node"), ("cwd", "../other")] { let mut bad = tool.clone(); bad[key] = json!(value); assert!(arguments(&bad, &[]).is_err()); }
        assert!(serde_json::from_value::<Request>(json!({"op":"cancel","tool":"a","job":"x","pid":1234})).is_err());
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn native_jobs_literal_arguments_progress_limits_timeout_and_owned_tree_cancellation() {
        use windows::Win32::{Foundation::{CloseHandle, HANDLE}, System::Threading::{OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
        let runtime = supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let source = include_str!("../../../tests/fixtures/extensions/test-runner/main.cjs");
        let tool = "sample.test-runner/test";
        let registry = Arc::new(Mutex::new(Registry::default()));
        for (argument, expected) in [("literal; $(whoami) & --eval=bad", "completed"), ("wait", "timeout"), ("flood", "failed"), ("result-flood", "failed"), ("progress-flood", "failed")] {
            let id = uuid::Uuid::new_v4().to_string(); let cancel = Arc::new(AtomicBool::new(false));
            registry.lock().unwrap().jobs.insert(id.clone(), Job { scope: scope("sample.test-runner", "A"), cancel: cancel.clone(), state: "running", progress: vec![], result: Value::Null, error: None });
            let directory = Authority::grant(root).unwrap().directory(root).unwrap();
            execute(registry.clone(), id.clone(), runtime.clone(), source.into(), json!({"job":{"tool":tool,"args":[argument]}}), cancel, directory, Duration::from_millis(1000)).await;
            let state = registry.lock().unwrap(); let job = state.jobs.get(&id).unwrap();
            assert_eq!(job.state, expected); assert!(job.progress.len() <= 32);
            if expected == "completed" { assert_eq!(job.result["args"], json!([argument])); assert_eq!(job.result["passed"], 1); assert_eq!(std::fs::canonicalize(job.result["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(root).unwrap()); }
        }
        // Open a handle to the actual supervised descendant before cancellation, so PID reuse
        // cannot make this assertion refer to an unrelated process. No taskkill/PID API used.
        let cancel = Arc::new(AtomicBool::new(false)); let signal = cancel.clone(); let mut descendant: Option<HANDLE> = None;
        let tree = "exports.tools={'tree':async(a,j)=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await j.progress(c.pid);return new Promise(()=>{});}};";
        let unrelated_cancel = Arc::new(AtomicBool::new(false));
        let unrelated = supervisor::run(&runtime, "exports.activate=async()=>{await new Promise(r=>setTimeout(r,500));};", Value::Null, unrelated_cancel.clone(), |_, _| panic!("no API expected"));
        let owned = supervisor::run_owned(&runtime, tree, json!({"job":{"tool":"tree","args":[]}}), cancel, root, Duration::from_secs(2), |method, value| {
            assert_eq!(method, "jobProgress");
            descendant = Some(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, value.as_u64().unwrap() as u32) }.unwrap());
            signal.store(true, Ordering::Release); json!({"ok":true,"value":null})
        });
        let (owned, unrelated) = tokio::join!(owned, unrelated);
        assert_eq!(owned.unwrap_err(), "Cancelled"); assert!(unrelated.is_ok()); assert!(!unrelated_cancel.load(Ordering::Acquire));
        let handle = descendant.expect("descendant must start before cancellation"); let mut exit = 259;
        unsafe { GetExitCodeProcess(handle, &mut exit).unwrap(); CloseHandle(handle).unwrap(); }
        assert_ne!(exit, 259, "owned descendant survived termination");
    }
}
