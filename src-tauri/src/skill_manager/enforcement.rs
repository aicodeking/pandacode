use super::*;

/// Codex resolves user and session-flags skill rules separately, retaining user disables.
/// Name selectors cover duplicate paths, plugins and skills in custom config homes (verified in Codex 0.167).
pub(crate) fn codex_arguments(disabled: &BTreeSet<String>) -> Vec<String> {
    codex_skills_config(Vec::new(), disabled)
}

fn codex_rules(disabled: &BTreeSet<String>) -> Vec<String> {
    disabled
        .iter()
        .filter(|name| validate_name(name).is_ok())
        .map(|name| {
            format!(
                "{{name={},enabled=false}}",
                serde_json::to_string(name).expect("name")
            )
        })
        .collect()
}

/// One `-c skills.config=[…]` with `before` first and the manager's disables last.
fn codex_skills_config(mut before: Vec<String>, disabled: &BTreeSet<String>) -> Vec<String> {
    let rules = codex_rules(disabled);
    if rules.is_empty() {
        return Vec::new();
    }
    before.extend(rules);
    vec!["-c".into(), format!("skills.config=[{}]", before.join(","))]
}

/// Codex keeps the last `-c` value per key, so a named connection's own `skills.config` (or a
/// whole `skills` table) passed after the manager's would replace its disables. Returns one
/// final override with the connection's entries first and the manager's last; nothing when the
/// connection sets neither or no skill is off.
pub(crate) fn codex_connection_arguments(
    args: &[String],
    disabled: &BTreeSet<String>,
) -> Vec<String> {
    let mut entries = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let value = if arg == "-c" || arg == "--config" {
            i += 1;
            args.get(i).map(String::as_str)
        } else {
            arg.strip_prefix("--config=")
                .or_else(|| arg.strip_prefix("-c").filter(|value| !value.is_empty()))
        };
        i += 1;
        let Some((key, value)) = value.and_then(|value| value.split_once('=')) else {
            continue;
        };
        let parsed = format!("value={value}").parse::<toml::Table>().ok();
        let array = match key.trim() {
            "skills.config" => parsed.and_then(|t| t.get("value")?.as_array().cloned()),
            "skills" => parsed.and_then(|t| t.get("value")?.get("config")?.as_array().cloned()),
            _ => continue,
        };
        // The last setting wins, as in Codex; one Codex can't read contributes nothing.
        entries = Some(array.unwrap_or_default());
    }
    entries.map_or_else(Vec::new, |entries| {
        codex_skills_config(entries.iter().map(inline_toml).collect(), disabled)
    })
}

