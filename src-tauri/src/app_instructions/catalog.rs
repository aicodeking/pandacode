//! Which optional tool families a turn lists, and which listed tools it refuses.
//!
//! A resumed session never loses a tool definition it may already hold: Claude can keep a
//! ToolSearch `tool_reference` in resumed history (`session_titles::with_host`), and removing
//! that definition invalidates later requests. So a family the turn does not want (a worker's
//! titles, schedules or agent-made tools, a read-only worker's writes, `pandacode_explore`
//! after the Local code explorer was turned off) stays listed on a resumed turn whenever the
//! conversation may hold it, and every call to it is refused (`refuse_tools`). A new
//! conversation holds nothing, so it lists only what it wants. A family whose wanted listing
//! shrinks from turn to turn (agent-made tools in Plan mode or with no tool left) keeps the
//! names it left out the same way (`Layers::hold`), with their real definitions in their usual
//! place, so switching to Plan mode does not rewrite a harness's cached tool list. A new
//! conversation that starts in Plan mode lists what a Standard turn would (refusing what Plan
//! does not offer) for the same reason: Plan-then-implement must not change the list either.
//!
//! What a conversation may hold is remembered per task (`remember`, persisted by
//! `session_state`, so a restart keeps it): the names its turns listed since it started or
//! resumed. For a conversation with no record (a missing or corrupt state file, an evicted
//! entry) the history is unknown, and every family a layer can add is kept. Codex sends dynamic tools only when its thread starts, so a family that can
//! become wanted later in the same conversation (`flips`: a read-only worker's writes) is listed
//! from a Codex thread's first turn.
//!
//! Claude's deferred native tools follow the same history (`History::lists_native`): `remember`
//! also records the ones a launch left defined, so a conversation keeps the deny set it started
//! with. Unknown history lists them all, because a missing definition breaks a request while an
//! extra one costs a single cache miss.
use crate::providers::ToolHost;
use serde_json::Value;
use crate::session_state::{self, Listed};
use std::collections::HashSet;

/// The description of a held tool whose real definition could not be read (no catalog this
/// turn): a stub is still better than removing a definition the conversation may hold.
const HELD_DESCRIPTION: &str = "Not available in this turn.";
/// The agent-made tools; which of them a turn offers depends on its mode and catalog.
const CUSTOM_TOOLS: [&str; 3] = [crate::custom_tools::TOOL_LIST, crate::custom_tools::TOOL_SAVE, crate::custom_tools::TOOL_RUN];

/// The tool names a session's conversation may hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct History {
    /// `None` when unknown (a resumed conversation with no listing recorded for it: never listed,
    /// or its record was lost, evicted or deleted).
    known: Option<HashSet<String>>,
    codex: bool,
    /// The launch continues a conversation, even one that holds nothing.
    resumed: bool,
}

impl History {
    /// A new conversation (`resume_id` `None`) holds nothing; a resumed one holds what was
    /// listed for it, if the listing was for this conversation (or the new one that became it),
    /// else is unknown. A new conversation's listing belongs to the first conversation id it is
    /// resumed as (bound here), so a later, different conversation is unknown.
    pub(crate) fn of(session_id: &str, provider: &str, resume_id: Option<&str>) -> Self {
        session_state::update_now(session_id, |task| {
            if let (Some(resume), Some(listed)) = (resume_id, task.listed.as_mut().filter(|listed| listed.on.is_none())) {
                listed.on = Some(resume.to_owned());
            }
            Self::from_listed(task.listed.as_ref(), provider, resume_id)
        })
    }
    /// `of` over a task's recorded listing.
    pub(crate) fn from_listed(listed: Option<&Listed>, provider: &str, resume_id: Option<&str>) -> Self {
        let codex = provider == "codex";
        let Some(resume) = resume_id else { return Self::fresh(codex) };
        let known = listed.filter(|listed| listed.on.as_deref().is_none_or(|on| on == resume)).map(|listed| listed.names.iter().cloned().collect());
        Self { known, codex, resumed: true }
    }
    pub(crate) fn fresh(codex: bool) -> Self {
        Self { known: Some(HashSet::new()), codex, resumed: false }
    }
    #[cfg(test)]
    pub(crate) fn unknown(codex: bool) -> Self {
        Self { known: None, codex, resumed: true }
    }
    #[cfg(test)]
    pub(crate) fn holding(names: &[&str]) -> Self {
        Self { known: Some(names.iter().map(|name| (*name).to_owned()).collect()), codex: false, resumed: true }
    }
    /// Whether an unwanted family may still have to be listed (before building it).
    pub(crate) fn may_hold(&self, flips: bool) -> bool {
        (self.codex && flips) || self.known.as_ref().is_none_or(|known| !known.is_empty())
    }
    /// Whether an unwanted family that adds `added` must stay listed.
    fn keeps(&self, added: &HashSet<String>, flips: bool) -> bool {
        (self.codex && flips) || self.known.as_ref().is_none_or(|known| !known.is_disjoint(added))
    }
    /// Whether the conversation may hold `name`; unknown history can only hold a tool the run
    /// could have been `offered`.
    fn holds(&self, name: &str, offered: bool) -> bool {
        self.known.as_ref().map_or(offered, |known| known.contains(name))
    }
    /// Whether a Claude launch leaves the deferred native tool `name` defined. A new conversation
    /// follows the role (`denied`); a resumed one keeps what it started with, whatever the role
    /// says now; unknown history keeps every definition.
    pub(crate) fn lists_native(&self, name: &str, denied: bool) -> bool {
        if !self.resumed {
            return !denied;
        }
        self.known.as_ref().is_none_or(|known| known.contains(name))
    }
}

