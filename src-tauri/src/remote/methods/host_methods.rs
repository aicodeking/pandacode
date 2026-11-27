//! This computer's PandaCode version and its own updater, from a phone (docs/remote-access.md,
//! "Updates"): a paired device can see whether an update is waiting and ask the computer to
//! install it and restart.
//!
//! The update state is shared with the webview's updater (`src/app-updates.ts`, which runs the real
//! automatic check) through `crate::app_updates`: whichever side checked last wins, deliberately, so
//! `host.updateStatus` never needs its own request to GitHub and the desktop's six-hourly check keeps
//! working unchanged. Only `host.checkUpdate` and `host.updateAndRestart` — both Full and both behind
//! the host's "Full access for remote tasks" switch — reach the network or change the machine.
//!
//! A restart drops every phone's connection: the reply is sent before the restart begins, and each
//! subscribed viewer gets a best-effort `host.restarting` event so a client can say why. Clients that
//! do not know that event simply see presence drop and re-subscribe when the computer is back.
//!
//! Deliberate limits:
//! - `host.updateStatus` is a read of the shared state only: no network, no store.
//! - `host.checkUpdate` coalesces: a second caller while a check runs waits for it and shares the
//!   answer, so two phones never make two requests at once.
//! - `host.updateAndRestart` refuses a copy that cannot install over itself (a Linux run outside an
//!   AppImage) instead of downloading something it could never apply.
use super::{full_access_off, Access, Ctx, Method, Reply, Run};
use crate::app_updates;
use crate::Result;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use tauri::{Emitter, Manager};

/// A check's answer: the version an update would install, `None` when up to date, or why it failed.
/// Kept free of the updater's own types so tests can drive a fake without a network or an app.
pub(crate) type Check<'a> = Pin<Box<dyn Future<Output = std::result::Result<Option<String>, String>> + Send + 'a>>;

/// The event the page and the socket hear when an install-and-restart begins.
pub(crate) const RESTARTING_EVENT: &str = "host-restarting";

/// How long the reply and the `host.restarting` frames get to leave before the install starts. The
/// reply never waits on the restart itself.
const RESTART_DELAY_MS: u64 = 750;

const NOT_INSTALLABLE: &str = "This copy of PandaCode cannot install updates itself. Update it with its package or a new AppImage.";
const NOTHING: &str = "PandaCode is up to date.";

/// The release-manifest request's ceiling: the plugin sets none of its own, and a phone's call must
/// not hold a background slot on a stalled connection for ever.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The gate both writes pass before the network or the machine is touched: a Full grant and the
/// host's switch, because installing swaps the program the user runs.
fn allow_write(full_access: bool) -> Result<()> {
    if !full_access {
        return Err(full_access_off());
    }
    Ok(())
}

/// The real check: Tauri's updater reads the release manifest (`tauri.conf.json` `plugins.updater`).
/// The plugin sets no request timeout, so the check imposes one: it is the call a phone waits on,
/// and it must never hold its lane for ever.
async fn real_check(app: &tauri::AppHandle) -> std::result::Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| update.version))
}

/// The real install: the update's own download (and its signature check) with no extra timeout, so a
/// big file on a slow link still finishes.
async fn real_install(app: &tauri::AppHandle) -> std::result::Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else { return Err(NOTHING.into()) };
    // Progress is ignored: the phone watched `host.updateStatus` already.
    update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())
}

/// Runs one check through the shared gate, records the outcome, and answers the status. `check` is
/// the seam real code and tests share: production passes [`real_check`], a test a fake, so no test
/// reaches GitHub.
async fn run_check<'a>(version: &str, check: impl FnOnce() -> Check<'a>) -> Result<Value> {
    // `None` means another caller ran the check while this one waited: share its recorded answer.
    if let Some(outcome) = app_updates::checks().run(check()).await {
        app_updates::update(|state| app_updates::apply_check(state, version, outcome));
    }
    Ok(app_updates::status_json(version))
}

// ---- host.updateStatus ----

#[derive(Debug)]
struct UpdateStatus;

impl Run for UpdateStatus {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let version = ctx.app.package_info().version.to_string();
        Box::pin(async move { Ok(app_updates::status_json(&version)) })
    }
}

// ---- host.checkUpdate ----

#[derive(Debug)]
struct CheckUpdate;

impl Run for CheckUpdate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            allow_write(ctx.full_access)?;
            let version = ctx.app.package_info().version.to_string();
            run_check(&version, || Box::pin(async move { real_check(ctx.app).await })).await
        })
    }
}

// ---- host.updateAndRestart ----

/// What `host.updateAndRestart` does, decided from the shared state alone — so a test can prove a
/// restart with nothing pending never happens without an app handle or a network.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// An install-and-restart is already under way.
    AlreadyRestarting,
    /// Nothing to install: up to date (or the last check failed; its error says which).
    Nothing,
    /// This copy cannot install over itself (a Linux run outside an AppImage).
    NotInstallable,
    /// Download, install and restart into this version.
    Install(String),
}

