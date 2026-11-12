//! The native half of the shared v1 contract corpus.
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/extensions/schema-v1.json"))
        .expect("shipped extension schema")
});
type Result<T> = std::result::Result<T, Value>;
const CONTRIBUTIONS: [&str; 8] = ["commands", "icons", "menus", "views", "layouts", "settings", "keybindings", "dialogExtras"];
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
fn order_graph(nodes: Vec<String>, edges: &[(String, String)], code: &str, path: &str, rank: impl Fn(&String, &String) -> std::cmp::Ordering) -> Result<Vec<String>> {
    let mut remaining: BTreeSet<_> = nodes.into_iter().collect();
    let mut result = vec![];
    while !remaining.is_empty() {
        let mut ready: Vec<_> = remaining.iter().filter(|id| !edges.iter().any(|(from, to)| to == *id && remaining.contains(from))).cloned().collect();
        ready.sort_by(&rank);
        let Some(id) = ready.first() else { return Err(fail(code, path, remaining.into_iter().collect())); };
        remaining.remove(id);
        result.push(id.clone());
    }
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
fn manifests(input: &Value, diagnostics: &mut Vec<Value>) -> Result<Value> {
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
                if !["ui.contribute", "ui.customize"].contains(&capability.as_str()) { return Err(fail("UnsupportedCapability", &format!("{path}/{key}"), vec![capability])); }
            }
        }
        let optional = strings(&manifest["optionalCapabilities"]);
        for (i, capability) in optional.iter().enumerate() {
            if !["ui.contribute", "ui.customize"].contains(&capability.as_str()) {
                diagnostics.push(json!({"code":"UnknownOptionalCapability", "path":format!("{path}/optionalCapabilities/{i}")}));
            }
        }
        if manifest.get("optionalCapabilities").is_some() { manifest["optionalCapabilities"] = json!(optional.into_iter().filter(|v| ["ui.contribute", "ui.customize"].contains(&v.as_str())).collect::<Vec<_>>()); }
        for kind in strings(&manifest["requiredContributions"]) {
            if !CONTRIBUTIONS.contains(&kind.as_str()) { return Err(fail("UnsupportedContribution", &format!("{path}/requiredContributions"), vec![kind])); }
        }
        let contributions = &manifest["contributes"];
        let mut owned = BTreeSet::new();
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
        for page in items(contributions, "settings") {
            dialog_fields(page, &format!("{path}/contributes/settings"))?;
            if items(page, "fields").iter().any(|field| field["async"] == true) { return Err(fail("UnsupportedContribution", &format!("{path}/contributes/settings"), vec![text(page, "id").to_owned()])); }
        }
        for binding in items(contributions, "keybindings") { reference(contributions, "commands", &binding["command"], &format!("{path}/contributes/keybindings"))?; }
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
                let dependency = packages.iter().find(|item| item["id"] == *id).ok_or_else(|| fail("UnknownReference", &path, vec![id.clone()]))?;
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
    let menu_order = order_graph(menus.iter().map(|item| text(item, "id").to_owned()).collect(), &edges, "OrderingCycle", "$/ordering", |a, b| {
        let left = menus.iter().find(|item| item["id"] == *a).unwrap();
        let right = menus.iter().find(|item| item["id"] == *b).unwrap();
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
        let value = if kind == "packages" { manifests(value, &mut diagnostics)? }
            else if ["command", "surface", "contribution", "context", "error", "expression", "dialog", "selectOptions"].contains(&kind) { shape(value, &SCHEMA["$defs"][kind], "$", &mut diagnostics)? }
            else { return Err(invalid("$")); };
        if kind == "dialog" { dialog_fields(&value, "$")?; }
        if kind == "selectOptions" { distinct(value.as_array().unwrap(), "value", "$")?; }
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

#[cfg(test)]
mod tests {
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
