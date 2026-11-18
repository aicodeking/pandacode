//! Selectable presentations (`ui.presentation`, runtime phase R10, slice R1002).
//!
//! A trusted package adds three closed things to the conversation, all additive and all gone when the package is disabled,
//! the grant is revoked or the app is in safe mode:
//!
//! - a **conversation-only transcript**: a `contributes.components` entry for the slot `panda.transcript` whose presentation
//!   is `conversation` (the host hides the tool steps; the text of the turns, the questions and the approvals stay);
//! - a **working indicator**: 2 to 16 text frames of at most 16 characters, 80 to 1,000 ms apart;
//! - a **backdrop** behind the thread: one static image of the package or one of its rich views, with an opacity from 0 to 0.5.
//!
//! The indicator and the backdrop are `contributes.presentations`; the user chooses one of each in the conversation (like a
//! recipe) and the choice is the user's alone. This module holds what the native side owns and rechecks:
//!
//! - `check_presentation`/`check_all`: the semantic validators (the shapes themselves are in `schema-v1.json`);
//! - `check_conversation_provider`: the capability rule of the `conversation` presentation;
//! - `gate`: the permission recheck (`PermissionDenied` without `ui.presentation` now);
//! - `resolve`: the selection rule, which falls back to the built-in presentation whenever the chosen offer is not valid;
//! - `frame_index`/`opacity`: the bounds the interface mirrors (`src/extensions/runtime-transcript-presentation.ts`).
//!
//! Limits are for reliability, predictability and legibility, never for trust (ADR-0005): a package that holds the permission
//! is never asked again per action. The state is pure (no I/O, no clock), so the bounds are deterministic to test.
use serde_json::Value;

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.presentation";
pub const KINDS: [&str; 2] = ["working-indicator", "backdrop"];
pub const MIN_FRAMES: usize = 2;
pub const MAX_FRAMES: usize = 16;
pub const MAX_FRAME_CHARS: usize = 16;
pub const MIN_INTERVAL_MS: u64 = 80;
pub const MAX_INTERVAL_MS: u64 = 1000;
/// A backdrop never exceeds this opacity, so the text of the thread stays readable over it.
pub const MAX_OPACITY: f64 = 0.5;
pub const MAX_PRESENTATIONS: usize = 16;
/// Capabilities a `conversation` transcript must declare (what the host keeps running under it).
pub const CONVERSATION_CAPABILITIES: [&str; 3] = ["streaming", "stop-resume", "host-history"];
const ALL_CAPABILITIES: [&str; 8] = ["streaming", "tool-output", "questions", "approvals", "team-progress", "usage", "stop-resume", "host-history"];

/// The frozen failure of one presentation (`None` when it is valid). `views` are the ids of the package's own views and
/// `icon_assets` the assets its `icons` declare (an image backdrop is a static SVG the icon channel already carries).
pub fn check_presentation(presentation: &Value, views: &[&str], icon_assets: &[&str]) -> Option<&'static str> {
    let kind = presentation["kind"].as_str();
    match kind {
        Some("working-indicator") => {
            let Some(frames) = presentation["frames"].as_array() else { return Some("InvalidShape") };
            if frames.len() < MIN_FRAMES || frames.len() > MAX_FRAMES { return Some("LimitExceeded"); }
            if !frames.iter().all(|frame| frame.as_str().is_some_and(|text| !text.is_empty() && text.chars().count() <= MAX_FRAME_CHARS)) { return Some("LimitExceeded"); }
            match presentation["intervalMs"].as_u64() { Some(ms) if (MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&ms) => None, Some(_) => Some("LimitExceeded"), None => Some("InvalidShape") }
        }
        Some("backdrop") => {
            let opacity = match presentation["opacity"].as_f64() { Some(value) if value.is_finite() => value, _ => return Some("InvalidShape") };
            if !(0.0..=MAX_OPACITY).contains(&opacity) { return Some("LimitExceeded"); }
            // Exactly one source: an image of the archive or an owned view.
            match (presentation["image"].as_str(), presentation["view"].as_str()) {
                (Some(image), None) => if image.starts_with("assets/") && image.ends_with(".svg") && icon_assets.contains(&image) { None } else { Some("InvalidShape") },
                (None, Some(view)) => if views.contains(&view) { None } else { Some("InvalidShape") },
                _ => Some("InvalidShape"),
            }
        }
        _ => Some("InvalidShape"),
    }
}