fn restart_plan(restarting: bool, installable: bool, pending: Option<String>) -> Plan {
    if restarting {
        Plan::AlreadyRestarting
    } else if let Some(version) = pending {
        if installable {
            Plan::Install(version)
        } else {
            Plan::NotInstallable
        }
    } else {
        Plan::Nothing
    }
}

/// Tells every subscribed viewer a restart is coming, best-effort: the socket close that follows is
/// the real signal, this only lets a client say why. Ignored when nobody is connected, and any
/// frame that cannot be sealed is dropped.
fn tell_viewers(app: &tauri::AppHandle, version: &str) {
    let Some(remote) = app.try_state::<super::super::Remote>() else { return };
    let viewers: Vec<String> = remote.lock().subscribers.keys().cloned().collect();
    let frame = json!({"type": "event", "name": "host.restarting", "data": {"version": version}});
    for viewer in viewers {
        let _ = super::super::socket::send_to_device(app, &viewer, &frame);
    }
}

/// Installs the pending update, re-checking for the file the way the page does. Waits out the local
/// signing pass so it never touches the bundle mid-install.
async fn install(app: &tauri::AppHandle) -> std::result::Result<(), String> {
    let _ = crate::blocking(crate::local_signing::sign_running_app).await;
    real_install(app).await?;
    let _ = crate::blocking(crate::local_signing::sign_running_app).await;
    Ok(())
}

/// Starts the install-and-restart if one is not already under way: claims the restart atomically, so
/// two phones (or a retried call) cannot both start one; tells the page and the viewers; then
/// installs and restarts in the background so the caller's reply is never held behind the download.
fn begin_restart(app: &tauri::AppHandle, version: &str) {
    if !app_updates::claim_restart() {
        return;
    }
    let _ = app.emit(RESTARTING_EVENT, json!({"version": version}));
    tell_viewers(app, version);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(RESTART_DELAY_MS)).await;
        match install(&handle).await {
            // ExitRequested with the restart code, so the clean shutdown (agents stopped, the page
            // told) runs and crash recovery does not treat this as a crash.
            Ok(()) => handle.restart(),
            // The release was withdrawn between the check and the download: not a failure, just no
            // update after all, so the phone's next status does not show a bogus error.
            Err(error) if error == NOTHING => app_updates::update(app_updates::apply_up_to_date),
            // No restart then: the phone sees the reason on its next `host.updateStatus`.
            Err(error) => app_updates::update(|state| app_updates::apply_failure(state, &error)),
        }
    });
}

#[derive(Debug)]
struct UpdateAndRestart;

