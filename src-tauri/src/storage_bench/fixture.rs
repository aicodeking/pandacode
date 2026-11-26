//! The storage benchmark's fixture: a deterministic, file-backed database shaped like a mature
//! PandaCode workspace (see the parent module), plus the temp root and self-removing copies the
//! cases run on. Every id comes from a seeded `Rng::uuid`, so two builds lay out the same tables
//! and indexes.

use crate::providers::{SubagentActivity, ToolActivity};
use crate::storage::{self, Store};
use crate::turn_changes::{Captured, ChangedFile, TurnChangeDiff, TurnChanges};
use rusqlite::params;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

pub(super) const SEED: u64 = 0x5eed_0fda_7aba_5e11;
const PROJECTS: usize = 20;
const SESSIONS: usize = 500;
const TARGET_MESSAGES: usize = 25_000;
const HEAVY_TURNS: usize = 50; // 50 × (user + 4 tools + assistant) = 300 rows, 200 tool rows
const FORK_MESSAGES: usize = 200;
const MIRROR_MESSAGES: usize = 500;
const TEAMS: usize = 40;
const WORKERS_PER_TEAM: usize = 4;
const WORKER_MESSAGES: usize = 4;
const LINKED_SESSIONS: usize = 100; // an issue and a pull each: 200 task_links
const SUBAGENTS: usize = 300;
const HEAVY_SUBAGENTS: usize = 24;
const TURN_CHANGES: usize = 300;
const FILES_PER_CHANGE: usize = 5;
const BOT_MAIN_ACTIVITY: usize = 5_000; // at the per-bot cap, so every log also trims
const BOT_OTHER_ACTIVITY: usize = 500;
/// Every `SWITCH_EVERY`th row of the main bot's activity (from `SWITCH_OFFSET`) is a `model-switch`
/// for the delivery task: 12 of its 5,000 rows, the hits `bots::failover::switches` reads.
const SWITCH_EVERY: usize = 416;
const SWITCH_OFFSET: usize = 207;
const SHARED_CHANNELS: usize = 10;
const CHANNEL_POSTS: usize = 250; // two deliveries each: 500
const MOODBOARD_IMAGES: usize = 64;
const MOODBOARD_ATTACH_SESSIONS: usize = 24; // project 2's tasks minus the mirror
const MOODBOARD_ATTACH_PER_SESSION: usize = 6;
const FILE_ATTACHMENTS: usize = 56; // 144 moodboard + 56 file rows = 200
const SCHEDULES: usize = 100;
const EMPTY_DRAFTS: usize = 5;
pub(super) const DAY_MS: i64 = 86_400_000;
pub(super) const HEAVY: usize = 0; // session indexes; project = index % PROJECTS
pub(super) const FORK: usize = 1;
pub(super) const MIRROR: usize = 2;
const IMPORTED: usize = 7;
const FIRST_LEAD: usize = 3;
const BOT_PROJECT: usize = 1;
pub(super) const MOODBOARD_PROJECT: usize = 2;
pub(super) const DELETE_PROJECT: usize = 5; // no bots: bots.project_id has no ON DELETE CASCADE
const PROVIDERS: [(&str, &str); 5] = [("claude", "claude-opus"), ("codex", "gpt-5-codex"), ("opencode", "kimi-k2"), ("kimi", "kimi-k2"), ("glm", "glm-4.6")];
const TOOL_NAMES: [&str; 6] = ["Bash", "Read", "Edit", "Grep", "Write", "WebFetch"];
const WORDS: [&str; 48] = [
    "the", "agent", "refactor", "storage", "sidebar", "query", "index", "commit", "render", "pipeline", "tests", "passed",
    "failed", "cargo", "tauri", "window", "thread", "message", "layout", "error", "retry", "worktree", "branch", "review",
    "diff", "patch", "schema", "migration", "latency", "cache", "token", "prompt", "response", "subagent", "harness", "model",
    "config", "update", "fix", "feature", "module", "function", "return", "value", "string", "vector", "compile", "warning",
];
pub(super) struct Rng(pub(super) u64);

impl Rng {
    pub(super) fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub(super) fn below(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize }
    pub(super) fn range(&mut self, low: usize, high: usize) -> usize { low + self.below(high - low + 1) }
    pub(super) fn chance(&mut self, percent: u64) -> bool { self.next() % 100 < percent }

    /// A UUID v4 string from 16 seeded bytes, in the format `storage::id` writes.
    pub(super) fn uuid(&mut self) -> String {
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&self.next().to_le_bytes());
        bytes[8..].copy_from_slice(&self.next().to_le_bytes());
        uuid::Builder::from_random_bytes(bytes).into_uuid().to_string()
    }
}

/// 256 KiB of word text; content is sliced from it at seeded offsets.
pub(super) struct Corpus(pub(super) String);

