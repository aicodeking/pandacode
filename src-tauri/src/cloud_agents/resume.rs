//! Re-attach (docs/cloud-agents.md, step 6): every cloud task whose run was active when
//! PandaCode quit (or whose bridge ended without finalizing it) gets a run in attach mode.
//! It replays the remote log into a fresh `Protocol`, so the turn ends normally: messages
//! saved, queue delivered, changes pulled.
use super::transport;
use crate::AppState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::Manager;

const FIRST: Duration = Duration::from_secs(3);
const EVERY: Duration = Duration::from_secs(60);

pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST).await;
        loop {
            if app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
                break;
            }
            attach_all(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn attach_all(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let ids = state.store.lock().ok().and_then(|store| super::active_runs(&store).ok()).unwrap_or_default();
    for id in ids {
        if state.agents.lock().map_or(true, |agents| agents.contains_key(&id)) {
            continue;
        }
        transport::attach_next(&id, true);
        if let Err(error) = crate::attach_cloud_run(app.clone(), id.clone()).await {
            transport::attach_next(&id, false);
            eprintln!("Cloud agents: could not re-attach to a cloud run: {error}");
        }
    }
}
