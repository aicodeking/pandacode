//! PandaConnect methods for the `tools` feature group: progress snapshots, the task's fast
//! check, recipes, skills, the project's run script and local servers. Each reuses the
//! desktop's own command or module. See `methods/mod.rs` and docs/remote-access.md,
//! "Adding a method".
use super::files::{data_page, offset_param, resolve, split_data_url, target_param, Target};
use super::super::host::workspace_task;
use super::{allow_task_mode, id_param, name_param, task_root, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::Result;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Recipe steps one run may queue; recipes themselves are validated by `recipes.rs`.
const MAX_RECIPE_MESSAGES: usize = 50;
/// The terminal size a phone-started run script gets (it runs headless on the computer).
const SCRIPT_COLS: u16 = 120;
const SCRIPT_ROWS: u16 = 32;
/// Why `skills.activate` needs the host's switch: a skill's instructions reach every task of
/// its harness (or project), Full access ones included.
const CHANGE_SKILLS: &str = "change skills";

/// Drops trailing list entries until `{key: list}` fits the page budget; true when any were dropped.
fn fit(list: &mut Vec<Value>, key: &str) -> bool {
    let mut dropped = false;
    while !list.is_empty() && json!({ key: &*list }).to_string().len() > PAGE_BUDGET - 1024 {
        list.pop();
        dropped = true;
    }
    dropped
}

// ---- progress.list / progress.thumb / progress.media ----

#[derive(Debug, PartialEq)]
struct ProgressList {
    session_id: String,
}

impl Run for ProgressList {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            workspace_task(&ctx.state(), &self.session_id).await?;
            let snapshots = crate::progress::progress_list(ctx.app.clone(), self.session_id).await?;
            let mut list: Vec<Value> = snapshots.into_iter().rev().map(|s| serde_json::to_value(s).unwrap_or(Value::Null)).filter(|v| !v.is_null()).collect();
            let truncated = fit(&mut list, "snapshots");
            Ok(json!({"snapshots": list, "truncated": truncated}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct ProgressImage {
    session_id: String,
    id: String,
    full: bool,
    offset: usize,
}

impl Run for ProgressImage {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            workspace_task(&ctx.state(), &self.session_id).await?;
            let url = if self.full {
                crate::progress::progress_media(ctx.app.clone(), self.session_id, self.id).await?
            } else {
                crate::progress::progress_thumb(ctx.app.clone(), self.session_id, self.id).await?
            };
            let (mime, data) = split_data_url(&url)?;
            data_page(mime, data, self.offset)
        })
    }
}

// ---- checks.plan / checks.run ----

#[derive(Debug, PartialEq)]
struct ChecksPlan {
    session_id: String,
}

impl Run for ChecksPlan {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let root = task_root(&ctx.state(), &self.session_id).await?;
            crate::blocking(move || Ok(json!({"name": crate::checks::plan(&root).map(|plan| plan.name)}))).await
        })
    }
}

#[derive(Debug, PartialEq)]
struct ChecksRun {
    session_id: String,
}

impl Run for ChecksRun {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // The repo's check commands run with no approval step, like `runScript.start`.
            super::terminal::require_full_access_to(ctx.full_access, super::terminal::RUN_CHECKS)?;
            let root = task_root(&ctx.state(), &self.session_id).await?;
            // Bounded by checks.rs (120 s, 64 KiB of output, a 4 KB tail in the reply).
            crate::blocking(move || Ok(crate::checks::turn_report(&root))).await
        })
    }
}

// ---- recipes.list / recipes.plan / recipes.run ----

fn global_recipes(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recipes"))
}

/// Recipes for the target's project (its main checkout, as the desktop lists them) and the global folder.
async fn recipes_for(ctx: &Ctx<'_>, target: &Target) -> Result<Vec<crate::recipes::Recipe>> {
    let (project_id, _) = resolve(&ctx.state(), target).await?;
    let store = ctx.state().store.clone();
    let global = global_recipes(ctx.app)?;
    crate::blocking(move || {
        let root = store.lock().map_err(|e| e.to_string())?.workspace_root(&project_id, None).ok();
        Ok(crate::recipes::list(root.as_deref(), &global))
    })
    .await
}

