//! Host methods that live outside `host.rs`'s built-in `Call` enum: a registry of
//! per-feature files, so features can add PandaConnect methods without touching the
//! shared dispatch (docs/remote-access.md, "Adding a method").
//!
//! Each feature file exports `METHODS: &[Method]`. A [`Method`] is data (name, the
//! narrowest grant that may call it, whether it is read-only) plus a `parse` that
//! validates the request's params into a boxed [`Run`]. `host.rs` consults the
//! registry for any method it does not know itself, so the hosting-off refusal,
//! presence and grant checks (`grants::check`), the request lanes
//! (`is_read_only_method`), `batch` (read-only methods only) and replay checks all
//! cover registry methods with no further edits.
//!
//! A registry method that changes a task's mode must enforce Full access itself with
//! [`Ctx::full_access`] and [`full_access_off`]/[`allow_task_mode`]: `host::cap_mode`
//! only knows the built-in `task.start`/`task.configure`.
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::fmt::Debug;
use std::future::Future;
use std::pin::Pin;
use tauri::Manager;

pub(crate) mod admin;
pub(crate) mod composer;
pub(crate) mod design;
pub(crate) mod files;
pub(crate) mod git;
pub(crate) mod github;
pub(crate) mod projects;
pub(crate) mod rewind;
pub(crate) mod search;
pub(crate) mod schedules;
pub(crate) mod settings;
pub(crate) mod team;
pub(crate) mod terminal;
pub(crate) mod threads;
pub(crate) mod tools;

/// Validators and task lookups feature files share with `host.rs`.
#[allow(unused_imports)]
pub(crate) use super::host::{
    allow_remote_team, allow_remote_team_for, allow_task_mode, bounded_text, drivable_session_from, drivable_task, force_param, full_access_off, github_comment_target, id_param, invalidate_pull_cache, linked_pull, local_session_from, local_task, moodboard_add_target, workspace_session_from, name_param, once_per_action, optional_pull, run_schedule_target,
    page_budget, path_param, TEAM_NEEDS_FULL_ACCESS, send_id_param, task_root, task_send_lock, text_param, uuid_param, valid_id, MAX_TEXT, PAGE_BUDGET,
};

/// The app protocol version `host.hello` reports. Hosts from before `host.hello` are
/// protocol 1 (they answer it with `Unknown method.`). Bump it only for a change a phone
/// cannot detect from the method list.
pub(crate) const PROTOCOL: u32 = 2;

/// The narrowest grant (`grants.rs`) that may call a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Control and Full: for feature files
pub(crate) enum Access {
    /// Read-only browsing (also Control and Full).
    View,
    /// Driving existing tasks (also Full).
    Control,
    /// Starting work, merging, anything with effects beyond one task.
    Full,
}

/// What a running method gets: the app, the calling device and whether remote tasks may
/// use Full access on this computer.
#[derive(Clone, Copy)]
#[allow(dead_code)] // `from`: for feature files
pub(crate) struct Ctx<'a> {
    pub(crate) app: &'a tauri::AppHandle,
    pub(crate) from: &'a str,
    pub(crate) full_access: bool,
}

impl<'a> Ctx<'a> {
    #[allow(dead_code)] // for feature files
    pub(crate) fn state(&self) -> tauri::State<'a, AppState> {
        self.app.state::<AppState>()
    }
}

/// A method's reply future.
pub(crate) type Reply<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;

/// A validated request, ready to run. Implemented by each method's params struct.
pub(crate) trait Run: Debug + Send {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a>;
}

/// One registry method. `parse` refuses invalid params with a short user-facing message.
pub(crate) struct Method {
    pub(crate) name: &'static str,
    pub(crate) access: Access,
    /// Read-only methods run concurrently, may be batched and are retried after a reconnect.
    pub(crate) read_only: bool,
    pub(crate) parse: fn(&Value) -> Result<Box<dyn Run>>,
}

/// Where `socket.rs` runs a state-changing registry method. Everything not listed here (and
/// not read-only) shares the phone's one ordered lane with `task.send`, `task.stop` and the
/// rest, so a slow method listed nowhere would hold up a Stop behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    /// Starts a task or chat: its own run, holding one of the computer's start slots like
    /// `task.start` (a repeated `startId` answers the first start).
    Start,
    /// Slow work that names no task's next step (a model call, a push, checks): runs beside
    /// the ordered lane, a few at a time per phone.
    Background,
}

/// Methods that start a task, chat or cloud agent.
const START_METHODS: [&str; 4] = ["github.startTask", "chat.start", "team.start", "cloudAgents.start"];

