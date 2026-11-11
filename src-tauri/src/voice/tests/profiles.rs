use super::*;

#[test]
fn voice_profiles_preserve_selection_bind_keys_and_snapshot() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let saved = voice
        .save_profile(input(
            None,
            "http://127.0.0.1:8080/inference",
            Some("private-test-token"),
        ))
        .unwrap();
    assert!(json(&saved)["selectedProfileId"].is_null());
    assert_eq!(json(&saved)["profiles"][0]["hasKey"], true);
    assert!(!json(&saved).to_string().contains("private-test-token"));
    let disk = std::fs::read_to_string(dir.0.join("voice-profiles.json")).unwrap();
    assert!(!disk.contains("private-test-token"));
    let id = profile_id(&saved);
    voice.select_profile(Some(id.clone())).unwrap();
    let snapshot = voice.snapshot(&id).unwrap();
    let same = voice
        .save_profile(input(Some(id.clone()), &snapshot.endpoint, None))
        .unwrap();
    assert_eq!(json(&same)["profiles"][0]["hasKey"], true);
    assert_eq!(json(&same)["selectedProfileId"], id);
    let changed = voice
        .save_profile(input(
            Some(id.clone()),
            "http://127.0.0.1:8080/another-route",
            None,
        ))
        .unwrap();
    assert_eq!(json(&changed)["profiles"][0]["hasKey"], false);
    assert!(voice.snapshot(&id).unwrap().key.is_none());
    assert_eq!(snapshot.key.as_deref(), Some("private-test-token"));
    assert_eq!(snapshot.endpoint, "http://127.0.0.1:8080/inference");
    assert_eq!(
        json(voice.delete_profile(&id).unwrap())["selectedProfileId"],
        serde_json::Value::Null
    );
    assert!(voice.snapshot(&id).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The last deletion removes the default file; use a new profile to check atomic writer permissions.
        voice
            .save_profile(input(None, "http://127.0.0.1:8080/stt", None))
            .unwrap();
        assert_eq!(
            std::fs::metadata(dir.0.join("voice-profiles.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn voice_profiles_validate_without_overwriting_bad_config() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    for bad in [
        "http://example.com/stt",
        "https://a.example/stt?secret=oops",
    ] {
        assert!(voice.save_profile(input(None, bad, None)).is_err());
    }
    assert!(voice
        .save_profile(input(
            None,
            "https://example.com/stt",
            Some("token\ninjection")
        ))
        .is_err());
    assert!(voice.select_profile(Some("missing".into())).is_err());
    assert!(voice.delete_profile("missing").is_err());
    let file = dir.0.join("voice-profiles.json");
    std::fs::write(&file, b"corrupt").unwrap();
    assert!(voice
        .save_profile(input(None, "http://127.0.0.1:8080/stt", None))
        .is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"corrupt");
}

#[test]
fn voice_credentials_do_not_follow_endpoint_edits_on_disk() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let saved = voice
        .save_profile(input(
            None,
            "https://example.com/transcribe",
            Some("private-test-token"),
        ))
        .unwrap();
    let id = profile_id(&saved);
    let path = dir.0.join("voice-profiles.json");
    let mut stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    stored["profiles"][0]["endpoint"] = "https://another.example/transcribe".into();
    std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(
        json(voice.configuration().unwrap())["profiles"][0]["hasKey"],
        false
    );
    assert!(voice.snapshot(&id).is_err());
}
