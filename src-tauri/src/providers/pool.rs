//! A run on a harness with an account pool (`account_pool.rs`). A usage limit that ends a turn
//! is not the end of the run: the account is held, the session moves to the next ready account
//! and resumes there with "Continue where you left off.". The user's input reaches whichever
//! attempt is running; input sent while the run changes accounts waits for the next attempt.

use super::{run_inner, AgentEvent, Protocol, RunConfig, RunInput, Sink, ToolHost};
use crate::account_pool as accounts;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// What one attempt saw: the harness session to resume and a limit it handed back.
#[derive(Default)]
struct Attempt {
    resume: Option<String>,
    /// The `limited` event held back in case another account takes over.
    limited: Option<AgentEvent>,
    /// Errors after it, sent if no other account takes over.
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

/// Passes events on, keeping the session id and holding back a limit another account can take.
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
            "error" if seen.limited.is_some() => {
                seen.errors.push(event);
                return;
            }
            _ => {}
        }
        drop(seen);
        sink(event);
    })
}

pub(super) async fn run(mut config: RunConfig, sink: Sink, mut input: UnboundedReceiver<RunInput>, host: Option<ToolHost>) -> Result<(), String> {
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
        // Stopped while the run changed accounts: the next account never starts.
        if stopped.load(Ordering::SeqCst) {
            result = Ok(());
            break;
        }
        let receiver = lock(&route).open();
        let attempt = Arc::new(Mutex::new(Attempt::default()));
        let member = accounts::member(&config.session_id, &config.provider);
        let _active = claimed.take().unwrap_or_else(|| accounts::begin(&config.provider, &member));
        let watched = watch(sink.clone(), attempt.clone(), stopped.clone(), config.provider.clone(), member);
        result = run_inner(config.clone(), watched, receiver, host.clone()).await;
        lock(&route).sender = None;
        let seen = std::mem::take(&mut *lock(&attempt));
        let Some(limited) = seen.limited else { break };
        let resume = seen.resume.or_else(|| config.resume_id.clone());
        // A limit inside a turn that still finished (a fallback model, overage) needs no move.
        let switch = if result.is_err() && attempt_number + 1 < accounts_count && !stopped.load(Ordering::SeqCst) {
            let (session, provider, resume) = (config.session_id.clone(), config.provider.clone(), resume.clone());
            off_thread(move || accounts::rotate(&session, &provider, resume.as_deref())).await.flatten()
        } else {
            None
        };
        let Some(switch) = switch else {
            sink(limited);
            seen.errors.into_iter().for_each(|error| sink(error));
            break;
        };
        note(&config, &sink, format!("{} {}, so this task continues on {}.", capitalized(&switch.from), switch.reason, switch.to), &switch);
        claimed = Some(switch.claim);
        // With a session to resume the new account picks up mid-turn; without one, the turn
        // never started anywhere, so the same request goes again.
        if resume.is_some() {
            config.resume_id = resume;
            config.prompt = "Continue where you left off.".into();
            config.images.clear();
            config.skill = None;
        }
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
}
