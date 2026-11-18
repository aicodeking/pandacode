use super::*;

// ---- preferences ----

fn write_old_config(dir: &Path, selected: bool) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let json = serde_json::json!({
        "selectedProfileId": if selected { Some(id.clone()) } else { None },
        "profiles": [{ "id": id, "name": "Local", "provider": "custom", "endpoint": "http://127.0.0.1:8080/stt",
            "model": "whisper", "language": null, "keyId": null }],
    });
    std::fs::write(dir.join("voice-profiles.json"), json.to_string()).unwrap();
    id
}

#[test]
fn old_configs_keep_their_profile_or_stay_off() {
    use super::super::config::{Destination, DestinationMode, Preferences, ShortcutMode, UnloadAfter};
    let temp = Temp::new();
    let id = write_old_config(&temp.0, true);
    let voice = super::super::Voice::new(temp.0.clone());
    let prefs = voice.preferences().unwrap();
    assert!(matches!(&prefs.destination, Destination::Profile(p) if p.profile_id == id));
    assert_eq!((prefs.shortcut_mode, prefs.unload_after, prefs.language.as_str()), (ShortcutMode::Auto, UnloadAfter::Min15, "auto"));
    assert_eq!(serde_json::to_value(&prefs).unwrap()["destination"], serde_json::json!({ "profileId": id }));

    let temp = Temp::new();
    write_old_config(&temp.0, false);
    let voice = super::super::Voice::new(temp.0.clone());
    assert_eq!(voice.preferences().unwrap().destination, Destination::Mode(DestinationMode::Off));

    // Saving writes version 2, and the remote profile list still loads.
    let prefs = Preferences {
        destination: Destination::Mode(DestinationMode::Local),
        device_name: Some("USB Mic".into()),
        shortcut_mode: ShortcutMode::Toggle,
        language: "de".into(),
        unload_after: UnloadAfter::Immediately,
        selected_model: Some("handy-computer/moonshine-tiny-gguf".into()),
    };
    voice.save_preferences(prefs.clone(), |_| Ok(())).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(temp.0.join("voice-profiles.json")).unwrap()).unwrap();
    assert_eq!(raw["version"], 2);
    assert_eq!(raw["preferences"]["destination"], "local");
    assert_eq!(raw["preferences"]["unloadAfter"], "immediately");
    assert_eq!(voice.preferences().unwrap(), prefs);
    let config = serde_json::to_value(voice.configuration().unwrap_or_else(|e| panic!("{e}"))).unwrap();
    assert_eq!(config["profiles"].as_array().unwrap().len(), 1);
    // Clearing the profile selection keeps a local destination.
    voice.select_profile(None).unwrap();
    assert_eq!(voice.preferences().unwrap().destination, Destination::Mode(DestinationMode::Local));
    // Bad input is refused before anything is written.
    for bad in [
        serde_json::json!({ "destination": { "profileId": "missing" } }),
        serde_json::json!({ "destination": "local", "language": "e n" }),
        serde_json::json!({ "destination": "local", "deviceName": "" }),
    ] {
        let prefs: Preferences = serde_json::from_value(bad).unwrap();
        assert!(voice.save_preferences(prefs, |_| Ok(())).is_err());
    }
    assert!(serde_json::from_value::<Preferences>(serde_json::json!({ "destination": "local", "extra": 1 })).is_err());
    assert!(serde_json::from_value::<Preferences>(serde_json::json!({ "destination": "cloud" })).is_err());
    // A newer file is not overwritten blindly.
    let mut raw = raw;
    raw["version"] = 99.into();
    std::fs::write(temp.0.join("voice-profiles.json"), raw.to_string()).unwrap();
    assert!(voice.preferences().is_err());
}

#[test]
fn local_destination_needs_an_installed_model() {
    use super::super::config::{Destination, DestinationMode, Preferences};
    let temp = Temp::new();
    let voice = super::super::Voice::new(temp.0.clone());
    let mut prefs: Preferences = serde_json::from_value(serde_json::json!({ "destination": "local" })).unwrap();
    voice.save_preferences(prefs.clone(), |_| Ok(())).unwrap();
    assert!(voice.destination(None).err().unwrap().contains("download"));
    prefs.selected_model = Some("handy-computer/moonshine-tiny-gguf".into());
    voice.save_preferences(prefs.clone(), |_| Ok(())).unwrap();
    assert!(voice.destination(None).err().unwrap().contains("Download"));
    prefs.destination = Destination::Mode(DestinationMode::Off);
    voice.save_preferences(prefs, |_| Ok(())).unwrap();
    assert!(voice.destination(None).err().unwrap().contains("off"));
}