/// The failure of a package's whole `presentations` list: the bound, unique ids, then each entry.
pub fn check_all(list: &[Value], views: &[&str], icon_assets: &[&str]) -> Option<&'static str> {
    if list.len() > MAX_PRESENTATIONS { return Some("LimitExceeded"); }
    let mut seen: Vec<&str> = Vec::new();
    for presentation in list {
        let Some(id) = presentation["id"].as_str() else { return Some("InvalidShape") };
        if seen.contains(&id) { return Some("InvalidShape"); }
        seen.push(id);
        if let Some(code) = check_presentation(presentation, views, icon_assets) { return Some(code); }
    }
    None
}

/// The `conversation` presentation of the slot `panda.transcript` declares the capabilities the host keeps under it and no
/// capability outside the transcript vocabulary. Any other presentation of the slot is none of this slice's business.
pub fn check_conversation_provider(provider: &Value) -> Option<&'static str> {
    if provider["slot"].as_str() != Some("panda.transcript") || provider["presentation"].as_str() != Some("conversation") { return None; }
    let declared: Vec<&str> = provider["capabilities"].as_array().map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if CONVERSATION_CAPABILITIES.iter().all(|needed| declared.contains(needed)) && declared.iter().all(|name| ALL_CAPABILITIES.contains(name)) { None } else { Some("InvalidShape") }
}

/// The permission recheck of a presentation or a conversation transcript: a package without `ui.presentation` now is refused.
pub fn gate(holds: bool) -> Result<(), &'static str> { if holds { Ok(()) } else { Err("PermissionDenied") } }

/// One thing a package offers for a kind, as the choice lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Offer { pub key: String, pub owner: String, pub kind: String, pub title: String, pub definition: Value }

/// The offers of the packages that may show one (`holds`) and whose presentation is valid, in a fixed order (owner, then
/// declaration). `owners` pairs a package id with its `contributes` object.
pub fn offers(owners: &[(String, Value)], kind: &str, holds: &dyn Fn(&str) -> bool) -> Vec<Offer> {
    let mut out = Vec::new();
    for (owner, contributes) in owners {
        if !holds(owner) { continue; }
        let list = contributes["presentations"].as_array().cloned().unwrap_or_default();
        let views: Vec<&str> = contributes["views"].as_array().map(|views| views.iter().filter_map(|view| view["id"].as_str()).collect()).unwrap_or_default();
        let assets: Vec<&str> = contributes["icons"].as_array().map(|icons| icons.iter().filter_map(|icon| icon["asset"].as_str()).collect()).unwrap_or_default();
        for presentation in list.iter().filter(|presentation| presentation["kind"].as_str() == Some(kind)) {
            if check_presentation(presentation, &views, &assets).is_some() { continue; }
            out.push(Offer { key: presentation["id"].as_str().unwrap_or_default().to_owned(), owner: owner.clone(), kind: kind.to_owned(), title: presentation["title"].as_str().unwrap_or_default().to_owned(), definition: presentation.clone() });
        }
    }
    out
}

/// The offer the user's choice resolves to: the chosen key when it is still offered, else `None` (the built-in presentation).
/// There is no automatic default: nothing changes until the user chooses.
pub fn resolve<'a>(offers: &'a [Offer], chosen: Option<&str>) -> Option<&'a Offer> { chosen.and_then(|key| offers.iter().find(|offer| offer.key == key)) }

