//! Small storage helpers kept out of `storage.rs`: the rollback detector, the newer-schema
//! recovery wrapper, the transaction runner, and path/subagent validation.
use rusqlite::Connection;
use std::{io::Write, path::PathBuf};

use super::schema_v38::{settle_unfinished_subagents, settle_unfinished_tools};
use super::sessions::{has_sidebar_ranking_columns, rank_published_drafts};
use super::sql::{
    COUNT_RESTART_INTERRUPTED_SQL, INTERRUPT_TEAMS_FALLBACK_SQL, INTERRUPT_TEAMS_SQL, PAUSE_GOALS_SQL,
    RESET_REMOTE_STARTS_SQL,
};
use super::{Result, Store, SCHEMA_VERSION};

/// The ordinary page cache (8 MiB), restored after migration and repair.
const STEADY_CACHE: i64 = -8192;

pub(super) fn set_steady_storage_pragmas(db: &Connection) -> Result<()> {
    let cache = db.pragma_update(None, "cache_size", STEADY_CACHE);
    let temp_store = db.execute_batch("PRAGMA temp_store=MEMORY;");
    cache.and(temp_store).map_err(|error| error.to_string())
}

struct MigrationPragmasGuard<'db> {
    db: &'db Connection,
    restore_sidebar_trigger: bool,
}

impl Drop for MigrationPragmasGuard<'_> {
    fn drop(&mut self) {
        let pragmas = set_steady_storage_pragmas(self.db);
        let sidebar_trigger = if self.restore_sidebar_trigger {
            rank_published_drafts(self.db)
        } else {
            Ok(())
        };
        if let Err(error) = pragmas.and(sidebar_trigger) {
            let _ = writeln!(std::io::stderr(), "Restoring database storage settings: {error}");
        }
    }
}

/// Lets migration sorts spill to disk. The callback must finish any transaction it
/// starts before the guard restores the steady-state pragmas.
pub(crate) fn with_migration_pragmas<T>(
    db: &Connection,
    large_cache: bool,
    work: impl FnOnce() -> Result<T>,
) -> Result<T> {
    // Changing temp_store clears SQLite's TEMP schema. Bot startup may run after
    // the Store has installed the connection-local sidebar ranking trigger.
    let restore_sidebar_trigger = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_temp_schema WHERE type='trigger' AND name='rank_published_draft')",
        [],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let _guard = MigrationPragmasGuard { db, restore_sidebar_trigger };
    db.execute_batch("PRAGMA temp_store=FILE;").map_err(|error| error.to_string())?;
    if large_cache {
        db.execute_batch("PRAGMA cache_size=-65536;").map_err(|error| error.to_string())?;
    }
    work()
}

/// Detects when SQLite itself rolled back an active transaction (I/O, disk full, or
/// `RAISE(ROLLBACK)`), so best-effort batch loops stop instead of committing later rows
/// in autocommit mode.
pub(crate) struct RollbackGuard<'a> {
    db: &'a Connection,
    in_tx: bool,
}

impl<'a> RollbackGuard<'a> {
    pub(crate) fn new(db: &'a Connection) -> Self {
        Self { db, in_tx: !db.is_autocommit() }
    }
    pub(crate) fn rolled_back(&self) -> bool {
        self.in_tx && self.db.is_autocommit()
    }
}