impl Corpus {
    pub(super) fn new(rng: &mut Rng) -> Self {
        let mut text = String::with_capacity(264 * 1024);
        let mut line = 0;
        while text.len() < 256 * 1024 {
            text.push_str(WORDS[rng.below(WORDS.len())]);
            line += 1;
            text.push(if line % 14 == 0 { '\n' } else { ' ' });
        }
        Self(text)
    }

    pub(super) fn take(&self, rng: &mut Rng, len: usize) -> String {
        let len = len.min(self.0.len() - 1);
        let start = rng.below(self.0.len() - len);
        self.0[start..start + len].to_owned()
    }

    pub(super) fn sized(&self, rng: &mut Rng, low: usize, high: usize) -> String {
        let len = rng.range(low, high);
        self.take(rng, len)
    }
}

pub(super) fn tool_json(corpus: &Corpus, rng: &mut Rng, tool_id: &str, status: &str, bytes: usize) -> String {
    let input = corpus.sized(rng, 80, 400);
    let output = corpus.take(rng, bytes.saturating_sub(input.len() + 140).max(16));
    let name = TOOL_NAMES[rng.below(TOOL_NAMES.len())];
    json!({"type": "tool_activity", "version": 1, "id": tool_id, "name": name, "status": status, "input": input, "output": output}).to_string()
}

pub(super) fn subagent(corpus: &Corpus, rng: &mut Rng, id: &str, status: &str, at: i64) -> SubagentActivity {
    let tools = (0..rng.range(10, 20))
        .map(|k| ToolActivity { id: format!("{id}-tool-{k}"), name: TOOL_NAMES[k % TOOL_NAMES.len()].into(), status: "completed".into(), input: corpus.sized(rng, 100, 300), output: corpus.sized(rng, 300, 1200), write_paths: None })
        .collect();
    SubagentActivity { id: id.into(), parent_id: None, name: format!("Explore {id}"), prompt: corpus.sized(rng, 300, 800), status: status.into(), response: corpus.sized(rng, 1024, 3072), tools, started_at: at - 60_000, updated_at: at }
}

pub(super) fn captured(corpus: &Corpus, rng: &mut Rng, id: String, files: usize, patch: usize) -> Captured {
    let changed = (0..files).map(|k| ChangedFile { path: format!("src/module_{}/file_{k}.rs", rng.below(40)), old_path: None, status: "modified".into(), additions: Some(rng.range(1, 80)), deletions: Some(rng.range(0, 40)), binary: false, truncated: false }).collect::<Vec<_>>();
    let details = changed.iter().map(|file| TurnChangeDiff { path: file.path.clone(), old_path: None, patch: corpus.take(rng, patch), binary: false, truncated: false, error: None }).collect();
    let summary = TurnChanges { id, additions: changed.iter().filter_map(|f| f.additions).sum(), deletions: changed.iter().filter_map(|f| f.deletions).sum(), files: changed, truncated: false, concurrent: false, attributed: true, error: None };
    Captured { summary, details }
}

/// A saved team: real `TeamSnapshot` shape, ~60 KiB with a 300-entry `config.catalog`.
pub(super) fn team_json(corpus: &Corpus, rng: &mut Rng, lead: &str, workers: &[(String, String)], status: &str, at: i64) -> String {
    let profile = |k: usize| {
        let provider = crate::architect::HARNESSES[k % crate::architect::HARNESSES.len()];
        json!({"id": format!("{provider}:model-{k}"), "name": format!("{provider} model {k} (catalog)"), "provider": provider, "model": format!("{provider}-model-{k}-preview"), "reasoningEffort": if k.is_multiple_of(3) { json!("high") } else { Value::Null }})
    };
    let catalog = (0..300).map(profile).collect::<Vec<_>>();
    let roster = (0..workers.len()).map(profile).collect::<Vec<_>>();
    let workers = workers.iter().enumerate().map(|(k, (worker_id, session_id))| {
        let worker_status = if status == "completed" || status == "stopped" { "completed" } else if k == 0 { "running" } else { "completed" };
        json!({"id": worker_id, "sessionId": session_id, "name": format!("Worker {k}"), "profileId": roster[k]["id"], "provider": roster[k]["provider"], "model": roster[k]["model"], "reasoningEffort": Value::Null,
            "status": worker_status, "assignment": corpus.sized(rng, 1024, 2048), "summary": corpus.sized(rng, 2048, 3072), "error": Value::Null, "dependsOn": [], "files": [format!("src/area_{k}.rs")],
            "readOnly": false, "attempt": 1, "createdAt": at - 3_600_000, "updatedAt": at, "keys": [], "abandoned": false, "resultRevision": 1, "checkpoint": Value::Null, "wroteAt": at})
    }).collect::<Vec<_>>();
    let config = json!({"auto": true, "workers": roster, "catalog": catalog, "maxParallel": 0, "maxRounds": 0, "maxAssignments": 0, "workspace": "shared", "summaryLimit": 2000});
    json!({"sessionId": lead, "toolCatalogVersion": 1, "config": config, "status": status, "round": 3, "revision": 12, "workers": workers, "error": Value::Null,
        "summary": corpus.sized(rng, 512, 1024), "updatedAt": at, "generation": 1, "objective": corpus.sized(rng, 1536, 2048)}).to_string()
}

