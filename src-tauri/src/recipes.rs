//! Local workflow recipes: `<project>/.pandacode/recipes/<name>.json` and a global folder.
//! A recipe is a list of steps the UI queues as ordinary messages; `dry_run` reports, per
//! step, whether the chosen harness can do it. Nothing here runs an agent or phones home.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_RECIPES: usize = 200;
const MAX_STEPS: usize = 50;
const MAX_TEXT: usize = 4000;
const MAX_DESCRIPTION: usize = 500;
const MAX_FILE: u64 = 64 * 1024;
const KINDS: [&str; 4] = ["prompt", "slash", "check", "approval"];
/// Harnesses whose running turn takes a message. Claude-family harnesses steer on
/// stream input, Codex uses `turn/steer`, Pi and omp use their own steer, Muse takes
/// one on the wire, and OpenCode folds a second `session/prompt` into its running loop.
const STEERING: [&str; 8] = ["claude", "glm", "mimo", "codex", "pi", "omp", "muse", "opencode"];
const HARNESSES: [&str; 16] = [
    "claude", "codex", "kimi", "glm", "opencode", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "github-copilot", "muse",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub kind: String,
    /// Prompt, check or approval wording; for `slash` the fallback prompt when the command is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `/name args` for `slash` steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// `slash:<name>`, `mcp` or `steer`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<Step>,
    /// `project` or `global`; set when listing, never stored.
    #[serde(default, skip_serializing)]
    pub scope: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReport {
    pub index: usize,
    /// `supported`, `fallback`, `manual` or `blocked`.
    pub status: &'static str,
    pub reason: String,
}

/// What the dry-run table shows and what Run queues; `messages` is empty while a step is blocked.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub steps: Vec<StepReport>,
    pub messages: Vec<String>,
}

pub fn plan(recipe: &Recipe, provider: &str, slash: &[String]) -> Result<Plan, String> {
    let steps = dry_run(recipe, provider, slash)?;
    let messages = messages(recipe, &steps).unwrap_or_default();
    Ok(Plan { steps, messages })
}

pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

pub fn project_dir(root: &Path) -> PathBuf {
    root.join(".pandacode").join("recipes")
}

pub fn validate(recipe: &Recipe) -> Result<(), String> {
    if !valid_name(&recipe.name) {
        return Err("Recipe names use lowercase letters, digits, - and _ (up to 64).".into());
    }
    if recipe.description.chars().count() > MAX_DESCRIPTION {
        return Err("The description is too long.".into());
    }
    if recipe.steps.is_empty() || recipe.steps.len() > MAX_STEPS {
        return Err(format!("A recipe has 1 to {MAX_STEPS} steps."));
    }
    for (i, step) in recipe.steps.iter().enumerate() {
        let n = i + 1;
        if !KINDS.contains(&step.kind.as_str()) {
            return Err(format!("Step {n}: unknown kind “{}”.", step.kind));
        }
        let text = step.text.as_deref().map(str::trim).unwrap_or("");
        let command = step.command.as_deref().map(str::trim).unwrap_or("");
        if text.chars().count() > MAX_TEXT || command.chars().count() > MAX_TEXT {
            return Err(format!("Step {n} is too long."));
        }
        match step.kind.as_str() {
            "slash" if !command.starts_with('/') || command.len() < 2 => {
                return Err(format!("Step {n}: a slash step needs a command like /review."))
            }
            "prompt" | "check" if text.is_empty() => return Err(format!("Step {n}: add the text to send.")),
            _ => {}
        }
        for need in &step.requires {
            let known = need == "mcp" || need == "steer" || need.strip_prefix("slash:").is_some_and(|s| !s.trim().is_empty());
            if !known || need.len() > 160 {
                return Err(format!("Step {n}: unknown requirement “{need}”."));
            }
        }
    }
    Ok(())
}

fn file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Invalid recipe name.".into());
    }
    Ok(dir.join(format!("{name}.json")))
}

/// Recipes in `dir` (unreadable or invalid files are skipped), sorted by name.
pub fn list_dir(dir: &Path, scope: &str) -> Vec<Recipe> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mut found: Vec<Recipe> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            if path.extension()? != "json" || !valid_name(&stem) || entry.metadata().ok()?.len() > MAX_FILE {
                return None;
            }
            let mut recipe: Recipe = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;
            (recipe.name == stem && validate(&recipe).is_ok()).then(|| {
                recipe.scope = scope.into();
                recipe
            })
        })
        .take(MAX_RECIPES)
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// Project recipes first; a project recipe hides a global one of the same name.
pub fn list(project: Option<&Path>, global: &Path) -> Vec<Recipe> {
    let mut all = project.map(|root| list_dir(&project_dir(root), "project")).unwrap_or_default();
    for recipe in list_dir(global, "global") {
        if !all.iter().any(|r| r.name == recipe.name) {
            all.push(recipe);
        }
    }
    all
}

