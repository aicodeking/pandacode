//! Small storage helpers kept out of `storage.rs`: the rollback detector, the newer-schema
//! recovery wrapper, the transaction runner, and path/subagent validation.
use rusqlite::Connection;
use std::path::PathBuf;

use super::{Result, Store, SCHEMA_VERSION};

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

/// Runs a startup recovery step that reads the version 38 trackers. At or below
/// `SCHEMA_VERSION` every error is fatal. On a newer schema (this binary is older) a future
/// migration may have dropped or renamed what the step reads, so its error is logged and the
/// step undone through a savepoint, unless SQLite rolled the whole recovery transaction back.
pub(super) fn tracked_recovery(recovery: &Connection, version: i64, step: &str, run: &dyn Fn(&Connection) -> Result<()>) -> Result<()> {
    if version <= SCHEMA_VERSION {
        return run(recovery);
    }
    let guard = RollbackGuard::new(recovery);
    match run_savepoint(recovery, "pandacode_newer_recovery", || run(recovery), |e| e.to_string()) {
        Ok(()) => Ok(()),
        Err(error) if guard.rolled_back() => Err(error),
        Err(error) => {
            eprintln!("Skipping startup recovery ({step}) on newer schema v{version}: {error}");
            Ok(())
        }
    }
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
