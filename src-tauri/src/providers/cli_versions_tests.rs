#[cfg(unix)]
use super::{BinaryStamp, SavedVersion, SavedVersions, VersionTarget};
use super::{Timing, VersionCache, VersionReport};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

#[cfg(unix)]
const QUICK: Timing = Timing { boot_delay: Duration::ZERO, round_timeout: Duration::from_secs(2), blocking_wait: Duration::from_secs(8) };
#[cfg(unix)]
const HOUR: u64 = 60 * 60;

#[cfg(unix)]
#[test]
fn probe_stdout_inherited_by_descendant_respects_deadline() {
    let timeout = Duration::from_millis(200);
    let started = Instant::now();
    let answer = super::capture(std::process::Command::new("sh"), &["-c", "sleep 5 & printf 1.2.3"], timeout);
    let elapsed = started.elapsed();
    assert!(elapsed < timeout + Duration::from_millis(500), "stdout drain exceeded deadline: {elapsed:?}");
    assert_eq!(answer, None, "an incomplete stdout drain is a failed probe");
}

#[cfg(unix)]
#[test]
fn probe_stdout_from_normal_exit_is_unchanged() {
    assert_eq!(
        super::capture(std::process::Command::new("sh"), &["-c", "printf ' 1.2.3\\n'"], Duration::from_secs(1)),
        Some("1.2.3".to_owned()),
    );
}

