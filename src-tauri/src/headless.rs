//! Headless host mode: `pandacode serve` (docs/headless.md) runs the desktop runtime with
//! no window and no webview on an always-on server, hosting PandaCode Connect clients —
//! the mobile app and other computers' PandaCode see it as a computer and can start,
//! watch, steer and approve tasks on it. The window's few real jobs for a server (queue
//! drain, pull-request links, limit resumes) run natively here instead; see start_services.

use crate::{message_queue, AppState};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static SERVE: AtomicBool = AtomicBool::new(false);

/// True inside a `pandacode serve` process. Native hooks key off this instead of a window.
pub(crate) fn active() -> bool {
    SERVE.load(Ordering::Relaxed)
}

/// What this `serve` invocation does. One per process.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve,
    SignIn { name: Option<String> },
    SignOut,
    FullAccess { enabled: bool },
    ExportBots { path: PathBuf },
}

/// `pandacode serve …`: true when the argument was handled; the process then serves until
/// it is stopped (or exits after a settings command). Everything else is the desktop app.
pub fn handle() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("serve") {
        return false;
    }
    match parse(&args[1..]) {
        Ok((command, import)) => {
            SERVE.store(true, Ordering::Relaxed);
            // A server has no Secret Service agent: the 0600 file backend is serve's default.
            // Set PANDACODE_SECRETS_FILE=0 to use the OS store anyway.
            if std::env::var_os("PANDACODE_SECRETS_FILE").is_none() {
                std::env::set_var("PANDACODE_SECRETS_FILE", "1");
            }
            serve(command, import)
        }
        Err(help) => {
            eprintln!("{help}");
            std::process::exit(2)
        }
    }
}

/// Builds the app with no window and runs it until an explicit exit. Never returns.
fn serve(command: Command, import: Option<PathBuf>) -> ! {
    let app = tauri::Builder::default()
        .setup(move |app| {
            let dir = crate::setup_common(app)?;
            // No window on a server: close the one from tauri.conf.json right away; the
            // run loop keeps the process alive (see on_run_event). Users watch from their
            // devices, never from here.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                let _ = window.close();
            }
            start(app.handle(), &dir, command, import);
            Ok(())
        })
        .build(crate::app_context())
        .expect("Failed to launch PandaCode");
    app.run(crate::on_run_event);
    std::process::exit(0)
}

/// Per-command startup, run from setup.
fn start(app: &tauri::AppHandle, dir: &std::path::Path, command: Command, import: Option<PathBuf>) {
    match command {
        Command::ExportBots { path } => match crate::headless_bots::run_export(app, &path) {
            Ok(()) => {
                println!("Bot configuration written to {}.", path.display());
                std::process::exit(0)
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1)
            }
        },
        Command::SignOut => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::remote::headless_sign_out(&app).await;
                println!("Signed out of PandaCode Connect.");
                std::process::exit(0)
            });
        }
        Command::FullAccess { enabled } => match crate::remote::headless_set_full_access(dir, enabled) {
            Ok(()) => {
                println!("Full access for remote tasks is {}.", if enabled { "on" } else { "off" });
                std::process::exit(0)
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1)
            }
        },
        Command::SignIn { name } => {
            let (app, dir) = (app.clone(), dir.to_owned());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::remote::headless_sign_in(&dir, name).await {
                    eprintln!("Sign-in failed: {error}");
                    std::process::exit(1)
                }
                crate::remote::headless_reload(&app, &dir);
                if let Some(path) = import {
                    crate::headless_bots::run_import(&app, &path);
                }
                start_services(app);
            });
        }
        Command::Serve => {
            if !crate::remote::configured() {
                eprintln!("Remote access is not configured in this build (PANDACODE_RELAY_URL / PANDACODE_GITHUB_CLIENT_ID).");
                std::process::exit(1)
            }
            if !crate::remote::signed_in(dir) {
                eprintln!("This server is not signed in to PandaCode Connect. Run: pandacode serve --sign-in");
                std::process::exit(1)
            }
            if let Some(path) = import {
                crate::headless_bots::run_import(app, &path);
            }
            // serve exists to host: flip the host switch if a saved sign-in left it off.
            if !crate::remote::host_enabled(dir) {
                if let Err(error) = crate::remote::headless_set_host_enabled(dir, true) {
                    eprintln!("Could not enable hosting: {error}");
                    std::process::exit(1)
                }
                crate::remote::headless_reload(app, dir);
                println!("Hosting was off in the saved sign-in; turned it on.");
            }
            start_services(app.clone());
        }
    }
}

