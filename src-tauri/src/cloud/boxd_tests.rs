use super::*;
use crate::cloud::http::mock;
use serde_json::json;
use std::time::Instant;

/// A grpc-web reply: the messages, then an OK trailer.
fn reply(messages: &[Out]) -> Vec<u8> {
    let mut body: Vec<u8> = messages.iter().flat_map(|m| frame(&m.0)).collect();
    body.extend(trailer(0, ""));
    body
}
fn trailer(code: u32, message: &str) -> Vec<u8> {
    let text = format!("grpc-status:{code}\r\ngrpc-message:{}\r\n", message.replace(' ', "%20"));
    let mut framed = frame(text.as_bytes());
    framed[0] = 0x80;
    framed
}
fn vm(id: &str, status: &str, labelled: bool) -> Out {
    let vm = Out::default().text(1, id).text(2, &format!("pc-{id}")).text(5, status).uint(15, 2).uint(16, 8 << 30).text(42, "fra");
    if labelled { vm.entry(34, "created-by", "pandacode").entry(34, "other", "x") } else { vm.entry(34, "team", "web") }
}
fn method(request: &mock::Request) -> &str {
    request.path.rsplit('/').next().unwrap_or_default()
}

fn boxd() -> (Boxd, mock::Seen) {
    let (base, seen) = mock::serve(|request, _| -> (u16, Vec<u8>) {
        let body = &request.body;
        let id = ["vm-1", "vm-2", "vm-3", "vm-4", "vm-9", "vm-gone", "vm-new"].into_iter().find(|id| body.contains(id)).unwrap_or_default();
        let reply = match method(request) {
            "Whoami" => reply(&[Out::default().text(1, "u-1").text(5, "Michiel")]),
            "ListRegions" => reply(&[Out::default()
                .bytes(1, &Out::default().text(1, "fra").text(4, "https://fra.boxd.example:9443").text(9, "enabled").0)
                .bytes(1, &Out::default().text(1, "nyc").text(4, "https://nyc.boxd.example:9443").text(9, "available").0)]),
            "ListVms" => reply(&[Out::default().bytes(1, &vm("vm-1", "running", true).0).bytes(1, &vm("vm-2", "hibernated", true).0).bytes(1, &vm("vm-9", "running", false).0)]),
            "CreateVm" if body.contains("pc-taken\u{60}") => trailer(ALREADY_EXISTS, "name 'pc-taken' is already taken"),
            "CreateVm" => reply(&[Out::default().text(1, "vm-new").text(2, "pc-new").bytes(9, &vm("vm-new", "starting", true).0)]),
            "GetVm" => match id {
                "vm-1" | "vm-4" | "vm-new" => reply(&[vm(id, "running", true)]),
                "vm-2" => reply(&[vm(id, "hibernated", true)]),
                "vm-3" => reply(&[vm(id, "suspended", true)]),
                "vm-9" => reply(&[vm(id, "running", false)]),
                _ => trailer(NOT_FOUND, "vm not found"),
            },
            "SetAutoSuspendTimeout" | "StartVm" | "WakeVm" | "ResumeVm" | "StopVm" | "DestroyVm" => reply(&[Out::default()]),
            "SetAutoHibernateTimeout" => trailer(FAILED_PRECONDITION, "this machine can't capture its memory"),
            "Exec" if body.contains("agent-down") => trailer(UNAVAILABLE, "cannot connect to VM agent: not up yet"),
            "Exec" if body.contains("sleep") => {
                std::thread::sleep(Duration::from_secs(3));
                reply(&[Out::default().bytes(1, b"late")])
            }
            "Exec" => reply(&[Out::default().bytes(1, b"out "), Out::default().bytes(1, b"err").flag(10, true), Out::default().uint(6, 2)]),
            "FsWrite" => reply(&[Out::default().uint(1, 5)]),
            "FsRead" if body.contains("/missing") => trailer(NOT_FOUND, "not_found"),
            "FsRead" => reply(&[Out::default().bytes(2, b"hel"), Out::default().bytes(2, b"lo").flag(3, true).uint(4, 5)]),
            _ => trailer(12, "unimplemented"),
        };
        (200, reply)
    });
    (Boxd::new(Some(base), None, "k".into()), seen)
}