#[derive(Debug, PartialEq)]
struct RecipesList {
    target: Target,
}

impl Run for RecipesList {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let recipes = recipes_for(&ctx, &self.target).await?;
            let mut list: Vec<Value> = recipes
                .into_iter()
                .map(|recipe| {
                    let scope = recipe.scope.clone();
                    let mut value = serde_json::to_value(recipe).unwrap_or(Value::Null);
                    value["scope"] = json!(if scope.is_empty() { "project".to_owned() } else { scope });
                    value
                })
                .collect();
            let truncated = fit(&mut list, "recipes");
            Ok(json!({"recipes": list, "truncated": truncated}))
        })
    }
}

/// A recipe's dry run against the task's harness and slash commands, as the desktop shows it.
async fn plan_for(ctx: &Ctx<'_>, session_id: &str, name: &str) -> Result<(crate::storage::Session, crate::recipes::Recipe, crate::recipes::Plan)> {
    let task = workspace_task(&ctx.state(), session_id).await?;
    let recipe = recipes_for(ctx, &Target::Task(session_id.to_owned()))
        .await?
        .into_iter()
        .find(|recipe| recipe.name == name)
        .ok_or("That recipe no longer exists.")?;
    // Round 12: a View device (or one below the task's mode) gets the cached catalog only;
    // discovery would start the harness in the project.
    let slash: Vec<String> = match super::composer::task_catalog(ctx, session_id, &task.mode).await {
        Ok(catalog) => catalog.commands.into_iter().map(|command| format!("/{}", command.name.trim_start_matches('/'))).collect(),
        Err(_) => Vec::new(),
    };
    let plan = crate::recipes::plan(&recipe, &task.provider, &slash)?;
    Ok((task, recipe, plan))
}

#[derive(Debug, PartialEq)]
struct RecipesPlan {
    session_id: String,
    name: String,
}

impl Run for RecipesPlan {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, recipe, plan) = plan_for(&ctx, &self.session_id, &self.name).await?;
            let blocked = plan.steps.iter().any(|step| step.status == "blocked");
            Ok(json!({"recipe": recipe, "steps": plan.steps, "count": plan.messages.len(), "blocked": blocked}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct RecipesRun {
    session_id: String,
    name: String,
    /// A retry with the same id answers the first run (`once_per_action`).
    send_id: Option<String>,
}

impl Run for RecipesRun {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let send_id = self.send_id.clone();
            let target = self.session_id.clone();
            super::once_per_action(ctx.from, "recipes.run", &target, send_id.as_deref(), run_recipe(ctx, *self)).await
        })
    }
}

