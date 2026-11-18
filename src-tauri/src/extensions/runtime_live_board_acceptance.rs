// R1201: native acceptance of the Work board (sample.live-board, cut A) with the canonical B1 fake daemon and the B2 fake
// command-line tool, run by the pinned runtime. This file has no module of its own: `runtime_service_lifetime.rs`
// pastes it with `include!` at the end of its `installed` test module, so it shares that module's B1 driver, process
// helpers and constants. It is compiled only with the `extension-runtime-native-tests` feature, like its neighbours.
// Written for the final test phase; not run when written.
//
// What it proves, on the shipped package (examples/extensions/live-board/package):
//  - a B1 change (made by B2, by a control call, or announced by a signal) moves the ready count of the status item and
//    the rows of the dynamic table within 2 s;
//  - a fault turns the status item to "Tracker offline", keeps the last rows (a stale table, never an empty one) and
//    registers the Retry button; a Retry click reaches the service, and the button leaves once the daemon answers;
//  - a dialog answer reaches the service's state, and a cancelled one changes nothing;
//  - safe mode, disable, a crash (backoff, five in ten minutes park it), retry and quit each end or restart the service
//    and leave no live item behind.
// Settings changes and task/project switches are workspace events: R0202 proves their delivery natively and the preview
// spec of this task proves how the board reacts to them.

const BOARD_MANIFEST: &str = include_str!("../../../examples/extensions/live-board/package/extension.json");
const BOARD_MAIN: &str = include_str!("../../../examples/extensions/live-board/package/main.cjs");
const BOARD_LOGIC: &str = include_str!("../../../examples/extensions/live-board/package/lib/board.mjs");
/// The board's rich view folder (`rich.folder: "panel"`): a served panel folder must be in the archive.
const BOARD_PANEL_HTML: &str = include_str!("../../../examples/extensions/live-board/package/panel/index.html");
const BOARD_PANEL_JS: &str = include_str!("../../../examples/extensions/live-board/package/panel/app.js");
/// A wrapper that adds one crash command and then runs the shipped main.cjs from the folder `real`.
const BOARD_CRASH_WRAPPER: &str = include_str!("../../../tests/fixtures/extensions/example-live-board/main.cjs");
const BOARD_ID: &str = "sample.live-board";
const BOARD_STATUS: &str = "sample.live-board/ready";
const BOARD_VIEW: &str = "sample.live-board/board";
const BOARD_RETRY_ITEM: &str = "sample.live-board/retry-button";
const BOARD_RETRY: &str = "sample.live-board/retry";
const BOARD_CRASH: &str = "sample.live-board/crash";