#[test]
fn messages_round_trip_through_the_wire_format() {
    let long = "x".repeat(300);
    let out = Out::default().text(1, &long).uint(2, 0).uint(3, 1 << 40).optional(4, 0).flag(5, true).entry(6, "a", "b").entry(6, "c", "").uint(7, (-3i64) as u64);
    let parsed = parse(&out.0).unwrap();
    assert_eq!(parsed.text(1), long);
    assert!(!parsed.has(2), "proto3 zero is left out");
    assert_eq!(parsed.int(3), 1 << 40);
    assert!(parsed.has(4) && parsed.int(4) == 0, "optional zero is written");
    assert_eq!(parsed.int(5), 1);
    assert_eq!(parsed.map(6), vec![("a".into(), "b".into()), ("c".into(), String::new())]);
    assert_eq!(parsed.int(7) as i64 as i32, -3);
    // Fixed-width fields (a region's coordinates) are skipped; a cut-off message is an error.
    let mut fixed = vec![0x31];
    fixed.extend(50.1f64.to_le_bytes());
    fixed.extend(Out::default().text(2, "after").0);
    assert_eq!(parse(&fixed).unwrap().text(2), "after");
    assert!(parse(&out.0[..out.0.len() - 3]).is_err());
}

#[test]
fn frames_split_across_reads_and_trailers_carry_the_status() {
    let mut body = reply(&[Out::default().text(1, "a"), Out::default().text(1, "b")]);
    let mut frames = Frames::default();
    for byte in body.drain(..) {
        frames.push(&[byte]);
    }
    assert_eq!(frames.finish().unwrap().len(), 2);
    let mut refused = Frames::default();
    refused.push(&trailer(UNAUTHENTICATED, "API key not recognized: it was deleted"));
    assert_eq!(refused.finish(), Err(Failure::Status(UNAUTHENTICATED, "API key not recognized: it was deleted".into())));
    assert_eq!(Frames::default().finish(), Err(Failure::Other("boxd ended the reply early.".into())));
    assert_eq!(percent_decode("a%20b%3Ac%zz%"), "a b:c%zz%");
}

#[test]
fn refusals_read_well_and_never_echo_a_key() {
    let text = String::from(Failure::Status(UNAUTHENTICATED, "API key not recognized: it was deleted, or it is not a key of this cluster".into()));
    assert_eq!(text, "boxd refused the API key: API key not recognized: it was deleted, or it is not a key of this cluster. Check it in Settings → Cloud.");
    let echoed = String::from(Failure::Status(UNAUTHENTICATED, "bad key fake-key-0123456789abcdefghijklmnop".into()));
    assert_eq!(echoed, "boxd refused the API key. Check it in Settings → Cloud.");
    assert_eq!(String::from(Failure::Status(NOT_FOUND, "vm not found: x".into())), "boxd: vm not found: x");
    assert_eq!(String::from(Failure::Status(13, " ".into())), "boxd answered with gRPC status 13.");
}

#[tokio::test]
async fn checks_the_key_and_finds_a_region() {
    let (boxd, seen) = boxd();
    assert_eq!(boxd.whoami().await.unwrap(), "Michiel");
    assert_eq!(boxd.region_api("FRA").await.unwrap(), "https://fra.boxd.example:9443");
    assert!(boxd.region_api("nyc").await.unwrap_err().contains("not enabled"));
    assert!(boxd.region_api("sfo").await.unwrap_err().contains("Regions: fra, nyc"));
    let log = seen.lock().unwrap();
    assert!(log.iter().all(|r| r.method == "POST" && r.authorization.as_deref() == Some("Bearer k")));
    assert!(log.iter().all(|r| r.headers.iter().any(|(n, v)| n == "content-type" && v == "application/grpc-web+proto")));
    assert_eq!(log[0].path, "/boxd.api.v1.BoxdApi/Whoami");
}