/// `recipes.run` itself: one message per step, sent or queued under the task's send lock.
async fn run_recipe(ctx: Ctx<'_>, this: RecipesRun) -> Result<Value> {
    // The mode check comes first, so a refused device never reaches the dry run at all.
    let mode = workspace_task(&ctx.state(), &this.session_id).await?.mode;
    allow_task_mode(&mode, None, ctx.full_access)?;
    // Its messages would prompt a team lead, whose workers run in full access.
    super::allow_remote_team_for(&ctx.state(), &this.session_id, ctx.full_access).await?;
    let (_, _, plan) = plan_for(&ctx, &this.session_id, &this.name).await?;
    if let Some(step) = plan.steps.iter().find(|step| step.status == "blocked") {
        return Err(format!("Step {} is blocked: {}", step.index + 1, step.reason));
    }
    let messages: Vec<String> = plan.messages.into_iter().filter(|text| !text.trim().is_empty()).collect();
    if messages.is_empty() || messages.len() > MAX_RECIPE_MESSAGES {
        return Err("This recipe has nothing to send.".into());
    }
    let state = ctx.state();
    let session_id = this.session_id;
    // Background lane: never check-then-send beside a `task.send` or `schedules.runNow`.
    let _turn = super::task_send_lock(&session_id).await;
    let busy = || state.agents.lock().map(|agents| agents.contains_key(&session_id)).map_err(|e| e.to_string());
    // Like the desktop's Run: one message per step, through the task's queue. A busy
    // task queues each; an idle one gets the first now and the rest after each run.
    let (mut sent, mut queued) = (0, 0);
    let mut failure = None;
    for text in messages {
        let step: Result<bool> = async {
            if busy()? {
                let entry = crate::message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, &session_id, &text, &json!([]))?;
                if busy()? || crate::message_queue::withdraw(&*state.store.lock().map_err(|e| e.to_string())?, &entry.id).is_err() {
                    return Ok(true);
                }
            }
            crate::send_message(ctx.app.clone(), ctx.state(), session_id.clone(), text, None, None).await?;
            Ok(false)
        }
        .await;
        match step {
            Ok(true) => queued += 1,
            Ok(false) => sent += 1,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    if sent + queued > 0 {
        let _ = ctx.app.emit("queue-changed", json!({"sessionId": session_id}));
        let _ = ctx.app.emit("sessions-changed", ());
    }
    recipe_outcome(sent, queued, failure)
}

/// A recipe run's reply. Once a step went (sent or queued) the run happened, so a later
/// step's failure is a success carrying `partialError`: `once_per_action` remembers it and a
/// retry with the same `sendId` does not send the first steps again.
fn recipe_outcome(sent: usize, queued: usize, failure: Option<String>) -> Result<Value> {
    match failure {
        Some(error) if sent + queued == 0 => Err(error),
        Some(error) => Ok(json!({"sent": sent, "queued": queued, "partialError": error})),
        None => Ok(json!({"sent": sent, "queued": queued})),
    }
}

// ---- skills.list / skills.activate ----

#[derive(Debug, PartialEq)]
struct SkillsList {
    target: Option<Target>,
}

/// Round 18: a local path as a View phone may see it: `~/…` below the home folder, otherwise
/// only its last folder name (never the absolute path of the computer's disk).
fn shown_path(path: &str, home: Option<&str>) -> String {
    let home = home.map(|home| home.trim_end_matches('/')).filter(|home| !home.is_empty());
    if let Some(rest) = home.and_then(|home| path.strip_prefix(home)) {
        if rest.is_empty() || rest.starts_with('/') {
            return format!("~{rest}");
        }
    }
    std::path::Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn home() -> Option<String> {
    std::env::var("HOME").ok()
}

/// A skill's source for the phone: `owner/name/path` for GitHub, [`shown_path`] for a folder.
fn shown_source(source: &crate::skills::Source, home: Option<&str>) -> String {
    if source.kind == "github" { source.location.clone() } else { shown_path(&source.location, home) }
}

/// A matrix row's cells with each `surface` (a skill folder or rule file) passed through
/// [`shown_path`]; `prompt` stays as it is (Round 24).
fn shown_cells(cells: &Value, home: Option<&str>) -> Value {
    let cells = cells.as_array().cloned().unwrap_or_default();
    Value::Array(
        cells
            .into_iter()
            .map(|mut cell| {
                if let Some(surface) = cell.get("surface").and_then(Value::as_str).map(|surface| shown_path(surface, home)) {
                    cell["surface"] = Value::String(surface);
                }
                cell
            })
            .collect(),
    )
}

/// What a phone needs of one library item: no file lists or excerpts, no local paths.
fn skill_summary(item: &crate::skills::Item) -> Value {
    let meta = &item.meta;
    json!({
        "id": meta.id,
        "name": meta.name,
        "kind": meta.kind,
        "description": crate::remote::host::bounded_text(&meta.description, 400),
        "source": shown_source(&meta.source, home().as_deref()),
        "findings": item.findings.len(),
        "acknowledged": item.findings.is_empty() || meta.acknowledged.as_deref() == Some(meta.sha256.as_str()),
    })
}

impl Run for SkillsList {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let root = match &self.target {
                Some(target) => Some(resolve(&ctx.state(), target).await?.1),
                None => None,
            };
            let app = ctx.app.clone();
            crate::blocking(move || {
                let library = crate::skills::library(&app)?;
                let mut items: Vec<Value> = library.list()?.iter().map(skill_summary).collect();
                let matrix = serde_json::to_value(library.matrix(root.as_deref())?).map_err(|e| e.to_string())?;
                let mut harnesses: Vec<Value> = matrix["harnesses"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|row| json!({"harness": row["harness"], "installed": row["installed"], "prompt": row["prompt"], "cells": shown_cells(&row["cells"], home().as_deref())}))
                    .collect();
                let truncated = fit(&mut items, "items") | fit(&mut harnesses, "harnesses");
                let project = matrix["project"].as_str().map(|root| shown_path(root, home().as_deref()));
                Ok(json!({"project": project, "items": items, "harnesses": harnesses, "truncated": truncated}))
            })
            .await
        })
    }
}