/// Slow methods (network, model calls, long git or check runs) kept off the ordered lane.
/// The slow [`super::host::ONCE_METHODS`] (`rewind.to` forks a thread; files stay as they are)
/// are here, so a retry runs beside its first try and waits for its answer instead of queueing
/// behind it. Each one waits in the queue at most [`background_timeout`] (socket.rs).
/// `slash.resolve` may run discovery for up to the phone's 30 s, so it never blocks a Stop.
const BACKGROUND_METHODS: [&str; 18] = [
    "btw.ask", "pull.review", "checks.run", "git.commit", "git.push", "github.comment", "pull.create", "recipes.run", "worktree.create", "worktree.merge", "worktree.remove", "vm.start", "vm.stop",
    "schedules.runNow", "bot.runSchedule", "rewind.to", "moodboards.add", "slash.resolve",
];

/// How long the phone waits for a background call (its `timeoutMs` in
/// mobile/src/connect/api/*.ts): socket.rs answers one still queued past it (less a margin)
/// with `NOT_RUN` instead of running it after its caller gave up. A once-method whose `sendId`
/// already ran is still answered from memory.
pub(crate) fn background_timeout(name: &str, params: &Value) -> std::time::Duration {
    let secs = match name {
        "checks.run" => 150,
        "git.push" | "pull.create" => 90,
        // api/git.ts: 90 s with a push, 60 s without.
        "git.commit" if params["push"].as_bool() == Some(true) => 90,
        // `task.pullMerge` (host.rs, Round 23): client.ts `MERGE_TIMEOUT_MS`.
        "git.commit" | "worktree.create" | "worktree.merge" | "worktree.remove" | "btw.ask" | "vm.start" | "vm.stop" | "task.pullMerge" => 60,
        "recipes.run" | "github.comment" | "pull.review" => 45,
        // api/composer.ts: discovery may take the phone's whole 30 s.
        "slash.resolve" => 30,
        // `schedules.runNow`, `bot.runSchedule`, `rewind.to`, `moodboards.add`: the default.
        _ => return super::client::TIMEOUT,
    };
    std::time::Duration::from_secs(secs)
}

/// Read-only registry methods the phone waits for longer than the default (network, `gh`, a
/// usage refresh, a design render), with that wait (their `timeoutMs` in
/// mobile/src/connect/api/*.ts). socket.rs runs them in their own small lane, so a few of them
/// never fill the read slots that `subscribe`, `tasks.list` and `task.messages` catch up through
/// after a reconnect, and lets one wait in its queue up to this, less a margin.
const SLOW_READS: [(&str, u64); 14] = [
    ("github.repos", 45),
    ("github.issues", 45),
    ("github.pulls", 45),
    ("github.runs", 45),
    ("github.item", 45),
    ("github.search", 45),
    ("usage.get", 60),
    ("usage.limits", 45),
    ("recipes.plan", 45),
    ("design.preview", 40),
    ("settings.providers", 30),
    ("projects.recentRepos", 30),
    ("slash.list", 30),
    // A big project's grep can take the phone's default 20 s; it never holds a read slot.
    ("files.grep", 20),
];

/// How long the phone waits for a slow read-only method, or `None` for an ordinary read.
pub(crate) fn slow_read_timeout(name: &str) -> Option<std::time::Duration> {
    SLOW_READS.iter().find(|(slow, _)| *slow == name).map(|(_, secs)| std::time::Duration::from_secs(*secs))
}

/// The lane a registry method runs in, or `None` for the ordered lane (or a read).
pub(crate) fn lane_for(name: &str) -> Option<Lane> {
    if START_METHODS.contains(&name) {
        Some(Lane::Start)
    } else if BACKGROUND_METHODS.contains(&name) {
        Some(Lane::Background)
    } else {
        None
    }
}

/// A parsed registry call inside `host::Call`.
#[derive(Debug)]
pub(crate) struct Parsed {
    pub(crate) name: &'static str,
    pub(crate) call: Box<dyn Run>,
}

impl PartialEq for Parsed {
    /// For tests: same method and same validated params.
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && format!("{:?}", self.call) == format!("{:?}", other.call)
    }
}