/// Records what this turn lists, so a later resumed turn knows what its conversation holds.
/// A resumed turn lists everything its conversation may hold, so this replaces the entry.
/// `natives`: the deferred native tools the launch leaves defined (`History::lists_native`).
#[cfg(test)]
pub(crate) fn remember(session_id: &str, resume_id: Option<&str>, host: Option<&ToolHost>, natives: &[String]) {
    remember_listed(session_id, listing(resume_id, host, natives));
}

/// `remember` with the listing already built, writing the file before it returns (a restart
/// must never trust an older, narrower listing). The launch runs it on a blocking thread
/// beside the harness's start and joins it before the turn ends (`lib.rs`): the harness
/// persists nothing of the conversation within the milliseconds the write takes.
pub(crate) fn remember_listed(session_id: &str, listed: Listed) {
    session_state::update_now(session_id, |task| task.listed = Some(listed));
}

/// What `remember` records for a turn.
pub(crate) fn listing(resume_id: Option<&str>, host: Option<&ToolHost>, natives: &[String]) -> Listed {
    let names = names(host).into_iter().chain(natives.iter().cloned()).collect();
    Listed { on: resume_id.map(str::to_owned), names }
}

/// Forgets deleted tasks.
pub(crate) fn forget(session_ids: &[String]) {
    session_state::clear(session_ids, |task| task.listed = None);
    crate::custom_tools::forget(session_ids);
}

fn names(host: Option<&ToolHost>) -> HashSet<String> {
    host.into_iter().flat_map(|host| host.tools.iter()).filter_map(|tool| tool["name"].as_str()).map(str::to_owned).collect()
}

/// Builds a turn's optional families, collecting the listed names it must refuse.
pub(crate) struct Layers<'a> {
    history: &'a History,
    refused: HashSet<String>,
}

impl<'a> Layers<'a> {
    pub(crate) fn new(history: &'a History) -> Self {
        Self { history, refused: HashSet::new() }
    }

    /// Adds one family: always when `wanted`; otherwise only when the conversation may hold
    /// it, with every name it adds refused. `flips`: the family can become wanted later in
    /// the same conversation (see the module doc on Codex).
    pub(crate) fn add(&mut self, host: Option<ToolHost>, wanted: bool, flips: bool, layer: impl FnOnce(Option<ToolHost>) -> Option<ToolHost>) -> Option<ToolHost> {
        if wanted {
            return layer(host);
        }
        if !self.history.may_hold(flips) {
            return host;
        }
        let before = names(host.as_ref());
        let after = layer(host.clone());
        let added: HashSet<String> = names(after.as_ref()).difference(&before).cloned().collect();
        if !self.history.keeps(&added, flips) {
            return host;
        }
        self.refused.extend(added);
        after
    }

