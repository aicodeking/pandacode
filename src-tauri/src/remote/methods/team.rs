//! Team tasks from a phone (docs/remote-access.md): `team.start` makes a task in a project and
//! starts its architect the way the desktop's Team button does (`architect_configure`, then
//! `architect_start_in_project`), and `team.roster` lists what a team may use here (installed
//! team harnesses and the named agent teams from Settings; never a secret).
//!
//! With no `profileId` the team is automatic: the task's own model leads and picks worker
//! models from every installed harness, as `autoTeamConfig` in src/main.ts builds it. A
//! `profileId` names a saved agent team, whose own lead and workers are used as on the desktop.
//! A `startId` runs the start once (`host::start_keyed`, shared with `task.start`, so
//! `task.startStatus` answers it too), and the method holds a Start lane slot.
use super::{full_access_off, id_param, name_param, valid_id, Access, Ctx, Method, Reply, Run};
use crate::architect::{self, profiles, TeamConfig, WorkerProfile};
use crate::remote::start::{self, Cancel, Start};
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// The desktop's `ROSTER_PER_HARNESS` / `ROSTER_MAX` (src/team-catalog.ts): what the lead sees.
const ROSTER_PER_HARNESS: usize = 6;
const ROSTER_MAX: usize = 24;
/// The desktop's `TEAM_LIMIT`: a harness offers teams at most this many models (plus `default`).
const TEAM_LIMIT: usize = 10;
/// `architect::validate_profiles` takes names of at most this many bytes here.
const NAME_BYTES: usize = 80;
const ID_BASE: usize = 72;
/// Named teams `team.roster` lists.
const MAX_PROFILES: usize = 100;

/// One installed harness and its models (id, name), in the order the harness lists them.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Harness {
    pub id: String,
    pub name: String,
    pub models: Vec<(String, String)>,
}

/// `text` cut to at most `max` UTF-8 bytes on a character boundary.
fn clip_bytes(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}