/// The serve-only services: Ctrl-C/SIGTERM, one status line for journald, native limit
/// resumes, and the queue the previous run left behind.
fn start_services(app: tauri::AppHandle) {
    let signals = app.clone();
    tauri::async_runtime::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term.recv() => {},
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        println!("Shutting down; waiting for running agents (up to 12s)…");
        signals.exit(0);
    });
    let status = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let line = crate::remote::headless_status(&status);
            if line != last {
                println!("{line}");
                last = line;
            }
        }
    });
    let limits = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let state = limits.state::<AppState>();
            if state.shutdown.load(Ordering::SeqCst) != 0 {
                break;
            }
            let due = state
                .store
                .lock()
                .ok()
                .and_then(|store| store.due_limit_resumes(crate::storage::now() + 1000).ok())
                .unwrap_or_default();
            for session_id in due {
                if state.agents.lock().map(|agents| agents.contains_key(&session_id)).unwrap_or(true) {
                    continue;
                }
                println!("serve: resuming {session_id} at its usage-limit reset");
                if let Err(error) = crate::send_message(
                    limits.clone(),
                    limits.state::<AppState>(),
                    session_id,
                    "Continue where you left off.".into(),
                    None,
                    None,
                )
                .await
                {
                    eprintln!("serve: the limit resume could not be sent: {error}");
                }
            }
        }
    });
    // Queued messages from before the restart: remote clients have no Resume button, so
    // serve delivers them once the resumed cloud runs have had a moment to re-attach.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let state = app.state::<AppState>();
        let queued: Vec<String> = state
            .store
            .lock()
            .ok()
            .and_then(|store| message_queue::list(&store, None).ok())
            .map(|entries| entries.into_iter().map(|entry| entry.session_id).collect())
            .unwrap_or_default();
        for session_id in queued.into_iter().collect::<BTreeSet<_>>() {
            drain_queue(app.clone(), session_id);
        }
    });
}

/// Sends the next queued message of a finished task — the window's dispatchQueue (main.ts)
/// and the bot gateway's native drain, for tasks that have neither. Holds the queue like
/// the desktop does: archived or still-limited tasks wait (the limit-resume send ends a
/// run, which then drains), and bot conversations are the gateway's. Sync: spawns the
/// send itself, so callers can chain it after their own run-end work.
pub(crate) fn drain_queue(app: tauri::AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        let now = crate::storage::now();
        let eligible = {
            let state = app.state::<AppState>();
            if state.agents.lock().map(|agents| agents.contains_key(&session_id)).unwrap_or(true) {
                return;
            }
            let Ok(store) = state.store.lock() else { return };
            // Bot conversations drain through the bot gateway.
            if crate::bots::owner_of(&store, &session_id).ok().flatten().is_some() {
                return;
            }
            store.session(&session_id).ok().is_some_and(|task| can_drain(task.archived, task.limited_at, task.limited_until, now))
        };
        if !eligible {
            return;
        }
        let next = {
            let state = app.state::<AppState>();
            let Ok(store) = state.store.lock() else { return };
            message_queue::list(&store, Some(&session_id)).ok().and_then(|entries| entries.into_iter().next())
        };
        let Some(entry) = next else { return };
        let entry = {
            let state = app.state::<AppState>();
            let Ok(store) = state.store.lock() else { return };
            match message_queue::take(&store, &entry.id) {
                Ok(entry) => entry,
                Err(error) => {
                    eprintln!("serve: could not take the next queued message: {error}");
                    return;
                }
            }
        };
        let (context, image_ids) = crate::bots::gateway::queued_prompt(&entry.attachments);
        let images = (!image_ids.is_empty()).then_some(image_ids);
        println!("serve: sending the next queued message to {session_id}");
        if let Err(error) = crate::send_message(
            app.clone(),
            app.state::<AppState>(),
            session_id.clone(),
            format!("{}{context}", entry.text),
            images,
            None,
        )
        .await
        {
            // A failed launch puts the entry back first; no run ends, so the queue holds.
            let state = app.state::<AppState>();
            if let Ok(store) = state.store.lock() {
                if let Err(lost) = message_queue::restore(&store, &entry) {
                    eprintln!("serve: queued message lost after a failed launch: {lost}");
                }
            }
            eprintln!("serve: couldn't send the next queued message: {error}");
        }
    });
}

