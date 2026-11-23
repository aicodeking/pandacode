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

// serde_json::Map sorts keys in this app. OpenCode evaluates the last matching rule,
// so retain object order locally instead of changing serde_json features for every IPC.
#[derive(Default)]
struct Object(Vec<(String, Json)>);
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Json {
    Object(Object),
    Other(serde_json::Value),
}
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Object;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an ordered JSON object")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Object, M::Error> {
                let mut object = Object::default();
                while let Some((key, value)) = map.next_entry()? {
                    object.put(key, value);
                }
                Ok(object)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
impl Serialize for Object {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}
impl Object {
    fn take(&mut self, key: &str) -> Option<Json> {
        self.0
            .iter()
            .position(|(k, _)| k == key)
            .map(|i| self.0.remove(i).1)
    }
    fn put(&mut self, key: String, value: Json) {
        self.take(&key);
        self.0.push((key, value));
    }
    fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn child(&mut self, key: &str) -> &mut Json {
        let i = self
            .0
            .iter()
            .position(|(k, _)| k == key)
            .unwrap_or_else(|| {
                self.0.push((key.into(), Json::Object(Self::default())));
                self.0.len() - 1
            });
        &mut self.0[i].1
    }
}
impl Json {
    fn object(&mut self, preserve_scalar: bool) -> &mut Object {
        if !matches!(self, Self::Object(_)) {
            let old = std::mem::replace(self, Self::Object(Object::default()));
            if preserve_scalar && matches!(&old, Self::Other(v) if v.is_string()) {
                self.object(false).put("*".into(), old);
            }
        }
        let Self::Object(object) = self else {
            unreachable!()
        };
        object
    }
}

/// Denies for the built-in agents and every agent defined in config or agent files for `cwd`.
/// Consoles have no reminder channel, so an incomplete agent list is only logged there; the
/// Skills page reports that state as asked/none (`opencode_unlisted_agents`).
pub(crate) fn opencode_configuration_at(
    text: &str,
    disabled: &BTreeSet<String>,
    cwd: &Path,
) -> String {
    opencode_enforcement_with(text, disabled, &opencode_agents_at(disabled, cwd))
}

/// The agents an OpenCode launch's denies must reach, rescanned when connection paths change.
#[derive(Clone, Debug, Default)]
pub(crate) struct OpenCodeAgents {
    names: BTreeSet<String>,
    pub(crate) complete: bool,
}

fn deniable(disabled: &BTreeSet<String>) -> bool {
    disabled
        .iter()
        .any(|name| claude_rule_name(name) || name == "*")
}

/// Lists user/project agents using the effective launch paths, retaining every configured home.
pub(crate) fn opencode_all_agents_with_env(cwd: Option<&Path>, env: &OpenCodeEnv) -> OpenCodeAgents {
    let agents = crate::agent_usage_providers::home()
        .map(|home| super::opencode_agents::agents_with_env(cwd, &home, &Homes::for_scan(), env));
    let complete = agents.as_ref().is_none_or(|agents| agents.complete);
    let names = agents.map(|agents| agents.names).unwrap_or_else(|| {
        super::opencode_agents::BUILTIN
            .into_iter()
            .map(String::from)
            .collect()
    });
    OpenCodeAgents { names, complete }
}

/// Lists the agents for `cwd`, only when some switched-off name can be denied.
pub(crate) fn opencode_agents_at(disabled: &BTreeSet<String>, cwd: &Path) -> OpenCodeAgents {
    opencode_agents_at_with_env(
        disabled,
        cwd,
        &OpenCodeEnv::from_environment(|name| std::env::var_os(name)),
    )
}