#[tokio::test]
async fn lists_only_labelled_machines_and_creates_isolated_ones() {
    let (boxd, seen) = boxd();
    let listed = boxd.list().await.unwrap();
    assert_eq!(listed.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("boxd:vm-1", "pc-vm-1", "running"), ("boxd:vm-2", "pc-vm-2", "stopped")]);
    assert_eq!(listed[0].detail, "boxd · 2 vCPU · 8 GB · fra");
    assert_eq!(listed[1].detail, "boxd · 2 vCPU · 8 GB · fra · hibernated");
    let created = boxd.create("pc-new").await.unwrap();
    assert_eq!((created.id.as_str(), created.state.as_str()), ("boxd:vm-new", "starting"));
    let log = seen.lock().unwrap();
    let list = log.iter().find(|r| method(r) == "ListVms").unwrap();
    assert!(list.body.contains("created-by=pandacode"), "the list asks for the label");
    let create = log.iter().find(|r| method(r) == "CreateVm").unwrap();
    assert!(create.body.contains("pc-new") && create.body.contains("created-by") && create.body.contains("pandacode"));
    assert!(create.body.contains("\u{60}\u{1}"), "isolated (field 12) is set");
    // New machines idle into standby after 15 minutes; hibernation is refused here and that is fine.
    let suspend = log.iter().find(|r| method(r) == "SetAutoSuspendTimeout").unwrap();
    assert!(suspend.body.contains("vm-new") && suspend.body.ends_with("\u{10}\u{fffd}\u{7}"), "900 s");
    assert!(log.iter().any(|r| method(r) == "SetAutoHibernateTimeout"));
}

#[tokio::test]
async fn a_taken_name_gets_a_suffix() {
    let (boxd, seen) = boxd();
    boxd.create("pc-taken").await.unwrap();
    let log = seen.lock().unwrap();
    let names: Vec<&str> = log.iter().filter(|r| method(r) == "CreateVm").map(|r| r.body.as_str()).collect();
    assert_eq!(names.len(), 2);
    assert!(names[1].contains("pc-taken-"), "{:?}", names[1]);
}

#[tokio::test]
async fn power_follows_the_machine_state() {
    let (boxd, seen) = boxd();
    boxd.power("vm-2", "start").await.unwrap();
    boxd.power("vm-3", "start").await.unwrap();
    boxd.power("vm-1", "start").await.unwrap();
    boxd.power("vm-1", "stop").await.unwrap();
    boxd.power("vm-2", "stop").await.unwrap();
    boxd.power("vm-1", "delete").await.unwrap();
    assert!(boxd.power("vm-1", "pause").await.unwrap_err().contains("not pause"));
    assert!(boxd.power("vm-gone", "delete").await.unwrap_err().contains("no longer exists"));
    assert_eq!(state(&boxd.owned("vm-3").await.unwrap()), "running", "standby wakes on the next call");
    assert_eq!(state(&boxd.owned("vm-2").await.unwrap()), "stopped");
    let log = seen.lock().unwrap();
    let calls: Vec<&str> = log.iter().map(method).filter(|m| *m != "GetVm").collect();
    assert_eq!(calls, vec!["WakeVm", "ResumeVm", "StopVm", "DestroyVm"]);
}