/// A task may take its next queued message when it is live and not inside a usage limit —
/// limitActive in src/usage-limit.ts: a limit without a known reset holds indefinitely.
fn can_drain(archived: bool, limited_at: Option<i64>, limited_until: Option<i64>, now: i64) -> bool {
    !archived && limited_at.is_none_or(|_at| limited_until.is_some_and(|until| until <= now))
}

/// An agent tool or a remote client queued (or removed) a message. The run-end hook drains
/// finished tasks; this covers a message queued while the task sits idle.
pub(crate) fn queue_changed(app: &tauri::AppHandle, session_id: &str) {
    if !active() {
        return;
    }
    drain_queue(app.clone(), session_id.to_owned());
}

fn parse(args: &[String]) -> Result<(Command, Option<PathBuf>), String> {
    let mut name: Option<String> = None;
    let mut import: Option<PathBuf> = None;
    let mut sign_in = false;
    let mut command = Command::Serve;
    let mut ops = 0;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => return Err(help()),
            "--sign-in" => {
                sign_in = true;
                ops += 1;
            }
            "--sign-out" => {
                command = Command::SignOut;
                ops += 1;
            }
            "--full-access" => {
                command = Command::FullAccess { enabled: true };
                ops += 1;
            }
            "--no-full-access" => {
                command = Command::FullAccess { enabled: false };
                ops += 1;
            }
            "--export-bots" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("--export-bots needs a file path.\n\n{}", help()))?;
                command = Command::ExportBots { path: PathBuf::from(value) };
                ops += 1;
                index += 1;
            }
            "--import-bots" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("--import-bots needs a file path.\n\n{}", help()))?;
                import = Some(PathBuf::from(value));
                index += 1;
            }
            "--device-name" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("--device-name needs a name.\n\n{}", help()))?;
                name = Some(value.clone());
                index += 1;
            }
            other => return Err(format!("Unknown flag `{other}`.\n\n{}", help())),
        }
        index += 1;
    }
    if ops > 1 {
        return Err(format!(
            "Choose one: --sign-in, --sign-out, --full-access, --no-full-access, --export-bots.\n\n{}",
            help()
        ));
    }
    // Built at the end, so flags work in any order.
    if sign_in {
        command = Command::SignIn { name };
    }
    // An import composes only with serving (or a first-run sign-in): the exiting ops
    // would silently ignore the file.
    if import.is_some() && !matches!(command, Command::Serve | Command::SignIn { .. }) {
        return Err(format!("--import-bots only works with serve or --sign-in.\n\n{}", help()));
    }
    Ok((command, import))
}

