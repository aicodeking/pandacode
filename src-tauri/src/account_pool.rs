//! Account pools (docs/providers.md#account-pools). With a harness's pool on, its own setup and
//! its named connections are interchangeable accounts. When a run fails at a usage limit, the
//! run moves to the next ready account inside the same run (`providers/pool.rs`): the account is
//! held until its reset, the harness session file is copied into the next account's config
//! folder, and the session resumes there with "Continue where you left off.".
//! An account near its limit (Claude `allowed_warning`, Codex ≥ 90 % of a window) is left before
//! the next turn when another account has room, so most switches happen between turns.
//!
//! Choice: accounts out of quota are skipped, accounts near a limit come last, and among the
//! rest the one running the fewest tasks wins (ties go in pool order after the current one), so
//! team workers spread out instead of draining one account together. A member whose config
//! folder is the same as an earlier member's and that has no token of its own is the same login,
//! so it is left out. Holds on spent accounts are saved, so a restart does not retry them.

use crate::connections::{self, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Harnesses whose session can follow a task to another account's config folder.
pub(crate) const POOLED: &[&str] = &["claude", "codex"];
/// The harness's own setup as a pool member.
pub(crate) const DEFAULT: &str = "";
// ponytail: a limit without a reset time holds for an hour.
const UNKNOWN_RESET_HOLD: i64 = 60 * 60_000;
pub(crate) const NEAR_PERCENT: f64 = 90.0;
/// Codex keeps a sessions tree of dated folders; bound the walk.
const MAX_SCAN: usize = 50_000;
/// No real limit window is longer than a week; a reset further out is a bad value.
const MAX_HOLD: i64 = 8 * 24 * 60 * 60_000;

type Key = (String, String);

#[derive(Default)]
struct State {
    /// (provider, member) → out until. Saved to `account-holds.json`.
    limited: HashMap<Key, i64>,
    /// (provider, member) → window → near its limit until.
    near: HashMap<Key, HashMap<String, i64>>,
    /// (provider, member) → runs in progress.
    active: HashMap<Key, usize>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static HOLDS_FILE: OnceLock<PathBuf> = OnceLock::new();
/// One save at a time, so an older snapshot never lands after a newer one.
static SAVING: Mutex<()> = Mutex::new(());

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
    f(guard.get_or_insert_with(State::default))
}

fn key(provider: &str, member: &str) -> Key {
    (provider.to_owned(), member.to_owned())
}

fn now() -> i64 {
    crate::storage::now()
}

#[derive(Serialize, Deserialize)]
struct SavedHold {
    provider: String,
    member: String,
    until: i64,
}

/// The saved holds still ahead, each capped at `MAX_HOLD` from now.
fn load_holds(path: &Path, at: i64) -> Vec<SavedHold> {
    let saved: Vec<SavedHold> = std::fs::read(path).ok().filter(|b| b.len() < 256 * 1024).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    saved.into_iter().filter(|h| h.until > at).map(|h| SavedHold { until: h.until.min(at + MAX_HOLD), ..h }).collect()
}

fn write_holds(path: &Path, holds: &[SavedHold]) -> bool {
    let temp = path.with_extension("json.tmp");
    serde_json::to_vec(holds).ok().is_some_and(|bytes| std::fs::write(&temp, bytes).is_ok() && std::fs::rename(&temp, path).is_ok())
}

/// Loads the saved holds that are still ahead.
pub fn setup(dir: &Path) {
    let path = dir.join("account-holds.json");
    let saved = load_holds(&path, now());
    with_state(|state| {
        for hold in saved {
            state.limited.insert(key(&hold.provider, &hold.member), hold.until);
        }
    });
    let _ = HOLDS_FILE.set(path);
}

/// Saves the current holds; called outside the state lock.
fn save_holds() {
    let Some(path) = HOLDS_FILE.get() else { return };
    let _saving = SAVING.lock().unwrap_or_else(|poison| poison.into_inner());
    let at = now();
    let holds: Vec<SavedHold> = with_state(|state| {
        state.limited.iter().filter(|(_, until)| **until > at).map(|((provider, member), until)| SavedHold { provider: provider.clone(), member: member.clone(), until: *until }).collect()
    });
    if !write_holds(path, &holds) {
        eprintln!("account pool: could not save account holds");
    }
}

/// The pool member a task runs on: its connection's id, or the harness's own setup. A
/// connection with the same login as an earlier member counts as that member, so a limit holds
/// the login rather than one of its names.
pub(crate) fn member(session_id: &str, provider: &str) -> String {
    let id = connections::for_task(session_id, provider).map_or_else(String::new, |c| c.id);
    if !enabled(provider) {
        return id;
    }
    candidates(provider).into_iter().find(|(candidate, ..)| *candidate == id).and_then(|(_, _, same)| same).unwrap_or(id)
}

pub(crate) fn enabled(provider: &str) -> bool {
    POOLED.contains(&provider) && connections::pooled(provider)
}

fn until_or_hour(resets_at: Option<i64>) -> i64 {
    let at = now();
    resets_at.filter(|until| *until > at).unwrap_or(at + UNKNOWN_RESET_HOLD).min(at + MAX_HOLD)
}

/// Records a usage limit. A limit on one model family (Claude's `seven_day_opus`/`_sonnet`)
/// leaves the account usable, so it only counts as near its limit.
pub(crate) fn note_limit(provider: &str, member: &str, resets_at: Option<i64>, window: Option<&str>) {
    let until = until_or_hour(resets_at);
    if window.is_some_and(|w| w.ends_with("_opus") || w.ends_with("_sonnet")) {
        with_state(|state| state.near.entry(key(provider, member)).or_default().insert(window.unwrap_or_default().to_owned(), until));
        return;
    }
    with_state(|state| state.limited.insert(key(provider, member), until));
    save_holds();
}

/// Clears an account's holds, for when the user knows it has room again (extra usage, a new login).
#[tauri::command]
pub async fn account_pool_clear(provider: String, id: String) -> crate::Result<()> {
    crate::blocking(move || {
        with_state(|state| {
            state.limited.remove(&key(&provider, &id));
            state.near.remove(&key(&provider, &id));
        });
        save_holds();
        Ok(())
    })
    .await
}

/// Records how much of one limit window a task's account has used.
pub(crate) fn note_usage(session_id: &str, provider: &str, window: &str, percent: f64, resets_at: Option<i64>) {
    if !enabled(provider) {
        return;
    }
    let account = key(provider, &member(session_id, provider));
    with_state(|state| {
        let windows = state.near.entry(account).or_default();
        if percent >= NEAR_PERCENT {
            windows.insert(window.to_owned(), until_or_hour(resets_at));
        } else {
            windows.remove(window);
        }
    });
}

fn limited_until(state: &State, k: &Key, at: i64) -> Option<i64> {
    state.limited.get(k).copied().filter(|until| *until > at)
}

fn near_until(state: &State, k: &Key, at: i64) -> Option<i64> {
    state.near.get(k).and_then(|windows| windows.values().copied().filter(|until| *until > at).max())
}

/// Counts a run on an account while it is alive, so new runs prefer quieter accounts.
pub(crate) struct Active(Key);

pub(crate) fn begin(provider: &str, member: &str) -> Active {
    let k = key(provider, member);
    with_state(|state| *state.active.entry(k.clone()).or_default() += 1);
    Active(k)
}

impl Drop for Active {
    fn drop(&mut self) {
        with_state(|state| {
            if let Some(count) = state.active.get_mut(&self.0) {
                *count = count.saturating_sub(1);
            }
        });
    }
}

/// The best other member, or `None` when every other one is out.
fn pick(provider: &str, members: &[String], current: &str, at: i64) -> Option<String> {
    with_state(|state| pick_in(state, provider, members, current, at))
}

/// Picks and counts a run on the choice under one lock, so tasks switching at the same moment
/// spread over the accounts instead of all taking the same one.
fn claim(provider: &str, members: &[String], current: &str, at: i64) -> Option<(String, Active)> {
    with_state(|state| {
        let next = pick_in(state, provider, members, current, at)?;
        let k = key(provider, &next);
        *state.active.entry(k.clone()).or_default() += 1;
        Some((next, Active(k)))
    })
}

fn pick_in(state: &State, provider: &str, members: &[String], current: &str, at: i64) -> Option<String> {
    let start = members.iter().position(|m| m == current).map_or(0, |i| i + 1);
    {
        members
            .iter()
            .cycle()
            .skip(start)
            .take(members.len())
            .enumerate()
            .filter(|(_, m)| *m != current && limited_until(state, &key(provider, m), at).is_none())
            .min_by_key(|(order, m)| {
                let k = key(provider, m);
                (near_until(state, &k, at).is_some(), state.active.get(&k).copied().unwrap_or(0), *order)
            })
            .map(|(_, m)| m.clone())
    }
}

/// A pool member as Settings shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStatus {
    id: String,
    /// Left out by the user.
    excluded: bool,
    /// The earlier member this one shares a login with; such a member is left out.
    same_as: Option<String>,
    /// Whether the account has a saved login; one without is skipped until it does.
    signed_in: bool,
    limited_until: Option<i64>,
    near_until: Option<i64>,
    active: usize,
}

