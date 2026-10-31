//! Backup models (docs/bots.md). When a bot conversation's turn ends with a usage limit or a
//! provider error before it wrote or ran anything, the message moves to the next ready model:
//! at once (`auto`), or after the user answers a card (`ask`). A usage limit holds its model
//! until the reset, a provider error for ten minutes; once the model the conversation left is
//! ready again, the next message goes back to it, unless the user picked a model meanwhile.
//!
//! Holds live in memory, so a restart clears them and the next message goes back at once.
//! Each switch is recorded as `bot_activity` of kind `model-switch` (detail: sessionId, cause,
//! back, provider, model) and emitted as `bot-model-switch`; the window draws it as a centered
//! system row with `modelSwitchMarkerHtml`. An `ask` hold is emitted as `bot-failover`.

use super::{BackupModel, Bot};
use crate::{storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

const ERROR_HOLD: i64 = 10 * 60_000;
// ponytail: a limit without a reset time holds for an hour; read the provider's window if that misses.
const UNKNOWN_RESET_HOLD: i64 = 60 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Cause {
    Limit,
    ProviderError,
}

/// The model a conversation left, kept so it can go back when that model is ready again.
#[derive(Debug, Clone, PartialEq)]
struct Return {
    to: BackupModel,
    /// The model it was moved to; any other model means the user chose one.
    via: BackupModel,
    cause: Cause,
}

/// An `ask` hold: the card the window shows until the user decides.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub bot_id: String,
    pub session_id: String,
    pub cause: Cause,
    pub provider: String,
    pub model: String,
    pub target: BackupModel,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Default)]
pub(crate) struct Failover {
    /// (provider, model) → held until.
    holds: HashMap<(String, String), i64>,
    returns: HashMap<String, Return>,
    /// Models that already failed the held message of a conversation; each gets it once.
    tried: HashMap<String, Vec<BackupModel>>,
    asks: HashMap<String, Ask>,
    images: HashMap<String, Vec<String>>,
}

fn key(model: &BackupModel) -> (String, String) {
    (model.provider.clone(), model.model.clone())
}

impl Failover {
    fn held(&self, model: &BackupModel, now: i64) -> bool {
        self.holds.get(&key(model)).is_some_and(|until| *until > now)
    }

    pub(crate) fn hold(&mut self, model: &BackupModel, until: i64) {
        self.holds.insert(key(model), until);
    }

    /// The first model in the bot's order (main, then backups) that is not the current one,
    /// not held, and has not failed this message yet.
    pub(crate) fn next(&self, bot: &Bot, session: &str, current: &BackupModel, now: i64) -> Option<BackupModel> {
        let tried = self.tried.get(session).map(Vec::as_slice).unwrap_or_default();
        std::iter::once(BackupModel { provider: bot.provider.clone(), model: bot.model.clone() })
            .chain(bot.backup_models.iter().cloned())
            .find(|model| model != current && !tried.contains(model) && !self.held(model, now))
    }

    /// Records a failure on `current` and picks where the message goes next.
    pub(crate) fn failed(&mut self, bot: &Bot, session: &str, current: &BackupModel, cause: Cause, resets_at: Option<i64>, now: i64) -> Option<BackupModel> {
        let until = match cause {
            Cause::Limit => resets_at.filter(|at| *at > now).unwrap_or(now + UNKNOWN_RESET_HOLD),
            Cause::ProviderError => now + ERROR_HOLD,
        };
        self.hold(current, until);
        let tried = self.tried.entry(session.to_owned()).or_default();
        if !tried.contains(current) {
            tried.push(current.clone());
        }
        self.next(bot, session, current, now)
    }

    /// Notes a switch so the conversation can go back to the model it first left.
    pub(crate) fn switched(&mut self, session: &str, from: &BackupModel, to: &BackupModel, cause: Cause) {
        let left = self.returns.get(session).map(|ret| ret.to.clone()).unwrap_or_else(|| from.clone());
        if left == *to {
            self.returns.remove(session);
        } else {
            self.returns.insert(session.to_owned(), Return { to: left, via: to.clone(), cause });
        }
    }