// ---------------------------------------------------------------------------------------
// Fixture

pub(super) struct TempRoot(pub(super) PathBuf);

impl TempRoot {
    pub(super) fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("pandacode-storage-bench-{label}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir.canonicalize().unwrap())
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// A database copy that removes itself (and its WAL files) after its `Store` is dropped.
pub(super) struct Copy {
    pub(super) store: Option<Store>,
    pub(super) path: PathBuf,
}

impl Copy {
    pub(super) fn store(&self) -> &Store { self.store.as_ref().unwrap() }
}

impl Drop for Copy {
    fn drop(&mut self) {
        drop(self.store.take());
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
        }
    }
}

pub(super) struct Fixture {
    pub(super) root: TempRoot,
    pub(super) pristine: PathBuf,
    pub(super) copies: Cell<usize>,
    pub(super) sessions: Vec<String>,
    pub(super) projects: Vec<String>,
    pub(super) corpus: Corpus,
    pub(super) import_resume_id: String,
    pub(super) fork_last_message: i64,
    pub(super) active_teams: Vec<String>,
    pub(super) active_workers: Vec<String>,
    links_to_refresh: Vec<(String, i64, String)>,
    pub(super) moodboard_id: String,
    pub(super) bots: [String; 2],
    pub(super) channel_id: String,
    pub(super) delivery_session: String,
    /// The task holding the most schedules (ties broken by id).
    pub(super) scheduled_session: String,
    pub(super) summary: String,
}

impl Fixture {
    pub(super) fn heavy(&self) -> &str { &self.sessions[HEAVY] }

    pub(super) fn link_states(&self, state: &str) -> Vec<(String, i64, String, String)> {
        self.links_to_refresh.iter().map(|(kind, number, title)| {
            (kind.clone(), *number, state.to_owned(), format!("{title} ({state})"))
        }).collect()
    }

    pub(super) fn seed_solo_history(&self, sid: &str, rng: &mut Rng, ids: &mut Rng) -> Copy {
        let copy = self.open_copy("solo-history");
        let store = copy.store();
        let tx = store.db.unchecked_transaction().unwrap();
        let now = storage::now();
        tx.execute(
            "INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,title_origin)
             VALUES(?1,?2,'Solo history','claude','claude-opus','full','idle',?3,?4,'auto')",
            params![sid, self.projects[HEAVY], now - DAY_MS, now],
        ).unwrap();
        // Older turns can keep their summaries after their diff previews have been pruned.
        {
            let mut message = tx.prepare("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'changes','',?2) RETURNING id").unwrap();
            let mut change = tx.prepare("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at) VALUES(?1,?2,?3,?4,?5)").unwrap();
            for n in 0..250 {
                let at = now - (250 - n) * 60_000;
                let message_id: i64 = message.query_row(params![sid, at], |row| row.get(0)).unwrap();
                let summary = captured(&self.corpus, rng, ids.uuid(), 67, 0).summary;
                let json = serde_json::to_string(&summary).unwrap();
                assert!((7 * 1024..=9 * 1024).contains(&json.len()), "solo history summaries should be ~8 KiB");
                change.execute(params![summary.id, sid, message_id, json, at]).unwrap();
            }
        }
        tx.commit().unwrap();
        store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        copy
    }

    pub(super) fn copy_path(&self, label: &str) -> PathBuf {
        let n = self.copies.get();
        self.copies.set(n + 1);
        let path = self.root.0.join(format!("copy-{n:03}-{label}.db"));
        std::fs::copy(&self.pristine, &path).unwrap();
        path
    }

    /// A fresh copy of the pristine database, not yet opened; removed when dropped.
    pub(super) fn unopened_copy(&self, label: &str) -> Copy { Copy { store: None, path: self.copy_path(label) } }

    /// A fresh copy of the pristine database opened with `Store::open` (startup recovery runs).
    pub(super) fn open_copy(&self, label: &str) -> Copy {
        let path = self.copy_path(label);
        Copy { store: Some(Store::open(&path).unwrap()), path }
    }

