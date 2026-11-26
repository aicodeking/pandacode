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
    LegacyScan::new(db, sid).kind(message_id, content)
}

/// `legacy_kind` for many rows of one session, as a fork copying a transcript does. The
/// session facts it checks (the team's legacy cutoff, the first user row and the team's
/// worker IDs) are read at most once, and only when a row's text is an exact legacy prompt,
/// so an ordinary transcript costs no query at all. Results match `legacy_kind` row for row
/// as long as the session's messages and team are not changed during the scan.
pub(crate) struct LegacyScan<'a> {
    db: &'a rusqlite::Connection,
    sid: &'a str,
    provenance: Option<LegacyProvenance>,
    workers: Option<HashSet<String>>,
}

struct LegacyProvenance {
    /// `COALESCE(json_extract(content,'$.legacyPromptThroughId'),0)` of the session's team;
    /// `Null` when the session has no team.
    cutoff: LegacyCutoff,
    /// The session's first `user` row.
    first_user: Option<i64>,
}

/// The team's legacy cutoff by SQLite storage class. Text and blob values are never read:
/// `json_extract` of an escaped lone surrogate (`"\uD800"`) yields TEXT that is not valid
/// UTF-8, and only the class matters for the comparison.
#[derive(Debug, Clone, Copy, PartialEq)]
enum LegacyCutoff {
    Null,
    Integer(i64),
    Real(f64),
    TextOrBlob,
}

const LEGACY_CUTOFF_SQL: &str = "SELECT typeof(v), CASE WHEN typeof(v) IN ('integer','real') THEN v END FROM (SELECT COALESCE(json_extract(content,'$.legacyPromptThroughId'),0) AS v FROM architect_teams WHERE session_id=?1)";

fn legacy_cutoff(db: &rusqlite::Connection, sid: &str) -> rusqlite::Result<LegacyCutoff> {
    use rusqlite::OptionalExtension;
    let cutoff = db
        .prepare_cached(LEGACY_CUTOFF_SQL)?
        .query_row([sid], |r| {
            Ok(match r.get::<_, String>(0)?.as_str() {
                "integer" => LegacyCutoff::Integer(r.get(1)?),
                "real" => LegacyCutoff::Real(r.get(1)?),
                "text" | "blob" => LegacyCutoff::TextOrBlob,
                _ => LegacyCutoff::Null,
            })
        })
        .optional()?;
    Ok(cutoff.unwrap_or(LegacyCutoff::Null))
}

impl LegacyProvenance {
    /// The per-row `EXISTS(team cutoff >= id) AND EXISTS(user row with id < id)` check, with
    /// SQLite's comparison rules (any text or blob sorts above every number).
    fn covers(&self, message_id: i64) -> bool {
        let cutoff = match self.cutoff {
            LegacyCutoff::Null => false,
            LegacyCutoff::Integer(cutoff) => cutoff >= message_id,
            LegacyCutoff::Real(cutoff) => f64_ge_i64(cutoff, message_id),
            LegacyCutoff::TextOrBlob => true,
        };
        cutoff && self.first_user.is_some_and(|first| first < message_id)
    }
}

fn f64_ge_i64(cutoff: f64, id: i64) -> bool {
    if cutoff.is_nan() || cutoff < i64::MIN as f64 {
        return false;
    }
    if cutoff >= 9_223_372_036_854_775_808.0 {
        return true;
    }
    // Within these bounds the floor fits exactly in i64, even above 2^53.
    (cutoff.floor() as i64) >= id
}

impl<'a> LegacyScan<'a> {
    pub(crate) fn new(db: &'a rusqlite::Connection, sid: &'a str) -> Self {
        Self { db, sid, provenance: None, workers: None }
    }

    pub(crate) fn kind(&mut self, message_id: i64, content: &str) -> Result<Option<CoordinationKind>> {
        let Some((kind, summary)) = legacy_prompt(content) else {
            return Ok(None);
        };
        let Some(workers) = summary["workers"]
            .as_array()
            .filter(|workers| !workers.is_empty())
        else {
            return Ok(None);
        };
        if !self.provenance()?.covers(message_id) {
            return Ok(None);
        }
        let ids = self.workers()?;
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
                        | "summaryTruncated"
                )
            }) || !worker["id"].as_str().is_some_and(|id| ids.contains(id))
                || !worker["name"].is_string()
                || !worker["status"].is_string()
                || worker["attempt"].as_u64().is_none_or(|n| n < 1)
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

    fn provenance(&mut self) -> Result<&LegacyProvenance> {
        if self.provenance.is_none() {
            let cutoff = legacy_cutoff(self.db, self.sid).map_err(|e| e.to_string())?;
            let first_user = self
                .db
                .prepare_cached("SELECT MIN(id) FROM messages WHERE session_id=?1 AND role='user'")
                .and_then(|mut query| query.query_row([self.sid], |r| r.get(0)))
                .map_err(|e| e.to_string())?;
            let provenance = LegacyProvenance { cutoff, first_user };
            self.provenance = Some(provenance);
        }
        Ok(self.provenance.as_ref().expect("provenance was just read"))
    }

    fn workers(&mut self) -> Result<&HashSet<String>> {
        if self.workers.is_none() {
            let mut query = self
                .db
                .prepare_cached("SELECT worker_id FROM architect_workers WHERE parent_session_id=?1")
                .map_err(|e| e.to_string())?;
            let ids = query
                .query_map([self.sid], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<HashSet<_>, _>>()
                .map_err(|e| e.to_string())?;
            self.workers = Some(ids);
        }
        Ok(self.workers.as_ref().expect("worker IDs were just read"))
    }
}

