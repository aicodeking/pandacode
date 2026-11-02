//! The viewer's start path against the host's real `task.start`, `task.startStatus` and
//! `task.cancelStart` logic, each on its own in-memory `Store`, with JSON parsed as the wire
//! delivers it (docs/machine-orchestration.md). Frames pass by function call: there is no
//! `tauri::AppHandle` here, so sockets, emitted events, subscribe rounds and the git steps of a
//! start are not run. `remote::bench::live_two_computers` covers those on real computers.
use super::config::{Access, Link};
use super::mirror::{self, AfterStart, Cancel, Launch, Reconcile, StartState};
use super::{client, crypto, host, orchestrate, start, tests::device, Inner};
use crate::storage::Store;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

const VIEWER: &str = "me";

struct Viewer {
    store: Store,
    inner: Inner,
    project: String,
    parent: String,
}

fn viewer() -> Viewer {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap().id;
    let parent = store.create_session(&project, "claude", "sonnet", "full").unwrap().id;
    let key = crypto::public_key(&crypto::generate());
    let mut inner = Inner { devices: vec![device(VIEWER, "This Mac", &key), device("studio", "ProMini", &key)], token: Some("t".into()), ..Default::default() };
    inner.settings.device_id = VIEWER.into();
    inner.settings.orchestration = true;
    inner.settings.links.insert("studio".into(), Link { access: Access::Ask, at: 1, key, name: String::new() });
    Viewer { store, inner, project, parent }
}

/// `mirror::commit` from its row on: the mirror, the child and the `task.start` params.
fn launch(viewer: &mut Viewer) -> (String, Value) {
    let mut request = Launch { device: "studio".into(), project_id: viewer.project.clone(), prompt: "Run the tests".into(), provider: "codex".into(), model: "default".into(), worktree: true, parent: Some(viewer.parent.clone()), title: Some("Linux tests".into()), ..Default::default() };
    let (local, created, start_id) = mirror::commit_row(&mut viewer.inner, &viewer.store, &mut request, &Arc::new(Notify::new())).unwrap();
    assert!(created);
    assert_eq!(start_id.as_deref(), Some(local.as_str()), "a machine thread's start goes by its own id");
    (local.clone(), mirror::start_body(request, "orbit-labs/orbit", Some("main"), Some(&local), &[]))
}

struct HostComputer {
    store: Arc<Mutex<Store>>,
    project: String,
}

fn host_computer() -> HostComputer {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap().id;
    HostComputer { store: Arc::new(Mutex::new(store)), project }
}

impl HostComputer {
    fn tasks(&self) -> i64 {
        self.store.lock().unwrap().db.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap()
    }

    /// Ends the host task's turn with a final reply.
    fn run_ends(&self, session: &str, reply: &str) {
        let store = self.store.lock().unwrap();
        store.message(session, "assistant", reply).unwrap();
        store.finish_task_turn(session, true, false).unwrap();
    }
}

/// Where a start waits for the test, to see what the viewer does meanwhile.
#[derive(Clone, Copy, PartialEq)]
enum At {
    /// Still cloning: a cancel stops it.
    BeforeCommit,
    /// Committed to making its task: a cancel is too late.
    AfterCommit,
}

struct Gate {
    at: At,
    reached: Notify,
    open: Notify,
}

impl Gate {
    fn new(at: At) -> Arc<Self> {
        Arc::new(Self { at, reached: Notify::new(), open: Notify::new() })
    }

    async fn pass(&self, at: At) {
        if self.at == at {
            self.reached.notify_one();
            self.open.notified().await;
        }
    }
}

/// `task.start` on the host: parsed from the wire params and run once per `startId`. What
/// `start::run_cancellable` does between its checks (finding, cloning, git) is what's left out.
fn task_start(computer: &HostComputer, params: &Value, gate: Option<Arc<Gate>>) -> tokio::task::JoinHandle<crate::Result<Value>> {
    let host::Call::Start(request) = host::parse(true, "task.start", params).unwrap() else { panic!("not a start") };
    let (store, project) = (computer.store.clone(), computer.project.clone());
    let id = request.start_id.clone().expect("a start id");
    tokio::spawn(async move {
        host::start_keyed(VIEWER, &id, move |cancel| async move {
            if let Some(gate) = &gate {
                gate.pass(At::BeforeCommit).await;
            }
            cancel.commit()?;
            if let Some(gate) = &gate {
                gate.pass(At::AfterCommit).await;
            }
            let store = store.lock().map_err(|e| e.to_string())?;
            let task = start::create_task(&store, &project, &request)?;
            store.begin_task_turn(&task.id, &request.prompt)?;
            Ok(json!({"sessionId": task.id}))
        })
        .await
    })
}

