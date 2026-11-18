//! Running Claude Code for a check that has no reading (`worth_asking`):
//! taking a run, waiting for it without holding a shared slot, joining one
//! under way, reading the stores again, and what the card says when nothing
//! better came of it.

use super::*;

/// Anything but a reading (`worth_asking`): Claude Code is run (if allowed,
/// once per 15 minutes, never on a locked Keychain) so it refreshes or
/// reports its own login, and the stores are read again after any run that
/// exited. A fresh reading wins; else the usage Claude Code printed; else
/// what its run says; else the re-read, or `otherwise` when nothing ran.
pub(super) async fn ask_claude(stores: &[Store], check: &Check, blocked: Option<Instant>, otherwise: Usage) -> Usage {
    // Claude Code can't read a locked Keychain either, and must not prompt.
    if !stores.iter().all(keychain_unlocked) {
        return otherwise;
    }
    let about_login = matches!(otherwise.cause, Some(Cause::Expired | Cause::SignInAgain));
    // Another Claude Code is refreshing this login right now: no second
    // refresher; the store is read again (it may have saved by now).
    if refresh_in_progress(check) {
        return reread_or(stores, check, blocked, otherwise).await;
    }
    let run = match cli::start(&check.cli, &check.profile.key, check.refresh, left(check).saturating_sub(cli::MARGIN)) {
        Ok(run) => run,
        Err(cli::NotRun::Outdated) if about_login => return *usage(UPDATE_CLAUDE),
        Err(cli::NotRun::Running) => return join_run(stores, check, blocked, otherwise).await,
        Err(_) if ended_since_start(check) => return reread_or(stores, check, blocked, otherwise).await,
        Err(cli::NotRun::Waiting) if about_login => return next_try(otherwise, &check.profile.key),
        Err(_) => return otherwise,
    };
    let mut handle = spawn_run(run, stores, check);
    let waiting = tokio::time::timeout(left(check).saturating_sub(cli::MARGIN), &mut handle);
    let outcome = match crate::agent_usage::without_slot(waiting).await {
        Ok(Ok(outcome)) => outcome,
        // The run's thread failed: a failed run, not a slow one.
        Ok(Err(_)) => cli::Outcome::Failed,
        Err(_) => return *usage(STILL_RUNNING),
    };
    if matches!(outcome, cli::Outcome::NotStarted) {
        return otherwise;
    }
    let reread = reread(stores, check, blocked).await;
    if let Some(reading) = reread.as_ref().filter(|reading| reading.status == "ready" && !reading.stale) {
        return reading.clone();
    }
    match outcome {
        cli::Outcome::Printed(printed) => *printed,
        cli::Outcome::Outdated => *usage(UPDATE_CLAUDE),
        cli::Outcome::SignIn => *usage(CLI_SIGN_IN),
        cli::Outcome::NoUsage => *usage(CLI_NO_USAGE),
        _ if about_login => cli_failed(&check.profile.key),
        _ => reread.unwrap_or(otherwise),
    }
}

/// Starts a taken run. The stores' remembered logins are forgotten now and
/// again when it ends (even after its check stopped waiting): the next check
/// reads what Claude Code saved, not a copy read while it ran. Usage it
/// printed is saved as it ends (marked from Claude Code, `cli::SOURCE`), so a
/// check that stopped waiting, or the next one, still shows it.
fn spawn_run(run: cli::Run, stores: &[Store], check: &Check) -> tokio::task::JoinHandle<cli::Outcome> {
    let watched = stores.to_vec();
    let run = run.guarded(Arc::new(move || watched.iter().all(keychain_unlocked)));
    let forget = stores.to_vec();
    remembered().retain(|store, _| !forget.contains(store));
    let (profile, file, runtime) = (check.profile.clone(), check.account_file.clone(), tokio::runtime::Handle::current());
    run.spawn(move |outcome| {
        forget_after_run(&forget);
        if let cli::Outcome::Printed(printed) = outcome {
            // Under the account signed in now (Claude Code may have switched).
            let profile = profile.with_email(file.as_deref().and_then(setup::account_in));
            runtime.block_on(limits::remember(&profile, printed));
        }
    })
}

/// A run for this setup is already under way (a Refresh pressed meanwhile,
/// say): no second process; wait for it (the card says "Asking Claude
/// Code…"), then read what it saved.
async fn join_run(stores: &[Store], check: &Check, blocked: Option<Instant>, otherwise: Usage) -> Usage {
    let wait = cli::wait_for_run(&check.profile.key, left(check).saturating_sub(cli::MARGIN));
    crate::agent_usage::without_slot(wait).await;
    reread_or(stores, check, blocked, otherwise).await
}

/// Claude Code's refresh lock, in its config folder: a folder Claude Code
/// holds while it refreshes the login (made with `proper-lockfile`, touched
/// every 5 s, counted stale after 60 s), so its own sessions never refresh at
/// once. Checked in Claude Code 2.1.322.
pub(super) const REFRESH_LOCK: &str = ".oauth_refresh.lock";
const REFRESH_LOCK_FRESH: Duration = Duration::from_secs(60);

/// Whether another Claude Code holds its refresh lock now (touched within the
/// last 60 s; a time in the future counts too).
fn refresh_in_progress(check: &Check) -> bool {
    let touched = check.refresh_lock.as_deref().and_then(|lock| std::fs::metadata(lock).ok()).and_then(|meta| meta.modified().ok());
    touched.is_some_and(|at| at.elapsed().map_or(true, |age| age < REFRESH_LOCK_FRESH))
}

/// A fresh reading from the stores read again, else `otherwise`.
async fn reread_or(stores: &[Store], check: &Check, blocked: Option<Instant>, otherwise: Usage) -> Usage {
    let reread = reread(stores, check, blocked).await;
    reread.filter(|reading| reading.status == "ready" && !reading.stale).unwrap_or(otherwise)
}

/// Whether a run for this setup ended after this check began: what it read
/// may be the login Claude Code has since replaced.
fn ended_since_start(check: &Check) -> bool {
    let started = check.ends.map(|ends| ends - check.deadline);
    started.is_some_and(|started| cli::ended_since(&check.profile.key, started))
}

/// The stores read again after a run, within all the check has left; `None`
/// if that runs out.
async fn reread(stores: &[Store], check: &Check, blocked: Option<Instant>) -> Option<Usage> {
    let again = Check { cli: cli::Cli::Used, ..check.clone() };
    // A rate limit met in this check holds for the re-read too.
    let blocked = limits::blocked(&check.profile, Instant::now(), check.refresh).or(blocked);
    tokio::time::timeout(left(check), check_stores(stores, &again, blocked, false)).await.ok().map(|checked| checked.usage)
}

/// A failed run of Claude Code after an expired login: when it runs again.
fn cli_failed(profile: &str) -> Usage {
    next_try(*usage(CLI_FAILED), profile)
}

/// When Claude Code may next be run for `profile`: opening the panel then
/// asks it (`auto_retry_at`); once a Refresh you press has used its extra
/// run, a Refresh waits for that time too (`retry_at`: "Next try after…").
fn next_try(mut result: Usage, profile: &str) -> Usage {
    let at = |wait: Duration| now_ms() + wait.as_millis() as u64;
    result.auto_retry_at = Some(at(cli::until_next(profile)));
    // A Refresh always reads the login and the service again; only its run
    // of Claude Code waits, for the 15-minute slot (backoffs never hold it).
    result.retry_at = (!cli::manual_left(profile)).then(|| at(cli::until_slot(profile)));
    result
}