/// The text-only half of `legacy_kind`: the exact app prompt format and summary shape.
fn legacy_prompt(content: &str) -> Option<(CoordinationKind, Value)> {
    let (kind, summary) = if let Some(rest) = content.strip_prefix(UPDATE_PREFIX) {
        let (objective, summary) = rest
            .split_once(UPDATE_BODY_BOUNDED)
            .or_else(|| rest.split_once(UPDATE_BODY))?;
        (!objective.is_empty()).then_some((CoordinationKind::WorkerUpdate, summary))?
    } else {
        let rest = content.strip_prefix(REVIEW_PREFIX)?;
        let (objective, summary) = rest.split_once(REVIEW_BODY)?;
        (!objective.is_empty()).then_some((CoordinationKind::WorkerReview, summary))?
    };
    let summary = serde_json::from_str::<Value>(summary).ok()?;
    let object = summary.as_object()?;
    if object.len()!=3 || summary["round"].as_u64().is_none_or(|n| n < 1) || !matches!(summary["readMore"].as_str(),Some("Use read_worker for a bounded full result when required." | "Use read_worker for bounded full results and checkpoints. Read every active worker's checkpoint when handling a blocker if its checkpoint was omitted by this context budget." | READ_MORE)) { return None; }
    Some((kind, summary))
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

#[cfg(test)]
mod tests {
    use super::{f64_ge_i64, legacy_cutoff, CoordinationKind, LegacyCutoff, LegacyScan, REVIEW_BODY, REVIEW_PREFIX};

    #[test]
    fn lone_surrogate_text_cutoff_does_not_panic_and_sorts_above_ids() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            r#"CREATE TABLE architect_teams(session_id TEXT PRIMARY KEY, content TEXT NOT NULL);
               CREATE TABLE architect_workers(parent_session_id TEXT NOT NULL, worker_id TEXT NOT NULL, session_id TEXT NOT NULL);
               CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL);
               INSERT INTO architect_teams VALUES('team','{"legacyPromptThroughId":"\uD800"}');
               INSERT INTO architect_workers VALUES('team','w1','worker-session');
               INSERT INTO messages VALUES(1,'team','user');"#,
        )
        .unwrap();
        // SQLite really hands back TEXT here, which is not valid UTF-8.
        let class: String = db
            .query_row("SELECT typeof(json_extract(content,'$.legacyPromptThroughId')) FROM architect_teams", [], |r| r.get(0))
            .unwrap();
        assert_eq!(class, "text");
        assert_eq!(legacy_cutoff(&db, "team").unwrap(), LegacyCutoff::TextOrBlob);
        assert_eq!(legacy_cutoff(&db, "no-team").unwrap(), LegacyCutoff::Null);

        let prompt = format!(
            "{REVIEW_PREFIX}Ship it{REVIEW_BODY}{}",
            serde_json::json!({
                "round": 1,
                "readMore": "Use read_worker for a bounded full result when required.",
                "workers": [{"id":"w1","name":"Worker","status":"completed","attempt":1,"changed":false,"summary":"done","error":null,"abandoned":false}],
            })
        );
        let mut sqlite = db
            .prepare("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id='team' AND COALESCE(json_extract(content,'$.legacyPromptThroughId'),0)>=?1)")
            .unwrap();
        for id in [2, 1_000, i64::MAX] {
            let covered: bool = sqlite.query_row([id], |r| r.get(0)).unwrap();
            assert!(covered, "SQLite sorts text above {id}");
            let kind = LegacyScan::new(&db, "team").kind(id, &prompt).unwrap();
            assert_eq!(kind, covered.then_some(CoordinationKind::WorkerReview), "id {id}");
        }
        // The first user row itself is never covered, whatever the cutoff.
        assert_eq!(LegacyScan::new(&db, "team").kind(1, &prompt).unwrap(), None);
    }

    #[test]
    fn real_cutoff_matches_sqlite_integer_comparison() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let mut compare = db.prepare("SELECT ?1 >= ?2").unwrap();
        for (cutoff, id) in [
            (9_007_199_254_740_992.0, 9_007_199_254_740_993),
            (9_007_199_254_740_992.0, 9_007_199_254_740_992),
            (9_007_199_254_740_992.0, 9_007_199_254_740_991),
            (5.5, 5),
            (5.5, 6),
            (-5.5, -5),
            (-5.5, -6),
            (i64::MIN as f64, i64::MIN),
            (9_223_372_036_854_775_808.0, i64::MAX),
            (9_223_372_036_854_774_784.0, i64::MAX),
            (f64::INFINITY, i64::MAX),
            (f64::NEG_INFINITY, i64::MIN),
            (f64::NAN, 0),
        ] {
            let sqlite: Option<bool> = compare.query_row((cutoff, id), |row| row.get(0)).unwrap();
            assert_eq!(f64_ge_i64(cutoff, id), sqlite.unwrap_or(false), "{cutoff:?} >= {id}");
        }
    }
}