/// What makes an account distinct: a token of its own, else its config folder.
fn identity(provider: &str, connection: Option<&Connection>) -> String {
    let token = if provider == "claude" { "CLAUDE_CODE_OAUTH_TOKEN" } else { "CODEX_API_KEY" };
    match connection {
        Some(c) if c.env.contains_key(token) || c.secret_env.iter().any(|n| n == token) => format!("token:{}", c.id),
        _ => format!("dir:{}", config_dir(provider, connection).map(|d| d.display().to_string()).unwrap_or_default()),
    }
}

/// Every candidate with whether it is left out, by the user or as a repeat of an earlier login.
fn candidates(provider: &str) -> Vec<(String, bool, Option<String>)> {
    let excluded = connections::pool_excluded(provider);
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    std::iter::once(None)
        .chain(connections::pool_members(provider).into_iter().map(Some))
        .map(|connection| {
            let id = connection.as_ref().map_or_else(String::new, |c| c.id.clone());
            let out = excluded.contains(&id);
            let same = seen.get(&identity(provider, connection.as_ref())).cloned();
            if !out && same.is_none() {
                seen.insert(identity(provider, connection.as_ref()), id.clone());
            }
            (id, out, same)
        })
        .collect()
}

/// Whether a member has a saved login. The harness's own setup always counts (it is the user's
/// main setup); a connection needs its own token or the login file its harness writes on sign-in,
/// so a folder added with **Add account…** joins the pool only once it is signed in.
fn signed_in(provider: &str, id: &str) -> bool {
    let Some(connection) = connections::get(id) else { return id == DEFAULT };
    let token = if provider == "claude" { "CLAUDE_CODE_OAUTH_TOKEN" } else { "CODEX_API_KEY" };
    if connection.env.contains_key(token) || connection.secret_env.iter().any(|n| n == token) {
        return true;
    }
    let Some(dir) = config_dir(provider, Some(&connection)) else { return false };
    if provider == "codex" {
        return dir.join("auth.json").is_file();
    }
    // `.claude.json` carries the signed-in account (credentials may be in the Keychain instead
    // of `.credentials.json`); it can be large, so it is scanned in chunks and the scan stops at
    // the key, which is usually near the top.
    dir.join(".credentials.json").is_file() || std::fs::File::open(dir.join(".claude.json")).is_ok_and(|file| contains(file, b"\"oauthAccount\""))
}