/// A cache of its own (the shared one is used by parallel tests) whose reports go to the receiver.
fn fresh_cache(timing: Timing) -> (&'static VersionCache, Receiver<VersionReport>) {
    let cache: &'static VersionCache = Box::leak(Box::new(VersionCache::new(timing)));
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    cache.set_announcer(std::sync::Arc::new(move |report| {
        let _ = sender.lock().unwrap().send(report);
    }));
    (cache, receiver)
}

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("pandacode-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A stand-in CLI at `root/name` running `body` (after logging its start and end to `log`).
#[cfg(unix)]
fn fake_cli(root: &Path, name: &str, log: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = root.join(name);
    std::fs::write(&script, format!("#!/bin/sh\necho 'start {name}' >> '{log}'\n{body}\necho 'end {name}' >> '{log}'\n", log = log.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

/// A shared binary that logs and answers by the name it was run as, with the version in `version_file`.
#[cfg(unix)]
fn fake_shim(root: &Path, log: &Path, version_file: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let shim = root.join("volta-shim");
    std::fs::write(&shim, format!(
        "#!/bin/sh\nname=$(basename \"$0\")\necho \"start $name\" >> '{log}'\necho \"$name $(cat '{version}')\"\n",
        log = log.display(),
        version = version_file.display(),
    )).unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    shim
}

#[cfg(unix)]
fn target(id: &str, path: &Path) -> VersionTarget {
    (id.to_owned(), Some(path.to_owned()))
}

#[cfg(unix)]
fn count_starts(log: &Path, name: &str) -> usize {
    std::fs::read_to_string(log).unwrap_or_default().lines().filter(|line| *line == format!("start {name}")).count()
}

#[cfg(unix)]
fn report(pairs: &[(&str, &str)], done: bool) -> VersionReport {
    VersionReport { versions: pairs.iter().map(|(id, version)| ((*id).to_owned(), (*version).to_owned())).collect(), done }
}

#[cfg(unix)]
fn next_report(receiver: &Receiver<VersionReport>) -> VersionReport {
    receiver.recv_timeout(Duration::from_secs(15)).expect("a report")
}

#[cfg(unix)]
fn write_saved(file: &Path, format: u32, entries: Vec<SavedVersion>) {
    std::fs::write(file, serde_json::to_vec(&SavedVersions { format, versions: entries }).unwrap()).unwrap();
}

#[cfg(unix)]
fn saved(path: &Path, version: Option<&str>, checked: u64, failed: Option<u64>) -> SavedVersion {
    SavedVersion { stamp: BinaryStamp::of(path).unwrap(), version: version.map(str::to_owned), checked, failed }
}

/// Four slow stand-in CLIs (one listed three times) probe at once: each binary runs once,
/// results keep their order, and the wall time is one probe, not four.
#[cfg(unix)]
#[test]
fn version_probes_run_in_parallel_once_per_binary() {
    let root = scratch("versions");
    let log = root.join("runs.log");
    let scripts: Vec<_> = (0..4).map(|index| fake_cli(&root, &format!("cli{index}"), &log, &format!("sleep 0.6\necho 'cli{index} 1.{index}.0'"))).collect();
    let missing = root.join("missing");
    let paths = [
        Some(&scripts[0]), None, Some(&scripts[1]), Some(&scripts[0]), Some(&scripts[2]), Some(&missing), Some(&scripts[0]), Some(&scripts[3]),
    ];
    let targets: Vec<VersionTarget> = paths.iter().enumerate().map(|(index, path)| (index.to_string(), path.cloned())).collect();
    let (cache, _reports) = fresh_cache(QUICK);
    let started = Instant::now();
    let versions = cache.versions_blocking(&targets);
    let elapsed = started.elapsed();
    let starts: Vec<_> = (0..4).map(|index| count_starts(&log, &format!("cli{index}"))).collect();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(versions, ["cli0 1.0.0", "", "cli1 1.1.0", "cli0 1.0.0", "cli2 1.2.0", "", "cli0 1.0.0", "cli3 1.3.0"]);
    assert_eq!(starts, [1, 1, 1, 1], "each distinct binary runs once");
    // Serially this is 4 × 0.6 s = 2.4 s; in parallel about one 0.6 s probe.
    assert!(elapsed < Duration::from_millis(1600), "probes ran serially: {elapsed:?}");
}

/// A list and a blocking discovery asking for ten slow CLIs between them: never more than four
/// probes run at once in total, they still overlap, and every CLI runs once.
#[cfg(unix)]
#[test]
fn version_probes_run_at_most_four_at_once_across_paths() {
    let root = scratch("version-cap");
    let log = root.join("runs.log");
    let targets: Vec<_> = (0..10)
        .map(|index| target(&format!("cli{index}"), &fake_cli(&root, &format!("cli{index}"), &log, &format!("sleep 0.3\necho 'cli{index} 2.{index}.0'"))))
        .collect();
    let (cache, _reports) = fresh_cache(QUICK);
    assert_eq!(cache.versions_now(&targets[..5], true), ["", "", "", "", ""]);
    let versions = cache.versions_blocking(&targets);
    let runs = std::fs::read_to_string(&log).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    let expected: Vec<_> = (0..10).map(|index| format!("cli{index} 2.{index}.0")).collect();
    assert_eq!(versions, expected);
    let (mut running, mut most) = (0usize, 0usize);
    for line in runs.lines() {
        if line.starts_with("start ") { running += 1; } else { running -= 1; }
        most = most.max(running);
    }
    assert_eq!(runs.lines().count(), 20, "every CLI started and ended once: {runs}");
    assert!(most <= super::PROBES_AT_ONCE, "{most} probes ran at once:\n{runs}");
    assert!(most >= 2, "probes ran one at a time:\n{runs}");
}

/// A second discovery starts no process for an answered binary or a recent failure; a new
/// mtime is a new build and is asked again.
#[cfg(unix)]
#[test]
fn version_answers_are_cached_per_build() {
    let root = scratch("version-cache");
    let log = root.join("runs.log");
    let good = fake_cli(&root, "good", &log, "echo 'good 3.0.0'");
    let bad = fake_cli(&root, "bad", &log, "exit 1");
    let targets = [target("good", &good), target("bad", &bad)];
    let (cache, _reports) = fresh_cache(QUICK);
    let starts = || (count_starts(&log, "good"), count_starts(&log, "bad"));

    assert_eq!(cache.versions_blocking(&targets), ["good 3.0.0", ""]);
    assert_eq!(starts(), (1, 1));
    assert_eq!(cache.versions_blocking(&targets), ["good 3.0.0", ""]);
    assert_eq!(starts(), (1, 1), "the answer and the failure are both reused");

    let file = std::fs::File::options().write(true).open(&good).unwrap();
    file.set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)).unwrap();
    drop(file);
    assert_eq!(cache.versions_blocking(&targets), ["good 3.0.0", ""]);
    let after = starts();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(after, (2, 1), "a new mtime is a new build");
}

/// A list never waits on a probe. The round reports answers, failures and timeouts ("") with
/// `done`; both failures are saved. The next list probes nothing and, with nothing pending,
/// reports the installed CLIs still without a version, `done`.
#[cfg(unix)]
#[test]
fn versions_now_answers_at_once_and_reports_failures() {
    let root = scratch("version-now");
    let log = root.join("runs.log");
    let slow = fake_cli(&root, "slow", &log, "sleep 5\necho 'slow 1.0.0'");
    let quick = fake_cli(&root, "quick", &log, "echo 'quick 2.0.0'");
    let broken = fake_cli(&root, "broken", &log, "exit 3");
    let file = root.join(super::CACHE_FILE);
    let targets = [target("slow", &slow), target("quick", &quick), target("broken", &broken), ("absent".to_owned(), None)];
    let (cache, reports) = fresh_cache(Timing { round_timeout: Duration::from_secs(1), ..QUICK });
    cache.load(file.clone());

    let started = Instant::now();
    assert_eq!(cache.versions_now(&targets, true), ["", "", "", ""]);
    assert!(started.elapsed() < Duration::from_millis(200), "the list waited on a probe: {:?}", started.elapsed());
    assert_eq!(next_report(&reports), report(&[("broken", ""), ("quick", "quick 2.0.0"), ("slow", "")], true));
    assert!(!cache.running());
    let on_disk: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let failed = on_disk["versions"].as_array().unwrap().iter().filter(|entry| entry["failed"].is_u64()).count();

    assert_eq!(cache.versions_now(&targets, true), ["", "quick 2.0.0", "", ""]);
    assert_eq!(next_report(&reports), report(&[("broken", ""), ("slow", "")], true));
    std::thread::sleep(Duration::from_millis(300));
    let starts = (count_starts(&log, "slow"), count_starts(&log, "quick"), count_starts(&log, "broken"));
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(on_disk["format"], super::CACHE_FORMAT);
    assert_eq!(failed, 2, "the timeout and the failure are saved: {on_disk}");
    assert_eq!(starts, (1, 1, 1), "nothing was asked twice");
    assert!(reports.try_recv().is_err());
}

/// Lists that arrive while a round runs share it: one process per binary, one report.
#[cfg(unix)]
#[test]
fn concurrent_lists_share_one_probe() {
    let root = scratch("version-flight");
    let log = root.join("runs.log");
    let targets = vec![target("cli", &fake_cli(&root, "cli", &log, "sleep 0.5\necho 'cli 4.0.0'"))];
    let (cache, reports) = fresh_cache(QUICK);
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let lists: Vec<_> = (0..2)
        .map(|_| {
            let (targets, gate) = (targets.clone(), gate.clone());
            std::thread::spawn(move || {
                gate.wait();
                cache.versions_now(&targets, true)
            })
        })
        .collect();
    for list in lists {
        assert_eq!(list.join().unwrap(), [""]);
    }
    assert_eq!(next_report(&reports), report(&[("cli", "cli 4.0.0")], true));
    assert!(reports.recv_timeout(Duration::from_secs(1)).is_err(), "a second round reported");
    let starts = count_starts(&log, "cli");
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, 1, "two lists started {starts} probes");
    assert!(!cache.running());
}

/// The blocking discovery joins a round a list started (skipping its boot delay), starts no
/// process of its own, and the round announces. On its own it starts a round, which announces.
#[cfg(unix)]
#[test]
fn blocking_discovery_joins_a_running_round_and_announces() {
    let root = scratch("version-join");
    let log = root.join("runs.log");
    let targets = [target("cli", &fake_cli(&root, "cli", &log, "sleep 0.3\necho 'cli 8.0.0'"))];
    let (cache, reports) = fresh_cache(Timing { boot_delay: Duration::from_secs(5), ..QUICK });
    assert_eq!(cache.versions_now(&targets, true), [""]);
    assert!(cache.running(), "the list started a round, waiting out its boot delay");
    let started = Instant::now();
    assert_eq!(cache.versions_blocking(&targets), ["cli 8.0.0"]);
    let waited = started.elapsed();
    assert_eq!(next_report(&reports), report(&[("cli", "cli 8.0.0")], true));
    let joined = count_starts(&log, "cli");

    let (alone, alone_reports) = fresh_cache(QUICK);
    assert_eq!(alone.versions_blocking(&targets), ["cli 8.0.0"]);
    let heard = next_report(&alone_reports);
    let total = count_starts(&log, "cli");
    std::fs::remove_dir_all(&root).unwrap();
    assert!(waited < Duration::from_secs(2), "the boot delay held the blocking discovery: {waited:?}");
    assert_eq!(joined, 1, "the blocking discovery probed again");
    assert_eq!(heard, report(&[("cli", "cli 8.0.0")], true));
    assert_eq!(total, 2);
}

/// The first round waits the boot delay after the first list before it starts a process.
#[cfg(unix)]
#[test]
fn first_round_waits_the_boot_delay() {
    let root = scratch("version-boot");
    let log = root.join("runs.log");
    let targets = [target("cli", &fake_cli(&root, "cli", &log, "echo 'cli 1.0.0'"))];
    let (cache, reports) = fresh_cache(Timing { boot_delay: Duration::from_millis(800), ..QUICK });
    let started = Instant::now();
    assert_eq!(cache.versions_now(&targets, true), [""]);
    std::thread::sleep(Duration::from_millis(400));
    let early = count_starts(&log, "cli");
    assert_eq!(next_report(&reports), report(&[("cli", "cli 1.0.0")], true));
    let waited = started.elapsed();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(early, 0, "a probe ran during the boot delay");
    assert!(waited >= Duration::from_millis(800), "{waited:?}");
}

/// A build asked for while a round runs gets a second round: only the last report is `done`.
#[cfg(unix)]
#[test]
fn only_the_last_round_reports_done() {
    let root = scratch("version-done");
    let log = root.join("runs.log");
    let first = [target("first", &fake_cli(&root, "first", &log, "sleep 0.6\necho 'first 1.0.0'"))];
    let second = [target("second", &fake_cli(&root, "second", &log, "echo 'second 1.0.0'"))];
    let (cache, reports) = fresh_cache(QUICK);
    assert_eq!(cache.versions_now(&first, true), [""]);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(cache.versions_now(&second, true), [""]);
    let reports = [next_report(&reports), next_report(&reports)];
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(reports, [report(&[("first", "first 1.0.0")], false), report(&[("second", "second 1.0.0")], true)]);
}

/// Discovery for callers that show no version starts no process and reports nothing.
#[cfg(unix)]
#[test]
fn cached_discovery_starts_no_probe() {
    let root = scratch("version-cached");
    let log = root.join("runs.log");
    let targets = [target("cli", &fake_cli(&root, "cli", &log, "echo 'cli 1.0.0'"))];
    let (cache, reports) = fresh_cache(QUICK);
    assert_eq!(cache.versions_now(&targets, false), [""]);
    assert!(!cache.running());
    assert!(reports.recv_timeout(Duration::from_millis(500)).is_err());
    let starts = count_starts(&log, "cli");
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, 0);
}