/// A worker id for `provider`'s `model`, as `buildTeamCatalog` makes it.
fn profile_base(provider: &str, model: &str) -> String {
    let mut base = String::new();
    for c in format!("{provider}-{model}").to_lowercase().chars() {
        let keep = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if keep {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base: String = base.trim_end_matches('-').chars().take(ID_BASE).collect();
    if base.is_empty() { provider.chars().take(ID_BASE).collect() } else { base }
}

/// The auto team's short roster and full catalog: every model of every harness (deduped, at most
/// [`TEAM_LIMIT`] per harness plus `default`), round-robin across harnesses so the pool cap never
/// drops one; the roster is each harness's first [`ROSTER_PER_HARNESS`]. Port of `buildTeamCatalog`.
pub(crate) fn build_catalog(harnesses: &[Harness]) -> (Vec<WorkerProfile>, Vec<WorkerProfile>) {
    let lists: Vec<Vec<&(String, String)>> = harnesses
        .iter()
        .map(|harness| {
            let mut seen = HashSet::new();
            let mut others = 0;
            harness
                .models
                .iter()
                .filter(|(id, _)| !id.is_empty() && id.len() <= 200 && !id.contains('\0') && seen.insert(id.clone()))
                .filter(|(id, _)| {
                    if id == "default" {
                        return true;
                    }
                    others += 1;
                    others <= TEAM_LIMIT
                })
                .collect()
        })
        .collect();
    let mut taken = HashSet::new();
    let mut catalog = Vec::new();
    let mut by_key = std::collections::HashMap::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    'fill: for position in 0..longest {
        for (harness, list) in harnesses.iter().zip(&lists) {
            if catalog.len() >= crate::model_routing::MAX_POOL {
                break 'fill;
            }
            let Some((model, name)) = list.get(position) else { continue };
            let base = profile_base(&harness.id, model);
            let mut id = base.clone();
            let mut n = 2;
            while taken.contains(&id) {
                let suffix = format!("-{n}");
                id = format!("{}{suffix}", base.chars().take(ID_BASE - suffix.len()).collect::<String>());
                n += 1;
            }
            taken.insert(id.clone());
            let label = if name.trim().is_empty() { model.as_str() } else { name.as_str() };
            let profile = WorkerProfile { id, name: clip_bytes(&format!("{label} · {}", harness.name), NAME_BYTES), provider: harness.id.clone(), model: model.clone(), reasoning_effort: None };
            by_key.insert((harness.id.clone(), model.clone()), catalog.len());
            catalog.push(profile);
        }
    }
    let mut roster = Vec::new();
    for (harness, list) in harnesses.iter().zip(&lists) {
        for (model, _) in list.iter().take(ROSTER_PER_HARNESS) {
            if let Some(&index) = by_key.get(&(harness.id.clone(), model.clone())) {
                if roster.len() < ROSTER_MAX {
                    roster.push(catalog[index].clone());
                }
            }
        }
    }
    (roster, catalog)
}

/// An automatic team over `harnesses`, keeping the limits of the last team setup (as the desktop does).
pub(crate) fn auto_config(harnesses: &[Harness], last: Option<&TeamConfig>) -> TeamConfig {
    let (workers, catalog) = build_catalog(harnesses);
    TeamConfig {
        auto: true,
        roster_only: false,
        name: None,
        workers,
        catalog,
        max_parallel: last.map_or(0, |c| c.max_parallel),
        max_rounds: last.map_or(8, |c| c.max_rounds),
        max_assignments: last.map_or(24, |c| c.max_assignments),
        workspace: "shared".into(),
        summary_limit: last.map_or(3072, |c| c.summary_limit),
        lead_guidance: None,
        // The phone has no Council controls, so its automatic teams never convene one.
        council: None,
    }
}

/// Installed harnesses that can work in a team, each with its models: the harness's discovered
/// list, or its built-in one when discovery fails.
async fn installed_harnesses(discover: bool) -> Vec<Harness> {
    let providers = crate::local_providers(false).await;
    let mut harnesses = Vec::new();
    for provider in providers.into_iter().filter(|p| p.installed && architect::HARNESSES.contains(&p.id.as_str())) {
        let models = if discover {
            match crate::local_provider_models(&provider.id, false).await {
                Ok(models) if !models.is_empty() => models,
                _ => provider.models,
            }
        } else {
            provider.models
        };
        harnesses.push(Harness { id: provider.id, name: provider.name, models: models.into_iter().map(|m| (m.id, m.name)).collect() });
    }
    harnesses
}

/// Without "Full access for remote tasks" a remote start may not ask for Full access, and gets
/// Ask when it names no mode (as `host::cap_mode` does for `task.start`).
pub(crate) fn capped_mode(mode: Option<String>, full_access: bool) -> Result<Option<String>> {
    match mode {
        _ if full_access => Ok(mode),
        Some(mode) if mode == "full" => Err(full_access_off()),
        Some(mode) => Ok(Some(mode)),
        None => Ok(Some("ask".into())),
    }
}

// ---- team.start ----

#[derive(Debug)]
struct TeamStart {
    /// Validated as `task.start` (project, prompt, lead provider and model, mode, effort, images, startId).
    start: Start,
    project_id: String,
    /// A named agent team from Settings; `None` for an automatic team.
    profile_id: Option<String>,
}

fn parse_team_start(params: &Value) -> Result<Box<dyn Run>> {
    if params.get("repo").is_some_and(|v| !v.is_null()) {
        return Err("A team starts in a project on the computer.".into());
    }
    if params["worktree"].as_bool().unwrap_or(false) || params.get("branch").is_some_and(|v| !v.is_null()) {
        return Err("A team starts in the project's own checkout.".into());
    }
    let project_id = id_param(params, "projectId")?;
    let start = start::parse(params)?;
    // Like `chat.start`: a start is never repeated, so a retry needs the id that names it.
    let start_id = start.start_id.as_deref().ok_or("Missing startId.")?;
    valid_id(start_id).map_err(|_| "Invalid startId.")?;
    let profile_id = name_param(params, "profileId")?;
    if let Some(id) = &profile_id {
        valid_id(id).map_err(|_| "Invalid profileId.")?;
    }
    let auto = match params.get("auto").filter(|v| !v.is_null()) {
        None => true,
        Some(value) => value.as_bool().ok_or("Invalid auto.")?,
    };
    if auto && profile_id.is_some() {
        return Err("Send either auto or profileId, not both.".into());
    }
    if !auto && profile_id.is_none() {
        return Err("Pick a team for this task.".into());
    }
    Ok(Box::new(TeamStart { start, project_id, profile_id }))
}

impl Run for TeamStart {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let mut request = *self;
            request.start.mode = capped_mode(request.start.mode.take(), ctx.full_access)?;
            // The switch as admitted decides the checkout gate below, as for `task.start`.
            request.start.full_access = Some(ctx.full_access);
            let (app, from) = (ctx.app.clone(), ctx.from.to_owned());
            let id = request.start.start_id.clone().ok_or("Missing startId.")?;
            super::super::host::start_keyed(ctx.from, &id, move |cancel| async move { start_team(&app, &from, request, cancel).await }).await
        })
    }
}