#[tokio::test]
async fn exec_combines_output_and_reports_the_exit_code() {
    let (boxd, seen) = boxd();
    assert_eq!(boxd.exec("vm-4", "ls -la", Duration::from_secs(30)).await.unwrap(), (Some(2), "out err".into()));
    let started = Instant::now();
    let (code, output) = boxd.exec("vm-4", "sleep 30", Duration::from_secs(1)).await.unwrap();
    assert_eq!((code, output.trim()), (None, "Timed out after 1 s."));
    assert!(started.elapsed() < Duration::from_secs(3));
    let log = seen.lock().unwrap();
    let exec = log.iter().find(|r| method(r) == "Exec").unwrap();
    assert!(exec.body.contains("ls -la") && exec.body.contains("vm-4"));
    assert_eq!(log.iter().filter(|r| method(r) == "GetVm").count(), 1, "ownership is checked once per machine");
}

#[tokio::test]
async fn exec_waits_for_an_agent_that_is_not_up_yet() {
    let (boxd, seen) = boxd();
    owned_ids().lock().unwrap().insert("vm-1".into());
    let error = boxd.exec("vm-1", "agent-down", Duration::from_secs(30)).await.unwrap_err();
    assert!(error.contains("cannot connect to VM agent"));
    assert_eq!(seen.lock().unwrap().iter().filter(|r| method(r) == "Exec").count(), 4, "three retries");
}

#[tokio::test]
async fn files_use_the_fs_api() {
    let (boxd, seen) = boxd();
    boxd.upload("vm-1", "/home/boxd/.pandacode/x", b"hello", true).await.unwrap();
    assert!(boxd.upload("vm-1", "/home/boxd/y", b"four", false).await.unwrap_err().contains("wrote 5 of 4"));
    assert_eq!(boxd.download("vm-1", "/home/boxd/out", 0, 1024).await.unwrap(), b"hello");
    assert_eq!(boxd.download("vm-1", "/home/boxd/out", 0, 2).await.unwrap(), b"he");
    assert!(boxd.download("vm-1", "/missing", 0, 1024).await.unwrap().is_empty());
    let log = seen.lock().unwrap();
    let writes: Vec<&mock::Request> = log.iter().filter(|r| method(r) == "FsWrite").collect();
    assert!(writes[0].body.contains("\u{18}\u{fffd}\u{3}"), "mode 0600 (field 3)");
    assert!(!writes[1].body.contains("\u{18}\u{fffd}\u{3}") && writes[1].body.contains("four"), "no mode unless private");
    let read = log.iter().find(|r| method(r) == "FsRead").unwrap();
    assert!(read.body.contains("/home/boxd/out") && read.body.contains("\u{20}\u{fffd}\u{8}"), "length 1024 (field 4)");
}

#[tokio::test]
async fn refuses_unlabelled_machines_and_unsafe_ids() {
    let (boxd, seen) = boxd();
    owned_ids().lock().unwrap().remove("vm-9");
    assert!(boxd.exec("vm-9", "ls", Duration::from_secs(5)).await.unwrap_err().contains("only controls boxd machines it created"));
    assert!(boxd.power("vm-9", "delete").await.unwrap_err().contains("it created"));
    assert!(boxd.keep_alive("vm-9", 30).await.unwrap_err().contains("it created"));
    assert!(boxd.upload("vm-9", "/x", b"", false).await.unwrap_err().contains("it created"));
    assert!(boxd.download("vm-9", "/x", 0, 1).await.unwrap_err().contains("it created"));
    assert!(boxd.exec("../vm", "ls", Duration::from_secs(5)).await.unwrap_err().contains("not a boxd machine ID"));
    let log = seen.lock().unwrap();
    assert!(log.iter().all(|r| method(r) == "GetVm"), "nothing else was sent");
}

#[tokio::test]
async fn keep_alive_sets_the_idle_timeouts() {
    let (boxd, seen) = boxd();
    boxd.keep_alive("vm-1", 24 * 60).await.unwrap();
    let log = seen.lock().unwrap();
    let suspend = log.iter().find(|r| method(r) == "SetAutoSuspendTimeout").unwrap();
    // 86400 s as a varint: 0x80 0xa3 0x05.
    assert!(suspend.body.ends_with("\u{10}\u{fffd}\u{fffd}\u{5}"), "86400 s");
    assert!(log.iter().any(|r| method(r) == "SetAutoHibernateTimeout"));
}