/// Runs a startup recovery step. At or below `SCHEMA_VERSION` every error is fatal.
/// A newer schema may have dropped or renamed what the step reads. Log its error
/// and roll back its savepoint, unless SQLite rolled the whole transaction back.
pub(super) fn tracked_recovery<T>(
    recovery: &Connection,
    version: i64,
    step: &str,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<Option<T>> {
    if version <= SCHEMA_VERSION {
        return run(recovery).map(Some);
    }
    let guard = RollbackGuard::new(recovery);
    match run_savepoint(recovery, "pandacode_newer_recovery", || run(recovery), |e| e.to_string()) {
        Ok(value) => Ok(Some(value)),
        Err(error) if guard.rolled_back() => Err(error),
        Err(error) => {
            eprintln!("Skipping startup recovery ({step}) on newer schema v{version}: {error}");
            Ok(None)
        }
    }
}

/// Settles the running state that the previous process left behind. The writer lock
/// makes the version check and the recovery use the same schema.
pub(super) fn recover_after_restart(db: &mut Connection) -> Result<(usize, i64)> {
    let recovery = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let version: i64 = recovery.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(|e| e.to_string())?;
    let trackers_usable = version <= SCHEMA_VERSION;
    let tracked = |step: &str, run: &dyn Fn(&Connection) -> Result<()>| tracked_recovery(&recovery, version, step, run);
    tracked("legacy prompt cutoff", &|db| Store::record_legacy_prompt_cutoff(db, trackers_usable))?;
    tracked("unfinished tools", &|db| {
        settle_unfinished_tools(db, None, "\n\n[PandaCode was interrupted before this tool reported a result.]", trackers_usable)
    })?;
    tracked("unfinished subagents", &|db| settle_unfinished_subagents(db, None, "stopped", trackers_usable))?;
    let restart_interrupted = tracked_recovery(&recovery, version, "interrupted tasks", |db| {
        let count: i64 = db.query_row(COUNT_RESTART_INTERRUPTED_SQL, [], |r| r.get(0)).map_err(|e| e.to_string())?;
        // The restart interrupted these tasks unless the user had requested Stop.
        // A machine thread keeps its host's status so its parent still waits for it.
        db.execute(
            "UPDATE sessions SET status='interrupted',task_stage='in_progress',completed_at=NULL,restart_interrupted=1-stop_requested WHERE status IN ('running','waiting') AND (remote_device IS NULL OR id NOT IN (SELECT session_id FROM machine_threads))",
            [],
        ).map_err(|e| e.to_string())?;
        Ok(usize::try_from(count).unwrap_or(0))
    })?.unwrap_or(0);
    // An unresolved remote start becomes a draft again. Machine threads retain their
    // starts so the viewer can query the host by request ID.
    tracked_recovery(&recovery, version, "remote starts", |db| db.execute(RESET_REMOTE_STARTS_SQL, []).map_err(|e| e.to_string()))?;
    tracked_recovery(&recovery, version, "active goals", |db| db.execute(PAUSE_GOALS_SQL, []).map_err(|e| e.to_string()))?;
    tracked("interrupted teams", &|db| {
        let sql = if trackers_usable { INTERRUPT_TEAMS_SQL } else { INTERRUPT_TEAMS_FALLBACK_SQL };
        db.execute_batch(sql).map_err(|e| e.to_string())
    })?;
    tracked("sidebar ranking", &|db| {
        if trackers_usable || has_sidebar_ranking_columns(db)? {
            let ranked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE sidebar_order IS NOT NULL)", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            if ranked { rank_published_drafts(db)?; }
        }
        Ok(())
    })?;
    recovery.commit().map_err(|e| e.to_string())?;
    Ok((restart_interrupted, version))
}

/// Runs `work` inside a SQLite savepoint named `name`, rolling back only the savepoint on
/// error or failed `RELEASE`. If cleanup itself fails, logs it; falls back to a full
/// `ROLLBACK` only when `standalone` (the savepoint opened the transaction), never silently
/// putting a caller's outer transaction into autocommit mode.
pub(crate) fn run_savepoint<T, E: std::fmt::Display>(
    db: &Connection,
    name: &str,
    work: impl FnOnce() -> std::result::Result<T, E>,
    map_sqlite: impl Fn(rusqlite::Error) -> E,
) -> std::result::Result<T, E> {
    let standalone = db.is_autocommit();
    let identifier = format!("\"{}\"", name.replace('"', "\"\""));
    db.execute_batch(&format!("SAVEPOINT {identifier}")).map_err(&map_sqlite)?;
    // Identically named savepoints nest; ROLLBACK TO / RELEASE target the innermost one.
    let release = format!("RELEASE SAVEPOINT {identifier}");
    let result = work().and_then(|value| {
        db.execute_batch(&release).map_err(&map_sqlite)?;
        Ok(value)
    });
    if result.is_err() && !db.is_autocommit() {
        let cleanup = format!("ROLLBACK TO SAVEPOINT {identifier}; {release}");
        if let Err(error) = db.execute_batch(&cleanup) {
            eprintln!("Rolling back savepoint {name}: {error}");
            if standalone && !db.is_autocommit() {
                if let Err(error) = db.execute_batch("ROLLBACK") {
                    eprintln!("Rolling back transaction opened by savepoint {name}: {error}");
                }
            }
        }
    }
    result
}

