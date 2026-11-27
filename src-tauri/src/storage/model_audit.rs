use super::{Result, Store};
use rusqlite::{params, Connection};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_model_runs (
    turn_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    harness TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    requested_effort TEXT,
    reported_model TEXT
)";

pub(crate) const REPORTED_MODEL_EVENT: &str = "reported_model";

pub(super) fn initialize(db: &Connection) -> bool {
    let result = super::run_savepoint(
        db,
        "model_audit_schema",
        || {
            db.execute_batch(SCHEMA)?;
            let _ = db.prepare("SELECT turn_message_id,harness,requested_model,requested_effort,reported_model FROM task_model_runs LIMIT 0")?;
            Ok(())
        },
        std::convert::identity,
    );
    if result.is_err() {
        eprintln!("Model selections are unavailable for task exports.");
    }
    result.is_ok()
}

pub(crate) fn exportable_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-:/@+".contains(&byte))
        && !id.contains("://")
        && !id.starts_with('/')
        && id.as_bytes().get(1..3) != Some(b":/".as_slice())
        && id.split('/').all(|part| part != "." && part != "..")
        && id.split_once('@').is_none_or(|(_, version)| {
            !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
        })
        && !["sk-", "ghp_", "github_pat_"]
            .into_iter()
            .any(|prefix| id.starts_with(prefix))
}

impl Store {
    pub(crate) fn record_requested_model(
        &self,
        turn: i64,
        harness: &str,
        model: &str,
        effort: Option<&str>,
    ) -> Result<()> {
        if !self.model_audit_usable || turn == 0 {
            return Ok(());
        }
        let model = if model.is_empty() {
            "default"
        } else if exportable_model_id(model) {
            model
        } else {
            "unavailable"
        };
        self.db.prepare_cached(
            "INSERT INTO task_model_runs(turn_message_id,harness,requested_model,requested_effort)
             VALUES (?1,?2,?3,?4) ON CONFLICT(turn_message_id) DO NOTHING",
        ).and_then(|mut stmt| stmt.execute(params![turn, harness, model, effort.filter(|id| exportable_model_id(id))]))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn record_reported_model(&self, turn: i64, model: &str) -> Result<()> {
        if !self.model_audit_usable
            || turn == 0
            || model == "default"
            || !exportable_model_id(model)
        {
            return Ok(());
        }
        self.db
            .prepare_cached(
                "UPDATE task_model_runs SET reported_model=?2
             WHERE turn_message_id=?1 AND reported_model IS NOT ?2",
            )
            .and_then(|mut stmt| stmt.execute(params![turn, model]))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn append_model_export(
        &self,
        session: &str,
        output: &mut String,
        limit: usize,
    ) -> Result<()> {
        if !self.model_audit_usable {
            return Ok(());
        }
        let mut query = self.db.prepare_cached(
            "SELECT w.worker_id, m.id, m.created_at, r.harness, r.requested_model, r.requested_effort, r.reported_model
             FROM messages m JOIN task_model_runs r ON r.turn_message_id=m.id
             LEFT JOIN architect_workers w ON w.session_id=m.session_id WHERE m.session_id=?1
             UNION ALL
             SELECT w.worker_id, m.id, m.created_at, r.harness, r.requested_model, r.requested_effort, r.reported_model
             FROM architect_workers w JOIN messages m ON m.session_id=w.session_id
             JOIN task_model_runs r ON r.turn_message_id=m.id WHERE w.parent_session_id=?1
             ORDER BY id",
        ).map_err(|error| error.to_string())?;
        let rows = query.query_map([session], |row| {
                let worker: Option<String> = row.get(0)?;
                let at: i64 = row.get(2)?;
                let harness: String = row.get(3)?;
                let requested: String = row.get(4)?;
                let effort: Option<String> = row.get(5)?;
                let reported: Option<String> = row.get(6)?;
                let actor = match worker {
                    Some(worker) if exportable_model_id(&worker) => format!("Worker `{worker}`"),
                    Some(_) => "Worker".into(),
                    None => "Lead".into(),
                };
                let timestamp = chrono::DateTime::from_timestamp_millis(at)
                    .map_or_else(|| at.to_string(), |time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                let model = reported.map_or_else(|| "model unreported".into(), |model| format!("reported `{model}`"));
                let effort = effort.map_or_else(String::new, |effort| format!(" · effort `{effort}`"));
                Ok(format!("- {timestamp} · {actor} · `{harness}` · requested `{requested}` · {model}{effort}\n"))
        }).map_err(|error| error.to_string())?;
        let mut heading = "## Model selections\n\n";
        for row in rows {
            let entry = row.map_err(|error| error.to_string())?;
            if output.len() + heading.len() + entry.len() > limit {
                return Err("This transcript exceeds the 8 MiB export limit.".into());
            }
            output.push_str(heading);
            output.push_str(&entry);
            heading = "";
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_keep_provider_versions_and_reject_accounts_and_paths() {
        for model in [
            "openai/gpt-6",
            "claude-sonnet-4-5@20250929",
            "us.anthropic.sonnet-v1:0",
        ] {
            assert!(exportable_model_id(model));
        }
        for value in [
            "person@example.com",
            "../dev/model",
            "/private/model",
            "C:/private/model",
            "sk-example-key",
        ] {
            assert!(!exportable_model_id(value));
        }
    }

    #[test]
    fn incompatible_audit_schema_does_not_prevent_recovery() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE task_model_runs (unrelated TEXT)")
            .unwrap();
        let recovery = db.transaction().unwrap();
        assert!(!initialize(&recovery));
        recovery
            .execute_batch("CREATE TABLE recovered (id INT)")
            .unwrap();
        recovery.commit().unwrap();
    }
}
