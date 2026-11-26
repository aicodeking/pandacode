//! The task, sidebar and startup recovery statements `Store` runs, built at compile time so
//! they can use the prepared statement cache. Each comment names the index its query relies on;
//! `schema_v38::tests::hot_queries_use_their_indexes` checks the plans.

/// The first tables and indexes, also used to restore missing base indexes on open.
pub(super) const BASE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, resume_id TEXT);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS messages_handoffs ON messages(session_id, id) WHERE role='handoff';";

/// A macro so the order can be spliced into `concat!` constants (see `SESSIONS_SQL`).
macro_rules! sidebar_order {
    () => {
        "pinned DESC,sidebar_order IS NULL,sidebar_order,COALESCE(MAX(last_response_at,last_prompt_at),last_response_at,last_prompt_at,created_at) DESC,id"
    };
}
pub(super) const SIDEBAR_ORDER: &str = sidebar_order!();
/// The sidebar listing: card previews only, built once at compile time so `sessions` can use
/// the prepared statement cache.
pub(super) const SESSIONS_SQL: &str = concat!(
    "SELECT id,project_id,title,provider,model,mode,status,created_at,updated_at,archived,resume_id,last_response_at,worktree_path,reasoning_effort,context_used_tokens,context_window,task_stage,substr(task_description,1,512),completed_at,goal_state,codex_settings,worktree_branch,last_prompt_at,pinned,sidebar_order,draft,limited_at,limited_until,resume_at_reset,remote_device,cloud FROM sessions WHERE draft=0 AND id NOT IN (SELECT session_id FROM architect_workers) ORDER BY ",
    sidebar_order!(),
    " LIMIT 500"
);
/// The whole order `reorder_sessions` rewrites, with each row's current rank.
pub(super) const REORDER_SQL: &str = concat!(
    "SELECT id,pinned,sidebar_order FROM sessions WHERE draft=0 AND id NOT IN (SELECT session_id FROM architect_workers) ORDER BY ",
    sidebar_order!()
);
/// `search_tasks`: a project's tasks newest first (`sessions_project`), each with its newest
/// user or assistant message matching ?2 (`messages_session_conversation`). That one lookup is
/// both the filter and the excerpt; `LIMIT -1` keeps SQLite from flattening the inner query
/// (or pushing the outer filter into it), which would run the lookup a second time. The inner
/// query streams as a co-routine, so the outer `LIMIT` still stops the walk early.
pub(super) const SEARCH_TASKS_SQL: &str = "SELECT id,title,updated_at,excerpt FROM (
      SELECT s.id,s.title,s.updated_at,
        (SELECT m.content FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant') AND m.content LIKE ?2 ESCAPE '\\' ORDER BY m.id DESC LIMIT 1) AS excerpt
      FROM sessions s
      WHERE s.project_id=?1 AND s.draft=0 AND s.id NOT IN (SELECT session_id FROM architect_workers)
      ORDER BY s.updated_at DESC LIMIT -1)
    WHERE excerpt IS NOT NULL OR title LIKE ?2 ESCAPE '\\'
    ORDER BY updated_at DESC LIMIT ?3";
/// Usage-limit resumes that are due, through the `sessions_limit_resume` partial index.
pub(super) const DUE_LIMIT_RESUMES_SQL: &str = "SELECT id FROM sessions WHERE resume_at_reset=1 AND limited_until IS NOT NULL AND limited_until<=?1 AND archived=0 AND draft=0 ORDER BY limited_until LIMIT 50";
/// Through the `sessions_provider_resume` partial index (an equality on `resume_id` implies it is not NULL).
pub(super) const IMPORTED_TASK_SQL: &str = "SELECT id FROM sessions WHERE provider=?1 AND resume_id=?2 ORDER BY updated_at DESC LIMIT 1";
/// Through the `sessions_draft` partial index.
pub(super) const DISCARD_EMPTY_DRAFTS_SQL: &str = "DELETE FROM sessions WHERE draft=1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id) AND id NOT IN (SELECT session_id FROM architect_workers) AND id NOT IN (SELECT parent_session_id FROM architect_workers)";
/// A project's links: its tasks through `sessions_project`, then each task's links by primary key.
pub(super) const PROJECT_LINKS_SQL: &str = "SELECT l.session_id,l.kind,l.number,l.url,l.title,l.state,l.checked_at FROM task_links l JOIN sessions s ON s.id=l.session_id WHERE s.project_id=?1 ORDER BY l.number";
/// Through the `messages_session_conversation` partial index (user and assistant rows only, so
/// tool rows are skipped without a separate index for user rows to maintain). The `IN` term
/// repeats the index's WHERE clause: SQLite does not infer it from `role='user'`.
pub(super) const USER_TURNS_SQL: &str = "SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role IN ('user','assistant') AND role='user'";
/// Through the `messages_user_activity` partial index (a range on `created_at`, covering `session_id`).
pub(super) const PROMPT_ACTIVITY_SQL: &str = "SELECT m.created_at/3600000,s.provider,COUNT(*) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='user' AND m.created_at>=?1 GROUP BY 1,2 ORDER BY 1";

