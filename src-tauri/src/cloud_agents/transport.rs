//! The app side of the remote transport (docs/cloud-agents.md, step 5). `run_inner` asks
//! [`command`] first: for a cloud task it prepares the machine and returns a bridge process
//! (see `bridge.rs`) to spawn instead of the harness, so `Protocol`, the sink, approvals,
//! steering and the queue work unchanged. The bridge reports progress through a status
//! file that [`watch`] copies into `sessions.cloud`.
use super::bridge::{self, Spec, Status};
use crate::providers::RunConfig;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;
use tokio::process::Command;

fn attaching() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

/// The next run of `session_id` re-attaches to its remote run instead of starting one.
pub(crate) fn attach_next(session_id: &str, attach: bool) {
    let mut set = attaching().lock().unwrap_or_else(|p| p.into_inner());
    if attach {
        set.insert(session_id.to_owned());
    } else {
        set.remove(session_id);
    }
}

fn take_attach(session_id: &str) -> bool {
    attaching().lock().unwrap_or_else(|p| p.into_inner()).remove(session_id)
}

/// Whether a task runs on a cloud machine.
pub(crate) fn is_cloud(session_id: &str) -> bool {
    super::app().is_some_and(|app| {
        app.state::<crate::AppState>().store.lock().ok().and_then(|store| super::load(&store, session_id).ok().flatten()).is_some()
    })
}

/// The harness's argv and explicit environment, as `configure` builds them locally.
fn argv(configure: impl FnOnce(&mut Command)) -> (Vec<String>, Vec<(String, String)>) {
    let mut command = Command::new("harness");
    configure(&mut command);
    let command = command.as_std();
    let args = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
    let env = command.get_envs().filter_map(|(key, value)| Some((key.to_str()?.to_owned(), value?.to_str()?.to_owned()))).collect();
    (args, env)
}

/// `cmd.sh` uploads must stay well under the exec command ceilings (`bridge.rs`,
/// `credentials.rs`), so an inherited environment is capped before the machine starts.
const INHERIT_LIMIT: usize = 32 * 1024;

/// The cloud provider a task runs on, read straight from its session row.
fn cloud_provider(app: &tauri::AppHandle, session_id: &str) -> Option<String> {
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().ok()?;
    super::load(&store, session_id).ok().flatten().map(|cloud| cloud.provider)
}

/// The harness's saved environment variables for a cloud run, when this cloud is set to
/// inherit them (off by default, so nothing is sent without the user asking for it).
/// Variables the local launch would scrub ("Prefer saved Claude login") are filtered
/// here too: the remote `cmd.sh` can only set, never remove.
fn inherited_environment(cloud_provider: &str, harness: &str) -> Result<Vec<(String, String)>, String> {
    let inherits = crate::cloud::settings().providers.get(cloud_provider).and_then(|options| options.get("inheritEnvironment").map(String::as_str)) == Some("true");
    if !inherits {
        return Ok(Vec::new());
    }
    let removed = crate::providers::claude_auth::removed_environment(harness);
    checked_environment(crate::provider_settings::environment(harness).into_iter().filter(|(name, _)| !removed.contains(&name.as_str())).collect())
}

/// Loopback guard and size cap for an environment about to travel to a cloud machine.
fn checked_environment(vars: Vec<(String, String)>) -> Result<Vec<(String, String)>, String> {
    let mut total = 0usize;
    for (name, value) in &vars {
        if proxy_points_at_this_computer(name, value) {
            return Err(format!(
                "{name} points at this computer, and a cloud machine cannot reach a proxy there — its tasks would lose all API traffic. Turn off “Include provider environment variables” for this cloud, or set a host the machine can reach."
            ));
        }
        total += name.len() + crate::cloud::shell_quote(value).len() + "export =\n".len();
    }
    if total > INHERIT_LIMIT {
        return Err("The saved environment variables are too large to send to a cloud machine. Remove a few in Settings → Providers and start the task again.".into());
    }
    Ok(vars)
}

/// HTTP(S) proxy variables only: `NO_PROXY` legitimately names this computer.
fn proxy_points_at_this_computer(name: &str, value: &str) -> bool {
    matches!(name.to_ascii_uppercase().as_str(), "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY")
        && ["127.0.0.1", "localhost", "::1"].iter().any(|host| value.contains(host))
}

