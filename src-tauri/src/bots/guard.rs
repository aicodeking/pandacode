//! Approval rules for bots: allow, ask or deny per pattern, like "Always allow" in
//! the products this follows. Deny wins over allow. A fixed list of dangerous
//! actions always asks, even when a broad allow rule matches, so "always" cannot
//! quietly cover force pushes, privilege escalation or piping downloads to a shell.

use crate::{storage::Store, AppState, Result};
use rusqlite::params;
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub pattern: String,
    pub decision: String,
    pub created_at: i64,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Decision {
    Allow,
    Ask,
    Deny,
}

/// Actions a rule can never auto-approve.
const ALWAYS_ASK: &[&str] = &[
    "sudo ", "rm -rf", "rm -fr", "git push --force", "git push -f", "| sh", "|sh", "| bash", "|bash", "mkfs", "dd if=", "chmod -r 777", ":(){", "shutdown", "reboot",
    "credit card", "card number", "password", "transfer money", "wire transfer",
];

/// Case-insensitive. Without `*` a pattern matches anywhere in the text; with `*` the
/// whole text must match, `*` standing for any run of characters (`npm test*`, `*deploy*`).
pub(crate) fn matches(pattern: &str, text: &str) -> bool {
    let pattern = pattern.trim().to_lowercase();
    let text = text.trim().to_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if !pattern.contains('*') {
        return text.contains(&pattern);
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    // Greedy glob with backtracking to the last star.
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] != '*' && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(position) = star {
            pi = position + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

pub(crate) fn dangerous(text: &str) -> bool {
    let lower = text.to_lowercase();
    ALWAYS_ASK.iter().any(|needle| lower.contains(needle))
}

pub(crate) fn rules(store: &Store, bot_id: &str) -> Result<Vec<Rule>> {
    let mut statement = store.db.prepare("SELECT id,pattern,decision,created_at FROM bot_rules WHERE bot_id=?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([bot_id], |r| Ok(Rule { id: r.get(0)?, pattern: r.get(1)?, decision: r.get(2)?, created_at: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn decide(store: &Store, bot_id: &str, text: &str) -> Result<Decision> {
    let rules = rules(store, bot_id)?;
    if rules.iter().any(|rule| rule.decision == "deny" && matches(&rule.pattern, text)) {
        return Ok(Decision::Deny);
    }
    // An agent-made tool run always asks: its script is agent text, so words in it could
    // match any allow rule.
    if dangerous(text) || crate::custom_tools::approval::is_run(text) {
        return Ok(Decision::Ask);
    }
    if rules.iter().any(|rule| rule.decision == "allow" && matches(&rule.pattern, text)) {
        return Ok(Decision::Allow);
    }
    Ok(Decision::Ask)
}

/// The rule "always" saves for an approval, or `None` for an agent-made tool run, which asks
/// every time (a pattern from its header would cover every later run of any script).
pub(crate) fn always_rule(text: &str) -> Option<String> {
    (!crate::custom_tools::approval::is_run(text)).then(|| pattern_for(text))
}

/// A rule pattern for "always allow this kind of action": the action's first words.
pub(crate) fn pattern_for(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let words: Vec<&str> = line.split_whitespace().take(3).collect();
    let base = words.join(" ");
    if line.split_whitespace().count() > 3 { format!("{base}*") } else { base }.chars().take(120).collect()
}

pub(crate) fn add_rule(store: &Store, bot_id: &str, pattern: &str, decision: &str) -> Result<Rule> {
    let pattern = pattern.trim().chars().take(200).collect::<String>();
    if pattern.trim_matches('*').trim().len() < 2 {
        return Err("A rule needs a pattern of at least two characters.".into());
    }
    if !matches!(decision, "allow" | "ask" | "deny") {
        return Err("A rule allows, asks or denies.".into());
    }
    super::get(store, bot_id)?;
    let id = crate::storage::id();
    let now = crate::storage::now();
    store.db.execute("INSERT INTO bot_rules(id,bot_id,pattern,decision,created_at) VALUES(?1,?2,?3,?4,?5)", params![id, bot_id, pattern, decision, now]).map_err(|e| e.to_string())?;
    super::log(store, bot_id, "rule", &format!("Rule: {decision} \"{pattern}\""), serde_json::json!({}))?;
    Ok(Rule { id, pattern, decision: decision.into(), created_at: now })
}

pub(crate) fn delete_rule(store: &Store, bot_id: &str, id: &str) -> Result<()> {
    store.db.execute("DELETE FROM bot_rules WHERE id=?1 AND bot_id=?2", params![id, bot_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn bot_rule_add(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, pattern: String, decision: String) -> Result<Rule> {
    let rule = add_rule(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &pattern, &decision)?;
    let _ = app.emit("bots-changed", ());
    Ok(rule)
}

#[tauri::command]
pub async fn bot_rule_delete(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, rule_id: String) -> Result<()> {
    delete_rule(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &rule_id)?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN: &str = "Run project tool test-all v2?\nIt runs in this task's checkout.\nScript (v2):\nnpm test";

    #[test]
    fn allow_rules_never_approve_an_agent_made_tool_run() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let root = std::env::temp_dir().join(format!("pandacode-guard-{}", crate::storage::id()));
        let input = super::super::BotInput { name: "Scout".into(), provider: "claude".into(), model: "default".into(), mode: "ask".into(), ..Default::default() };
        let bot = super::super::create(&store, &input, &root).unwrap();
        add_rule(&store, &bot.id, "npm test", "allow").unwrap();
        // A broad rule saved before add_rule refused it.
        store.db.execute("INSERT INTO bot_rules(id,bot_id,pattern,decision,created_at) VALUES('wide',?1,'*','allow',0)", [&bot.id]).unwrap();
        assert_eq!(decide(&store, &bot.id, "npm test").unwrap(), Decision::Allow);
        assert_eq!(decide(&store, &bot.id, RUN).unwrap(), Decision::Ask);
        add_rule(&store, &bot.id, "test-all", "deny").unwrap();
        assert_eq!(decide(&store, &bot.id, RUN).unwrap(), Decision::Deny, "deny rules still refuse");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn always_saves_no_rule_for_an_agent_made_tool_run() {
        assert_eq!(always_rule(RUN), None);
        assert_eq!(always_rule("Allow pandacode_tool_run?\n{}").as_deref(), Some("Allow pandacode_tool_run?"));
        assert_eq!(always_rule("npm run build --prod").as_deref(), Some("npm run build*"));
    }
}