/// The team setup a start uses: a saved named team (its lead and config), or an automatic one.
async fn team_setup(app: &tauri::AppHandle, profile_id: Option<&str>) -> Result<(TeamConfig, Option<profiles::ModelSelection>)> {
    let library = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        profiles::read(&store)?
    };
    if let Some(id) = profile_id {
        let profile = library.profiles.into_iter().find(|p| p.id == id).ok_or_else(|| format!("That team is no longer on {}.", super::super::config::device_name()))?;
        return Ok((profile.setup.config, Some(profile.setup.architect)));
    }
    let harnesses = installed_harnesses(true).await;
    Ok((auto_config(&harnesses, library.last_setup.as_ref().map(|s| &s.config)), None))
}

/// A bot's workspace is the bot's own, never a remote task's (as `remote::start` refuses it).
fn refuse_bot_project(bot_projects: &[String], project_id: &str) -> Result<()> {
    if bot_projects.iter().any(|bot_project| bot_project == project_id) {
        return Err(BOT_WORKSPACE.into());
    }
    Ok(())
}

const BOT_WORKSPACE: &str = "Bot workspaces cannot be used for remote tasks.";

/// The team's workers get worktrees of the project's checkout made with Desktop trust
/// (`architect_start_in_project`), so with "Full access for remote tasks" off a checkout whose
/// own config could run a program is refused before anything is made, as `task.start` refuses
/// it ([`crate::workspace::refuse_untrusted_programs`]; a no-op with the switch on).
fn refuse_untrusted_checkout(root: &std::path::Path, full_access: bool) -> Result<()> {
    crate::workspace::refuse_untrusted_programs(root, crate::workspace::Trust::phone(full_access))
}

/// Makes the team's task and configures its team, before its images are used: on an error
/// nothing is left behind (a task that never got its team is deleted).
async fn prepare_team(app: &tauri::AppHandle, from: &str, start: &start::Start, project_id: &str, profile_id: Option<String>, cancel: &Cancel) -> Result<crate::storage::Session> {
    start::require_installed(&start.provider).await?;
    let (config, lead) = team_setup(app, profile_id.as_deref()).await?;
    // From here the task is made, so a cancel arriving now is answered "too late".
    cancel.commit()?;
    let task = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.project(project_id).map_err(|_| "That project is no longer on this computer.".to_string())?;
        start::create_task(&store, project_id, start)?
    };
    // The caller mirrors the task from its first event.
    super::super::host::follow(app, from, &task.id);
    if let Err(error) = architect::architect_configure(app.clone(), app.state(), task.id.clone(), Some(config), lead, profile_id).await {
        // A task that never got its team would run as a single agent: it goes again.
        let _ = crate::task_deletion::delete_state(&app.state::<AppState>(), &task.id);
        let _ = app.emit("sessions-changed", ());
        return Err(error);
    }
    Ok(task)
}

async fn start_team(app: &tauri::AppHandle, from: &str, request: TeamStart, cancel: Arc<Cancel>) -> Result<Value> {
    let TeamStart { start, project_id, profile_id } = request;
    let root = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        refuse_bot_project(&crate::bots::project_ids(&store)?, &project_id)?;
        let project = store.project(&project_id).map_err(|_| "That project is no longer on this computer.".to_string())?;
        std::path::PathBuf::from(project.path)
    };
    let full_access = start.full_access.unwrap_or(false);
    crate::blocking(move || refuse_untrusted_checkout(&root, full_access)).await?;
    // Before anything is made: the images must be ones this caller just sent. Until the lead
    // gets them, a failure gives them back so a retry finds them.
    super::super::images::claim(app, from, &start.image_ids)?;
    let task = match prepare_team(app, from, &start, &project_id, profile_id, &cancel).await {
        Ok(task) => task,
        Err(error) => {
            super::super::images::restore(app, from, &start.image_ids);
            return Err(error);
        }
    };
    let _ = app.emit("sessions-changed", ());
    architect::architect_start_in_project(app.clone(), app.state(), task.id.clone(), start.prompt, Some(start.image_ids), Some(project_id)).await?;
    Ok(json!({"sessionId": task.id}))
}

// ---- team.roster ----

#[derive(Debug)]
struct Roster;