    /// The model to go back to before the next turn, if its hold ended. A model the user
    /// picked since the switch cancels the return.
    pub(crate) fn due_return(&mut self, session: &str, current: &BackupModel, now: i64) -> Option<(BackupModel, Cause)> {
        let ret = self.returns.get(session)?;
        if ret.via != *current {
            self.returns.remove(session);
            return None;
        }
        if self.held(&ret.to, now) {
            return None;
        }
        self.returns.remove(session).map(|ret| (ret.to, ret.cause))
    }

    /// A turn completed: its message is no longer held.
    pub(crate) fn completed(&mut self, session: &str) {
        self.tried.remove(session);
    }
}

fn state() -> &'static Mutex<Failover> {
    static STATE: std::sync::OnceLock<Mutex<Failover>> = std::sync::OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// A provider error worth another model; anything else (a bad request, a refused tool) is not.
pub(crate) fn provider_error(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        "overloaded", "unavailable", "rate limit", "rate_limit", "too many requests", "429", "500 ", "502", "503", "529",
        "internal server error", "bad gateway", "timed out", "timeout", "network", "connection", "econnreset",
        "billing", "credit balance", "quota", "insufficient", "unauthorized", "authentication", "401",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn remembered_backups(existing: &[BackupModel], target: &BackupModel) -> Vec<BackupModel> {
    let mut models = vec![target.clone()];
    models.extend(existing.iter().filter(|item| *item != target).take(3).cloned());
    models
}

/// The turn that just failed, if it wrote and ran nothing: the prompt row and its text, whether
/// it hit a usage limit (and when that resets), and its error text.
#[derive(Debug, PartialEq)]
pub(crate) struct FailedTurn {
    pub prompt_id: i64,
    pub text: String,
    pub image_ids: Vec<String>,
    pub limited: Option<Option<i64>>,
    pub errors: String,
}

pub(crate) fn failed_turn(store: &Store, session: &str) -> Result<Option<FailedTurn>> {
    let prompt: Option<(i64, String, i64)> = store
        .db
        .query_row("SELECT id,content,created_at FROM messages WHERE session_id=?1 AND role='user' ORDER BY id DESC LIMIT 1", [session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((prompt_id, text, at)) = prompt else { return Ok(None) };
    let acted: bool = store
        .db
        .query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id>?2 AND role IN ('assistant','tool') AND trim(content)<>'')", params![session, prompt_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if acted {
        return Ok(None);
    }
    let errors: String = store
        .db
        .query_row("SELECT COALESCE(group_concat(content,'\n'),'') FROM messages WHERE session_id=?1 AND id>?2 AND role='error'", params![session, prompt_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let task = store.session(session)?;
    let limited = task.limited_at.filter(|limited| *limited >= at).map(|_| task.limited_until);
    Ok(Some(FailedTurn { prompt_id, text, image_ids: Vec::new(), limited, errors }))
}

fn failed_turn_with_images(store: &Store, session: &str) -> Result<Option<FailedTurn>> {
    let mut turn = failed_turn(store, session)?;
    if let Some(turn) = &mut turn {
        turn.image_ids = state().lock().ok().and_then(|failover| failover.images.get(session).cloned()).unwrap_or_default();
    }
    Ok(turn)
}

pub(crate) enum Outcome {
    /// Normal error handling.
    None,
    /// The message runs again on another model.
    Switched,
    /// The message waits for the user; channel threads get this text.
    Held(String),
}

fn current(store: &Store, session: &str) -> Result<BackupModel> {
    let task = store.session(session)?;
    Ok(BackupModel { provider: task.provider, model: task.model })
}

/// After a failed run of a bot conversation: switch, hold, or leave it to the error path.
pub(crate) async fn after_failure(app: &tauri::AppHandle, bot: &Bot, session: &str) -> Outcome {
    if bot.backup_models.is_empty() {
        return Outcome::None;
    }
    let found = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return Outcome::None };
        match (failed_turn_with_images(&store, session), current(&store, session)) {
            (Ok(Some(turn)), Ok(model)) => Some((turn, model)),
            _ => None,
        }
    };
    let Some((turn, from)) = found else { return Outcome::None };
    let (cause, resets_at) = match turn.limited {
        Some(until) => (Cause::Limit, until),
        None if provider_error(&turn.errors) => (Cause::ProviderError, None),
        None => return Outcome::None,
    };
    let now = crate::storage::now();
    let Some(target) = state().lock().ok().and_then(|mut failover| failover.failed(bot, session, &from, cause, resets_at, now)) else { return Outcome::None };
    if bot.fallback_mode != "auto" {
        let ask = Ask { bot_id: bot.id.clone(), session_id: session.into(), cause, provider: from.provider, model: from.model, target, resets_at };
        if let Ok(mut failover) = state().lock() {
            failover.asks.insert(session.into(), ask.clone());
        }
        super::note(app, &bot.id, "failover", "Message on hold", json!({"sessionId": session}));
        let _ = app.emit("bot-failover", &ask);
        return Outcome::Held(format!("Usage of {} ran out. Your message is on hold: choose another model in PandaCode, or wait for the reset.", ask.model));
    }
    match switch(app, bot, session, &turn, &from, &target, cause).await {
        Ok(()) => Outcome::Switched,
        Err(error) => {
            super::note(app, &bot.id, "error", &format!("Couldn't switch to a backup model: {}", error.chars().take(160).collect::<String>()), json!({"sessionId": session}));
            Outcome::None
        }
    }
}

fn marker(cause: Cause, back: bool, model: &str) -> String {
    match (cause, back) {
        (Cause::Limit, false) => format!("Usage limit reached. Switched to {model}."),
        (Cause::Limit, true) => format!("Usage limit ended. Switched back to {model}."),
        (Cause::ProviderError, false) => format!("Provider error. Switched to {model}."),
        (Cause::ProviderError, true) => format!("Switched back to {model} after the provider error."),
    }
}

/// Records and announces a switch in the conversation.
fn record(app: &tauri::AppHandle, store: &Store, bot: &Bot, session: &str, to: &BackupModel, cause: Cause, back: bool) -> Result<()> {
    let detail = json!({"sessionId": session, "cause": cause, "back": back, "provider": to.provider, "model": to.model});
    super::log(store, &bot.id, "model-switch", &marker(cause, back, &to.model), detail.clone())?;
    let _ = app.emit("bot-model-switch", json!({"botId": bot.id, "at": crate::storage::now(), "text": marker(cause, back, &to.model), "detail": detail}));
    Ok(())
}

/// Moves the held message to `to`: the failed turn's rows go, the conversation changes model,
/// and the same prompt runs again (its brief is already part of the text).
async fn switch(app: &tauri::AppHandle, bot: &Bot, session: &str, turn: &FailedTurn, from: &BackupModel, to: &BackupModel, cause: Cause) -> Result<()> {
    let held = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.db.query_row("SELECT content,created_at FROM messages WHERE session_id=?1 AND id=?2 AND role='user'", params![session, turn.prompt_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|e| e.to_string())?
    };
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        // Configure first (it opens its own transaction for the handoff), so a refusal keeps the prompt.
        store.configure(session, &to.provider, &to.model, None)?;
        store.db.execute("DELETE FROM messages WHERE session_id=?1 AND id>=?2", params![session, turn.prompt_id]).map_err(|e| e.to_string())?;
        if let Err(error) = record(app, &store, bot, session, to, cause, false) {
            let _ = store.db.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?1,?2,'user',?3,?4)", params![turn.prompt_id,session,held.0,held.1]);
            let _ = store.configure(session, &from.provider, &from.model, None);
            return Err(error);
        }
    }
    if let Ok(mut failover) = state().lock() {
        failover.switched(session, from, to, cause);
    }
    let _ = app.emit("sessions-changed", ());
    let result = crate::launch_task_in_project(app.clone(), app.state::<AppState>(), session.to_owned(), Some(turn.text.clone()), Some(turn.image_ids.clone()), Some(bot.project_id.clone())).await;
    if let Err(error) = result {
        let state = app.state::<AppState>();
        if let Ok(store) = state.store.lock() {
            let _ = store.db.execute("DELETE FROM messages WHERE session_id=?1 AND id>=?2", params![session, turn.prompt_id]);
            let _ = store.db.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?1,?2,'user',?3,?4)", params![turn.prompt_id,session,held.0,held.1]);
            let _ = store.configure(session, &from.provider, &from.model, None);
        }
        return Err(error);
    }
    Ok(())
}

