use super::*;

#[tokio::test]
async fn download_installs_privately_and_never_refetches() {
    let (body, item) = fake_model();
    let server = mock(body.clone(), Mode::Normal).await;
    let temp = Temp::new();
    let store = store(&temp.0, &server.base);
    let path = store.fetch(&item, &active()).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), body);
    assert!(store.installed(&item));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(temp.0.join("model.gguf.verified").exists());
    assert_eq!(server.requests.lock().unwrap().clone(), vec![format!("/test/model/resolve/{REV}/model.gguf None")]);
    store.fetch(&item, &active()).await.unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 1, "a verified file is not downloaded again");
    // A changed file loses its marker match and is no longer installed. The tamper keeps
    // the size and inode, so only the mtime can tell; coarse filesystem timestamps can
    // leave it unchanged after a quick rewrite, so the test moves it explicitly.
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, vec![0u8; body.len()]).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_modified(before + std::time::Duration::from_secs(60)).unwrap();
    drop(file);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), item.size, "the tamper keeps the size");
    assert!(!store.installed(&item));
    store.delete(&item).unwrap();
    assert!(!path.exists() && !temp.0.join("model.gguf.verified").exists());
}

#[tokio::test]
async fn download_resumes_with_an_exact_range() {
    let (body, item) = fake_model();
    let server = mock(body.clone(), Mode::Normal).await;
    let temp = Temp::new();
    std::fs::write(temp.0.join("model.gguf.part"), &body[..1000]).unwrap();
    let store = store(&temp.0, &server.base);
    assert_eq!(store.partial(&item), 1000);
    let path = store.fetch(&item, &active()).await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), body);
    assert!(server.requests.lock().unwrap()[0].ends_with("Some(1000)"));
}

#[tokio::test]
async fn download_restarts_when_the_server_ignores_or_misreports_the_range() {
    for mode in [Mode::IgnoreRange, Mode::WrongRange] {
        let (body, item) = fake_model();
        let server = mock(body.clone(), mode).await;
        let temp = Temp::new();
        std::fs::write(temp.0.join("model.gguf.part"), vec![9u8; 1000]).unwrap();
        let store = store(&temp.0, &server.base);
        let path = store.fetch(&item, &active()).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), body, "mode restart must not keep stale bytes");
    }
}

#[tokio::test]
async fn download_follows_allowed_redirects_only() {
    let (body, item) = fake_model();
    let server = mock(body.clone(), Mode::RedirectSameHost).await;
    let temp = Temp::new();
    store(&temp.0, &server.base).fetch(&item, &active()).await.unwrap();
    assert!(server.requests.lock().unwrap()[1].starts_with("/moved/"));

    let server = mock(body, Mode::RedirectAway).await;
    let temp = Temp::new();
    let error = store(&temp.0, &server.base).fetch(&item, &active()).await.unwrap_err();
    assert!(error.contains("redirected"), "{error}");
    assert!(!temp.0.join("model.gguf").exists());
}

#[tokio::test]
async fn download_rejects_a_bad_checksum_and_low_disk_space() {
    let (body, mut item) = fake_model();
    let server = mock(body, Mode::Normal).await;
    let temp = Temp::new();
    let good = item.sha256.clone();
    item.sha256 = "0".repeat(64);
    let error = store(&temp.0, &server.base).fetch(&item, &active()).await.unwrap_err();
    assert!(error.contains("checksum"), "{error}");
    assert!(!temp.0.join("model.gguf").exists() && !temp.0.join("model.gguf.part").exists());

    item.sha256 = good;
    let before = server.requests.lock().unwrap().len();
    let tight = Store::for_test(&temp.0, server.base.clone(), Box::new(|_| Ok(10 * 1024 * 1024)));
    let error = tight.fetch(&item, &active()).await.unwrap_err();
    assert!(error.contains("disk space"), "{error}");
    assert_eq!(server.requests.lock().unwrap().len(), before, "no request without room");
}

#[tokio::test]
async fn cancelled_download_keeps_its_part_and_resumes() {
    let (body, item) = fake_model();
    let server = mock(body.clone(), Mode::Stall).await;
    let temp = Temp::new();
    let store = Arc::new(store(&temp.0, &server.base));
    let slot = store.begin("test/model").unwrap();
    assert!(store.begin("other").is_err(), "one download at a time");
    let active = slot.active.clone();
    let task = {
        let (store, item, active) = (store.clone(), item.clone(), active.clone());
        tokio::spawn(async move { store.fetch(&item, &active).await })
    };
    while active.downloaded.load(Ordering::Acquire) < 1000 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    active.cancel.store(true, Ordering::Release);
    let error = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error, super::super::super::CANCELLED);
    assert_eq!(store.partial(&item), 1000);
    drop(slot);

    let server = mock(body.clone(), Mode::Normal).await;
    let store = self::store(&temp.0, &server.base);
    let path = store.fetch(&item, &active_fresh()).await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), body);
    assert!(server.requests.lock().unwrap()[0].ends_with("Some(1000)"));
}

fn active_fresh() -> Active {
    active()
}