pub fn save(dir: &Path, recipe: &Recipe) -> Result<(), String> {
    validate(recipe)?;
    let path = file(dir, &recipe.name)?;
    let exists = path.exists();
    if !exists && list_dir(dir, "").len() >= MAX_RECIPES {
        return Err("Too many recipes here.".into());
    }
    let body = serde_json::to_string_pretty(recipe).map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_FILE {
        return Err("The recipe is too large.".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("Could not create the recipes folder: {e}"))?;
    let temp = dir.join(format!(".{}.tmp", recipe.name));
    fs::write(&temp, body + "\n").map_err(|e| format!("Could not save the recipe: {e}"))?;
    fs::rename(&temp, &path).map_err(|e| format!("Could not save the recipe: {e}"))
}

pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    match fs::remove_file(file(dir, name)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete the recipe: {e}")),
    }
}

fn note(report: &mut StepReport, status: &'static str, reason: String) {
    if rank(status) > rank(report.status) {
        *report = StepReport { index: report.index, status, reason };
    }
}

fn rank(status: &str) -> u8 {
    match status {
        "supported" => 0,
        "fallback" => 1,
        "manual" => 2,
        _ => 3,
    }
}

/// Resolves every step against `provider`. `slash` lists the command names (with the leading
/// `/`) the harness offers in this task, from `list_slash_commands`. A step never silently
/// takes a weaker path: a missing command is `blocked`, unless the step carries fallback text.
pub fn dry_run(recipe: &Recipe, provider: &str, slash: &[String]) -> Result<Vec<StepReport>, String> {
    if !HARNESSES.contains(&provider) {
        return Err("Unknown harness.".into());
    }
    validate(recipe)?;
    let has = |name: &str| {
        let name = name.trim_start_matches('/');
        slash.iter().any(|s| s.trim_start_matches('/') == name)
    };
    Ok(recipe
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut report = StepReport { index, status: "supported", reason: "Sent as a message.".into() };
            match step.kind.as_str() {
                "slash" => {
                    let command = step.command.as_deref().unwrap_or("").trim();
                    let name = command.split_whitespace().next().unwrap_or("");
                    if has(name) {
                        report.reason = format!("{name} is offered by {provider}.");
                    } else if step.text.as_deref().is_some_and(|t| !t.trim().is_empty()) {
                        note(&mut report, "fallback", format!("{name} is not offered by {provider}; the step's own text is sent instead."));
                    } else {
                        note(&mut report, "blocked", format!("{name} is not offered by {provider} and the step has no fallback text."));
                    }
                }
                "approval" => note(&mut report, "manual", "Waits for you to confirm before the next step.".into()),
                "check" => report.reason = "The agent runs the check and reports the result.".into(),
                _ => {}
            }
            for need in &step.requires {
                match need.as_str() {
                    "mcp" => {}
                    "steer" if !STEERING.contains(&provider) => {
                        note(&mut report, "fallback", format!("{provider} cannot take a message mid-turn; it is queued until the run ends."))
                    }
                    "steer" => {}
                    other => {
                        let name = other.trim_start_matches("slash:");
                        if !has(name) {
                            note(&mut report, "blocked", format!("Requires /{} which {provider} does not offer.", name.trim_start_matches('/')));
                        }
                    }
                }
            }
            report
        })
        .collect())
}