/// Every feature group, in the order `host.hello` lists them. A new feature file adds
/// itself here (and its `mod` line above) once.
const GROUPS: [(&str, &[Method]); 16] = [
    ("hello", HELLO),
    ("threads", threads::METHODS),
    ("composer", composer::METHODS),
    ("git", git::METHODS),
    ("github", github::METHODS),
    ("schedules", schedules::METHODS),
    ("files", files::METHODS),
    ("tools", tools::METHODS),
    ("terminal", terminal::METHODS),
    ("admin", admin::METHODS),
    ("design", design::METHODS),
    ("projects", projects::METHODS),
    ("team", team::METHODS),
    ("settings", settings::METHODS),
    ("rewind", rewind::METHODS),
    ("search", search::METHODS),
];

/// Every registry method.
pub(crate) fn all() -> impl Iterator<Item = &'static Method> {
    GROUPS.iter().flat_map(|(_, methods)| methods.iter())
}

/// The registry method called `name`, if any.
pub(crate) fn find(name: &str) -> Option<&'static Method> {
    all().find(|method| method.name == name)
}

/// Validates a registry call; `None` when `name` is not a registry method.
pub(crate) fn parse(name: &str, params: &Value) -> Option<Result<Parsed>> {
    let method = find(name)?;
    Some((method.parse)(params).map(|call| Parsed { name: method.name, call }))
}

// ---- host.hello ----

pub(crate) const HELLO: &[Method] = &[Method { name: "host.hello", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Hello)) }];

#[derive(Debug)]
struct Hello;

impl Run for Hello {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let version = ctx.app.package_info().version.to_string();
        Box::pin(async move {
            let access = super::grants::scope_name(ctx.app, ctx.from);
            Ok(hello_reply(&version, ctx.full_access, access))
        })
    }
}

/// Flags for behaviour a phone cannot read from the method list: `startId` (a repeated
/// `task.start` with the same id answers the first start), `sendId` (the same for `task.send`,
/// `task.steer` and `bot.message`, remembered an hour), `actionSendId` (the same `sendId` for
/// `github.comment`, `pull.create`, `recipes.run`, `schedules.runNow`, `worktree.create`,
/// `thread.fork` and `rewind.to`: host::ONCE_METHODS)
/// and `prevSeq` (each agent event names its task's previous event as `prev`, so a viewer can
/// tell it missed one).
/// `forkSendId`: `worktree.create`, `thread.fork` and `rewind.to` joined the once-methods too
/// (hosts with only `actionSendId` would run a retried one twice).
/// `backgroundSendId`: so did `btw.ask`, `vm.start`, `vm.stop` and `moodboards.add`, and a
/// background call still queued past [`background_timeout`] is refused unrun.
/// `projectCheckout`: `task.start` with a `projectId` takes `checkout: "current"` (the project's
/// folder as it is) and runs in a folder without `origin` or outside Git (`start.rs`); older
/// hosts ignore `checkout` and fall back to a worktree (`remote/browse.rs` asks first).
pub(crate) const PROJECT_CHECKOUT: &str = "projectCheckout";
const BASE_FEATURES: [&str; 12] =
    ["packedFrames", "replayAfterSeq", "pagedMessages", "imageUpload", "teams", "startId", "sendId", "actionSendId", "forkSendId", "backgroundSendId", "prevSeq", PROJECT_CHECKOUT];

/// Methods that also need the host's "Full access for remote tasks" switch (each one checks
/// `terminal::require_full_access*` or `ctx.full_access` itself), so a phone can explain why
/// they are off.
/// `task.start` with a `repo` this computer has no project for refuses too
/// (`start::refuse_clone`), but a start in an existing project does not, so it is not listed.
pub(crate) const SWITCH_METHODS: [&str; 15] = [
    "terminal.list", "terminal.open", "terminal.read", "terminal.write", "terminal.resize", "terminal.close", "runScript.start", "runScript.stop", "checks.run", "files.write", "skills.activate", "cloudAgents.start",
    "moodboards.add", "projects.clone", "team.start",
];