#[test]
fn states_map_onto_the_panel() {
    for (status, expected) in [("running", "running"), ("suspended", "running"), ("starting", "starting"), ("pending", "starting"), ("hibernated", "stopped"), ("stopped", "stopped"), ("stopping", "stopping"), ("failed", "error")] {
        assert_eq!(state(status), expected, "{status}");
    }
}

#[test]
fn connect_refuses_empty_keys_and_odd_regions() {
    assert!(connect(" ", &json!({})).unwrap_err().contains("boxd auth keys create"));
    assert!(connect("k", &json!({"region": "fra/../x"})).unwrap_err().contains("short code"));
}

/// `BOXD_API_KEY=… [BOXD_REGION=fra] cargo test --lib boxd_live -- --ignored --nocapture`.
/// Creates one machine (labelled `overnight=pandacode`, deleted by boxd after 2 h at the
/// latest), runs every Sandbox method on it and always deletes it.
#[test]
#[ignore = "needs BOXD_API_KEY"]
fn boxd_live() {
    let key = std::env::var("BOXD_API_KEY").expect("BOXD_API_KEY");
    let probe = Boxd::new(None, None, key.clone());
    let region = std::env::var("BOXD_REGION").ok().filter(|r| !r.is_empty());
    let machines = region.as_deref().map(|r| http::block(probe.region_api(r)).unwrap());
    let mut api = Boxd::new(None, machines, key);
    api.extra_labels = vec![("overnight".into(), "pandacode".into())];
    api.delete_after_secs = Some(2 * 3600);
    let error = http::block(Boxd::new(None, None, "not-a-real-boxd-key".into()).whoami()).unwrap_err();
    eprintln!("boxd_live: a wrong key reads: {error}");
    assert!(error.contains("refused the API key"));
    eprintln!("boxd_live: signed in as {}", http::block(api.whoami()).unwrap());

    let started = Instant::now();
    let made = Sandbox::create(&api, &format!("t-pandacode-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])).unwrap();
    let id = made.id.trim_start_matches("boxd:").to_string();
    eprintln!("boxd_live: created {id} ({}, {}) in {} ms", made.name, made.detail, started.elapsed().as_millis());
    let run = || -> Result<()> {
        let wait = |want: &str| -> Result<()> {
            let started = Instant::now();
            while Sandbox::state(&api, &id)? != want {
                assert!(started.elapsed() < Duration::from_secs(300), "never {want}");
                std::thread::sleep(Duration::from_secs(2));
            }
            eprintln!("boxd_live: {want} after {} ms", started.elapsed().as_millis());
            Ok(())
        };
        wait("running")?;
        assert!(Sandbox::list(&api)?.iter().any(|m| m.id == made.id), "list shows the machine");

        let (code, out) = Sandbox::exec(&api, &id, "echo out; echo err >&2; whoami; echo $HOME; command -v git curl bash; exit 3", Duration::from_secs(60))?;
        eprintln!("boxd_live: exec -> {code:?} {out:?}");
        assert_eq!(code, Some(3));
        assert!(out.contains("out") && out.contains("err") && out.contains("/usr/bin/git"));
        let home = Sandbox::exec(&api, &id, "printf %s \"$HOME\"", Duration::from_secs(30))?.1;
        assert_eq!(Sandbox::exec(&api, &id, "sudo -n true", Duration::from_secs(30))?.0, Some(0), "passwordless sudo");

        // Big output is kept whole up to the contract's 4 MiB.
        let (code, big) = Sandbox::exec(&api, &id, "head -c 5000000 /dev/zero | tr '\\0' a", Duration::from_secs(60))?;
        assert_eq!((code, big.len()), (Some(0), 5_000_000));

        // A detached process outlives the call; a timed-out command is killed.
        Sandbox::spawn(&api, &id, "exec sleep 3001")?;
        let (code, out) = Sandbox::exec(&api, &id, "echo started; sleep 3002", Duration::from_secs(3))?;
        eprintln!("boxd_live: timeout -> {code:?} {out:?}");
        assert!(code.is_none() && out.contains("started") && out.contains("Timed out after 3 s."));
        std::thread::sleep(Duration::from_secs(5));
        let procs = Sandbox::exec(&api, &id, "pgrep -fa 'sleep 300' || true", Duration::from_secs(30))?.1;
        eprintln!("boxd_live: processes {procs:?}");
        assert!(procs.contains("sleep 3001"), "the spawned process died");
        assert!(!procs.contains("sleep 3002"), "the timed-out command kept running");

        // Files: private mode, parents, binary bytes, offsets, a missing file.
        let path = format!("{home}/pandacode-live/deep/secret.json");
        Sandbox::upload(&api, &id, &path, b"{\"token\":1}", true)?;
        assert_eq!(Sandbox::exec(&api, &id, &format!("stat -c %a {path}"), Duration::from_secs(30))?.1.trim(), "600");
        Sandbox::upload(&api, &id, &format!("{home}/pandacode-live/empty"), b"", false)?;
        assert_eq!(Sandbox::exec(&api, &id, &format!("stat -c %s {home}/pandacode-live/empty"), Duration::from_secs(30))?.1.trim(), "0");
        let blob: Vec<u8> = (0..3 * 1024 * 1024 + 7).map(|i| (i * 31 % 251) as u8).collect();
        let started = Instant::now();
        Sandbox::upload(&api, &id, &format!("{home}/pandacode-live/blob"), &blob, false)?;
        eprintln!("boxd_live: 3 MiB upload in {} ms", started.elapsed().as_millis());
        let sum = Sandbox::exec(&api, &id, &format!("sha256sum {home}/pandacode-live/blob | cut -c1-64"), Duration::from_secs(30))?.1;
        use sha2::Digest;
        assert_eq!(sum.trim(), format!("{:x}", sha2::Sha256::digest(&blob)));
        let mut back = Vec::new();
        while back.len() < blob.len() {
            back.extend(Sandbox::download(&api, &id, &format!("{home}/pandacode-live/blob"), back.len() as u64, 128 * 1024)?);
        }
        assert_eq!(back, blob);
        assert!(Sandbox::download(&api, &id, &format!("{home}/pandacode-live/blob"), blob.len() as u64 + 10, 10)?.is_empty());
        assert!(Sandbox::download(&api, &id, &format!("{home}/nope"), 0, 10)?.is_empty());
        assert!(Sandbox::download(&api, &id, &format!("{home}/pandacode-live"), 0, 10)?.is_empty(), "a directory reads as empty");

        // keep_alive: standby after the minutes asked, hibernation an hour after that.
        Sandbox::keep_alive(&api, &id, 90)?;
        let vm = http::block(api.get(&id)).unwrap();
        let vm = parse(&vm)?;
        assert_eq!((vm.int(8), vm.int(13)), (90 * 60, 90 * 60 + 3600));

        // Stop and start: the disk is kept, processes are not.
        Sandbox::power(&api, &id, "stop")?;
        wait("stopped")?;
        Sandbox::power(&api, &id, "start")?;
        wait("running")?;
        assert_eq!(Sandbox::exec(&api, &id, &format!("cat {path}"), Duration::from_secs(60))?.1, "{\"token\":1}");

        // Hibernate (as the idle timer would), then the next exec wakes it.
        let hibernated = http::block(api.unary(&api.machines, "HibernateVm", Out::default().text(1, &id)));
        eprintln!("boxd_live: hibernate -> {hibernated:?}");
        if hibernated.is_ok() {
            wait("stopped")?;
            Sandbox::power(&api, &id, "start")?;
            wait("running")?;
            assert_eq!(Sandbox::exec(&api, &id, "echo awake", Duration::from_secs(60))?.1.trim(), "awake");
        }
        eprintln!("boxd_live: all steps passed");
        Ok(())
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    Sandbox::power(&api, &id, "delete").unwrap();
    let deleted = Instant::now();
    while Sandbox::state(&api, &id).is_ok() {
        assert!(deleted.elapsed() < Duration::from_secs(120), "{id} still exists");
        std::thread::sleep(Duration::from_secs(2));
    }
    eprintln!("boxd_live: {id} deleted");
    result.unwrap().unwrap();
}

/// A real agent run through the cloud agent pipeline on boxd: the checkout goes up as a git
/// bundle, Claude Code is installed by `setup::ensure_runtime`, runs detached under the
/// bridge's runner (stdin from `inbox`, output polled with `download`), edits the repo with
/// its tools, and the commit comes back with `sync::pull_changes`.
/// `BOXD_API_KEY=… ANTHROPIC_API_KEY=… cargo test --lib boxd_live_agent -- --ignored --nocapture`.
#[test]
#[ignore = "needs BOXD_API_KEY and ANTHROPIC_API_KEY"]
fn boxd_live_agent() {
    use crate::cloud_agents::{bridge, setup, sync};
    let mut api = Boxd::new(None, None, std::env::var("BOXD_API_KEY").expect("BOXD_API_KEY"));
    let anthropic = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
    api.extra_labels = vec![("overnight".into(), "pandacode".into())];
    api.delete_after_secs = Some(2 * 3600);
    let made = Sandbox::create(&api, &format!("t-pandacode-agent-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])).unwrap();
    let id = made.id.trim_start_matches("boxd:").to_string();
    eprintln!("boxd_live_agent: created {id} ({})", made.name);
    let local = std::env::temp_dir().join(format!("pandacode-boxd-agent-{}", uuid::Uuid::new_v4().simple()));
    let run = || -> Result<()> {
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(&local).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        std::fs::create_dir_all(&local).unwrap();
        git(&["init", "-q", "-b", "pandacode/cloud-live"]);
        git(&["config", "user.email", "live@example.invalid"]);
        git(&["config", "user.name", "PandaCode live test"]);
        std::fs::write(local.join("README.md"), "# boxd live test\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "start"]);

        let home = bridge::home(&api, &id)?;
        let remote_dir = format!("{home}/pandacode/live-task");
        let started = Instant::now();
        let base = sync::upload_checkout(&api, &id, &local, &remote_dir, "pandacode/cloud-live")?;
        eprintln!("boxd_live_agent: checkout {base} uploaded in {} ms", started.elapsed().as_millis());
        let started = Instant::now();
        let program = setup::ensure_runtime(&api, &id, "claude", None, &|step| eprintln!("boxd_live_agent: setup: {step}"))?;
        eprintln!("boxd_live_agent: runtime {program} ready in {} s", started.elapsed().as_secs());

        let prompt = "Create a file named hello.txt in the current directory containing exactly the line `hello from boxd`. Then run `uname -sm` with Bash and reply with its output only.";
        let message = json!({"type": "user", "message": {"role": "user", "content": prompt}}).to_string() + "\n";
        let status = local.with_extension("status.json");
        let spec = bridge::Spec {
            provider: "boxd".into(),
            native: id.clone(),
            run_id: format!("live-{}", uuid::Uuid::new_v4().simple()),
            remote_dir: remote_dir.clone(),
            local_dir: local.to_string_lossy().into_owned(),
            program,
            args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--dangerously-skip-permissions"].map(String::from).to_vec(),
            env: vec![("ANTHROPIC_API_KEY".into(), anthropic.clone())],
            attach: false,
            status,
            secrets: None,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let started = Instant::now();
        let code = bridge::run(&api, &spec, std::io::Cursor::new(message.into_bytes()), &mut out, &mut err, &mut |_| {});
        let out = String::from_utf8_lossy(&out);
        eprintln!("boxd_live_agent: agent exited {code} after {} s, {} output lines, stderr {:?}", started.elapsed().as_secs(), out.lines().count(), String::from_utf8_lossy(&err));
        let result = out.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v["type"] == "result").expect("a result line");
        eprintln!("boxd_live_agent: result {}", result["result"]);
        let tools: Vec<String> = out.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| v["message"]["content"].as_array().cloned().unwrap_or_default()).filter(|c| c["type"] == "tool_use").map(|c| c["name"].as_str().unwrap_or_default().to_string()).collect();
        eprintln!("boxd_live_agent: tools used {tools:?}");
        assert_eq!(code, 0);
        assert!(result["result"].as_str().unwrap_or_default().contains("Linux x86_64"), "{result}");
        assert!(tools.iter().any(|t| t == "Bash"));

        let pulled = sync::pull_changes(&api, &id, &remote_dir, &local, "live", "Cloud changes")?;
        eprintln!("boxd_live_agent: pulled {} commit(s), applied {}", pulled.commits, pulled.applied);
        assert!(pulled.commits >= 1 && pulled.applied);
        assert_eq!(std::fs::read_to_string(local.join("hello.txt")).unwrap().trim(), "hello from boxd");
        eprintln!("boxd_live_agent: all steps passed");
        Ok(())
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    Sandbox::power(&api, &id, "delete").unwrap();
    let _ = std::fs::remove_dir_all(&local);
    eprintln!("boxd_live_agent: {id} deleted");
    result.unwrap().unwrap();
}

/// A command that prints nothing for 5.5 minutes keeps its one HTTPS stream, and a machine in
/// standby wakes for the next exec.
/// `BOXD_API_KEY=… cargo test --lib boxd_live_long -- --ignored --nocapture`.
#[test]
#[ignore = "needs BOXD_API_KEY; takes 6 minutes"]
fn boxd_live_long() {
    let mut api = Boxd::new(None, None, std::env::var("BOXD_API_KEY").expect("BOXD_API_KEY"));
    api.extra_labels = vec![("overnight".into(), "pandacode".into())];
    api.delete_after_secs = Some(2 * 3600);
    let made = Sandbox::create(&api, &format!("t-pandacode-long-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])).unwrap();
    let id = made.id.trim_start_matches("boxd:").to_string();
    let run = || -> Result<()> {
        assert_eq!(Sandbox::exec(&api, &id, "echo up", Duration::from_secs(60))?.1.trim(), "up");
        http::block(api.unary(&api.machines, "SuspendVm", Out::default().text(1, &id))).map_err(String::from)?;
        let vm = http::block(api.get(&id)).unwrap();
        let vm = parse(&vm)?;
        eprintln!("boxd_live_long: after SuspendVm the status is {:?} ({})", vm.text(5), Sandbox::state(&api, &id)?);
        let started = Instant::now();
        assert_eq!(Sandbox::exec(&api, &id, "echo woke", Duration::from_secs(60))?.1.trim(), "woke");
        eprintln!("boxd_live_long: exec woke it in {} ms", started.elapsed().as_millis());
        let started = Instant::now();
        let (code, out) = Sandbox::exec(&api, &id, "sleep 330; echo done", Duration::from_secs(600))?;
        eprintln!("boxd_live_long: silent command -> {code:?} {out:?} after {} s", started.elapsed().as_secs());
        assert_eq!((code, out.trim()), (Some(0), "done"));
        Ok(())
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    Sandbox::power(&api, &id, "delete").unwrap();
    eprintln!("boxd_live_long: {id} deleted");
    result.unwrap().unwrap();
}