/// Lists deniable skills' agents using the same effective launch paths as tool grants.
pub(crate) fn opencode_agents_at_with_env(
    disabled: &BTreeSet<String>,
    cwd: &Path,
    env: &OpenCodeEnv,
) -> OpenCodeAgents {
    if !deniable(disabled) {
        return OpenCodeAgents {
            names: BTreeSet::new(),
            complete: true,
        };
    }
    let agents = opencode_all_agents_with_env(Some(cwd), env);
    if !agents.complete {
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
) -> String {
    opencode_configuration_with(text, disabled, &agents.names)
}

#[cfg(test)]
fn opencode_configuration(text: &str, disabled: &BTreeSet<String>) -> String {
    opencode_configuration_with(
        text,
        disabled,
        &["build", "plan", "general", "explore"]
            .into_iter()
            .map(String::from)
            .collect(),
    )
}

/// Permission resource patterns are glob-based; arbitrary names keep the advisory fallback.
fn deny_names(disabled: &BTreeSet<String>) -> Vec<&String> {
    disabled
        .iter()
        .filter(|name| claude_rule_name(name) || name.as_str() == "*")
        .collect()
}

/// Unquoted OpenCode `{env:...}` / `{file:...}` substitution tokens replaced with collision-free
/// JSON string sentinels while parsing JSONC, then restored verbatim after serialization.
#[derive(Default)]
pub(super) struct OpenCodeTokens {
    prefix: String,
    entries: Vec<(String, String)>,
}

impl OpenCodeTokens {
    pub(super) fn contains_sentinel_str(&self, value: &str) -> bool {
        !self.entries.is_empty() && value.starts_with(&self.prefix) && value.ends_with('\x01')
    }

    pub(super) fn is_sentinel_value(&self, value: &serde_json::Value) -> bool {
        value
            .as_str()
            .is_some_and(|s| self.contains_sentinel_str(s))
    }

    fn is_sentinel_json(&self, value: &Json) -> bool {
        matches!(value, Json::Other(v) if self.is_sentinel_value(v))
    }
}

/// Matches a valid unquoted OpenCode `{env:NAME}` or `{file:PATH}` substitution token at the
/// start of `rest`, returning its byte length. Rejects empty bodies, nested braces, quotes, and
/// control characters (and whitespace/commas/colons in `{env:...}`) so malformed JSON is never
/// misread as a substitution token.
fn match_opencode_token(rest: &str) -> Option<usize> {
    let (prefix_len, is_env) = if rest.starts_with("{env:") {
        (5, true)
    } else if rest.starts_with("{file:") {
        (6, false)
    } else {
        return None;
    };
    let tail = &rest[prefix_len..];
    let close = tail.find('}')?;
    let body = &tail[..close];
    if body.is_empty() {
        return None;
    }
    if body
        .chars()
        .any(|c| c.is_control() || matches!(c, '{' | '}' | '"'))
    {
        return None;
    }
    if is_env
        && body
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, ',' | ':'))
    {
        return None;
    }
    Some(prefix_len + close + 1)
}

/// Scans JSONC `text` outside string literals and comments, replacing each unquoted OpenCode
/// `{env:...}` / `{file:...}` token with a unique collision-free JSON string literal sentinel.
/// Runs before `strip_jsonc` so characters inside `{file:...}` (e.g. `//`, `/*`, `,}`) are never
/// misinterpreted as JSONC comments or trailing commas.
pub(super) fn scrub_opencode_tokens(text: &str) -> (String, OpenCodeTokens) {
    let mut nonce = 0usize;
    let prefix = loop {
        let raw = format!("\x01pc_oc_tok_{nonce}_");
        let escaped = format!("\\u0001pc_oc_tok_{nonce}_");
        if !text.contains(&raw) && !text.contains(&escaped) {
            break raw;
        }
        nonce += 1;
    };

    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut entries = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 1;
                        if let Some(ch) = text[i..].chars().next() {
                            i += ch.len_utf8();
                        }
                    } else if bytes[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
                out.push_str(&text[start..i]);
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                let start = i;
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                out.push_str(&text[start..i]);
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                let start = i;
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = if i + 1 < bytes.len() {
                    i + 2
                } else {
                    bytes.len()
                };
                out.push_str(&text[start..i]);
            }
            b'{' => {
                if let Some(token_len) = match_opencode_token(&text[i..]) {
                    let token = &text[i..i + token_len];
                    let raw = format!("{prefix}{}\x01", entries.len());
                    let literal = serde_json::to_string(&raw).expect("OpenCode token sentinel");
                    out.push_str(&literal);
                    entries.push((literal, token.to_owned()));
                    i += token_len;
                } else {
                    out.push('{');
                    i += 1;
                }
            }
            _ => {
                let start = i;
                i += 1;
                while i < bytes.len() && !matches!(bytes[i], b'"' | b'/' | b'{') {
                    i += 1;
                }
                out.push_str(&text[start..i]);
            }
        }
    }

    (out, OpenCodeTokens { prefix, entries })
}

/// Restores every JSON-quoted sentinel back to its exact original unquoted `{env:...}` /
/// `{file:...}` token verbatim.
fn restore_opencode_tokens(mut json: String, tokens: &OpenCodeTokens) -> String {
    for (literal, original) in &tokens.entries {
        json = json.replace(literal, original);
    }
    json
}

