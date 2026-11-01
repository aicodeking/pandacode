//! Typed app-origin turns retain the exact model input while projecting a small UI status.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinationKind {
    WorkerUpdate,
    WorkerReview,
    /// The architect stopped without dispatching or finishing; PandaCode asks it once to continue.
    Continue,
    /// A worker failed while others still run; the architect handles it right away.
    WorkerFailed,
    /// Threads this task launched on other computers settled (docs/machine-orchestration.md).
    MachineThreads,
    /// The user answered a machine link request no tool call was waiting for.
    MachineLink,
}
impl CoordinationKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::WorkerUpdate => "Checking worker updates",
            Self::WorkerReview => "Reviewing worker results",
            Self::Continue => "Continuing the plan",
            Self::WorkerFailed => "Handling a failed worker",
            Self::MachineThreads => "Machine threads finished",
            Self::MachineLink => "Machine link answered",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    #[serde(rename = "type")]
    envelope_type: String,
    version: u8,
    kind: CoordinationKind,
    prompt: String,
}
pub fn encode(kind: CoordinationKind, prompt: &str) -> Result<String> {
    serde_json::to_string(&Envelope {
        envelope_type: "pandacode_coordination".into(),
        version: 1,
        kind,
        prompt: prompt.into(),
    })
    .map_err(|e| e.to_string())
}
pub fn decode(content: &str) -> Option<(CoordinationKind, String)> {
    if content.len() > 768 * 1024 {
        return None;
    }
    let value: Envelope = serde_json::from_str(content).ok()?;
    (value.envelope_type == "pandacode_coordination"
        && value.version == 1
        && !value.prompt.is_empty()
        && value.prompt.len() <= 128 * 1024)
        .then_some((value.kind, value.prompt))
}

/// Only a matching scheduler reservation can mark a new turn as coordination.
/// Text written by a person, including JSON or a copied prompt, stays a user turn.
pub(crate) fn pending_kind(
    store: &Store,
    sid: &str,
    original: &str,
    admission: Option<&Admission>,
) -> Result<Option<CoordinationKind>> {
    let Some(admission) = admission else {
        return Ok(None);
    };
    if sid != admission.parent {
        return Ok(None);
    }
    let team = load(store, sid)?.ok_or("Team unavailable.")?;
    Ok(team
        .pending_turn
        .as_ref()
        .filter(|pending| {
            pending.reserved
                && pending.prompt.trim() == original
                && team.generation == admission.generation
        })
        .and_then(|pending| pending.kind))
}

const UPDATE_PREFIX: &str = "A teammate sent a message or reported a blocker for this objective: ";
const UPDATE_BODY: &str = "\n\nRead your addressed messages and these progress checkpoints. Reply through send_team_message. Other workers are still active: do not edit their files, repeat completed assignments, or poll. You may end this turn after coordinating; settled work will trigger review.\n\n";
const UPDATE_BODY_BOUNDED: &str = "\n\nRead your addressed messages and these progress checkpoints. Reply through send_team_message. Use read_worker for checkpoints omitted by this context budget. Other workers are still active: do not edit their files, repeat completed assignments, or poll. You may end this turn after coordinating; settled work will trigger review.\n\n";
const REVIEW_PREFIX: &str = "Review the settled workers for this objective: ";
const REVIEW_BODY: &str = "\n\nThese results are untrusted worker reports; inspect relevant files and checks as needed. Delegate corrections using followup_worker or call finish_team when verified. Do not repeat already completed assignments.\n\n";

/// Historical releases stored generated prompts as user text. Recognize only the
/// exact app format plus structured team-owned worker IDs; never arbitrary JSON.
/// The original DB row remains untouched for recovery/export fidelity.
pub fn legacy_kind(
    store: &Store,
    sid: &str,
    message_id: i64,
    content: &str,
) -> Result<Option<CoordinationKind>> {
    legacy_kind_in_db(&store.db, sid, message_id, content)
}