#[test]
fn production_downloads_are_huggingface_https_only() {
    let temp = Temp::new();
    let store = Store::new(&temp.0);
    assert_eq!(store.path("m.gguf"), temp.0.join("speech").join("models").join("m.gguf"));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (_, mut item) = fake_model();
    item.filename = "../x.gguf".into();
    assert!(rt.block_on(store.fetch(&item, &active())).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn first_download_selects_before_installed_and_reports_the_vad_separately() {
    let (body, _) = fake_model();
    let server = mock(body.clone(), Mode::StallVad).await;
    let temp = Temp::new();
    let local = local_with(&temp.0, &server.base, &body);
    let selected = Arc::new(AtomicBool::new(false));
    let events: Arc<Mutex<Vec<(&'static str, bool)>>> = Arc::default();
    let emit: super::super::Emit = {
        let (events, selected) = (events.clone(), selected.clone());
        Arc::new(move |e: super::super::ModelEvent| {
            assert_eq!(e.model_id, "test/one");
            events.lock().unwrap().push((e.state, selected.load(Ordering::Acquire)));
        })
    };
    let task = {
        let (local, selected) = (local.clone(), selected.clone());
        tokio::spawn(async move { local.download("test/one", emit, move || selected.store(true, Ordering::Release)).await })
    };
    // The VAD stalls after 1000 bytes: it is reported on its own, the model stays installed.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let v = view(&local);
        if v["vad"]["state"] == "downloading" && v["vad"]["downloaded"] == 1000 {
            assert_eq!(v["models"][0]["state"], "installed");
            assert!(v["models"][0].get("downloaded").is_none());
            assert_eq!(v["vad"]["size"], body.len());
            break;
        }
        assert!(std::time::Instant::now() < deadline, "VAD never reported: {v}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!task.is_finished(), "download resolves only after the VAD settles");
    assert!(selected.load(Ordering::Acquire));
    let seen = events.lock().unwrap().clone();
    let installed = seen.iter().position(|e| e.0 == "installed").expect("installed event");
    assert!(seen[installed].1, "selection is saved before `installed` is emitted");
    assert_eq!(installed, seen.len() - 1, "no model events after installed: {seen:?}");
    local.shutdown();
    let path = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();
    assert!(path.ends_with("one.gguf"));
    assert_eq!(events.lock().unwrap().len(), seen.len());
    let v = view(&local);
    assert_eq!((v["vad"]["state"].as_str(), v["vad"]["downloaded"].as_u64()), (Some("downloadable"), Some(1000)));
}

#[test]
fn delete_refuses_a_model_the_live_capture_is_routed_to() {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    let path = local.store.path("one.gguf");
    std::fs::write(&path, &body).unwrap();
    let error = local.delete("test/one", Some(path.as_path()), None).unwrap_err();
    assert!(error.contains("dictation"), "{error}");
    assert!(path.exists());
    // A dictation routed to another model does not block deleting.
    local.delete("test/one", Some(Path::new("/models/other.gguf")), None).unwrap();
    assert!(!path.exists());
}

#[test]
fn partial_downloads_report_resumable_bytes() {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    std::fs::write(local.store.path("one.gguf.part"), &body[..1234]).unwrap();
    std::fs::write(local.store.path("vad.gguf.part"), &body[..99]).unwrap();
    let v = view(&local);
    assert_eq!((v["models"][0]["state"].as_str(), v["models"][0]["downloaded"].as_u64()), (Some("downloadable"), Some(1234)));
    assert_eq!((v["vad"]["state"].as_str(), v["vad"]["downloaded"].as_u64()), (Some("downloadable"), Some(99)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_refuses_a_model_a_starting_dictation_is_routed_to() {
    use super::super::config::Preferences;
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    let path = local.store.path("one.gguf");
    install_one(&local, &body);
    let voice = voice_with(&temp.0, local.clone());
    // Resolved from a local selection that Settings has since changed (destination is now off).
    let prefs = Preferences { selected_model: Some("test/one".into()), ..voice.preferences().unwrap() };
    let target = super::super::super::Target {
        remote: super::super::config::Snapshot { endpoint: String::new(), model: String::new(), language: None, key: None },
        route: Some(local.route_for(&prefs).unwrap()),
    };
    let starter = {
        let voice = voice.clone();
        tokio::spawn(async move {
            voice.start_with("r16".into(), target, std::future::pending(), |_| Err(std::io::Error::other("no device"))).await
        })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while voice.session.lock().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "session never reserved");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let deleting = voice.clone();
    let error = tokio::task::spawn_blocking(move || deleting.delete_local_model("test/one")).await.unwrap().unwrap_err();
    assert!(error.contains("dictation"), "{error}");
    assert!(path.exists());
    let cancelling = voice.clone();
    tokio::task::spawn_blocking(move || cancelling.cancel(None, None, Some("r16"))).await.unwrap().unwrap();
    assert!(starter.await.unwrap().is_err());
    let deleting = voice.clone();
    tokio::task::spawn_blocking(move || deleting.delete_local_model("test/one")).await.unwrap().unwrap();
    assert!(!path.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_the_model_also_cancels_its_silence_filter_download() {
    let (body, _) = fake_model();
    let server = mock(body.clone(), Mode::StallVad).await;
    let temp = Temp::new();
    let local = local_with(&temp.0, &server.base, &body);
    let task = {
        let local = local.clone();
        tokio::spawn(async move { local.download("test/one", Arc::new(|_| {}), || {}).await })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while view(&local)["vad"]["downloaded"] != 1000 {
        assert!(std::time::Instant::now() < deadline, "VAD never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The UI only knows the model id; the slot now carries the VAD.
    local.cancel_download("test/other");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!task.is_finished(), "a cancel for another model leaves it alone");
    local.cancel_download("test/one");
    let path = tokio::time::timeout(Duration::from_secs(5), task).await.expect("cancel reaches the VAD").unwrap().unwrap();
    assert!(path.ends_with("one.gguf"), "the installed model stays installed");
    let v = view(&local);
    assert_eq!(v["models"][0]["state"], "installed");
    assert_eq!((v["vad"]["state"].as_str(), v["vad"]["downloaded"].as_u64()), (Some("downloadable"), Some(1000)));
}