/// Before a bot conversation's next turn: go back to the model it left once that model is ready.
pub(crate) fn before_turn(app: &tauri::AppHandle, bot: &Bot, session: &str) {
    let state = app.state::<AppState>();
    let Ok(store) = state.store.lock() else { return };
    let Ok(now_on) = current(&store, session) else { return };
    let due = state_due(session, &now_on);
    let Some((to, cause)) = due else { return };
    let moved = store.configure(session, &to.provider, &to.model, None).and_then(|_| record(app, &store, bot, session, &to, cause, true));
    if let Err(error) = moved {
        let _ = super::log(&store, &bot.id, "error", &format!("Couldn't switch back to {}: {}", to.model, error.chars().take(160).collect::<String>()), json!({"sessionId": session}));
    }
}

fn state_due(session: &str, current: &BackupModel) -> Option<(BackupModel, Cause)> {
    state().lock().ok()?.due_return(session, current, crate::storage::now())
}

/// A turn of a bot conversation completed cleanly.
pub(crate) fn completed(session: &str) {
    if let Ok(mut failover) = state().lock() {
        failover.completed(session);
        failover.images.remove(session);
    }
}

/// Keep the current bot prompt's local image ids so a failover retry can submit them again.
pub(crate) fn remember_images(session: &str, image_ids: &[String]) {
    if let Ok(mut failover) = state().lock() {
        if image_ids.is_empty() { failover.images.remove(session); }
        else { failover.images.insert(session.to_owned(), image_ids.to_vec()); }
    }
}

