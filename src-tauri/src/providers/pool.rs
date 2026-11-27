//! A run on a harness with an account pool (`account_pool.rs`). A usage limit that ends a turn
//! is not the end of the run: the account is held, the session moves to the next ready account
//! and resumes there with "Continue where you left off.". A login that cannot be refreshed
//! (OAuth `unauthorized` / `authenticationRequired`) leaves the account the same way, since
//! another account can still run the task. The user's input reaches whichever attempt is
//! running; input sent while the run changes accounts waits for the next attempt.

use super::limits;
use super::{run_inner, AgentEvent, Protocol, RunConfig, RunInput, Sink, ToolHost};
use crate::account_pool as accounts;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// What one attempt saw: the harness session to resume and a limit or login it handed back.
#[derive(Default)]
struct Attempt {
    resume: Option<String>,
    /// The `limited` event held back in case another account takes over.
    limited: Option<AgentEvent>,
    /// The `error` event for a login that cannot be refreshed, held for the same reason.
    auth_failure: Option<AgentEvent>,
    /// Errors after either, sent if no other account takes over.
    errors: Vec<AgentEvent>,
}

/// Where user input goes: the running attempt, or a queue while the run changes accounts.
#[derive(Default)]
struct Route {
    sender: Option<UnboundedSender<RunInput>>,
    pending: Vec<RunInput>,
}

impl Route {
    fn send(&mut self, message: RunInput) {
        let message = match &self.sender {
            Some(sender) => match sender.send(message) {
                Ok(()) => return,
                Err(error) => error.0,
            },
            None => message,
        };
        // A steer that waits for the next account is acknowledged now, as one the harness takes
        // on its next turn, so the composer never resends it.
        let message = match message {
            RunInput::Steer { id, text, reply } => {
                let _ = reply.send(Ok(serde_json::json!({"steered": true, "id": id, "mode": "next-turn"})));
                RunInput::Steer { id, text, reply: tokio::sync::oneshot::channel().0 }
            }
            other => other,
        };
        self.pending.push(message);
    }