/// What a phone shows for a team: installed team harnesses (id, name, model count) and the named teams.
fn roster_reply(harnesses: &[Harness], library: &profiles::TeamLibrary) -> Value {
    let harnesses: Vec<Value> = harnesses.iter().map(|h| json!({"id": h.id, "name": h.name, "models": h.models.len()})).collect();
    let teams: Vec<Value> = library
        .profiles
        .iter()
        .take(MAX_PROFILES)
        .map(|p| {
            json!({
                "id": p.id,
                "name": clip_bytes(&p.name, 200),
                "auto": p.setup.config.auto,
                "workers": p.setup.config.workers.len(),
                "lead": {"provider": p.setup.architect.provider, "model": p.setup.architect.model},
            })
        })
        .collect();
    json!({"harnesses": harnesses, "teams": teams})
}

impl Run for Roster {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let library = {
                let state = ctx.state();
                let store = state.store.lock().map_err(|e| e.to_string())?;
                profiles::read(&store)?
            };
            let harnesses = installed_harnesses(false).await;
            Ok(roster_reply(&harnesses, &library))
        })
    }
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "team.start", access: Access::Full, read_only: false, parse: parse_team_start },
    Method { name: "team.roster", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Roster)) },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_team_start_that_fails_before_using_its_images_gives_them_back() {
        let source = include_str!("team.rs");
        let body = &source[source.find("async fn start_team").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let claim = body.find("images::claim(app, from, &start.image_ids)").unwrap();
        let restore = body.find("images::restore(app, from, &start.image_ids)").expect("restored on failure");
        assert!(claim < restore && restore < body.find("architect_start_in_project(").unwrap());
    }

    #[test]
    fn a_team_start_checks_the_checkout_before_making_anything() {
        let source = include_str!("team.rs");
        let body = &source[source.find("async fn start_team").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let refuse = body.find("refuse_untrusted_checkout(&root, full_access)").expect("checkout gate");
        assert!(refuse < body.find("images::claim(").unwrap());
        assert!(refuse < body.find("prepare_team(").unwrap());
        let run = &source[source.find("impl Run for TeamStart").unwrap()..];
        assert!(run[..run.find("start_keyed(").unwrap()].contains("request.start.full_access = Some(ctx.full_access)"));
    }

    #[cfg(unix)]
    #[test]
    fn an_untrusted_phone_cannot_start_a_team_in_a_checkout_whose_config_runs_programs() {
        let git = |dir: &std::path::Path, args: &[&str]| {
            let status = std::process::Command::new("git").current_dir(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
            assert!(status.success(), "git {args:?}");
        };
        let base = std::env::temp_dir().join(format!("pandacode-team-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        git(&base, &["init", "-q"]);
        assert!(refuse_untrusted_checkout(&base, false).is_ok(), "a plain checkout starts");
        git(&base, &["config", "filter.mark.clean", "cat"]);
        let refused = refuse_untrusted_checkout(&base, false).unwrap_err();
        assert!(refused.contains("filter.mark.clean"), "{refused}");
        assert!(refuse_untrusted_checkout(&base, true).is_ok(), "Full access on trusts the checkout");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn parsed(params: Value) -> Result<String> {
        super::super::parse("team.start", &params).expect("registered").map(|p| format!("{:?}", p.call))
    }

    fn ok() -> Value {
        json!({"projectId": "p1", "prompt": "Build it", "provider": "claude", "model": "opus", "startId": "s-1"})
    }

    fn harness(id: &str, models: &[&str]) -> Harness {
        Harness { id: id.into(), name: id.to_uppercase(), models: models.iter().map(|m| (m.to_string(), format!("{m} name"))).collect() }
    }

    #[test]
    fn methods_are_registered_with_their_grants_and_lanes() {
        let start = super::super::find("team.start").unwrap();
        assert_eq!(start.access, Access::Full);
        assert!(!start.read_only);
        assert_eq!(super::super::lane_for("team.start"), Some(super::super::Lane::Start));
        let roster = super::super::find("team.roster").unwrap();
        assert_eq!(roster.access, Access::View);
        assert!(roster.read_only);
    }

    #[test]
    fn team_starts_are_validated() {
        let text = parsed(ok()).unwrap();
        assert!(text.contains("s-1") && text.contains("profile_id: None"), "{text}");
        let named = parsed(json!({"projectId": "p1", "prompt": "x", "provider": "claude", "model": "m", "auto": false, "profileId": "team-1", "startId": "s-2"})).unwrap();
        assert!(named.contains("team-1"));
        for (change, why) in [
            (json!({"projectId": null}), "no project"),
            (json!({"repo": "octo/app"}), "repo"),
            (json!({"worktree": true}), "worktree"),
            (json!({"branch": "dev"}), "branch"),
            (json!({"prompt": ""}), "empty prompt"),
            (json!({"provider": null}), "no provider"),
            (json!({"model": null}), "no model"),
            (json!({"mode": "a b"}), "bad mode"),
            (json!({"startId": "a b"}), "bad startId"),
            (json!({"startId": null}), "no startId (round 8: required, like chat.start)"),
            (json!({"profileId": "a b", "auto": false}), "bad profile"),
            (json!({"profileId": "t1"}), "auto and profile"),
            (json!({"auto": false}), "no team"),
            (json!({"auto": "yes"}), "bad auto"),
            (json!({"imageIds": "x"}), "bad images"),
        ] {
            let mut params = ok();
            for (key, value) in change.as_object().unwrap() {
                params[key] = value.clone();
            }
            assert!(parsed(params).is_err(), "{why}");
        }
    }

    #[test]
    fn full_access_is_capped_without_the_host_setting() {
        assert!(capped_mode(Some("full".into()), false).is_err());
        assert_eq!(capped_mode(None, false).unwrap().as_deref(), Some("ask"));
        assert_eq!(capped_mode(Some("edit".into()), false).unwrap().as_deref(), Some("edit"));
        assert_eq!(capped_mode(Some("full".into()), true).unwrap().as_deref(), Some("full"));
        assert_eq!(capped_mode(None, true).unwrap(), None);
    }

    #[tokio::test]
    async fn a_repeated_start_id_runs_the_start_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let runs = Arc::new(AtomicUsize::new(0));
        let start = |runs: Arc<AtomicUsize>| {
            move |_cancel| async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"sessionId": "t1"}))
            }
        };
        let first = super::super::super::host::start_keyed("phone-team", "team-once", start(runs.clone())).await.unwrap();
        let again = super::super::super::host::start_keyed("phone-team", "team-once", start(runs.clone())).await.unwrap();
        assert_eq!(first, again);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(super::super::super::host::start_keyed("other-phone", "team-once", start(runs.clone())).await.is_err(), "another viewer's id");
    }

    #[test]
    fn the_auto_catalog_round_robins_dedupes_and_caps() {
        let many: Vec<String> = (0..15).map(|n| format!("m{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        let harnesses = [harness("claude", &["default", "opus", "opus", "Sonnet 4.5"]), harness("codex", &many)];
        let (roster, catalog) = build_catalog(&harnesses);
        let ids: Vec<&str> = catalog.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(&ids[..4], ["claude-default", "codex-m0", "claude-opus", "codex-m1"]);
        assert!(ids.contains(&"claude-sonnet-4-5"));
        assert_eq!(catalog.iter().filter(|w| w.provider == "codex").count(), TEAM_LIMIT);
        assert_eq!(catalog.len(), 3 + TEAM_LIMIT);
        assert_eq!(roster.len(), 3 + ROSTER_PER_HARNESS);
        assert_eq!(catalog[1].name, "m0 name · CODEX");
        let config = auto_config(&harnesses, None);
        assert!(config.auto && config.workspace == "shared" && config.max_parallel == 0);
        assert_eq!(config.workers, roster);
    }

    #[test]
    fn catalog_ids_stay_unique_and_valid() {
        let harnesses = [harness("claude", &["a/b", "a.b", "a b", "A_B"])];
        let (_, catalog) = build_catalog(&harnesses);
        let ids: HashSet<&str> = catalog.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids.len(), 4);
        assert!(catalog.iter().all(|w| w.id.len() <= 80 && w.id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))));
        assert_eq!(clip_bytes("ééé", 5), "éé");
    }

    #[test]
    fn the_roster_lists_harnesses_and_named_teams_only() {
        let library = profiles::TeamLibrary::default();
        let reply = roster_reply(&[harness("claude", &["opus"])], &library);
        assert_eq!(reply, json!({"harnesses": [{"id": "claude", "name": "CLAUDE", "models": 1}], "teams": []}));
    }

    #[test]
    fn bot_workspaces_cannot_take_a_team() {
        let bots = vec!["bot-project".to_owned()];
        assert_eq!(refuse_bot_project(&bots, "bot-project"), Err(BOT_WORKSPACE.into()));
        assert_eq!(refuse_bot_project(&bots, "p1"), Ok(()));
        assert_eq!(refuse_bot_project(&[], "p1"), Ok(()));
    }
}