    /// Store::open interrupts running teams and tasks, as at a real startup; put back the live
    /// state a running app has (two working teams with one running worker each).
    pub(super) fn make_live(&self, store: &Store) {
        for (k, lead) in self.active_teams.iter().enumerate() {
            let status = if k == 0 { "running" } else { "waiting" };
            store.db.execute("UPDATE architect_teams SET content=json_set(content,'$.status',?2,'$.error',NULL) WHERE session_id=?1", params![lead, status]).unwrap();
        }
        for worker in &self.active_workers {
            store.db.execute("UPDATE sessions SET status='running' WHERE id=?1", [worker]).unwrap();
        }
    }
}

struct Builder<'a> {
    store: &'a Store,
    rng: Rng,
    corpus: Corpus,
    messages: usize,
    handoffs: bool,
    first_user: HashMap<String, i64>,
}

impl Builder<'_> {
    fn insert_message(&mut self, sid: &str, role: &str, content: &str, at: i64, tool_id: Option<&str>) -> i64 {
        let duration = (role == "user").then(|| self.rng.range(4_000, 600_000) as i64);
        self.store.db.prepare_cached("INSERT INTO messages(session_id,role,content,created_at,tool_id,turn_duration_ms) VALUES(?1,?2,?3,?4,?5,?6)").unwrap()
            .execute(params![sid, role, content, at, tool_id, duration]).unwrap();
        self.messages += 1;
        let id = self.store.db.last_insert_rowid();
        if role == "user" {
            self.first_user.entry(sid.to_owned()).or_insert(id);
        }
        id
    }

    /// One turn: a user prompt, `tools` tool rows, an assistant reply. Returns the last id.
    fn turn(&mut self, sid: &str, at: &mut i64, tools: usize, tool_bytes: (usize, usize), search_hit: bool) -> i64 {
        let mut prompt = self.corpus.sized(&mut self.rng, 200, 1500);
        if search_hit {
            prompt.push_str(" please fix the deploy_pipeline step");
        }
        self.insert_message(sid, "user", &prompt, *at, None);
        for _ in 0..tools {
            *at += self.rng.range(2_000, 30_000) as i64;
            let tool_id = format!("toolu_{:016x}", self.rng.next());
            let bytes = self.rng.range(tool_bytes.0, tool_bytes.1);
            let content = tool_json(&self.corpus, &mut self.rng, &tool_id, "completed", bytes);
            self.insert_message(sid, "tool", &content, *at, Some(&tool_id));
        }
        *at += self.rng.range(5_000, 60_000) as i64;
        let reply = self.corpus.sized(&mut self.rng, 1024, 4096);
        let id = self.insert_message(sid, "assistant", &reply, *at, None);
        if self.handoffs && self.rng.chance(3) {
            let handoff = json!({"fromProvider": "codex", "toProvider": "claude", "summary": self.corpus.sized(&mut self.rng, 200, 600)}).to_string();
            self.insert_message(sid, "handoff", &handoff, *at + 1, None);
        }
        *at += self.rng.range(60_000, 3_600_000) as i64;
        id
    }

    /// Turns until the task holds about `target` rows; tool rows are ~64% of the total.
    fn conversation(&mut self, sid: &str, mut at: i64, target: usize, tool_bytes: (usize, usize), hits: u64) -> i64 {
        let start = self.messages;
        let mut last = 0;
        while self.messages - start + 2 <= target {
            let room = target - (self.messages - start) - 2;
            let tools = self.rng.range(2, 6).min(room);
            let hit = self.rng.chance(hits);
            last = self.turn(sid, &mut at, tools, tool_bytes, hit);
        }
        while !self.handoffs && self.messages - start < target {
            let reply = self.corpus.sized(&mut self.rng, 1024, 2048);
            last = self.insert_message(sid, "assistant", &reply, at, None);
        }
        last
    }
}