    fn open(&mut self) -> UnboundedReceiver<RunInput> {
        let (sender, receiver) = unbounded_channel();
        for message in self.pending.drain(..) {
            let _ = sender.send(message);
        }
        self.sender = Some(sender);
        receiver
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

async fn off_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

fn note(config: &RunConfig, sink: &Sink, text: String, switch: &accounts::Switch) {
    let mut event = Protocol::new(config.clone()).event("note", format!("Account switched\n{text}"), None);
    // The window updates the task's connection from this; the persisted row is the text.
    event.data = Some(serde_json::json!({"accountPool": {"connectionId": switch.connection}}));
    sink(event);
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// Why an attempt leaves its account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RotationReason {
    Limited,
    Auth,
}

/// Whether an `error` event is a login another account can take over from. A Codex payload
/// carries `codexErrorInfo` under its data; an event that only has a message is read by wording.
fn auth_failure_event(event: &AgentEvent) -> bool {
    event
        .data
        .as_ref()
        .is_some_and(|data| limits::codex_auth_failure(data.get("error").unwrap_or(data)))
        || limits::auth_failure_message(&event.text)
}

/// Why this attempt should move to another account, if it should. A login that cannot be
/// refreshed is the other accounts' chance to continue the task. The run's own error is checked
/// too: the Codex app-server auth path ends the attempt as `Err` without pushing an `error` event
/// through the sink, so its wording is the only thing the pool can classify.
fn rotation_reason(seen: &Attempt, result: &Result<(), String>) -> Option<RotationReason> {
    if seen.limited.is_some() {
        return Some(RotationReason::Limited);
    }
    if seen.auth_failure.is_some() || result.as_ref().err().is_some_and(|error| limits::auth_failure_message(error)) {
        return Some(RotationReason::Auth);
    }
    None
}

/// The switch note: a usage limit keeps the pool's own reason, while a broken login says so
/// instead and never claims the account ran out of quota.
fn switch_text(reason: RotationReason, from: &str, to: &str, limit_reason: &str) -> String {
    match reason {
        RotationReason::Limited => format!("{} {}, so this task continues on {}.", capitalized(from), limit_reason, to),
        RotationReason::Auth => format!("{} could not refresh its login, so this task continues on {}.", capitalized(from), to),
    }
}

/// Passes events on, keeping the session id and holding back a limit or broken login another
/// account can take.
fn watch(sink: Sink, attempt: Arc<Mutex<Attempt>>, stopped: Arc<AtomicBool>, provider: String, member: String) -> Sink {
    Arc::new(move |event: AgentEvent| {
        let mut seen = lock(&attempt);
        match event.kind.as_str() {
            "session" => seen.resume = Some(event.text.clone()),
            "limited" => {
                let data = event.data.as_ref();
                accounts::note_limit(&provider, &member, data.and_then(|d| d["resetsAt"].as_i64()), data.and_then(|d| d["window"].as_str()));
                if !stopped.load(Ordering::SeqCst) && accounts::has_alternative(&provider, &member) {
                    seen.limited = Some(event);
                    return;
                }
            }
            "error" => {
                if seen.limited.is_some() || seen.auth_failure.is_some() {
                    seen.errors.push(event);
                    return;
                }
                if auth_failure_event(&event) {
                    // A login that cannot be refreshed has no reset time, so the hold is the
                    // pool's unknown one: this account is not picked again until it is cleared.
                    accounts::note_limit(&provider, &member, None, None);
                    if !stopped.load(Ordering::SeqCst) && accounts::has_alternative(&provider, &member) {
                        seen.auth_failure = Some(event);
                        return;
                    }
                }
            }
            _ => {}
        }
        drop(seen);
        sink(event);
    })
}

/// A stop taken before the next account started: reported with the status a run loop gives
/// when it takes a stop (`STOPPING_STATUS`), so a team worker's stop counts as taken.
fn stopped_between_accounts(config: &RunConfig, sink: &Sink) {
    super::stop_taken();
    sink(AgentEvent {
        session_id: config.session_id.clone(),
        kind: "status".into(),
        text: super::STOPPING_STATUS.into(),
        request_id: None,
        data: None,
        tool: None,
    });
}

/// Sessions whose pooled run is between accounts (choosing one, or rotating after a limit):
/// input waits in `Route::pending` until the next account starts.
/// Marked per run (session and this pool run's own token), so overlapping runs of one task never
/// clear each other's mark; asked per session.
static SWITCHING: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

pub(super) fn switching(session_id: &str) -> bool {
    lock(&SWITCHING).iter().any(|(session, _)| session == session_id)
}

/// One pool run's switching mark; cleared however the run ends.
struct SwitchingMark {
    session_id: String,
    token: String,
}
impl SwitchingMark {
    fn new(session_id: &str) -> Self {
        Self { session_id: session_id.to_owned(), token: uuid::Uuid::new_v4().to_string() }
    }

    fn set(&self, on: bool) {
        let mut switching = lock(&SWITCHING);
        switching.retain(|(session, token)| !(session == &self.session_id && token == &self.token));
        if on {
            switching.push((self.session_id.clone(), self.token.clone()));
        }
    }
}
impl Drop for SwitchingMark {
    fn drop(&mut self) {
        self.set(false);
    }
}

/// Leaving an account: answers and approvals queued for its process can never reach it (the
/// next account's harness never asked them), so they are dropped, closing their replies, and
/// the run's owner is told to settle what the old account left open.
fn leave_account(route: &Mutex<Route>, config: &RunConfig, sink: &Sink) {
    lock(route).pending.retain(|message| !matches!(message, RunInput::UserInput { .. } | RunInput::Approval { .. }));
    sink(AgentEvent {
        session_id: config.session_id.clone(),
        kind: super::ACCOUNT_SWITCHED.into(),
        text: String::new(),
        request_id: None,
        data: None,
        tool: None,
    });
}

/// A rotated account resumes mid-turn. The rewritten prompt must not fall through to a fresh session.
pub(super) fn continue_on_rotated_account(config: &mut RunConfig, resume: Option<String>) {
    if resume.is_some() {
        config.resume_id = resume;
        config.prompt = "Continue where you left off.".into();
        config.images.clear();
        config.skill = None;
        config.no_fresh_resume_fallback = true;
    }
}

pub(super) async fn run(mut config: RunConfig, sink: Sink, mut input: UnboundedReceiver<RunInput>, host: Option<ToolHost>) -> Result<(), String> {
    // Between accounts until the first one starts.
    let switching_mark = SwitchingMark::new(&config.session_id);
    switching_mark.set(true);
    let route = Arc::new(Mutex::new(Route::default()));
    let stopped = Arc::new(AtomicBool::new(false));
    // Input is taken from the first moment, so a Stop pressed while an account is chosen counts.
    let relay = {
        let (route, stopped) = (route.clone(), stopped.clone());
        tokio::spawn(async move {
            while let Some(message) = input.recv().await {
                if matches!(message, RunInput::Stop) {
                    stopped.store(true, Ordering::SeqCst);
                }
                lock(&route).send(message);
            }
            stopped.store(true, Ordering::SeqCst);
            let mut route = lock(&route);
            route.sender = None;
            route.pending.push(RunInput::Stop);
        })
    };
    let (session, provider) = (config.session_id.clone(), config.provider.clone());
    let resume = config.resume_id.clone();
    let prepared = off_thread(move || accounts::prepare(&session, &provider, resume.as_deref())).await.flatten();
    let mut claimed = None;
    if let Some(switch) = prepared {
        note(&config, &sink, format!("Using {} because {} {}.", switch.to, switch.from, switch.reason), &switch);
        claimed = Some(switch.claim);
    }
    let mut result = Ok(());
    // Each account gets at most one attempt per run.
    let accounts_count = crate::connections::pool_members(&config.provider).len() + 1;
    for attempt_number in 0..accounts_count {
        // Stopped while the run changed accounts: the next account never starts. The stop was
        // taken here, so the run's owner is told as a harness loop would tell it.
        if stopped.load(Ordering::SeqCst) {
            stopped_between_accounts(&config, &sink);
            result = Ok(());
            break;
        }
        let receiver = lock(&route).open();
        switching_mark.set(false);
        let attempt = Arc::new(Mutex::new(Attempt::default()));
        let member = accounts::member(&config.session_id, &config.provider);
        let _active = claimed.take().unwrap_or_else(|| accounts::begin(&config.provider, &member));
        let watched = watch(sink.clone(), attempt.clone(), stopped.clone(), config.provider.clone(), member.clone());
        result = run_inner(config.clone(), watched, receiver, host.clone()).await;
        lock(&route).sender = None;
        switching_mark.set(true);
        let seen = std::mem::take(&mut *lock(&attempt));
        let Some(reason) = rotation_reason(&seen, &result) else { break };
        if reason == RotationReason::Auth {
            // The login cannot be refreshed here: hold the member so this run and the next never
            // pick it again, even when no other account can take over now. The hold uses the
            // pool's unknown reset time, as the event path already did.
            accounts::note_limit(&config.provider, &member, None, None);
        }
        let resume = seen.resume.or_else(|| config.resume_id.clone());
        // A limit inside a turn that still finished (a fallback model, overage) needs no move.
        let switch = if result.is_err() && attempt_number + 1 < accounts_count && !stopped.load(Ordering::SeqCst) {
            let (session, provider, resume) = (config.session_id.clone(), config.provider.clone(), resume.clone());
            off_thread(move || accounts::rotate(&session, &provider, resume.as_deref())).await.flatten()
        } else {
            None
        };
        let Some(switch) = switch else {
            if let Some(limited) = seen.limited {
                sink(limited);
            }
            if let Some(error) = seen.auth_failure {
                sink(error);
            }
            seen.errors.into_iter().for_each(|error| sink(error));
            break;
        };
        let text = switch_text(reason, &switch.from, &switch.to, switch.reason);
        note(&config, &sink, text, &switch);
        leave_account(&route, &config, &sink);
        claimed = Some(switch.claim);
        // With a session to resume the new account picks up mid-turn; without one, the turn
        // never started anywhere, so the same request goes again.
        continue_on_rotated_account(&mut config, resume);
    }
    relay.abort();
    // Wait for the relay to stop, so a steer it was queuing is in `pending` below.
    let _ = relay.await;
    // A steer acknowledged while the run changed accounts but never reached one goes back to the
    // composer's queue, as one the agent did not take.
    let unsent = std::mem::take(&mut lock(&route).pending);
    for message in unsent {
        if let RunInput::Steer { id, text, .. } = message {
            let mut event = Protocol::new(config.clone()).steer_event(&id, &text, "failed", "next-turn");
            if let Some(data) = event.data.as_mut() {
                data["reason"] = "The run ended before another account took it.".into();
            }
            sink(event);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn leaving_an_account_drops_its_answers_and_tells_the_owner() {
        let route = Mutex::new(Route::default());
        let (steer_reply, _steer) = tokio::sync::oneshot::channel();
        {
            let mut route = lock(&route);
            route.pending.push(RunInput::UserInput { request_id: "q".into(), response: serde_json::json!({}), reply: None });
            route.pending.push(RunInput::Approval { request_id: "a".into(), approved: true });
            route.pending.push(RunInput::Steer { id: "s".into(), text: "Keep going".into(), reply: steer_reply });
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event| seen.lock().unwrap().push(event));
        leave_account(&route, &super::super::tests::config("claude"), &sink);
        let pending = &lock(&route).pending;
        assert_eq!(pending.len(), 1, "only the steer goes on to the next account");
        assert!(matches!(pending[0], RunInput::Steer { .. }));
        assert_eq!(events.lock().unwrap()[0].kind, super::super::ACCOUNT_SWITCHED);
    }

    #[test]
    fn overlapping_runs_keep_their_own_switching_marks() {
        let first = SwitchingMark::new("overlap-session");
        let second = SwitchingMark::new("overlap-session");
        first.set(true);
        second.set(true);
        drop(first);
        assert!(switching("overlap-session"), "the other run is still switching");
        drop(second);
        assert!(!switching("overlap-session"));
    }

    #[tokio::test]
    async fn a_stop_taken_between_accounts_marks_the_run() {
        let taken = Arc::new(AtomicBool::new(false));
        let sink: Sink = Arc::new(|_| {});
        super::super::STOP_TAKEN.scope(taken.clone(), async { stopped_between_accounts(&super::super::tests::config("claude"), &sink) }).await;
        assert!(taken.load(Ordering::SeqCst));
    }

    #[test]
    fn a_stop_taken_between_accounts_is_reported_as_taken() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event| seen.lock().unwrap().push(event));
        stopped_between_accounts(&super::super::tests::config("claude"), &sink);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].kind.as_str(), events[0].text.as_str()), ("status", super::super::STOPPING_STATUS));
    }

    use super::*;

    #[test]
    fn input_waits_while_the_run_changes_accounts() {
        let mut route = Route::default();
        let first = route.open();
        drop(first);
        route.send(RunInput::Stop);
        assert_eq!(route.pending.len(), 1, "a closed attempt does not swallow input");
        route.sender = None;
        route.send(RunInput::Stop);
        let mut next = route.open();
        assert!(matches!(next.try_recv(), Ok(RunInput::Stop)));
        assert!(matches!(next.try_recv(), Ok(RunInput::Stop)));
        assert!(route.pending.is_empty());
    }

    #[test]
    fn a_rotated_account_blocks_a_fresh_session_for_the_resume_prompt() {
        let mut config = super::super::tests::config("antigravity");
        config.images.push(std::path::PathBuf::from("shot.png"));
        config.skill = Some(("review".into(), std::path::PathBuf::from("/skills/review")));
        super::continue_on_rotated_account(&mut config, Some("saved".into()));
        assert_eq!(config.resume_id.as_deref(), Some("saved"));
        assert_eq!(config.prompt, "Continue where you left off.");
        assert!(config.images.is_empty());
        assert!(config.skill.is_none());
        assert!(config.no_fresh_resume_fallback);
        let mut fresh = super::super::tests::config("antigravity");
        super::continue_on_rotated_account(&mut fresh, None);
        assert!(!fresh.no_fresh_resume_fallback);
        assert_eq!(fresh.prompt, "Explain this project");
    }

    fn error_event(text: &str, data: Option<serde_json::Value>) -> AgentEvent {
        AgentEvent { session_id: "s".into(), kind: "error".into(), text: text.into(), request_id: None, data, tool: None }
    }

    #[test]
    fn an_auth_failure_moves_the_attempt_instead_of_ending_the_run() {
        // Held by watch for an `error` event that names an unrefreshable login.
        let held = Attempt { auth_failure: Some(error_event("login failed", None)), ..Attempt::default() };
        assert_eq!(rotation_reason(&held, &Ok(())), Some(RotationReason::Auth), "a held auth error moves accounts");
        // The Codex app-server path ends the attempt with `Err` and no `error` event, so the
        // run's own error is classified too.
        let empty = Attempt::default();
        assert_eq!(rotation_reason(&empty, &Err("unauthorized".into())), Some(RotationReason::Auth));
        assert_eq!(rotation_reason(&empty, &Err("failed to refresh token while getting account: 403 Forbidden".into())), Some(RotationReason::Auth));
        // A bad request, a per-turn context limit, and a finished turn never move.
        assert_eq!(rotation_reason(&empty, &Err("badRequest: missing field `model`".into())), None);
        assert_eq!(rotation_reason(&empty, &Err("contextWindowExceeded".into())), None);
        assert_eq!(rotation_reason(&empty, &Ok(())), None);
    }

    #[test]
    fn the_limit_reason_wins_when_an_attempt_saw_both() {
        let limited = Attempt { limited: Some(error_event("limited", None)), ..Attempt::default() };
        assert_eq!(rotation_reason(&limited, &Err("You have reached your usage limit".into())), Some(RotationReason::Limited));
        let both = Attempt {
            limited: Some(error_event("limited", None)),
            auth_failure: Some(error_event("unauthorized", None)),
            ..Attempt::default()
        };
        assert_eq!(rotation_reason(&both, &Err("unauthorized".into())), Some(RotationReason::Limited), "the usage-limit note keeps its wording");
    }

    #[test]
    fn an_auth_switch_note_says_the_login_could_not_be_refreshed() {
        let auth = switch_text(RotationReason::Auth, "the default Codex account", "“Backup”", "reached its usage limit");
        assert_eq!(auth, "The default Codex account could not refresh its login, so this task continues on “Backup”.");
        assert!(!auth.contains("usage limit"), "an auth hold is not a quota limit: {auth}");
        // The usage-limit wording stays exactly as it was.
        assert_eq!(
            switch_text(RotationReason::Limited, "the default Codex account", "“Backup”", "reached its usage limit"),
            "The default Codex account reached its usage limit, so this task continues on “Backup”."
        );
    }

    #[test]
    fn an_error_event_names_a_bad_login_from_its_payload_or_its_wording() {
        for info in [serde_json::json!("unauthorized"), serde_json::json!({"authenticationRequired": {}})] {
            let event = error_event("login failed", Some(serde_json::json!({"error": {"codexErrorInfo": info}})));
            assert!(auth_failure_event(&event), "{info}");
        }
        assert!(auth_failure_event(&error_event("", Some(serde_json::json!({"codexErrorInfo": "authenticationRequired"})))));
        assert!(auth_failure_event(&error_event(
            "Your access token could not be refreshed. Please log out and sign in again.",
            None,
        )));
        assert!(!auth_failure_event(&error_event("badRequest: bad input", Some(serde_json::json!({"codexErrorInfo": "badRequest"})))));
        assert!(!auth_failure_event(&error_event("usageLimitExceeded", Some(serde_json::json!({"codexErrorInfo": "usageLimitExceeded"})))));
        assert!(!auth_failure_event(&error_event("rate limit exceeded", None)));
        assert!(!auth_failure_event(&error_event("context window exceeded", None)));
        assert!(!auth_failure_event(&error_event("The run was cancelled by the user", None)));
    }
}