fn help() -> String {
    "PandaCode headless host (docs/headless.md)

Usage: pandacode serve [--sign-in [--device-name <name>]] [--sign-out] [--full-access | --no-full-access] [--export-bots <file>] [--import-bots <file>]

Runs this computer as an always-on PandaCode Connect host: your devices see it as a
computer and can start, watch, steer and approve tasks on it. Linux servers run it
under `xvfb-run -a pandacode serve …` (a display is required to start, none is used).

  --sign-in              First run: sign in with the GitHub device flow, enable hosting, then serve.
  --sign-out             Forget the Connect sign-in on this server and exit.
  --full-access          Let remote devices pick Full access (no approvals); exits after saving.
  --no-full-access       Require approvals again (the default); exits after saving.
  --device-name <name>   Name shown to your devices when signing in (default: the hostname).
  --import-bots <file>   Create/update bots, channels, schedules and rules from a JSON file
                         (docs/headless.md), then serve. Re-applying a file converges.
  --export-bots <file>   Write every bot's configuration (no secrets) to a JSON file and exit."
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(flags: &str) -> Vec<String> {
        flags.split_whitespace().map(str::to_owned).collect()
    }

    /// The command half of a parse, for tests that don't care about the import path.
    fn parsed(flags: &str) -> Result<Command, String> {
        parse(&argv(flags)).map(|(command, _)| command)
    }

    #[test]
    fn flags_parse_in_any_order() {
        assert_eq!(parsed(""), Ok(Command::Serve));
        assert_eq!(parsed("--sign-in"), Ok(Command::SignIn { name: None }));
        assert_eq!(
            parsed("--sign-in --device-name build-server"),
            Ok(Command::SignIn { name: Some("build-server".into()) })
        );
        assert_eq!(
            parsed("--device-name build-server --sign-in"),
            Ok(Command::SignIn { name: Some("build-server".into()) })
        );
        assert_eq!(parsed("--full-access"), Ok(Command::FullAccess { enabled: true }));
        assert_eq!(parsed("--no-full-access"), Ok(Command::FullAccess { enabled: false }));
        assert_eq!(parsed("--sign-out"), Ok(Command::SignOut));
        assert_eq!(
            parsed("--export-bots bots.json"),
            Ok(Command::ExportBots { path: PathBuf::from("bots.json") })
        );
        assert!(parsed("--wat").is_err());
        assert!(parsed("--device-name").is_err());
        assert!(parsed("--export-bots").is_err());
    }

    #[test]
    fn import_bots_is_a_modifier_not_an_op() {
        let (_, import) = parse(&argv("--import-bots bots.json")).unwrap();
        assert_eq!(import, Some(PathBuf::from("bots.json")));
        let (_, import) = parse(&argv("--sign-in --import-bots bots.json --device-name s")).unwrap();
        assert_eq!(import, Some(PathBuf::from("bots.json")));
        assert_eq!(parse(&argv("--import-bots bots.json")).unwrap().0, Command::Serve);
        // It still conflicts with the exclusive ops, which exit after saving.
        assert!(parse(&argv("--sign-out --import-bots bots.json")).is_err());
    }

    #[test]
    fn help_mentions_every_flag() {
        let text = help();
        for flag in [
            "--sign-in",
            "--sign-out",
            "--full-access",
            "--no-full-access",
            "--device-name",
            "--import-bots",
            "--export-bots",
            "xvfb-run",
        ] {
            assert!(text.contains(flag), "{flag}");
        }
    }

    #[test]
    fn only_live_unlimited_tasks_take_their_queue() {
        assert!(can_drain(false, None, None, 1000));
        assert!(can_drain(false, None, Some(1000), 1000));
        assert!(can_drain(false, Some(500), Some(1000), 1000));
        // Inside a limit (with or without a known reset), or archived: hold. limitActive
        // holds a limit with an unknown reset indefinitely; the resume send ends a run,
        // which then delivers the queue.
        assert!(!can_drain(false, Some(500), Some(1001), 1000));
        assert!(!can_drain(false, Some(500), None, 1000));
        assert!(!can_drain(true, None, None, 1000));
        assert!(!can_drain(true, None, Some(999), 1000));
        assert!(!can_drain(true, Some(500), Some(999), 1000));
    }

    #[test]
    fn ops_conflict() {
        assert!(parse(&argv("--sign-in --sign-out")).is_err());
        assert!(parse(&argv("--full-access --no-full-access")).is_err());
        assert!(parse(&argv("--sign-out --full-access")).is_err());
        // A name with a lone op is fine, in either order.
        assert!(parse(&argv("--sign-in --device-name x")).is_ok());
    }
}