/// Volta and mise shims are symlinks to one binary that answers by its own name: each keeps its
/// own version, and is detected as a shim.
#[cfg(unix)]
#[test]
fn symlinked_shims_keep_their_own_versions() {
    let root = scratch("version-shims");
    let log = root.join("runs.log");
    let version_file = root.join("version");
    std::fs::write(&version_file, "5.0.0").unwrap();
    let shim = fake_shim(&root, &log, &version_file);
    let (alpha, beta) = (root.join("alpha"), root.join("beta"));
    std::os::unix::fs::symlink(&shim, &alpha).unwrap();
    std::os::unix::fs::symlink(&shim, &beta).unwrap();
    let (alpha_stamp, beta_stamp) = (BinaryStamp::of(&alpha).unwrap(), BinaryStamp::of(&beta).unwrap());
    let (cache, _reports) = fresh_cache(QUICK);
    let versions = cache.versions_blocking(&[target("alpha", &alpha), target("beta", &beta)]);
    std::fs::remove_dir_all(&root).unwrap();
    assert_ne!(alpha_stamp, beta_stamp);
    assert_eq!(alpha_stamp.target, beta_stamp.target);
    assert!(alpha_stamp.shim() && beta_stamp.shim());
    assert_eq!(versions, ["alpha 5.0.0", "beta 5.0.0"]);
}