/// Whether a stream contains `needle`, read in 64 KiB chunks.
fn contains(mut reader: impl std::io::Read, needle: &[u8]) -> bool {
    let mut window = Vec::with_capacity(64 * 1024 + needle.len());
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let Ok(read) = reader.read(&mut chunk) else { return false };
        if read == 0 {
            return false;
        }
        window.extend_from_slice(&chunk[..read]);
        if window.windows(needle.len()).any(|w| w == needle) {
            return true;
        }
        // Keep the tail so a key split across chunks is still found.
        window.drain(..window.len().saturating_sub(needle.len() - 1));
    }
}

fn members(provider: &str) -> Vec<String> {
    candidates(provider).into_iter().filter(|(id, out, same)| !out && same.is_none() && signed_in(provider, id)).map(|(id, ..)| id).collect()
}

/// Each candidate's state (`""` is the harness's own setup).
#[tauri::command]
pub async fn account_pool_status(provider: String) -> crate::Result<Vec<MemberStatus>> {
    crate::blocking(move || {
        let at = now();
        let list: Vec<_> = candidates(&provider).into_iter().map(|(id, out, same)| { let ok = signed_in(&provider, &id); (id, out, same, ok) }).collect();
        Ok(with_state(|state| {
            list.into_iter()
                .map(|(id, excluded, same_as, signed_in)| {
                    let k = key(&provider, &id);
                    MemberStatus { limited_until: limited_until(state, &k, at), near_until: near_until(state, &k, at), active: state.active.get(&k).copied().unwrap_or(0), id, excluded, same_as, signed_in }
                })
                .collect()
        }))
    })
    .await
}

/// Whether another account could take over from `current` now.
pub(crate) fn has_alternative(provider: &str, current: &str) -> bool {
    enabled(provider) && pick(provider, &members(provider), current, now()).is_some()
}