fn board_archive(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, text) in entries {
        writer.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
        writer.write_all(text.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn board_shipped_archive() -> Vec<u8> { board_archive(&[("extension.json", BOARD_MANIFEST), ("main.cjs", BOARD_MAIN), ("lib/board.mjs", BOARD_LOGIC), ("panel/index.html", BOARD_PANEL_HTML), ("panel/app.js", BOARD_PANEL_JS)]) }
fn board_crashable_archive() -> Vec<u8> {
    let mut manifest: Value = serde_json::from_str(BOARD_MANIFEST).unwrap();
    manifest["runtime"]["files"] = json!(["real"]);
    manifest["contributes"]["commands"].as_array_mut().unwrap().push(json!({"id": BOARD_CRASH, "title": "Crash for the test", "action": {"kind": "runCommand"}}));
    board_archive(&[("extension.json", &manifest.to_string()), ("main.cjs", BOARD_CRASH_WRAPPER), ("real/main.cjs", BOARD_MAIN), ("real/lib/board.mjs", BOARD_LOGIC), ("panel/index.html", BOARD_PANEL_HTML), ("panel/app.js", BOARD_PANEL_JS)])
}

/// The host side of the board's requests: live items and dialogs. Settings and notices answer `UnsupportedCapability`, which
/// the board survives (it keeps its defaults and the address B1 handed in).
fn board_dispatch(items: &Arc<crate::extensions::runtime_dynamic_items::DynamicItems>, slots: &Arc<crate::extensions::runtime_dialog_navigation::DialogSlots>) -> Dispatch {
    use crate::extensions::runtime_dynamic_items::{failure, now_millis, serve, Checks};
    let manifest: Value = serde_json::from_str(BOARD_MANIFEST).unwrap();
    let (items, slots) = (items.clone(), slots.clone());
    Arc::new(move |request: DispatchRequest| {
        let (items, slots, manifest) = (items.clone(), slots.clone(), manifest.clone());
        Box::pin(async move {
            match request.method.as_str() {
                "ui" => {
                    let checks = Checks { granted: true, manifest: &manifest, scope_exists: &|_| true, version: "1.0.0", now_ms: now_millis() };
                    serve(&items, &request.owner, &checks, &request.params)
                }
                "uiDialog" => match slots.begin(&request.owner, request.params.clone()) {
                    Ok((_, answer)) => json!({"ok": true, "value": answer.await.unwrap_or_else(|_| json!({"status": "cancelled"}))}),
                    Err(code) => failure(code),
                },
                _ => failure("UnsupportedCapability"),
            }
        }) as Pin<Box<dyn Future<Output = Value> + Send>>
    })
}
fn board_manager(env: &[(&str, &str)], items: &Arc<crate::extensions::runtime_dynamic_items::DynamicItems>, slots: &Arc<crate::extensions::runtime_dialog_navigation::DialogSlots>, clock: Option<Arc<supervision::ManualClock>>) -> Arc<ServiceLifetime> {
    let mut manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(env);
    if let Some(clock) = clock { manager = manager.with_clock(clock); }
    manager.set_dispatch(board_dispatch(items, slots));
    { let (items, slots) = (items.clone(), slots.clone()); manager.set_ended_hook(Arc::new(move |owner: &str| { items.clear(owner); slots.cancel_owner(owner); })); }
    Arc::new(manager)
}
/// Installs, trusts and enables the package, then grants what its manifest declares and reconciles until it is served.
async fn board_launch(manager: &Arc<ServiceLifetime>, packages: &ExtensionPackages, grants: &RuntimeGrants, archive: &[u8]) {
    { let packages = packages.0.lock().unwrap(); packages.install(archive).unwrap(); let digest = digest(&packages); packages.trust(BOARD_ID, &digest, true).unwrap(); packages.enable(BOARD_ID, true).unwrap(); }
    { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, grants); }
    for permission in [PERMISSION, "events.workspace", "ui.dynamic", "ui.notify"] { grants.grant(BOARD_ID, permission, Scope::default()).unwrap(); }
    { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, grants); }
    let deadline = Instant::now() + Duration::from_secs(20);
    while !manager.serves(BOARD_ID, BOARD_RETRY) { assert!(Instant::now() < deadline, "the board never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }
}
/// Waits for `probe` to answer, at most `limit`: the product is told by an event, tests only look.
async fn board_until<T>(what: &str, limit: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(value) = probe() { return value; }
        assert!(Instant::now() < deadline, "timed out after {limit:?} waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn board_layer(items: &crate::extensions::runtime_dynamic_items::DynamicItems) -> Value { items.snapshot()["owners"][BOARD_ID].clone() }
fn board_status(items: &crate::extensions::runtime_dynamic_items::DynamicItems) -> String { board_layer(items)["overrides"][BOARD_STATUS]["text"].as_str().unwrap_or("").to_owned() }
fn board_rows(items: &crate::extensions::runtime_dynamic_items::DynamicItems) -> Option<usize> { board_layer(items)["overrides"][BOARD_VIEW]["controls"][0]["rows"].as_array().map(Vec::len) }
fn board_retry_buttons(items: &crate::extensions::runtime_dynamic_items::DynamicItems) -> usize {
    board_layer(items)["menus"].as_array().map_or(0, |menus| menus.iter().filter(|menu| menu["id"] == BOARD_RETRY_ITEM).count())
}
/// The service's own status line (compact JSON: ready, total, offline, retries, actor, answers, ...).
fn board_held(manager: &ServiceLifetime) -> Value {
    entry_of(manager, BOARD_ID)["status"]["text"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap_or(Value::Null)
}
/// B2: the fake command-line tool, a thin client of B1. It cancels its work when its stdin closes, so the pipe stays open.
async fn board_cli(runtime: &supervisor::Runtime, socket: &str, args: &[&str]) -> Value {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/backends/fake-cli/fake-cli.mjs");
    let mut child = tokio::process::Command::new(&runtime.binary).arg(script).args(["--daemon", socket, "--json"]).args(args)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).creation_flags(0x08000000).spawn().unwrap();
    let _stdin = child.stdin.take();
    let mut text = String::new();
    child.stdout.take().unwrap().read_to_string(&mut text).await.unwrap();
    let status = child.wait().await.unwrap();
    assert!(status.success(), "B2 {args:?} failed: {text}");
    serde_json::from_str(&text).unwrap()
}

/// R1201 acceptance (service and dynamic UI): the installed board follows B1 within 2 s, shows a stale table while the
/// daemon is away, takes a Retry click and drops the button once the daemon answers, and keeps a dialog answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_board_installed_follows_b1_and_b2_retries_after_a_fault_keeps_a_stale_table_and_keeps_the_dialog_answer() {
    use crate::extensions::{runtime_dialog_navigation::DialogSlots, runtime_dynamic_items::DynamicItems};
    let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
    let b1 = B1::start(&runtime).await;
    // One ready issue and one blocked behind it, before the service exists.
    b1.http("POST", "/control/issues", &json!({"op": "add", "issue": {"id": "T-1", "title": "One"}})).await;
    b1.http("POST", "/control/issues", &json!({"op": "add", "issue": {"id": "T-2", "title": "Two", "dependsOn": ["T-1"]}})).await;
    let dir = Dir::new();
    let packages = ExtensionPackages::new(&dir.0, false);
    let grants = RuntimeGrants::open(&dir.0);
    let (items, slots) = (Arc::new(DynamicItems::default()), Arc::new(DialogSlots::default()));
    let env = [("PANDA_FIXTURE_B1", b1.socket.as_str())];
    let manager = board_manager(&env, &items, &slots, None);
    board_launch(&manager, &packages, &grants, &board_shipped_archive()).await;
    let two = Duration::from_secs(2);

    // The status item reads the daemon's own ready list; the table has one row per issue. No Retry button while it answers.
    board_until("the first snapshot", Duration::from_secs(10), || (board_status(&items) == "1 ready" && board_rows(&items) == Some(2)).then_some(())).await;
    assert_eq!(board_retry_buttons(&items), 0);
    assert_eq!(board_layer(&items)["overrides"][BOARD_STATUS]["tone"], "success");

    // B2 creates an issue: the count and the table follow within 2 s, with no click.
    let created = board_cli(&runtime, &b1.socket, &["create", "--title=Three"]).await;
    assert_eq!(created["id"], "T-3", "{created}");
    let started = Instant::now();
    board_until("B2's issue on the board", two, || (board_status(&items) == "2 ready" && board_rows(&items) == Some(3)).then_some(())).await;
    println!("LIVE_BOARD_B2_FOLLOW_MS {}", started.elapsed().as_millis());
    // A control change plus a signal that announces it: the same path through the signals topic.
    b1.http("POST", "/control/issues", &json!({"op": "update", "issue": {"id": "T-3", "status": "closed"}})).await;
    b1.order(json!({"op": "refresh"})).await;
    board_until("the closed issue leaving the ready list", two, || (board_status(&items) == "1 ready" && board_rows(&items) == Some(3)).then_some(())).await;
    board_until("the service's own ready count", two, || (board_held(&manager)["ready"] == 1).then_some(())).await;

    // The daemon goes away for a while: the last rows stay, marked stale, and the Retry button appears once.
    let fault = Instant::now();
    b1.http("POST", "/control/fault", &json!({"kind": "refuse", "ms": 2500})).await;
    board_until("the offline marking", Duration::from_secs(5), || (board_status(&items) == "Tracker offline" && board_retry_buttons(&items) == 1).then_some(())).await;
    assert_eq!(board_rows(&items), Some(3), "a stale table keeps its rows, never an empty board");
    let view = board_layer(&items)["overrides"][BOARD_VIEW].clone();
    assert!(view["text"].as_str().unwrap().starts_with("Stale: the tracker is offline (stale since "), "{view}");
    assert!(view["controls"][0]["label"].as_str().unwrap().contains("stale since"), "{view}");
    board_until("the service marking itself offline", two, || (board_held(&manager)["offline"] == true).then_some(())).await;
    // A click while it is still away reaches the service, which stays offline and keeps the button.
    let click = manager.call_command(BOARD_ID, BOARD_RETRY, json!({}), None).await.unwrap();
    assert_eq!((click["offline"].as_bool(), click["retries"].as_u64()), (Some(true), Some(1)), "{click}");
    assert_eq!(board_retry_buttons(&items), 1);
    // The daemon returns: the button leaves and the count is read again.
    board_until("the recovery", Duration::from_secs(10), || (board_retry_buttons(&items) == 0 && board_status(&items) == "1 ready").then_some(())).await;
    assert!(fault.elapsed() < Duration::from_millis(2500 + 2500), "recovery took {:?} after the fault began", fault.elapsed());
    assert_eq!(board_rows(&items), Some(3));
    let click = manager.call_command(BOARD_ID, BOARD_RETRY, json!({}), None).await.unwrap();
    assert_eq!((click["offline"].as_bool(), click["retries"].as_u64()), (Some(false), Some(2)), "{click}");
    board_until("the second retry in the service status", two, || (board_held(&manager)["retries"] == 2).then_some(())).await;

    // The dialog answer reaches the service's state; a cancelled one changes nothing.
    b1.order(json!({"op": "ask"})).await;
    board_until("the dialog", Duration::from_secs(10), || (slots.count(BOARD_ID) == 1).then_some(())).await;
    let id = slots.pending()[0]["id"].as_str().unwrap().to_owned();
    slots.answer(&id, &json!({"status": "confirmed", "values": {"actor": "Ada"}})).unwrap();
    board_until("the answer in the service", Duration::from_secs(10), || (board_held(&manager)["actor"] == "Ada").then_some(())).await;
    board_until("the actor on the status item", two, || board_layer(&items)["overrides"][BOARD_STATUS]["tooltip"].as_str().is_some_and(|tip| tip.contains("Working: Ada")).then_some(())).await;
    b1.order(json!({"op": "ask"})).await;
    board_until("the second dialog", Duration::from_secs(10), || (slots.count(BOARD_ID) == 1).then_some(())).await;
    let id = slots.pending()[0]["id"].as_str().unwrap().to_owned();
    slots.answer(&id, &json!({"status": "cancelled"})).unwrap();
    board_until("the cancelled answer", Duration::from_secs(10), || (board_held(&manager)["answers"] == 2).then_some(())).await;
    assert_eq!(board_held(&manager)["actor"], "Ada");

    // The process ends: nothing of its layer stays.
    manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
    assert_eq!(items.count(BOARD_ID), 0, "the layer ends with the process");
    b1.stop().await;
}

/// R1201 acceptance (R1/R2 lifetime): the installed board stops for safe mode and disable and comes back with a fresh layer,
/// a crash leaves no Retry button behind and the restart registers exactly one, five crashes in ten minutes park it, retry
/// starts it again, and quit ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_board_installed_stops_for_safe_mode_and_disable_restarts_after_crashes_parks_after_five_and_ends_on_quit() {
    use crate::extensions::{runtime_dialog_navigation::DialogSlots, runtime_dynamic_items::DynamicItems};
    let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
    let b1 = B1::start(&runtime).await;
    b1.http("POST", "/control/issues", &json!({"op": "add", "issue": {"id": "T-1", "title": "One"}})).await;
    let dir = Dir::new();
    let packages = Arc::new(ExtensionPackages::new(&dir.0, false));
    let grants = Arc::new(RuntimeGrants::open(&dir.0));
    let (items, slots) = (Arc::new(DynamicItems::default()), Arc::new(DialogSlots::default()));
    let clock = supervision::ManualClock::new();
    let env = [("PANDA_FIXTURE_B1", b1.socket.as_str())];
    let manager = board_manager(&env, &items, &slots, Some(clock.clone()));
    {
        let (weak, packages, grants) = (Arc::downgrade(&manager), packages.clone(), grants.clone());
        manager.set_restart_hook(Arc::new(move || if let Some(manager) = weak.upgrade() { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }));
    }
    let reconcile = || { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); };
    board_launch(&manager, &packages, &grants, &board_crashable_archive()).await;
    let limit = Duration::from_secs(10);
    board_until("the first snapshot", limit, || (board_status(&items) == "1 ready").then_some(())).await;
    let first = wait_id(&manager, BOARD_ID, "the first start", |service| service["state"] == "running" && service["status"].is_object()).await;
    assert_eq!(first["reason"], "enable");

    // Safe mode stops it and takes the layer with it; leaving safe mode starts it again with a fresh layer.
    packages.0.lock().unwrap().safe = true; reconcile();
    let stopped = wait_id(&manager, BOARD_ID, "safe mode", |service| service["state"] == "stopped" && service["stops"]["safeMode"] == 1).await;
    assert_eq!(stopped["lastStop"], json!({"reason": "safeMode", "acknowledged": true}));
    assert_eq!(items.count(BOARD_ID), 0, "safe mode leaves no live item");
    packages.0.lock().unwrap().safe = false; reconcile();
    board_until("the board after safe mode", limit, || (board_status(&items) == "1 ready").then_some(())).await;
    // Disable, then enable.
    packages.0.lock().unwrap().enable(BOARD_ID, false).unwrap(); reconcile();
    wait_id(&manager, BOARD_ID, "disable", |service| service["state"] == "stopped" && service["stops"]["disable"] == 1).await;
    assert_eq!(items.count(BOARD_ID), 0, "disable leaves no live item");
    packages.0.lock().unwrap().enable(BOARD_ID, true).unwrap(); reconcile();
    board_until("the board after enable", limit, || (board_status(&items) == "1 ready").then_some(())).await;

    // A crash while the daemon is away: the layer (and its Retry button) goes with the process, and the restart registers one.
    b1.http("POST", "/control/fault", &json!({"kind": "refuse"})).await;
    board_until("the offline marking", limit, || (board_status(&items) == "Tracker offline" && board_retry_buttons(&items) == 1).then_some(())).await;
    let crash = || async { let _ = manager.call_command(BOARD_ID, BOARD_CRASH, json!({}), None).await; };
    let before = wait_id(&manager, BOARD_ID, "a running board", |service| service["state"] == "running").await["restarts"].as_u64().unwrap();
    crash().await;
    let crashed = wait_id(&manager, BOARD_ID, "a scheduled restart", |service| service["state"] == "restarting").await;
    assert_eq!(crashed["supervision"]["backoffMs"], 1000);
    assert_eq!(items.count(BOARD_ID), 0, "a crash leaves no live item behind");
    clock.advance(Duration::from_millis(1000));
    wait_id(&manager, BOARD_ID, "the first restart", |service| service["state"] == "running" && service["restarts"] == before + 1 && service["status"].is_object()).await;
    board_until("exactly one Retry button after the restart", limit, || (board_status(&items) == "Tracker offline" && board_retry_buttons(&items) == 1).then_some(())).await;
    // The daemon comes back (reset also lifts the fault): the button leaves and the board reads it again.
    b1.http("POST", "/control/reset", &json!({})).await;
    b1.http("POST", "/control/issues", &json!({"op": "add", "issue": {"id": "T-1", "title": "One"}})).await;
    board_until("the recovery after the restart", limit, || (board_retry_buttons(&items) == 0 && board_status(&items) == "1 ready").then_some(())).await;

    // Three more crashes with doubling backoff, then the fifth in ten minutes parks the service.
    for (index, delay) in [(before + 1, 2_000u64), (before + 2, 4_000), (before + 3, 8_000)] {
        wait_id(&manager, BOARD_ID, "a running board", |service| service["state"] == "running" && service["restarts"] == index && service["status"].is_object()).await;
        crash().await;
        let crashed = wait_id(&manager, BOARD_ID, "a scheduled restart", |service| service["state"] == "restarting").await;
        assert_eq!(crashed["supervision"]["backoffMs"], delay);
        clock.advance(Duration::from_millis(delay - 1)); tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(entry_of(&manager, BOARD_ID)["state"], "restarting", "nothing starts before the backoff");
        clock.advance(Duration::from_millis(1));
    }
    wait_id(&manager, BOARD_ID, "the fourth restart", |service| service["state"] == "running" && service["restarts"] == before + 4 && service["status"].is_object()).await;
    crash().await;
    let parked = wait_id(&manager, BOARD_ID, "parking", |service| service["state"] == "parked").await;
    assert!(parked["supervision"]["parked"].as_str().unwrap().starts_with("The service of sample.live-board was parked after 5 crashes in 10 minutes"), "{parked}");
    assert_eq!(items.count(BOARD_ID), 0, "a parked service has no live item");
    // Retry starts it again with a clean history; the board reads the daemon again.
    manager.retry(BOARD_ID); reconcile();
    let retried = wait_id(&manager, BOARD_ID, "the retried start", |service| service["state"] == "running" && service["restarts"] == 0 && service["status"].is_object()).await;
    assert_eq!((retried["reason"].as_str(), retried["supervision"]["parked"].clone()), (Some("enable"), Value::Null));
    board_until("the board after retry", limit, || (board_status(&items) == "1 ready").then_some(())).await;

    // Quit ends it and its layer.
    manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
    assert_eq!(items.count(BOARD_ID), 0, "quit leaves no live item");
    b1.stop().await;
}