#[test]
fn shims_are_recognised_by_name_and_folder() {
    let shim = |path: &str, target: &str| super::is_shim(Path::new(path), Path::new(target));
    assert!(shim("/home/u/.volta/bin/claude", "/home/u/.volta/bin/volta-shim"));
    assert!(shim("/home/u/.local/share/mise/shims/codex", "/usr/local/bin/mise"));
    assert!(shim("/home/u/.asdf/shims/gemini", "/home/u/.asdf/shims/gemini"));
    assert!(shim("/home/u/.local/share/mise/shims/codex", "/home/u/.local/share/mise/shims/codex"));
    assert!(shim("/home/u/.mise/shims/codex", "/home/u/.mise/shims/codex"));
    assert!(!shim("/usr/local/bin/qwen", "/usr/local/lib/node_modules/qwen/cli.js"));
    assert!(!shim("/home/u/.local/bin/claude", "/home/u/.local/share/claude/versions/2.1.0"));
    assert!(!shim("/opt/homebrew/bin/codex", "/opt/homebrew/Cellar/codex/1.2.0/bin/codex"));
    assert!(!shim("/home/u/.local/bin/claude", "/home/u/.local/bin/claude"));
}

/// A shim's saved answer is shown at once on the next launch and asked again in the background
/// once per launch (the new version replaces it); a non-shim answer is not asked again. A
/// shim answer saved on an earlier day is not shown.
#[cfg(unix)]
#[test]
fn shim_answers_are_checked_once_per_launch() {
    let root = scratch("version-shim-launch");
    let log = root.join("runs.log");
    let version_file = root.join("version");
    std::fs::write(&version_file, "5.0.0").unwrap();
    let shim = fake_shim(&root, &log, &version_file);
    let alpha = root.join("alpha");
    std::os::unix::fs::symlink(&shim, &alpha).unwrap();
    let plain = fake_cli(&root, "plain", &log, "echo 'plain 1.0.0'");
    let file = root.join(super::CACHE_FILE);
    let targets = [target("alpha", &alpha), target("plain", &plain)];

    let (first, first_reports) = fresh_cache(QUICK);
    first.load(file.clone());
    assert_eq!(first.versions_blocking(&targets), ["alpha 5.0.0", "plain 1.0.0"]);
    // The blocking discovery returns as answers land; the round still saves and reports.
    assert_eq!(next_report(&first_reports), report(&[("alpha", "alpha 5.0.0"), ("plain", "plain 1.0.0")], true));
    assert_eq!(first.versions_now(&targets, true), ["alpha 5.0.0", "plain 1.0.0"]);
    assert!(!first.running(), "a shim checked this launch is not asked again");

    // The version manager installs a new version: the shim binary does not change.
    std::fs::write(&version_file, "6.0.0").unwrap();
    let (second, reports) = fresh_cache(QUICK);
    second.load(file.clone());
    assert_eq!(second.versions_now(&targets, true), ["alpha 5.0.0", "plain 1.0.0"], "the saved answer shows until the new one lands");
    assert_eq!(next_report(&reports), report(&[("alpha", "alpha 6.0.0")], true));
    assert_eq!(second.versions_now(&targets, true), ["alpha 6.0.0", "plain 1.0.0"]);
    std::thread::sleep(Duration::from_millis(300));
    let starts = (count_starts(&log, "alpha"), count_starts(&log, "plain"));

    let now = super::now_secs();
    let yesterday = now - now % super::DAY - 60;
    write_saved(&file, super::CACHE_FORMAT, vec![saved(&alpha, Some("alpha 4.0.0"), yesterday, None)]);
    let (third, _third_reports) = fresh_cache(QUICK);
    third.load(file.clone());
    let shown = third.versions_now(&targets[..1], false);
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, (2, 1), "the shim was checked once per launch, the plain CLI once");
    assert_eq!(shown, [""], "a shim answer from an earlier day was shown");
}