    /// Like `add` for tools an always-listed layer already added (`subset`, such as the design
    /// writes): dropped from the catalog unless wanted or possibly held, then refused.
    pub(crate) fn subset(&mut self, host: Option<ToolHost>, wanted: bool, flips: bool, subset: &'static [&'static str]) -> Option<ToolHost> {
        if wanted {
            return host;
        }
        let present: HashSet<String> = names(host.as_ref()).into_iter().filter(|name| subset.contains(&name.as_str())).collect();
        if self.history.keeps(&present, flips) {
            self.refused.extend(present);
            return host;
        }
        super::without_tools(host, subset)
    }

    /// Lists each of `family` that this turn's layers left out but the conversation may hold,
    /// with its real entry from `definitions`, and refuses its calls. Called right after the
    /// family's layer: the family ends the host, in `family`'s order, exactly as a turn offering
    /// all of it lists it. `offered`: the run could list the family at all. `standard`: names
    /// kept whatever the history, because a later turn of this conversation will list them.
    pub(crate) fn hold(&mut self, host: Option<ToolHost>, definitions: &[Value], family: &[&str], offered: bool, standard: &[String]) -> Option<ToolHost> {
        let history = self.history;
        let listed = names(host.as_ref());
        let held: Vec<&str> = family.iter().copied().filter(|name| !listed.contains(*name) && (history.holds(name, offered) || standard.iter().any(|kept| kept == name))).collect();
        if held.is_empty() {
            return host;
        }
        self.refused.extend(held.iter().map(|name| (*name).to_owned()));
        let host = host.unwrap_or_else(empty_host);
        let named = |tool: &&Value, name: &str| tool["name"].as_str() == Some(name);
        let (mine, mut tools): (Vec<Value>, Vec<Value>) = host.tools.iter().cloned().partition(|tool| tool["name"].as_str().is_some_and(|name| family.contains(&name)));
        tools.extend(family.iter().filter_map(|name| {
            let current = mine.iter().find(|tool| named(tool, name)).cloned();
            current.or_else(|| held.contains(name).then(|| definitions.iter().find(|tool| named(tool, name)).cloned().unwrap_or_else(|| stub(name))))
        }));
        Some(ToolHost { tools, ..host })
    }

    /// The finished host: listed tools the turn does not want are refused.
    #[cfg(test)]
    pub(crate) fn finish(self, host: Option<ToolHost>) -> Option<ToolHost> {
        self.finish_with_refused(host).0
    }

    /// `finish`, also returning the names its handler refuses: the one set a harness's own
    /// permission check may let through without asking (`RunHost::refused`).
    pub(crate) fn finish_with_refused(self, host: Option<ToolHost>) -> (Option<ToolHost>, HashSet<String>) {
        if self.refused.is_empty() || host.is_none() {
            return (host, HashSet::new());
        }
        let refused = self.refused.clone();
        (super::refuse_tools(host, self.refused), refused)
    }
}

fn stub(name: &str) -> Value {
    serde_json::json!({"type": "function", "name": name, "description": HELD_DESCRIPTION, "inputSchema": {"type": "object", "properties": {}}})
}

fn empty_host() -> ToolHost {
    ToolHost { tools: Vec::new(), approval_tools: HashSet::new(), handler: std::sync::Arc::new(|_, _| Box::pin(async { Err("Unknown PandaCode tool.".to_owned()) })) }
}

/// The families a run's tool host is built from, in `build_host`'s order. The app builds them
/// with its handle (`run_host` in `lib.rs`); tests build them without one.
pub(crate) trait HostLayers {
    /// The team's tools (a lead's also the app's agent tools; a plain task gets just those), JEV and bot tools, and whether a team's own
    /// tools failed to start.
    fn base(&mut self, plan: &super::HostPlan) -> (Option<ToolHost>, bool);
    fn schedules(&mut self, host: Option<ToolHost>) -> Option<ToolHost>;
    /// Simulator, VM, Colab (local runs only), machine and design tools: listed for every role (design writes are
    /// trimmed afterwards).
    fn devices(&mut self, host: Option<ToolHost>, plan: &super::HostPlan) -> Option<ToolHost>;
    fn progress(&mut self, host: Option<ToolHost>) -> Option<ToolHost>;
    fn explore(&mut self, host: Option<ToolHost>, strict: bool) -> ToolHost;
    /// The agent-made tools, or `host` unchanged when the run is not offered them.
    fn custom(&mut self, host: Option<ToolHost>) -> Option<ToolHost>;
    /// Every agent-made tool's real definition, for the ones this turn holds without offering;
    /// empty when the run has no catalog.
    fn custom_definitions(&self) -> Vec<Value>;
    /// Deploy and preview tools, listed for every run.
    fn always(&mut self, host: Option<ToolHost>) -> ToolHost;
    fn track(&mut self, host: Option<ToolHost>) -> ToolHost;
    fn titles(&mut self, host: Option<ToolHost>) -> ToolHost;
}

/// A run's tool host, the listed names its handler refuses, and whether a team's own tools
/// failed to start.
pub(crate) struct RunHost {
    pub host: Option<ToolHost>,
    /// Exactly the names `host`'s handler refuses (`Layers::finish_with_refused`).
    pub refused: HashSet<String>,
    pub missing: bool,
}