/// The config folder a member's harness reads: the connection's folder or variable, else the
/// harness's own (saved provider variable, this process's variable, then the home default).
fn config_dir(provider: &str, connection: Option<&Connection>) -> Option<PathBuf> {
    let var = match provider {
        "claude" => "CLAUDE_CONFIG_DIR",
        "codex" => "CODEX_HOME",
        _ => return None,
    };
    if let Some(dir) = connection.and_then(|c| c.config_dir.clone().or_else(|| c.env.get(var).cloned())) {
        return Some(PathBuf::from(dir));
    }
    let saved = crate::provider_settings::environment(provider).into_iter().find(|(k, _)| k == var).map(|(_, v)| v);
    saved
        .or_else(|| std::env::var(var).ok())
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::agent_usage_providers::home().map(|h| h.join(if provider == "claude" { ".claude" } else { ".codex" })))
}

fn session_name_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The session file and its path below the config folder.
fn find_session(provider: &str, dir: &Path, id: &str) -> Option<(PathBuf, PathBuf)> {
    if provider == "claude" {
        let name = format!("{id}.jsonl");
        let projects = dir.join("projects");
        return std::fs::read_dir(&projects).ok()?.flatten().find_map(|project| {
            let file = project.path().join(&name);
            file.is_file().then(|| (file, PathBuf::from("projects").join(project.file_name()).join(&name)))
        });
    }
    // Codex: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl; newest folders are searched first.
    let suffix = format!("-{id}.jsonl");
    let mut stack = vec![dir.join("sessions")];
    let mut seen = 0;
    while let Some(folder) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&folder) else { continue };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            seen += 1;
            if seen > MAX_SCAN {
                return None;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_str().is_some_and(|n| n.ends_with(&suffix)) {
                let path = entry.path();
                let relative = path.strip_prefix(dir).ok()?.to_path_buf();
                return Some((path, relative));
            }
        }
    }
    None
}

/// Creates a folder only its owner can read: transcripts can hold secrets.
fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// Copies a harness session into another account's config folder so it resumes there.
fn carry(provider: &str, from: &Path, to: &Path, id: &str) -> Result<(), &'static str> {
    if !session_name_ok(id) {
        return Err("unexpected session id");
    }
    if from == to {
        return Ok(());
    }
    let (source, relative) = find_session(provider, from, id).ok_or("session file not found")?;
    let target = to.join(&relative);
    let parent = target.parent().ok_or("bad target")?;
    // Write beside the target, then rename, so a half-copied file is never resumed.
    let temp = target.with_extension("jsonl.pandacode-tmp");
    let copied = private_dir(parent).is_ok() && std::fs::copy(&source, &temp).is_ok() && std::fs::rename(&temp, &target).is_ok();
    if !copied {
        let _ = std::fs::remove_file(&temp);
        return Err("copy failed");
    }
    // Claude keeps a session's subagent transcripts and large tool results beside it in
    // `<id>/`; best effort, since the main transcript alone resumes.
    if provider == "claude" {
        if let Some(from_dir) = source.parent() {
            copy_tree(&from_dir.join(id), &parent.join(id), 0);
        }
    }
    Ok(())
}

/// Copies a folder tree, skipping links; bounded depth.
fn copy_tree(from: &Path, to: &Path, depth: usize) {
    let Ok(entries) = std::fs::read_dir(from) else { return };
    if depth > 8 || private_dir(to).is_err() {
        return;
    }
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, depth + 1);
        } else if kind.is_file() {
            let _ = std::fs::copy(entry.path(), target);
        }
    }
}

/// A move from one account to another, for the transcript and the window.
pub(crate) struct Switch {
    pub from: String,
    pub to: String,
    /// The connection the task now uses; `None` is the harness's own setup.
    pub connection: Option<String>,
    /// The run counted on the new account, for the attempt that runs there.
    pub claim: Active,
    /// Why the task left `from`, completing "… {from} {reason}".
    pub reason: &'static str,
}

fn label(provider: &str, member: &str) -> String {
    if member == DEFAULT {
        return format!("the default {} account", if provider == "claude" { "Claude" } else { "Codex" });
    }
    connections::get(member).map_or_else(|| "another account".to_owned(), |c| format!("“{}”", c.name))
}