/// An npm-style link to a script with a different name is not a shim: its answer is trusted on
/// the next launch, and an upgrade (which changes the resolved script) is asked again.
#[cfg(unix)]
#[test]
fn npm_links_are_not_probed_again_on_the_next_launch() {
    let root = scratch("version-npm-link");
    let log = root.join("runs.log");
    let script = fake_cli(&root, "cli.js", &log, "echo 'qwen 1.0.0'");
    let qwen = root.join("qwen");
    std::os::unix::fs::symlink(&script, &qwen).unwrap();
    let file = root.join(super::CACHE_FILE);
    let targets = [target("qwen", &qwen)];
    let stamp = BinaryStamp::of(&qwen).unwrap();

    let (first, first_reports) = fresh_cache(QUICK);
    first.load(file.clone());
    assert_eq!(first.versions_blocking(&targets), ["qwen 1.0.0"]);
    assert_eq!(next_report(&first_reports), report(&[("qwen", "qwen 1.0.0")], true));

    let (second, second_reports) = fresh_cache(QUICK);
    second.load(file.clone());
    assert_eq!(second.versions_now(&targets, true), ["qwen 1.0.0"]);
    assert!(!second.running(), "an npm link was asked again on the next launch");
    assert!(second_reports.recv_timeout(Duration::from_millis(300)).is_err());
    let starts = count_starts(&log, "cli.js");
    std::fs::remove_dir_all(&root).unwrap();
    assert!(!stamp.shim());
    assert_eq!(starts, 1);
}

