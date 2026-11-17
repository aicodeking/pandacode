//! A live, task-scoped band above the composer (`ui.presentation`, runtime phase R10, slice R1001).
//!
//! A trusted package puts one segment in `panda.composer.band`: a status item (`text`, `icon`, `tone`, `progress`,
//! `tooltip`, a `command` for the click and up to three buttons in `items`) or a rich view whose `location` is the band
//! (24 to 96 px high, no `placement`). The items of a background service reach the band through the run-time layer of
//! `runtime_dynamic_items` (`scope: { taskId }` shows an item only while that task is in view); this module holds the rules
//! the native side owns and rechecks:
//!
//! - `check_item` and `check_view` are the semantic validators (C04) the manifest, a registration and an update go through;
//! - `gate` is the permission recheck: a band item or view of a package that does not hold `ui.presentation` now is refused
//!   with `PermissionDenied`, and `strip_ungranted` removes it from the layer the interface reads, so a revoke, a disable or
//!   safe mode takes the band away at once without touching the built-in composer or a running task;
//! - `segments`, `arrange` and `step_placement` are the selection rules the interface mirrors
//!   (`src/extensions/runtime-composer-band.ts`): one segment per package, three drawn, the rest in a menu, hide and order.
//!
//! Everything here is for predictability and fault isolation, never for trust (ADR-0005): a package that holds the permission
//! is never asked again per action. The state is pure (no I/O, no clock) so the bounds are deterministic to test.
use serde_json::{json, Map, Value};

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.presentation";
pub const LOCATION: &str = "panda.composer.band";
/// Segments drawn in the row; the rest fold into a menu.
pub const MAX_SHOWN: usize = 3;
/// Item buttons of one segment.
pub const MAX_BUTTONS: usize = 3;
pub const MIN_HEIGHT: u64 = 24;
pub const MAX_HEIGHT: u64 = 96;
const INSPECTOR_MIN_HEIGHT: u64 = 160;
const TONES: [&str; 5] = ["neutral", "info", "success", "warning", "danger"];

/// The frozen failure of a band item (`None` when it is not a band item or is a valid one).
pub fn check_item(menu: &Value) -> Option<&'static str> {
    if menu["location"].as_str() != Some(LOCATION) { return None; }
    if menu["presentation"].as_str() != Some("status") { return Some("InvalidShape"); }
    match menu.get("items") {
        None => None,
        Some(Value::Array(items)) if items.len() > MAX_BUTTONS => Some("LimitExceeded"),
        Some(Value::Array(items)) => if items.iter().all(|item| item["kind"] == "command" && item["command"].is_string() && item["title"].is_string()) { None } else { Some("InvalidShape") },
        Some(_) => Some("InvalidShape"),
    }
}

/// C04: a band view has a `rich` panel 24 to 96 px high and no `placement`; any other location needs 160 or more.
pub fn check_view(view: &Value) -> Option<&'static str> {
    let location = view["location"].as_str();
    if location.is_some_and(|location| location != LOCATION && location != "panda.inspector.views") || (!view["location"].is_null() && location.is_none()) { return Some("InvalidShape"); }
    let in_band = location == Some(LOCATION);
    if !view["rich"].is_object() { return if in_band { Some("InvalidShape") } else { None }; }
    let height = view["rich"]["minSize"]["height"].as_u64();
    if in_band {
        if !view["rich"]["placement"].is_null() { return Some("InvalidShape"); }
        return match height { Some(height) if (MIN_HEIGHT..=MAX_HEIGHT).contains(&height) => None, _ => Some("InvalidShape") };
    }
    if height.is_some_and(|height| height < INSPECTOR_MIN_HEIGHT) { Some("InvalidShape") } else { None }
}

/// The band height of a rich view, clamped to the range both validators enforce.
pub fn view_height(view: &Value) -> u64 { view["rich"]["minSize"]["height"].as_u64().unwrap_or(MIN_HEIGHT).clamp(MIN_HEIGHT, MAX_HEIGHT) }

/// Whether a menu item or a view is in the band.
fn in_band(definition: &Value) -> bool { definition["location"].as_str() == Some(LOCATION) }

/// The permission recheck of a registration or an update that targets the band: a package without `ui.presentation` now is
/// refused; anything outside the band is none of this slice's business.
pub fn gate(definition: &Value, holds: bool) -> Result<(), &'static str> {
    if !in_band(definition) { return Ok(()); }
    if !holds { return Err("PermissionDenied"); }
    check_item(definition).or_else(|| if definition.get("rich").is_some() { check_view(definition) } else { None }).map_or(Ok(()), Err)
}

/// Removes the band items and views of every owner that does not hold `ui.presentation` now from a run-time layer
/// (`{ revision, owners: { id: { menus, views, .. } } }`). Answers how many entries were removed.
pub fn strip_ungranted(layer: &mut Value, holds: &dyn Fn(&str) -> bool) -> usize {
    let mut removed = 0;
    let Some(owners) = layer["owners"].as_object_mut() else { return 0 };
    for (owner, entry) in owners.iter_mut() {
        if holds(owner) { continue; }
        for bucket in ["menus", "views"] {
            if let Some(list) = entry[bucket].as_array_mut() {
                let before = list.len();
                list.retain(|item| !in_band(item));
                removed += before - list.len();
            }
        }
    }
    removed
}