/// The frame to draw: the first one, still, with reduced motion; otherwise the tick modulo the frame count.
pub fn frame_index(count: usize, tick: u64, reduced_motion: bool) -> usize { if count == 0 || reduced_motion { 0 } else { (tick % count as u64) as usize } }

/// The opacity actually drawn: the declared one clamped to 0 to `MAX_OPACITY` (non-numbers draw nothing).
pub fn opacity(declared: &Value) -> f64 { declared.as_f64().filter(|value| value.is_finite()).map_or(0.0, |value| value.clamp(0.0, MAX_OPACITY)) }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn indicator(frames: Value, interval: Value) -> Value { json!({"id": "a.b/dots", "title": "Dots", "kind": "working-indicator", "frames": frames, "intervalMs": interval}) }
    fn image(opacity: Value) -> Value { json!({"id": "a.b/sky", "title": "Sky", "kind": "backdrop", "image": "assets/sky.svg", "opacity": opacity}) }

    #[test]
    fn an_indicator_has_two_to_sixteen_short_frames_80_to_1000_ms_apart() {
        assert_eq!(check_presentation(&indicator(json!(["·", "··", "···"]), json!(240)), &[], &[]), None);
        assert_eq!(check_presentation(&indicator(json!(["·"]), json!(240)), &[], &[]), Some("LimitExceeded"));
        let many: Vec<String> = (0..17).map(|n| n.to_string()).collect();
        assert_eq!(check_presentation(&indicator(json!(many), json!(240)), &[], &[]), Some("LimitExceeded"));
        assert_eq!(check_presentation(&indicator(json!(["a", "a".repeat(17)]), json!(240)), &[], &[]), Some("LimitExceeded"));
        assert_eq!(check_presentation(&indicator(json!(["a", ""]), json!(240)), &[], &[]), Some("LimitExceeded"));
        for ms in [79, 1001] { assert_eq!(check_presentation(&indicator(json!(["a", "b"]), json!(ms)), &[], &[]), Some("LimitExceeded"), "{ms}"); }
        for ms in [80, 1000] { assert_eq!(check_presentation(&indicator(json!(["a", "b"]), json!(ms)), &[], &[]), None, "{ms}"); }
        assert_eq!(check_presentation(&indicator(json!(["a", "b"]), json!("fast")), &[], &[]), Some("InvalidShape"));
    }

    #[test]
    fn a_backdrop_names_one_source_and_an_opacity_up_to_one_half() {
        let assets = ["assets/sky.svg"];
        assert_eq!(check_presentation(&image(json!(0.2)), &[], &assets), None);
        assert_eq!(check_presentation(&image(json!(0)), &[], &assets), None);
        assert_eq!(check_presentation(&image(json!(0.5)), &[], &assets), None);
        assert_eq!(check_presentation(&image(json!(0.51)), &[], &assets), Some("LimitExceeded"));
        assert_eq!(check_presentation(&image(json!(-0.1)), &[], &assets), Some("LimitExceeded"));
        assert_eq!(check_presentation(&image(json!("0.2")), &[], &assets), Some("InvalidShape"));
        // The image must be an `assets/` SVG that the package's icons declare.
        assert_eq!(check_presentation(&image(json!(0.2)), &[], &[]), Some("InvalidShape"));
        let mut png = image(json!(0.2)); png["image"] = json!("assets/sky.png");
        assert_eq!(check_presentation(&png, &[], &["assets/sky.png"]), Some("InvalidShape"));
        let view = json!({"id": "a.b/aurora", "title": "Aurora", "kind": "backdrop", "view": "a.b/panel", "opacity": 0.3});
        assert_eq!(check_presentation(&view, &["a.b/panel"], &[]), None);
        assert_eq!(check_presentation(&view, &["a.b/other"], &[]), Some("InvalidShape"));
        let mut both = view.clone(); both["image"] = json!("assets/sky.svg");
        assert_eq!(check_presentation(&both, &["a.b/panel"], &assets), Some("InvalidShape"));
        let mut neither = view.clone(); neither.as_object_mut().unwrap().remove("view");
        assert_eq!(check_presentation(&neither, &[], &[]), Some("InvalidShape"));
        assert_eq!(check_presentation(&json!({"id": "a.b/x", "kind": "theme"}), &[], &[]), Some("InvalidShape"));
    }

    #[test]
    fn the_list_is_bounded_and_its_ids_are_unique() {
        let one = indicator(json!(["a", "b"]), json!(100));
        assert_eq!(check_all(std::slice::from_ref(&one), &[], &[]), None);
        assert_eq!(check_all(&[one.clone(), one.clone()], &[], &[]), Some("InvalidShape"));
        let many: Vec<Value> = (0..17).map(|n| { let mut item = one.clone(); item["id"] = json!(format!("a.b/p{n}")); item }).collect();
        assert_eq!(check_all(&many, &[], &[]), Some("LimitExceeded"));
        assert_eq!(check_all(&many[..16], &[], &[]), None);
    }

    #[test]
    fn the_conversation_transcript_keeps_what_the_host_runs_under_it() {
        let provider = |capabilities: Value| json!({"id": "a.b/chat", "title": "Chat", "slot": "panda.transcript", "contractVersion": 1, "presentation": "conversation", "capabilities": capabilities});
        assert_eq!(check_conversation_provider(&provider(json!(["streaming", "stop-resume", "host-history"]))), None);
        assert_eq!(check_conversation_provider(&provider(json!(["streaming", "stop-resume"]))), Some("InvalidShape"));
        assert_eq!(check_conversation_provider(&provider(json!(["streaming", "stop-resume", "host-history", "teleport"]))), Some("InvalidShape"));
        let mut timeline = provider(json!([])); timeline["presentation"] = json!("timeline");
        assert_eq!(check_conversation_provider(&timeline), None);
        assert_eq!(gate(true), Ok(()));
        assert_eq!(gate(false), Err("PermissionDenied"));
    }

    #[test]
    fn only_granted_packages_offer_and_the_choice_falls_back_to_the_built_in() {
        let contributes = json!({"icons": [{"id": "a.b/sky-icon", "asset": "assets/sky.svg"}], "views": [], "presentations": [indicator(json!(["a", "b"]), json!(100)), image(json!(0.2)), json!({"id": "a.b/bad", "title": "Bad", "kind": "working-indicator", "frames": ["a"], "intervalMs": 100})]});
        let owners = vec![("a.b".to_owned(), contributes.clone()), ("c.d".to_owned(), contributes)];
        let found = offers(&owners, "working-indicator", &|owner| owner == "a.b");
        assert_eq!(found.iter().map(|offer| offer.key.as_str()).collect::<Vec<_>>(), vec!["a.b/dots"]);
        assert_eq!(offers(&owners, "backdrop", &|_| true).len(), 2);
        assert_eq!(resolve(&found, Some("a.b/dots")).map(|offer| offer.owner.as_str()), Some("a.b"));
        assert_eq!(resolve(&found, Some("a.b/gone")), None);
        assert_eq!(resolve(&found, None), None);
        assert_eq!(offers(&owners, "working-indicator", &|_| false), vec![]);
    }

    #[test]
    fn reduced_motion_holds_the_first_frame_and_the_opacity_is_clamped() {
        assert_eq!((frame_index(3, 0, false), frame_index(3, 4, false), frame_index(3, 4, true), frame_index(0, 4, false)), (0, 1, 0, 0));
        assert_eq!((opacity(&json!(0.2)), opacity(&json!(0.9)), opacity(&json!(-1)), opacity(&json!("x"))), (0.2, 0.5, 0.0, 0.0));
    }
}