/// A run's whole tool host, built from its plan: a family the plan does not want stays listed
/// (every call refused) while `history` may hold it.
pub(crate) fn build_host(plan: &super::HostPlan, history: &History, at: &mut impl HostLayers) -> RunHost {
    let mut layers = Layers::new(history);
    let (host, missing) = at.base(plan);
    // Leads and plain tasks list every family below; workers drop what `Role::wants` leaves out.
    let host = layers.add(host, plan.trim.schedules, false, |host| at.schedules(host));
    let host = at.devices(host, plan);
    let host = layers.subset(host, plan.trim.design_writes, true, &super::DESIGN_WRITES);
    // A cloud agent's checkout is on its machine, where screenshots cannot be read: never listed.
    let host = if plan.cloud { host } else { layers.add(host, plan.trim.progress, true, |host| at.progress(host)) };
    // Search needs the checkout on this computer, so cloud runs never list it.
    let host = match plan.explore {
        Some(strict) => layers.add(host, plan.trim.explore, false, |host| Some(at.explore(host, strict))),
        None => host,
    };
    let host = layers.add(host, plan.trim.custom, false, |host| at.custom(host));
    // Plan mode offers fewer agent-made tools than another turn of the same conversation may
    // list, before or after this one: a run wanting them lists a Standard turn's.
    let definitions = at.custom_definitions();
    let offered = crate::custom_tools::offered(plan.cloud);
    let standard = if plan.trim.custom && offered { crate::custom_tools::standard_names(&definitions) } else { Vec::new() };
    let host = layers.hold(host, &definitions, &CUSTOM_TOOLS, offered, &standard);
    let host = Some(at.always(host));
    // A read-only worker keeps its tracker (native write events are still observed); on a new
    // conversation it is never offered the shell handshake.
    let host = layers.add(host, plan.trim.track, true, |host| Some(at.track(host)));
    let host = layers.add(host, plan.trim.titles, false, |host| Some(at.titles(host)));
    let (host, refused) = layers.finish_with_refused(host);
    RunHost { host, refused, missing }
}