#[test]
fn concurrent_preference_updates_never_lose_a_change() {
    use super::super::config::Preferences;
    let temp = Temp::new();
    let voice = super::super::Voice::new(temp.0.clone());
    let other = voice.clone();
    let mut racer = None;
    voice
        .update_preferences(|p| {
            racer = Some(std::thread::spawn(move || {
                other.update_preferences(|p| Ok(Preferences { language: "de".into(), ..p })).unwrap();
            }));
            std::thread::sleep(Duration::from_millis(200));
            Ok(Preferences { selected_model: Some("test/one".into()), ..p })
        })
        .unwrap();
    racer.unwrap().join().unwrap();
    let prefs = voice.preferences().unwrap();
    assert_eq!((prefs.selected_model.as_deref(), prefs.language.as_str()), (Some("test/one"), "de"));
}

#[test]
fn saved_unload_preference_applies_at_startup() {
    use super::super::config::{Preferences, UnloadAfter};
    let temp = Temp::new();
    let voice = super::super::Voice::new(temp.0.clone());
    assert_eq!(*voice.local.idle_after.lock().unwrap(), Some(Duration::from_secs(15 * 60)));
    let prefs = Preferences { unload_after: UnloadAfter::Immediately, ..voice.preferences().unwrap() };
    voice.save_preferences(prefs, |_| Ok(())).unwrap();
    let restarted = super::super::Voice::new(temp.0.clone());
    assert_eq!(*restarted.local.idle_after.lock().unwrap(), None);
}

#[test]
fn preference_patches_merge_without_undoing_native_changes() {
    use super::super::config::{Preferences, ShortcutMode};
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    install_one(&local, &body);
    let voice = voice_with(&temp.0, local);
    voice.patch_preferences(patch(serde_json::json!({ "deviceName": "USB Mic" }))).unwrap();
    // A native auto-select lands after the UI last read its preferences.
    voice.update_preferences(|p| Ok(Preferences { selected_model: Some("test/one".into()), ..p })).unwrap();
    let merged = voice.patch_preferences(patch(serde_json::json!({ "language": "de", "shortcutMode": "hold" }))).unwrap();
    assert_eq!(merged.selected_model.as_deref(), Some("test/one"), "absent fields keep the stored value");
    assert_eq!((merged.language.as_str(), merged.shortcut_mode), ("de", ShortcutMode::Hold));
    assert_eq!(merged.device_name.as_deref(), Some("USB Mic"));
    assert_eq!(voice.preferences().unwrap(), merged);
    // `null` clears a nullable field; other fields stay.
    let cleared = voice.patch_preferences(patch(serde_json::json!({ "deviceName": null }))).unwrap();
    assert_eq!((cleared.device_name, cleared.selected_model.as_deref()), (None, Some("test/one")));
    // Unknown fields and invalid values are refused without writing.
    assert!(serde_json::from_value::<super::super::config::PreferencesPatch>(serde_json::json!({ "bogus": 1 })).is_err());
    assert!(voice.patch_preferences(patch(serde_json::json!({ "language": "no way" }))).is_err());
    assert_eq!(voice.preferences().unwrap().language, "de");
}

#[test]
fn patched_model_selections_must_be_installed() {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    let voice = voice_with(&temp.0, local.clone());
    // In the catalog but not downloaded (e.g. deleted while Settings held a stale copy).
    let error = voice.patch_preferences(patch(serde_json::json!({ "selectedModel": "test/one" }))).unwrap_err();
    assert!(error.contains("Download"), "{error}");
    assert!(voice.patch_preferences(patch(serde_json::json!({ "selectedModel": "test/none" }))).is_err());
    assert_eq!(voice.preferences().unwrap().selected_model, None);
    install_one(&local, &body);
    let chosen = voice.patch_preferences(patch(serde_json::json!({ "selectedModel": "test/one" }))).unwrap();
    assert_eq!(chosen.selected_model.as_deref(), Some("test/one"));
    let none = voice.patch_preferences(patch(serde_json::json!({ "selectedModel": null }))).unwrap();
    assert_eq!(none.selected_model, None);
    let again = voice.patch_preferences(patch(serde_json::json!({ "selectedModel": "test/one" }))).unwrap();
    assert_eq!(again.selected_model.as_deref(), Some("test/one"));
}