/// Returns true when a scrubbed `{env:...}` / `{file:...}` sentinel occupies a permission or
/// agent container slot that merging would overwrite or misinterpret (e.g. `"permission": {env:P}`).
fn has_structural_sentinel(config: &Object, tokens: &OpenCodeTokens, check_skill: bool) -> bool {
    if tokens.entries.is_empty() {
        return false;
    }
    let has_skill_sentinel = |perm: &Json| match perm {
        Json::Object(obj) => obj
            .get("skill")
            .is_some_and(|v| tokens.is_sentinel_json(v)),
        _ => false,
    };
    for (key, value) in &config.0 {
        if tokens.contains_sentinel_str(key) {
            return true;
        }
        match key.as_str() {
            "permission" => {
                if tokens.is_sentinel_json(value) || (check_skill && has_skill_sentinel(value)) {
                    return true;
                }
            }
            "permissions" => {
                if tokens.is_sentinel_json(value) {
                    return true;
                }
            }
            "agent" => {
                if tokens.is_sentinel_json(value) {
                    return true;
                }
                if let Json::Object(agents) = value {
                    for (agent_name, agent_val) in &agents.0 {
                        if tokens.contains_sentinel_str(agent_name)
                            || tokens.is_sentinel_json(agent_val)
                        {
                            return true;
                        }
                        if let Json::Object(agent_obj) = agent_val {
                            if let Some(perm) = agent_obj.get("permission") {
                                if tokens.is_sentinel_json(perm)
                                    || (check_skill && has_skill_sentinel(perm))
                                {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            "agents" => {
                if tokens.is_sentinel_json(value) {
                    return true;
                }
                if let Json::Object(agents) = value {
                    for (agent_name, agent_val) in &agents.0 {
                        if tokens.contains_sentinel_str(agent_name)
                            || tokens.is_sentinel_json(agent_val)
                        {
                            return true;
                        }
                        if let Json::Object(agent_obj) = agent_val {
                            if let Some(perms) = agent_obj.get("permissions") {
                                if tokens.is_sentinel_json(perms) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// The inline configuration as an ordered object, read as JSONC with unquoted `{env:...}` /
/// `{file:...}` tokens temporarily scrubbed to sentinels; `None` when parsing still fails or a
/// sentinel occupies a permission/agent container slot.
fn parse_inline(text: &str, check_skill: bool) -> Option<(Object, OpenCodeTokens)> {
    let (scrubbed, tokens) = scrub_opencode_tokens(text);
    let config: Object = serde_json::from_str(&crate::vsix_themes::strip_jsonc(&scrubbed)).ok()?;
    if has_structural_sentinel(&config, &tokens, check_skill) {
        return None;
    }
    Some((config, tokens))
}

/// Detected OpenCode 1.x vs 2.x permission/agent schema for one inline config document.
struct OpenCodeSchema {
    has_v1_permission: bool,
    has_v1_agent: bool,
    use_v2_permissions: bool,
    use_v2_agents: bool,
}

impl OpenCodeSchema {
    fn detect(inline: &Object) -> Self {
        let has_v2_permissions = matches!(
            inline.get("permissions"),
            Some(Json::Other(serde_json::Value::Array(_)))
        );
        let has_v2_agents = matches!(inline.get("agents"), Some(Json::Object(_)));
        let has_v1_permission = inline.get("permission").is_some();
        let has_v1_agent = inline.get("agent").is_some();
        let use_v2_permissions = has_v2_permissions || (has_v2_agents && !has_v1_permission);
        let use_v2_agents = has_v2_agents || (has_v2_permissions && !has_v1_agent);
        Self {
            has_v1_permission,
            has_v1_agent,
            use_v2_permissions,
            use_v2_agents,
        }
    }
}

/// Appends exact bound-server allow rules to an OpenCode 2.x native `permissions` array.
fn grant_rules(rules: &mut Vec<serde_json::Value>, served: &[&str]) {
    for name in served {
        let name = format!("pandacode_architect_{name}");
        let trailing = trailing_key(&name);
        for action in [name, trailing] {
            rules.push(serde_json::json!({
                "action": action,
                "resource": "*",
                "effect": "allow",
            }));
        }
    }
}

/// Appends exact bound-server grants to an OpenCode 2.x `permissions` array field, creating it
/// when absent so OpenCode 2.x (which ignores legacy `agent.<name>` when `agents.<name>` exists)
/// still carries the grants after any project-level agent wildcards.
fn grant_v2_permissions(target: &mut Object, served: &[&str]) {
    match target.get_mut("permissions") {
        Some(Json::Other(serde_json::Value::Array(rules))) => grant_rules(rules, served),
        None => {
            let mut rules = Vec::new();
            grant_rules(&mut rules, served);
            target.put(
                "permissions".into(),
                Json::Other(serde_json::Value::Array(rules)),
            );
        }
        Some(_) => {}
    }
}

fn grant_v1_permissions(permission: &mut Object, served: &[&str]) {
    for name in served {
        let name = format!("pandacode_architect_{name}");
        permission.put(name.clone(), Json::Other(serde_json::json!("allow")));
        permission.put(trailing_key(&name), Json::Other(serde_json::json!("allow")));
    }
}

fn grant_permission_env(
    permission: Option<&str>,
    served: &[&str],
    create_if_missing: bool,
) -> Option<String> {
    let mut rules = match permission {
        Some(text) => match serde_json::from_str::<Json>(text) {
            Ok(Json::Object(rules)) => rules,
            Ok(Json::Other(serde_json::Value::String(action)))
                if PERMISSION_ACTIONS.contains(&action.as_str()) =>
            {
                let mut rules = Object::default();
                rules.put("*".into(), Json::Other(serde_json::Value::String(action)));
                rules
            }
            _ if create_if_missing => {
                eprintln!("Warning: OPENCODE_PERMISSION is not a permission object or action; launching OpenCode with bound tool grants only.");
                Object::default()
            }
            _ => return None,
        },
        None if create_if_missing => Object::default(),
        None => return None,
    };
    grant_v1_permissions(&mut rules, served);
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
    let Some((mut inline, tokens)) = parse_inline(text, false) else {
        return Some((
            text.to_owned(),
            grant_permission_env(permission, served, true),
        ));
    };
    let schema = OpenCodeSchema::detect(&inline);

    if schema.use_v2_permissions {
        grant_v2_permissions(&mut inline, served);
    }
    if !schema.use_v2_permissions || schema.has_v1_permission {
        grant_v1_permissions(inline.child("permission").object(true), served);
    }

    let target_agents: BTreeSet<&str> = super::opencode_agents::BUILTIN
        .into_iter()
        .chain(agents.names.iter().map(String::as_str))
        .collect();
    let v1_agent_names: BTreeSet<String> = match inline.get("agent") {
        Some(Json::Object(agents)) => agents.0.iter().map(|(k, _)| k.clone()).collect(),
        _ => BTreeSet::new(),
    };
    if schema.use_v2_agents {
        let agents = inline.child("agents").object(false);
        for name in &target_agents {
            if !v1_agent_names.contains(*name) {
                agents.child(name);
            }
        }
        for (_, agent) in &mut agents.0 {
            if let Json::Object(agent) = agent {
                grant_v2_permissions(agent, served);
            }
        }
    }
    if !schema.use_v2_agents || schema.has_v1_agent {
        let agents = inline.child("agent").object(false);
        if !schema.use_v2_agents {
            for name in &target_agents {
                agents.child(name);
            }
        }
        for (_, agent) in &mut agents.0 {
            grant_v1_permissions(agent.object(false).child("permission").object(true), served);
        }
    }
    let permission = grant_permission_env(permission, served, false);
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
    known_agents: &BTreeSet<String>,
) -> Object {
    let schema = OpenCodeSchema::detect(&config);

    if schema.use_v2_permissions {
        deny_v2_permissions(&mut config, names);
    }
    if !schema.use_v2_permissions || schema.has_v1_permission {
        deny_rules(config.child("permission").object(true), names);
    }

    let v1_agent_names: BTreeSet<String> = match config.get("agent") {
        Some(Json::Object(agents)) => agents.0.iter().map(|(k, _)| k.clone()).collect(),
        _ => BTreeSet::new(),
    };
    if schema.use_v2_agents {
        let agents = config.child("agents").object(false);
        for name in known_agents {
            if !v1_agent_names.contains(name) {
                agents.child(name);
            }
        }
        for (_, agent) in &mut agents.0 {
            if let Json::Object(agent) = agent {
                deny_v2_permissions(agent, names);
            }
        }
    }
    if !schema.use_v2_agents || schema.has_v1_agent {
        let agents = config.child("agent").object(false);
        if !schema.use_v2_agents {
            for name in known_agents {
                agents.child(name).object(false);
            }
        }
        for (_, agent) in &mut agents.0 {
            deny_rules(agent.object(false).child("permission").object(true), names);
        }
    }
    config
}

/// For PandaCode's own configuration text, which always parses. Text that somehow doesn't is
/// replaced by the denies alone (logged): a deny is never dropped.
fn opencode_configuration_with(
    text: &str,
    disabled: &BTreeSet<String>,
    known_agents: &BTreeSet<String>,
) -> String {
    let names = deny_names(disabled);
    if names.is_empty() {
        return text.into();
    }
    let (config, tokens) = parse_inline(text, true).unwrap_or_else(|| {
        eprintln!("Warning: PandaCode's OpenCode configuration could not be read; launching with skill denies only.");
        (Object::default(), OpenCodeTokens::default())
    });
    let serialized =
        serde_json::to_string(&deny_everywhere(config, &names, known_agents)).expect("OpenCode configuration");
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
        let serialized = serde_json::to_string(&deny_everywhere(config, &names, &agents.names))
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