/// A saved answer younger than a day is trusted; an older one is shown and asked again in the
/// background. A format-1 file (no timestamps) loads as due for a check.
#[cfg(unix)]
#[test]
fn saved_answers_older_than_a_day_are_probed_again() {
    let root = scratch("version-age");
    let log = root.join("runs.log");
    let old = fake_cli(&root, "old", &log, "echo 'old 2.0.0'");
    let recent = fake_cli(&root, "recent", &log, "echo 'recent 2.0.0'");
    let legacy = fake_cli(&root, "legacy", &log, "echo 'legacy 2.0.0'");
    let file = root.join(super::CACHE_FILE);
    let targets = [target("old", &old), target("recent", &recent)];
    let now = super::now_secs();
    write_saved(&file, super::CACHE_FORMAT, vec![
        saved(&old, Some("old 1.0.0"), now - 25 * HOUR, None),
        saved(&recent, Some("recent 1.0.0"), now - HOUR, None),
    ]);
    let (cache, reports) = fresh_cache(QUICK);
    cache.load(file.clone());
    assert_eq!(cache.versions_now(&targets, true), ["old 1.0.0", "recent 1.0.0"]);
    assert_eq!(next_report(&reports), report(&[("old", "old 2.0.0")], true));
    assert_eq!(cache.versions_now(&targets, true), ["old 2.0.0", "recent 1.0.0"]);

    let stamp = BinaryStamp::of(&legacy).unwrap();
    let format_one = serde_json::json!({ "format": 1, "versions": [{
        "path": stamp.path, "target": stamp.target, "size": stamp.size, "modified": stamp.modified, "version": "legacy 1.0.0",
    }]});
    std::fs::write(&file, format_one.to_string()).unwrap();
    let (upgraded, upgraded_reports) = fresh_cache(QUICK);
    upgraded.load(file.clone());
    assert_eq!(upgraded.versions_now(&[target("legacy", &legacy)], true), ["legacy 1.0.0"]);
    assert_eq!(next_report(&upgraded_reports), report(&[("legacy", "legacy 2.0.0")], true));
    std::thread::sleep(Duration::from_millis(200));
    let starts = (count_starts(&log, "old"), count_starts(&log, "recent"), count_starts(&log, "legacy"));
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, (1, 0, 1));
}