/// None for an ordinary task. For a cloud task: prepares the machine (blocking work off the
/// runtime) and returns the bridge command. `configure` adds the harness's arguments.
pub(crate) async fn command(config: &RunConfig, configure: impl FnOnce(&mut Command)) -> crate::Result<Option<Command>> {
    let Some(app) = super::app() else { return Ok(None) };
    let attach = take_attach(&config.session_id);
    if !is_cloud(&config.session_id) {
        return Ok(None);
    }
    if !super::setup::HARNESSES.contains(&config.provider.as_str()) {
        return Err(super::tasks::harness_refusal(&config.provider));
    }
    if !config.images.is_empty() {
        return Err("Images can't be sent to a cloud machine yet.".into());
    }
    // Guards run before any machine prep: a refused environment must not cost a
    // sandbox start. Attach never sends env — the bridge catches up with the live
    // run instead of starting one — so there is nothing to inherit into.
    let inherited = if attach {
        Vec::new()
    } else {
        match cloud_provider(app, &config.session_id) {
            Some(cloud) => inherited_environment(cloud.as_str(), &config.provider)?,
            None => Vec::new(),
        }
    };
    let (args, env) = argv(configure);
    let (session_id, provider) = (config.session_id.clone(), config.provider.clone());
    let worker = app.clone();
    let prepared = crate::blocking(move || super::tasks::before_run(&worker, &session_id, &provider, attach)).await?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("cloud-runs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let status = dir.join(format!("{}.status", config.session_id));
    let _ = std::fs::remove_file(&status);
    let spec = Spec {
        provider: prepared.provider,
        native: prepared.native,
        run_id: prepared.run_id,
        remote_dir: prepared.remote_dir,
        local_dir: config.cwd.to_string_lossy().into_owned(),
        program: prepared.program,
        args,
        // Saved variables first, so the harness's credentials and this run's
        // environment always win over them — the local precedence, unchanged.
        env: inherited.into_iter().chain(env).chain(prepared.env).collect(),
        attach,
        status: status.clone(),
        secrets: crate::secret_store::dir().map(std::path::Path::to_path_buf),
    };
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    write_private(&path, &serde_json::to_vec(&spec).map_err(|e| e.to_string())?)?;
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.env(bridge::ENV, &path);
    watch(app.clone(), config.session_id.clone(), status);
    Ok(Some(command))
}

fn write_private(path: &PathBuf, bytes: &[u8]) -> crate::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).and_then(|mut file| file.write_all(bytes)).map_err(|e| format!("Could not prepare the cloud run: {e}"))
}

/// Copies the bridge's progress into `sessions.cloud` while the run is registered.
fn watch(app: tauri::AppHandle, session_id: String, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<Status> = None;
        let mut ticks = 0u32;
        loop {
            ticks += 1;
            tokio::time::sleep(Duration::from_millis(700)).await;
            let running = app.state::<crate::AppState>().agents.lock().is_ok_and(|agents| agents.contains_key(&session_id));
            let status = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Status>(&bytes).ok());
            if let Some(status) = status.filter(|status| last.as_ref() != Some(status)) {
                let _ = super::update(&app, &session_id, |state| {
                    // A run that was finalized meanwhile keeps its final stage.
                    if state.active() && matches!(state.stage.as_str(), "running" | "reconnecting") {
                        state.stage = status.stage.clone();
                        state.detail = status.detail.clone();
                    }
                    state.offset = status.offset;
                    state.inbox_lines = status.inbox_lines;
                });
                last = Some(status);
            }
            if !running && ticks > 1 {
                let _ = std::fs::remove_file(&path);
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_gets_the_harness_argv_and_explicit_environment() {
        let (args, env) = super::argv(|command| {
            command.args(["-p", "--model", "x"]).env("A", "1").env_remove("B");
        });
        assert_eq!(args, ["-p", "--model", "x"]);
        assert_eq!(env, [("A".to_string(), "1".to_string())]);
    }

    #[test]
    fn loopback_proxies_are_refused_but_no_proxy_and_real_hosts_pass() {
        for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "ALL_PROXY"] {
            for value in ["http://127.0.0.1:7890", "socks5://localhost:1080", "http://[::1]:3128"] {
                let error = super::checked_environment(vec![(name.into(), value.into())]).unwrap_err();
                assert!(error.contains(name) && error.contains("cloud machine"), "{name}={value}");
                assert!(!error.contains(value), "the value is never echoed back");
            }
        }
        // NO_PROXY legitimately names this computer on its own.
        super::checked_environment(vec![("NO_PROXY".into(), "localhost,127.0.0.1".into())]).unwrap();
        super::checked_environment(vec![
            ("HTTP_PROXY".into(), "http://proxy.corp.example:3128".into()),
            ("HTTPS_PROXY".into(), "http://proxy.corp.example:3128".into()),
            ("NO_PROXY".into(), "localhost,127.0.0.1,.corp.example".into()),
        ])
        .unwrap();
        assert!(!super::proxy_points_at_this_computer("ANTHROPIC_BASE_URL", "https://127.0.0.1:8080"));
    }

    #[test]
    fn an_oversized_environment_is_refused_before_the_machine_starts() {
        let mut vars: Vec<(String, String)> = (0..64).map(|index| (format!("VAR_{index}"), "x".repeat(2048))).collect();
        assert!(super::checked_environment(vars.clone()).is_err());
        vars.truncate(4);
        assert_eq!(super::checked_environment(vars).unwrap().len(), 4);
        assert!(super::checked_environment(Vec::new()).unwrap().is_empty());
    }
}