/// Moves the task to the best other account, carrying its harness session. `None` when the pool
/// is off, no other account is ready, or the session could not be carried (the task then keeps
/// its account and the usual limit banner applies).
pub(crate) fn rotate(session_id: &str, provider: &str, resume_id: Option<&str>) -> Option<Switch> {
    if !enabled(provider) {
        return None;
    }
    let current = member(session_id, provider);
    let (next, claim) = claim(provider, &members(provider), &current, now())?;
    if let Some(id) = resume_id {
        let from = config_dir(provider, connections::get(&current).as_ref());
        let to = config_dir(provider, connections::get(&next).as_ref());
        let carried = match (from, to) {
            (Some(from), Some(to)) => carry(provider, &from, &to, id),
            _ => Err("no config folder"),
        };
        if let Err(step) = carried {
            eprintln!("account pool: {provider} session not carried to the next account: {step}");
            return None;
        }
    }
    let connection = (next != DEFAULT).then(|| next.clone());
    if let Err(error) = connections::reassign(session_id, connection.clone()) {
        eprintln!("account pool: could not reassign the task: {error}");
        return None;
    }
    Some(Switch { from: label(provider, &current), to: label(provider, &next), connection, claim, reason: "reached its usage limit" })
}

/// Before a turn starts: leave an account that is out or left out of the pool, or that is near
/// its limit while another has room. A new conversation (nothing to resume yet) without an account
/// of its own also starts on a quieter account when the default is busier, so parallel tasks spread
/// over the pool.
pub(crate) fn prepare(session_id: &str, provider: &str, resume_id: Option<&str>) -> Option<Switch> {
    if !enabled(provider) {
        return None;
    }
    let current = member(session_id, provider);
    let pool = members(provider);
    let at = now();
    let next = pick(provider, &pool, &current, at)?;
    // A task given an account by hand keeps it while that account has room.
    let chosen = connections::for_task(session_id, provider).is_some();
    let reason = with_state(|state| {
        let (here, there) = (key(provider, &current), key(provider, &next));
        let out = !pool.contains(&current) || limited_until(state, &here, at).is_some();
        let near_here = near_until(state, &here, at).is_some();
        let near_there = near_until(state, &there, at).is_some();
        let busy = |k: &Key| state.active.get(k).copied().unwrap_or(0);
        if out {
            Some("is out of room or left out of the pool")
        } else if near_here && !near_there {
            Some("is near its usage limit")
        } else if resume_id.is_none() && !chosen && !near_there && busy(&there) < busy(&here) {
            Some("is running more tasks")
        } else {
            None
        }
    })?;
    rotate(session_id, provider, resume_id).map(|switch| Switch { reason, ..switch })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn pick_skips_held_prefers_room_and_wraps() {
        let p = "test-pick";
        let pool = members(&["", "a", "b", "c"]);
        let at = now();
        assert_eq!(pick(p, &pool, "a", at).as_deref(), Some("b"));
        note_limit(p, "b", Some(at + 60_000), Some("five_hour"));
        assert_eq!(pick(p, &pool, "a", at).as_deref(), Some("c"));
        with_state(|s| s.near.entry(key(p, "c")).or_default().insert("w".into(), at + 60_000));
        assert_eq!(pick(p, &pool, "a", at).as_deref(), Some(""), "wraps past a near account to one with room");
        note_limit(p, "", None, None);
        assert_eq!(pick(p, &pool, "a", at).as_deref(), Some("c"), "a near account beats none");
        note_limit(p, "c", None, None);
        assert_eq!(pick(p, &pool, "a", at), None);
        assert_eq!(pick(p, &pool, "a", at + 2 * UNKNOWN_RESET_HOLD).as_deref(), Some("b"), "holds lift at the reset");
    }

    #[test]
    fn quieter_accounts_win_and_runs_are_counted_until_dropped() {
        let p = "test-spread";
        let pool = members(&["", "a", "b"]);
        let at = now();
        let busy = begin(p, "a");
        assert_eq!(pick(p, &pool, "", at).as_deref(), Some("b"), "b runs nothing, a runs one");
        drop(busy);
        assert_eq!(pick(p, &pool, "", at).as_deref(), Some("a"), "ties go in order");
    }

    #[test]
    fn model_family_limits_only_mark_an_account_near() {
        let p = "test-family";
        note_limit(p, "x", None, Some("seven_day_opus"));
        let at = now();
        with_state(|s| {
            assert!(limited_until(s, &key(p, "x"), at).is_none());
            assert!(near_until(s, &key(p, "x"), at).is_some());
        });
    }

    #[test]
    fn saved_holds_round_trip_drop_expired_and_cap_bad_resets() {
        let dir = std::env::temp_dir().join(format!("pool-holds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("account-holds.json");
        let at = now();
        let holds = [
            SavedHold { provider: "claude".into(), member: "a".into(), until: at + 60_000 },
            SavedHold { provider: "claude".into(), member: "old".into(), until: at - 1 },
            SavedHold { provider: "codex".into(), member: "".into(), until: at + 1_000 * MAX_HOLD },
        ];
        assert!(write_holds(&path, &holds));
        let loaded = load_holds(&path, at);
        assert_eq!(loaded.len(), 2, "expired holds are dropped");
        assert_eq!(loaded[0].until, at + 60_000);
        assert_eq!(loaded[1].until, at + MAX_HOLD, "a reset years away is capped");
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_holds(&path, at).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn claims_count_the_chosen_account_at_once() {
        let p = "test-claim";
        let pool = members(&["", "a", "b"]);
        let at = now();
        let (first, _one) = claim(p, &pool, "", at).unwrap();
        let (second, _two) = claim(p, &pool, "", at).unwrap();
        assert_ne!(first, second, "two switches at the same moment take different accounts");
    }

    #[test]
    fn login_keys_are_found_across_chunk_edges_and_deep_in_large_files() {
        let mut text = vec![b' '; 64 * 1024 - 5];
        text.extend_from_slice(b"\"oauthAccount\":{}");
        assert!(contains(text.as_slice(), b"\"oauthAccount\""), "split across two chunks");
        let mut deep = vec![b'x'; 9 << 20];
        deep.extend_from_slice(b"\"oauthAccount\"");
        assert!(contains(deep.as_slice(), b"\"oauthAccount\""), "past the old 8 MiB cap");
        assert!(!contains(&b"{\"projects\":{}}"[..], b"\"oauthAccount\""));
    }

    #[test]
    fn past_reset_times_hold_for_an_hour() {
        note_limit("test-past", "x", Some(1), None);
        assert!(with_state(|s| limited_until(s, &key("test-past", "x"), now() + 59 * 60_000).is_some()));
    }

    #[test]
    fn claude_sessions_are_carried_atomically_and_validated() {
        let root = std::env::temp_dir().join(format!("pool-claude-{}", uuid::Uuid::new_v4()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(a.join("projects/-Users-me-app")).unwrap();
        std::fs::write(a.join("projects/-Users-me-app/abc-123.jsonl"), "{\"x\":1}\n").unwrap();
        assert!(carry("claude", &a, &b, "abc-123").is_ok());
        assert_eq!(std::fs::read_to_string(b.join("projects/-Users-me-app/abc-123.jsonl")).unwrap(), "{\"x\":1}\n");
        assert!(!b.join("projects/-Users-me-app/abc-123.jsonl.pandacode-tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(b.join("projects/-Users-me-app")).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::create_dir_all(a.join("projects/-Users-me-app/abc-124/subagents")).unwrap();
        std::fs::write(a.join("projects/-Users-me-app/abc-124.jsonl"), "{}\n").unwrap();
        std::fs::write(a.join("projects/-Users-me-app/abc-124/subagents/agent-1.jsonl"), "{}\n").unwrap();
        assert!(carry("claude", &a, &b, "abc-124").is_ok());
        assert!(b.join("projects/-Users-me-app/abc-124/subagents/agent-1.jsonl").is_file(), "subagent transcripts follow");
        assert!(carry("claude", &a, &b, "missing").is_err());
        assert!(carry("claude", &a, &b, "../escape").is_err());
        assert!(carry("claude", &a, &a, "anything").is_ok(), "one folder needs no copy");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_rollouts_keep_their_dated_path_past_unreadable_folders() {
        let root = std::env::temp_dir().join(format!("pool-codex-{}", uuid::Uuid::new_v4()));
        let (a, b) = (root.join("a"), root.join("b"));
        let day = a.join("sessions/2026/11/05");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-11-05T10-00-00-0199aaaa-bbbb.jsonl"), "{}\n").unwrap();
        std::fs::write(day.join("rollout-2026-11-05T09-00-00-other.jsonl"), "{}\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = a.join("sessions/2026/12");
            std::fs::create_dir_all(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        assert!(carry("codex", &a, &b, "0199aaaa-bbbb").is_ok());
        assert!(b.join("sessions/2026/11/05/rollout-2026-11-05T10-00-00-0199aaaa-bbbb.jsonl").is_file());
        assert!(carry("codex", &a, &b, "nope").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(a.join("sessions/2026/12"), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
