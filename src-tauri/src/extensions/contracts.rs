//! The native half of the shared v1 contract corpus.
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/extensions/schema-v1.json"))
        .expect("shipped extension schema")
});
type Result<T> = std::result::Result<T, Value>;
/// One limit of the public primitive declaration (`x-primitives`) shared with the frontend renderers.
pub fn primitive_limit(family: &str, name: &str) -> u64 {
    SCHEMA["x-primitives"]["families"][family]["limits"][name]["value"].as_u64().expect("declared primitive limit")
}
const CONTRIBUTIONS: [&str; 15] = ["commands", "icons", "menus", "views", "layouts", "settings", "keybindings", "dialogExtras", "themes", "components", "tools", "connections", "services", "providers", "slashCommands"];
static PACKAGE_ID: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$").unwrap());
static ASSET_PATH: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^assets/[a-zA-Z0-9_./-]+\.(svg|png|webp)$").unwrap());

fn fail(code: &str, path: &str, ids: Vec<String>) -> Value {
    json!({"schemaVersion": 1, "code": code, "path": path.chars().take(512).collect::<String>(), "ids": ids.into_iter().take(64).collect::<Vec<_>>()})
}
fn equal(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() { left.as_f64() == right.as_f64() }
    else { left == right }
}
fn invalid(path: &str) -> Value { fail("InvalidShape", path, vec![]) }
fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().map(|v| v.as_str().unwrap_or("").to_owned()).collect()).unwrap_or_default()
}
fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str { value[key].as_str().unwrap_or("") }
fn appearance_luminance(hex: &str) -> f64 {
    [0.2126, 0.7152, 0.0722].iter().enumerate().map(|(i, weight)| {
        let value = u8::from_str_radix(&hex[1 + i * 2..3 + i * 2], 16).unwrap_or(0) as f64 / 255.0;
        weight * if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    }).sum()
}
fn appearance_contrast(a: &str, b: &str) -> f64 { let a = appearance_luminance(a); let b = appearance_luminance(b); (a.max(b) + 0.05) / (a.min(b) + 0.05) }
fn distinct(values: &[Value], key: &str, path: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    for value in values { let id = text(value, key); if !seen.insert(id) { return Err(fail("DuplicateId", path, vec![id.to_owned()])); } }
    Ok(())
}
fn dialog_fields(dialog: &Value, path: &str) -> Result<()> {
    distinct(items(dialog, "fields"), "id", path)?;
    for field in items(dialog, "fields") {
        if field["kind"] == "select" { distinct(items(field, "options"), "value", &format!("{path}/{}/options", text(field, "id")))?; }
    }
    Ok(())
}
fn bounded(value: &Value, path: &str, depth: u64, nodes: &mut u64, bytes: &mut u64) -> Result<()> {
    *nodes += 1;
    let limits = &SCHEMA["x-dataLimits"];
    if depth > limits["depth"].as_u64().unwrap() || *nodes > limits["nodes"].as_u64().unwrap() { return Err(fail("LimitExceeded", path, vec![])); }
    match value {
        Value::Array(values) => {
            *bytes += 2 + values.len().saturating_sub(1) as u64;
            for (i, item) in values.iter().enumerate() { bounded(item, &format!("{path}/{i}"), depth + 1, nodes, bytes)?; }
        }
        Value::Object(values) => {
            *bytes += 2 + values.len().saturating_sub(1) as u64;
            for (key, item) in values.iter().collect::<BTreeMap<_, _>>() {
                *bytes += serde_json::to_string(key).unwrap().len() as u64 + 1;
                bounded(item, &format!("{path}/{key}"), depth + 1, nodes, bytes)?;
            }
        }
        Value::Number(_) => *bytes += limits["numberBytes"].as_u64().unwrap(),
        _ => *bytes += serde_json::to_string(value).unwrap().len() as u64,
    }
    Ok(())
}

fn shape(value: &Value, schema: &Value, path: &str, diagnostics: &mut Vec<Value>) -> Result<Value> {
    if let Some(reference) = schema["$ref"].as_str() {
        return shape(value, &SCHEMA["$defs"][reference.rsplit('/').next().unwrap()], path, diagnostics);
    }
    // Opaque JSON (`x-opaqueJson`): already bounded by the walk, copied unchanged, limited in compact bytes.
    if let Some(opaque) = schema.get("x-opaqueJson") {
        if opaque["top"] == "object" && !value.is_object() { return Err(invalid(path)); }
        if value.to_string().len() as u64 > opaque["bytes"].as_u64().unwrap_or(0) { return Err(fail("LimitExceeded", path, vec![])); }
        return Ok(value.clone());
    }
    if let Some(alternatives) = schema["anyOf"].as_array() {
        for alternative in alternatives {
            let mut notes = vec![];
            if let Ok(result) = shape(value, alternative, path, &mut notes) {
                diagnostics.extend(notes);
                return Ok(result);
            }
        }
        return Err(invalid(path));
    }
    if let Some(expected) = schema.get("const") {
        return if equal(value, expected) { Ok(expected.clone()) } else { Err(invalid(path)) };
    }
    if let Some(values) = schema["enum"].as_array() {
        return values.iter().find(|expected| equal(value, expected)).cloned().ok_or_else(|| invalid(path));
    }
    match schema["type"].as_str().unwrap_or("") {
        "string" => {
            let string = value.as_str().ok_or_else(|| invalid(path))?;
            let length = string.chars().count() as u64;
            if length < schema["minLength"].as_u64().unwrap_or(0) || length > schema["maxLength"].as_u64().unwrap_or(u64::MAX) {
                return Err(fail("LimitExceeded", path, vec![]));
            }
            if let Some(pattern) = schema["pattern"].as_str() {
                if !regex::Regex::new(pattern).expect("shipped schema pattern").is_match(string) { return Err(invalid(path)); }
            }
        }
        "boolean" => if !value.is_boolean() { return Err(invalid(path)); },
        "integer" => {
            let number = value.as_f64().ok_or_else(|| invalid(path))?;
            if number.fract() != 0.0 || number.abs() > 9007199254740991.0 { return Err(invalid(path)); }
            if number < schema["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY) || number > schema["maximum"].as_f64().unwrap_or(f64::INFINITY) {
                return Err(fail("LimitExceeded", path, vec![]));
            }
            // Canonicalize 1.0 to the same integer JSON representation used in the frontend.
            return Ok(json!(number as i64));
        }
        "array" => {
            let array = value.as_array().ok_or_else(|| invalid(path))?;
            let length = array.len() as u64;
            if length < schema["minItems"].as_u64().unwrap_or(0) || length > schema["maxItems"].as_u64().unwrap_or(u64::MAX) {
                return Err(fail("LimitExceeded", path, vec![]));
            }
            return array.iter().enumerate().map(|(i, item)| shape(item, &schema["items"], &format!("{path}/{i}"), diagnostics)).collect::<Result<Vec<_>>>().map(Value::Array);
        }
        "object" => {
            let object = value.as_object().ok_or_else(|| invalid(path))?;
            for key in strings(&schema["required"]) {
                if !object.contains_key(&key) { return Err(invalid(&format!("{path}/{key}"))); }
            }
            if object.len() as u64 > schema["maxProperties"].as_u64().unwrap_or(u64::MAX) { return Err(fail("LimitExceeded", path, vec![])); }
            let mut result = Map::new();
            // Sort explicitly: serde_json may be compiled with preserve_order by another dependency.
            let sorted: BTreeMap<_, _> = object.iter().collect();
            for (key, item) in sorted {
                let child = schema["properties"].get(key).unwrap_or(&schema["additionalProperties"]);
                let child_path = format!("{path}/{key}");
                if child == false { return Err(invalid(&child_path)); }
                if child.is_object() { result.insert(key.clone(), shape(item, child, &child_path, diagnostics)?); }
                else { diagnostics.push(json!({"code": "UnknownOptionalField", "path": child_path})); }
            }
            return Ok(Value::Object(result));
        }
        _ => {}
    }
    Ok(value.clone())
}

