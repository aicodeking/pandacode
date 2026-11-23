//! Native Google Colab tools for local agents, once the user signed in to Colab and left
//! native tools on (Settings → Cloud): see runtimes, create and stop them, run Python on a
//! runtime's persistent Jupyter kernel, run shell commands over SSH, and move files. Status
//! is free; everything else asks like other host tools. Local paths stay inside the task's
//! checkout.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

use super::colab::{self, activity, jupyter, Colab};
use super::Machine;
use crate::agent_tools::{spec, validate_spec};
use crate::providers::ToolHost;

const PREFIX: &str = "pandacode_colab_";
const READ_ONLY: [&str; 1] = ["pandacode_colab_status"];
const DEFAULT_TIMEOUT: u64 = 120;
/// Under the per-run MCP server's `tool_timeout_sec` (360) with the host's grace added.
const MAX_TIMEOUT: u64 = 300;
/// What the host allows a Colab call beyond its own `timeoutSeconds` (replies, transfers).
const HOST_GRACE: u64 = 30;
/// What creating a runtime can add (Colab's assignment wait).
const CREATE_ALLOWANCE: u64 = 180;
/// The host's bounds for a Colab call: never under the usual floor for slow runtimes, never
/// past Codex's per-run `tool_timeout_sec` (360).
const HOST_MIN: u64 = 180;
const HOST_MAX: u64 = 350;
/// Text returned per stream; a long log keeps its end.
const OUTPUT_CAP: usize = 64 * 1024;
/// The text beside an inline plot: the host refuses an image reply whose text passes 8 KiB.
const IMAGE_TEXT_MAX: usize = 8000;
/// The largest checkout file read as code.
const SOURCE_MAX: u64 = 4 << 20;
const CONTENT: &str = "/content";

pub fn catalog() -> Vec<Value> {
    let runtime = json!({"type":"string","maxLength":200,"description":"Runtime id or name; default: the only one."});
    let timeout = json!({"type":"integer","description":"1–300, default 120."});
    vec![
        spec("colab_status", "Google Colab: active runtimes (id, name, hardware, browserUrl), compute units, default hardware.", json!({}), &[]),
        spec("colab_manage", "Colab runtimes: create (gpu or tpu, highMem; spends compute units, confirm first), stop (ends it; files are lost), restart_kernel, open_browser.", json!({
            "action":{"type":"string","enum":["create","stop","restart_kernel","open_browser"]},
            "runtime":runtime,
            "name":{"type":"string","maxLength":64},
            "gpu":{"type":"string","enum":colab::GPUS},
            "tpu":{"type":"string","enum":colab::TPUS},
            "highMem":{"type":"boolean"}}), &["action"]),
        spec("colab_run_python", "Run Python on a Colab runtime's persistent Jupyter kernel (state persists): code, or a checkout .py/.ipynb file. Returns stdout, stderr, result, error; a plot comes back as an image, or saved to outputImage (checkout path).", json!({
            "code":{"type":"string","maxLength":100000},
            "file":{"type":"string","maxLength":1024},
            "runtime":runtime.clone(),
            "autoCreate":{"type":"boolean","description":"No runtime: create one."},
            "timeoutSeconds":timeout.clone(),
            "outputImage":{"type":"string","maxLength":1024}}), &[]),
        spec("colab_exec", "Shell command on a Colab runtime (root, in /content) over SSH. Returns exit code, stdout, stderr.", json!({
            "command":{"type":"string","maxLength":8192},
            "runtime":runtime.clone(),
            "timeoutSeconds":timeout}), &["command"]),
        spec("colab_files", "Colab runtime files: list, upload (localPath to remotePath), download (remotePath to localPath), delete. localPath is in the checkout; remotePath defaults to /content.", json!({
            "action":{"type":"string","enum":["list","upload","download","delete"]},
            "runtime":runtime,
            "remotePath":{"type":"string","maxLength":4096},
            "localPath":{"type":"string","maxLength":1024}}), &["action"]),
    ]
}

/// The tools while Colab is connected with native tools on (for the integrations list).
pub fn enabled_catalog() -> Vec<Value> {
    if colab::is_connected() && colab::native_tools_enabled() { catalog() } else { Vec::new() }
}

fn string(args: &Value, key: &str) -> Option<String> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}
fn timeout(args: &Value) -> Duration {
    Duration::from_secs(args["timeoutSeconds"].as_u64().unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT))
}

/// How long a tool host lets a Colab call run, or `None` for its usual limit: the call's own
/// `timeoutSeconds` plus a grace, plus the assignment wait when it creates a runtime. Status
/// answers quickly and keeps the usual limit.
pub(crate) fn host_timeout(name: &str, args: &Value) -> Option<Duration> {
    if !name.starts_with(PREFIX) || READ_ONLY.contains(&name) {
        return None;
    }
    let creates = (name == "pandacode_colab_manage" && args["action"] == "create") || args["autoCreate"] == true;
    let seconds = match name {
        // Transfers carry no timeout of their own: give them the most.
        "pandacode_colab_files" => HOST_MAX,
        _ => timeout(args).as_secs() + HOST_GRACE + if creates { CREATE_ALLOWANCE } else { 0 },
    };
    Some(Duration::from_secs(seconds.clamp(HOST_MIN, HOST_MAX)))
}