impl Run for UpdateAndRestart {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            allow_write(ctx.full_access)?;
            let version = ctx.app.package_info().version.to_string();
            let decide = || restart_plan(app_updates::read(|state| state.restarting), app_updates::installable_now(), app_updates::read(|state| state.pending.clone()));
            let mut decided = decide();
            if decided == Plan::Nothing {
                // A phone asked to update without checking first: refresh, then decide again. A
                // failed check records its error, which the reply below carries.
                run_check(&version, || Box::pin(async move { real_check(ctx.app).await })).await?;
                decided = decide();
            }
            match decided {
                // `begin_restart` claims the restart atomically, so when two callers both reach
                // here only one installs; the other answers the same without a second download.
                Plan::Install(found) => {
                    begin_restart(ctx.app, &found);
                    Ok(json!({"restarting": true}))
                }
                Plan::AlreadyRestarting => Ok(json!({"restarting": true})),
                Plan::NotInstallable => Err(NOT_INSTALLABLE.into()),
                Plan::Nothing => Err(app_updates::read(|state| state.error.clone()).map_or_else(|| NOTHING.to_owned(), |error| format!("Couldn’t check for updates: {error}"))),
            }
        })
    }
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "host.updateStatus", access: Access::View, read_only: true, parse: |_| Ok(Box::new(UpdateStatus)) },
    Method { name: "host.checkUpdate", access: Access::Full, read_only: false, parse: |_| Ok(Box::new(CheckUpdate)) },
    Method { name: "host.updateAndRestart", access: Access::Full, read_only: false, parse: |_| Ok(Box::new(UpdateAndRestart)) },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn method(name: &str) -> &'static Method {
        super::super::find(name).unwrap_or_else(|| panic!("{name} is registered"))
    }

    #[test]
    fn the_status_read_is_view_and_the_writes_are_full() {
        for (name, access, read_only) in [
            ("host.updateStatus", Access::View, true),
            ("host.checkUpdate", Access::Full, false),
            ("host.updateAndRestart", Access::Full, false),
        ] {
            let found = method(name);
            assert_eq!(found.access, access, "{name}");
            assert_eq!(found.read_only, read_only, "{name}");
        }
        // The status read is a quick ordered call. Both writes touch the network (a check may run
        // before an install, right before the restart), so they run in the background lane and never
        // hold a phone's Stop behind a manifest fetch.
        assert_eq!(super::super::lane_for("host.updateStatus"), None);
        for name in ["host.checkUpdate", "host.updateAndRestart"] {
            assert_eq!(super::super::lane_for(name), Some(super::super::Lane::Background), "{name}");
        }
    }

    #[test]
    fn every_write_checks_the_switch_before_the_network_or_the_restart() {
        // A Full grant alone is not enough to swap the program the user runs: the host's switch must
        // be on, and checked before anything is fetched, installed or restarted.
        let source = include_str!("host_methods.rs");
        for (run, before) in [("impl Run for CheckUpdate", "real_check(ctx.app)"), ("impl Run for UpdateAndRestart", "begin_restart(ctx.app,")] {
            let start = source.find(run).unwrap_or_else(|| panic!("{run}"));
            let body = &source[start..];
            let body = &body[..body.find("\n    }\n").unwrap()];
            let gate = body.find("allow_write(ctx.full_access)?").unwrap_or_else(|| panic!("{run} checks the switch"));
            let effect = body[gate..].find(before).map(|at| gate + at).unwrap_or_else(|| panic!("{run} reaches {before}"));
            assert!(gate < effect, "{run} gates before it acts");
        }
    }

    #[test]
    fn a_restart_needs_a_pending_installable_update() {
        assert_eq!(restart_plan(false, true, Some("0.3.162".into())), Plan::Install("0.3.162".into()));
        // Nothing pending: no restart, whatever the copy can do.
        assert_eq!(restart_plan(false, true, None), Plan::Nothing);
        assert_eq!(restart_plan(false, false, None), Plan::Nothing);
        // A pending update on a copy that only reports updates is never installed over itself.
        assert_eq!(restart_plan(false, false, Some("0.3.162".into())), Plan::NotInstallable);
        // A restart already under way answers the same, so a retried call does not start another.
        assert_eq!(restart_plan(true, true, None), Plan::AlreadyRestarting);
        assert_eq!(restart_plan(true, true, Some("0.3.162".into())), Plan::AlreadyRestarting);
    }

    #[tokio::test]
    async fn a_check_records_its_answer_and_a_failure_leaves_no_pending_update() {
        let _tests = app_updates::test_lock();
        let found = run_check("0.3.161", || Box::pin(async { Ok(Some("0.3.162".to_owned())) })).await.unwrap();
        assert_eq!(found["currentVersion"], "0.3.161");
        assert_eq!(found["update"], json!({"version": "0.3.162"}));
        assert_eq!(found["error"], Value::Null);

        // A failed check records the sentence and clears what an earlier one found.
        let failed = run_check("0.3.161", || Box::pin(async { Err("Couldn’t check for updates: offline.".to_owned()) })).await.unwrap();
        assert_eq!(failed["update"], Value::Null);
        assert_eq!(failed["error"], "Couldn’t check for updates: offline.");
        assert!(app_updates::read(|state| state.pending.is_none()));

        // A check that finds nothing clears both.
        let current = run_check("0.3.161", || Box::pin(async { Ok(None) })).await.unwrap();
        assert_eq!(current["update"], Value::Null);
        assert_eq!(current["error"], Value::Null);
    }

    #[tokio::test]
    async fn one_check_at_a_time_even_when_two_calls_overlap() {
        let _tests = app_updates::test_lock();
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counted = |runs: std::sync::Arc<std::sync::atomic::AtomicU64>| async move {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            Ok(Some("0.3.162".to_owned()))
        };
        let (first, second) = tokio::join!(run_check("0.3.161", || Box::pin(counted(runs.clone()))), run_check("0.3.161", || Box::pin(counted(runs.clone()))));
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1, "two overlapping checks share one run");
        // Both callers see the shared answer.
        for status in [first.unwrap(), second.unwrap()] {
            assert_eq!(status["update"], json!({"version": "0.3.162"}));
        }
    }

    #[test]
    fn the_status_read_never_touches_the_network() {
        // `host.updateStatus` answers the shared state only: its Run body has no check, install or
        // restart in it, so any of them showing up here is a bug.
        let source = include_str!("host_methods.rs");
        let start = source.find("impl Run for UpdateStatus").unwrap();
        let body = &source[start..];
        let body = &body[..body.find("\n    }\n").unwrap()];
        for forbidden in ["real_check", "real_update", "download_and_install", "restart()", "begin_restart"] {
            assert!(!body.contains(forbidden), "host.updateStatus must not {forbidden}");
        }
        assert!(body.contains("status_json"));
    }
}