fn version(text: &str) -> Option<[u64; 3]> {
    let components: Vec<_> = text.split('.').collect();
    if components.len() != 3 { return None; }
    let mut result = [0; 3];
    for (i, component) in components.iter().enumerate() {
        if component.is_empty() || component.len() > 6 || (component.len() > 1 && component.starts_with('0')) || !component.bytes().all(|b| b.is_ascii_digit()) { return None; }
        result[i] = component.parse().ok()?;
    }
    Some(result)
}
fn matches(range: &str, actual: &str, path: &str) -> Result<bool> {
    let prefix = range.chars().next().filter(|c| *c == '^' || *c == '~');
    let base = version(if prefix.is_some() { &range[1..] } else { range });
    let current = version(actual).expect("validated version");
    if let Some(base) = base {
        let Some(prefix) = prefix else { return Ok(current == base); };
        let upper = if prefix == '~' { [base[0], base[1] + 1, 0] }
            else if base[0] > 0 { [base[0] + 1, 0, 0] }
            else if base[1] > 0 { [0, base[1] + 1, 0] }
            else { [0, 0, base[2] + 1] };
        return Ok(current >= base && current < upper);
    }
    if let Some(interval) = range.strip_prefix(">=") {
        if let Some((lower, upper)) = interval.split_once(" <") {
            if let (Some(lower), Some(upper)) = (version(lower), version(upper)) {
                if lower < upper { return Ok(current >= lower && current < upper); }
            }
        }
    }
    Err(fail("InvalidVersionRange", path, vec![]))
}
fn package_id(id: &str, path: &str) -> Result<()> {
    if !PACKAGE_ID.is_match(id) {
        return Err(fail("InvalidId", path, vec![id.to_owned()]));
    }
    if id.starts_with("panda.") { return Err(fail("ReservedId", path, vec![id.to_owned()])); }
    Ok(())
}
/// Deterministic topological order: each step takes the lowest-ranked node with no remaining
/// predecessor (`rank` is total over distinct IDs). Kahn's algorithm over positions ranked once keeps
/// 1,000 menus from re-sorting every step; a cycle reports the sorted IDs still remaining.
fn order_graph(nodes: Vec<String>, edges: &[(String, String)], code: &str, path: &str, rank: impl Fn(&String, &String) -> std::cmp::Ordering) -> Result<Vec<String>> {
    let mut remaining: BTreeSet<_> = nodes.into_iter().collect();
    let mut blockers: BTreeMap<&String, usize> = BTreeMap::new();
    let mut successors: BTreeMap<&String, Vec<&String>> = BTreeMap::new();
    for (from, to) in edges {
        if remaining.contains(from) && remaining.contains(to) {
            *blockers.entry(to).or_default() += 1;
            successors.entry(from).or_default().push(to);
        }
    }
    let mut sorted: Vec<String> = remaining.iter().cloned().collect();
    sorted.sort_by(&rank);
    let position: BTreeMap<String, usize> = sorted.into_iter().enumerate().map(|(index, id)| (id, index)).collect();
    let mut ready: Vec<String> = remaining.iter().filter(|id| !blockers.contains_key(id)).cloned().collect();
    let mut result = vec![];
    while !ready.is_empty() {
        let best = (0..ready.len()).min_by_key(|&i| position[&ready[i]]).unwrap();
        let id = ready.swap_remove(best);
        remaining.remove(&id);
        for to in successors.get(&id).cloned().unwrap_or_default() {
            let left = blockers.get_mut(to).unwrap();
            *left -= 1;
            if *left == 0 { ready.push(to.clone()); }
        }
        result.push(id);
    }
    if !remaining.is_empty() { return Err(fail(code, path, remaining.into_iter().collect())); }
    Ok(result)
}
fn reference(contributions: &Value, kind: &str, id: &Value, path: &str) -> Result<()> {
    if !items(contributions, kind).iter().any(|item| item["id"] == *id) {
        return Err(fail("UnknownReference", path, vec![id.as_str().unwrap_or("").to_owned()]));
    }
    Ok(())
}
fn menu_items<'a>(values: &'a [Value], contributions: Option<&Value>, owner: &str, owned: &mut BTreeSet<&'a str>, path: &str, depth: u64, count: &mut u64) -> Result<()> {
    *count += values.len() as u64;
    if depth > SCHEMA["x-menuLimits"]["depth"].as_u64().unwrap() || *count > SCHEMA["x-menuLimits"]["items"].as_u64().unwrap() { return Err(fail("LimitExceeded", path, vec![])); }
    let mut checked_groups = BTreeSet::new();
    for item in values {
        let id = text(item, "id");
        if id.starts_with("panda.") { return Err(fail("ReservedId", path, vec![id.to_owned()])); }
        if !id.starts_with(&format!("{owner}/")) { return Err(fail("InvalidId", path, vec![id.to_owned()])); }
        if !owned.insert(id) { return Err(fail("DuplicateId", path, vec![id.to_owned()])); }
        let kind = text(item, "kind");
        if kind == "separator" {
            if item.as_object().unwrap().keys().any(|key| !["id", "kind", "visible"].contains(&key.as_str())) { return Err(invalid(path)); }
            continue;
        }
        if item.get("title").is_none() || (if kind == "submenu" { item.get("items").is_none() || item.get("command").is_some() } else { item.get("command").is_none() || item.get("items").is_some() }) { return Err(invalid(path)); }
        if (!["checkbox", "radio"].contains(&kind) && item.get("checked").is_some()) || (kind == "radio" && item.get("group").is_none()) || (kind != "radio" && item.get("group").is_some()) { return Err(invalid(path)); }
        if kind == "radio" && item["checked"] == true && !checked_groups.insert(text(item, "group")) { return Err(invalid(path)); }
        if let Some(contributions) = contributions {
            if item.get("command").is_some() { reference(contributions, "commands", &item["command"], path)?; }
            if item.get("icon").is_some() { reference(contributions, "icons", &item["icon"], path)?; }
        }
        if item.get("items").is_some() { menu_items(items(item, "items"), contributions, owner, owned, path, depth + 1, count)?; }
    }
    Ok(())
}
fn manifests(input: &Value, diagnostics: &mut Vec<Value>, allow_missing: bool) -> Result<Value> {
    let input = input.as_array().ok_or_else(|| invalid("$"))?;
    if input.len() as u64 > SCHEMA["x-dataLimits"]["packages"].as_u64().unwrap() { return Err(fail("LimitExceeded", "$", vec![])); }
    let mut packages = input.iter().enumerate().map(|(i, value)| shape(value, &SCHEMA["$defs"]["manifest"], &format!("$/{i}"), diagnostics)).collect::<Result<Vec<_>>>()?;
    let mut ids = BTreeSet::new();
    let mut menus = vec![];
    for (index, manifest) in packages.iter_mut().enumerate() {
        let path = format!("$/{index}");
        let id = text(manifest, "id").to_owned();
        package_id(&id, &format!("{path}/id"))?;
        if !ids.insert(id.clone()) { return Err(fail("DuplicateId", &format!("{path}/id"), vec![id])); }
        if ["entrypoint", "activationEvents", "scripts"].iter().any(|key| input[index].get(key).is_some()) { return Err(fail("UnsupportedRuntime", &path, vec![id])); }
        if !matches(text(&manifest["engines"], "pandacodeApi"), "1.0.0", &format!("{path}/engines/pandacodeApi"))? { return Err(fail("IncompatibleApi", &format!("{path}/engines/pandacodeApi"), vec![id])); }
        for key in ["permissions", "requiredCapabilities"] {
            for capability in strings(&manifest[key]) {
                if !super::runtime_grants::PERMISSIONS.contains(&capability.as_str()) { return Err(fail("UnsupportedCapability", &format!("{path}/{key}"), vec![capability])); }
            }
        }
        let optional = strings(&manifest["optionalCapabilities"]);
        for (i, capability) in optional.iter().enumerate() {
            if !super::runtime_grants::PERMISSIONS.contains(&capability.as_str()) {
                diagnostics.push(json!({"code":"UnknownOptionalCapability", "path":format!("{path}/optionalCapabilities/{i}")}));
            }
        }
        if manifest.get("optionalCapabilities").is_some() { manifest["optionalCapabilities"] = json!(optional.into_iter().filter(|v| super::runtime_grants::PERMISSIONS.contains(&v.as_str())).collect::<Vec<_>>()); }
        for kind in strings(&manifest["requiredContributions"]) {
            if !CONTRIBUTIONS.contains(&kind.as_str()) { return Err(fail("UnsupportedContribution", &format!("{path}/requiredContributions"), vec![kind])); }
        }
        let contributions = &manifest["contributes"];
        for theme in items(contributions, "themes") { for mode in ["light", "dark"] {
            let colors = &theme[mode];
            if appearance_contrast(text(colors, "background"), text(colors, "foreground")) < 7.0 || appearance_contrast(text(colors, "background"), text(colors, "accent")) < 3.0 { return Err(fail("InvalidAppearanceContrast", &format!("{path}/contributes/themes"), vec![])); }
        } }
        let executable: Vec<_> = items(contributions, "commands").iter().filter(|command| command["action"]["kind"] == "runCommand").chain(items(contributions, "providers").iter().filter(|provider| provider.get("launch").is_none())).map(|command| text(command, "id").to_owned()).collect();
        for provider in items(contributions, "providers") {
            if !crate::skill_manager::roots::discovery::valid_roots(text(provider, "id"), &provider["discovery"]) {
                return Err(fail("PermissionDenied", &format!("{path}/contributes/providers/discovery"), vec![text(provider, "id").into()]));
            }
            // A `launch` provider is declared, not executed by package code: it needs executable trust but no handler or runtime.
            let launched = provider.get("launch").is_some();
            if !launched && manifest.get("runtime").is_none() { return Err(fail("UnsupportedRuntime", &path, vec![])); }
            if launched {
                let launch = &provider["launch"];
                let command = strings(&launch["command"]);
                let placeholders_ok = command.iter().chain(launch["env"].as_object().into_iter().flat_map(|env| env.values()).filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>().iter())
                    .all(|value| { let mut rest = value.as_str(); loop { let Some(start) = rest.find('{') else { return true }; let Some(end) = rest[start..].find('}') else { return false }; if !["node", "package", "data"].contains(&&rest[start + 1..start + end]) { return false; } rest = &rest[start + end + 1..]; } });
                if command.is_empty() || command[0].is_empty() || !placeholders_ok || launch["env"].as_object().is_some_and(|env| env.len() > 32 || env.keys().any(|name| name.is_empty() || name.contains(['=', '\0']))) { return Err(fail("InvalidShape", &format!("{path}/contributes/providers/launch"), vec![text(provider, "id").into()])); }
            } else if items(provider, "models").is_empty() && provider["metadata"]["signIn"].is_null() { return Err(fail("InvalidShape", &format!("{path}/contributes/providers/models"), vec![text(provider, "id").into()])); }
            // `metadata.signIn` / `signOut` bind the provider's Sign in and Sign out actions to commands of this package (R0806).
            for action in ["signIn", "signOut"] {
                if let Some(command) = provider["metadata"][action]["command"].as_str() {
                    if !items(contributions, "commands").iter().any(|item| item["id"] == command) { return Err(fail("UnknownReference", &format!("{path}/contributes/providers/metadata/{action}"), vec![command.into()])); }
                }
            }
            let modes = strings(&provider["metadata"]["modes"]);
            if modes.iter().collect::<BTreeSet<_>>().len() != modes.len() { return Err(fail("DuplicateId", &path, vec![])); }
            if let Some(icon) = provider["metadata"]["icon"].as_str() {
                if !icon.starts_with(&format!("{id}/")) || !items(contributions, "icons").iter().any(|entry| entry["id"] == icon) { return Err(fail("MissingReference", &path, vec![icon.into()])); }
            }
            let mut models = BTreeSet::new();
            for model in items(provider, "models") {
                let efforts = strings(&model["efforts"]);
                // Match core storage's byte bound even for multibyte model IDs.
                if text(model, "id").len() > 200 { return Err(fail("LimitExceeded", &format!("{path}/contributes/providers/models"), vec![])); }
                let tiers: Vec<&str> = items(model, "speedTiers").iter().map(|tier| text(tier, "id")).collect();
                if !models.insert(text(model, "id")) || efforts.iter().collect::<BTreeSet<_>>().len() != efforts.len() || tiers.iter().collect::<BTreeSet<_>>().len() != tiers.len() { return Err(fail("DuplicateId", &path, vec![])); }
            }
        }
        let events = strings(&manifest["runtime"]["activationEvents"]);
        // A background service takes its commands from the service itself, so activationEvents may be left out (R0201);
        // when listed they still have to match the package's executable commands.
        let service_without_events = manifest["runtime"].get("service").is_some() && manifest["runtime"].get("activationEvents").is_none();
        if !service_without_events && (manifest.get("runtime").is_some() && (executable.is_empty() || events.iter().collect::<BTreeSet<_>>().len() != events.len() || events.iter().any(|event| !executable.contains(event))) || executable.iter().any(|id| !events.contains(id))) { return Err(fail("UnsupportedRuntime", &path, vec![id])); }
        // A background service is a named permission: it must be declared to be granted (runtime-service-lifetime.md).
        if manifest["runtime"].get("service").is_some() && !strings(&manifest["permissions"]).contains(&"runtime.service".to_owned()) { return Err(fail("PermissionDenied", &format!("{path}/permissions"), vec![id])); }
        let mut owned = BTreeSet::new();
        let mut tool_commands = BTreeSet::new();
        for service in items(contributions, "services") {
            if manifest.get("runtime").is_none() { return Err(fail("UnsupportedRuntime", &path, vec![])); }
            let mut methods = BTreeSet::new();
            for method in items(service, "methods") { if !methods.insert(text(method, "id")) { return Err(fail("DuplicateId", &path, vec![])); } }
        }
        for connection in items(contributions, "connections") {
            if !executable.contains(&text(connection, "command").to_owned()) || !strings(&manifest["permissions"]).contains(&"connections.request".to_owned()) || !tool_commands.insert(text(connection, "command")) { return Err(fail("PermissionDenied", &path, vec![])); }
            let mut operations = BTreeSet::new();
            for operation in items(connection, "operations") {
                if !operations.insert(text(operation, "id")) { return Err(fail("DuplicateId", &path, vec![])); }
                if super::connections::endpoint(text(operation, "url")).is_err() { return Err(fail("PermissionDenied", &path, vec![])); }
            }
            // The authentication names what it needs (R0804): the header or the query parameter that carries the credential.
            if text(connection, "authentication") == "header" && connection.get("headerName").and_then(Value::as_str).is_none() || text(connection, "authentication") == "query" && connection.get("queryName").and_then(Value::as_str).is_none() { return Err(fail("InvalidShape", &path, vec![])); }
        }
        for tool in items(contributions, "tools") {
            if !executable.contains(&text(tool, "command").to_owned()) || !strings(&manifest["permissions"]).contains(&"tools.execute".to_owned()) || !tool_commands.insert(text(tool, "command")) { return Err(fail("PermissionDenied", &path, vec![])); }
        }
        for kind in CONTRIBUTIONS {
            for item in items(contributions, kind) {
                let item_id = text(item, "id");
                let item_path = format!("{path}/contributes/{kind}");
                if item_id.starts_with("panda.") { return Err(fail("ReservedId", &item_path, vec![item_id.to_owned()])); }
                if !item_id.starts_with(&format!("{id}/")) { return Err(fail("InvalidId", &item_path, vec![item_id.to_owned()])); }
                if !owned.insert(item_id) { return Err(fail("DuplicateId", &item_path, vec![item_id.to_owned()])); }
            }
        }
        for icon in items(contributions, "icons") {
            let asset = text(icon, "asset");
            if !ASSET_PATH.is_match(asset) || asset.split('/').any(|v| v.is_empty() || v == "." || v == "..") {
                return Err(fail("UnsafeAsset", &format!("{path}/contributes/icons"), vec![text(icon, "id").to_owned()]));
            }
        }
        for command in items(contributions, "commands") {
            if command.get("icon").is_some() { reference(contributions, "icons", &command["icon"], &format!("{path}/contributes/commands"))?; }
            if command["action"]["kind"] == "openView" { reference(contributions, "views", &command["action"]["view"], &format!("{path}/contributes/commands"))?; }
            if command["action"]["kind"] == "showDialog" { dialog_fields(&command["action"]["dialog"], &format!("{path}/contributes/commands"))?; }
        }
        for view in items(contributions, "views") {
            if view.get("rich").is_some() && !strings(&manifest["permissions"]).contains(&"ui.richViews".to_owned()) { return Err(fail("PermissionDenied", &format!("{path}/permissions"), vec![id.to_owned()])); }
            for item in items(view, "toolbar") { reference(contributions, "commands", &item["command"], &format!("{path}/contributes/views"))?; }
        }
        for page in items(contributions, "settings") {
            dialog_fields(page, &format!("{path}/contributes/settings"))?;
            if items(page, "fields").iter().any(|field| field["async"] == true) { return Err(fail("UnsupportedContribution", &format!("{path}/contributes/settings"), vec![text(page, "id").to_owned()])); }
        }
        for binding in items(contributions, "keybindings") { reference(contributions, "commands", &binding["command"], &format!("{path}/contributes/keybindings"))?; }
        // A slash command runs exactly one target: a contributed command, or one of this package's own providers (whose
        // send path receives it as typed). Names are unique per package; conflicts across owners resolve in the host.
        let mut slash_names = BTreeSet::new();
        for slash in items(contributions, "slashCommands") {
            let slash_path = format!("{path}/contributes/slashCommands");
            if slash.get("command").is_some() == slash.get("provider").is_some() { return Err(fail("InvalidShape", &slash_path, vec![text(slash, "id").to_owned()])); }
            if slash.get("command").is_some() { reference(contributions, "commands", &slash["command"], &slash_path)?; } else { reference(contributions, "providers", &slash["provider"], &slash_path)?; }
            if !slash_names.insert(text(slash, "name")) { return Err(fail("DuplicateId", &slash_path, vec![text(slash, "name").to_owned()])); }
        }
        for menu in items(contributions, "menus") {
            reference(contributions, "commands", &menu["command"], &format!("{path}/contributes/menus"))?;
            if menu.get("icon").is_some() { reference(contributions, "icons", &menu["icon"], &format!("{path}/contributes/menus"))?; }
            if menu.get("items").is_some() { menu_items(items(menu, "items"), Some(contributions), &id, &mut owned, &format!("{path}/contributes/menus"), 1, &mut 0)?; }
            menus.push(menu.clone());
        }
        for layout in items(contributions, "layouts") {
            if !strings(&manifest["permissions"]).contains(&"ui.customize".to_owned()) { return Err(fail("PermissionDenied", &format!("{path}/permissions"), vec![id])); }
            let mut edges = vec![];
            for rule in items(layout, "rules") {
                for target in [text(rule, "id"), text(rule, "target")] {
                    if !target.starts_with(&format!("{}/", text(layout, "location"))) && !items(contributions, "menus").iter().any(|menu| text(menu, "id") == target && menu["location"] == layout["location"]) { return Err(fail("UnknownReference", &format!("{path}/contributes/layouts"), vec![target.to_owned()])); }
                }
                let pair = (text(rule, "id").to_owned(), text(rule, "target").to_owned());
                edges.push(if rule["side"] == "before" { pair } else { (pair.1, pair.0) });
            }
            order_graph(edges.iter().flat_map(|(a, b)| [a.clone(), b.clone()]).collect(), &edges, "OrderingCycle", &format!("{path}/contributes/layouts"), |a, b| a.cmp(b))?;
        }
        if CONTRIBUTIONS.iter().any(|kind| !items(contributions, kind).is_empty()) && !strings(&manifest["permissions"]).contains(&"ui.contribute".to_owned()) { return Err(fail("PermissionDenied", &format!("{path}/permissions"), vec![id])); }
    }
    let mut dependencies = vec![];
    for (index, manifest) in packages.iter().enumerate() {
        if let Some(values) = manifest["dependencies"].as_object() {
            let sorted: BTreeMap<_, _> = values.iter().collect();
            for (id, range) in sorted {
                let path = format!("$/{index}/dependencies/{id}");
                package_id(id, &path)?;
                let range = range.as_str().unwrap();
                matches(range, "1.0.0", &path)?;
                let Some(dependency) = packages.iter().find(|item| item["id"] == *id) else {
                    if allow_missing { continue; }
                    return Err(fail("UnknownReference", &path, vec![id.clone()]));
                };
                if !matches(range, text(dependency, "version"), &path)? { return Err(fail("IncompatibleDependency", &path, vec![id.clone()])); }
                dependencies.push((id.clone(), text(manifest, "id").to_owned()));
            }
        }
    }
    let activation_order = order_graph(ids.into_iter().collect(), &dependencies, "DependencyCycle", "$/dependencies", Ord::cmp)?;
    let mut edges = vec![];
    for menu in &menus {
        for key in ["before", "after"] {
            for target in strings(&menu[key]) {
                if !menus.iter().any(|item| item["id"] == target && item["location"] == menu["location"]) { return Err(fail("UnknownReference", "$/ordering", vec![target])); }
                let id = text(menu, "id").to_owned();
                edges.push(if key == "before" { (id, target) } else { (target, id) });
            }
        }
    }
    let by_id: BTreeMap<&str, &Value> = menus.iter().map(|item| (text(item, "id"), item)).collect();
    let menu_order = order_graph(menus.iter().map(|item| text(item, "id").to_owned()).collect(), &edges, "OrderingCycle", "$/ordering", |a, b| {
        let (left, right) = (by_id[a.as_str()], by_id[b.as_str()]);
        text(left, "location").cmp(text(right, "location")).then(text(left, "group").cmp(text(right, "group"))).then(left["order"].as_i64().unwrap_or(0).cmp(&right["order"].as_i64().unwrap_or(0))).then(a.cmp(b))
    })?;
    Ok(json!({"packages": packages, "activationOrder": activation_order, "menuOrder": menu_order}))
}