// Startup recovery (`Store::open`). Each WHERE clause repeats its index's verbatim, so a
// launch with nothing to recover reads no table row.
macro_rules! legacy_prompt_cutoff_set {
    () => {
        "UPDATE architect_teams SET content=json_set(content,'$.legacyPromptThroughId',COALESCE((SELECT MAX(id) FROM messages WHERE session_id=architect_teams.session_id),0))"
    };
}
macro_rules! legacy_prompt_cutoff_pred {
    () => {
        "CASE WHEN json_valid(content) THEN COALESCE(json_type(content,'$.legacyPromptThroughId'),'null') END='null'"
    };
}
/// Through the `architect_team_meta_legacy_cutoff` partial index on the trigger-kept tracker
/// (`SCHEMA_38_RUNNING`), which holds only teams still missing the `legacyPromptThroughId`
/// watermark, so a healthy launch reads no `architect_teams` row (it used to parse every team
/// snapshot, most of a reopen's time). The content test repeats the tracker's predicate, so a
/// stale tracker row can never stamp a team that already has a watermark: valid JSON whose key is
/// missing or JSON `null` (unparsable content makes the CASE NULL, so `json_type` never sees it).
pub(super) const LEGACY_PROMPT_CUTOFF_SQL: &str = concat!(legacy_prompt_cutoff_set!(), "
            WHERE session_id IN (SELECT session_id FROM architect_team_meta WHERE needs_legacy_cutoff=1)
              AND ", legacy_prompt_cutoff_pred!(), ";");
/// `LEGACY_PROMPT_CUTOFF_SQL` for the version 19 migration, which runs before version 38 creates
/// `architect_team_meta`: it reads every team, as it always did.
pub(super) const LEGACY_PROMPT_CUTOFF_SCAN_SQL: &str = concat!(legacy_prompt_cutoff_set!(), " WHERE ", legacy_prompt_cutoff_pred!(), ";");
/// Through `sessions_active_status`. Archived tasks are left out: the page shows no Interrupted badge for them.
pub(super) const COUNT_RESTART_INTERRUPTED_SQL: &str = "SELECT COUNT(*) FROM sessions WHERE status IN ('running','waiting') AND stop_requested=0 AND archived=0 AND (remote_device IS NULL OR id NOT IN (SELECT session_id FROM machine_threads))";
/// Through `sessions_remote_pending`.
pub(super) const RESET_REMOTE_STARTS_SQL: &str = "UPDATE sessions SET remote_device=NULL,status='idle',draft=NOT EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id) WHERE remote_device IS NOT NULL AND remote_session IS NULL AND id NOT IN (SELECT session_id FROM machine_threads)";
/// Through `sessions_active_goal`.
pub(super) const PAUSE_GOALS_SQL: &str = "UPDATE sessions SET goal_state=json_set(goal_state,'$.status','paused')
            WHERE json_valid(goal_state) AND json_extract(goal_state,'$.status')='active'";
macro_rules! interrupt_teams {
    ($candidates:literal) => {
        concat!("UPDATE architect_teams SET content=json_set(content,'$.status','interrupted','$.pendingTurn',NULL,'$.error','PandaCode restarted. Resume explicitly to continue.','$.generation',COALESCE(json_extract(content,'$.generation'),0)+1,'$.revision',COALESCE(json_extract(content,'$.revision'),0)+1,
            '$.workers',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.status') IN ('running','waiting') THEN json_set(value,'$.status','stopped') ELSE value END)) FROM json_each(content,'$.workers') WHERE type='object')))
            WHERE ", $candidates, "json_valid(content) AND json_extract(content,'$.status') IN ('running','waiting');")
    };
}
/// Through the architect_team_meta_status index, with a status re-check on each snapshot.
pub(super) const INTERRUPT_TEAMS_SQL: &str =
    interrupt_teams!("session_id IN (SELECT session_id FROM architect_team_meta WHERE status IN ('running','waiting')) AND ");
/// For newer schemas where the tracker cannot be used.
pub(super) const INTERRUPT_TEAMS_FALLBACK_SQL: &str = interrupt_teams!("");
/// `Store::settle_archived`, through the `sessions_archived` partial index.
pub(super) const SETTLE_ARCHIVED_SQL: &str = "UPDATE sessions SET archived=0,task_stage='completed',completed_at=COALESCE(completed_at,updated_at) WHERE archived=1";
pub(super) const SESSION_SQL: &str = "SELECT id,project_id,title,provider,model,mode,status,created_at,updated_at,archived,resume_id,last_response_at,worktree_path,reasoning_effort,context_used_tokens,context_window,task_stage,task_description,completed_at,goal_state,codex_settings,worktree_branch,last_prompt_at,pinned,sidebar_order,draft,limited_at,limited_until,resume_at_reset,remote_device,cloud FROM sessions WHERE id=?1";