/// The end of a long text, marked as cut.
fn tail(text: &str) -> String {
    tail_to(text, OUTPUT_CAP)
}
/// The last `cap` bytes of a text (at a character boundary), marked as cut.
fn tail_to(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let start = (text.len() - cap..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
    format!("[…first {} bytes cut]\n{}", start, &text[start..])
}

fn alive(stopped: &AtomicBool) -> Result<(), String> {
    if stopped.load(Ordering::SeqCst) { Err("Task has stopped.".into()) } else { Ok(()) }
}

fn endpoint(machine: &Machine) -> String {
    machine.id.trim_start_matches("colab:").to_string()
}

/// The runtime an argument names (endpoint, `colab:<endpoint>` or name), else the only one.
pub(crate) fn resolve(machines: &[Machine], wanted: Option<&str>) -> Result<String, String> {
    let names = || machines.iter().map(|m| format!("{} ({})", m.name, m.id)).collect::<Vec<_>>().join(", ");
    match wanted {
        Some(wanted) => {
            let bare = wanted.strip_prefix("colab:").unwrap_or(wanted);
            machines.iter().find(|m| endpoint(m) == bare || m.name == wanted).map(endpoint).ok_or_else(|| {
                if machines.is_empty() { format!("No Colab runtime named {wanted}; none is active.") } else { format!("No Colab runtime named {wanted}. Active: {}.", names()) }
            })
        }
        None => match machines {
            [one] => Ok(endpoint(one)),
            [] => Err("No Colab runtime is active. Create one with pandacode_colab_manage (action create), or pass autoCreate.".into()),
            _ => Err(format!("Several Colab runtimes are active; pass runtime: {}.", names())),
        },
    }
}

/// The accelerator (gpu or tpu, else the default) and High-RAM choice for a new runtime.
pub(crate) fn hardware(args: &Value, defaults: (String, bool)) -> Result<(String, bool), String> {
    let accelerator = match (string(args, "gpu"), string(args, "tpu")) {
        (Some(_), Some(_)) => return Err("Choose gpu or tpu, not both.".into()),
        (Some(gpu), None) => gpu,
        (None, Some(tpu)) => tpu,
        (None, None) => defaults.0,
    };
    Ok((accelerator, args["highMem"].as_bool().unwrap_or(defaults.1)))
}

/// Git's own folder: its hooks and config run code, so no Colab file goes in or comes out.
fn is_git(component: Component) -> bool {
    matches!(component, Component::Normal(name) if name.to_str().is_some_and(|name| name.eq_ignore_ascii_case(".git")))
}
fn git_refusal(path: &str) -> String {
    format!("{path} is inside .git; Colab tools never read or write Git's own files.")
}

/// A checkout-relative path with nothing that could climb out of it, nor into `.git`.
fn relative(path: &str) -> Result<&Path, String> {
    let relative = Path::new(path.trim());
    if path.trim().is_empty() || path.contains('\0') || relative.is_absolute() || relative.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err(format!("{path} must be a path inside the checkout."));
    }
    if relative.components().any(is_git) {
        return Err(git_refusal(path));
    }
    Ok(relative)
}

/// A resolved path inside the canonical `root`, outside its `.git` (a symlink can point there).
fn within(root: &Path, real: &Path) -> bool {
    real.strip_prefix(root).is_ok_and(|rest| !rest.components().any(is_git))
}

fn canonical_root(checkout: &Path) -> Result<PathBuf, String> {
    checkout.canonicalize().map_err(|_| "This task's folder is unknown.".to_string())
}

/// An existing file inside the checkout (symlinks resolved).
pub(crate) fn inside_file(checkout: &Path, path: &str) -> Result<PathBuf, String> {
    let root = canonical_root(checkout)?;
    let real = checkout.join(relative(path)?).canonicalize().map_err(|_| format!("{path} does not exist in the checkout."))?;
    if !within(&root, &real) || !real.is_file() {
        return Err(format!("{path} must be a file inside the checkout."));
    }
    Ok(real)
}

/// Refuses a target that exists as anything but a plain file (a symlink above all).
fn plain_or_missing(target: &Path, path: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => Err(format!("{path} exists and is not a plain file.")),
        _ => Ok(()),
    }
}

/// Where to write a file inside the checkout: the nearest existing folder must resolve
/// inside it, and an existing target must be a plain file there (never a symlink out).
/// The write itself goes through `write_inside`, which checks again.
pub(crate) fn inside_output(checkout: &Path, path: &str) -> Result<PathBuf, String> {
    let root = canonical_root(checkout)?;
    let target = root.join(relative(path)?);
    let outside = || format!("{path} must be a path inside the checkout.");
    plain_or_missing(&target, path)?;
    let parent = target.parent().ok_or_else(outside)?;
    let existing = parent.ancestors().find(|dir| dir.exists()).ok_or_else(outside)?;
    if !within(&root, &existing.canonicalize().map_err(|_| outside())?) {
        return Err(outside());
    }
    std::fs::create_dir_all(parent).map_err(|_| format!("Could not create the folder for {path}."))?;
    if !within(&root, &parent.canonicalize().map_err(|_| outside())?) {
        return Err(outside());
    }
    Ok(target)
}