/// A TOML value in inline form, for passing a connection's own entries back to Codex.
fn inline_toml(value: &toml::Value) -> String {
    let string = |text: &str| {
        serde_json::to_string(text)
            .expect("string")
            .replace('\u{7f}', "\\u007f")
    };
    match value {
        toml::Value::String(text) => string(text),
        toml::Value::Integer(n) => n.to_string(),
        toml::Value::Float(n) if n.is_nan() => "nan".into(),
        toml::Value::Float(n) if n.is_infinite() => if *n > 0.0 { "inf" } else { "-inf" }.into(),
        toml::Value::Float(n) => format!("{n:?}"),
        toml::Value::Boolean(b) => b.to_string(),
        toml::Value::Datetime(d) => d.to_string(),
        toml::Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(inline_toml).collect::<Vec<_>>().join(",")
            )
        }
        toml::Value::Table(table) => format!(
            "{{{}}}",
            table
                .iter()
                .map(|(key, value)| format!("{}={}", string(key), inline_toml(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

#[path = "opencode_config.rs"]
mod opencode_config;
use opencode_config::*;

/// Denies for the built-in agents and every agent defined in config or agent files for `cwd`.
/// Consoles have no reminder channel, so an incomplete agent list is only logged there; the
/// Skills page reports that state as asked/none (`opencode_unlisted_agents`).
#[allow(dead_code)]
pub(crate) fn opencode_configuration_at(
    text: &str,
    disabled: &BTreeSet<String>,
    cwd: &Path,
) -> String {
    opencode_configuration_at_with_env(
        text,
        disabled,
        cwd,
        &OpenCodeEnv::from_environment(|name| std::env::var_os(name)),
    )
}

/// Denies for built-in and discovered agents using the launch's effective discovery environment.
pub(crate) fn opencode_configuration_at_with_env(
    text: &str,
    disabled: &BTreeSet<String>,
    cwd: &Path,
    env: &OpenCodeEnv,
) -> String {
    let agents = opencode_agents_at_with_env(disabled, cwd, env);
    // The console already has a generated legacy mode. Its project scan can discover V2
    // even when the inline text supplied by the mode wrapper contains only V1 fields.
    if let Some((mut config, tokens)) = agents
        .has_v2_permissions
        .then(|| parse_inline(text, true))
        .flatten()
    {
        let schema = OpenCodeSchema::detect(&config);
        if !schema.use_v2_permissions && !schema.use_v2_agents {
            let skip_v2_agents: BTreeSet<String> = match config.get("agent") {
                Some(Json::Object(v1_agents)) => v1_agents
                    .0
                    .iter()
                    .filter_map(|(name, value)| match value {
                        Json::Object(obj)
                            if obj.0.iter().any(|(field, _)| field != "permission")
                                && !agents.disk_v2_agents.contains(name) =>
                        {
                            Some(name.clone())
                        }
                        _ => None,
                    })
                    .collect(),
                _ => BTreeSet::new(),
            };
            apply_native_mode(&mut config, &skip_v2_agents);
            let names = deny_names(disabled);
            if !names.is_empty() {
                config = deny_everywhere(config, &names, &agents);
            }
            let serialized = serde_json::to_string(&config).expect("OpenCode configuration");
            return restore_opencode_tokens(serialized, &tokens);
        }
    }
    opencode_enforcement_with(text, disabled, &agents, None)
}

/// The agents an OpenCode launch's denies must reach, rescanned when connection paths change.
#[derive(Clone, Debug, Default)]
pub(crate) struct OpenCodeAgents {
    names: BTreeSet<String>,
    disk_v2_agents: BTreeSet<String>,
    pub(crate) complete: bool,
    has_v2_permissions: bool,
    tool_rules: OpenCodeToolRules,
}

fn deniable(disabled: &BTreeSet<String>) -> bool {
    disabled
        .iter()
        .any(|name| claude_rule_name(name) || name == "*")
}

/// Lists user/project agents using the effective launch paths, retaining every configured home.
pub(crate) fn opencode_all_agents_with_env(cwd: Option<&Path>, env: &OpenCodeEnv) -> OpenCodeAgents {
    let agents = super::opencode_agents::agents_with_env(
        cwd,
        crate::agent_usage_providers::home().as_deref(),
        &Homes::for_scan(),
        env,
    );
    OpenCodeAgents {
        names: agents.names,
        disk_v2_agents: agents.disk_v2_agents,
        complete: agents.complete,
        has_v2_permissions: agents.has_v2_permissions,
        tool_rules: agents.tool_rules,
    }
}

/// Lists the agents and the permission schema for `cwd`.
pub(crate) fn opencode_agents_at(disabled: &BTreeSet<String>, cwd: &Path) -> OpenCodeAgents {
    opencode_agents_at_with_env(
        disabled,
        cwd,
        &OpenCodeEnv::from_environment(|name| std::env::var_os(name)),
    )
}

/// Lists agents using the same effective launch paths as tool grants.
pub(crate) fn opencode_agents_at_with_env(
    disabled: &BTreeSet<String>,
    cwd: &Path,
    env: &OpenCodeEnv,
) -> OpenCodeAgents {
    let agents = opencode_all_agents_with_env(Some(cwd), env);
    if !agents.complete && deniable(disabled) {
        eprintln!(
            "Warning: OpenCode skill denies may not reach every agent for {} (too many agents or an unusable agent name); switched-off skills are asked, not blocked, for this launch.",
            cwd.display()
        );
    }
    agents
}

/// The configuration for agents already listed: no folder is read. When `agents.complete` is
/// false some agent may run without the denies, and the launch asks instead (`asked`).
pub(crate) fn opencode_enforcement_with(
    text: &str,
    disabled: &BTreeSet<String>,
    agents: &OpenCodeAgents,
    mode_permission: Option<&serde_json::Value>,
) -> String {
    opencode_configuration_with(text, disabled, agents, mode_permission)
}

#[cfg(test)]
fn opencode_configuration(text: &str, disabled: &BTreeSet<String>) -> String {
    opencode_configuration_with(
        text,
        disabled,
        &OpenCodeAgents {
            names: super::opencode_agents::BUILTIN.into_iter().map(String::from).collect(),
            ..Default::default()
        },
        None,
    )
}

/// Permission resource patterns are glob-based; arbitrary names keep the advisory fallback.
fn deny_names(disabled: &BTreeSet<String>) -> Vec<&String> {
    disabled
        .iter()
        .filter(|name| claude_rule_name(name) || name.as_str() == "*")
        .collect()
}

const TOOL_PERMISSION_PREFIX: &str = "pandacode_architect_";

fn exact_tool_name(action: &str) -> Option<&str> {
    let name = action.strip_prefix(TOOL_PERMISSION_PREFIX)?;
    let name = name.strip_suffix(" *").unwrap_or(name);
    (!name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')))
    .then_some(name)
}

#[derive(Clone, Copy)]
enum ToolGrant {
    Allow,
    Deny,
    Withhold,
}

#[derive(Clone, Debug, Default)]
struct ExactToolRules {
    // The trailing action alias shares the same entry; false is allow, true is deny.
    tools: BTreeMap<String, BTreeMap<String, bool>>,
    withheld: bool,
}

impl ExactToolRules {
    fn record(&mut self, action: &str, resource: &str, effect: &str) {
        let Some(name) = exact_tool_name(action) else {
            return;
        };
        let deny = match effect {
            "allow" => false,
            "deny" => true,
            _ => return,
        };
        let resources = self.tools.entry(name.to_owned()).or_default();
        if resource == "*" {
            resources.clear();
        }
        resources.insert(resource.to_owned(), deny);
    }

    fn collect_v1(&mut self, permission: &Object) {
        for (action, value) in &permission.0 {
            match value {
                Json::Other(value) => {
                    if let Some(effect) = value.as_str() {
                        self.record(action, "*", effect);
                    }
                }
                Json::Object(resources) => {
                    for (resource, value) in &resources.0 {
                        if let Json::Other(value) = value {
                            if let Some(effect) = value.as_str() {
                                self.record(action, resource, effect);
                            }
                        }
                    }
                }
            }
        }
    }

    fn collect_permissions(&mut self, config: &Object) {
        if let Some(Json::Object(permission)) = config.get("permission") {
            self.collect_v1(permission);
        }
        if let Some(Json::Other(serde_json::Value::Array(permissions))) = config.get("permissions")
        {
            for rule in permissions {
                if let (Some(action), Some(resource), Some(effect)) = (
                    rule["action"].as_str(),
                    rule["resource"].as_str(),
                    rule["effect"].as_str(),
                ) {
                    self.record(action, resource, effect);
                }
            }
        }
    }

    fn withhold(&mut self) {
        self.tools.clear();
        self.withheld = true;
    }

    fn decision(&self, tool: &str) -> Option<ToolGrant> {
        if let Some(resources) = self.tools.get(tool) {
            let denied = resources.values().any(|deny| *deny);
            let whole = resources.get("*").copied();
            let decision = match whole {
                Some(false) if !denied => Some(ToolGrant::Allow),
                Some(true) if resources.values().all(|deny| *deny) => Some(ToolGrant::Deny),
                _ if denied => Some(ToolGrant::Withhold),
                _ => None,
            };
            if decision.is_some() {
                return decision;
            }
        }
        self.withheld.then_some(ToolGrant::Withhold)
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct OpenCodeToolRules {
    global: ExactToolRules,
    agents: BTreeMap<String, ExactToolRules>,
    config_withheld: bool,
}

impl OpenCodeToolRules {
    fn collect_config(&mut self, config: &Object) {
        self.global.collect_permissions(config);
        for key in ["mode", "agent", "agents"] {
            if let Some(Json::Object(agents)) = config.get(key) {
                for (name, agent) in &agents.0 {
                    if let Json::Object(agent) = agent {
                        self.agents
                            .entry(name.clone())
                            .or_default()
                            .collect_permissions(agent);
                    }
                }
            }
        }
    }

    pub(super) fn collect_markdown(
        &mut self,
        name: &str,
        rules: Option<Vec<(String, String, String)>>,
    ) {
        let scope = self.agents.entry(name.to_owned()).or_default();
        if let Some(rules) = rules {
            for (action, resource, effect) in rules {
                scope.record(&action, &resource, &effect);
            }
        } else {
            scope.withhold();
        }
    }

    pub(super) fn withhold_config(&mut self) {
        self.global.withhold();
        self.agents.clear();
        self.config_withheld = true;
    }

    /// OpenCode evaluates all top-level rules across every layer (including `OPENCODE_PERMISSION`)
    /// before all per-agent rules. Any explicit per-agent rule or Markdown withhold always beats
    /// top-level rules; an unreadable earlier config withholds agents that have no later explicit
    /// per-agent rule, because that config may have carried a per-agent deny.
    fn effect(&self, tool: &str, agent: Option<&str>) -> Option<&'static str> {
        let effective = if let Some(name) = agent {
            if let Some(decision) = self.agents.get(name).and_then(|rules| rules.decision(tool)) {
                Some(decision)
            } else if self.config_withheld {
                Some(ToolGrant::Withhold)
            } else {
                self.global.decision(tool)
            }
        } else {
            self.global.decision(tool)
        };
        match effective {
            None | Some(ToolGrant::Allow) => Some("allow"),
            Some(ToolGrant::Deny) => Some("deny"),
            Some(ToolGrant::Withhold) => None,
        }
    }
}

/// Read a bounded disk config once, keeping v1 rule order and agent-name validation.
pub(super) fn discover_opencode_config(
    text: &str,
    add: &mut impl FnMut(Option<&str>),
    tool_rules: &mut OpenCodeToolRules,
    has_v2_permissions: &mut bool,
    disk_v2_agents: &mut BTreeSet<String>,
) {
    let (scrubbed, tokens) = scrub_opencode_tokens(text);
    let Ok(config) = serde_json::from_str::<Object>(&crate::vsix_themes::strip_jsonc(&scrubbed))
    else {
        add(None);
        tool_rules.withhold_config();
        return;
    };
    let schema = OpenCodeSchema::detect(&config);
    *has_v2_permissions |= schema.use_v2_permissions || schema.use_v2_agents;
    tool_rules.collect_config(&config);
    for key in ["agent", "agents", "mode"] {
        match config.get(key) {
            Some(Json::Object(agents)) => {
                for (name, _) in &agents.0 {
                    let usable = !tokens.contains_sentinel_str(name);
                    add(usable.then_some(name.as_str()));
                    if key == "agents" && usable {
                        disk_v2_agents.insert(name.clone());
                    }
                }
            }
            Some(Json::Other(value)) if tokens.is_sentinel_value(value) => add(None),
            _ => {}
        }
    }
}

fn mode_permission_exception(action: &str) -> bool {
    exact_tool_name(action).is_some() || matches!(action, "skill" | "skill *")
}

fn apply_mode_permission(
    config: &mut Object,
    policy: &serde_json::Value,
    native: bool,
    discovered: &OpenCodeAgents,
) {
    let skip_v2_agents: BTreeSet<String> = match config.get("agent") {
        Some(Json::Object(agents)) => agents
            .0
            .iter()
            .filter(|(k, _)| !discovered.disk_v2_agents.contains(k.as_str()))
            .map(|(k, _)| k.clone())
            .collect(),
        _ => BTreeSet::new(),
    };
    let apply_v1 = |target: &mut Object| {
        let mut permission: Object =
            serde_json::from_value(policy.clone()).expect("OpenCode mode permission");
        if let Some(Json::Object(old)) = target.take("permission") {
            for (key, value) in old.0 {
                if mode_permission_exception(&key) {
                    permission.put(key, value);
                }
            }
        }
        target.put("permission".into(), Json::Object(permission));
    };
    apply_v1(config);
    let agents = config.child("agent").object(false);
    for name in ["build", "plan"] {
        apply_v1(agents.child(name).object(false));
    }
    if native {
        apply_native_mode(config, &skip_v2_agents);
    }
}

fn apply_native_mode(config: &mut Object, skip_v2_agents: &BTreeSet<String>) {
    let translate = |target: &Object| {
        let mut permissions = Vec::new();
        if let Some(Json::Object(old)) = target.get("permission") {
            for (action, value) in &old.0 {
                let action = match action.as_str() {
                    "bash" => "shell",
                    "task" => "subagent",
                    "skill *" => "skill",
                    action => action,
                };
                match value {
                    Json::Other(value) if value.is_string() => {
                        permissions.push(permission_rule(action, value));
                    }
                    Json::Object(resources) => {
                        for (resource, effect) in &resources.0 {
                            if let Json::Other(effect) = effect {
                                permissions.push(serde_json::json!({
                                    "action": action, "resource": resource, "effect": effect
                                }));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        permissions
    };
    let apply = |target: &mut Object, mut permissions: Vec<serde_json::Value>| {
        if let Some(Json::Other(serde_json::Value::Array(old))) = target.take("permissions") {
            permissions.extend(old.into_iter().filter(|rule| {
                rule["action"]
                    .as_str()
                    .is_some_and(mode_permission_exception)
            }));
        }
        target.put(
            "permissions".into(),
            Json::Other(serde_json::Value::Array(permissions)),
        );
    };
    let permissions = translate(config);
    apply(config, permissions);
    let existing_v2: BTreeSet<String> = match config.get("agents") {
        Some(Json::Object(agents)) => agents.0.iter().map(|(k, _)| k.clone()).collect(),
        _ => BTreeSet::new(),
    };
    let primary: Vec<_> = {
        let legacy = config.child("agent").object(false);
        ["build", "plan"]
            .into_iter()
            .filter(|name| !skip_v2_agents.contains(*name) || existing_v2.contains(*name))
            .map(|name| (name, translate(legacy.child(name).object(false))))
            .collect()
    };
    if !primary.is_empty() {
        let agents = config.child("agents").object(false);
        for (name, permissions) in primary {
            apply(agents.child(name).object(false), permissions);
        }
    }
}

fn permission_rule(action: &str, effect: impl Serialize) -> serde_json::Value {
    serde_json::json!({"action": action, "resource": "*", "effect": effect})
}

/// Two exact action spellings for each served tool. A whole-tool deny also follows the
/// mode's wildcard in each relevant layer, which would otherwise allow it in Full access.
fn served_tool_rules<'a>(
    served: &'a [&str],
    tool_rules: &'a OpenCodeToolRules,
    agent: Option<&'a str>,
) -> impl Iterator<Item = (String, &'static str)> + 'a {
    served
        .iter()
        .filter_map(move |name| {
            let effect = tool_rules.effect(name, agent)?;
            let name = format!("{TOOL_PERMISSION_PREFIX}{name}");
            let trailing = trailing_key(&name);
            Some([(name, effect), (trailing, effect)])
        })
        .flatten()
}

/// Appends exact bound-server grants to an OpenCode 2.x `permissions` array field, creating it
/// when absent so OpenCode 2.x (which ignores legacy `agent.<name>` when `agents.<name>` exists)
/// still carries the grants after any project-level agent wildcards.
fn grant_v2_permissions(target: &mut Object, rules: impl Iterator<Item = (String, &'static str)>) {
    let mut rules = rules.peekable();
    if rules.peek().is_none() {
        return;
    }
    if target.get("permissions").is_none() {
        target.put("permissions".into(), Json::Other(serde_json::json!([])));
    }
    if let Some(Json::Other(serde_json::Value::Array(permissions))) = target.get_mut("permissions")
    {
        permissions.extend(rules.map(|(action, effect)| permission_rule(&action, effect)));
    }
}

fn grant_v1_permissions(
    permission: &mut Object,
    rules: impl Iterator<Item = (String, &'static str)>,
) {
    for (action, effect) in rules {
        permission.put(action, Json::Other(serde_json::json!(effect)));
    }
}

fn parse_permission_env(permission: Option<&str>, create_if_missing: bool) -> Option<Object> {
    match permission {
        Some(text) => match serde_json::from_str::<Json>(text) {
            Ok(Json::Object(rules)) => Some(rules),
            Ok(Json::Other(serde_json::Value::String(action)))
                if PERMISSION_ACTIONS.contains(&action.as_str()) =>
            {
                let mut rules = Object::default();
                rules.put("*".into(), Json::Other(serde_json::Value::String(action)));
                Some(rules)
            }
            _ if create_if_missing => {
                eprintln!("Warning: OPENCODE_PERMISSION is not a permission object or action; launching OpenCode with bound tool grants only.");
                Some(Object::default())
            }
            _ => None,
        },
        None if create_if_missing => Some(Object::default()),
        None => None,
    }
}

fn grant_permission_env(
    permission: Option<&str>,
    served: &[&str],
    tool_rules: &mut OpenCodeToolRules,
    create_if_missing: bool,
) -> Option<String> {
    let mut rules = parse_permission_env(permission, create_if_missing)?;
    tool_rules.global.collect_v1(&rules);
    grant_v1_permissions(&mut rules, served_tool_rules(served, tool_rules, None));
    Some(serde_json::to_string(&rules).expect("OpenCode permission"))
}

/// Exact bound-server grants for built-in agents; launches without tools stay untouched.
/// Unparseable inline text is preserved verbatim while grants still ride through
/// `OPENCODE_PERMISSION`. Unquoted `{env:...}` / `{file:...}` tokens are scrubbed to sentinels
/// during parsing and restored verbatim so grants still merge into `OPENCODE_CONFIG_CONTENT`.
#[cfg(test)]
fn opencode_tool_grants(
    text: &str,
    permission: Option<&str>,
    served: &[&str],
) -> Option<(String, Option<String>)> {
    opencode_tool_grants_with(text, permission, served, &OpenCodeAgents::default())
}

/// Exact bound-server grants for built-ins plus every discovered agent in `agents`.
/// Unquoted `{env:...}` / `{file:...}` tokens are preserved byte-for-byte while merging grants
/// directly into `OPENCODE_CONFIG_CONTENT`; genuinely unparseable inline text is preserved
/// verbatim while grants fall back to `OPENCODE_PERMISSION`.
pub(crate) fn opencode_tool_grants_with(
    text: &str,
    permission: Option<&str>,
    served: &[&str],
    agents: &OpenCodeAgents,
) -> Option<(String, Option<String>)> {
    if served.is_empty() {
        return None;
    }
    let inline = parse_inline(text, false);
    let mut tool_rules = agents.tool_rules.clone();
    if let Some((inline, _)) = &inline {
        tool_rules.collect_config(inline);
    }
    let permission = grant_permission_env(permission, served, &mut tool_rules, inline.is_none());
    let Some((mut inline, tokens)) = inline else {
        return Some((text.to_owned(), permission));
    };
    let schema = OpenCodeSchema::detect(&inline);

    let use_v2_permissions = schema.use_v2_permissions || agents.has_v2_permissions;
    let use_v2_agents = schema.use_v2_agents || agents.has_v2_permissions;
    if use_v2_permissions {
        grant_v2_permissions(&mut inline, served_tool_rules(served, &tool_rules, None));
    }
    if !use_v2_permissions || schema.has_v1_permission {
        grant_v1_permissions(
            inline.child("permission").object(true),
            served_tool_rules(served, &tool_rules, None),
        );
    }

    let target_agents: BTreeSet<&str> = super::opencode_agents::BUILTIN
        .into_iter()
        .chain(agents.names.iter().map(String::as_str))
        .collect();
    let v1_agent_names: BTreeSet<String> = match inline.get("agent") {
        Some(Json::Object(agents)) => agents.0.iter().map(|(k, _)| k.clone()).collect(),
        _ => BTreeSet::new(),
    };
    if use_v2_agents {
        let to_add: Vec<&str> = target_agents
            .iter()
            .copied()
            .filter(|name| !v1_agent_names.contains(*name) || agents.disk_v2_agents.contains(*name))
            .collect();
        if !to_add.is_empty() || inline.get("agents").is_some() {
            let v2_agents = inline.child("agents").object(false);
            for name in to_add {
                v2_agents.child(name);
            }
            for (name, agent) in &mut v2_agents.0 {
                if let Json::Object(agent) = agent {
                    grant_v2_permissions(agent, served_tool_rules(served, &tool_rules, Some(name)));
                }
            }
        }
    }
    if !use_v2_agents || schema.has_v1_agent {
        let agents = inline.child("agent").object(false);
        if !use_v2_agents {
            for name in &target_agents {
                agents.child(name);
            }
        }
        for (name, agent) in &mut agents.0 {
            let mut rules = served_tool_rules(served, &tool_rules, Some(name)).peekable();
            if rules.peek().is_some() {
                grant_v1_permissions(agent.object(false).child("permission").object(true), rules);
            }
        }
    }
    let serialized = serde_json::to_string(&inline).expect("OpenCode configuration");
    Some((restore_opencode_tokens(serialized, &tokens), permission))
}

/// The extra key for each deny or bound-tool grant. OpenCode (1.19) deep-merges config layers
/// keeping the first layer's key order, then applies the last matching rule, so a deny for an
/// existing key (`{"review":"allow","*":"allow"}` from a project) would stay in place before the
/// wildcard allow. `"<name> *"` matches exactly `<name>` (OpenCode reads a trailing ` *` as
/// "optionally followed by arguments", and deniable names have no spaces), and as a key no layer
/// sets it is appended after every other rule, so the deny is always last. The same holds one
/// level up: permission names are matched the same way, so `"skill *"` is the skill permission,
/// placed after a wildcard `"*"` rule that a later layer would otherwise leave after `skill`.
fn trailing_key(name: &str) -> String {
    format!("{name} *")
}

/// Denies every name in one permission object (OpenCode's `permission`, at any level).
fn deny_rules(permission: &mut Object, names: &[&String]) {
    let mut skill = permission
        .take("skill")
        .unwrap_or_else(|| Json::Object(Object::default()));
    if !matches!(&skill, Json::Other(v) if v.as_str() == Some("deny")) {
        let rules = skill.object(true);
        for name in names {
            rules.put((*name).clone(), Json::Other(serde_json::json!("deny")));
        }
        // After every name's own key, so the merged order ends with denies.
        for name in names {
            rules.put(trailing_key(name), Json::Other(serde_json::json!("deny")));
        }
    }
    // This also puts skill after any wildcard permission allows.
    permission.put("skill".into(), skill);
    // The same denies under the permission's own trailing key, always after `*` and `skill`.
    let mut last = Object::default();
    for name in names {
        last.put((*name).clone(), Json::Other(serde_json::json!("deny")));
    }
    for name in names {
        last.put(trailing_key(name), Json::Other(serde_json::json!("deny")));
    }
    permission.put(trailing_key("skill"), Json::Object(last));
}

/// Appends native OpenCode 2.x skill-deny rule objects to a `permissions` array.
fn deny_v2_rules(rules: &mut Vec<serde_json::Value>, names: &[&String]) {
    for name in names {
        for resource in [(*name).clone(), trailing_key(name)] {
            rules.push(serde_json::json!({
                "action": "skill",
                "resource": resource,
                "effect": "deny",
            }));
        }
    }
}

/// Appends native OpenCode 2.x skill-deny rules to a `permissions` array field, creating it when
/// absent so agent-level denies follow any earlier project-level wildcards.
fn deny_v2_permissions(target: &mut Object, names: &[&String]) {
    match target.get_mut("permissions") {
        Some(Json::Other(serde_json::Value::Array(rules))) => deny_v2_rules(rules, names),
        None => {
            let mut rules = Vec::new();
            deny_v2_rules(&mut rules, names);
            target.put(
                "permissions".into(),
                Json::Other(serde_json::Value::Array(rules)),
            );
        }
        Some(_) => {}
    }
}

/// OpenCode's permission actions; a bare one is shorthand for every permission.
const PERMISSION_ACTIONS: [&str; 3] = ["ask", "allow", "deny"];

/// The rules of an existing `OPENCODE_PERMISSION`. A bare action (`"allow"`) becomes
/// `{"*": "allow"}`, the wildcard form OpenCode's `Permission.fromConfig` reads, so it still
/// applies before the denies appended after it. Anything else that isn't an object (invalid
/// JSON, which OpenCode skips; another value, which its schema rejects) is replaced, and logged.
fn existing_permission(text: &str) -> Object {
    match serde_json::from_str::<Json>(text) {
        Ok(Json::Object(rules)) => rules,
        Ok(Json::Other(serde_json::Value::String(action)))
            if PERMISSION_ACTIONS.contains(&action.as_str()) =>
        {
            let mut rules = Object::default();
            rules.put("*".into(), Json::Other(serde_json::Value::String(action)));
            rules
        }
        _ => {
            eprintln!("Warning: OPENCODE_PERMISSION is not a permission object or action; launching OpenCode with skill denies only.");
            Object::default()
        }
    }
}

/// `OPENCODE_PERMISSION` for a launch with these switches: OpenCode merges it into the
/// top-level permissions after every config layer. An existing value's rules are kept
/// (`existing_permission`); `None` when nothing is deniable.
pub(crate) fn opencode_permission(
    existing: Option<&str>,
    disabled: &BTreeSet<String>,
) -> Option<String> {
    let names = deny_names(disabled);
    if names.is_empty() {
        return None;
    }
    let mut rules = existing.map(existing_permission).unwrap_or_default();
    deny_rules(&mut rules, &names);
    Some(serde_json::to_string(&rules).expect("OpenCode permission"))
}

/// Injects skill denies across top-level permissions and every known agent in the schema
/// (`permissions`/`agents` for 2.x, `permission`/`agent` for 1.x, or per-agent matching schema
/// when mixed) that OpenCode reads for each entry.
fn deny_everywhere(
    mut config: Object,
    names: &[&String],
    discovered: &OpenCodeAgents,
) -> Object {
    let schema = OpenCodeSchema::detect(&config);
    let use_v2_permissions = schema.use_v2_permissions || discovered.has_v2_permissions;
    let use_v2_agents = schema.use_v2_agents || discovered.has_v2_permissions;

    if use_v2_permissions {
        deny_v2_permissions(&mut config, names);
    }
    if !use_v2_permissions || schema.has_v1_permission {
        deny_rules(config.child("permission").object(true), names);
    }

    let v1_agent_names: BTreeSet<String> = match config.get("agent") {
        Some(Json::Object(agents)) => agents.0.iter().map(|(k, _)| k.clone()).collect(),
        _ => BTreeSet::new(),
    };
    if use_v2_agents {
        let to_add: Vec<&str> = discovered
            .names
            .iter()
            .map(String::as_str)
            .filter(|name| {
                !v1_agent_names.contains(*name) || discovered.disk_v2_agents.contains(*name)
            })
            .collect();
        if !to_add.is_empty() || config.get("agents").is_some() {
            let agents = config.child("agents").object(false);
            for name in to_add {
                agents.child(name);
            }
            for (_, agent) in &mut agents.0 {
                if let Json::Object(agent) = agent {
                    deny_v2_permissions(agent, names);
                }
            }
        }
    }
    if !use_v2_agents || schema.has_v1_agent {
        let agents = config.child("agent").object(false);
        if !use_v2_agents {
            for name in &discovered.names {
                agents.child(name).object(false);
            }
        }
        for (_, agent) in &mut agents.0 {
            deny_rules(agent.object(false).child("permission").object(true), names);
        }
    }
    config
}

/// Merges mode permissions and skill denies into `OPENCODE_CONFIG_CONTENT`. When `disabled` has
/// no deniable names and the inline text cannot be read, the text is preserved verbatim (logged);
/// when skill denies are active, unreadable text is replaced by the denies so no deny is dropped.
fn opencode_configuration_with(
    text: &str,
    disabled: &BTreeSet<String>,
    agents: &OpenCodeAgents,
    mode_permission: Option<&serde_json::Value>,
) -> String {
    let names = deny_names(disabled);
    if names.is_empty() && mode_permission.is_none() {
        return text.into();
    }
    let (mut config, tokens) = match parse_inline(text, !names.is_empty()) {
        Some(parsed) => parsed,
        None if names.is_empty() => {
            eprintln!("Warning: OpenCode's inline configuration (OPENCODE_CONFIG_CONTENT) could not be read; it is passed on unchanged.");
            return text.into();
        }
        None => {
            if mode_permission.is_none() {
                eprintln!("Warning: PandaCode's OpenCode configuration could not be read; launching with skill denies only.");
            }
            (Object::default(), OpenCodeTokens::default())
        }
    };
    if let Some(policy) = mode_permission {
        let schema = OpenCodeSchema::detect(&config);
        let native = agents.has_v2_permissions || schema.use_v2_permissions || schema.use_v2_agents;
        apply_mode_permission(&mut config, policy, native, agents);
    }
    if !names.is_empty() {
        config = deny_everywhere(config, &names, agents);
    }
    let serialized = serde_json::to_string(&config).expect("OpenCode configuration");
    restore_opencode_tokens(serialized, &tokens)
}

/// What one OpenCode launch sets after a named connection's environment is applied.
#[derive(Debug)]
pub(crate) struct OpenCodeLaunch {
    /// `OPENCODE_CONFIG_CONTENT`: with the denies merged in, or the user's text untouched.
    pub(crate) content: String,
    /// `OPENCODE_PERMISSION`: set whenever a name is deniable, keeping any rules already set.
    pub(crate) permission: Option<String>,
    /// False when the denies could not be merged into the inline configuration: the launch
    /// then also asks (`remind_unenforced`), because agent-level rules in that text may win.
    pub(crate) enforced: bool,
}

/// The configuration for a launch whose inline text came from outside PandaCode (a named
/// connection's `OPENCODE_CONFIG_CONTENT`). The denies always also go through
/// `OPENCODE_PERMISSION`, which OpenCode (1.19) merges into the top-level permissions after every
/// config layer (remote and managed config included). Unquoted `{env:...}` / `{file:...}` tokens
/// are preserved byte-for-byte while merging denies into `OPENCODE_CONFIG_CONTENT`; text that
/// still can't be read even as JSONC is never replaced: it reaches OpenCode untouched and the
/// launch also asks.
/// `permission` is an `OPENCODE_PERMISSION` already set for the launch; its rules are kept.
pub(crate) fn opencode_launch_with(
    text: &str,
    permission: Option<&str>,
    disabled: &BTreeSet<String>,
    agents: &OpenCodeAgents,
) -> OpenCodeLaunch {
    let names = deny_names(disabled);
    if names.is_empty() {
        return OpenCodeLaunch {
            content: text.into(),
            permission: None,
            enforced: true,
        };
    }
    let permission = opencode_permission(permission, disabled);
    if let Some((config, tokens)) = parse_inline(text, true) {
        let serialized = serde_json::to_string(&deny_everywhere(config, &names, agents))
            .expect("OpenCode configuration");
        return OpenCodeLaunch {
            content: restore_opencode_tokens(serialized, &tokens),
            permission,
            enforced: true,
        };
    }
    eprintln!("Warning: OpenCode's inline configuration (OPENCODE_CONFIG_CONTENT) could not be read; it is passed on unchanged, switched-off skills are denied through OPENCODE_PERMISSION and asked about for this launch.");
    OpenCodeLaunch {
        content: text.into(),
        permission,
        enforced: false,
    }
}

#[cfg(test)]
#[path = "enforcement_tests.rs"]
mod tests;

// Tests for enforcement internals, kept in their own files.
#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;
#[cfg(test)]
#[path = "opencode_order_tests.rs"]
mod opencode_order_tests;