#[derive(Debug, PartialEq)]
struct SkillsActivate {
    id: String,
    harness: String,
    scope: crate::skills::Scope,
    target: Option<Target>,
    active: bool,
}

impl Run for SkillsActivate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // A skill reaches every task of its harness or project, Full access ones too.
            super::terminal::require_full_access_to(ctx.full_access, CHANGE_SKILLS)?;
            let root = match &self.target {
                Some(target) => Some(resolve(&ctx.state(), target).await?.1),
                None => None,
            };
            let app = ctx.app.clone();
            let SkillsActivate { id, harness, scope, active, .. } = *self;
            crate::blocking(move || {
                let library = crate::skills::library(&app)?;
                // Never acknowledges safety findings: that stays a decision made at the computer.
                let change = if active { library.activate(&id, &harness, scope, root.as_deref(), false) } else { library.deactivate(&id, &harness, scope, root.as_deref()) };
                let change = change.map_err(|error| if error.contains("acknowledge") || error.contains("finding") { format!("Review this skill's safety findings in PandaCode on the computer first. ({error})") } else { error })?;
                Ok(json!({"kept": change.kept}))
            })
            .await
        })
    }
}

// ---- runScript.get / runScript.start / localServers.list ----

fn ids(target: &Target, project_id: String) -> (String, Option<String>) {
    match target {
        Target::Task(session_id) => (project_id, Some(session_id.clone())),
        Target::Project(_) => (project_id, None),
    }
}

/// Whether `runScript.get` names the running script's terminal: only to a device that may
/// stop it (`runScript.stop` is Full and needs the host switch).
fn shows_running_script(full_access: bool, scope: Option<&str>) -> bool {
    full_access && scope == Some("full")
}

#[derive(Debug, PartialEq)]
struct RunScriptGet {
    target: Target,
}

impl Run for RunScriptGet {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            // Round 12: the running script's terminal, so the phone can offer Stop. Only when
            // the device could call `runScript.stop`: the host switch on and a Full grant.
            let shows = shows_running_script(ctx.full_access, super::super::grants::scope_name(ctx.app, ctx.from));
            let running = if shows { super::terminal::running_run_script(&ctx.state(), &root).await? } else { None };
            let script = crate::blocking(move || crate::run_script::inspect(&root)).await?;
            Ok(json!({"script": script, "running": running.map(|terminal_id| json!({"terminalId": terminal_id}))}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct RunScriptStart {
    target: Target,
}

impl Run for RunScriptStart {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // The script runs in a shell like `terminal.open`, so it needs the same Full access.
            super::terminal::require_full_access_to(ctx.full_access, super::terminal::RUN_SCRIPTS)?;
            // Resolving first refuses bot workspaces and mirrored tasks.
            let (project_id, _) = resolve(&ctx.state(), &self.target).await?;
            let (project_id, session_id) = ids(&self.target, project_id);
            let terminal_id = crate::start_run_script_terminal(ctx.app.clone(), ctx.state(), project_id, session_id, None, SCRIPT_COLS, SCRIPT_ROWS).await?;
            Ok(json!({"status": "started", "terminalId": terminal_id}))
        })
    }
}

/// `runScript.stop`: closes a run script the phone (or the desktop) started. Like
/// `runScript.start` it needs Full and the host switch, and it only ever closes a terminal
/// whose kind is `script`, never a shell or a harness console.
#[derive(Debug, PartialEq)]
struct RunScriptStop {
    terminal_id: String,
}