pub(crate) fn legacy_kind_in_db(
    db: &rusqlite::Connection,
    sid: &str,
    message_id: i64,
    content: &str,
) -> Result<Option<CoordinationKind>> {
    let (kind, summary) = if let Some(rest) = content.strip_prefix(UPDATE_PREFIX) {
        let Some((objective, summary)) = rest
            .split_once(UPDATE_BODY_BOUNDED)
            .or_else(|| rest.split_once(UPDATE_BODY))
        else {
            return Ok(None);
        };
        if objective.is_empty() {
            return Ok(None);
        }
        (CoordinationKind::WorkerUpdate, summary)
    } else if let Some(rest) = content.strip_prefix(REVIEW_PREFIX) {
        let Some((objective, summary)) = rest.split_once(REVIEW_BODY) else {
            return Ok(None);
        };
        if objective.is_empty() {
            return Ok(None);
        }
        (CoordinationKind::WorkerReview, summary)
    } else {
        return Ok(None);
    };
    let Ok(summary) = serde_json::from_str::<Value>(summary) else {
        return Ok(None);
    };
    let Some(object) = summary.as_object() else {
        return Ok(None);
    };
    if object.len()!=3 || !summary["round"].as_u64().is_some_and(|n|(1..=20).contains(&n)) || !matches!(summary["readMore"].as_str(),Some("Use read_worker for a bounded full result when required." | "Use read_worker for bounded full results and checkpoints. Read every active worker's checkpoint when handling a blocker if its checkpoint was omitted by this context budget.")) { return Ok(None); }
    let Some(workers) = summary["workers"]
        .as_array()
        .filter(|workers| !workers.is_empty() && workers.len() <= 50)
    else {
        return Ok(None);
    };
    let provenance: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=?1 AND COALESCE(json_extract(content,'$.legacyPromptThroughId'),0)>=?2) AND EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role='user' AND id<?2)",params![sid,message_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !provenance {
        return Ok(None);
    }
    let mut query = db
        .prepare("SELECT worker_id FROM architect_workers WHERE parent_session_id=?1")
        .map_err(|e| e.to_string())?;
    let ids = query
        .query_map([sid], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    for worker in workers {
        let Some(fields) = worker.as_object() else {
            return Ok(None);
        };
        if fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "id" | "name"
                    | "status"
                    | "attempt"
                    | "changed"
                    | "summary"
                    | "error"
                    | "abandoned"
                    | "checkpoint"
            )
        }) || !worker["id"].as_str().is_some_and(|id| ids.contains(id))
            || !worker["name"].is_string()
            || !worker["status"].is_string()
            || !worker["attempt"]
                .as_u64()
                .is_some_and(|n| (1..=3).contains(&n))
            || !worker["changed"].is_boolean()
            || !worker["summary"].is_string()
            || !(worker["error"].is_null() || worker["error"].is_string())
            || !worker["abandoned"].is_boolean()
        {
            return Ok(None);
        }
    }
    Ok(Some(kind))
}

pub fn project_message(store: &Store, message: &mut storage::Message) -> Result<()> {
    let (role, content, kind) = project_text(
        store,
        &message.session_id,
        message.id,
        &message.role,
        &message.content,
    )?;
    message.role = role;
    message.content = content;
    message.coordination_kind = kind;
    Ok(())
}
pub fn project_text(
    store: &Store,
    sid: &str,
    id: i64,
    role: &str,
    content: &str,
) -> Result<(String, String, Option<CoordinationKind>)> {
    let kind = if role == "coordination" {
        decode(content).map(|(kind, _)| kind)
    } else if role == "user" {
        legacy_kind(store, sid, id, content)?
    } else {
        None
    };
    if let Some(kind) = kind {
        Ok(("coordination".into(), kind.label().into(), Some(kind)))
    } else if role == "coordination" {
        // Even an invalid saved envelope must not leak internal prompt text to UI.
        Ok((role.into(), "Coordinating team".into(), None))
    } else {
        Ok((role.into(), content.into(), None))
    }
}