/// What `host.hello` answers: protocol, version, every method this host serves, its
/// request limits, feature flags (the base ones, each feature group that has at least
/// one method, and `remoteFullAccess` while remote tasks may use Full access), the calling
/// device's grant (`access`: `view`, `control` or `full`), the narrowest grant each method
/// needs (`methodAccess`) and the methods gated on the switch (`fullAccessSwitch`).
pub(crate) fn hello_reply(app_version: &str, full_access: bool, access: Option<&str>) -> Value {
    let methods = super::host::all_methods();
    let groups = GROUPS.iter().filter(|(name, methods)| *name != "hello" && !methods.is_empty()).map(|(name, _)| *name);
    let mut features: Vec<&str> = BASE_FEATURES.iter().copied().chain(groups).collect();
    if full_access {
        features.push("remoteFullAccess");
    }
    let method_access: serde_json::Map<String, Value> = methods.iter().map(|name| (name.to_string(), json!(super::grants::method_access(name)))).collect();
    json!({
        "protocol": PROTOCOL,
        "appVersion": app_version,
        "access": access,
        "methodAccess": method_access,
        "fullAccessSwitch": SWITCH_METHODS,
        "methods": methods,
        "limits": super::host::limits(),
        "features": features,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_names_are_unique_and_never_shadow_built_in_methods() {
        let mut seen = HashSet::new();
        for method in all() {
            assert!(seen.insert(method.name), "{} is registered twice", method.name);
            assert!(!super::super::host::METHODS.contains(&method.name), "{} is also a built-in method", method.name);
            assert!(!method.name.is_empty() && method.name.len() <= 64 && method.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'), "{}", method.name);
        }
    }

    #[test]
    fn hello_lists_every_method_limits_and_features() {
        let reply = hello_reply("9.9.9", false, Some("control"));
        assert_eq!(reply["protocol"], 2);
        assert_eq!(reply["appVersion"], "9.9.9");
        let methods: Vec<&str> = reply["methods"].as_array().unwrap().iter().map(|m| m.as_str().unwrap()).collect();
        for method in super::super::host::METHODS.iter().chain(all().map(|m| &m.name)) {
            assert!(methods.contains(method), "{method} missing from host.hello");
        }
        assert!(methods.contains(&"host.hello"));
        assert_eq!(methods.len(), methods.iter().collect::<HashSet<_>>().len(), "no duplicates");
        assert_eq!(reply["limits"]["maxText"], MAX_TEXT);
        assert_eq!(reply["limits"]["pageBudget"], PAGE_BUDGET);
        assert_eq!(reply["limits"]["maxBatch"], 8);
        assert!(reply["limits"]["maxFrame"].as_u64().unwrap() > PAGE_BUDGET as u64);
        let features = reply["features"].as_array().unwrap();
        assert!(features.contains(&json!("packedFrames")));
        for flag in ["startId", "sendId", "actionSendId", "forkSendId", "backgroundSendId", "prevSeq"] {
            assert!(features.contains(&json!(flag)), "{flag}");
        }
        assert!(!features.contains(&json!("remoteFullAccess")));
        assert!(hello_reply("1", true, None)["features"].as_array().unwrap().contains(&json!("remoteFullAccess")));
    }

    #[test]
    fn hello_reports_the_callers_access_and_each_methods_grant() {
        let reply = hello_reply("1", false, Some("view"));
        assert_eq!(reply["access"], "view");
        assert_eq!(hello_reply("1", false, None)["access"], Value::Null);
        let access = reply["methodAccess"].as_object().unwrap();
        assert_eq!(access.len(), reply["methods"].as_array().unwrap().len(), "every method has a grant");
        assert_eq!(access["tasks.list"], "view");
        assert_eq!(access["host.hello"], "view");
        assert_eq!(access["task.send"], "control");
        assert_eq!(access["task.start"], "full");
        assert_eq!(access["terminal.open"], "full");
        let switch: Vec<&str> = reply["fullAccessSwitch"].as_array().unwrap().iter().map(|m| m.as_str().unwrap()).collect();
        for name in SWITCH_METHODS {
            assert!(find(name).is_some(), "{name} is a registry method");
            assert!(switch.contains(&name));
        }
        assert!(switch.contains(&"moodboards.add"), "moodboards.add checks the switch, so hello names it");
        assert!(switch.contains(&"projects.clone"), "Round 10: a phone clone needs the switch");
        assert!(!switch.contains(&"task.start"), "a start in an existing project does not");
        assert!(reply.to_string().len() < 64 * 1024, "hello stays small");
    }

    #[test]
    fn slow_methods_leave_the_ordered_lane_and_every_listed_one_is_a_real_writer() {
        for name in START_METHODS {
            assert_eq!(lane_for(name), Some(Lane::Start), "{name}");
        }
        for name in BACKGROUND_METHODS {
            assert_eq!(lane_for(name), Some(Lane::Background), "{name}");
        }
        for name in START_METHODS.iter().chain(BACKGROUND_METHODS.iter()) {
            let method = find(name).unwrap_or_else(|| panic!("{name} is not a registry method"));
            assert!(!method.read_only, "{name}");
        }
        for name in ["thread.rename", "queue.update", "terminal.write", "git.stage", "task.stop"] {
            assert_eq!(lane_for(name), None, "{name}");
        }
        // Round 8: the once-methods that take long run in the background lane.
        for name in ["rewind.to", "git.commit", "bot.runSchedule"] {
            assert_eq!(lane_for(name), Some(Lane::Background), "{name}");
            assert!(super::super::host::ONCE_METHODS.contains(&name), "{name}");
        }
    }

    #[test]
    fn background_calls_wait_no_longer_than_the_phone_does() {
        let s = std::time::Duration::from_secs;
        assert_eq!(background_timeout("checks.run", &json!({})), s(150));
        assert_eq!(background_timeout("git.push", &json!({})), s(90));
        assert_eq!(background_timeout("git.commit", &json!({"push": true})), s(90));
        assert_eq!(background_timeout("git.commit", &json!({"push": false})), s(60));
        assert_eq!(background_timeout("btw.ask", &json!({})), s(60));
        assert_eq!(background_timeout("vm.start", &json!({})), s(60));
        assert_eq!(background_timeout("recipes.run", &json!({})), s(45));
        assert_eq!(background_timeout("task.pullMerge", &json!({})), s(60), "Round 23: client.ts MERGE_TIMEOUT_MS");
        assert!(include_str!("../../../../mobile/src/connect/client.ts").contains("const MERGE_TIMEOUT_MS = 60_000;"));
        // Round 20: a slow command lookup never blocks a Stop in the ordered lane.
        assert_eq!(lane_for("slash.resolve"), Some(Lane::Background));
        assert_eq!(background_timeout("slash.resolve", &json!({})), s(30));
        for name in ["schedules.runNow", "bot.runSchedule", "rewind.to", "moodboards.add"] {
            assert_eq!(background_timeout(name, &json!({})), super::super::client::TIMEOUT, "{name}");
        }
        for name in BACKGROUND_METHODS {
            let limit = background_timeout(name, &json!({"push": true}));
            assert!(limit >= super::super::client::TIMEOUT && limit <= s(150), "{name}");
        }
        // Round 9: the background calls a retry could repeat are once-methods.
        for name in ["btw.ask", "vm.start", "vm.stop", "moodboards.add"] {
            assert_eq!(lane_for(name), Some(Lane::Background), "{name}");
            assert!(super::super::host::ONCE_METHODS.contains(&name), "{name}");
        }
    }

    #[test]
    fn slow_reads_are_real_readers_with_the_phones_longer_timeout() {
        for (name, secs) in SLOW_READS {
            let method = find(name).unwrap_or_else(|| panic!("{name} is not a registry method"));
            assert!(method.read_only, "{name}");
            assert_eq!(lane_for(name), None, "{name}");
            assert!(std::time::Duration::from_secs(secs) >= super::super::client::TIMEOUT, "{name}");
        }
        let s = std::time::Duration::from_secs;
        assert_eq!(slow_read_timeout("github.repos"), Some(s(45)));
        assert_eq!(slow_read_timeout("usage.get"), Some(s(60)));
        assert_eq!(slow_read_timeout("design.preview"), Some(s(40)));
        assert_eq!(slow_read_timeout("settings.providers"), Some(s(30)));
        assert_eq!(slow_read_timeout("files.grep"), Some(s(20)), "Round 20");
        for name in ["subscribe", "tasks.list", "task.messages", "batch", "host.hello", "files.read"] {
            assert_eq!(slow_read_timeout(name), None, "{name}");
        }
    }

    #[test]
    fn every_once_method_is_a_registry_writer() {
        for name in super::super::host::ONCE_METHODS {
            let method = find(name).unwrap_or_else(|| panic!("{name} is not a registry method"));
            assert!(!method.read_only, "{name}");
        }
    }

    #[tokio::test]
    async fn task_send_locks_serialize_one_task_and_leave_others_alone() {
        let first = task_send_lock("lock-test-a").await;
        // Another task is not held up.
        let other = tokio::time::timeout(std::time::Duration::from_millis(200), task_send_lock("lock-test-b")).await;
        assert!(other.is_ok());
        // The same task waits until the first holder is done.
        let waiting = tokio::spawn(async { task_send_lock("lock-test-a").await; });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "a second send waits for the first");
        drop(first);
        tokio::time::timeout(std::time::Duration::from_secs(2), waiting).await.unwrap().unwrap();
    }

    #[test]
    fn hello_parses_through_the_registry() {
        let parsed = parse("host.hello", &json!({})).unwrap().unwrap();
        assert_eq!(parsed.name, "host.hello");
        assert!(parse("nope.nothing", &json!({})).is_none());
        let hello = find("host.hello").unwrap();
        assert_eq!(hello.access, Access::View);
        assert!(hello.read_only);
    }
}