/// A saved failure is not asked again for six hours; after that it is.
#[cfg(unix)]
#[test]
fn saved_failures_are_respected_for_six_hours() {
    let root = scratch("version-failure");
    let log = root.join("runs.log");
    let recent = fake_cli(&root, "recent", &log, "echo 'recent 1.0.0'");
    let expired = fake_cli(&root, "expired", &log, "echo 'expired 1.0.0'");
    let file = root.join(super::CACHE_FILE);
    let now = super::now_secs();
    write_saved(&file, super::CACHE_FORMAT, vec![
        saved(&recent, None, now - HOUR, Some(now - HOUR)),
        saved(&expired, None, now - 7 * HOUR, Some(now - 7 * HOUR)),
    ]);
    let targets = [target("recent", &recent), target("expired", &expired)];
    let (cache, reports) = fresh_cache(QUICK);
    cache.load(file.clone());
    assert_eq!(cache.versions_now(&targets, true), ["", ""]);
    assert_eq!(next_report(&reports), report(&[("expired", "expired 1.0.0")], true));
    std::thread::sleep(Duration::from_millis(200));
    let starts = (count_starts(&log, "recent"), count_starts(&log, "expired"));
    let shown = cache.versions_blocking(&targets);
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, (0, 1));
    assert_eq!(shown, ["", "expired 1.0.0"], "the recent failure is still respected");
}

/// `force` forgets answers and failures, so the next list probes again; a round running when
/// it forgets asks its builds again, and its stale answer is never reported.
#[cfg(unix)]
#[test]
fn forgetting_versions_probes_again() {
    let root = scratch("version-forget");
    let log = root.join("runs.log");
    let targets = [target("cli", &fake_cli(&root, "cli", &log, "sleep 0.4\necho 'cli 7.0.0'"))];
    let (cache, reports) = fresh_cache(QUICK);
    assert_eq!(cache.versions_blocking(&targets), ["cli 7.0.0"]);
    assert_eq!(next_report(&reports), report(&[("cli", "cli 7.0.0")], true));

    cache.forget();
    assert_eq!(cache.versions_now(&targets, true), [""]);
    assert_eq!(next_report(&reports), report(&[("cli", "cli 7.0.0")], true));
    assert_eq!(count_starts(&log, "cli"), 2);

    cache.forget();
    assert_eq!(cache.versions_now(&targets, true), [""]);
    std::thread::sleep(Duration::from_millis(100));
    cache.forget();
    assert_eq!(next_report(&reports), report(&[("cli", "cli 7.0.0")], true));
    assert!(reports.recv_timeout(Duration::from_millis(800)).is_err(), "the dropped round reported");
    let starts = count_starts(&log, "cli");
    let remembered = cache.versions_blocking(&targets);
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(starts, 4);
    assert_eq!(remembered, ["cli 7.0.0"]);
}

/// Times the list on a first launch (no saved versions) and a second launch (a new cache loading
/// the first one's file) against the CLIs installed on this machine, with the launch timing, and
/// prints each report until `done`.
#[test]
#[ignore = "Runs --version on every installed agent CLI"]
fn installed_discover_timing() {
    use crate::providers::{installed_paths, provider_infos, version_targets};
    let root = scratch("version-launch");
    let file = root.join(super::CACHE_FILE);
    for launch in ["first", "second"] {
        let (cache, reports) = fresh_cache(Timing::LAUNCH);
        cache.load(file.clone());
        let started = Instant::now();
        let paths = installed_paths();
        let versions = cache.versions_now(&version_targets(&paths), true);
        let providers = provider_infos(paths, versions);
        let elapsed = started.elapsed();
        for provider in &providers {
            println!("{:>16} {:<5} {}", provider.id, provider.installed, provider.version.lines().next().unwrap_or(""));
        }
        println!("{launch} launch: list_providers took {elapsed:?}");
        loop {
            match reports.recv_timeout(Duration::from_secs(90)) {
                Ok(report) => {
                    println!("{launch} launch: provider-versions after {:?}: {}", started.elapsed(), serde_json::to_string(&report).unwrap());
                    if report.done {
                        break;
                    }
                }
                Err(_) => {
                    println!("{launch} launch: no provider-versions event (every version known, none unresolved)");
                    break;
                }
            }
        }
    }
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap_or_default()).unwrap_or_default();
    println!("saved entries: {}", saved["versions"].as_array().map_or(0, Vec::len));
    std::fs::remove_dir_all(&root).unwrap();
}
