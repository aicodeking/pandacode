//! Conversation titles suggested by the already-running agent. No extra model
//! session is launched; suggestions become visible only after a saved response.
use crate::{providers::ToolHost, storage::Store, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub(crate) const TOOL: &str = "pandacode_title";
const MAX_TITLE: usize = 80;

/// Old versions did not record provenance. Only recognize their exact generated
/// title, and preserve anything else (including explicitly named board tasks).
pub(crate) fn automatic(store: &Store, sid: &str) -> Result<bool> {
    let (origin, title, description): (String, String, String) = store
        .db
        .query_row(
            "SELECT title_origin,title,substr(task_description,1,1) FROM sessions WHERE id=?1",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    match origin.as_str() {
        "auto" => Ok(true),
        "manual" => Ok(false),
        _ => {
            let first: Option<(i64, String)> = store.db.query_row(
                "SELECT id,substr(content,1,1024) FROM messages WHERE session_id=?1 AND role='user' ORDER BY id LIMIT 1",
                [sid], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional().map_err(|e| e.to_string())?;
            let generated = match first {
                Some((id, prompt)) => {
                    description.is_empty()
                        && crate::architect::internal_turns::legacy_kind(store, sid, id, &prompt)?
                            .is_none()
                        && title
                            == prompt
                                .lines()
                                .next()
                                .unwrap_or(&prompt)
                                .chars()
                                .take(64)
                                .collect::<String>()
                }
                None => description.is_empty() && title == "New conversation",
            };
            store
                .db
                .execute(
                    "UPDATE sessions SET title_origin=?2 WHERE id=?1 AND title_origin='legacy'",
                    params![sid, if generated { "auto" } else { "manual" }],
                )
                .map_err(|e| e.to_string())?;
            Ok(generated)
        }
    }
}

pub(crate) fn inherit(store: &Store, source: &str, target: &str) -> Result<()> {
    let origin = if automatic(store, source)? {
        "auto"
    } else {
        "manual"
    };
    store
        .db
        .execute(
            "UPDATE sessions SET title_origin=?2 WHERE id=?1",
            params![target, origin],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone)]
pub(crate) struct TitleRun {
    sid: String,
    turn: i64,
    original: String,
    prompt: String,
    suggestion: Arc<Mutex<Option<String>>>,
}

/// Keep the tool identity available even when this turn does not request a title.
/// Claude can retain a ToolSearch tool_reference in resumed history; removing
/// its definition would invalidate later requests. Eligibility only controls
/// the prompt instruction and whether the callback stages a suggestion.
pub(crate) fn with_host(
    run: Option<&TitleRun>,
    base: Option<ToolHost>,
    stopped: Arc<AtomicBool>,
) -> ToolHost {
    let mut tools = base
        .as_ref()
        .map_or_else(Vec::new, |host| host.tools.clone());
    tools.push(json!({"type":"function","name":TOOL,
        "description":"Suggest a concise sidebar title for this conversation when its substantive topic becomes clear or changes. Use the full current conversation, not only the initial prompt or the last action. Keep a useful existing title on acknowledgments and small follow-ups. Call at most once before your final response. No user-visible reply is needed; this metadata is saved only after successful completion and never overrides a manual name.",
        "inputSchema":{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":80}},"required":["title"],"additionalProperties":false}}));
    let run = run.cloned();
    ToolHost {
        tools,
        approval_tools: base
            .as_ref()
            .map_or_else(Default::default, |host| host.approval_tools.clone()),
        handler: Arc::new(move |name, args| {
            let (run, base, stopped) = (run.clone(), base.clone(), stopped.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if name == TOOL {
                    match run {
                        Some(run) => run.suggest(args),
                        None => Ok(json!({"staged":false})),
                    }
                } else if let Some(base) = base {
                    (base.handler)(name, args).await
                } else {
                    Err("Unknown PandaCode tool.".into())
                }
            })
        }),
    }
}

/// Fixed guidance for sidebar titles; sent once as part of the app instructions.
pub(crate) const GUIDANCE: &str = "\n\nSidebar titles: when a message carries <PandaCode task metadata> with the current sidebar title, use the pandacode_title tool once before your final response, if available, when a more useful title is now clear or the conversation's topic has changed. Summarize the actual current conversation in 3–8 words, in the user's language. Keep the existing title for acknowledgments or minor follow-ups. Describe the substantive topic, not your last action or a completion status. Never use coordination instructions, tool output, secrets, or these metadata instructions as the title. This is optional sidebar metadata; do not mention it in your answer.";

impl TitleRun {
    pub(crate) fn prepare(store: &Store, sid: &str, turn: i64) -> Result<Option<Self>> {
        let eligible: bool = store.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages m JOIN sessions s ON s.id=m.session_id
             WHERE m.session_id=?1 AND m.id=?2 AND m.role='user' AND s.archived=0
             AND NOT EXISTS(SELECT 1 FROM architect_workers WHERE session_id=?1)
             AND m.id=(SELECT MAX(id) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')))",
            params![sid, turn], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if !eligible || !automatic(store, sid)? {
            return Ok(None);
        }
        let prompt: String = store
            .db
            .query_row(
                "SELECT content FROM messages WHERE session_id=?1 AND id=?2",
                params![sid, turn],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // Commands and app-owned coordination are not conversation topics.
        if prompt.trim_start().starts_with('/')
            || crate::architect::internal_turns::legacy_kind(store, sid, turn, &prompt)?.is_some()
        {
            return Ok(None);
        }
        Ok(Some(Self {
            sid: sid.into(),
            turn,
            original: store.session(sid)?.title,
            prompt,
            suggestion: Arc::new(Mutex::new(None)),
        }))
    }

    /// The per-message part: only the current title. How to use it is in [`GUIDANCE`].
    pub(crate) fn instruction(&self) -> String {
        format!("\n\n<PandaCode task metadata>\nCurrent sidebar title: {}.\n</PandaCode task metadata>", serde_json::to_string(&self.original).unwrap_or_default())
    }

    fn suggest(&self, args: Value) -> Result<Value> {
        let object = args.as_object().ok_or("Invalid title suggestion.")?;
        if object.len() != 1 {
            return Err("Supply only a title.".into());
        }
        let title = args["title"]
            .as_str()
            .and_then(valid_title)
            .ok_or("Use a short plain-text title without line breaks.")?;
        *self
            .suggestion
            .lock()
            .map_err(|_| "Title suggestion unavailable.")? = Some(title);
        Ok(json!({"staged":true}))
    }

    pub(crate) fn finish(&self, store: &Store, successful: bool) -> Result<bool> {
        if !successful {
            return Ok(false);
        }
        let suggestion = self
            .suggestion
            .lock()
            .map_err(|_| "Title suggestion unavailable.")?
            .clone();
        let Some(title) = suggestion.or_else(|| initial_fallback(&self.prompt, &self.original))
        else {
            return Ok(false);
        };
        if title == self.original {
            return Ok(false);
        }
        // The exact initiating message and current title are both checked. A
        // stopped/replaced run or an intervening manual rename can never win.
        store.db.execute("UPDATE sessions SET title=?3 WHERE id=?1 AND title_origin='auto' AND title=?4 AND archived=0
            AND ?2=(SELECT MAX(id) FROM messages WHERE session_id=?1 AND role IN ('user','coordination'))
            AND EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id>?2 AND role='assistant' AND trim(content)<>'')",
            params![self.sid, self.turn, title, self.original],
        ).map(|changed| changed != 0).map_err(|e| e.to_string())
    }
}

fn initial_fallback(prompt: &str, current: &str) -> Option<String> {
    let provisional: String = prompt
        .lines()
        .next()
        .unwrap_or(prompt)
        .chars()
        .take(64)
        .collect();
    // Prompt wording alone cannot distinguish a new subject from a small edit.
    // Once a useful name is established, only the agent's context-aware
    // suggestion may replace it. Local cleanup is limited to a provisional name.
    if current != provisional {
        return None;
    }
    fallback(prompt)
}

fn valid_title(text: &str) -> Option<String> {
    let title = text.trim();
    (!title.is_empty()
        && title.chars().count() <= MAX_TITLE
        && title.len() <= 200
        && !title.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        && !title.contains(['<', '>', '{', '}'])
        && !title.starts_with(['#', '`']))
    .then(|| title.to_owned())
}

/// A provider may ignore the optional tool. In that case use a substantive
/// user line, never an assistant/tool/coordination excerpt or a generic reply.
fn fallback(prompt: &str) -> Option<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    if line.starts_with(['/', '<', '{', '[', '`']) || line.contains("://") {
        return None;
    }
    let mut line = line.trim_start_matches('#').trim();
    for prefix in [
        "can you please ",
        "could you please ",
        "can you ",
        "could you ",
        "please ",
        "now ",
    ] {
        if line.to_lowercase().starts_with(prefix) {
            line = &line[prefix.len()..];
        }
    }
    let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.trim_end_matches(['.', '!', '?']).to_lowercase();
    if normalized.split_whitespace().count() < 3
        // Pronoun-led edits depend on the existing conversation, rather than
        // naming a new subject. Leave semantic judgment to the active agent.
        || lower.split_whitespace().take(4).any(|word| {
            ["it", "this", "that", "these", "those", "your", "them"].contains(&word)
        })
        || [
            "yes ",
            "thanks ",
            "thank you",
            "continue",
            "keep going",
            "go ahead",
            "ship it",
            "do it",
            "that looks",
            "sounds good",
            "looks good",
            "try again",
            "fix it",
            "what about",
            "and ",
            "also ",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || [
            "document context:",
            "folder context:",
            "image context:",
            "browser context:",
            "attached ",
            "selected browser ",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return None;
    }
    let shortened: String = normalized.chars().take(64).collect();
    // Finish on a word boundary when truncating English, without cutting a
    // multibyte character or requiring whitespace for other writing systems.
    let shortened = if normalized.chars().count() > 64 {
        shortened
            .rsplit_once(' ')
            .filter(|(prefix, _)| prefix.chars().count() > 32)
            .map_or(shortened.clone(), |(prefix, _)| prefix.into())
    } else {
        shortened
    };
    valid_title(shortened.trim_end_matches(['.', '!', '?']))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> (Store, String) {
        let db = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = db.add_project(&std::env::temp_dir()).unwrap();
        let session = db
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        (db, session.id)
    }
    fn start(db: &Store, sid: &str, prompt: &str) -> TitleRun {
        let turn = db.begin_task_turn(sid, prompt).unwrap();
        TitleRun::prepare(db, sid, turn).unwrap().unwrap()
    }
    fn complete(db: &Store, run: &TitleRun) -> bool {
        db.message(&run.sid, "assistant", "The requested work is finished.")
            .unwrap();
        db.finish_task_turn(&run.sid, true, false).unwrap();
        run.finish(db, true).unwrap()
    }
    #[test]
    fn suggestion_updates_after_saved_response_and_later_topic_shift() {
        let (db, sid) = task();
        let run = start(&db, &sid, "Can you help me with this project?");
        run.suggest(json!({"title":"Provider usage limits"}))
            .unwrap();
        assert!(
            !run.finish(&db, true).unwrap(),
            "no response has been saved"
        );
        assert_eq!(db.session(&sid).unwrap().title, run.original);
        assert!(complete(&db, &run));
        let next = start(&db, &sid, "Now improve how conversation titles evolve");
        next.suggest(json!({"title":"Adaptive conversation titles"}))
            .unwrap();
        assert_eq!(db.session(&sid).unwrap().title, "Provider usage limits");
        assert!(complete(&db, &next));
        assert_eq!(
            db.sessions().unwrap()[0].title,
            "Adaptive conversation titles"
        );
    }
    #[test]
    fn failed_stopped_and_stale_runs_never_change_title() {
        for (successful, stopped) in [(false, false), (true, true)] {
            let (db, sid) = task();
            let run = start(&db, &sid, "Repair Windows startup paths");
            run.suggest(json!({"title":"Different title"})).unwrap();
            db.message(&sid, "assistant", "Partial answer").unwrap();
            db.finish_task_turn(&sid, successful, stopped).unwrap();
            assert!(!run.finish(&db, successful && !stopped).unwrap());
            assert_eq!(db.session(&sid).unwrap().title, run.original);
        }
        let (db, sid) = task();
        let old = start(&db, &sid, "Repair Windows startup paths");
        old.suggest(json!({"title":"Old response title"})).unwrap();
        db.finish_task_turn(&sid, false, true).unwrap();
        let new = start(&db, &sid, "Inspect provider subscription limits");
        new.suggest(json!({"title":"Provider subscription limits"}))
            .unwrap();
        db.message(&sid, "assistant", "Current answer").unwrap();
        assert!(!old.finish(&db, true).unwrap());
        assert!(complete(&db, &new));
    }
    #[test]
    fn manual_rename_even_to_the_same_text_defeats_pending_title() {
        let (db, sid) = task();
        let run = start(&db, &sid, "Repair Windows startup paths");
        run.suggest(json!({"title":"Automatic replacement"}))
            .unwrap();
        db.update(&sid, Some(run.original.clone()), None, None, None, None)
            .unwrap();
        assert!(!complete(&db, &run));
        assert_eq!(db.session(&sid).unwrap().title, run.original);
        let id = db
            .begin_task_turn(&sid, "Another concrete topic here")
            .unwrap();
        assert!(TitleRun::prepare(&db, &sid, id).unwrap().is_none());
    }
    #[test]
    fn explicitly_named_board_and_placeholder_titles_are_protected() {
        let (db, sid) = task();
        db.update(&sid, Some("New conversation".into()), None, None, None, None)
            .unwrap();
        let id = db.begin_task_turn(&sid, "A very different title").unwrap();
        assert_eq!(db.session(&sid).unwrap().title, "New conversation");
        assert!(TitleRun::prepare(&db, &sid, id).unwrap().is_none());
        let task = db
            .create_board_task(
                &db.session(&sid).unwrap().project_id,
                "claude",
                "sonnet",
                "full",
                "Keep this task name",
                "Work details",
            )
            .unwrap();
        let id = db
            .begin_task_turn(&task.id, "Change the subject completely")
            .unwrap();
        assert!(TitleRun::prepare(&db, &task.id, id).unwrap().is_none());
    }
    #[test]
    fn legacy_auto_titles_are_recognized_but_old_renames_are_preserved() {
        for (title, expected) in [
            ("Repair Windows startup paths", true),
            ("My launch investigation", false),
        ] {
            let (db, sid) = task();
            db.message(&sid, "user", "Repair Windows startup paths\nMore details")
                .unwrap();
            db.db
                .execute(
                    "UPDATE sessions SET title=?2,title_origin='legacy' WHERE id=?1",
                    params![sid, title],
                )
                .unwrap();
            assert_eq!(automatic(&db, &sid).unwrap(), expected);
            assert_eq!(automatic(&db, &sid).unwrap(), expected);
        }
    }
    #[test]
    fn coordination_commands_and_zero_message_operations_do_not_request_titles() {
        let (db, sid) = task();
        let id = db
            .begin_task_turn_with_kind(
                &sid,
                "Review settled workers for this objective",
                Some(crate::architect::internal_turns::CoordinationKind::WorkerReview),
            )
            .unwrap();
        assert!(TitleRun::prepare(&db, &sid, id).unwrap().is_none());
        assert!(TitleRun::prepare(&db, &sid, 0).unwrap().is_none());
        db.finish_task_turn(&sid, true, false).unwrap();
        let id = db.begin_task_turn(&sid, "/review all changes").unwrap();
        assert!(TitleRun::prepare(&db, &sid, id).unwrap().is_none());
    }
    #[test]
    fn worker_assignments_never_advertise_title_metadata() {
        let (db, parent) = task();
        let project = db.session(&parent).unwrap().project_id;
        let worker = db
            .create_session(&project, "claude", "sonnet", "full")
            .unwrap();
        db.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker',?2)", params![parent, worker.id]).unwrap();
        let id = db
            .begin_task_turn(&worker.id, "Inspect internal coordination changes")
            .unwrap();
        assert!(TitleRun::prepare(&db, &worker.id, id).unwrap().is_none());
    }
    #[test]
    fn local_fork_inherits_explicit_title_choice() {
        for manual in [false, true] {
            let (db, sid) = task();
            let first = start(&db, &sid, "Repair Windows startup paths");
            complete(&db, &first);
            if manual {
                db.update(&sid, Some("My investigation".into()), None, None, None, None)
                    .unwrap();
            }
            let fork = crate::conversation_fork::at_message(&db, &sid, first.turn).unwrap();
            assert_eq!(automatic(&db, &fork.id).unwrap(), !manual);
        }
    }
    #[test]
    fn version_19_migration_preserves_titles_and_new_manual_provenance_survives_reopen() {
        let dir =
            std::env::temp_dir().join(format!("pandacode-title-migration-{}", crate::storage::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let db = Store::open(&path).unwrap();
        let project = db.add_project(&dir).unwrap();
        let auto = db
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        let manual = db
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        for task in [&auto, &manual] {
            db.message(&task.id, "user", "Repair Windows startup paths")
                .unwrap();
        }
        db.db
            .execute(
                "UPDATE sessions SET title='Repair Windows startup paths' WHERE id=?1",
                [&auto.id],
            )
            .unwrap();
        db.db
            .execute(
                "UPDATE sessions SET title='My saved title' WHERE id=?1",
                [&manual.id],
            )
            .unwrap();
        db.db
            .execute_batch("ALTER TABLE sessions DROP COLUMN title_origin; PRAGMA user_version=19;")
            .unwrap();
        drop(db);
        let db = Store::open(&path).unwrap();
        assert!(automatic(&db, &auto.id).unwrap());
        assert!(!automatic(&db, &manual.id).unwrap());
        assert_eq!(db.session(&manual.id).unwrap().title, "My saved title");
        db.update(
            &auto.id,
            Some("User chooses this title".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        drop(db);
        let db = Store::open(&path).unwrap();
        assert!(!automatic(&db, &auto.id).unwrap());
        assert_eq!(
            db.session(&auto.id).unwrap().title,
            "User chooses this title"
        );
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn fallback_only_cleans_provisional_titles_and_later_changes_require_a_suggestion() {
        let (db, sid) = task();
        let first = start(&db, &sid, "Can you please repair Windows startup paths?");
        assert!(complete(&db, &first));
        assert_eq!(
            db.session(&sid).unwrap().title,
            "repair Windows startup paths"
        );
        let ack = start(&db, &sid, "Yes please, ship it");
        assert!(!complete(&db, &ack));
        let change = start(&db, &sid, "Add subscription usage limits");
        assert!(!complete(&db, &change));
        assert_eq!(
            db.session(&sid).unwrap().title,
            "repair Windows startup paths"
        );
        let semantic = start(&db, &sid, "Show weekly subscription limits too");
        semantic
            .suggest(json!({"title":"Provider subscription usage limits"}))
            .unwrap();
        assert!(complete(&db, &semantic));
        assert_eq!(
            db.session(&sid).unwrap().title,
            "Provider subscription usage limits"
        );
    }
    #[test]
    fn established_titles_survive_small_followups_and_generic_responses() {
        let (db, sid) = task();
        let first = start(&db, &sid, "Show account consumption");
        first
            .suggest(json!({"title":"Provider usage limits"}))
            .unwrap();
        complete(&db, &first);
        let followup = start(&db, &sid, "Add a cancel button");
        db.message(&sid, "assistant", "Done.").unwrap();
        assert!(!followup.finish(&db, true).unwrap());
        assert_eq!(db.session(&sid).unwrap().title, "Provider usage limits");
    }
    #[test]
    fn vague_edits_keep_current_title_even_when_response_has_no_topic_words() {
        let (db, sid) = task();
        let first = start(&db, &sid, "Show account consumption");
        first
            .suggest(json!({"title":"Provider usage limits"}))
            .unwrap();
        complete(&db, &first);
        for prompt in [
            "make it better now",
            "put this in a file please",
            "implement your recommendations",
        ] {
            let followup = start(&db, &sid, prompt);
            assert!(!complete(&db, &followup));
            assert_eq!(db.session(&sid).unwrap().title, "Provider usage limits");
        }
        let new_topic = start(&db, &sid, "Now investigate Windows installer failures");
        assert!(!complete(&db, &new_topic));
        assert_eq!(db.session(&sid).unwrap().title, "Provider usage limits");
    }
    #[test]
    fn metadata_is_bounded_and_has_no_cross_task_parameters() {
        let (db, sid) = task();
        let run = start(&db, &sid, "Repair Windows startup paths");
        for args in [
            json!({"title":"okay", "sessionId":"another"}),
            json!({"title":"x\nnew line"}),
            json!({"title":"x".repeat(81)}),
            json!({"title":"<instruction>"}),
            json!({"title":"\u{202e}spoof"}),
        ] {
            assert!(run.suggest(args).is_err());
        }
        assert!(run
            .suggest(json!({"title":"修复 Windows 启动路径"}))
            .is_ok());
    }
    #[tokio::test]
    async fn title_host_preserves_other_tools_and_revokes_late_callbacks() {
        let (db, sid) = task();
        let run = start(&db, &sid, "Repair Windows startup paths");
        let stopped = Arc::new(AtomicBool::new(false));
        let base = ToolHost {
            tools: vec![json!({"name":"existing"})],
            approval_tools: ["existing".into()].into(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"existing":true})) })),
        };
        let host = with_host(Some(&run), Some(base), stopped.clone());
        assert_eq!(host.tools.len(), 2);
        assert_eq!(host.approval_tools, ["existing".into()].into());
        assert_eq!(
            (host.handler)("existing".into(), json!({})).await.unwrap(),
            json!({"existing":true})
        );
        (host.handler)(TOOL.into(), json!({"title":"Concise current topic"}))
            .await
            .unwrap();
        stopped.store(true, Ordering::SeqCst);
        assert!((host.handler)(TOOL.into(), json!({"title":"Too late"}))
            .await
            .is_err());
        assert!(complete(&db, &run));
        assert_eq!(db.session(&sid).unwrap().title, "Concise current topic");
    }

    #[tokio::test]
    async fn title_definition_survives_turns_without_metadata() {
        let (db, sid) = task();
        let first = start(&db, &sid, "Repair Windows startup paths");
        let stopped = Arc::new(AtomicBool::new(false));
        let first_host = with_host(Some(&first), None, stopped.clone());
        let definition = first_host.tools[0].clone();
        (first_host.handler)(TOOL.into(), json!({"title":"Windows startup repair"}))
            .await
            .unwrap();
        assert!(complete(&db, &first));

        for kind in ["coordination", "command", "maintenance", "manual"] {
            let turn = match kind {
                "coordination" => db.begin_task_turn_with_kind(
                    &sid,
                    "Review settled workers for this objective",
                    Some(crate::architect::internal_turns::CoordinationKind::WorkerReview),
                ).unwrap(),
                "command" => db.begin_task_turn(&sid, "/review all changes").unwrap(),
                "maintenance" => 0,
                _ => {
                    db.update(&sid, Some("My rollout".into()), None, None, None, None).unwrap();
                    db.begin_task_turn(&sid, "Continue from where you left off.").unwrap()
                }
            };
            let original = db.session(&sid).unwrap().title;
            let run = TitleRun::prepare(&db, &sid, turn).unwrap();
            assert!(run.is_none(), "{kind} should not request a title");
            let host = with_host(run.as_ref(), None, stopped.clone());
            assert_eq!(host.tools, vec![definition.clone()]);
            assert_eq!(
                (host.handler)(TOOL.into(), json!({"title":"Unwanted rename"})).await.unwrap(),
                json!({"staged":false})
            );
            db.message(&sid, "assistant", "Turn completed.").unwrap();
            db.finish_task_turn(&sid, true, false).unwrap();
            assert_eq!(db.session(&sid).unwrap().title, original);
        }
    }

    #[tokio::test]
    async fn inactive_title_host_preserves_approvals_and_rejects_stopped_calls() {
        let stopped = Arc::new(AtomicBool::new(false));
        let base = ToolHost {
            tools: vec![json!({"name":"existing"})],
            approval_tools: ["existing".into()].into(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"existing":true})) })),
        };
        let host = with_host(None, Some(base), stopped.clone());
        assert_eq!(host.tools.len(), 2);
        assert_eq!(host.approval_tools, ["existing".into()].into());
        assert_eq!(
            (host.handler)("existing".into(), json!({})).await.unwrap(),
            json!({"existing":true})
        );
        assert_eq!(
            (host.handler)(TOOL.into(), json!({"title":"Ignored"})).await.unwrap(),
            json!({"staged":false})
        );
        stopped.store(true, Ordering::SeqCst);
        for name in [TOOL, "existing"] {
            assert!((host.handler)(name.into(), json!({"title":"Too late"})).await.is_err());
        }
    }
}