/// Validate and copy a DTO. Declarations are not grants and never execute here.
pub fn validate_contract(kind: &str, value: &Value) -> Value {
    let result = (|| {
        let mut bytes = 0;
        bounded(value, "$", 0, &mut 0, &mut bytes)?;
        if bytes > SCHEMA["x-dataLimits"]["bytes"].as_u64().unwrap() { return Err(fail("LimitExceeded", "$", vec![])); }
        let mut diagnostics = vec![];
        let value = if kind == "packages" || kind == "packageFiles" { manifests(value, &mut diagnostics, kind == "packageFiles")? }
            else if ["botConversationPresentation", "botConversationAction", "windowMenusPresentation", "windowMenusAction", "taskMenusPresentation", "taskMenusAction", "commandsPresentation", "commandsAction", "tilesPresentation", "tilesAction", "projectPickerPresentation", "projectPickerAction", "threadExtrasPresentation", "threadExtrasAction", "composerAttachPresentation", "composerAttachAction", "composerPanelsPresentation", "composerPanelsAction", "composerPresentation", "composerAction", "statusPresentation", "statusAction", "rosterPresentation", "rosterAction", "dockPresentation", "dockAction", "sidebarPresentation", "sidebarAction", "sidebarBotsPresentation", "sidebarBotsAction", "settingsPresentation", "settingsAction", "dialogAccessory", "machinesPresentation", "machinesAction", "cloudPresentation", "cloudAction", "moodboardPresentation", "moodboardAction", "worktreePresentation", "worktreeAction", "pullPresentation", "pullAction", "githubHubPresentation", "githubHubAction", "boardPresentation", "boardAction", "btwPresentation", "btwAction", "designPresentation", "designAction", "command", "surface", "contribution", "context", "error", "expression", "dialog", "selectOptions", "view", "viewControl", "documentPresentation", "documentAction", "changesPresentation", "changesAction", "searchPresentation", "searchAction", "browserPresentation", "browserAction", "terminalPresentation", "terminalAction", "simulatorPresentation", "simulatorAction", "vmPresentation", "vmAction", "slashCommand", "projectScope"].contains(&kind) { shape(value, &SCHEMA["$defs"][kind], "$", &mut diagnostics)? }
            else { return Err(invalid("$")); };
        if kind == "dialog" { dialog_fields(&value, "$")?; }
        if kind == "projectScope" {
            let projects: Vec<&str> = value["projects"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            if let Some(duplicate) = projects.iter().enumerate().find_map(|(i, id)| projects[..i].contains(id).then_some(*id)) { return Err(fail("DuplicateId", "$/projects", vec![duplicate.to_owned()])); }
        }
        if kind == "selectOptions" { distinct(value.as_array().unwrap(), "value", "$")?; }
        if kind == "searchPresentation" { distinct(items(&value, "results"), "id", "$/results")?; }
        if kind == "changesPresentation" {
            distinct(items(&value, "files"), "id", "$/files")?;
            distinct(items(&value, "files"), "diffId", "$/files")?;
            distinct(items(&value, "controls"), "id", "$/controls")?;
            for file in items(&value, "files") {
                distinct(items(file, "hunks"), "id", "$/files/hunks")?;
                distinct(items(file, "controls"), "id", "$/files/controls")?;
            }
            if !text(&value, "selected").is_empty() && !items(&value, "files").iter().any(|file| file["id"] == value["selected"]) { return Err(invalid("$/selected")); }
        }
        if kind == "documentPresentation" {
            distinct(items(&value, "tabs"), "id", "$/tabs")?;
            distinct(items(&value, "tabs"), "documentId", "$/tabs")?;
            for tab in items(&value, "tabs") { distinct(items(tab, "controls"), "id", "$/tabs/controls")?; }
            if !text(&value, "selected").is_empty() && !items(&value, "tabs").iter().any(|tab| tab["id"] == value["selected"]) { return Err(invalid("$/selected")); }
        }
        if kind == "command" && value["definition"]["action"]["kind"] == "showDialog" { dialog_fields(&value["definition"]["action"]["dialog"], "$/definition/action/dialog")?; }
        if kind == "command" || kind == "contribution" {
            package_id(text(&value["owner"], "extensionId"), "$/owner/extensionId")?;
            if !text(&value["definition"], "id").starts_with(&format!("{}/", text(&value["owner"], "extensionId"))) {
                return Err(fail("InvalidId", "$/definition/id", vec![text(&value["definition"], "id").to_owned()]));
            }
            if kind == "contribution" && value["definition"].get("items").is_some() {
                let mut owned = BTreeSet::from([text(&value["definition"], "id")]);
                menu_items(items(&value["definition"], "items"), None, text(&value["owner"], "extensionId"), &mut owned, "$/definition/items", 1, &mut 0)?;
            }
        }
        Ok(json!({"ok": true, "value": value, "diagnostics": diagnostics}))
    })();
    result.unwrap_or_else(|error| json!({"ok": false, "error": error}))
}

fn evaluate(node: &Value, context: &Value) -> bool {
    if let Some(value) = node.as_bool() { return value; }
    let value = if node["key"] == "selection.kind" { context.get("selection").and_then(|v| v.get("kind")) }
        else { context.get(text(node, "key")) };
    match text(node, "op") {
        "has" => value.is_some(),
        "eq" => value.is_some_and(|v| equal(v, &node["value"])),
        "not" => !evaluate(&node["arg"], context),
        "all" => items(node, "args").iter().all(|v| evaluate(v, context)),
        "any" => items(node, "args").iter().any(|v| evaluate(v, context)),
        _ => false,
    }
}
pub fn evaluate_condition(expression: &Value, context: &Value) -> Value {
    let parsed = validate_contract("expression", expression);
    if parsed["ok"] != true { return parsed; }
    let captured = validate_contract("context", context);
    if captured["ok"] != true { return captured; }
    let diagnostics: Vec<_> = items(&parsed, "diagnostics").iter().chain(items(&captured, "diagnostics")).cloned().collect();
    json!({"ok": true, "value": evaluate(&parsed["value"], &captured["value"]), "diagnostics": diagnostics})
}

/// The 20-package/1,000-contribution scale fixture, generated exactly like
/// `tests/extensions-performance.spec.ts` does from `performance-scale.json`.
#[cfg(test)]
pub(crate) fn performance_scale_manifests() -> Vec<Value> {
    let scale: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/performance-scale.json")).unwrap();
    let count = |key: &str| scale[key].as_u64().unwrap() as usize;
    (1..=count("packages")).map(|p| {
        let id = format!("{}.ext-{p:02}", scale["publisher"].as_str().unwrap());
        let commands: Vec<Value> = (1..=count("perContextLocation")).map(|c| json!({"id":format!("{id}/run-{c}"), "title":format!("Perf {p:02} action {c}"), "action":{"kind":"showMessage","message":format!("Perf {p:02} action {c}")}})).collect();
        let mut menus: Vec<Value> = scale["visibleLocations"].as_array().unwrap().iter().enumerate().map(|(v, location)| json!({"id":format!("{id}/visible-{}", v + 1), "location":location, "command":commands[0]["id"], "presentation":"button", "text":format!("P{p:02}"), "group":"extensions", "order":p - 1})).collect();
        for location in scale["contextLocations"].as_array().unwrap() { for command in &commands { let n = menus.len() + 1; menus.push(json!({"id":format!("{id}/m-{n:03}"), "location":location, "command":command["id"], "group":"extensions", "order":p - 1})); } }
        json!({"manifestVersion":1, "id":id, "version":"1.0.0", "engines":{"pandacodeApi":"^1.0.0"}, "extensionKind":"ui", "permissions":["ui.contribute"], "contributes":{"commands":commands, "menus":menus}})
    }).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    #[test]
    fn primitive_declaration_matches_schema_carriers_limits_hosts_and_conformance_package() {
        let primitives = &super::SCHEMA["x-primitives"];
        assert_eq!(primitives["contractVersion"], 1);
        let mut declared = std::collections::BTreeSet::new();
        for (name, family) in primitives["families"].as_object().unwrap() {
            let def = &super::SCHEMA["$defs"][family["carrier"]["def"].as_str().unwrap()];
            let key = family["carrier"]["key"].as_str().unwrap();
            let alternatives = def["anyOf"].as_array().cloned().unwrap_or_else(|| vec![def.clone()]);
            let mut carried: Vec<String> = alternatives.iter().flat_map(|alternative| { let property = &alternative["properties"][key]; property["enum"].as_array().cloned().unwrap_or_else(|| vec![property["const"].clone()]) }).map(|value| value.as_str().unwrap().to_owned()).collect();
            let mut kinds = super::strings(&family["kinds"]);
            for kind in &kinds { declared.insert(format!("{name}.{kind}")); }
            carried.sort(); kinds.sort();
            assert_eq!(kinds, carried, "{name}");
            for (limit, entry) in family["limits"].as_object().unwrap() {
                for path in super::strings(&entry["at"]) { assert_eq!(super::SCHEMA.pointer(&format!("/{path}")), Some(&entry["value"]), "{name}.{limit} at {path}"); }
                if super::strings(&entry["at"]).is_empty() { assert!(["field.rowsDefault", "field.query"].contains(&format!("{name}.{limit}").as_str())); }
            }
        }
        assert_eq!(super::primitive_limit("field", "text"), 4096);
        assert_eq!(super::primitive_limit("menu", "depth"), super::SCHEMA["x-menuLimits"]["depth"].as_u64().unwrap());
        for (name, host) in primitives["hosts"].as_object().unwrap() {
            let accepts = super::strings(&host["accepts"]);
            let degrades = host["degrades"].as_object().unwrap();
            for id in accepts.iter().chain(super::strings(&host["omits"]).iter()).chain(super::strings(&host["disables"]).iter()).chain(degrades.keys()) { assert!(declared.contains(id), "{name}: {id}"); }
            for id in super::strings(&host["omits"]).iter().chain(super::strings(&host["disables"]).iter()).chain(degrades.keys()) { assert!(!accepts.contains(id), "{name}: {id}"); }
            for target in degrades.values() { assert!(accepts.contains(&target.as_str().unwrap().to_owned()), "{name}"); }
        }
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/primitives/extension.json")).unwrap();
        let checked = super::validate_contract("packages", &json!([manifest]));
        assert_eq!(checked["ok"], true, "{checked}"); assert_eq!(checked["diagnostics"], json!([]));
        let field = |change: &dyn Fn(&mut Value)| { let mut value = manifest.clone(); change(&mut value["contributes"]["commands"][0]["action"]["dialog"]["fields"][1]); super::validate_contract("packages", &json!([value])) };
        let package = |change: &dyn Fn(&mut Value)| { let mut value = manifest.clone(); change(&mut value); super::validate_contract("packages", &json!([value])) };
        for (case, result) in [
            ("rows low", field(&|f| f["rows"] = json!(1))), ("rows high", field(&|f| f["rows"] = json!(13))), ("rows fraction", field(&|f| f["rows"] = json!(2.5))),
            ("oversize", field(&|f| f["value"] = json!("a".repeat(4097)))), ("number", field(&|f| f["value"] = json!(3))), ("unknown kind", field(&|f| f["kind"] = json!("richtext"))),
            ("callback", field(&|f| f["onInput"] = json!("fetch()"))), ("prototype", field(&|f| f["__proto__"] = json!({"polluted": true}))),
            ("view kind", package(&|m| m["contributes"]["views"][0]["controls"].as_array_mut().unwrap().push(json!({"kind":"chart","label":"Chart","items":[]})))),
            ("view markup", package(&|m| m["contributes"]["views"][0]["controls"][0]["html"] = json!("<script></script>"))),
            ("presentation", package(&|m| m["contributes"]["menus"][1]["presentation"] = json!("select"))),
            ("ungranted", package(&|m| m["permissions"] = json!([]))),
            ("settings async", package(&|m| m["contributes"]["settings"][0]["fields"].as_array_mut().unwrap().push(json!({"id":"remote","kind":"select","label":"Remote","async":true,"options":[]})))),
        ] { assert_eq!(result["ok"], false, "{case}"); assert_ne!(result["error"]["code"], "DuplicateId", "{case}"); }
        assert_eq!(package(&|m| m["permissions"] = json!([]))["error"]["code"], "PermissionDenied");
        assert_eq!(package(&|m| m["contributes"]["settings"][0]["fields"].as_array_mut().unwrap().push(json!({"id":"remote","kind":"select","label":"Remote","async":true,"options":[]})))["error"]["code"], "UnsupportedContribution");
        let dialog = &manifest["contributes"]["commands"][0]["action"]["dialog"];
        let mut many = dialog.clone(); many["fields"] = json!((0..25).map(|n| json!({"id": format!("field-{n}"), "kind": "textarea", "label": "Notes"})).collect::<Vec<_>>());
        assert_eq!(super::validate_contract("dialog", &many)["error"]["code"], "LimitExceeded");
        // Prior fixtures keep validating unchanged.
        for prior in [include_str!("../../../tests/fixtures/extensions/menu-laboratory/extension.json"), include_str!("../../../tests/fixtures/extensions/data-panel/extension.json"), include_str!("../../../tests/fixtures/extensions/settings-laboratory/extension.json")] {
            assert_eq!(super::validate_contract("packages", &json!([serde_json::from_str::<Value>(prior).unwrap()]))["ok"], true);
        }
    }
    #[test]
    fn machines_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/machines/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/machines/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/machines/action.json")).unwrap();
        assert_eq!(super::validate_contract("machinesPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("machinesAction", &action)["ok"], true);
        // No device ID, name, fingerprint, pairing code, access level, link, prompt, selector or IPC crosses the contract.
        for field in ["selector", "ipc", "deviceId", "fingerprint", "pairingCode", "access", "link", "prompt", "credentials", "token"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("machinesAction", &forged)["ok"], false);
        }
        for field in ["selector", "ipc", "deviceId", "deviceName", "fingerprint", "access"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("machinesPresentation", &raw)["ok"], false);
        }
        // Remote starts, the behind continue, pairing, link/access consent and the switch are host-owned: no public control can name them.
        for control in ["behind-continue", "remote-start", "link-confirm", "pairing", "orchestration", "unlink", "access"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("machinesAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("machinesPresentation", &oversized)["ok"], false);
        let mut long = state.clone(); long["label"] = json!("x".repeat(81));
        assert_eq!(super::validate_contract("machinesPresentation", &long)["ok"], false);
        let mut requests = state.clone(); requests["requests"] = json!(17);
        assert_eq!(super::validate_contract("machinesPresentation", &requests)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.machines.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
    }
    #[test]
    fn cloud_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/cloud/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/cloud/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/cloud/action.json")).unwrap();
        assert_eq!(super::validate_contract("cloudPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("cloudAction", &action)["ok"], true);
        // No provider key, token, region, machine name, detail, selector or IPC crosses the contract.
        for field in ["selector", "ipc", "apiKey", "token", "credentials", "region", "machineName", "detail", "prompt", "spend"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("cloudAction", &forged)["ok"], false);
        }
        for field in ["selector", "ipc", "apiKey", "credentials", "detail", "machineName"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("cloudPresentation", &raw)["ok"], false);
        }
        // The delete confirmation, the provisioning send and credential entry are host-owned: no public control can name them.
        for control in ["delete-confirm", "cloud-start", "credentials", "provision", "connect"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("cloudAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("cloudPresentation", &oversized)["ok"], false);
        let mut long = state.clone(); long["label"] = json!("x".repeat(81));
        assert_eq!(super::validate_contract("cloudPresentation", &long)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.cloud.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
    }
    #[test]
    fn moodboard_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/moodboards/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/moodboards/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/moodboards/action.json")).unwrap();
        assert_eq!(super::validate_contract("moodboardPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("moodboardAction", &action)["ok"], true);
        // No file path, image bytes, caption, name, selector or IPC crosses the contract.
        for field in ["selector", "ipc", "path", "paths", "dataUrl", "bytes", "caption", "name", "credentials"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("moodboardAction", &forged)["ok"], false);
        }
        for field in ["selector", "ipc", "path", "dataUrl", "caption", "credentials"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("moodboardPresentation", &raw)["ok"], false);
        }
        // Create submit, delete confirmation, file chooser and drop are host-owned: no public control can name them.
        for control in ["create-confirm", "delete-confirm", "file-picker", "file-drop", "import"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("moodboardAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 257]);
        assert_eq!(super::validate_contract("moodboardPresentation", &oversized)["ok"], false);
        let mut long = state.clone(); long["boardName"] = json!("x".repeat(121));
        assert_eq!(super::validate_contract("moodboardPresentation", &long)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.moodboards.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
    }
    #[test]
    fn action_dock_component_state_action_and_layouts_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/action-dock/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/action-dock/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/action-dock/action.json")).unwrap();
        assert_eq!(super::validate_contract("dockPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("dockAction", &action)["ok"], true);
        for field in ["selector", "ipc", "workerId", "sessionId", "assignment"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("dockAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("dockPresentation", &raw)["ok"], false);
        }
        // Stop, approvals, answers and worker recovery have no public control id.
        for control in ["stop", "stop-worker", "approve", "deny", "answer", "retry", "skip"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("dockAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["workers"] = json!(vec![state["workers"][0].clone(); 65]);
        assert_eq!(super::validate_contract("dockPresentation", &oversized)["ok"], false);
        let mut named = state.clone(); named["workers"][0]["name"] = json!("Builder");
        assert_eq!(super::validate_contract("dockPresentation", &named)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.actionDock.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let mut provider = manifest.clone(); provider["contributes"]["components"][0]["presentation"] = json!("workers-replaced");
        assert_eq!(super::validate_contract("packages", &json!([provider]))["ok"], false);
        let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.team.context", "sessionId": "session-1", "revision": 1, "selection": {"kind": "team", "ids": ["session-1"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
    }
    #[test]
    fn status_component_state_action_and_layouts_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/status/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/status/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/status/action.json")).unwrap();
        assert_eq!(super::validate_contract("statusPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("statusAction", &action)["ok"], true);
        for field in ["selector", "ipc", "interval", "email", "toastText"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("statusAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("statusPresentation", &raw)["ok"], false);
        }
        // Restart, Undo, notice actions, Clear history, sign-in, dashboard links and polling have no public control id.
        for control in ["update-restart", "toast-undo", "toast-action", "progress-clear", "usage-sign-in", "usage-dashboard", "usage-poll"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("statusAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["providers"] = json!(vec![state["providers"][0].clone(); 65]);
        assert_eq!(super::validate_contract("statusPresentation", &oversized)["ok"], false);
        for field in ["email", "plan", "message", "dashboardUrl"] {
            let mut account = state.clone(); account["providers"][0][field] = json!("you@example.com");
            assert_eq!(super::validate_contract("statusPresentation", &account)["ok"], false);
        }
        let mut percent = state.clone(); percent["providers"][0]["peak"] = json!(101);
        assert_eq!(super::validate_contract("statusPresentation", &percent)["ok"], false);
        let mut toast = state.clone(); toast["toast"] = json!("Saved your draft");
        assert_eq!(super::validate_contract("statusPresentation", &toast)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.status.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let mut provider = manifest.clone(); provider["contributes"]["components"][0]["presentation"] = json!("usage-replaced");
        assert_eq!(super::validate_contract("packages", &json!([provider]))["ok"], false);
        let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.status.context", "revision": 1, "selection": {"kind": "usage-provider", "ids": ["provider-a"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
    }
    #[test]
    fn agent_roster_component_state_action_and_layouts_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/agent-roster/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/agent-roster/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/agent-roster/action.json")).unwrap();
        assert_eq!(super::validate_contract("rosterPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("rosterAction", &action)["ok"], true);
        for field in ["selector", "ipc", "agentId", "sessionId", "prompt"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("rosterAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("rosterPresentation", &raw)["ok"], false);
        }
        // Stop, pin, unpin, rename, delete, approvals and answers have no public control id.
        for control in ["stop", "stop-subagent", "widget-pin", "unpin", "profile-rename", "profile-delete", "approve", "answer"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("rosterAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["children"] = json!(vec![state["children"][0].clone(); 65]);
        assert_eq!(super::validate_contract("rosterPresentation", &oversized)["ok"], false);
        for field in ["name", "response", "tools"] {
            let mut named = state.clone(); named["children"][0][field] = json!("Reviewer");
            assert_eq!(super::validate_contract("rosterPresentation", &named)["ok"], false);
        }
        let mut titled = state.clone(); titled["agents"][0]["title"] = json!("Secret task");
        assert_eq!(super::validate_contract("rosterPresentation", &titled)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.roster.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let mut provider = manifest.clone(); provider["contributes"]["components"][0]["presentation"] = json!("children-replaced");
        assert_eq!(super::validate_contract("packages", &json!([provider]))["ok"], false);
        let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.roster.context", "sessionId": "session-1", "revision": 1, "selection": {"kind": "subagent", "ids": ["child-a"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
    }
    #[test]
    fn sidebar_component_state_action_and_layouts_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar/action.json")).unwrap();
        assert_eq!(super::validate_contract("sidebarPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("sidebarAction", &action)["ok"], true);
        for field in ["selector", "ipc", "title", "taskId", "order"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("sidebarAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("sidebarPresentation", &raw)["ok"], false);
        }
        // Deletion, renaming, manual order and project removal have no public control id.
        for control in ["delete", "rename", "reorder", "remove-project", "pin", "drag"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("sidebarAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["rows"] = json!(vec![state["rows"][0].clone(); 129]);
        assert_eq!(super::validate_contract("sidebarPresentation", &oversized)["ok"], false);
        let mut section = state.clone(); section["sections"][0]["id"] = json!("folders");
        assert_eq!(super::validate_contract("sidebarPresentation", &section)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.sidebar.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let mut provider = manifest.clone(); provider["contributes"]["components"][0]["presentation"] = json!("sections-replaced");
        assert_eq!(super::validate_contract("packages", &json!([provider]))["ok"], false);
        let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.sidebar.context", "revision": 1, "selection": {"kind": "sidebar-section", "ids": ["review"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
    }
    #[test]
    fn task_menus_state_action_locations_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/task-menus/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/task-menus/state.json")).unwrap();
        let request: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/task-menus/action.json")).unwrap();
        assert_eq!(super::validate_contract("taskMenusPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("taskMenusAction", &request)["ok"], true);
        for field in ["selector", "ipc", "text", "token", "credential", "name", "draft"] {
            let mut forged = request.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("taskMenusAction", &forged)["ok"], false, "{field}");
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("taskMenusPresentation", &raw)["ok"], false, "{field}");
        }
        // Saving a team, profiles, the console, connecting a platform, credentials and a bot's settings have no public control id.
        for control in ["team-save", "team-profile-edit", "task-console", "task-delete-confirm", "deploy-connect", "deploy-credentials", "bot-credentials", "bot-create", "bot-delete"] {
            let mut forged = request.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("taskMenusAction", &forged)["ok"], false, "{control}");
        }
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.menus.task.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, ids) in [("panda.team.menu", "team", json!(["task-1"])), ("panda.team.setup.actions", "team", json!(["task-1"])), ("panda.task.menu", "task", json!(["task-1"])), ("panda.deploy.menu", "connection", json!(["vercel", "netlify"])), ("panda.bot.assignment", "bot", json!(["bot-1"]))] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": ids}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{surface}");
        }
        let credential = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.deploy.menu", "revision": 1, "selection": {"kind": "credential", "ids": ["vercel"]}});
        assert_eq!(super::validate_contract("context", &credential)["ok"], false);
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("taskMenusPresentation", &oversized)["ok"], false);
    }
    #[test]
    fn bot_conversation_state_action_locations_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/bot-conversation/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/bot-conversation/state.json")).unwrap();
        let request: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/bot-conversation/action.json")).unwrap();
        assert_eq!(super::validate_contract("botConversationPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("botConversationAction", &request)["ok"], true);
        for field in ["selector", "ipc", "text", "draft", "name", "token", "html"] {
            let mut forged = request.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("botConversationAction", &forged)["ok"], false, "{field}");
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("botConversationPresentation", &raw)["ok"], false, "{field}");
        }
        // Stop, deletion, credentials, settings and membership changes, sending and the draft have no public control id.
        for control in ["bot-stop", "channel-stop", "bot-delete", "bot-credentials", "bot-settings-save", "channel-settings-save", "channel-membership", "channel-delete", "message-send", "draft-write"] {
            let mut forged = request.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("botConversationAction", &forged)["ok"], false, "{control}");
        }
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.bot.conversation.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, ids) in [("panda.bot.thread.actions", "bot", json!(["bot-1"])), ("panda.bot.channel.actions", "channel", json!(["channel-1"]))] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": ids}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{surface}");
        }
        let mut view = state.clone(); view["view"] = json!("web");
        assert_eq!(super::validate_contract("botConversationPresentation", &view)["ok"], false);
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 129]);
        assert_eq!(super::validate_contract("botConversationPresentation", &oversized)["ok"], false);
    }
    #[test]
    fn window_menus_state_action_locations_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/window-menus/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/window-menus/state.json")).unwrap();
        let request: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/window-menus/action.json")).unwrap();
        assert_eq!(super::validate_contract("windowMenusPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("windowMenusAction", &request)["ok"], true);
        for field in ["selector", "ipc", "text", "query", "project", "path", "name"] {
            let mut forged = request.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("windowMenusAction", &forged)["ok"], false, "{field}");
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("windowMenusPresentation", &raw)["ok"], false, "{field}");
        }
        // Hiding the open view, manual order, project actions, adding or removing a project and turning GitHub on have no public control id.
        for control in ["view-hide-current", "sort-reorder", "project-actions", "project-remove", "project-add", "github-enable"] {
            let mut forged = request.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("windowMenusAction", &forged)["ok"], false, "{control}");
        }
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.menus.window.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, ids) in [("panda.workspace.view.menu", "workspace-view", json!(["board"])), ("panda.sidebar.sort.menu", "sidebar-sort", json!(["recent", "per-6"])), ("panda.projects.filter.menu", "project-filter", json!(["all-projects"]))] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "revision": 1, "selection": {"kind": kind, "ids": ids}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{surface}");
        }
        let credential = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.projects.filter.menu", "revision": 1, "selection": {"kind": "project-path", "ids": ["x"]}});
        assert_eq!(super::validate_contract("context", &credential)["ok"], false);
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("windowMenusPresentation", &oversized)["ok"], false);
    }
    #[test]
    fn commands_slash_declarations_state_action_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/commands-extras/extension.json")).unwrap();
        let provider: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/commands-extras/provider.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        assert_eq!(super::validate_contract("packages", &json!([provider]))["ok"], true);
        // name, description and argument schema: the same refusals as schema-v1.json and the TypeScript validator.
        for (field, value) in [("name", json!("notes")), ("name", json!("/Notes")), ("name", json!(format!("/{}", "a".repeat(33)))), ("description", json!("")), ("arguments", json!({"required": true})), ("arguments", json!({"required": false, "maxLength": 0})), ("arguments", json!({"required": false, "maxLength": 2049})), ("arguments", json!({"required": false, "maxLength": 10, "pattern": ".*"})), ("script", json!("run"))] {
            let mut invalid = manifest.clone(); invalid["contributes"]["slashCommands"][0][field] = value;
            assert_eq!(super::validate_contract("packages", &json!([invalid]))["ok"], false, "{field}");
        }
        let mut both = manifest.clone(); both["contributes"]["slashCommands"][0]["provider"] = json!("sample.commands-extras/missing");
        assert_eq!(super::validate_contract("packages", &json!([both]))["error"]["code"], "InvalidShape");
        let mut neither = manifest.clone(); neither["contributes"]["slashCommands"][0].as_object_mut().unwrap().remove("command");
        assert_eq!(super::validate_contract("packages", &json!([neither]))["error"]["code"], "InvalidShape");
        let mut unknown = manifest.clone(); unknown["contributes"]["slashCommands"][0]["command"] = json!("sample.commands-extras/missing");
        assert_eq!(super::validate_contract("packages", &json!([unknown]))["error"]["code"], "UnknownReference");
        let mut foreign = provider.clone(); foreign["contributes"]["slashCommands"][0]["provider"] = json!("sample.fake-harness/recorded");
        assert_eq!(super::validate_contract("packages", &json!([foreign]))["error"]["code"], "UnknownReference");
        let mut duplicate = manifest.clone(); duplicate["contributes"]["slashCommands"][1]["name"] = json!("/notes");
        assert_eq!(super::validate_contract("packages", &json!([duplicate]))["error"]["code"], "DuplicateId");
        let mut stolen = manifest.clone(); stolen["contributes"]["slashCommands"][0]["id"] = json!("other.owner/notes");
        assert_eq!(super::validate_contract("packages", &json!([stolen]))["error"]["code"], "InvalidId");
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/commands-extras/state.json")).unwrap();
        let request: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/commands-extras/action.json")).unwrap();
        assert_eq!(super::validate_contract("commandsPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("commandsAction", &request)["ok"], true);
        for field in ["selector", "ipc", "text", "draft", "command", "arguments"] {
            let mut forged = request.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("commandsAction", &forged)["ok"], false, "{field}");
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("commandsPresentation", &raw)["ok"], false, "{field}");
        }
        // Sending, writing or reading the draft, panel changes and consoles have no public control id.
        for control in ["slash-send", "slash-insert", "slash-read-draft", "harness-execute", "console-open"] {
            let mut forged = request.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("commandsAction", &forged)["ok"], false, "{control}");
        }
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.commands.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let slash = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.commands.slash", "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": "slash-command", "ids": ["task-1"]}, "slash": {"command": "sample.commands-extras/notes", "provider": "codex", "arguments": "release notes"}});
        assert_eq!(super::validate_contract("context", &slash)["ok"], true);
        let harness = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.commands.harness.actions", "sessionId": "task-1", "revision": 1, "selection": {"kind": "harness-command", "ids": ["codex:usage"]}});
        assert_eq!(super::validate_contract("context", &harness)["ok"], true);
        let mut long = slash.clone(); long["slash"]["arguments"] = json!("x".repeat(2049));
        assert_eq!(super::validate_contract("context", &long)["ok"], false);
        let mut extra = slash.clone(); extra["slash"]["draft"] = json!("the rest of the composer");
        assert_eq!(super::validate_contract("context", &extra)["ok"], false);
    }
    #[test]
    fn tiles_picker_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/tiles-picker/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        for (presentation, action, state_file, action_file) in [
            ("tilesPresentation", "tilesAction", include_str!("../../../tests/fixtures/extensions/tiles-picker/state.json"), include_str!("../../../tests/fixtures/extensions/tiles-picker/action.json")),
            ("projectPickerPresentation", "projectPickerAction", include_str!("../../../tests/fixtures/extensions/tiles-picker/picker-state.json"), include_str!("../../../tests/fixtures/extensions/tiles-picker/picker-action.json")),
        ] {
            let state: Value = serde_json::from_str(state_file).unwrap();
            let request: Value = serde_json::from_str(action_file).unwrap();
            assert_eq!(super::validate_contract(presentation, &state)["ok"], true, "{presentation}");
            assert_eq!(super::validate_contract(action, &request)["ok"], true, "{action}");
            for field in ["selector", "ipc", "text", "draft", "search", "path"] {
                let mut forged = request.clone(); forged[field] = json!("raw");
                assert_eq!(super::validate_contract(action, &forged)["ok"], false, "{action} {field}");
                let mut raw = state.clone(); raw[field] = json!("raw");
                assert_eq!(super::validate_contract(presentation, &raw)["ok"], false, "{presentation} {field}");
            }
        }
        // Input to a tile, its rows, the tile layout and moving or reading the draft have no public control id.
        let request: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/tiles-picker/action.json")).unwrap();
        for control in ["tile-send-input", "tile-read-rows", "tile-open", "tile-move", "tile-resize", "picker-select"] {
            let mut forged = request.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("tilesAction", &forged)["ok"], false, "{control}");
        }
        let picker: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/tiles-picker/picker-action.json")).unwrap();
        for control in ["picker-move", "picker-read-draft", "picker-set-search", "picker-create-project", "picker-clear-attachments", "tile-focus"] {
            let mut forged = picker.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("projectPickerAction", &forged)["ok"], false, "{control}");
        }
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/tiles-picker/state.json")).unwrap();
        let mut tiles = state.clone(); tiles["tiles"] = json!(vec!["tile"; 7]);
        assert_eq!(super::validate_contract("tilesPresentation", &tiles)["ok"], false);
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 33]);
        assert_eq!(super::validate_contract("tilesPresentation", &oversized)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.workspace.tiles-picker.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind) in [("panda.workspace.tiles.actions", "tile"), ("panda.workspace.project-picker.actions", "draft-project")] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": ["task-1"]}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.workspace.tiles.actions", "revision": 1, "selection": {"kind": "tile-input", "ids": ["task-1"]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
    }
    #[test]
    fn thread_extras_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/thread-extras/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/thread-extras/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/thread-extras/action.json")).unwrap();
        assert_eq!(super::validate_contract("threadExtrasPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("threadExtrasAction", &action)["ok"], true);
        for field in ["selector", "ipc", "query", "path", "diff"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("threadExtrasAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("threadExtrasPresentation", &raw)["ok"], false);
        }
        // Reading attachment contents, setting the find text, reading diffs and assigning a connection or provider have no public control id.
        for control in ["attachment-read", "attachment-reveal", "find-set-query", "find-read-matches", "changes-read-diff", "limit-set", "limit-assign-connection", "limit-switch-provider"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("threadExtrasAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 257]);
        assert_eq!(super::validate_contract("threadExtrasPresentation", &oversized)["ok"], false);
        let mut turns = state.clone(); turns["turns"] = json!(vec!["turn"; 65]);
        assert_eq!(super::validate_contract("threadExtrasPresentation", &turns)["ok"], false);
        let mut count = state.clone(); count["attachments"] = json!(257);
        assert_eq!(super::validate_contract("threadExtrasPresentation", &count)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.thread.extras.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, ids) in [("panda.thread.attachments.actions", "message-attachment", json!(["1:0", "1:1"])), ("panda.thread.find.actions", "find", json!(["task-1"])), ("panda.thread.changes.actions", "turn-changes", json!(["turn-1", "src/a.ts"])), ("panda.thread.usage-limit.actions", "usage-limit", json!(["claude"]))] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": ids}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.thread.find.actions", "revision": 1, "selection": {"kind": "find-query", "ids": ["task-1"]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
    }
    #[test]
    fn composer_attach_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-attach/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-attach/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-attach/action.json")).unwrap();
        assert_eq!(super::validate_contract("composerAttachPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("composerAttachAction", &action)["ok"], true);
        for field in ["selector", "ipc", "text", "path", "steps"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("composerAttachAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("composerAttachPresentation", &raw)["ok"], false);
        }
        // Attaching paths, removing attachments, recipe deletes and edit commits and wake-up changes have no public control id.
        for control in ["attach-paths", "attach-remove", "recipe-delete", "recipe-save", "recipe-cancel", "wake-create", "wake-remove", "wake-snooze", "wake-set"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("composerAttachAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 129]);
        assert_eq!(super::validate_contract("composerAttachPresentation", &oversized)["ok"], false);
        let mut schedules = state.clone(); schedules["schedules"] = json!(vec!["schedule"; 65]);
        assert_eq!(super::validate_contract("composerAttachPresentation", &schedules)["ok"], false);
        let mut count = state.clone(); count["attachments"] = json!(65);
        assert_eq!(super::validate_contract("composerAttachPresentation", &count)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.composer.attach.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, id) in [("panda.composer.attach.actions", "draft", "task-1"), ("panda.composer.recipes.actions", "recipe", "project:review-diff"), ("panda.composer.wake.actions", "task", "task-1"), ("panda.composer.wake.context", "schedule", "sched-1")] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": [id]}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.composer.wake.context", "revision": 1, "selection": {"kind": "wake-up", "ids": ["sched-1"]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
    }
    #[test]
    fn composer_panels_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-panels/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-panels/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-panels/action.json")).unwrap();
        assert_eq!(super::validate_contract("composerPanelsPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("composerPanelsAction", &action)["ok"], true);
        for field in ["selector", "ipc", "text", "packs", "position"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("composerPanelsAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("composerPanelsPresentation", &raw)["ok"], false);
        }
        // Queue removal, edit commits, reordering, packs, installs and the council's decisions have no public control id.
        for control in ["queue-remove", "queue-save", "queue-cancel", "queue-reorder", "saver-pack", "saver-level", "saver-install", "council-accept", "council-dismiss", "council-keep-fixing", "council-set"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("composerPanelsAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 129]);
        assert_eq!(super::validate_contract("composerPanelsPresentation", &oversized)["ok"], false);
        let mut entries = state.clone(); entries["entries"] = json!(vec!["entry"; 65]);
        assert_eq!(super::validate_contract("composerPanelsPresentation", &entries)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.composer.panels.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, id) in [("panda.composer.queue.actions", "queue-entry", "queue-1"), ("panda.composer.saver.actions", "token-saver", "task-1"), ("panda.composer.council.actions", "council-cycle", "task-1:1700000000000")] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": [id]}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.composer.queue.actions", "revision": 1, "selection": {"kind": "queue", "ids": ["queue-1"]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
    }
    #[test]
    fn composer_controls_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-controls/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-controls/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/composer-controls/action.json")).unwrap();
        assert_eq!(super::validate_contract("composerPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("composerAction", &action)["ok"], true);
        for field in ["selector", "ipc", "text", "model", "value"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("composerAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("composerPresentation", &raw)["ok"], false);
        }
        // Mode and model changes, Send, Stop and approvals have no public control id.
        for control in ["mode-set", "model-set", "effort-set", "team-set", "send", "stop", "approve", "deny"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("composerAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("composerPresentation", &oversized)["ok"], false);
        let mut draft = state.clone(); draft["draft"] = json!("draft text");
        assert_eq!(super::validate_contract("composerPresentation", &draft)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.composer.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for (surface, kind, id) in [("panda.composer.steering.actions", "draft", "task-1"), ("panda.composer.model.actions", "model", "claude:default"), ("panda.composer.permissions.actions", "approval-mode", "plan")] {
            let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": surface, "projectId": "project-1", "sessionId": "task-1", "revision": 1, "selection": {"kind": kind, "ids": [id]}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.composer.permissions.actions", "revision": 1, "selection": {"kind": "approval", "ids": ["plan"]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
    }
    #[test]
    fn sidebar_bots_state_action_layouts_and_selection_kinds_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar-bots/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar-bots/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sidebar-bots/action.json")).unwrap();
        assert_eq!(super::validate_contract("sidebarBotsPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("sidebarBotsAction", &action)["ok"], true);
        for field in ["selector", "ipc", "name", "botId", "token"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("sidebarBotsAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("sidebarBotsPresentation", &raw)["ok"], false);
        }
        // Deletion, pausing, channel changes, membership and credentials have no public control id.
        for control in ["delete-bot", "pause-bot", "duplicate-bot", "delete-channel", "restore-channel", "channel-members", "bot-credentials"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("sidebarBotsAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["rows"] = json!(vec![state["rows"][0].clone(); 257]);
        assert_eq!(super::validate_contract("sidebarBotsPresentation", &oversized)["ok"], false);
        let mut named = state.clone(); named["rows"][0]["name"] = json!("Scout");
        assert_eq!(super::validate_contract("sidebarBotsPresentation", &named)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.sidebar.bots.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        let bot = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.sidebar.bots.context", "projectId": "bot-project", "revision": 1, "selection": {"kind": "bot", "ids": ["bot-1"]}});
        assert_eq!(super::validate_contract("context", &bot)["ok"], true);
        let channel = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.sidebar.channel.context", "revision": 1, "selection": {"kind": "channel", "ids": ["channel-1"]}});
        assert_eq!(super::validate_contract("context", &channel)["ok"], true);
    }
    #[test]
    fn settings_component_state_action_and_placed_fields_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/settings-core/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/settings-core/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/settings-core/action.json")).unwrap();
        assert_eq!(super::validate_contract("settingsPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("settingsAction", &action)["ok"], true);
        for field in ["selector", "ipc", "key", "value", "credentials"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("settingsAction", &forged)["ok"], false);
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("settingsPresentation", &raw)["ok"], false);
        }
        // Credentials, grants, pairing and recovery have no public control id.
        for control in ["turn-checks", "provider-credentials", "remote-pairing", "github-sign-in", "safe-mode", "app-update", "project-remove"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("settingsAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("settingsPresentation", &oversized)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.settings.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
        for section in ["providers", "voice", "extensions", "about", "remote", "github", "cloud", "recommended"] {
            let mut placed = manifest.clone(); placed["contributes"]["settings"][0]["section"] = json!(section);
            assert_eq!(super::validate_contract("packages", &json!([placed]))["ok"], false);
        }
        let context = json!({"schemaVersion": 1, "windowId": "main", "surfaceId": "panda.settings.actions", "revision": 1, "selection": {"kind": "settings-page", "ids": ["general"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
    }
    #[test]
    fn worktree_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/worktree/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/worktree/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/worktree/action.json")).unwrap();
        assert_eq!(super::validate_contract("worktreePresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("worktreeAction", &action)["ok"], true);
        for field in ["selector", "ipc", "path", "branchName", "credentials"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("worktreeAction", &forged)["ok"], false);
        }
        for field in ["selector", "ipc", "path", "credentials"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("worktreePresentation", &raw)["ok"], false);
        }
        // Create submit and cleanup confirmation are host-owned: no public control can name them.
        for control in ["worktree-confirm", "cleanup-confirm", "cleanup-remove", "delete-branch"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("worktreeAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["controls"] = json!(vec![state["controls"][0].clone(); 65]);
        assert_eq!(super::validate_contract("worktreePresentation", &oversized)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.worktree.protected");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
    }
    #[test]
    fn workspace_action_contexts_share_native_selection_kinds() {
        // Board, GitHub hub and Pull accessories capture these kinds; a rejected context disables every contributed action.
        for kind in ["board", "github-hub", "pull", "task", "moodboard", "moodboard-image", "machine"] {
            let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.pull.actions","revision":1,"projectId":"p","selection":{"kind":kind,"ids":["handle"]}});
            assert_eq!(super::validate_contract("context", &context)["ok"], true, "{kind}");
        }
        let unknown = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.pull.actions","revision":1,"selection":{"kind":"pull-request","ids":[]}});
        assert_eq!(super::validate_contract("context", &unknown)["ok"], false);
        // Hosts omit an absent project rather than sending empty text.
        let empty = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.githubHub.actions","revision":1,"projectId":"","selection":{"kind":"github-hub","ids":["handle"]}});
        assert_eq!(super::validate_contract("context", &empty)["ok"], false);
    }
    #[test]
    fn pull_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/pull/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/pull/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/pull/action.json")).unwrap();
        assert_eq!(super::validate_contract("pullPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("pullAction", &action)["ok"], true);
        for field in ["selector", "ipc", "credentials", "url", "method", "value"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("pullPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("pullAction", &forged)["ok"], false);
        }
        // Merge confirmation is host-owned: no public control can name it.
        for control in ["merge-confirm", "merge", "push"] {
            let mut forged = action.clone(); forged["controlId"] = json!(control);
            assert_eq!(super::validate_contract("pullAction", &forged)["ok"], false);
        }
        let mut oversized = state.clone(); oversized["files"] = json!(vec![state["files"][0].clone(); 501]);
        assert_eq!(super::validate_contract("pullPresentation", &oversized)["ok"], false);
        let mut layout = manifest.clone(); layout["contributes"]["layouts"][0]["location"] = json!("panda.pull.merge");
        assert_eq!(super::validate_contract("packages", &json!([layout]))["ok"], false);
    }
    #[test]
    fn github_hub_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/github-hub/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/github-hub/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/github-hub/action.json")).unwrap();
        assert_eq!(super::validate_contract("githubHubPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("githubHubAction", &action)["ok"], true);
        for field in ["selector", "ipc", "credentials", "prompt", "url"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("githubHubPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("githubHubAction", &forged)["ok"], false);
        }
        let mut future = action; future["controlId"] = json!("merge");
        assert_eq!(super::validate_contract("githubHubAction", &future)["ok"], false);
        let mut oversized = state.clone(); oversized["rows"] = json!(vec![state["rows"][0].clone(); 501]);
        assert_eq!(super::validate_contract("githubHubPresentation", &oversized)["ok"], false);
    }
    #[test]
    fn board_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/board/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/board/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/board/action.json")).unwrap();
        assert_eq!(super::validate_contract("boardPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("boardAction", &action)["ok"], true);
        for field in ["selector", "html", "ipc", "description", "prompt", "credentials"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("boardPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("boardAction", &forged)["ok"], false);
        }
        let mut future = action; future["controlId"] = json!("set-stage");
        assert_eq!(super::validate_contract("boardAction", &future)["ok"], false);
        let mut oversized = state.clone(); oversized["rows"] = json!(vec![state["rows"][0].clone(); 501]);
        assert_eq!(super::validate_contract("boardPresentation", &oversized)["ok"], false);
    }
    #[test]
    fn vm_component_state_action_and_policy_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/vm/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/vm/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/vm/action.json")).unwrap();
        assert_eq!(super::validate_contract("vmPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("vmAction", &action)["ok"], true);
        for field in ["nativeId", "ipc", "frame", "credentials", "input", "writableShare"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("vmPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("vmAction", &forged)["ok"], false);
        }
    }
    #[test]
    fn design_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/design/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/design/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/design/action.json")).unwrap();
        assert_eq!(super::validate_contract("designPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("designAction", &action)["ok"], true);
        for field in ["selector", "html", "frame", "ipc", "text"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("designPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("designAction", &forged)["ok"], false);
        }
        let mut future = action.clone(); future["controlId"] = json!("execute");
        assert_eq!(super::validate_contract("designAction", &future)["ok"], false);
        future = action; future["x"] = json!(6001);
        assert_eq!(super::validate_contract("designAction", &future)["ok"], false);
    }
    #[test]
    fn btw_component_state_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/btw/extension.json")).unwrap();
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/btw/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/btw/action.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        assert_eq!(super::validate_contract("btwPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("btwAction", &action)["ok"], true);
        for key in ["text", "selector", "approval", "ipc", "mainTaskControl"] {
            let mut forged = action.clone(); forged[key] = json!("forged");
            assert_eq!(super::validate_contract("btwAction", &forged)["ok"], false);
        }
        let mut approval = action.clone(); approval["controlId"] = json!("approval-allow");
        assert_eq!(super::validate_contract("btwAction", &approval)["ok"], false);
    }
    #[test]
    fn simulator_component_state_action_and_policy_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/simulator/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let state: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/simulator/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/simulator/action.json")).unwrap();
        assert_eq!(super::validate_contract("simulatorPresentation", &state)["ok"], true);
        assert_eq!(super::validate_contract("simulatorAction", &action)["ok"], true);
        for field in ["udid", "ipc", "screen", "clipboard", "input"] {
            let mut raw = state.clone(); raw[field] = json!("raw");
            assert_eq!(super::validate_contract("simulatorPresentation", &raw)["ok"], false);
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("simulatorAction", &forged)["ok"], false);
        }
    }
    #[test]
    fn provider_catalog_ids_fit_core_storage_and_launcher_byte_limits() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../examples/extensions/acp-recorded/package/extension.json")).unwrap();
        for (id, effort, valid) in [
            ("m".repeat(200), "e".repeat(40), true),
            ("é".repeat(100), "medium".into(), true),
            ("m".repeat(201), "medium".into(), false),
            ("é".repeat(101), "medium".into(), false),
            ("recorded".into(), "e".repeat(41), false),
        ] {
            let mut candidate = manifest.clone();
            candidate["contributes"]["providers"][0]["models"][0]["id"] = serde_json::json!(id);
            candidate["contributes"]["providers"][0]["models"][0]["efforts"] = serde_json::json!([effort]);
            assert_eq!(super::validate_contract("packages", &serde_json::json!([candidate]))["ok"], valid, "model bytes={}, effort={}", id.len(), effort.len());
        }
    }
    #[test]
    fn component_slot_manifest_keeps_versions_dormant_and_rejects_code_and_foreign_owners() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/replacement/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &serde_json::json!([manifest]))["ok"], true);
        let mut future = manifest.clone(); future["contributes"]["components"][0]["contractVersion"] = serde_json::json!(2);
        assert_eq!(super::validate_contract("packages", &serde_json::json!([future]))["ok"], true);
        for (field, value) in [("id", serde_json::json!("other.owner/foreign")), ("presentation", serde_json::json!("html")), ("render", serde_json::json!("code")), ("actions", serde_json::json!(["delete"]))] {
            let mut invalid = manifest.clone(); invalid["contributes"]["components"][0][field] = value;
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false);
        }
    }
    #[test]
    fn browser_component_state_and_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/browser/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let props: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/browser/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/browser/action.json")).unwrap();
        assert_eq!(super::validate_contract("browserPresentation", &props)["ok"], true);
        assert_eq!(super::validate_contract("browserAction", &action)["ok"], true);
        let mut raw = props; raw["picked"]["html"] = json!("raw");
        assert_eq!(super::validate_contract("browserPresentation", &raw)["ok"], false);
        let mut forged = action; forged["ipc"] = json!("raw");
        assert_eq!(super::validate_contract("browserAction", &forged)["ok"], false);
    }
    #[test]
    fn terminal_component_state_and_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/terminal/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let props: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/terminal/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/terminal/action.json")).unwrap();
        assert_eq!(super::validate_contract("terminalPresentation", &props)["ok"], true);
        assert_eq!(super::validate_contract("terminalAction", &action)["ok"], true);
        for field in ["pid", "command", "terminalId", "ipc"] {
            let mut forged = action.clone(); forged[field] = json!("raw");
            assert_eq!(super::validate_contract("terminalAction", &forged)["ok"], false);
        }
    }
    #[test]
    fn search_component_state_and_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/search/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let props: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/search/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/search/action.json")).unwrap();
        assert_eq!(super::validate_contract("searchPresentation", &props)["ok"], true);
        assert_eq!(super::validate_contract("searchAction", &action)["ok"], true);
        let mut duplicate = props.clone(); duplicate["results"].as_array_mut().unwrap().push(props["results"][0].clone());
        assert_eq!(super::validate_contract("searchPresentation", &duplicate)["ok"], false);
        let mut forged = action; forged["ipc"] = json!("raw");
        assert_eq!(super::validate_contract("searchAction", &forged)["ok"], false);
    }
    #[test]
    fn changes_component_state_and_action_share_native_schema() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/diff/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &json!([manifest]))["ok"], true);
        let props: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/diff/state.json")).unwrap();
        let action: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/diff/action.json")).unwrap();
        assert_eq!(super::validate_contract("changesPresentation", &props)["ok"], true);
        assert_eq!(super::validate_contract("changesAction", &action)["ok"], true);
        let mut duplicate = props.clone(); duplicate["files"].as_array_mut().unwrap().push(props["files"][0].clone());
        assert_eq!(super::validate_contract("changesPresentation", &duplicate)["ok"], false);
        let mut forged = action; forged["ipc"] = json!("raw");
        assert_eq!(super::validate_contract("changesAction", &forged)["ok"], false);
        let mut invalid = props; invalid["selected"] = json!("missing");
        assert_eq!(super::validate_contract("changesPresentation", &invalid)["ok"], false);
    }
    #[test]
    fn document_component_and_action_locations_share_native_schema() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/documents/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &serde_json::json!([manifest]))["ok"], true);
        let props = serde_json::json!({"contractVersion":1,"context":"main/A","revision":1,"tabs":[{"id":"tab","documentId":"doc","label":"Readme","controls":[{"id":"copy","label":"Copy","enabled":true}]}],"selected":"tab","focused":"doc","visible":true});
        assert_eq!(super::validate_contract("documentPresentation", &props)["ok"], true);
        let action = serde_json::json!({"contractVersion":1,"context":"main/A","revision":1,"tabId":"tab","documentId":"doc","controlId":"copy"});
        assert_eq!(super::validate_contract("documentAction", &action)["ok"], true);
        let mut forged = action.clone(); forged["ipc"] = serde_json::json!("raw");
        assert_eq!(super::validate_contract("documentAction", &forged)["ok"], false);
        let mut duplicate = props.clone(); duplicate["tabs"].as_array_mut().unwrap().push(props["tabs"][0].clone());
        assert_eq!(super::validate_contract("documentPresentation", &duplicate)["ok"], false);
        for (field, value) in [("id", serde_json::json!("other.owner/stolen")), ("presentation", serde_json::json!("html")), ("render", serde_json::json!("code"))] {
            let mut invalid = manifest.clone(); invalid["contributes"]["components"][0][field] = value;
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false);
        }
    }
    #[test]
    fn settings_and_shortcuts_share_namespaces_and_protected_dialog_policy() {
        let sample: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/settings-laboratory/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &serde_json::json!([sample]))["ok"], true);
        for kind in ["settings", "keybindings", "dialogExtras"] {
            let mut invalid = sample.clone(); invalid["contributes"][kind][0]["id"] = serde_json::json!("other.owner/foreign");
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["error"]["code"], "InvalidId");
        }
        for name in ["permission", "privacy", "recovery", "unknown"] {
            let mut invalid = sample.clone(); invalid["contributes"]["dialogExtras"][0]["dialog"] = serde_json::json!(name);
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false);
            let mut invalid = sample.clone(); invalid["contributes"]["menus"][0]["location"] = serde_json::json!(format!("panda.dialog.{name}.actions"));
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false);
        }
        let mut invalid = sample.clone(); invalid["contributes"]["settings"][0]["fields"][2]["async"] = serde_json::json!(true);
        assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["error"]["code"], "UnsupportedContribution");
    }
    #[test]
    fn core_dialog_extras_admit_only_eligible_main_dialogs() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/core-dialogs/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &serde_json::json!([manifest]))["ok"], true);
        let owned: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/owned-dialogs/extension.json")).unwrap();
        assert_eq!(super::validate_contract("packages", &serde_json::json!([owned]))["ok"], true);
        let eligible = SCHEMA["$defs"]["mainDialogId"]["enum"].as_array().unwrap().clone();
        // 23 shared main modals, then 11 module-owned and directly mounted dialogs (docs/extensions/owned-dialogs.md).
        assert_eq!(eligible.len(), 34);
        for (index, id) in eligible.iter().enumerate() {
            let location = format!("panda.dialog.{}.actions", id.as_str().unwrap());
            let fixture = if index < 23 { &manifest } else { &owned };
            assert!(fixture["contributes"]["menus"].as_array().unwrap().iter().any(|menu| menu["location"] == location.as_str()), "{location}");
        }
        let accessory = serde_json::json!({"contractVersion":1,"window":"main","dialog":"command-center","mount":"command-center/2","revision":5,"project":"project-1","task":"session-2","target":"task"});
        assert_eq!(super::validate_contract("dialogAccessory", &accessory)["ok"], true);
        // Destructive, credential, permission and recovery dialogs have no ID anywhere in the shared contract.
        for name in ["remove-project", "delete-task", "provider-connections", "delete-cloud", "github-behind", "delete-bot", "machine-link", "worktree-cleanup", "skill-add", "extension-form", "integrations-direct", "unknown"] {
            let mut invalid = manifest.clone(); invalid["contributes"]["dialogExtras"][0]["dialog"] = serde_json::json!(name);
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false, "{name}");
            let mut invalid = manifest.clone(); invalid["contributes"]["menus"][0]["location"] = serde_json::json!(format!("panda.dialog.{name}.actions"));
            assert_eq!(super::validate_contract("packages", &serde_json::json!([invalid]))["ok"], false, "{name}");
        }
        let mut oversized = manifest.clone();
        oversized["contributes"]["dialogExtras"] = serde_json::json!((0..65).map(|index| serde_json::json!({"id": format!("sample.core-dialogs/n{index}"), "dialog": "usage", "text": "Note"})).collect::<Vec<_>>());
        assert_eq!(super::validate_contract("packages", &serde_json::json!([oversized]))["ok"], false);
        let accessory = serde_json::json!({"contractVersion":1,"window":"main","dialog":"rename-task","mount":"main/4","revision":7,"project":"project-1","task":"session-1","target":"task"});
        assert_eq!(super::validate_contract("dialogAccessory", &accessory)["ok"], true);
        for (field, value) in [("dialog", serde_json::json!("delete-task")), ("window", serde_json::json!("tray")), ("contractVersion", serde_json::json!(2)), ("selector", serde_json::json!("#dialog")), ("target", serde_json::json!("bot")), ("mount", serde_json::json!(""))] {
            let mut forged = accessory.clone(); forged[field] = value;
            assert_eq!(super::validate_contract("dialogAccessory", &forged)["ok"], false, "{field}");
        }
        let context = serde_json::json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.dialog.rename-task.actions","revision":7,"dialog":"rename-task","projectId":"project-1","sessionId":"session-1","selection":{"kind":"task","ids":["session-1"]}});
        assert_eq!(super::validate_contract("context", &context)["ok"], true);
        let mut forged = context.clone(); forged["dialog"] = serde_json::json!("github-behind");
        assert_eq!(super::validate_contract("context", &forged)["ok"], false);
    }
    use super::*;

    #[test]
    fn thread_action_fixture_validates_without_task_control_authority() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/thread-laboratory/extension.json")).unwrap();
        assert_eq!(validate_contract("packages", &json!([manifest]))["ok"], true);
        assert_eq!(manifest["contributes"]["menus"].as_array().unwrap().len(), 9);
        for menu in manifest["contributes"]["menus"].as_array().unwrap() {
            let registration = json!({"schemaVersion":1, "owner":{"extensionId":"sample.thread-laboratory", "version":"1.0.0", "activationId":"test-1"}, "definition":menu});
            assert_eq!(validate_contract("contribution", &registration)["ok"], true);
            for kind in ["message", "trace", "team"] {
                let context = json!({"schemaVersion":1, "windowId":"main", "surfaceId":menu["location"], "revision":1, "projectId":"project-a", "sessionId":"task-a", "selection":{"kind":kind, "ids":["object-a"]}});
                assert_eq!(validate_contract("context", &context)["value"], context);
            }
        }
        for kind in ["stop_session", "respond_approval", "respond_user_input", "send_message", "bridge.call"] {
            let mut invalid = manifest.clone();
            invalid["contributes"]["commands"][0]["action"] = json!({"kind":kind, "sessionId":"task-a"});
            assert_eq!(validate_contract("packages", &json!([invalid]))["ok"], false);
        }
    }

    #[test]
    fn view_action_locations_and_captured_object_contexts_validate_natively() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/view-laboratory/extension.json")).unwrap();
        assert_eq!(validate_contract("packages", &json!([manifest]))["ok"], true);
        assert_eq!(manifest["contributes"]["menus"].as_array().unwrap().len(), 8);
        for menu in manifest["contributes"]["menus"].as_array().unwrap() {
            let registration = json!({"schemaVersion":1, "owner":{"extensionId":"sample.view-laboratory", "version":"1.0.0", "activationId":"test-1"}, "definition":menu});
            assert_eq!(validate_contract("contribution", &registration)["ok"], true);
            let mut proposal = manifest.clone();
            proposal["permissions"] = json!(["ui.contribute", "ui.customize"]);
            let location = menu["location"].as_str().unwrap();
            let core = if location.ends_with(".toolbar") { "refresh" } else if location.contains(".project.") { "new" } else if location.contains(".task.") { "pin" } else { "open" };
            proposal["contributes"]["layouts"] = json!([{"id":"sample.view-laboratory/layout", "title":"Object actions first", "location":location, "rules":[{"id":menu["id"], "target":format!("{location}/{core}"), "side":"before"}]}]);
            assert_eq!(validate_contract("packages", &json!([proposal]))["ok"], true);
            for kind in ["file", "task", "project"] {
                let context = json!({"schemaVersion":1, "windowId":"main", "surfaceId":menu["location"], "revision":1, "projectId":"clicked-project", "sessionId":"clicked-task", "selection":{"kind":kind, "ids":["clicked-object"]}});
                assert_eq!(validate_contract("context", &context)["value"], context);
            }
        }
    }

    #[test]
    fn dialog_contracts_share_bounded_fields_options_and_three_trigger_locations() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/menu-laboratory/extension.json")).unwrap();
        for location in ["panda.workspace.header.actions", "panda.sidebar.footer", "panda.inspector.actions"] {
            let mut value = manifest.clone(); value["contributes"]["menus"][0]["location"] = json!(location);
            assert_eq!(validate_contract("packages", &json!([value]))["ok"], true);
        }
        let dialog = &manifest["contributes"]["commands"][0]["action"]["dialog"];
        assert_eq!(validate_contract("dialog", dialog)["ok"], true);
        let mut duplicate = dialog.clone(); duplicate["fields"][1]["id"] = json!("name");
        assert_eq!(validate_contract("dialog", &duplicate)["error"]["code"], "DuplicateId");
        let mut many = dialog.clone(); many["fields"] = json!((0..25).map(|n| json!({"id":format!("field-{n}"), "kind":"text", "label":"Name"})).collect::<Vec<_>>());
        assert_eq!(validate_contract("dialog", &many)["error"]["code"], "LimitExceeded");
        assert_eq!(validate_contract("selectOptions", &json!([{"value":"a", "label":"A"}, {"value":"a", "label":"Duplicate"}]))["error"]["code"], "DuplicateId");
        let mut executable = dialog.clone(); executable["onSubmit"] = json!("eval()");
        assert_eq!(validate_contract("dialog", &executable)["error"]["code"], "InvalidShape");
    }

    #[test]
    fn recursive_menus_validate_shared_fixture_and_reject_malformed_trees() {
        let mut manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sample-project-helper/extension.json")).unwrap();
        let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/menus-v1.json")).unwrap();
        manifest["contributes"]["menus"] = json!([{ "id":"sample.project-helper/header", "location":"panda.workspace.header.actions", "command":"sample.project-helper/hello", "items":fixture }]);
        assert_eq!(validate_contract("packages", &json!([manifest]))["ok"], true);
        let mut foreign = manifest.clone(); foreign["contributes"]["menus"][0]["items"][1]["id"] = json!("other.owner/reports");
        assert_eq!(validate_contract("packages", &json!([foreign]))["error"]["code"], "InvalidId");
        let mut duplicate = manifest.clone(); duplicate["contributes"]["menus"][0]["items"][1]["id"] = json!("sample.project-helper/header");
        assert_eq!(validate_contract("packages", &json!([duplicate]))["error"]["code"], "DuplicateId");
        let mut malformed = manifest.clone(); malformed["contributes"]["menus"][0]["items"][1]["command"] = json!("sample.project-helper/hello");
        assert_eq!(validate_contract("packages", &json!([malformed]))["error"]["code"], "InvalidShape");
        let mut radio = manifest.clone(); radio["contributes"]["menus"][0]["items"][1]["items"][0]["items"][5]["checked"] = json!(true);
        assert_eq!(validate_contract("packages", &json!([radio]))["error"]["code"], "InvalidShape");
        let registration = json!({"schemaVersion":1, "owner":{"extensionId":"sample.project-helper", "version":"1.0.0", "activationId":"test-1"}, "definition":manifest["contributes"]["menus"][0]});
        assert_eq!(validate_contract("contribution", &registration)["ok"], true);
        let mut foreign_registration = registration.clone(); foreign_registration["definition"]["items"][1]["id"] = json!("other.owner/item");
        assert_eq!(validate_contract("contribution", &foreign_registration)["error"]["code"], "InvalidId");
        let mut deep = json!([]);
        for n in 0..6 { deep = json!([{ "id":format!("sample.project-helper/level-{n}"), "kind":"submenu", "title":"Deep", "items":deep }]); }
        let mut too_deep = manifest.clone(); too_deep["contributes"]["menus"][0]["items"] = deep;
        assert_eq!(validate_contract("packages", &json!([too_deep]))["error"]["code"], "LimitExceeded");
        let mut many = manifest.clone(); many["contributes"]["menus"][0]["items"] = json!((0..128).map(|n| json!({"id":format!("sample.project-helper/item-{n}"), "kind":"submenu", "title":"Nested", "items":[{"id":format!("sample.project-helper/child-{n}"), "kind":"command", "title":"Child", "command":"sample.project-helper/hello"}]})).collect::<Vec<_>>());
        assert_eq!(validate_contract("packages", &json!([many]))["error"]["code"], "LimitExceeded");
    }

    #[test]
    fn one_thousand_contributions_across_twenty_packages_validate_in_bounded_time_with_a_stable_order() {
        let manifests = super::performance_scale_manifests();
        assert_eq!(manifests.len(), 20);
        assert_eq!(manifests.iter().map(|m| m["contributes"]["menus"].as_array().unwrap().len()).sum::<usize>(), 1000);
        let started = std::time::Instant::now();
        let result = validate_contract("packages", &json!(manifests));
        let elapsed = started.elapsed();
        eprintln!("SCALE_VALIDATION elapsed_ms={}", elapsed.as_millis());
        assert_eq!(result["ok"], true, "{result}");
        let order = result["value"]["menuOrder"].as_array().unwrap();
        assert_eq!(order.len(), 1000);
        // Location, then group, then numeric order, then ID: the first entries are the board context menus of ext-01.
        assert_eq!(order[0], "perf.ext-01/m-035");
        let reversed: Vec<Value> = manifests.iter().rev().cloned().collect();
        assert_eq!(validate_contract("packages", &json!(reversed))["value"]["menuOrder"], result["value"]["menuOrder"], "input order must not change the result");
        // The former per-step re-sort was cubic (10 s in the TypeScript twin, far longer in a debug
        // build); ~0.5 s now. A generous bound tolerates parallel test load and still catches that.
        assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
    }

    #[test]
    fn ordering_cycles_and_constraints_survive_the_linear_topological_order() {
        let base = || json!({"manifestVersion":1, "id":"sample.order", "version":"1.0.0", "engines":{"pandacodeApi":"^1.0.0"}, "extensionKind":"ui", "permissions":["ui.contribute"], "contributes":{"commands":[{"id":"sample.order/run", "title":"Run", "action":{"kind":"showMessage","message":"Run"}}], "menus":[
            {"id":"sample.order/a", "location":"panda.workspace.header.actions", "command":"sample.order/run", "order":1},
            {"id":"sample.order/b", "location":"panda.workspace.header.actions", "command":"sample.order/run", "order":2},
            {"id":"sample.order/c", "location":"panda.workspace.header.actions", "command":"sample.order/run", "order":3}]}});
        let order = |value: &Value| validate_contract("packages", &json!([value]))["value"]["menuOrder"].clone();
        assert_eq!(order(&base()), json!(["sample.order/a", "sample.order/b", "sample.order/c"]));
        // A constraint only blocks its target: b is ready and ranks before c, then c unblocks a.
        let mut before = base(); before["contributes"]["menus"][2]["before"] = json!(["sample.order/a"]);
        assert_eq!(order(&before), json!(["sample.order/b", "sample.order/c", "sample.order/a"]));
        let mut after = base(); after["contributes"]["menus"][0]["after"] = json!(["sample.order/c", "sample.order/b"]);
        assert_eq!(order(&after), json!(["sample.order/b", "sample.order/c", "sample.order/a"]));
        let mut cycle = base(); cycle["contributes"]["menus"][0]["after"] = json!(["sample.order/b"]); cycle["contributes"]["menus"][1]["after"] = json!(["sample.order/a"]);
        let error = validate_contract("packages", &json!([cycle]));
        assert_eq!(error["error"]["code"], "OrderingCycle");
        assert_eq!(error["error"]["ids"], json!(["sample.order/a", "sample.order/b"]));
    }

    #[test]
    fn layout_proposals_require_declaration_reject_cycles_and_incompatible_placements() {
        let a: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/layout-a/extension.json")).unwrap();
        let b: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/layout-b/extension.json")).unwrap();
        assert_eq!(validate_contract("packages", &json!([a, b]))["ok"], true);
        assert_eq!(validate_contract("packages", &json!([b, a]))["ok"], true);
        let mut denied = a.clone(); denied["permissions"] = json!(["ui.contribute"]);
        assert_eq!(validate_contract("packages", &json!([denied]))["error"]["code"], "PermissionDenied");
        let mut cycle = a.clone();
        cycle["contributes"]["layouts"][0]["rules"].as_array_mut().unwrap().push(json!({"id":"panda.sidebar.footer/support", "target":"panda.sidebar.footer/theme", "side":"before"}));
        assert_eq!(validate_contract("packages", &json!([cycle]))["error"]["code"], "OrderingCycle");
        let mut incompatible = a.clone(); incompatible["contributes"]["layouts"][0]["location"] = json!("panda.inspector.views");
        assert_eq!(validate_contract("packages", &json!([incompatible]))["error"]["code"], "InvalidShape");
    }

    #[test]
    fn shared_extension_contract_corpus() {
        let corpus: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/contracts-v1.json")).unwrap();
        let sample: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/sample-project-helper/extension.json")).unwrap();
        for fixture in corpus["cases"].as_array().unwrap() {
            let input = fixture_input(fixture, &sample);
            let actual = if fixture["kind"] == "condition" { evaluate_condition(&input, &fixture["context"]) }
                else { validate_contract(text(fixture, "kind"), &input) };
            let mut expected = if fixture["expected"] == "sample" { corpus["sampleResult"].clone() }
                else if fixture["expected"] == "input" { json!({"ok":true, "value":fixture["input"], "diagnostics":[]}) }
                else { fixture["expected"].clone() };
            apply_edits(&mut expected, items(fixture, "expectedEdits"));
            assert_eq!(actual, expected, "{}", fixture["name"]);
        }
    }

    fn fixture_input(fixture: &Value, sample: &Value) -> Value {
        let mut input = if fixture["sample"] == true { json!([sample]) } else { fixture["input"].clone() };
        apply_edits(&mut input, items(fixture, "edits"));
        if fixture["duplicateSample"] == true { input.as_array_mut().unwrap().push(sample.clone()); }
        if let Some(repeat) = fixture["repeat"].as_u64() { input = json!(vec![input; repeat as usize]); }
        if let Some(repeat) = fixture["textRepeat"].as_u64() { input = json!(input.as_str().unwrap().repeat(repeat as usize)); }
        for _ in 0..fixture["nest"].as_u64().unwrap_or(0) { input = json!({"op":"not", "arg": input}); }
        input
    }

    fn apply_edits(input: &mut Value, edits: &[Value]) {
        for edit in edits {
            let path = text(edit, "path");
            let (parent, key) = path.rsplit_once('/').unwrap();
            let target = if parent.is_empty() { &mut *input } else { input.pointer_mut(parent).expect("fixture parent") };
            if let Some(object) = target.as_object_mut() { object.insert(key.to_owned(), edit["value"].clone()); }
            else if let Some(array) = target.as_array_mut() {
                if key == "-" { array.push(edit["value"].clone()); }
                else { array[key.parse::<usize>().unwrap()] = edit["value"].clone(); }
            } else { panic!("fixture edit parent"); }
        }
    }
}