/// One segment of the band, as the interface draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment { pub key: String, pub owner: String, pub kind: &'static str, pub text: String, pub tone: String, pub progress: Option<u64>, pub command: Option<String>, pub buttons: Vec<Value>, pub height: Option<u64> }

/// The segments of the band for the packages that may show one (`holds`), given the merged contributions of each owner
/// (`owners`: id to `{ menus, views }`, already without the items scoped to a task that is not in view). One segment per
/// package: its band view when it declares one, else its first valid status item that is not `visible: false`.
pub fn segments(owners: &Map<String, Value>, holds: &dyn Fn(&str) -> bool) -> Vec<Segment> {
    let mut out = Vec::new();
    for (owner, entry) in owners {
        if !holds(owner) { continue; }
        let list = |bucket: &str| entry[bucket].as_array().cloned().unwrap_or_default();
        if let Some(view) = list("views").iter().find(|view| in_band(view) && view["rich"].is_object() && check_view(view).is_none()) {
            out.push(Segment { key: view["id"].as_str().unwrap_or_default().to_owned(), owner: owner.clone(), kind: "view", text: view["text"].as_str().unwrap_or_default().to_owned(), tone: "neutral".into(), progress: None, command: None, buttons: Vec::new(), height: Some(view_height(view)) });
            continue;
        }
        let Some(menu) = list("menus").into_iter().find(|menu| in_band(menu) && menu["visible"] != json!(false) && check_item(menu).is_none()) else { continue };
        let tone = menu["tone"].as_str().filter(|tone| TONES.contains(tone)).unwrap_or("neutral").to_owned();
        let progress = menu["progress"].as_u64().filter(|progress| *progress <= 100);
        let buttons = menu["items"].as_array().map(|items| items.iter().take(MAX_BUTTONS).cloned().collect()).unwrap_or_default();
        out.push(Segment { key: menu["id"].as_str().unwrap_or_default().to_owned(), owner: owner.clone(), kind: "status", text: menu["text"].as_str().or(menu["badge"].as_str()).unwrap_or_default().to_owned(), tone, progress, command: menu["command"].as_str().map(str::to_owned), buttons, height: None });
    }
    out
}

/// What the user's order and hiding make of the segments: the first `MAX_SHOWN` visible ones are drawn, the rest fold into
/// the menu, hidden ones wait to be restored. `order` lists keys; keys it does not name keep their place after the named ones.
#[derive(Debug, PartialEq)]
pub struct Arrangement { pub shown: Vec<String>, pub overflow: Vec<String>, pub hidden: Vec<String> }
pub fn arrange(keys: &[String], order: &[String], hidden: &dyn Fn(&str) -> bool) -> Arrangement {
    let mut ordered: Vec<String> = order.iter().filter(|key| keys.contains(key)).cloned().collect();
    for key in keys { if !ordered.contains(key) { ordered.push(key.clone()); } }
    let (hidden_keys, visible): (Vec<String>, Vec<String>) = ordered.into_iter().partition(|key| hidden(key));
    Arrangement { shown: visible.iter().take(MAX_SHOWN).cloned().collect(), overflow: visible.iter().skip(MAX_SHOWN).cloned().collect(), hidden: hidden_keys }
}