/// Writes `bytes` to `target` (from `inside_output`) after a long remote run: the folder is
/// resolved again and must still be inside the checkout, the bytes go to a fresh temp file
/// there (never through a symlink), and the rename happens only while the target is still
/// missing or a plain file. A folder or target swapped for a symlink during the run is refused.
pub(crate) fn write_inside(checkout: &Path, target: &Path, bytes: &[u8], path: &str) -> Result<(), String> {
    use std::io::Write;
    let root = canonical_root(checkout)?;
    let outside = || format!("{path} must be a path inside the checkout.");
    let name = target.file_name().ok_or_else(outside)?;
    let parent = target.parent().ok_or_else(outside)?.canonicalize().map_err(|_| outside())?;
    if !within(&root, &parent) {
        return Err(outside());
    }
    let dest = parent.join(name);
    plain_or_missing(&dest, path)?;
    let temp = parent.join(format!(".{}.pandacode-{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let written = options.open(&temp).and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()));
    let placed = written.map_err(|_| format!("Could not write {path}.")).and_then(|_| {
        // The folder or the target may have been swapped while the bytes were written.
        let still = parent.canonicalize().map_err(|_| outside())?;
        if still != parent || !within(&root, &still) {
            return Err(outside());
        }
        plain_or_missing(&dest, path)?;
        std::fs::rename(&temp, &dest).map_err(|_| format!("Could not write {path}."))
    });
    if placed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    placed
}

/// A notebook's code cells, in order, as one program.
pub(crate) fn notebook_code(text: &str) -> Result<String, String> {
    let notebook: Value = serde_json::from_str(text).map_err(|_| "That notebook is not readable JSON.".to_string())?;
    let cells: Vec<String> = notebook["cells"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|cell| cell["cell_type"] == "code")
        .map(|cell| match &cell["source"] {
            Value::String(source) => source.clone(),
            Value::Array(lines) => lines.iter().filter_map(Value::as_str).collect(),
            _ => String::new(),
        })
        .filter(|source| !source.trim().is_empty())
        .collect();
    if cells.is_empty() {
        return Err("That notebook has no code cells.".into());
    }
    Ok(cells.join("\n\n"))
}

fn source(checkout: &Path, file: &str) -> Result<String, String> {
    let path = inside_file(checkout, file)?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > SOURCE_MAX {
        return Err(format!("{file} is too large to run as code."));
    }
    let text = std::fs::read_to_string(&path).map_err(|_| format!("Could not read {file} as text."))?;
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("py") => Ok(text),
        Some("ipynb") => notebook_code(&text),
        _ => Err("file must be a .py or .ipynb file.".into()),
    }
}

/// A run's report with every text cut to its last `cap` bytes.
fn report_with(runtime: &str, output: &jupyter::Output, cap: usize, created: bool) -> Value {
    let mut report = json!({
        "runtime": format!("colab:{runtime}"),
        "stdout": tail_to(&output.stdout, cap),
        "stderr": tail_to(&output.stderr, cap),
        "result": tail_to(&output.results.join("\n"), cap),
        "timedOut": output.timed_out,
        "images": output.images.len(),
    });
    if let Some(error) = &output.error {
        report["error"] = json!({"name": tail_to(&error.name, cap.min(200)), "value": tail_to(&error.value, cap), "traceback": tail_to(&error.traceback.join("\n"), cap)});
    }
    if output.timed_out {
        report["note"] = json!("Timed out; the kernel was interrupted and keeps its state.");
    }
    if created {
        report["created"] = json!(format!("Created colab:{runtime} for this run."));
    }
    report
}

/// The report beside an inline plot, within `IMAGE_TEXT_MAX` bytes: the same fields with
/// shorter tails until it fits (escaping can grow a text up to sixfold in JSON).
fn image_text(runtime: &str, output: &jupyter::Output, created: bool) -> String {
    let mut cap = IMAGE_TEXT_MAX / 4;
    loop {
        let text = report_with(runtime, output, cap, created).to_string();
        if text.len() <= IMAGE_TEXT_MAX {
            return text;
        }
        if cap == 0 {
            return json!({"runtime": format!("colab:{runtime}"), "images": output.images.len(), "note": "Output too long to show beside the plot; save the plot with outputImage to read it all."}).to_string();
        }
        cap /= 2;
    }
}

/// What a Python run returns to the agent; a plot without `outputImage` rides along as an
/// image (PNG) so vision models can see it, with a bounded report as its text.
pub(crate) fn python_report(runtime: &str, output: &jupyter::Output, saved: Option<&str>, created: bool) -> Value {
    match (saved, output.images.first()) {
        (Some(path), _) => {
            let mut report = report_with(runtime, output, OUTPUT_CAP, created);
            report["savedImage"] = json!(path);
            report
        }
        (None, Some(png)) => json!({"_pandacodeImage": {"mimeType": "image/png", "data": STANDARD.encode(png), "text": image_text(runtime, output, created)}}),
        (None, None) => report_with(runtime, output, OUTPUT_CAP, created),
    }
}

/// The task's checkout: its worktree, else its project folder.
fn checkout(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = store.session(session_id)?;
    task.worktree_path.map(Into::into).or_else(|| store.project(&task.project_id).ok().map(|project| project.path.into())).ok_or_else(|| "This task's folder is unknown.".into())
}

/// Creates a runtime while the thread's indicator shows it being allocated.
fn create_tracked(app: &tauri::AppHandle, session_id: &str, colab: &Colab, name: &str, accelerator: &str, high_mem: bool) -> Result<Machine, String> {
    let creating = activity::begin_create(app, session_id, name, accelerator, high_mem);
    let created = colab.create_with(name, accelerator, high_mem);
    creating.finish(created.as_ref().map(|machine| machine.id.as_str()).map_err(String::as_str));
    created
}

/// The runtime to use: named, the only one, or (with `autoCreate`) a new default one.
fn target(app: &tauri::AppHandle, session_id: &str, colab: &Colab, args: &Value, auto_create: bool) -> Result<(String, bool), String> {
    let machines = colab.machines()?;
    let wanted = string(args, "runtime");
    if machines.is_empty() && wanted.is_none() && auto_create {
        let (accelerator, high_mem) = colab::default_hardware();
        let machine = create_tracked(app, session_id, colab, "", &accelerator, high_mem)?;
        return Ok((endpoint(&machine), true));
    }
    Ok((resolve(&machines, wanted.as_deref())?, false))
}

fn status(colab: &Colab) -> Result<Value, String> {
    let records = colab.records()?;
    let runtimes: Vec<Value> = records
        .values()
        .map(|r| json!({"id": format!("colab:{}", r.endpoint), "name": r.name, "hardware": colab::hardware_label(&r.accelerator), "shape": colab::shape_label(&r.machine_shape), "browserUrl": colab::browser_url(&r.endpoint)}))
        .collect();
    let (accelerator, high_mem) = colab::default_hardware();
    Ok(json!({
        "runtimes": runtimes,
        "computeUnits": colab.usage().ok().flatten().map(|(balance, rate)| json!({"balance": balance, "perHour": rate})),
        "defaults": {"accelerator": accelerator, "highMem": high_mem},
        "colabCliInstalled": crate::token_saver::find_tool("colab").is_some(),
        "colabMcpEnabled": colab::colab_mcp_command().is_some(),
    }))
}

fn manage(app: &tauri::AppHandle, session_id: &str, colab: &Colab, args: &Value) -> Result<Value, String> {
    let action = string(args, "action").unwrap_or_default();
    let changed = || {
        let _ = app.emit("vm-changed", json!({}));
    };
    if action == "create" {
        let (accelerator, high_mem) = hardware(args, colab::default_hardware())?;
        let machine = create_tracked(app, session_id, colab, &string(args, "name").unwrap_or_default(), &accelerator, high_mem)?;
        changed();
        return Ok(json!({"created": machine.id, "name": machine.name, "detail": machine.detail, "browserUrl": colab::browser_url(&endpoint(&machine))}));
    }
    let runtime = resolve(&colab.machines()?, string(args, "runtime").as_deref())?;
    match action.as_str() {
        "stop" => {
            crate::cloud_agents::tasks::ensure_colab_runtime_free(app, &runtime)?;
            let stopping = activity::begin_busy(app, session_id, &runtime, "stopping", "Releasing runtime…");
            match colab.unassign(&runtime) {
                Ok(()) => stopping.released(),
                Err(error) => {
                    stopping.finish::<()>(&Err(error.clone()));
                    return Err(error);
                }
            }
            changed();
            Ok(json!(format!("Stopped colab:{runtime}; its files are gone.")))
        }
        "restart_kernel" => {
            let restarting = activity::begin_busy(app, session_id, &runtime, "restarting", "Restarting kernel…");
            let restarted = colab.restart_kernel(&runtime);
            restarting.finish(&restarted);
            restarted?;
            Ok(json!(format!("Restarted the Python kernel on colab:{runtime}; its variables are cleared.")))
        }
        "open_browser" => {
            let url = colab::browser_url(&runtime);
            super::http::block(crate::open_external_url(url.clone()))?;
            Ok(json!({"opened": url}))
        }
        _ => Err("Unknown Colab action.".into()),
    }
}

fn run_python(app: &tauri::AppHandle, session_id: &str, colab: &Colab, args: &Value, stopped: &AtomicBool) -> Result<Value, String> {
    let (code, doing) = match (args["code"].as_str().filter(|c| !c.trim().is_empty()), string(args, "file")) {
        (Some(_), Some(_)) => return Err("Pass code or file, not both.".into()),
        (Some(code), None) => (code.to_string(), "Running Python".to_string()),
        (None, Some(file)) => (source(&checkout(app, session_id)?, &file)?, running_file(&file)),
        (None, None) => return Err("Pass code or file.".into()),
    };
    let image_path = string(args, "outputImage")
        .map(|path| checkout(app, session_id).and_then(|root| inside_output(&root, &path).map(|full| (path, root, full))))
        .transpose()?;
    alive(stopped)?;
    let (runtime, created) = target(app, session_id, colab, args, args["autoCreate"].as_bool() == Some(true))?;
    if created {
        let _ = app.emit("vm-changed", json!({}));
    }
    alive(stopped)?;
    let busy = activity::begin_busy(app, session_id, &runtime, "busy", &doing);
    let output = colab.execute_python(&runtime, &code, timeout(args));
    busy.finish(&output);
    let output = output?;
    alive(stopped)?;
    let saved = match (&image_path, output.images.first()) {
        (Some((shown, root, full)), Some(png)) => {
            write_inside(root, full, png, shown)?;
            Some(shown.as_str())
        }
        _ => None,
    };
    Ok(python_report(&runtime, &output, saved, created))
}

fn exec(app: &tauri::AppHandle, session_id: &str, colab: &Colab, args: &Value, stopped: &AtomicBool) -> Result<Value, String> {
    let command = string(args, "command").ok_or("Missing argument: command")?;
    let runtime = resolve(&colab.machines()?, string(args, "runtime").as_deref())?;
    alive(stopped)?;
    let busy = activity::begin_busy(app, session_id, &runtime, "busy", "Running shell command");
    let outcome = colab.shell(&runtime, &format!("cd {CONTENT} 2>/dev/null; {command}"), None, timeout(args));
    busy.finish(&outcome);
    let outcome = outcome?;
    Ok(json!({"runtime": format!("colab:{runtime}"), "exitCode": outcome.code, "stdout": tail(&outcome.stdout), "stderr": tail(&outcome.stderr)}))
}

/// `remote` names a folder: the file keeps its own name inside it.
fn upload_destination(remote: Option<&str>, local: &Path) -> String {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match remote {
        Some(remote) if !remote.ends_with('/') && remote.trim_end_matches('/') != CONTENT => remote.to_string(),
        Some(folder) => format!("{}/{name}", folder.trim_end_matches('/')),
        None => format!("{CONTENT}/{name}"),
    }
}

/// What the indicator says while a files action runs.
fn files_activity(action: &str) -> &'static str {
    match action {
        "upload" => "Uploading files",
        "download" => "Downloading files",
        "delete" => "Deleting files",
        _ => "Listing files",
    }
}