/// A `task.messages` request through the host's parser and pages, into the viewer's copy.
fn copy_messages(viewer: &Viewer, computer: &HostComputer, session: &str, local: &str) {
    let params = json!({"sessionId": session, "tail": true, "limit": mirror::TAIL_PAGE, "budget": mirror::TAIL_BUDGET});
    let host::Call::Messages { session_id, page, budget } = host::parse(true, "task.messages", &params).unwrap() else { panic!("not a page") };
    let rows = host::read_page(&computer.store.lock().unwrap().db, &session_id, page).unwrap();
    mirror::store_first(&viewer.store, local, 0, &host::fit_page(rows, budget)).unwrap();
}

fn status(store: &Store, id: &str) -> String {
    store.session(id).unwrap().status
}

fn linked_session(viewer: &mut Viewer, local: &str, reply: crate::Result<Value>) -> (String, bool) {
    let started = reply.and_then(|reply| mirror::started_session(&reply));
    match mirror::after_start(&mut viewer.inner.viewer, local, true, started) {
        AfterStart::Link { session, stop_now } => {
            mirror::link(&viewer.store, local, &session).unwrap();
            (session, stop_now)
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_launch_makes_the_host_task_and_its_end_wakes_the_parent() {
    let (mut viewer, computer) = (viewer(), host_computer());
    let (local, params) = launch(&mut viewer);
    assert_eq!(status(&viewer.store, &local), "running");
    assert!(mirror::of(&viewer.store, &local).unwrap_err().contains("still starting"));

    let reply = task_start(&computer, &params, None).await.unwrap();
    let (session, stop_now) = linked_session(&mut viewer, &local, reply);
    assert!(!stop_now);
    assert!(!viewer.inner.viewer.starts.contains_key(&local));
    assert_eq!(mirror::of(&viewer.store, &local).unwrap().unwrap().session, session);
    {
        let store = computer.store.lock().unwrap();
        let task = store.session(&session).unwrap();
        assert_eq!((task.provider.as_str(), task.mode.as_str(), task.status.as_str()), ("codex", "ask", "running"), "a full parent over an ask link gets an ask thread");
        assert!(store.messages(&session, None).unwrap().iter().any(|m| m.content == "Run the tests"));
    }
    assert_eq!(orchestrate::claim(&viewer.store, &viewer.parent).unwrap(), None, "its thread still runs");

    computer.run_ends(&session, "All green.");
    let ended = computer.store.lock().unwrap().session(&session).unwrap().status;
    assert_eq!(mirror::reconcile("running", &ended), Reconcile::Ended { successful: true, stopped: false }, "a subscribe's snapshot ends it as `run.finished` does");
    copy_messages(&viewer, &computer, &session, &local);
    assert!(mirror::finish_once(&viewer.store, &local, true, false).unwrap());
    assert!(!mirror::finish_once(&viewer.store, &local, true, false).unwrap(), "ended once");

    let (message, ids) = orchestrate::claim(&viewer.store, &viewer.parent).unwrap().expect("the parent's wake is due");
    assert_eq!(ids, vec![local]);
    assert!(message.contains("\"Linux tests\"") && message.contains("All green."), "{message}");
    viewer.store.begin_task_turn_reporting(&viewer.parent, &message, Some(crate::architect::internal_turns::CoordinationKind::MachineThreads), &ids).unwrap();
    viewer.store.finish_task_turn(&viewer.parent, true, false).unwrap();
    assert_eq!(orchestrate::claim(&viewer.store, &viewer.parent).unwrap(), None, "reported once");
}

/// `cancel_start`'s first half: marked cancelling, the thread's turn ends here at once.
fn stop_starting(viewer: &mut Viewer, local: &str) {
    viewer.inner.viewer.starts.get_mut(local).unwrap().cancelling = true;
    assert!(mirror::finish_once(&viewer.store, local, false, true).unwrap());
    assert_eq!(status(&viewer.store, local), "interrupted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_while_cloning_cancels_the_start_and_leaves_the_thread_stopped() {
    let (mut viewer, computer) = (viewer(), host_computer());
    let (local, params) = launch(&mut viewer);
    let gate = Gate::new(At::BeforeCommit);
    let running = task_start(&computer, &params, Some(gate.clone()));
    // The host saw the start before it hears of the stop.
    gate.reached.notified().await;
    stop_starting(&mut viewer, &local);
    let reply = host::cancel_start_of(VIEWER, &local);
    assert_eq!(mirror::cancel_outcome(&reply), Cancel::Cancelled);
    assert_eq!(mirror::record_not_started(&viewer.store, &local, start::CANCELLED), Ok(false));
    gate.open.notify_one();
    assert_eq!(running.await.unwrap(), Err(start::CANCELLED.to_string()), "its caller hears at once");
    assert_eq!(computer.tasks(), 0, "the host never made a task");
    assert_eq!(status(&viewer.store, &local), "interrupted", "stopped, not an error or deleted");
    assert_eq!(host::start_status_of(VIEWER, &local)["state"], "failed");
    // Its late reply changes nothing.
    assert!(matches!(mirror::after_start(&mut viewer.inner.viewer, &local, true, Err(start::CANCELLED.to_string())), AfterStart::Failed(_)));
    assert_eq!(mirror::record_not_started(&viewer.store, &local, start::CANCELLED), Ok(false));
    assert!(viewer.store.messages(&local, None).unwrap().is_empty(), "no error reply");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_too_late_to_cancel_links_the_task_and_stops_it_there() {
    let (mut viewer, computer) = (viewer(), host_computer());
    let (local, params) = launch(&mut viewer);
    let gate = Gate::new(At::AfterCommit);
    let making = task_start(&computer, &params, Some(gate.clone()));
    gate.reached.notified().await;
    // Past the host's commit, a cancel is refused: `pending` until the task exists.
    assert_eq!(mirror::cancel_outcome(&host::cancel_start_of(VIEWER, &local)), Cancel::TooLate);
    stop_starting(&mut viewer, &local);
    gate.open.notify_one();
    let (session, stop_now) = linked_session(&mut viewer, &local, making.await.unwrap());
    assert!(stop_now, "whoever links it stops it there");
    assert_eq!(computer.tasks(), 1);
    assert_eq!(mirror::of(&viewer.store, &local).unwrap().unwrap().session, session);
    // Past the start's end, a cancel names the task.
    assert_eq!(mirror::cancel_outcome(&host::cancel_start_of(VIEWER, &local)), Cancel::Started(session));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_reply_is_recovered_by_asking_how_the_start_went() {
    let (mut viewer, computer) = (viewer(), host_computer());
    let (local, params) = launch(&mut viewer);
    let gate = Gate::new(At::AfterCommit);
    let running = task_start(&computer, &params, Some(gate.clone()));
    // The call times out here; the host goes on.
    let lost = mirror::after_start(&mut viewer.inner.viewer, &local, true, Err(client::TIMED_OUT.to_string()));
    assert_eq!(lost, AfterStart::Lost(Some(local.clone())));
    assert!(!viewer.inner.viewer.starts[&local].busy, "the next subscribe round may ask");
    assert_eq!(status(&viewer.store, &local), "running");
    gate.reached.notified().await;
    assert_eq!(mirror::start_state(&Ok(host::start_status_of(VIEWER, &local))), StartState::Running);
    assert_eq!(host::start_status_of("another-device", &local)["state"], "unknown", "only the device that asked");
    gate.open.notify_one();
    let session = running.await.unwrap().unwrap()["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(mirror::start_state(&Ok(host::start_status_of(VIEWER, &local))), StartState::Done(session.clone(), None));
    // A repeated `task.start` under that id returns the same task and makes no other.
    assert_eq!(task_start(&computer, &params, None).await.unwrap().unwrap()["sessionId"], session.as_str());
    assert_eq!(computer.tasks(), 1);
    viewer.inner.viewer.starts.remove(&local);
    mirror::link(&viewer.store, &local, &session).unwrap();
    assert_eq!(mirror::of(&viewer.store, &local).unwrap().unwrap().session, session);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_the_host_lost_fails_the_thread_and_reports_it() {
    let mut viewer = viewer();
    let (local, _) = launch(&mut viewer);
    // The host restarted and never heard of it; it asks for an id it has no record of.
    let state = mirror::start_state(&Ok(host::start_status_of(VIEWER, &local)));
    let StartState::Failed(error) = state else { panic!("{state:?}") };
    assert_eq!(mirror::record_not_started(&viewer.store, &local, &error), Ok(false));
    assert_eq!(status(&viewer.store, &local), "error");
    let (message, ids) = orchestrate::claim(&viewer.store, &viewer.parent).unwrap().expect("reported like one that finished");
    assert_eq!(ids, vec![local]);
    assert!(message.contains("could not start on the other computer"), "{message}");
    // An unreachable host is not a failure: it is asked again when it is back.
    assert_eq!(mirror::start_state(&Err(super::socket::OFFLINE.to_string())), StartState::Unreachable);
}