/// The relative placement that moves `key` one step among the visible segments (`earlier` or `later`), `None` at an end.
pub fn step_placement(visible: &[String], key: &str, earlier: bool) -> Option<(String, String, &'static str)> {
    let at = visible.iter().position(|item| item == key)?;
    let neighbour = if earlier { at.checked_sub(1)? } else { at + 1 };
    visible.get(neighbour).map(|target| (key.to_owned(), target.clone(), if earlier { "before" } else { "after" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &str) -> Value { json!({"id": id, "location": LOCATION, "command": "sample.band/open", "presentation": "status", "text": "Usage 42%", "tone": "warning", "progress": 42}) }
    fn band_view(id: &str, height: u64) -> Value { json!({"id": id, "title": "Band", "text": "", "location": LOCATION, "rich": {"html": "assets/b.html", "css": "assets/b.css", "script": "assets/b.js", "minSize": {"width": 160, "height": height}}}) }
    fn owners(entries: &[(&str, Value)]) -> Map<String, Value> { entries.iter().map(|(owner, value)| ((*owner).to_owned(), value.clone())).collect() }

    #[test]
    fn a_band_item_is_a_status_with_at_most_three_command_buttons() {
        assert_eq!(check_item(&status("a.b/x")), None);
        let mut one = status("a.b/x"); one["presentation"] = json!("button");
        assert_eq!(check_item(&one), Some("InvalidShape"));
        let button = |n: u32| json!({"id": format!("a.b/i{n}"), "kind": "command", "title": "Go", "command": "a.b/go"});
        let mut three = status("a.b/x"); three["items"] = json!([button(1), button(2), button(3)]);
        assert_eq!(check_item(&three), None);
        three["items"] = json!([button(1), button(2), button(3), button(4)]);
        assert_eq!(check_item(&three), Some("LimitExceeded"));
        three["items"] = json!([{"id": "a.b/s", "kind": "separator"}]);
        assert_eq!(check_item(&three), Some("InvalidShape"));
        // An item elsewhere is not judged by the band rules.
        assert_eq!(check_item(&json!({"location": "panda.status.items", "presentation": "button"})), None);
    }

    #[test]
    fn a_band_view_is_24_to_96_without_placement_and_an_inspector_view_needs_160() {
        for height in [24, 48, 96] { assert_eq!(check_view(&band_view("a.b/v", height)), None, "{height}"); }
        for height in [23, 97, 160] { assert_eq!(check_view(&band_view("a.b/v", height)), Some("InvalidShape"), "{height}"); }
        let mut placed = band_view("a.b/v", 48); placed["rich"]["placement"] = json!("inspector");
        assert_eq!(check_view(&placed), Some("InvalidShape"));
        let mut plain = band_view("a.b/v", 48); plain.as_object_mut().unwrap().remove("rich");
        assert_eq!(check_view(&plain), Some("InvalidShape"));
        let mut inspector = band_view("a.b/v", 48); inspector["location"] = json!("panda.inspector.views");
        assert_eq!(check_view(&inspector), Some("InvalidShape"));
        inspector["rich"]["minSize"]["height"] = json!(160);
        assert_eq!(check_view(&inspector), None);
        let mut nowhere = band_view("a.b/v", 48); nowhere["location"] = json!("panda.somewhere");
        assert_eq!(check_view(&nowhere), Some("InvalidShape"));
        assert_eq!(view_height(&band_view("a.b/v", 500)), MAX_HEIGHT);
    }

    #[test]
    fn the_grant_is_rechecked_and_a_revoke_strips_the_band_from_the_layer() {
        assert_eq!(gate(&status("a.b/x"), true), Ok(()));
        assert_eq!(gate(&status("a.b/x"), false), Err("PermissionDenied"));
        assert_eq!(gate(&json!({"location": "panda.status.items"}), false), Ok(()));
        let mut layer = json!({"revision": 3, "owners": {"a.b": {"menus": [status("a.b/x"), {"id": "a.b/y", "location": "panda.status.items"}], "views": [band_view("a.b/v", 40)]}, "c.d": {"menus": [status("c.d/x")], "views": []}}});
        assert_eq!(strip_ungranted(&mut layer, &|owner| owner == "c.d"), 2);
        assert_eq!(layer["owners"]["a.b"]["menus"].as_array().unwrap().len(), 1);
        assert_eq!(layer["owners"]["a.b"]["views"].as_array().unwrap().len(), 0);
        assert_eq!(layer["owners"]["c.d"]["menus"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn one_segment_per_package_with_its_view_first_and_only_granted_packages() {
        let both = json!({"menus": [status("a.b/x")], "views": [band_view("a.b/v", 40)]});
        let only = json!({"menus": [json!({"id": "c.d/hidden", "location": LOCATION, "command": "c.d/o", "presentation": "status", "visible": false}), status("c.d/x")], "views": []});
        let refused = json!({"menus": [status("e.f/x")], "views": []});
        let map = owners(&[("a.b", both), ("c.d", only), ("e.f", refused)]);
        let found = segments(&map, &|owner| owner != "e.f");
        assert_eq!(found.iter().map(|segment| (segment.owner.as_str(), segment.kind, segment.key.as_str())).collect::<Vec<_>>(), vec![("a.b", "view", "a.b/v"), ("c.d", "status", "c.d/x")]);
        assert_eq!(found[0].height, Some(40));
        assert_eq!((found[1].progress, found[1].tone.as_str()), (Some(42), "warning"));
    }

    #[test]
    fn three_are_drawn_the_rest_fold_and_hide_and_order_apply() {
        let keys: Vec<String> = ["a/x", "b/x", "c/x", "d/x", "e/x"].iter().map(|key| (*key).to_owned()).collect();
        let none = arrange(&keys, &[], &|_| false);
        assert_eq!((none.shown.len(), none.overflow.len(), none.hidden.len()), (3, 2, 0));
        let order: Vec<String> = ["e/x", "ghost/x", "a/x"].iter().map(|key| (*key).to_owned()).collect();
        let arranged = arrange(&keys, &order, &|key| key == "b/x");
        assert_eq!(arranged.shown, vec!["e/x", "a/x", "c/x"]);
        assert_eq!(arranged.overflow, vec!["d/x"]);
        assert_eq!(arranged.hidden, vec!["b/x"]);
        let visible = vec!["e/x".to_owned(), "a/x".to_owned(), "c/x".to_owned()];
        assert_eq!(step_placement(&visible, "a/x", true), Some(("a/x".into(), "e/x".into(), "before")));
        assert_eq!(step_placement(&visible, "a/x", false), Some(("a/x".into(), "c/x".into(), "after")));
        assert_eq!(step_placement(&visible, "e/x", true), None);
        assert_eq!(step_placement(&visible, "c/x", false), None);
    }
}