pub(super) fn build_fixture() -> Fixture {
    let started = Instant::now();
    let root = TempRoot::new("db");
    let pristine = root.0.join("pandacode.db");
    let mut rng = Rng(SEED);
    let corpus = Corpus::new(&mut rng);
    // Ids come from their own stream, so the content stream (and every row's size) is unchanged.
    let mut ids = Rng(SEED ^ 0x1d5_1d5_1d5);
    let now = storage::now();
    let store = Store::open(&pristine).unwrap();
    crate::bots::upgrade(&store.db).unwrap();
    let projects = (0..PROJECTS).map(|i| {
        let dir = root.0.join("projects").join(format!("workspace-{i:02}"));
        std::fs::create_dir_all(&dir).unwrap();
        // add_project mints a random id; the project has no rows yet, so give it a seeded one.
        let id = ids.uuid();
        store.db.execute("UPDATE projects SET id=?2 WHERE id=?1", params![store.add_project(&dir).unwrap().id, id]).unwrap();
        id
    }).collect::<Vec<_>>();
    let transaction = store.db.unchecked_transaction().unwrap();
    let mut b = Builder { store: &store, rng, corpus, messages: 0, handoffs: true, first_user: HashMap::new() };

    // Tasks: all listed, all ranked, a few pinned, limited, with goals or worktrees.
    let sessions = (0..SESSIONS).map(|_| ids.uuid()).collect::<Vec<_>>();
    let mut import_resume_id = String::new();
    for (i, sid) in sessions.iter().enumerate() {
        let (provider, model) = if i == IMPORTED { PROVIDERS[0] } else { PROVIDERS[b.rng.below(PROVIDERS.len())] };
        let created = now - b.rng.range(1, 365) as i64 * DAY_MS;
        let resume_id = (i == IMPORTED || b.rng.chance(70)).then(|| format!("{provider}-{}", ids.uuid()));
        if i == IMPORTED {
            import_resume_id = resume_id.clone().unwrap();
        }
        let worktree = (i == HEAVY || (i != FORK && i != MIRROR && b.rng.chance(15))).then(|| {
            let dir = root.0.join("worktrees").join(format!("wt-{i:03}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(".git"), "gitdir: ../../.git/worktrees/wt\n").unwrap();
            dir.to_string_lossy().into_owned()
        });
        let goal = b.rng.chance(10).then(|| serde_json::to_string(&crate::goal_state::GoalState { thread_id: format!("thread-{i}"), objective: b.corpus.sized(&mut b.rng, 200, 800), status: "paused".into(), token_budget: Some(2_000_000), tokens_used: 120_000, time_used_seconds: 900, created_at: created, updated_at: created + 60_000 }).unwrap());
        let stage = ["in_progress", "review", "completed"][b.rng.below(3)];
        let description = b.corpus.sized(&mut b.rng, 200, 600);
        let title = format!("Task {i}: {}", b.corpus.sized(&mut b.rng, 20, 60).trim());
        b.store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,resume_id,worktree_path,worktree_branch,reasoning_effort,context_used_tokens,context_window,task_stage,task_description,completed_at,goal_state,pinned,sidebar_order,title_origin)
            VALUES(?1,?2,?3,?4,?5,?6,'idle',?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'auto')",
            params![sid, projects[i % PROJECTS], title, provider, model, ["full", "auto", "ask"][i % 3], created, created + DAY_MS / 2, resume_id, worktree, worktree.as_ref().map(|_| format!("pandacode/task-{i}")),
                (i % 4 == 0).then_some("high"), 40_000 + i as i64 * 100, 200_000, stage, description, (stage == "completed").then_some(created + DAY_MS / 2), goal, i % 97 == 50, i as i64]).unwrap();
    }
    b.store.db.execute("UPDATE sessions SET remote_device='bench-host-device',remote_session='host-task-1',remote_synced_id=?2 WHERE id=?1", params![sessions[MIRROR], MIRROR_MESSAGES as i64]).unwrap();

    // Teams: 40 leads, each with 4 hidden worker tasks; two teams are working.
    let mut active_teams = Vec::new();
    let mut active_workers = Vec::new();
    let mut worker_sessions = Vec::new();
    for t in 0..TEAMS {
        let lead = sessions[FIRST_LEAD + t].clone();
        let project = &projects[(FIRST_LEAD + t) % PROJECTS];
        let at = now - (TEAMS - t) as i64 * DAY_MS / 4;
        let workers = (0..WORKERS_PER_TEAM).map(|k| (format!("w{k}"), ids.uuid())).collect::<Vec<_>>();
        for (k, (worker_id, sid)) in workers.iter().enumerate() {
            b.store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,task_stage,title_origin) VALUES(?1,?2,?3,'codex','gpt-5-codex','full','idle',?4,?4,'completed','auto')", params![sid, project, format!("Worker {k}"), at]).unwrap();
            b.store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,?2,?3)", params![lead, worker_id, sid]).unwrap();
            worker_sessions.push((sid.clone(), at));
        }
        let status = match t { 0 => "running", 1 => "waiting", _ if t % 2 == 0 => "completed", _ => "stopped" };
        if t < 2 {
            active_teams.push(lead.clone());
            active_workers.push(workers[0].1.clone());
        }
        let content = team_json(&b.corpus, &mut b.rng, &lead, &workers, status, at);
        b.store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![lead, content]).unwrap();
        for r in 0..3 {
            let request = json!({"assignment": b.corpus.sized(&mut b.rng, 300, 900)}).to_string();
            b.store.db.execute("INSERT INTO architect_requests(parent_session_id,key,kind,content,worker_id) VALUES(?1,?2,'dispatch',?3,?4)", params![lead, format!("req-{r}"), request, format!("w{}", r % WORKERS_PER_TEAM)]).unwrap();
        }
    }

    // Messages: the heavy task, the 200-row fork source, the mirror, workers, then the rest.
    let mut at = now - DAY_MS;
    for _ in 0..HEAVY_TURNS {
        b.turn(&sessions[HEAVY], &mut at, 4, (11 * 1024, 13 * 1024), false);
    }
    b.handoffs = false; // exact row counts for the fork source and the mirror
    let fork_last_message = b.conversation(&sessions[FORK], now - 20 * DAY_MS, FORK_MESSAGES, (4096, 16384), 0);
    b.conversation(&sessions[MIRROR], now - 10 * DAY_MS, MIRROR_MESSAGES, (4096, 16384), 0);
    b.handoffs = true;
    b.store.db.execute("UPDATE messages SET remote_cut=id WHERE id IN (SELECT id FROM messages WHERE session_id=?1 AND role='tool' ORDER BY id DESC LIMIT 2)", [&sessions[MIRROR]]).unwrap();
    for (sid, at) in &worker_sessions {
        let mut t = *at;
        b.turn(sid, &mut t, WORKER_MESSAGES - 2, (1024, 4096), false);
    }
    let fixed = b.messages + TURN_CHANGES;
    let per_task = (TARGET_MESSAGES - fixed) / (SESSIONS - 3);
    for (i, sid) in sessions.iter().enumerate().skip(3) {
        let target = b.rng.range(per_task / 4, per_task * 7 / 4);
        let hits = if i % PROJECTS == HEAVY { 8 } else { 0 };
        let start = now - b.rng.range(2, 360) as i64 * DAY_MS;
        b.conversation(sid, start, target, (4096, 16384), hits);
    }

    // Task links: an issue and a pull on 100 tasks (50 in the heavy task's project).
    let mut links_to_refresh = Vec::new();
    for j in 0..LINKED_SESSIONS {
        let sid = &sessions[j * 5];
        for (kind, number) in [("issue", 1000 + j as i64), ("pull", 2000 + j as i64)] {
            let title = format!("Linked {kind} {number}");
            b.store.db.execute("INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at) VALUES(?1,?2,?3,?4,?5,'open',?6)",
                params![sid, kind, number, format!("https://github.com/example/app/{kind}s/{number}"), title, now - DAY_MS]).unwrap();
            if j % 4 == 0 && links_to_refresh.len() < 20 {
                links_to_refresh.push((kind.to_owned(), number, title));
            }
        }
    }

    // Subagents: 24 on the heavy task (two still running), the rest spread.
    for n in 0..SUBAGENTS {
        let sid = if n < HEAVY_SUBAGENTS { &sessions[HEAVY] } else { &sessions[3 + b.rng.below(SESSIONS - 3)] };
        let status = if n < 2 { "running" } else { "completed" };
        let activity = subagent(&b.corpus, &mut b.rng, &format!("agent-{n}"), status, now - (SUBAGENTS - n) as i64 * 60_000);
        b.store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,?2,?3,?4)", params![sid, activity.id, serde_json::to_string(&activity).unwrap(), activity.updated_at]).unwrap();
    }

    // Turn changes: 300 records of 5 files, 10 on the heavy task.
    for n in 0..TURN_CHANGES {
        let sid = if n < 10 { sessions[HEAVY].clone() } else { sessions[3 + b.rng.below(SESSIONS - 3)].clone() };
        let message = b.insert_message(&sid, "changes", "", now - (TURN_CHANGES - n) as i64 * 600_000, None);
        let patch = 1024 + b.rng.below(3072);
        let capture = captured(&b.corpus, &mut b.rng, ids.uuid(), FILES_PER_CHANGE, patch);
        let details = capture.details.iter().map(|d| (d.path.clone(), serde_json::to_string(d).unwrap())).collect::<Vec<_>>();
        let bytes: i64 = details.iter().map(|(_, d)| d.len() as i64).sum();
        b.store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at,diff_bytes) VALUES(?1,?2,?3,?4,?5,?6)", params![capture.summary.id, sid, message, serde_json::to_string(&capture.summary).unwrap(), now, bytes]).unwrap();
        for (path, detail) in details {
            b.store.db.execute("INSERT OR IGNORE INTO turn_change_files(change_id,path,detail) VALUES(?1,?2,?3)", params![capture.summary.id, path, detail]).unwrap();
        }
    }

    // Usage limits go on last: the messages_clear_limit trigger clears them on any insert.
    // Every 50th block: 6 due to resume at reset, 4 still limited.
    for (i, sid) in sessions.iter().enumerate() {
        let (until, resume) = match i % 50 { 20..=25 => (now - 3_600_000, true), 26..=29 => (now + 3_600_000, false), _ => continue };
        b.store.db.execute("UPDATE sessions SET limited_at=?2,limited_until=?3,resume_at_reset=?4 WHERE id=?1", params![sid, until - DAY_MS, until, resume]).unwrap();
    }

    let delivery_session = sessions[BOT_PROJECT + PROJECTS].clone();
    // Bots: two in one project, 5,500 activity rows, 10 shared channels with 500 deliveries.
    let bots = [ids.uuid(), ids.uuid()];
    for (k, bot) in bots.iter().enumerate() {
        b.store.db.execute("INSERT INTO bots(id,name,role,project_id,provider,model,mode,created_at,updated_at) VALUES(?1,?2,'Helper',?3,'claude','claude-opus','full',?4,?4)", params![bot, format!("Bot {k}"), projects[BOT_PROJECT], now - 90 * DAY_MS]).unwrap();
        for n in 0..if k == 0 { BOT_MAIN_ACTIVITY } else { BOT_OTHER_ACTIVITY } {
            let switch = k == 0 && n % SWITCH_EVERY == SWITCH_OFFSET;
            let detail = if switch {
                json!({"sessionId": delivery_session, "cause": "limit", "back": false, "provider": "codex", "model": "gpt-5-codex"})
            } else {
                json!({"channel": "slack", "text": b.corpus.sized(&mut b.rng, 150, 400)})
            }.to_string();
            let summary = b.corpus.sized(&mut b.rng, 60, 160);
            let kind = if switch { "model-switch" } else { ["message", "reply", "tool", "heartbeat"][n % 4] };
            b.store.db.prepare_cached("INSERT INTO bot_activity(bot_id,kind,summary,detail,at) VALUES(?1,?2,?3,?4,?5)").unwrap()
                .execute(params![bot, kind, summary, detail, now - 90 * DAY_MS + n as i64 * 60_000]).unwrap();
        }
    }
    let channels = (0..SHARED_CHANNELS).map(|_| ids.uuid()).collect::<Vec<_>>();
    for (k, channel) in channels.iter().enumerate() {
        b.store.db.execute("INSERT INTO bot_shared_channels(id,name,lead_bot_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)", params![channel, format!("channel-{k}"), bots[0], now - 30 * DAY_MS]).unwrap();
        for (position, bot) in bots.iter().enumerate() {
            b.store.db.execute("INSERT INTO bot_shared_channel_members(channel_id,bot_id,position) VALUES(?1,?2,?3)", params![channel, bot, position as i64]).unwrap();
        }
    }
    for n in 0..CHANNEL_POSTS {
        let channel = &channels[n % SHARED_CHANNELS];
        let post = ids.uuid();
        let open = n + 2 >= CHANNEL_POSTS;
        let status = if open { "in_progress" } else { "completed" };
        let created = now - (CHANNEL_POSTS - n) as i64 * 300_000;
        b.store.db.execute("INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at) VALUES(?1,?2,'user',?3,?4,?5)", params![post, channel, b.corpus.sized(&mut b.rng, 100, 400), status, created]).unwrap();
        for bot in &bots {
            let sid = if open { delivery_session.clone() } else { sessions[3 + b.rng.below(SESSIONS - 3)].clone() };
            b.store.db.execute("INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,depth,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)", params![ids.uuid(), channel, post, bot, sid, status, (n % 3) as i64, created]).unwrap();
        }
    }

    // A 64-image moodboard (~12 MB of blobs) and 200 attachment rows.
    let moodboard_id = ids.uuid();
    b.store.db.execute("INSERT INTO moodboards(id,project_id,name,created_at,updated_at) VALUES(?1,?2,'Brand refresh',?3,?3)", params![moodboard_id, projects[MOODBOARD_PROJECT], now - 7 * DAY_MS]).unwrap();
    let blob = (0..128 * 1024).map(|_| b.rng.next() as u8).collect::<Vec<u8>>();
    let images = (0..MOODBOARD_IMAGES).map(|_| ids.uuid()).collect::<Vec<_>>();
    for (k, image) in images.iter().enumerate() {
        let mut original = blob.clone();
        original[..8].copy_from_slice(&(k as u64).to_le_bytes());
        b.store.db.execute("INSERT INTO moodboard_images(id,board_id,name,mime_type,width,height,original,thumbnail,agent_image,created_at) VALUES(?1,?2,?3,'image/jpeg',1600,1200,?4,?5,?6,?7)",
            params![image, moodboard_id, format!("ref-{k}.jpg"), original, &blob[..8 * 1024], &blob[..48 * 1024], now - 7 * DAY_MS + k as i64]).unwrap();
    }
    let board_sessions = sessions.iter().enumerate().filter(|(i, _)| i % PROJECTS == MOODBOARD_PROJECT && *i != MIRROR).map(|(_, s)| s.clone()).take(MOODBOARD_ATTACH_SESSIONS).collect::<Vec<_>>();
    for (n, sid) in board_sessions.iter().enumerate() {
        let message = b.first_user[sid];
        for image in images.iter().skip(n * 2).take(MOODBOARD_ATTACH_PER_SESSION) {
            b.store.db.execute("INSERT INTO message_attachments(message_id,session_id,id,kind,name,mime,width,height,bytes,file,source,moodboard_id,moodboard_image_id) VALUES(?1,?2,?3,'image','ref.jpg','image/jpeg',1600,1200,?4,NULL,'moodboard',?5,?3)",
                params![message, sid, image, blob.len() as i64, moodboard_id]).unwrap();
        }
    }
    for n in 0..FILE_ATTACHMENTS {
        let sid = &sessions[3 + (n * 7) % (SESSIONS - 3)];
        let id = ids.uuid();
        b.store.db.execute("INSERT INTO message_attachments(message_id,session_id,id,kind,name,mime,width,height,bytes,file,source) VALUES(?1,?2,?3,'image','screenshot.png','image/png',1440,900,250000,?4,'file')",
            params![b.first_user[sid], sid, id, format!("attachments/{id}.png")]).unwrap();
    }

    // Schedules: 100, some agent-created, some waiting on another task.
    for n in 0..SCHEDULES {
        let sid = &sessions[3 + b.rng.below(SESSIONS - 3)];
        let kind = ["interval", "daily", "weekdays", "after"][n % 4];
        let watch = (kind == "after").then(|| sessions[3 + b.rng.below(SESSIONS - 3)].clone());
        let by_agent = n % 3 == 0;
        b.store.db.execute("INSERT INTO task_schedules(id,session_id,title,prompt,kind,interval_minutes,time_of_day,watch_session_id,next_run_at,enabled,created_by,created_by_session,run_count,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?11,?12,?13,?13)",
            params![ids.uuid(), sid, format!("Schedule {n}"), b.corpus.sized(&mut b.rng, 100, 400), kind, (kind == "interval").then_some(60), matches!(kind, "daily" | "weekdays").then_some("09:00"), watch,
                (kind != "after").then_some(now + (n as i64 + 1) * 600_000), if by_agent { "agent" } else { "user" }, by_agent.then(|| sid.clone()), n as i64 % 7, now - 30 * DAY_MS]).unwrap();
    }
    transaction.commit().unwrap();
    let messages = b.messages;
    let corpus = b.corpus;
    drop(store);

    // Reopen once, as a mature database has been, then leave the state a quit app leaves:
    // two working teams, a few running tasks and some empty drafts for the next startup.
    let store = Store::open(&pristine).unwrap();
    let fixture = Fixture { root, pristine: pristine.clone(), copies: Cell::new(0), sessions, projects, corpus, import_resume_id, fork_last_message, active_teams, active_workers, links_to_refresh, moodboard_id, bots, channel_id: channels[0].clone(), delivery_session, scheduled_session: String::new(), summary: String::new() };
    fixture.make_live(&store);
    for sid in fixture.sessions.iter().skip(60).take(3) {
        store.db.execute("UPDATE sessions SET status='running' WHERE id=?1", [sid]).unwrap();
    }
    for _ in 0..EMPTY_DRAFTS {
        store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,draft,title_origin) VALUES(?1,?2,'New conversation','claude','claude-opus','full','idle',?3,?3,1,'auto')", params![ids.uuid(), fixture.projects[0], now]).unwrap();
    }
    assert!(crate::architect::load(&store, &fixture.active_teams[0]).unwrap().is_some(), "team snapshot must parse");
    let count = |table: &str| store.db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap();
    let tables = ["projects", "sessions", "messages", "task_links", "subagents", "architect_teams", "architect_workers", "architect_requests", "turn_changes", "turn_change_files", "bot_activity", "bot_shared_channel_deliveries", "moodboard_images", "message_attachments", "task_schedules"];
    let counts = tables.iter().map(|t| format!("{t}={}", count(t))).collect::<Vec<_>>().join(", ");
    let scheduled_session = store.db.query_row("SELECT session_id FROM task_schedules GROUP BY session_id ORDER BY COUNT(*) DESC, session_id LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap();
    let switches = store.db.query_row("SELECT COUNT(*) FROM bot_activity WHERE kind='model-switch'", [], |r| r.get::<_, i64>(0)).unwrap();
    let tool_share = store.db.query_row("SELECT 100.0*SUM(role='tool')/COUNT(*) FROM messages", [], |r| r.get::<_, f64>(0)).unwrap();
    let team_kib = store.db.query_row("SELECT AVG(length(content))/1024.0 FROM architect_teams", [], |r| r.get::<_, f64>(0)).unwrap();
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(store);
    let bytes = std::fs::metadata(&pristine).unwrap().len();
    if let Some(export) = std::env::var_os("PANDACODE_STORAGE_BENCH_EXPORT") {
        std::fs::copy(&pristine, &export).unwrap();
    }
    let summary = format!("built in {:.1} s ({messages} messages inserted): {counts}, model-switch={switches}; tool rows {tool_share:.1}%; team snapshot avg {team_kib:.1} KiB; file {:.1} MiB", started.elapsed().as_secs_f64(), bytes as f64 / 1048576.0);
    Fixture { summary, scheduled_session, ..fixture }
}
