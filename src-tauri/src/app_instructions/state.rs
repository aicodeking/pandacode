//! What each task's conversation has already been told: the role its instructions last went out
//! for, instructions a slash-command turn held back, and how far its compactions were read. Kept per task in `session_state`, so it
//! survives an app restart (a missing or corrupt file behaves as a fresh process did).
use super::Role;
use crate::providers::{COMPACTED_OUTPUT, COMPACT_CONTEXT_TOOL};
use crate::session_state::{self, CompactionScan};
use crate::storage::Store;

/// Whether `role` differs from the one this task's instructions last went out for (or none
/// did). Harnesses without a system prompt re-send a worker's instructions only then, on a new
/// conversation and on reminder turns. Nothing is recorded here: `instructed_as` records the role
/// once a run carrying the instructions ended cleanly, so a turn that failed or was stopped says
/// them again.
pub(crate) fn instructions_due(session_id: &str, role: Role) -> bool {
    session_state::get(session_id, |task| task.and_then(|task| task.instructed)) != Some(role)
}

/// Records that this task's instructions went out for `role` (its run ended cleanly). Any
/// instructions owed by a slash-command turn went out with it (`owed` forces them).
pub(crate) fn instructed_as(session_id: &str, role: Role) {
    session_state::update(session_id, |task| {
        task.instructed = Some(role);
        task.owed = false;
    });
}

/// A new conversation's first message was a slash command, which must reach the harness bare:
/// its full instructions are owed to the next message instead.
pub(super) fn owe_instructions(session_id: &str) {
    session_state::update(session_id, |task| task.owed = true);
}

/// Whether a slash-command turn held back this task's full instructions.
pub(super) fn instructions_owed(session_id: &str) -> bool {
    session_state::get(session_id, |task| task.is_some_and(|task| task.owed))
}

/// The newest compaction the harness reported (a `COMPACT_CONTEXT_TOOL` row, matched by the
/// row's own top-level name and output, as `StoredToolActivity` flattens them) that the
/// instructions were not resent after, if any. A failed read counts as none: the periodic
/// reminder still goes out. Each turn reads only the rows added since the last one (a task with
/// no record reads them all); a launch comes after the previous run's rows are final, so a row
/// already read never turns into a compaction.
pub(crate) fn new_compaction(store: &Store, session_id: &str) -> Option<i64> {
    let scan = session_state::get(session_id, |task| task.and_then(|task| task.compaction)).unwrap_or_default();
    let (scanned, found) = match compactions_after(store, session_id, scan.scanned) {
        Ok(read) => read,
        Err(error) => {
            eprintln!("PandaCode: could not read compactions for {session_id}: {error}");
            return None;
        }
    };
    let next = CompactionScan { scanned: scanned.unwrap_or(scan.scanned), newest: found.unwrap_or(scan.newest), ..scan };
    if next != scan {
        session_state::update(session_id, |task| task.compaction = Some(next));
    }
    (next.newest > next.answered).then_some(next.newest)
}

/// The newest tool row after message `after` in this conversation and the newest compaction
/// among them. A compaction is a `COMPACT_CONTEXT_TOOL` row matched by the row's own top-level
/// name and output, never its text: an agent reading PandaCode's source can print both strings
/// in another tool's output. Shared with the team brief (`architect::coordination::compacted`).
pub(crate) fn compactions_after(store: &Store, session_id: &str, after: i64) -> rusqlite::Result<(Option<i64>, Option<i64>)> {
    store.db.query_row(
        "SELECT MAX(id), MAX(CASE WHEN CASE WHEN json_valid(content) THEN json_extract(content,'$.name')=?3 AND json_extract(content,'$.output')=?4 ELSE 0 END THEN id END) FROM messages WHERE session_id=?1 AND id>?2 AND role='tool'",
        rusqlite::params![session_id, after, COMPACT_CONTEXT_TOOL, COMPACTED_OUTPUT],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

/// Records that a run carrying the full instructions after `compaction` ended cleanly. A failed
/// or stopped run records nothing, even if the model read the message: the next turn says them
/// again, which costs a resend and never loses them.
pub(crate) fn compaction_answered(session_id: &str, compaction: i64) {
    session_state::update(session_id, |task| task.compaction.get_or_insert_with(CompactionScan::default).answered = compaction);
}

/// Forgets deleted tasks: their instructed role, the tools their conversations held and their note counters, in memory and on disk.
pub(crate) fn forget(session_ids: &[String]) {
    session_state::clear(session_ids, |task| {
        task.instructed = None;
        task.owed = false;
        task.compaction = None;
    });
    super::catalog::forget(session_ids);
}

#[cfg(test)]
mod tests {
    use super::super::{bare_command, instruct_launch, Instructed, LaunchText, Role};
    use super::*;
    use crate::providers::RunConfig;
    use crate::turn_changes;
    use std::sync::Mutex;

    #[test]
    fn slash_command_turns_carry_no_message_notes_and_owe_a_new_conversations_instructions() {
        assert!(!bare_command(false, false) && bare_command(true, false) && bare_command(false, true) && bare_command(true, true));
        let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
        let launch = |provider: &str, resume: Option<&str>, maintenance: bool, command: bool| {
            let session = format!("bare-{}", uuid::Uuid::new_v4());
            let mut config = RunConfig { session_id: session.clone(), prompt: "/foo".into(), resume_id: resume.map(str::to_owned), ..crate::providers::tests::config(provider) };
            let instructed = instruct_launch(&store, &mut config, LaunchText { role: Role::Task, explore: None, offered: false, maintenance: bare_command(maintenance, command) });
            let owed = instructions_owed(&session);
            forget(std::slice::from_ref(&session));
            (config, instructed, owed)
        };
        // GLM in Standard mode gets the tracking note on an ordinary turn, never on a command.
        assert!(launch("glm", Some("conv"), false, false).0.prompt.ends_with(turn_changes::turn_note(true).unwrap()));
        let (command, instructed, owed) = launch("glm", Some("conv"), false, true);
        assert_eq!((command.prompt.as_str(), instructed, owed), ("/foo", Instructed::default(), false));
        assert!(!command.instructions.is_empty(), "the system prompt stays");
        // A harness without a system prompt owes a new conversation's instructions to its next turn.
        let (command, instructed, owed) = launch("codex", None, false, true);
        assert_eq!((command.prompt.as_str(), instructed, owed), ("/foo", Instructed::default(), true));
        assert!(!launch("codex", Some("thread"), false, true).2, "a resumed one owes nothing");
    }
}