/// Every family's real catalog without an app handle (`run_host` needs one for each layer's
/// handler; tauri's test runtime is not enabled), so tests run the real `build_host` over the
/// real tool names. Every call reaches a stub that answers with the tool's name; the tracking
/// and title layers are the real ones.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    /// Team workers' coordination tools as `architect::host` lists them (a sample).
    pub(crate) const TEAM: [&str; 2] = ["pandacode_checkpoint_worker", "pandacode_send_team_message"];
    pub(crate) const CUSTOM: [&str; 3] = CUSTOM_TOOLS;

    #[derive(Default)]
    pub(crate) struct FakeLayers {
        /// The run is offered agent-made tools.
        pub custom: bool,
        /// What that layer lists this turn, when not all of `CUSTOM` (Plan mode).
        pub custom_listed: Option<&'static [&'static str]>,
        /// Real specs that layer lists instead of `custom_listed`'s bare names.
        pub custom_specs: Option<Vec<Value>>,
        /// What `custom_definitions` returns.
        pub definitions: Vec<Value>,
        /// The run is a team's lead, which also gets the app host (`launch_host::AppLayers::base`).
        pub lead: bool,
    }

    fn with(host: Option<ToolHost>, specs: Vec<Value>, gated: &[&str]) -> ToolHost {
        let mut host = host.unwrap_or_else(|| ToolHost {
            tools: Vec::new(),
            approval_tools: HashSet::new(),
            handler: Arc::new(|name, _| Box::pin(async move { Ok(json!(name)) })),
        });
        host.tools.extend(specs);
        host.approval_tools.extend(gated.iter().map(|name| (*name).to_owned()));
        host
    }

    fn named(names: &[&str]) -> Vec<Value> {
        names.iter().map(|name| json!({"type": "function", "name": name})).collect()
    }

    impl HostLayers for FakeLayers {
        fn base(&mut self, plan: &super::super::HostPlan) -> (Option<ToolHost>, bool) {
            // As `launch_host::AppLayers::base`: every harness gets the app host without a team, and
            // only a team's lead gets it beside the team tools.
            let app = || crate::agent_tools::catalog();
            let host = match (plan.team, self.lead) {
                (true, true) => Some(with(Some(with(None, named(&TEAM), &[])), app(), &[])),
                (true, false) => Some(with(None, named(&TEAM), &[])),
                (false, _) => Some(with(None, app(), &[])),
            };
            (host, false)
        }
        fn schedules(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
            Some(with(host, crate::schedules::tools::catalog(), &[]))
        }
        fn devices(&mut self, host: Option<ToolHost>, _: &super::super::HostPlan) -> Option<ToolHost> {
            let host = with(host, crate::vm::tools::catalog(), &["pandacode_vm_exec"]);
            Some(with(Some(host), crate::design::catalog(), &[]))
        }
        fn progress(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
            Some(with(host, crate::progress::catalog(), &[]))
        }
        fn explore(&mut self, host: Option<ToolHost>, _: bool) -> ToolHost {
            with(host, crate::explore::catalog(), &[])
        }
        fn custom(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
            if let Some(specs) = self.custom.then(|| self.custom_specs.clone()).flatten() {
                return Some(with(host, specs, &[]));
            }
            let listed = self.custom_listed.unwrap_or(&CUSTOM);
            let gated: &[&str] = if listed.contains(&crate::custom_tools::TOOL_RUN) { &[crate::custom_tools::TOOL_RUN] } else { &[] };
            if self.custom { Some(with(host, named(listed), gated)) } else { host }
        }
        fn custom_definitions(&self) -> Vec<Value> {
            self.definitions.clone()
        }
        fn always(&mut self, host: Option<ToolHost>) -> ToolHost {
            with(host, named(&["pandacode_preview_file", "pandacode_run_project"]), &["pandacode_run_project"])
        }
        fn track(&mut self, host: Option<ToolHost>) -> ToolHost {
            crate::turn_changes::with_host(host, None, Arc::new(AtomicBool::new(false)))
        }
        fn titles(&mut self, host: Option<ToolHost>) -> ToolHost {
            crate::session_titles::with_host(None, host, Arc::new(AtomicBool::new(false)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn host_of(names: &[&str]) -> Option<ToolHost> {
        let tools = names.iter().map(|name| serde_json::json!({"name": name})).collect();
        let approval_tools = names.iter().map(|name| (*name).to_owned()).collect();
        Some(ToolHost { tools, approval_tools, handler: Arc::new(|name, _| Box::pin(async move { Ok(serde_json::json!(name)) })) })
    }

    /// A layer that adds `names` to the host.
    fn adds(names: &'static [&'static str]) -> impl FnOnce(Option<ToolHost>) -> Option<ToolHost> {
        move |host: Option<ToolHost>| {
            let mut host = host.unwrap_or_else(|| host_of(&[]).unwrap());
            host.tools.extend(names.iter().map(|name| serde_json::json!({"name": name})));
            host.approval_tools.extend(names.iter().map(|name| (*name).to_owned()));
            Some(host)
        }
    }

    fn listing(host: &Option<ToolHost>) -> Vec<String> {
        let mut names: Vec<String> = names(host.as_ref()).into_iter().collect();
        names.sort();
        names
    }

    fn refuses(host: &Option<ToolHost>, name: &str) -> bool {
        let host = host.as_ref().unwrap();
        tauri::async_runtime::block_on((host.handler)(name.into(), serde_json::Value::Null)).is_err()
    }

    /// A turn over a base tool, a wanted/unwanted explore family and a worker's title family.
    fn turn(history: &History, explore_on: bool, titles_on: bool) -> Option<ToolHost> {
        let mut layers = Layers::new(history);
        let host = layers.add(host_of(&["pandacode_preview_file"]), explore_on, false, adds(&["pandacode_explore"]));
        let host = layers.add(host, titles_on, false, adds(&["pandacode_title"]));
        layers.finish(host)
    }

    #[test]
    fn turning_explore_off_keeps_a_resumed_sessions_definition_and_refuses_its_calls() {
        // A new conversation with explore on lists it; the next turn resumes it with explore off.
        let first = turn(&History::fresh(false), true, true);
        assert!(listing(&first).contains(&"pandacode_explore".to_owned()));
        let resumed = turn(&History::holding(&["pandacode_preview_file", "pandacode_explore", "pandacode_title"]), false, true);
        assert_eq!(listing(&first), listing(&resumed), "a resumed session never loses a tool it listed");
        assert!(refuses(&resumed, "pandacode_explore"), "but its calls are refused");
        assert!(!refuses(&resumed, "pandacode_title") && !refuses(&resumed, "pandacode_preview_file"));
        let host = resumed.unwrap();
        assert!(!host.approval_tools.contains("pandacode_explore"), "a refused call never asks the user");
        // A new conversation with explore off never lists it.
        assert!(!listing(&turn(&History::fresh(false), false, true)).contains(&"pandacode_explore".to_owned()));
        // Nor does a resumed one that never held it (known history).
        assert!(!listing(&turn(&History::holding(&["pandacode_preview_file"]), false, true)).contains(&"pandacode_explore".to_owned()));
    }

    #[test]
    fn a_resumed_worker_that_listed_titles_keeps_them_listed_and_refused() {
        // A worker session from before workers dropped titles (or after a restart: unknown).
        for history in [History::holding(&["pandacode_preview_file", "pandacode_title"]), History::unknown(false)] {
            let resumed = turn(&history, true, false);
            assert!(listing(&resumed).contains(&"pandacode_title".to_owned()), "{history:?}");
            assert!(refuses(&resumed, "pandacode_title"));
        }
        // A worker's new conversation never lists them.
        assert!(!listing(&turn(&History::fresh(false), true, false)).contains(&"pandacode_title".to_owned()));
    }

    #[test]
    fn codex_lists_a_family_that_can_flip_from_its_threads_first_turn() {
        let codex = History::fresh(true);
        let mut layers = Layers::new(&codex);
        let host = layers.add(host_of(&["base"]), false, true, adds(&["pandacode_progress_snapshot"]));
        let host = layers.add(host, false, false, adds(&["pandacode_title"]));
        let host = layers.finish(host);
        assert_eq!(listing(&host), ["base", "pandacode_progress_snapshot"]);
        assert!(refuses(&host, "pandacode_progress_snapshot"));
        // Claude adds it later instead, from the next launch's catalog.
        let claude = History::fresh(false);
        let mut layers = Layers::new(&claude);
        let host = layers.add(host_of(&["base"]), false, true, adds(&["pandacode_progress_snapshot"]));
        assert_eq!(listing(&layers.finish(host)), ["base"]);
    }

    #[test]
    fn a_subset_of_an_always_listed_layer_is_dropped_or_refused() {
        const WRITES: [&str; 1] = ["write"];
        let all = || host_of(&["list", "write"]);
        let subset = |history: History, wanted: bool| {
            let mut layers = Layers::new(&history);
            let host = layers.subset(all(), wanted, true, &WRITES);
            layers.finish(host)
        };
        // A new conversation that does not want them drops them; one that does keeps them working.
        assert_eq!(listing(&subset(History::fresh(false), false)), ["list"]);
        let wanted = subset(History::fresh(false), true);
        assert_eq!(listing(&wanted), ["list", "write"]);
        assert!(!refuses(&wanted, "write"));
        // A resumed session that held them keeps them listed, refused.
        let kept = subset(History::holding(&["list", "write"]), false);
        assert_eq!(listing(&kept), ["list", "write"]);
        assert!(refuses(&kept, "write") && !refuses(&kept, "list"));
    }

    /// A plain task's whole host, its agent-made layer listing only `listed`.
    fn plain_turn(history: &History, listed: &'static [&'static str]) -> RunHost {
        let plan = crate::app_instructions::HostPlan { team: false, codex: false, cloud: false, trim: crate::app_instructions::Role::of(false, false).wants(), explore: None };
        build_host(&plan, history, &mut fake::FakeLayers { custom: true, custom_listed: Some(listed), ..Default::default() })
    }

    fn custom_listing(host: &Option<ToolHost>) -> Vec<String> {
        listing(host).into_iter().filter(|name| fake::CUSTOM.contains(&name.as_str())).collect()
    }

    const ALL_CUSTOM: [&str; 3] = [crate::custom_tools::TOOL_LIST, crate::custom_tools::TOOL_RUN, crate::custom_tools::TOOL_SAVE];

    #[test]
    fn plan_mode_keeps_held_custom_tools_listed_and_refuses_what_it_does_not_offer() {
        use crate::custom_tools::{TOOL_LIST, TOOL_RUN, TOOL_SAVE};
        let built = plain_turn(&History::holding(&fake::CUSTOM), &[TOOL_LIST]);
        assert_eq!(custom_listing(&built.host), ALL_CUSTOM);
        assert!(refuses(&built.host, TOOL_SAVE) && refuses(&built.host, TOOL_RUN));
        assert!(!refuses(&built.host, TOOL_LIST), "Plan mode can still list");
        assert_eq!(built.refused, HashSet::from([TOOL_SAVE.to_owned(), TOOL_RUN.to_owned()]));
        assert!(!built.host.as_ref().unwrap().approval_tools.contains(TOOL_RUN), "a refused call never asks the user");
        // The smaller offer is not what gets remembered.
        let session = format!("catalog-{}", uuid::Uuid::new_v4());
        remember(&session, Some("conv-1"), built.host.as_ref(), &[]);
        let next = History::of(&session, "claude", Some("conv-1"));
        assert_eq!(custom_listing(&plain_turn(&next, &[TOOL_LIST]).host), ALL_CUSTOM);
        forget(std::slice::from_ref(&session));
    }

    /// A real project's agent-made specs in `mode`, from the real layer.
    fn real_specs(base: &std::path::Path, mode: &str) -> Vec<Value> {
        crate::custom_tools::test_host(base.to_owned(), "project", base.to_owned(), "catalog-specs", mode).tools
    }

    fn spec_bytes(built: &RunHost) -> Vec<u8> {
        serde_json::to_vec(&built.host.as_ref().unwrap().tools).unwrap()
    }

    #[test]
    fn plan_mode_lists_the_same_spec_bytes_in_the_same_order_as_standard() {
        use crate::custom_tools::{TOOL_LIST, TOOL_RUN, TOOL_SAVE};
        let dir = crate::custom_tools::temp();
        crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
        let (standard, plan_specs) = (real_specs(&dir.0, "ask"), real_specs(&dir.0, "plan"));
        assert_eq!(plan_specs.len(), 1, "Plan mode offers only the list tool");
        let build = |specs: &[Value], history: &History| {
            let plan = crate::app_instructions::HostPlan { team: false, codex: true, cloud: false, trim: crate::app_instructions::Role::of(false, false).wants(), explore: Some(false) };
            build_host(&plan, history, &mut fake::FakeLayers { custom: true, custom_specs: Some(specs.to_vec()), definitions: standard.clone(), ..Default::default() })
        };
        for history in [History::holding(&fake::CUSTOM), History::unknown(true)] {
            let (full, planned) = (build(&standard, &history), build(&plan_specs, &history));
            assert_eq!(spec_bytes(&full), spec_bytes(&planned), "{history:?}");
            assert_eq!(planned.refused, HashSet::from([TOOL_SAVE.to_owned(), TOOL_RUN.to_owned()]));
            assert!(refuses(&planned.host, TOOL_RUN) && refuses(&planned.host, TOOL_SAVE) && !refuses(&planned.host, TOOL_LIST));
            assert!(!planned.host.as_ref().unwrap().approval_tools.contains(TOOL_RUN));
        }
    }

    /// A new conversation's Plan turn, then its Standard turn, over the real layer's specs.
    fn plan_then_standard(base: &std::path::Path, codex: bool) -> (RunHost, RunHost) {
        let definitions = crate::custom_tools::test_definitions(base, "project");
        let build = |mode: &str, history: &History| {
            let plan = crate::app_instructions::HostPlan { team: false, codex, cloud: false, trim: crate::app_instructions::Role::of(false, false).wants(), explore: Some(false) };
            build_host(&plan, history, &mut fake::FakeLayers { custom: true, custom_specs: Some(real_specs(base, mode)), definitions: definitions.clone(), ..Default::default() })
        };
        let provider = if codex { "codex" } else { "claude" };
        let session = format!("catalog-{}", uuid::Uuid::new_v4());
        let planned = build("plan", &History::of(&session, provider, None));
        remember(&session, None, planned.host.as_ref(), &[]);
        let implemented = build("ask", &History::of(&session, provider, Some("conv-1")));
        forget(std::slice::from_ref(&session));
        (planned, implemented)
    }

    #[test]
    fn a_conversation_that_starts_in_plan_mode_keeps_its_tool_list_when_it_implements() {
        use crate::custom_tools::{TOOL_LIST, TOOL_RUN, TOOL_SAVE};
        let dir = crate::custom_tools::temp();
        crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
        for codex in [false, true] {
            let (planned, implemented) = plan_then_standard(&dir.0, codex);
            assert_eq!(spec_bytes(&planned), spec_bytes(&implemented), "codex: {codex}");
            assert_eq!(custom_listing(&planned.host), ALL_CUSTOM);
            assert_eq!(planned.refused, HashSet::from([TOOL_SAVE.to_owned(), TOOL_RUN.to_owned()]));
            assert!(refuses(&planned.host, TOOL_RUN) && refuses(&planned.host, TOOL_SAVE) && !refuses(&planned.host, TOOL_LIST));
            assert!(!planned.host.as_ref().unwrap().approval_tools.contains(TOOL_RUN), "a refused call never asks the user");
            assert!(implemented.refused.is_empty() && !refuses(&implemented.host, TOOL_SAVE) && !refuses(&implemented.host, TOOL_RUN));
        }
    }

    #[test]
    fn an_empty_catalog_lists_what_a_full_one_does() {
        let (empty, full) = (crate::custom_tools::temp(), crate::custom_tools::temp());
        crate::custom_tools::test_save(&full.0, "project", "build-app", "true");
        for codex in [false, true] {
            let ((empty_plan, empty_ask), (full_plan, full_ask)) = (plan_then_standard(&empty.0, codex), plan_then_standard(&full.0, codex));
            assert_eq!(spec_bytes(&empty_plan), spec_bytes(&full_plan), "codex: {codex}");
            assert_eq!(spec_bytes(&empty_ask), spec_bytes(&full_ask), "codex: {codex}");
            assert_eq!(custom_listing(&empty_ask.host), ALL_CUSTOM);
            assert!(empty_ask.refused.is_empty());
        }
    }

    #[test]
    fn a_worker_is_not_listed_agent_made_tools_for_a_later_turn() {
        let dir = crate::custom_tools::temp();
        crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
        let plan = crate::app_instructions::HostPlan { team: true, codex: false, cloud: false, trim: crate::app_instructions::Role::of(true, false).wants(), explore: None };
        let definitions = crate::custom_tools::test_definitions(&dir.0, "project");
        let built = build_host(&plan, &History::fresh(false), &mut fake::FakeLayers { definitions, ..Default::default() });
        assert!(custom_listing(&built.host).is_empty());
    }

    #[test]
    fn the_app_host_is_listed_for_every_harness_and_a_teams_lead_only() {
        let app_tool = crate::agent_tools::catalog().iter().find_map(|spec| spec["name"].as_str().map(str::to_owned)).expect("the app host lists a tool");
        let listed = |team: bool, codex: bool, lead: bool| {
            let plan = crate::app_instructions::HostPlan { team, codex, cloud: false, trim: crate::app_instructions::Role::of(team, false).wants(), explore: None };
            let built = build_host(&plan, &History::fresh(codex), &mut fake::FakeLayers { lead, ..Default::default() });
            listing(&built.host).contains(&app_tool)
        };
        for codex in [false, true] {
            assert!(listed(false, codex, false), "a plain task lists the app host (codex: {codex})");
            assert!(listed(true, codex, true), "a team's lead lists it (codex: {codex})");
            assert!(!listed(true, codex, false), "a team's worker does not (codex: {codex})");
        }
    }

    #[test]
    fn a_held_tool_without_a_readable_definition_is_still_listed() {
        let built = plain_turn(&History::holding(&fake::CUSTOM), &[]);
        let tools = &built.host.as_ref().unwrap().tools;
        assert!(tools.iter().any(|tool| tool["name"] == crate::custom_tools::TOOL_RUN && tool["description"] == HELD_DESCRIPTION));
    }

    #[test]
    fn a_conversation_keeps_the_native_tools_it_started_with() {
        // A new conversation follows the role.
        assert!(!History::fresh(false).lists_native("NotebookEdit", true));
        assert!(History::fresh(false).lists_native("NotebookEdit", false));
        // A resumed one keeps what it started with, whatever the role says now.
        let held = History::holding(&["pandacode_preview_file", "SendMessage"]);
        assert!(held.lists_native("SendMessage", true));
        assert!(!held.lists_native("NotebookEdit", false));
        // Unknown history keeps every definition.
        assert!(History::unknown(false).lists_native("NotebookEdit", true));
    }

    #[test]
    fn the_history_follows_the_conversation_and_deleted_tasks_are_forgotten() {
        let session = format!("catalog-{}", uuid::Uuid::new_v4());
        // Unknown until a listing is recorded for the session.
        assert_eq!(History::of(&session, "claude", Some("conv-1")), History::unknown(false));
        // A new conversation holds nothing, whatever was listed before.
        assert_eq!(History::of(&session, "claude", None), History::fresh(false));
        remember(&session, None, host_of(&["a"]).as_ref(), &[]);
        // The new conversation becomes conv-1: its next turn knows what it holds.
        assert_eq!(History::of(&session, "claude", Some("conv-1")), History::holding(&["a"]));
        remember(&session, Some("conv-1"), host_of(&["a", "b"]).as_ref(), &[]);
        assert_eq!(History::of(&session, "claude", Some("conv-1")), History::holding(&["a", "b"]));
        // Another conversation is unknown again.
        assert_eq!(History::of(&session, "claude", Some("conv-2")), History::unknown(false));
        // A new conversation's listing holds only for the first conversation it is resumed as.
        remember(&session, None, host_of(&["c"]).as_ref(), &[]);
        assert_eq!(History::of(&session, "claude", Some("conv-3")), History::holding(&["c"]));
        assert_eq!(History::of(&session, "claude", Some("conv-3")), History::holding(&["c"]), "reading again keeps it");
        // A swapped conversation (fork, adopt) is unknown history, not the new one's tools.
        assert_eq!(History::of(&session, "claude", Some("conv-2")), History::unknown(false));
        forget(std::slice::from_ref(&session));
        assert_eq!(History::of(&session, "claude", Some("conv-1")), History::unknown(false));
    }

    #[test]
    fn a_restart_lists_exactly_what_the_same_process_would() {
        use crate::session_state::{tests::temp, SessionState, Shared};
        // A worker: titles, schedules and agent-made tools are unwanted, so only history keeps them.
        let plan = crate::app_instructions::HostPlan { team: true, codex: false, cloud: false, trim: crate::app_instructions::Role::of(true, false).wants(), explore: None };
        let build = |history: &History| build_host(&plan, history, &mut fake::FakeLayers::default());
        let first = build(&History::fresh(false));
        let (_dir, path) = temp();
        let before = Shared::open(path.clone());
        before.update_now("task", |task| task.listed = Some(super::listing(None, first.host.as_ref(), &["SendMessage".to_owned()])));
        let history = |state: &mut SessionState| state.get("task", |task| History::from_listed(task.and_then(|task| task.listed.as_ref()), "claude", Some("conv-1")));
        let same_process = history(&mut before.lock());
        let restarted = history(&mut SessionState::open(path.clone()));
        assert_eq!(restarted, same_process);
        assert!(restarted.lists_native("SendMessage", true) && !restarted.lists_native("Agent", false), "the deny set it started with");
        let (resumed, again) = (build(&same_process), build(&restarted));
        assert_eq!(serde_json::to_vec(&again.host.as_ref().unwrap().tools).unwrap(), serde_json::to_vec(&resumed.host.as_ref().unwrap().tools).unwrap());
        assert_eq!(listing(&again.host), listing(&first.host), "no widening after a restart");
        assert_ne!(listing(&build(&History::unknown(false)).host), listing(&first.host), "unknown history would have widened it");
        // A corrupt file is unknown history, exactly as before persistence.
        std::fs::write(&path, "{").unwrap();
        assert_eq!(history(&mut SessionState::open(path)), History::unknown(false));
    }
}