/// The messages a run queues, in order. Slash steps whose command is missing send their fallback text.
pub fn messages(recipe: &Recipe, reports: &[StepReport]) -> Result<Vec<String>, String> {
    if let Some(r) = reports.iter().find(|r| r.status == "blocked") {
        return Err(format!("Step {} is blocked: {}", r.index + 1, r.reason));
    }
    Ok(recipe
        .steps
        .iter()
        .zip(reports)
        .map(|(step, report)| {
            let text = step.text.as_deref().unwrap_or("").trim();
            match step.kind.as_str() {
                "slash" if report.status == "fallback" => text.to_string(),
                "slash" => step.command.as_deref().unwrap_or("").trim().to_string(),
                "check" => format!("Run this check and report the result, including any failures:\n{text}"),
                "approval" => format!(
                    "Stop here and ask me to confirm before doing anything else. Do not continue until I reply.{}",
                    if text.is_empty() { String::new() } else { format!("\n{text}") }
                ),
                _ => text.to_string(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: &str, text: Option<&str>, command: Option<&str>, requires: &[&str]) -> Step {
        Step { kind: kind.into(), text: text.map(Into::into), command: command.map(Into::into), requires: requires.iter().map(|s| s.to_string()).collect() }
    }
    fn recipe(steps: Vec<Step>) -> Recipe {
        Recipe { name: "review".into(), description: "d".into(), steps, scope: String::new() }
    }
    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-recipes-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn names_are_path_safe() {
        for bad in ["", "../x", "a/b", "A", ".hidden", "a.json", &"a".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(valid_name("review-diff_2"));
        assert!(save(&temp("name"), &Recipe { name: "../x".into(), ..recipe(vec![step("prompt", Some("hi"), None, &[])]) }).is_err());
    }

    #[test]
    fn validation_bounds() {
        assert!(validate(&recipe(vec![])).is_err());
        assert!(validate(&recipe(vec![step("prompt", None, None, &[])])).is_err());
        assert!(validate(&recipe(vec![step("slash", None, Some("review"), &[])])).is_err());
        assert!(validate(&recipe(vec![step("nope", Some("x"), None, &[])])).is_err());
        assert!(validate(&recipe(vec![step("prompt", Some("x"), None, &["gpu"])])).is_err());
        assert!(validate(&recipe(vec![step("prompt", Some(&"x".repeat(MAX_TEXT + 1)), None, &[])])).is_err());
        assert!(validate(&recipe(vec![step("prompt", Some("x"), None, &[]); MAX_STEPS + 1])).is_err());
        assert!(validate(&recipe(vec![step("approval", None, None, &["steer", "mcp", "slash:review"])])).is_ok());
    }

    #[test]
    fn save_list_delete_and_scope() {
        let (project, global) = (temp("project"), temp("global"));
        let mut r = recipe(vec![step("prompt", Some("Review the diff"), None, &[])]);
        save(&project_dir(&project), &r).unwrap();
        r.name = "only-global".into();
        save(&global, &r).unwrap();
        r.name = "review".into();
        r.description = "global copy".into();
        save(&global, &r).unwrap();
        fs::write(project_dir(&project).join("broken.json"), "{").unwrap();
        let all = list(Some(&project), &global);
        let names: Vec<_> = all.iter().map(|r| (r.name.as_str(), r.scope.as_str(), r.description.as_str())).collect();
        assert_eq!(names, [("review", "project", "d"), ("only-global", "global", "d")]);
        assert!(!fs::read_to_string(project_dir(&project).join("review.json")).unwrap().contains("scope"));
        delete(&project_dir(&project), "review").unwrap();
        delete(&project_dir(&project), "review").unwrap();
        assert!(list(Some(&project), &global).iter().any(|r| r.name == "review" && r.scope == "global" && r.description == "global copy"));
        assert!(delete(&global, "../review").is_err());
        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(global);
    }

    #[test]
    fn dry_run_resolves_each_step() {
        let r = recipe(vec![
            step("prompt", Some("Look"), None, &[]),
            step("slash", None, Some("/review main"), &[]),
            step("slash", Some("Review the diff"), Some("/missing"), &[]),
            step("slash", None, Some("/missing"), &[]),
            step("check", Some("npm test"), None, &["steer"]),
            step("approval", None, None, &[]),
            step("prompt", Some("x"), None, &["slash:ship"]),
        ]);
        let slash = vec!["/review".to_string()];
        let status = |provider: &str| dry_run(&r, provider, &slash).unwrap().iter().map(|s| s.status).collect::<Vec<_>>();
        assert_eq!(status("claude"), ["supported", "supported", "fallback", "blocked", "supported", "manual", "blocked"]);
        assert_eq!(status("kimi")[4], "fallback");
        let reports = dry_run(&r, "claude", &slash).unwrap();
        assert!(reports[3].reason.contains("/missing"));
        assert!(dry_run(&r, "nope", &slash).is_err());
        assert!(messages(&r, &reports).unwrap_err().contains("Step 4"));
        assert!(plan(&r, "claude", &slash).unwrap().messages.is_empty());
    }

    #[test]
    fn messages_follow_the_dry_run() {
        let r = recipe(vec![
            step("slash", Some("Review the diff"), Some("/missing"), &[]),
            step("slash", None, Some("/review"), &[]),
            step("check", Some("npm test"), None, &[]),
            step("approval", Some("Merge?"), None, &[]),
        ]);
        let reports = dry_run(&r, "codex", &["/review".into()]).unwrap();
        let out = messages(&r, &reports).unwrap();
        assert_eq!(out[0], "Review the diff");
        assert_eq!(out[1], "/review");
        assert!(out[2].ends_with("npm test") && out[2].contains("report"));
        assert!(out[3].contains("confirm") && out[3].ends_with("Merge?"));
    }

    #[test]
    fn every_harness_the_app_supports_can_run_a_recipe() {
        let r = recipe(vec![step("prompt", Some("hi"), None, &[])]);
        for (provider, _) in crate::providers::PROVIDERS {
            assert!(HARNESSES.contains(&provider), "{provider} is missing from the recipe harnesses");
            assert!(dry_run(&r, provider, &[]).is_ok(), "{provider} cannot run a recipe");
        }
    }

    #[test]
    fn a_steer_step_is_supported_only_where_the_turn_takes_a_message() {
        let r = recipe(vec![step("check", Some("npm test"), None, &["steer"])]);
        for provider in ["claude", "glm", "mimo", "codex", "pi", "omp", "muse", "opencode"] {
            let reports = dry_run(&r, provider, &[]).unwrap();
            assert_eq!(reports[0].status, "supported", "{provider} takes a message mid-turn");
        }
        for provider in ["kimi", "grok", "deepseek", "commandcode", "cline", "antigravity", "github-copilot"] {
            let reports = dry_run(&r, provider, &[]).unwrap();
            assert_eq!(reports[0].status, "fallback", "{provider} holds the message until the run ends");
        }
    }
}