/// Resolves a task's checkout (or the project folder when it has none) on disk, without
/// silently falling back from a missing worktree to the main folder.
pub(crate) fn resolve_workspace_root(project_path: PathBuf, worktree: Option<PathBuf>) -> Result<PathBuf> {
    let is_worktree = worktree.is_some();
    let kind = if is_worktree { "Worktree" } else { "Project" };
    let path = worktree
        .unwrap_or(project_path)
        .canonicalize()
        .map_err(|e| format!("{kind} folder is unavailable: {e}"))?;
    if !path.is_dir() {
        return Err(format!("{kind} folder is unavailable."));
    }
    if is_worktree && !path.join(".git").is_file() {
        return Err("Worktree checkout is unavailable. Its Git metadata is missing.".into());
    }
    Ok(path)
}

/// A subagent snapshot as saved in `subagents.content`, after checking its id.
pub(crate) fn serialize_subagent(activity: &crate::providers::SubagentActivity) -> Result<String> {
    if activity.id.is_empty() || activity.id.len() > 1024 {
        return Err("Subagent activity has an invalid ID.".into());
    }
    serde_json::to_string(activity).map_err(|error| error.to_string())
}

/// Error from `Store::try_in_transaction_immediate`: distinguishes failing to acquire the
/// immediate write lock (before `work` ever ran) from any other error.
#[derive(Debug)]
pub(crate) enum ImmediateTxError {
    Busy(String),
    Other(String),
}

fn is_sqlite_lock_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

impl Store {
    /// Runs `work` in one (deferred) transaction, or in a savepoint inside the caller's when one
    /// is already open. Either way an error rolls back exactly what `work` wrote: standalone its
    /// own transaction, nested its savepoint, leaving the caller's earlier and later writes in
    /// the outer transaction (unless SQLite itself rolled that whole transaction back).
    pub(crate) fn in_transaction<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        self.run_in_transaction(rusqlite::TransactionBehavior::Deferred, work)
    }

    /// `in_transaction`, but a standalone transaction takes the write lock up front (`BEGIN
    /// IMMEDIATE`). Use it when `work` reads before it writes: under WAL a deferred transaction
    /// that read a snapshot and then tries to write after another connection committed fails at
    /// once with `SQLITE_BUSY_SNAPSHOT`, without waiting for the busy timeout.
    pub(crate) fn in_transaction_immediate<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        self.run_in_transaction(rusqlite::TransactionBehavior::Immediate, work)
    }

    /// Like `in_transaction_immediate`, but when starting a standalone transaction fails with
    /// `SQLITE_BUSY` or `SQLITE_LOCKED` (before `work` runs), returns `ImmediateTxError::Busy`.
    pub(crate) fn try_in_transaction_immediate<T>(
        &self,
        work: impl FnOnce() -> Result<T>,
    ) -> std::result::Result<T, ImmediateTxError> {
        if self.db.is_autocommit() {
            let transaction = rusqlite::Transaction::new_unchecked(
                &self.db,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|e| {
                if is_sqlite_lock_error(&e) {
                    ImmediateTxError::Busy(e.to_string())
                } else {
                    ImmediateTxError::Other(e.to_string())
                }
            })?;
            let value = work().map_err(ImmediateTxError::Other)?;
            transaction
                .commit()
                .map_err(|e| ImmediateTxError::Other(e.to_string()))?;
            return Ok(value);
        }
        run_savepoint(&self.db, "pandacode_nested", work, |e| e.to_string())
            .map_err(ImmediateTxError::Other)
    }

    fn run_in_transaction<T>(&self, behavior: rusqlite::TransactionBehavior, work: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.db.is_autocommit() {
            let transaction = rusqlite::Transaction::new_unchecked(&self.db, behavior).map_err(|e| e.to_string())?;
            let value = work()?;
            transaction.commit().map_err(|e| e.to_string())?;
            return Ok(value);
        }
        run_savepoint(&self.db, "pandacode_nested", work, |e| e.to_string())
    }
}