impl Run for RunScriptStop {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            super::terminal::require_full_access_to(ctx.full_access, super::terminal::RUN_SCRIPTS)?;
            super::terminal::close_run_script(&ctx.state(), self.terminal_id).await?;
            Ok(json!({"status": "stopped"}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct LocalServers;

impl Run for LocalServers {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let servers = crate::local_servers::list().await?;
            let mut list: Vec<Value> = servers.into_iter().map(|s| json!({"port": s.port, "process": s.process, "url": s.url})).collect();
            fit(&mut list, "servers");
            Ok(json!({"servers": list}))
        })
    }
}

// ---- parsing ----

fn session(p: &Value) -> Result<String> {
    id_param(p, "sessionId")
}

fn recipe_name(p: &Value) -> Result<String> {
    let name = p.get("name").and_then(Value::as_str).filter(|name| crate::recipes::valid_name(name)).ok_or("Invalid recipe name.")?;
    Ok(name.to_owned())
}

fn optional_target(p: &Value) -> Result<Option<Target>> {
    let given = |key: &str| p.get(key).is_some_and(|v| !v.is_null());
    if given("sessionId") || given("projectId") { target_param(p).map(Some) } else { Ok(None) }
}

fn parse_progress_image(p: &Value, full: bool) -> Result<Box<dyn Run>> {
    Ok(Box::new(ProgressImage { session_id: session(p)?, id: id_param(p, "id")?, full, offset: offset_param(p)? }))
}

