//! Real initialization through the production preparation path, with only launch lookup
//! replaced by a gated local CLI. No installed harness or credentials are used.
use super::*;

type Job = tokio::task::JoinHandle<Result<(), String>>;

struct Fixture {
    id: String,
    dir: PathBuf,
    jobs: Vec<Job>,
    launches: Vec<PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        let id = format!("handshake-cancel-{}", uuid::Uuid::new_v4());
        let dir = std::env::temp_dir().join(&id);
        std::fs::create_dir(&dir).unwrap();
        Self { id, dir, jobs: Vec::new(), launches: Vec::new() }
    }

    fn launch(&self, key: &str, dir: &Path) -> impl std::future::Future<Output = Result<(), String>> + Send + 'static {
        // Both the initializer and a descendant must die when preparation is canceled.
        let script = r#"printf '%s\n' "$$" >> "$1/pids"
sleep 60 &
printf '%s\n' "$!" >> "$1/pids"
IFS= read -r line
printf '%s\n' "$line" >> "$1/requests"
while [ ! -f "$1/answer" ]; do sleep 0.02; done
printf '{"method":"notice","params":{}}\n{"id":1,"result":{}}\n'
while IFS= read -r line; do printf '%s\n' "$line" >> "$1/requests"; done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "handshake-cancel"]).arg(dir);
        let config = RunConfig { session_id: self.id.clone(), ..crate::providers::tests::config("kimi") };
        let epoch = warm::epoch(&self.id);
        let launched = Ok((command, key.to_owned(), self.dir.clone()));
        prewarm_launched(config, None, epoch, Vec::new(), HashSet::new(), launched)
    }

    async fn start(&mut self, key: &str) -> Result<(), String> {
        let dir = self.dir.join(self.launches.len().to_string());
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        self.jobs.push(tokio::spawn(self.launch(key, &dir)));
        self.launches.push(dir.clone());
        require(poll(|| pids(&dir).len() == 2 && dir.join("requests").exists()).await, "fake initializer did not start")
    }

    fn living(&self) -> usize {
        self.launches.iter().flat_map(|dir| pids(dir)).filter(|pid| alive(*pid as i32)).count()
    }

    async fn cleanup(&mut self) -> Result<(), String> {
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
        discard(&self.id);
        for job in &self.jobs { job.abort(); }
        for job in self.jobs.drain(..) { let _ = job.await; }
        // A failing regression must also await cleanup, rather than leaving fake CLIs alive.
        for dir in &self.launches {
            if let Some(pid) = pids(dir).first() { kill_group(*pid); }
        }
        let gone = poll(|| self.living() == 0 && self.launches.iter().all(|dir| pids(dir).first().is_none_or(|pid| !alive(-(*pid as i32))))).await;
        state().spawned.remove(&self.id);
        warm::launch_settled(&self.id);
        eprintln!("{} cleanup: {} owned processes, groups gone={gone}", self.id, self.living());
        require(gone, "owned fake processes or groups survived cleanup")?;
        std::fs::remove_dir_all(&self.dir).map_err(|e| e.to_string())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Panic fallback; normal success and failure both use the awaited cleanup above.
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
        discard(&self.id);
        for job in &self.jobs { job.abort(); }
        for dir in &self.launches {
            if let Some(pid) = pids(dir).first() { kill_group(*pid); }
        }
    }
}

