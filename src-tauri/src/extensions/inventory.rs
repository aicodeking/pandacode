//! Read-only projections and bounded pull streams. Never serialize internal provider/connection/event DTOs.
use crate::storage::Store;
use serde_json::{json, Value};
use std::collections::VecDeque;

pub(super) const MAX_EVENTS: usize = 128;
pub(super) fn capability(resource: &str) -> Option<&'static str> {
    match resource { "projects" => Some("projects.summary"), "tasks" => Some("tasks.summary"), "harnesses" => Some("harnesses.inventory"), "connections" => Some("connections.summary"), "jobs" => Some("jobs.summary"), _ => None }
}
pub(super) fn status(raw: &str) -> &'static str {
    match raw { "running" => "running", "completed" => "completed", "failed" => "failed", "stopped" => "stopped", "pending" => "pending", "idle" => "idle", _ => "unknown" }
}
pub(super) fn items(store: &Store, project: &str, resource: &str) -> Result<Vec<Value>, &'static str> {
    if resource == "harnesses" { return crate::providers::inventory(); }
    let mut statement = store.db.prepare("SELECT id,provider,status FROM sessions WHERE project_id=?1 AND draft=0 ORDER BY id LIMIT 10001").map_err(|_| "HostUnavailable")?;
    let rows = statement.query_map([project], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(|_| "HostUnavailable")?;
    let mut result = Vec::new();
    for (count, row) in rows.enumerate() {
        if count == 10000 { return Err("LimitExceeded"); }
        let (id, provider, raw_status) = row.map_err(|_| "HostUnavailable")?;
        if id.len() > 256 { return Err("LimitExceeded"); }
        if resource == "jobs" { result.push(json!({"id":id,"projectId":project,"kind":"agentTask","status":status(&raw_status)})); }
        else if resource == "connections" {
            // Only the named connection assigned to an authorized task, not a global account roster.
            if let Some(connection) = crate::connections::for_task(&id, &provider) {
                if connection.id.len() > 160 { return Err("LimitExceeded"); }
                if crate::providers::PROVIDERS.iter().any(|(known, _)| *known == provider) && !result.iter().any(|item| item["id"] == connection.id) {
                    result.push(connection_summary(&connection));
                }
            }
        } else { return Err("UnsupportedCapability"); }
    }
    Ok(result)
}
fn connection_summary(connection: &crate::connections::Connection) -> Value {
    json!({"id":connection.id,"name":connection.provider,"status":"Configured","authentication":"Unknown","capabilities":["harness.launch"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_projection_never_serializes_environment_auth_paths_arguments_or_labels() {
        let connection = crate::connections::Connection { id: "opaque".into(), provider: "claude".into(), name: "SECRET_LABEL".into(), executable: Some("SECRET_PATH".into()), args: vec!["SECRET_ARG".into()], env: std::collections::BTreeMap::from([("SECRET_ENV".into(), "SECRET_VALUE".into())]), secret_env: vec!["SECRET_AUTH".into()], config_dir: Some("SECRET_DIR".into()), revision: 12 };
        assert_eq!(connection_summary(&connection), json!({"id":"opaque","name":"claude","status":"Configured","authentication":"Unknown","capabilities":["harness.launch"]}));
        assert!(!connection_summary(&connection).to_string().contains("SECRET"));
    }
}

#[derive(Default)]
pub(super) struct Journal { pub cursor: u64, floor: u64, events: VecDeque<Value> }
impl Journal {
    pub fn record(&mut self, id: &str, kind: &str, state: &str) {
        if id.len() > 256 || !matches!(kind, "progress" | "terminal") { return; }
        self.cursor += 1;
        // Coalesce adjacent progress; its old cursor becomes a gap, never silent loss.
        if kind == "progress" && self.events.back().is_some_and(|last| last["id"] == id && last["kind"] == "progress") {
            if let Some(last) = self.events.pop_back() { self.floor = self.floor.max(last["sequence"].as_u64().unwrap_or(0)); }
        }
        self.events.push_back(json!({"sequence":self.cursor,"id":id,"kind":kind,"status":status(state)}));
        if self.events.len() > MAX_EVENTS { if let Some(old) = self.events.pop_front() { self.floor = self.floor.max(old["sequence"].as_u64().unwrap_or(0)); } }
    }
    pub fn read(&self, store: &Store, project: &str, cursor: u64) -> Result<(bool, Vec<Value>), &'static str> {
        if cursor < self.floor || cursor > self.cursor { return Ok((true, Vec::new())); }
        let mut result = Vec::new();
        for event in self.events.iter().filter(|event| event["sequence"].as_u64().unwrap_or(0) > cursor) {
            let authorized: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND project_id=?2 AND draft=0)", rusqlite::params![event["id"].as_str(), project], |row| row.get(0)).map_err(|_| "HostUnavailable")?;
            if authorized { result.push(event.clone()); }
        }
        Ok((false, result))
    }
}