fn parse_skills_activate(p: &Value) -> Result<Box<dyn Run>> {
    let scope = match p.get("scope").and_then(Value::as_str) {
        Some("user") => crate::skills::Scope::User,
        Some("project") => crate::skills::Scope::Project,
        _ => return Err("Invalid scope.".into()),
    };
    let target = optional_target(p)?;
    if scope == crate::skills::Scope::Project && target.is_none() {
        return Err("Choose a project for a project skill.".into());
    }
    Ok(Box::new(SkillsActivate {
        id: id_param(p, "id")?,
        harness: name_param(p, "harness")?.ok_or("Missing harness.")?,
        scope,
        target,
        active: p.get("active").and_then(Value::as_bool).ok_or("Missing active.")?,
    }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "progress.list", access: Access::View, read_only: true, parse: |p| Ok(Box::new(ProgressList { session_id: session(p)? })) },
    Method { name: "progress.thumb", access: Access::View, read_only: true, parse: |p| parse_progress_image(p, false) },
    Method { name: "progress.media", access: Access::View, read_only: true, parse: |p| parse_progress_image(p, true) },
    Method { name: "checks.plan", access: Access::View, read_only: true, parse: |p| Ok(Box::new(ChecksPlan { session_id: session(p)? })) },
    // Runs the repo's check commands with no approval step, like runScript.start: Full only.
    Method { name: "checks.run", access: Access::Full, read_only: false, parse: |p| Ok(Box::new(ChecksRun { session_id: session(p)? })) },
    Method { name: "recipes.list", access: Access::View, read_only: true, parse: |p| Ok(Box::new(RecipesList { target: target_param(p)? })) },
    Method { name: "recipes.plan", access: Access::View, read_only: true, parse: |p| Ok(Box::new(RecipesPlan { session_id: session(p)?, name: recipe_name(p)? })) },
    Method { name: "recipes.run", access: Access::Control, read_only: false, parse: |p| Ok(Box::new(RecipesRun { session_id: session(p)?, name: recipe_name(p)?, send_id: super::send_id_param(p)? })) },
    Method { name: "skills.list", access: Access::View, read_only: true, parse: |p| Ok(Box::new(SkillsList { target: optional_target(p)? })) },
    // Turning a skill on at user scope changes every project's harness: Full only.
    Method { name: "skills.activate", access: Access::Full, read_only: false, parse: parse_skills_activate },
    Method { name: "runScript.get", access: Access::View, read_only: true, parse: |p| Ok(Box::new(RunScriptGet { target: target_param(p)? })) },
    // Runs the project's own script in a terminal on the computer: an effect beyond any task.
    Method { name: "runScript.start", access: Access::Full, read_only: false, parse: |p| Ok(Box::new(RunScriptStart { target: target_param(p)? })) },
    Method { name: "runScript.stop", access: Access::Full, read_only: false, parse: |p| Ok(Box::new(RunScriptStop { terminal_id: id_param(p, "terminalId")? })) },
    // Every listening process on the computer (ports, process names, URLs): beyond what a
    // View device's tasks show, so Control.
    Method { name: "localServers.list", access: Access::Control, read_only: true, parse: |_| Ok(Box::new(LocalServers)) },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Round 12/13: `runScript.get` names the running script's terminal only to a device that
    /// could stop it: the switch on and a Full grant.
    #[test]
    fn run_script_get_names_the_terminal_only_to_full_devices_with_the_switch_on() {
        assert!(shows_running_script(true, Some("full")));
        assert!(!shows_running_script(false, Some("full")), "switch off");
        assert!(!shows_running_script(true, Some("control")), "a Control grant cannot stop it");
        assert!(!shows_running_script(true, Some("view")));
        assert!(!shows_running_script(true, None));
        let source = include_str!("tools.rs");
        let body = &source[source.find("impl Run for RunScriptGet").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("shows_running_script(ctx.full_access, super::super::grants::scope_name(ctx.app, ctx.from))"));
        assert!(body.contains("let running = if shows { super::terminal::running_run_script(&ctx.state(), &root).await? } else { None };"));
        assert!(body.contains(r#""running": running.map("#));
    }

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (super::super::find(name).unwrap().parse)(&params)
    }

    #[test]
    fn a_recipe_that_already_sent_a_step_reports_a_later_failure_as_partial() {
        assert_eq!(recipe_outcome(2, 1, None).unwrap(), json!({"sent": 2, "queued": 1}));
        assert_eq!(recipe_outcome(0, 0, Some("boom".into())).unwrap_err(), "boom", "nothing went: a plain error");
        let partial = recipe_outcome(1, 0, Some("boom".into())).unwrap();
        assert_eq!(partial, json!({"sent": 1, "queued": 0, "partialError": "boom"}), "remembered, so a retry does not resend step 1");
        assert_eq!(recipe_outcome(0, 2, Some("x".into())).unwrap()["partialError"], "x");
    }

    #[test]
    fn scopes_match_what_each_method_does() {
        for method in METHODS {
            let expected = match method.name {
                "recipes.run" | "localServers.list" => Access::Control,
                // Repo commands without approval, and skills for every project: like runScript.start.
                "checks.run" | "skills.activate" | "runScript.start" | "runScript.stop" => Access::Full,
                _ => Access::View,
            };
            assert_eq!(method.access, expected, "{}", method.name);
            assert_eq!(method.read_only, expected == Access::View || method.name == "localServers.list", "{}", method.name);
        }
    }

    #[test]
    fn run_script_start_needs_full_access_for_remote_tasks() {
        let source = include_str!("tools.rs");
        let body = &source[source.find("impl Run for RunScriptStart").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let gate = body.find("require_full_access_to(ctx.full_access, ").expect("runScript.start checks Full access");
        assert!(gate < body.find("start_run_script_terminal").unwrap(), "checked before the script starts");
        assert!(super::super::terminal::require_full_access(false).is_err());
    }

    /// Round 11: stopping a run script needs Full and the switch, and closes only a `script`
    /// terminal through the terminal methods' close path.
    #[test]
    fn run_script_stop_needs_the_switch_and_only_closes_run_scripts() {
        let source = include_str!("tools.rs");
        let body = &source[source.find("impl Run for RunScriptStop").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let gate = body.find("require_full_access_to(ctx.full_access, ").expect("runScript.stop checks Full access");
        assert!(gate < body.find("close_run_script").unwrap());
        assert!(super::super::SWITCH_METHODS.contains(&"runScript.stop"));
        assert_eq!(super::super::lane_for("runScript.stop"), None);
        let terminal = include_str!("terminal.rs");
        let close = &terminal[terminal.find("pub(super) async fn close_run_script").unwrap()..];
        let close = &close[..close.find("\n}\n").unwrap()];
        assert!(close.find("is_run_script(&info) || visible(state, info)").unwrap() < close.find("crate::terminal::close(").unwrap());
        assert_eq!(format!("{:?}", (super::super::find("runScript.stop").unwrap().parse)(&json!({"terminalId": "t1"})).unwrap()), r#"RunScriptStop { terminal_id: "t1" }"#);
        assert!(parse("runScript.stop", json!({})).is_err());
    }

    #[test]
    fn checks_run_needs_full_access_for_remote_tasks() {
        let source = include_str!("tools.rs");
        let body = &source[source.find("impl Run for ChecksRun").unwrap()..source.find("// ---- recipes.list").unwrap()];
        let gate = body.find("require_full_access_to(ctx.full_access, ").expect("checks.run checks Full access");
        assert!(gate < body.find("crate::checks::turn_report").unwrap(), "the gate comes before the checks run");
        assert_eq!(super::super::find("checks.run").unwrap().access, Access::Full);
    }

    #[test]
    fn skills_activate_needs_full_access_for_remote_tasks() {
        let source = include_str!("tools.rs");
        let body = &source[source.find("impl Run for SkillsActivate").unwrap()..source.find("// ---- runScript.get").unwrap()];
        let gate = body.find("require_full_access_to(ctx.full_access, CHANGE_SKILLS)").expect("skills.activate checks the switch");
        assert!(gate < body.find("crate::skills::library").unwrap(), "the gate comes before the library changes");
        assert!(super::super::SWITCH_METHODS.contains(&"skills.activate"));
        assert_eq!(super::super::terminal::require_full_access_to(false, CHANGE_SKILLS).unwrap_err(), "Turn on Full access for remote tasks on this computer to change skills.");
    }

    #[test]
    fn recipes_run_sends_under_the_task_lock_and_takes_a_send_id() {
        let source = include_str!("tools.rs");
        let body = &source[source.find("async fn run_recipe").unwrap()..source.find("// ---- skills.list").unwrap()];
        let lock = body.find("task_send_lock(&session_id)").expect("recipes.run takes the task's send lock");
        assert!(lock < body.find("let busy").unwrap(), "before the busy check");
        let call = parse("recipes.run", json!({"sessionId": "s", "name": "ship-it", "sendId": "abc-1"})).unwrap();
        assert!(format!("{call:?}").contains("send_id: Some(\"abc-1\")"));
        assert!(parse("recipes.run", json!({"sessionId": "s", "name": "ship-it", "sendId": "bad id"})).is_err());
    }

    #[test]
    fn task_methods_need_a_valid_session() {
        for name in ["progress.list", "checks.plan", "checks.run"] {
            assert!(parse(name, json!({})).is_err(), "{name}");
            assert!(parse(name, json!({"sessionId": "bad id"})).is_err(), "{name}");
            assert!(parse(name, json!({"sessionId": "s1"})).is_ok(), "{name}");
        }
        assert!(parse("progress.thumb", json!({"sessionId": "s1"})).is_err(), "needs an id");
        assert!(parse("progress.media", json!({"sessionId": "s1", "id": "a", "offset": 4})).is_ok());
        assert!(parse("progress.media", json!({"sessionId": "s1", "id": "a", "offset": "4"})).is_err());
    }

    #[test]
    fn recipe_names_follow_the_desktop_rules() {
        assert!(parse("recipes.run", json!({"sessionId": "s", "name": "ship-it"})).is_ok());
        for name in ["../x", "Ship", "", "a b"] {
            assert!(parse("recipes.run", json!({"sessionId": "s", "name": name})).is_err(), "{name}");
        }
        assert!(parse("recipes.list", json!({})).is_err(), "needs a project or task");
        assert!(parse("recipes.list", json!({"projectId": "p"})).is_ok());
    }

    #[test]
    fn skills_list_sends_no_local_paths() {
        let home = Some("/Users/me");
        assert_eq!(shown_path("/Users/me/code/app", home), "~/code/app");
        assert_eq!(shown_path("/Users/me", Some("/Users/me/")), "~");
        assert_eq!(shown_path("/Users/meadow/app", home), "app", "not below home");
        assert_eq!(shown_path("/opt/skills/house", home), "house");
        assert_eq!(shown_path("/opt/skills/house", None), "house");
        let folder = crate::skills::Source { kind: "folder".into(), location: "/srv/x/rules".into(), git_ref: None, commit: None };
        assert_eq!(shown_source(&folder, home), "rules");
        let github = crate::skills::Source { kind: "github".into(), location: "acme/skills/deploy".into(), git_ref: None, commit: None };
        assert_eq!(shown_source(&github, home), "acme/skills/deploy");
        let source = include_str!("tools.rs");
        let code = &source[source.find("// ---- skills.list").unwrap()..source.find("struct SkillsActivate").unwrap()];
        assert!(!code.contains("\"source\": meta.source.location"));
        assert!(!code.contains("\"project\": matrix[\"project\"]"));
        // Round 24: each cell's surface too.
        assert!(!code.contains("\"cells\": row[\"cells\"]"));
        let cells = json!([
            {"id": "a", "scope": "user", "status": "active", "surface": "/Users/me/.claude/skills/a"},
            {"id": "a", "scope": "project", "status": "off", "surface": "/srv/work/app/CLAUDE.md"},
            {"id": "b", "scope": "user", "status": "prompt", "surface": "prompt"},
        ]);
        let shown = shown_cells(&cells, home);
        let surfaces: Vec<&str> = shown.as_array().unwrap().iter().map(|cell| cell["surface"].as_str().unwrap()).collect();
        assert_eq!(surfaces, ["~/.claude/skills/a", "CLAUDE.md", "prompt"]);
        assert_eq!(shown[0]["status"], "active", "other fields are kept");
        assert!(!shown.to_string().contains("/srv/") && !shown.to_string().contains("/Users/"));
    }

    #[test]
    fn skills_activation_is_validated() {
        let ok = json!({"id": "abc", "harness": "claude", "scope": "user", "active": true});
        assert!(parse("skills.activate", ok.clone()).is_ok());
        assert!(parse("skills.activate", json!({"id": "abc", "harness": "claude", "scope": "project", "active": true})).is_err(), "project scope needs a project");
        assert!(parse("skills.activate", json!({"id": "abc", "harness": "claude", "scope": "project", "projectId": "p", "active": false})).is_ok());
        assert!(parse("skills.activate", json!({"id": "abc", "harness": "claude", "scope": "global", "active": true})).is_err());
        assert!(parse("skills.activate", json!({"id": "abc", "scope": "user", "active": true})).is_err());
        assert!(parse("skills.activate", json!({"id": "abc", "harness": "claude", "scope": "user"})).is_err());
        assert!(parse("skills.list", json!({})).is_ok(), "user-level list needs no project");
    }

    /// Round 12: `recipes.plan` is View and `recipes.run` checks the mode, so neither may start
    /// slash-command discovery (the harness, inside the project) without the composer's gate.
    #[test]
    fn recipes_never_start_discovery_without_the_gate() {
        let source = include_str!("tools.rs");
        let plan = &source[source.find("async fn plan_for").unwrap()..];
        let plan = &plan[..plan.find("\n}\n").unwrap()];
        assert!(plan.contains("super::composer::task_catalog(ctx, session_id, &task.mode)"));
        let run = &source[source.find("async fn run_recipe").unwrap()..];
        assert!(run.find("allow_task_mode(&mode, None, ctx.full_access)?").unwrap() < run.find("plan_for(").unwrap(), "the mode check comes before the dry run");
    }

    #[test]
    fn run_script_needs_a_target() {
        assert!(parse("runScript.start", json!({})).is_err());
        assert!(parse("runScript.get", json!({"projectId": "p"})).is_ok());
        assert!(parse("localServers.list", json!({})).is_ok());
    }

    #[test]
    fn fit_drops_tail_entries_past_the_budget() {
        let mut list: Vec<Value> = (0..400).map(|i| json!({"i": i, "pad": "x".repeat(1000)})).collect();
        assert!(fit(&mut list, "items"));
        assert!(json!({"items": list}).to_string().len() <= PAGE_BUDGET);
        let mut small = vec![json!(1)];
        assert!(!fit(&mut small, "items"));
    }
}