/// "Running <file name>" for a checkout file run as code.
fn running_file(file: &str) -> String {
    let name = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.to_string());
    format!("Running {}", name.chars().take(80).collect::<String>())
}

fn files(app: &tauri::AppHandle, session_id: &str, colab: &Colab, args: &Value, stopped: &AtomicBool) -> Result<Value, String> {
    let action = string(args, "action").unwrap_or_default();
    let runtime = resolve(&colab.machines()?, string(args, "runtime").as_deref())?;
    let busy = activity::begin_busy(app, session_id, &runtime, "busy", files_activity(&action));
    let result = transfer(app, session_id, colab, &runtime, &action, args, stopped);
    busy.finish(&result);
    result
}

fn transfer(app: &tauri::AppHandle, session_id: &str, colab: &Colab, runtime: &str, action: &str, args: &Value, stopped: &AtomicBool) -> Result<Value, String> {
    let runtime = runtime.to_string();
    let remote = string(args, "remotePath");
    match action {
        "list" => colab.contents_list(&runtime, remote.as_deref().unwrap_or(CONTENT)),
        "upload" => {
            let local = string(args, "localPath").ok_or("upload needs localPath (a file in the checkout).")?;
            let path = inside_file(&checkout(app, session_id)?, &local)?;
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > jupyter::FILE_MAX as u64 {
                return Err(format!("{local} is over {} MiB; upload it from a URL with pandacode_colab_exec instead.", jupyter::FILE_MAX >> 20));
            }
            let bytes = std::fs::read(&path).map_err(|_| format!("Could not read {local}."))?;
            let destination = upload_destination(remote.as_deref(), &path);
            alive(stopped)?;
            colab.contents_upload(&runtime, &bytes, &destination)?;
            Ok(json!({"uploaded": destination, "bytes": bytes.len()}))
        }
        "download" => {
            let remote = remote.ok_or("download needs remotePath.")?;
            let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
            let local = string(args, "localPath").unwrap_or(name);
            let root = checkout(app, session_id)?;
            let target = inside_output(&root, &local)?;
            alive(stopped)?;
            let bytes = colab.contents_download(&runtime, &remote)?;
            alive(stopped)?;
            write_inside(&root, &target, &bytes, &local)?;
            Ok(json!({"downloaded": remote, "savedTo": local, "bytes": bytes.len()}))
        }
        "delete" => {
            let remote = remote.ok_or("delete needs remotePath.")?;
            if matches!(jupyter::contents_path(&remote)?.as_str(), "" | "content") {
                return Err("Refusing to delete the runtime's root or /content folder.".into());
            }
            alive(stopped)?;
            colab.contents_delete(&runtime, &remote)?;
            Ok(json!({"deleted": remote}))
        }
        _ => Err("Unknown files action.".into()),
    }
}