fn pids(dir: &Path) -> Vec<u32> {
    std::fs::read_to_string(dir.join("pids")).unwrap_or_default().lines().filter_map(|pid| pid.parse().ok()).collect()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn poll(mut done: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while !done() {
        if tokio::time::Instant::now() >= deadline { return false; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.to_owned()) }
}

#[tokio::test]
async fn superseding_keys_stop_old_initializers_without_clearing_the_newest() {
    let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
    let mut fixture = Fixture::new();
    let result = async {
        for index in 0..4 {
            fixture.start(&format!("key-{index}")).await?;
            tokio::time::sleep(Duration::from_millis(220)).await;
        }
        let finished = fixture.jobs[..3].iter().filter(|job| job.is_finished()).count();
        let living = fixture.living();
        eprintln!("superseded: {finished}/3 old preparation futures exited; {living}/8 processes alive (expected current pair only)");
        require(finished == 3 && living == 2, "superseded initializers kept running")?;
        for dir in &fixture.launches[..3] {
            require(!alive(-(pids(dir)[0] as i32)), "superseded process group survived")?;
        }
        require(state().starting.get(&fixture.id).is_some_and(|(_, key, ..)| key == "key-3"), "old cleanup cleared the newest generation")?;
        require(!state().spares.contains_key(&fixture.id), "obsolete spare became ready")?;
        std::fs::write(fixture.launches[3].join("answer"), "").map_err(|e| e.to_string())?;
        require(poll(|| fixture.jobs[3].is_finished()).await, "current initializer did not finish")?;
        for job in fixture.jobs.drain(..) { job.await.map_err(|e| e.to_string())??; }
        let mut adopted = take(&fixture.id, "key-3", None, None).await.ok_or("newest spare was not adopted")?;
        adopted.child.kill().await.map_err(|e| e.to_string())?;
        drop(adopted);
        Ok::<_, String>(())
    }.await;
    let cleanup = fixture.cleanup().await;
    cleanup.unwrap();
    result.unwrap();
}

#[tokio::test]
async fn discarding_or_turning_away_stops_initializers_that_never_reply() {
    let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
    for cancel in [discard as fn(&str), other_start, handshake_race::turn_away] {
        let mut fixture = Fixture::new();
        let result = async {
            fixture.start("never-replies").await?;
            let began = std::time::Instant::now();
            cancel(&fixture.id);
            let stopped = poll(|| fixture.jobs[0].is_finished() && fixture.living() == 0).await;
            eprintln!("discard/turn-away: stopped={stopped}, {} processes, elapsed={:?}", fixture.living(), began.elapsed());
            require(stopped, "discarded initialization outlived the one-second cancellation bound")?;
            fixture.jobs.remove(0).await.map_err(|e| e.to_string())??;
            require(!present(&fixture.id), "discarded initializer left a spare or start")
        }.await;
        let cleanup = fixture.cleanup().await;
        cleanup.unwrap();
        result.unwrap();
    }
}

#[tokio::test]
async fn disabling_start_ahead_stops_initialization_without_a_failed_send() {
    let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
    let mut fixture = Fixture::new();
    let result = async {
        fixture.start("disabled").await?;
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(Some(false)));
        warm::changed();
        let stopped = poll(|| fixture.jobs[0].is_finished() && fixture.living() == 0).await;
        eprintln!("start-ahead off: stopped={stopped}, {} processes", fixture.living());
        require(stopped, "disabled initialization kept running")?;
        fixture.jobs.remove(0).await.map_err(|e| e.to_string())??;
        require(!present(&fixture.id), "disabled initialization left a spare or start")
    }.await;
    let cleanup = fixture.cleanup().await;
    cleanup.unwrap();
    result.unwrap();
}

#[tokio::test]
async fn same_key_initialization_completes_and_is_adopted_without_an_extra_spawn() {
    let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
    let mut fixture = Fixture::new();
    let result = async {
        fixture.start("same-key").await?;
        let original = pids(&fixture.launches[0]);
        let generation = state().starting[&fixture.id].0;
        let duplicate = fixture.dir.join("duplicate");
        std::fs::create_dir(&duplicate).map_err(|e| e.to_string())?;
        fixture.launches.push(duplicate.clone());
        fixture.launch("same-key", &duplicate).await?;
        require(!duplicate.join("pids").exists() && current(&fixture.id, generation), "same-key request spawned or replaced the initializer")?;
        std::fs::write(fixture.launches[0].join("answer"), "").map_err(|e| e.to_string())?;
        require(poll(|| fixture.jobs[0].is_finished()).await, "wanted initializer did not complete")?;
        fixture.jobs.remove(0).await.map_err(|e| e.to_string())??;
        fixture.launch("same-key", &duplicate).await?;
        require(!duplicate.join("pids").exists(), "ready same-key spare was replaced")?;
        let mut adopted = take(&fixture.id, "same-key", None, None).await.ok_or("wanted spare was not adopted")?;
        let same_pid = adopted.child.id() == Some(original[0]);
        let replayed = handshake_spare::reply(&adopted.pending).is_some();
        adopted.child.kill().await.map_err(|e| e.to_string())?;
        drop(adopted);
        require(same_pid && replayed, "adoption did not retain the process and initialize reply")?;
        let sent = std::fs::read_to_string(fixture.launches[0].join("requests")).map_err(|e| e.to_string())?;
        require(sent.lines().count() == 1, "initialize was sent more than once")?;
        eprintln!("same-key: one initializer, original PID adopted, one initialize reply replayed");
        Ok::<_, String>(())
    }.await;
    let cleanup = fixture.cleanup().await;
    cleanup.unwrap();
    result.unwrap();
}