pub(crate) fn clear_images(session: &str) {
    if let Ok(mut failover) = state().lock() {
        failover.images.remove(session);
    }
}

/// Drops a session's held message (its channel delivery was stopped), so a stale card can't send it.
pub(crate) fn cancel(session: &str) -> bool {
    let Ok(mut failover) = state().lock() else { return false };
    failover.tried.remove(session);
    failover.images.remove(session);
    failover.asks.remove(session).is_some()
}

/// The card for a held message, if one waits (e.g. after the window reloads).
#[tauri::command]
pub async fn bot_failover_pending(session_id: String) -> Result<Option<Ask>> {
    Ok(state().lock().map_err(|e| e.to_string())?.asks.get(&session_id).cloned())
}

/// The switches recorded in a conversation, oldest first, for its marker rows.
#[tauri::command]
pub async fn bot_model_switches(state: State<'_, AppState>, session_id: String) -> Result<Vec<super::Activity>> {
    switches(&*state.store.lock().map_err(|e| e.to_string())?, &session_id)
}

pub(crate) fn switches(store: &Store, session: &str) -> Result<Vec<super::Activity>> {
    let mut statement = store
        .db
        .prepare("SELECT id,summary,detail,at FROM bot_activity WHERE kind='model-switch' AND json_extract(detail,'$.sessionId')=?1 ORDER BY id DESC LIMIT 200")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([session], |r| Ok(super::Activity { id: r.get(0)?, kind: "model-switch".into(), summary: r.get(1)?, detail: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(), at: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    let mut list = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    list.reverse();
    Ok(list)
}

/// Answers the card: `send` runs the message on the offered model now (with `always`, the bot
/// switches without asking from then on); `wait` keeps it until the reset.
#[tauri::command]
pub async fn bot_failover_decide(app: tauri::AppHandle, session_id: String, action: String, always: bool) -> Result<()> {
    let ask = state().lock().map_err(|e| e.to_string())?.asks.get(&session_id).cloned().ok_or("This message is no longer on hold.")?;
    let (bot, turn, from) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        (super::get(&store, &ask.bot_id)?, failed_turn_with_images(&store, &session_id)?, current(&store, &session_id)?)
    };
    match action.as_str() {
        "send" => {
            let turn = turn.ok_or("This message has already been answered.")?;
            switch(&app, &bot, &session_id, &turn, &from, &ask.target, ask.cause).await?;
        }
        "wait" => {
            // The window's limit scheduler continues the task at the reset.
            if ask.cause == Cause::Limit && ask.resets_at.is_some() {
                let state = app.state::<AppState>();
                state.store.lock().map_err(|e| e.to_string())?.set_resume_at_reset(&session_id, true)?;
                let _ = app.emit("sessions-changed", ());
            } else {
                // Nothing will run this message again, so settle its channel or bot delivery as
                // failed now (recoverable from the channel); a later turn must not finish it.
                super::shared_channels::run_finished(&app, &session_id, false, "").await;
            }
            let summary = if ask.cause == Cause::Limit && ask.resets_at.is_some() { "Waiting for the reset" } else { "Hold dismissed" };
            super::note(&app, &bot.id, "failover", summary, json!({"sessionId": session_id}));
        }
        _ => return Err("Choose Send or Wait.".into()),
    }
    if always {
        let state = app.state::<AppState>();
        if let Ok(store) = state.store.lock() {
            let backups = serde_json::to_string(&remembered_backups(&bot.backup_models, &ask.target)).map_err(|e| e.to_string())?;
            let _ = store.db.execute("UPDATE bots SET fallback_mode='auto',backup_models=?2,updated_at=?3 WHERE id=?1", params![ask.bot_id,backups,crate::storage::now()]);
        }
        let _ = app.emit("bots-changed", ());
    }
    if let Ok(mut failover) = state().lock() { failover.asks.remove(&session_id); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, model: &str) -> BackupModel {
        BackupModel { provider: provider.into(), model: model.into() }
    }

    fn bot() -> Bot {
        Bot {
            id: "b".into(), name: "Scout".into(), role: String::new(), instructions: String::new(), goals: String::new(), avatar: String::new(),
            project_id: "p".into(), provider: "claude".into(), model: "opus".into(), mode: "ask".into(), heartbeat_minutes: 0, next_heartbeat_at: None,
            paused: false, memory_version: 0, notify_channel_id: None, notify_thread: None, created_at: 0, updated_at: 0, color: String::new(),
            reasoning_effort: String::new(), backup_models: vec![model("codex", "gpt-5"), model("kimi", "k2")], fallback_mode: "auto".into(),
            notify: true, while_working: "queue".into(), show_plan: false, soul: String::new(), skills: Vec::new(), mcp: Vec::new(),
        }
    }

    #[test]
    fn failover_picks_the_next_ready_model_once_per_message() {
        let (bot, mut f) = (bot(), Failover::default());
        let main = model("claude", "opus");
        assert_eq!(f.failed(&bot, "s", &main, Cause::Limit, Some(5_000), 0), Some(model("codex", "gpt-5")));
        // The backup fails too: the next one, never back to the held main model.
        assert_eq!(f.failed(&bot, "s", &model("codex", "gpt-5"), Cause::ProviderError, None, 1), Some(model("kimi", "k2")));
        assert_eq!(f.failed(&bot, "s", &model("kimi", "k2"), Cause::ProviderError, None, 2), None);
        // Another conversation still skips the held models.
        assert_eq!(f.next(&bot, "t", &model("kimi", "k2"), 3), None);
    }

    #[test]
    fn provider_errors_skip_a_model_for_ten_minutes() {
        let (bot, mut f) = (bot(), Failover::default());
        f.failed(&bot, "s", &model("codex", "gpt-5"), Cause::ProviderError, None, 0);
        assert_eq!(f.next(&bot, "t", &model("claude", "opus"), ERROR_HOLD - 1), Some(model("kimi", "k2")));
        assert_eq!(f.next(&bot, "t", &model("claude", "opus"), ERROR_HOLD), Some(model("codex", "gpt-5")));
    }

    #[test]
    fn limits_without_a_reset_hold_for_an_hour() {
        let (bot, mut f) = (bot(), Failover::default());
        f.failed(&bot, "s", &model("claude", "opus"), Cause::Limit, None, 0);
        assert_eq!(f.next(&bot, "t", &model("kimi", "k2"), UNKNOWN_RESET_HOLD - 1), Some(model("codex", "gpt-5")));
        assert_eq!(f.next(&bot, "t", &model("kimi", "k2"), UNKNOWN_RESET_HOLD), Some(model("claude", "opus")));
    }

    #[test]
    fn switches_back_after_the_reset_unless_the_user_picked_a_model() {
        let (bot, mut f) = (bot(), Failover::default());
        let (main, backup, other) = (model("claude", "opus"), model("codex", "gpt-5"), model("kimi", "k2"));
        let target = f.failed(&bot, "s", &main, Cause::Limit, Some(1_000), 0).unwrap();
        f.switched("s", &main, &target, Cause::Limit);
        assert_eq!(f.due_return("s", &backup, 999), None, "still limited");
        assert_eq!(f.due_return("s", &backup, 1_000), Some((main.clone(), Cause::Limit)));
        assert_eq!(f.due_return("s", &backup, 2_000), None, "a return happens once");

        // A second hop keeps the model first left; a manual pick drops the return.
        f.switched("s", &main, &backup, Cause::Limit);
        f.switched("s", &backup, &other, Cause::ProviderError);
        assert_eq!(f.returns["s"].to, main);
        assert_eq!(f.due_return("s", &backup, 5_000), None);
        assert!(f.returns.is_empty());
    }

    #[test]
    fn markers_read_as_the_conversation_rows() {
        assert_eq!(marker(Cause::Limit, false, "gpt-5"), "Usage limit reached. Switched to gpt-5.");
        assert_eq!(marker(Cause::Limit, true, "opus"), "Usage limit ended. Switched back to opus.");
        assert_eq!(marker(Cause::ProviderError, false, "k2"), "Provider error. Switched to k2.");
        assert_eq!(marker(Cause::ProviderError, true, "opus"), "Switched back to opus after the provider error.");
        assert!(provider_error("API Error: 529 Overloaded") && provider_error("Request timed out") && !provider_error("Invalid tool input"));
    }

    #[test]
    fn stopping_a_held_message_drops_its_card() {
        let ask = Ask { bot_id: "b".into(), session_id: "held-stop".into(), cause: Cause::Limit, provider: "claude".into(), model: "opus".into(), target: model("codex", "gpt-5"), resets_at: None };
        state().lock().unwrap().asks.insert("held-stop".into(), ask);
        assert!(cancel("held-stop"));
        assert!(!cancel("held-stop"), "a stale Send finds nothing on hold");
    }

    #[test]
    fn remembering_a_backup_puts_it_first_without_duplicates() {
        let target = model("kimi", "k2");
        let existing = vec![model("codex", "gpt-5"), target.clone(), model("glm", "glm-5")];
        assert_eq!(remembered_backups(&existing, &target), vec![target, model("codex", "gpt-5"), model("glm", "glm-5")]);
    }

    #[test]
    fn only_turns_that_did_nothing_fail_over() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let root = std::env::temp_dir().join(format!("pandacode-failover-{}", crate::storage::id()));
        let project = store.add_project(&{ std::fs::create_dir_all(&root).unwrap(); root.clone() }).unwrap();
        let task = store.create_session(&project.id, "claude", "opus", "ask").unwrap();
        store.message(&task.id, "user", "hello").unwrap();
        store.message(&task.id, "error", "API Error: 503 Service Unavailable").unwrap();
        let turn = failed_turn(&store, &task.id).unwrap().unwrap();
        assert_eq!((turn.text.as_str(), turn.limited, provider_error(&turn.errors)), ("hello", None, true));
        store.set_limited(&task.id, Some(1_791_013_800_000)).unwrap();
        assert_eq!(failed_turn(&store, &task.id).unwrap().unwrap().limited, Some(Some(1_791_013_800_000)));
        store.message(&task.id, "assistant", "Working on it").unwrap();
        assert_eq!(failed_turn(&store, &task.id).unwrap(), None, "a turn that wrote text keeps its error");
        let _ = std::fs::remove_dir_all(root);
    }
}