async fn dispatch(app: tauri::AppHandle, session_id: String, name: String, args: Value, stopped: Arc<AtomicBool>) -> Result<Value, String> {
    crate::blocking(move || {
        // A queued call may start after the task stopped: nothing paid starts then.
        alive(&stopped)?;
        let colab = Colab::connected()?;
        alive(&stopped)?;
        match name.as_str() {
            "pandacode_colab_status" => status(&colab),
            "pandacode_colab_manage" => manage(&app, &session_id, &colab, &args),
            "pandacode_colab_run_python" => run_python(&app, &session_id, &colab, &args, &stopped),
            "pandacode_colab_exec" => exec(&app, &session_id, &colab, &args, &stopped),
            "pandacode_colab_files" => files(&app, &session_id, &colab, &args, &stopped),
            _ => Err("Unknown PandaCode tool.".into()),
        }
    })
    .await
}

/// Tool names that ask before running: all but status.
fn approval_names(tools: &[Value]) -> Vec<String> {
    tools.iter().filter_map(|tool| tool["name"].as_str()).filter(|name| !READ_ONLY.contains(name)).map(str::to_string).collect()
}

/// Add the Colab tools while the user is signed in to Colab with native tools on.
pub fn with_colab(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    if !colab::is_connected() || !colab::native_tools_enabled() {
        return base;
    }
    let own = crate::design::listed(catalog());
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let mut approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    approval_tools.extend(approval_names(&own));
    tools.extend(own);
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, stopped, session_id) = (base.clone(), app.clone(), stopped.clone(), session_id.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if !name.starts_with(PREFIX) {
                    return match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    };
                }
                validate_spec(&catalog(), &name, &args)?;
                dispatch(app, session_id, name, args, stopped).await
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(endpoint: &str, name: &str) -> Machine {
        Machine { id: format!("colab:{endpoint}"), provider: "colab".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: String::new() }
    }
    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-colab-tools-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_catalog_validates_and_only_status_is_free() {
        let tools = catalog();
        assert_eq!(tools.len(), 5);
        assert!(tools.iter().all(|t| t["name"].as_str().unwrap().starts_with(PREFIX)));
        let ok = |name: &str, args: Value| validate_spec(&tools, name, &args);
        assert!(ok("pandacode_colab_status", json!({})).is_ok());
        assert!(ok("pandacode_colab_manage", json!({"action":"create","gpu":"A100","highMem":true,"name":"train"})).is_ok());
        assert!(ok("pandacode_colab_manage", json!({"action":"create","gpu":"K80"})).is_err());
        assert!(ok("pandacode_colab_manage", json!({"action":"create","tpu":"T4"})).is_err());
        assert!(ok("pandacode_colab_manage", json!({"action":"delete"})).is_err());
        assert!(ok("pandacode_colab_run_python", json!({"code":"print(1)","timeoutSeconds":30,"autoCreate":true})).is_ok());
        assert!(ok("pandacode_colab_run_python", json!({"code":"x","timeoutSeconds":-1})).is_err());
        assert!(ok("pandacode_colab_exec", json!({"runtime":"pc-a"})).is_err());
        assert!(ok("pandacode_colab_files", json!({"action":"list","remotePath":"/content"})).is_ok());
        assert!(ok("pandacode_colab_files", json!({"action":"chmod"})).is_err());
        assert!(ok("pandacode_colab_files", json!({"action":"list","extra":1})).is_err());
        let asking = approval_names(&tools);
        assert_eq!(asking.len(), 4);
        assert!(!asking.contains(&"pandacode_colab_status".to_string()));
    }

    /// Bytes the harness sees: `tools/list` sends name, description and schema.
    #[test]
    fn the_catalog_stays_small() {
        let bytes: usize = crate::design::listed(catalog()).iter().map(|t| serde_json::to_string(&json!({"name":t["name"],"description":t["description"],"inputSchema":t["inputSchema"]})).unwrap().len() + 1).sum();
        println!("colab catalog: {bytes} B");
        assert!(bytes <= 2400, "colab catalog is {bytes} B");
    }

    #[test]
    fn resolves_runtimes_by_endpoint_id_or_name() {
        let one = [machine("gpu-t4-s-1", "pc-train")];
        assert_eq!(resolve(&one, None).unwrap(), "gpu-t4-s-1");
        assert_eq!(resolve(&one, Some("colab:gpu-t4-s-1")).unwrap(), "gpu-t4-s-1");
        assert_eq!(resolve(&one, Some("gpu-t4-s-1")).unwrap(), "gpu-t4-s-1");
        assert_eq!(resolve(&one, Some("pc-train")).unwrap(), "gpu-t4-s-1");
        assert!(resolve(&one, Some("other")).unwrap_err().contains("pc-train"));
        assert!(resolve(&[], None).unwrap_err().contains("autoCreate"));
        let two = [machine("a", "pc-a"), machine("b", "pc-b")];
        assert!(resolve(&two, None).unwrap_err().contains("Several"));
        assert_eq!(resolve(&two, Some("pc-b")).unwrap(), "b");
    }

    #[test]
    fn picks_hardware_from_arguments_or_defaults() {
        let defaults = ("T4".to_string(), false);
        assert_eq!(hardware(&json!({}), defaults.clone()).unwrap(), ("T4".into(), false));
        assert_eq!(hardware(&json!({"gpu":"H100","highMem":true}), defaults.clone()).unwrap(), ("H100".into(), true));
        assert_eq!(hardware(&json!({"tpu":"V6E1"}), defaults.clone()).unwrap(), ("V6E1".into(), false));
        assert!(hardware(&json!({"gpu":"T4","tpu":"V5E1"}), defaults).is_err());
    }

    #[test]
    fn local_paths_stay_inside_the_checkout() {
        let root = temp();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/train.py"), "print(1)").unwrap();
        assert_eq!(inside_file(&root, "src/train.py").unwrap(), root.join("src/train.py").canonicalize().unwrap());
        for bad in ["../x.py", "/etc/passwd", "src/../../x", "", "missing.py", "src"] {
            assert!(inside_file(&root, bad).is_err(), "{bad}");
        }
        let out = inside_output(&root, "plots/loss.png").unwrap();
        assert!(out.starts_with(root.canonicalize().unwrap()) && root.join("plots").is_dir());
        assert!(inside_output(&root, "../loss.png").is_err());
        assert!(inside_output(&root, "/tmp/loss.png").is_err());
        assert!(inside_output(&root, "src").is_err(), "a folder is not a file");
        #[cfg(unix)]
        {
            let outside = temp();
            std::fs::write(outside.join("secret.txt"), "x").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
            assert!(inside_file(&root, "escape/secret.txt").is_err());
            assert!(inside_file(&root, "link.txt").is_err());
            assert!(inside_output(&root, "escape/new/plot.png").is_err());
            assert!(!outside.join("new").exists(), "no folder is made outside the checkout");
            assert!(inside_output(&root, "link.txt").is_err());
            std::fs::remove_dir_all(outside).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runs_python_and_notebook_files_only() {
        let root = temp();
        std::fs::write(root.join("a.py"), "print('a')").unwrap();
        std::fs::write(root.join("b.ipynb"), r##"{"cells":[{"cell_type":"markdown","source":["# T"]},{"cell_type":"code","source":["import os\n","x = 1"]},{"cell_type":"code","source":"print(x)"},{"cell_type":"code","source":[]}]}"##).unwrap();
        std::fs::write(root.join("c.sh"), "ls").unwrap();
        assert_eq!(source(&root, "a.py").unwrap(), "print('a')");
        assert_eq!(source(&root, "b.ipynb").unwrap(), "import os\nx = 1\n\nprint(x)");
        assert!(source(&root, "c.sh").unwrap_err().contains(".py or .ipynb"));
        assert!(notebook_code(r#"{"cells":[{"cell_type":"markdown","source":"x"}]}"#).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The PNG signature plus an IHDR start: enough for the host's image check.
    fn png() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend([0u8; 64]);
        bytes
    }

    #[test]
    fn plots_come_back_as_an_image_unless_saved() {
        let output = jupyter::Output { stdout: "ok\n".into(), results: vec!["1".into()], images: vec![png()], ..jupyter::Output::default() };
        let inline = python_report("gpu-1", &output, None, false);
        assert_eq!(inline["_pandacodeImage"]["mimeType"], "image/png");
        assert_eq!(inline["_pandacodeImage"]["data"], STANDARD.encode(png()));
        assert!(inline["_pandacodeImage"]["text"].as_str().unwrap().contains("\"stdout\":\"ok\\n\""));
        let saved = python_report("gpu-1", &output, Some("plots/a.png"), false);
        assert_eq!(saved["savedImage"], "plots/a.png");
        assert_eq!(saved["runtime"], "colab:gpu-1");
        let failed = jupyter::Output { error: Some(jupyter::KernelError { name: "NameError".into(), value: "x".into(), traceback: vec!["line 1".into()] }), timed_out: true, ..jupyter::Output::default() };
        let report = python_report("gpu-1", &failed, None, true);
        assert_eq!(report["error"]["name"], "NameError");
        assert!(report["note"].as_str().unwrap().contains("interrupted"));
        assert_eq!(report["created"], "Created colab:gpu-1 for this run.");
    }

    /// What every harness gets: the report goes through the host's own image check.
    #[test]
    fn plots_pass_the_host_image_check_even_beside_long_output() {
        let plain = jupyter::Output { stdout: "loss 0.1\n".into(), results: vec!["<Figure>".into()], images: vec![png()], ..jupyter::Output::default() };
        // Long logs, multibyte text and characters JSON escapes sixfold.
        let noisy = jupyter::Output {
            stdout: format!("{}é\u{1}END", "step 1 ✓ loss=0.25\n".repeat(40 * 1024 / 20)),
            stderr: "\u{1}\"".repeat(20 * 1024),
            results: vec!["r".repeat(30 * 1024)],
            images: vec![png()],
            error: Some(jupyter::KernelError { name: "ValueError".into(), value: "v".repeat(10_000), traceback: vec!["t\n".repeat(10_000)] }),
            timed_out: false,
        };
        for (output, created) in [(&plain, false), (&noisy, true)] {
            let report = python_report("gpu-t4-s-1", output, None, created);
            let (mime, data, text) = crate::providers::host_tools::image_content(&report).unwrap().expect("an image");
            assert_eq!(mime, "image/png");
            assert_eq!(data, STANDARD.encode(png()));
            assert!(text.len() <= IMAGE_TEXT_MAX && text.len() <= 8192, "{} B", text.len());
            let shown: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(shown["runtime"], "colab:gpu-t4-s-1");
            if created {
                assert!(shown["created"].as_str().unwrap().contains("Created"));
                assert!(shown["stdout"].as_str().unwrap().ends_with("é\u{1}END"), "the end of the log stays");
            } else {
                assert_eq!(shown["stdout"], "loss 0.1\n");
            }
        }
    }

    #[test]
    fn colab_calls_get_their_own_host_timeout() {
        let secs = |name: &str, args: Value| host_timeout(name, &args).map(|d| d.as_secs());
        assert_eq!(secs("pandacode_colab_status", json!({})), None);
        assert_eq!(secs("pandacode_vm_exec", json!({"timeoutSeconds": 300})), None);
        assert_eq!(secs("pandacode_colab_run_python", json!({})), Some(HOST_MIN));
        assert_eq!(secs("pandacode_colab_exec", json!({"timeoutSeconds": 250})), Some(280));
        assert_eq!(secs("pandacode_colab_exec", json!({"timeoutSeconds": 1800})), Some(330));
        assert_eq!(secs("pandacode_colab_manage", json!({"action": "create"})), Some(330));
        assert_eq!(secs("pandacode_colab_manage", json!({"action": "stop"})), Some(HOST_MIN));
        assert_eq!(secs("pandacode_colab_run_python", json!({"autoCreate": true, "timeoutSeconds": 300})), Some(HOST_MAX));
        assert_eq!(secs("pandacode_colab_files", json!({"action": "download"})), Some(HOST_MAX));
        assert_eq!(timeout(&json!({"timeoutSeconds": 1800})).as_secs(), MAX_TIMEOUT);
        assert_eq!(timeout(&json!({})).as_secs(), DEFAULT_TIMEOUT);
    }

    #[test]
    fn git_folders_are_never_read_or_written() {
        let root = temp();
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::write(root.join(".git/config"), "[core]").unwrap();
        for bad in [".git/hooks/pre-commit", ".git/config", "sub/.git/config", ".GIT/config"] {
            assert!(inside_output(&root, bad).unwrap_err().contains(".git"), "{bad}");
        }
        assert!(inside_file(&root, ".git/config").unwrap_err().contains(".git"));
        assert!(!root.join(".git/hooks/pre-commit").exists());
        #[cfg(unix)]
        {
            // A folder that resolves into .git is refused too.
            std::os::unix::fs::symlink(root.join(".git"), root.join("meta")).unwrap();
            assert!(inside_output(&root, "meta/hooks/pre-commit").is_err());
            assert!(inside_file(&root, "meta/config").is_err());
        }
        assert!(inside_output(&root, "gitstuff/.gitignore").is_ok(), "only the .git folder itself is refused");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_land_atomically_and_never_through_a_swapped_symlink() {
        let root = temp();
        let target = inside_output(&root, "plots/loss.png").unwrap();
        write_inside(&root, &target, b"one", "plots/loss.png").unwrap();
        write_inside(&root, &target, b"two", "plots/loss.png").unwrap();
        assert_eq!(std::fs::read(root.join("plots/loss.png")).unwrap(), b"two");
        let leftovers = std::fs::read_dir(root.join("plots")).unwrap().count();
        assert_eq!(leftovers, 1, "no temp file stays behind");
        #[cfg(unix)]
        {
            let outside = temp();
            std::fs::write(outside.join("victim"), "keep").unwrap();
            // The target became a symlink while the remote run went on.
            let target = inside_output(&root, "out.bin").unwrap();
            std::os::unix::fs::symlink(outside.join("victim"), &target).unwrap();
            assert!(write_inside(&root, &target, b"evil", "out.bin").is_err());
            assert_eq!(std::fs::read_to_string(outside.join("victim")).unwrap(), "keep");
            // Its folder became a symlink out of the checkout.
            let target = inside_output(&root, "data/out.bin").unwrap();
            std::fs::remove_dir(root.join("data")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("data")).unwrap();
            assert!(write_inside(&root, &target, b"evil", "data/out.bin").is_err());
            assert!(!outside.join("out.bin").exists());
            assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1, "nothing is written outside");
            std::fs::remove_dir_all(outside).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uploads_into_folders_keep_the_file_name() {
        let local = Path::new("/c/data/train.csv");
        assert_eq!(upload_destination(None, local), "/content/train.csv");
        assert_eq!(upload_destination(Some("/content"), local), "/content/train.csv");
        assert_eq!(upload_destination(Some("/content/data/"), local), "/content/data/train.csv");
        assert_eq!(upload_destination(Some("/content/x.csv"), local), "/content/x.csv");
    }

    #[test]
    fn long_output_keeps_its_end() {
        let text = format!("{}END", "a".repeat(OUTPUT_CAP + 10));
        let cut = tail(&text);
        assert!(cut.ends_with("END") && cut.starts_with("[…first"));
        assert_eq!(tail("short"), "short");
    }
}
