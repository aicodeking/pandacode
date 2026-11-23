//! OpenCode inline-config plumbing for `enforcement`: an order-preserving JSON object, the
//! `{env:...}` / `{file:...}` token scrubbing that lets JSONC with substitutions parse, and
//! OpenCode 1.x/2.x schema detection.

use super::*;

// serde_json::Map sorts keys in this app. OpenCode evaluates the last matching rule,
// so retain object order locally instead of changing serde_json features for every IPC.
#[derive(Default)]
pub(super) struct Object(pub(super) Vec<(String, Json)>);
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Json {
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
    pub(super) fn take(&mut self, key: &str) -> Option<Json> {
        self.0
            .iter()
            .position(|(k, _)| k == key)
            .map(|i| self.0.remove(i).1)
    }
    pub(super) fn put(&mut self, key: String, value: Json) {
        self.take(&key);
        self.0.push((key, value));
    }
    pub(super) fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub(super) fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub(super) fn child(&mut self, key: &str) -> &mut Json {
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
    pub(super) fn object(&mut self, preserve_scalar: bool) -> &mut Object {
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

/// Unquoted OpenCode `{env:...}` / `{file:...}` substitution tokens replaced with collision-free
/// JSON string sentinels while parsing JSONC, then restored verbatim after serialization.
#[derive(Default)]
pub(in crate::skill_manager) struct OpenCodeTokens {
    prefix: String,
    entries: Vec<(String, String)>,
}

impl OpenCodeTokens {
    pub(in crate::skill_manager) fn contains_sentinel_str(&self, value: &str) -> bool {
        !self.entries.is_empty() && value.starts_with(&self.prefix) && value.ends_with('\x01')
    }

    pub(in crate::skill_manager) fn is_sentinel_value(&self, value: &serde_json::Value) -> bool {
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
pub(in crate::skill_manager) fn scrub_opencode_tokens(text: &str) -> (String, OpenCodeTokens) {
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
pub(super) fn restore_opencode_tokens(mut json: String, tokens: &OpenCodeTokens) -> String {
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
pub(super) fn parse_inline(text: &str, check_skill: bool) -> Option<(Object, OpenCodeTokens)> {
    let (scrubbed, tokens) = scrub_opencode_tokens(text);
    let config: Object = serde_json::from_str(&crate::vsix_themes::strip_jsonc(&scrubbed)).ok()?;
    if has_structural_sentinel(&config, &tokens, check_skill) {
        return None;
    }
    Some((config, tokens))
}

/// Detected OpenCode 1.x vs 2.x permission/agent schema for one inline config document.
pub(super) struct OpenCodeSchema {
    pub(super) has_v1_permission: bool,
    pub(super) has_v1_agent: bool,
    pub(super) use_v2_permissions: bool,
    pub(super) use_v2_agents: bool,
}

impl OpenCodeSchema {
    pub(super) fn detect(inline: &Object) -> Self {
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
