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
        env: env.into_iter().chain(prepared.env).collect(),
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
}
