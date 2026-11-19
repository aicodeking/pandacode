# Agent loop benchmark

A three-arm benchmark of `pandacode_explore` using `claude -p`. It is dev-only: there are no npm dependencies and nothing here ships in the app. Method, gates and results are in [docs/agent-loop-benchmark.md](../../docs/agent-loop-benchmark.md).

Each run gets a fresh `git archive` copy under the system temporary folder (`WORK_ROOT`) with a new one-commit repo. `--dangerously-skip-permissions` is only ever used there.

```sh
R="node scripts/agent-bench/run.mjs"
$R --prepare                  # snapshot the explore server and clause; clone and fetch the public repos
$R --check-tasks              # re-derive every gold set from git; no model time
$R --sanity                   # mutation-check the edit tasks; no model time
$R --plan                     # runs and estimated cost; no model time
$R --status                   # spend from the ledger, runs in flight, runs finished per batch
$R --smoke                    # one task and one probe per arm, plus filler calibration; read smoke.json
$R --batch A                  # localization and edits, all arms
$R --batch L --set long       # long context
$R --batch B --set loc --arm before,after --seeds 3,4
$R --batch B --set edit --arm before,after --seeds 3
$R --batch E --set loc --heldout       # add the held-out tasks (reported apart by analyze.mjs)
node scripts/agent-bench/analyze.mjs --runs ~/Library/Caches/pandacode-bench/v2/runs/A,~/Library/Caches/pandacode-bench/v2/runs/B --summary scripts/agent-bench/results/v2.json
node scripts/agent-bench/analyze.mjs --runs scripts/agent-bench/results/runs/v2-A.csv,scripts/agent-bench/results/runs/v2-B.csv   # the same, from the committed CSVs
node scripts/agent-bench/analyze.mjs --runs ~/Library/Caches/pandacode-bench/v2/runs/D --export-csv scripts/agent-bench/results/runs/v4-D.csv
node scripts/agent-bench/dig.mjs errors --runs ~/Library/Caches/pandacode-bench/v2/runs/D   # errors, sizes, seen, edits, empty
```

### Where the data lives

- **Checkouts** (each run's tree, sanity and scan trees, explore roots, replay scratch) are made under `$TMPDIR/pandacode-bench-work` (`WORK_ROOT` in `lib.mjs`; set `PANDACODE_BENCH_WORK` to move them). `pandacode_explore` refuses roots under `~/Library`, `~/.config`, `~/.local` and `~/AppData`, so `assertExplorable` refuses to make a tree there.
- **Raw runs** (transcripts, `run.json`, ledger, snapshots, repo clones) are under `~/Library/Caches/pandacode-bench/`, outside the repo and outside `/tmp`, which macOS clears. The runner's default `--out` is `~/Library/Caches/pandacode-bench/v2`. Round 1's batches are `runs/` (clean) and `runs-v1-blocked-event-loop/` (first) there. `/tmp/pandacode-bench` may still be a symlink to it for older scripts.
- **Per-run CSVs** for every batch are in `results/runs/` (`v1-first`, `v1-clean`, `v2-A`, `v2-B`, `v2-L`, `v4-D`, `v5-E`, `v5-E2`, `v6-Fv2`, `r1-R1`, `saver-S1v3`, `s2-S2`, `s3-S3`): task, arm, seed, steps, times, tokens, cost, recall, precision, pass and explore use, with no paths or transcripts. `analyze.mjs --runs <file>.csv` gives the same summary as the raw directory; a CSV's batch name is its file name.
- **Summaries** are `results/*.json`.
- **Pre-registrations** are in the doc between `<!-- prereg:X -->` markers. `results/preregistrations.jsonl` is append-only: each entry holds the sha256 of its section and task files and of the line before it, and `check.test.mjs` fails if any of them changes; a later entry with `supersedes: X` releases X's task-file pins. Add an entry with `run.mjs --register <batch> --doc <doc> --pins tasks.json,… [--supersedes X] [--note …]`. A deviation goes between `<!-- deviation:<batch>-<n> -->` markers and is registered as soon as it is written: `run.mjs --register <batch>-<n> --marker deviation:<batch>-<n> --doc <doc>`. Every entry records its time.
- **Edit tasks v2** (`tasks-edit-v2.json`, batch F) load only with `--edit-v2`, as the set `edit2`, with their own gate (`editV2Pass`); `--sanity --edit-v2` checks them. `analyze.mjs --holm-cost` makes cost a co-primary beside steps (Holm).

### Replay, with no model time

`replay.mjs` reruns every `pandacode_explore` call of the recorded AFTER localization runs against the current engine, on the same pinned trees (`git archive` of each task's parent, deleted after use), one process per run as the server was. It reports reply bytes per task against the transcripts and an earlier replay, whether each task's gold files still appear in some reply, empty searches inside a glob (and how many now show hits outside it), and call times. It exits non-zero if a gold file stops appearing.

```sh
node scripts/agent-bench/replay.mjs --save base.json             # before a change
node scripts/agent-bench/replay.mjs --compare base.json          # after it
node scripts/agent-bench/replay.mjs --tasks vsc-search-leak --gap-ms 3000 --bin <optimized test binary>
```

It builds the debug test binary itself (with `CARGO_INCREMENTAL=0`, set it to save disk) unless given `--bin`. Times from a debug binary are much slower than the app's. `--gap-ms` waits between calls, as the model's own time does.

| `run.mjs` option | Default | Meaning |
|---|---|---|
| `--batch` | `A` | Batch name. A resumed batch reuses its recorded seed and skips finished runs. |
| `--batch-seed` | random | Seed for job and arm order, saved in the batch's `batch.json` |
| `--arm` | `before,instruction,after` | Arms to run. `after-e` (batch Fv2) is AFTER's server with batch E's `LOOK` (`--prepare --look-e bin-e`), and runs on edit sets only |
| `--set` | `loc,edit` | `loc`, `edit`, `long`; `reuse` (batch R1, with `--edit-v2`) runs arms `none` and `tools` as chains of three Rust edits sharing one agent-made tool store (`custom_tools_mcp_serve`, test-only) |
| `--tasks`, `--seeds` | all, `1,2` | Comma-separated |
| `--model` | `sonnet` | Must resolve to the model pinned in `tasks.json` |
| `--concurrency` | `4` | Parallel runs |
| `--total-budget-usd` | `60` | Everything in the ledger under `--out`, in-flight run caps included |
| `--run-cap-usd` | `1` | Per-run `--max-budget-usd` for localization and edits (long context gets twice it); reserved in the ledger while a run is in flight |
| `--min-free-gib` | `6` | Start nothing below this much free disk; wait up to 60 minutes |
| `--snapshot` | `bin` | Explore server snapshot directory, one per engine version. A batch is pinned to its snapshot. |
| `--server-profile`, `--build-dir` | `fast-release`, none | Cargo profile (the shipped opt-level) and target directory for `--prepare`; every AFTER run records `server.profile` and `server.optLevel` |
| `--no-long` | off | Smoke test without the long-context probe |
| `--force` | off | Rerun finished runs |
| `--heldout` | off | Add `tasks-heldout.json` to the localization set; `batch.json` then pins its hash |
| `--out` | `~/Library/Caches/pandacode-bench/v2` | Raw results, per run in `runs/<batch>/<id>/` |
| `--simulate` | off | POST-HOC gate calibration (Fv2-2): P(pass) of each Fv2 gate with no effect and a true loss of 0.10, from BEFORE's runs in `--sim-runs` (E, E2, Fv2 CSVs); `--sim-reps` (1000; 400 for edit steps). No model time, about 5 minutes |

| `analyze.mjs` option | Meaning |
|---|---|
| `--runs a,b` | Batch directories or per-run CSVs to pool. Each one's gate is also reported alone. Held-out tasks are always reported in their own section. |
| `--export-csv file` | Write one batch directory's runs (every model) as a sanitized CSV |
| `--arms before,after` | The pair to compare; also `instruction,after` and `before,instruction` |
| `--skip-wall` | Leave wall time out, for a batch whose runner clock is not trusted |
| `--summary file` | Write sanitized numbers for the repo. It refuses paths, addresses and tokens. |
| `--holm-cost` | Batch F on: steps and cost are the primary and co-primary on tuned localization (Holm); cost leaves the max-T family everywhere; registered reads say "not shown to be lower/higher" |
| `--descriptive` | An unregistered comparison (Fv2's AFTER-E): every read is "descriptive", no PASS or FAIL, no `pass` in the summary |
| `--saver --strict-rubrics file --no-effect` | POST-HOC (S1v3-2): rescore report answers blind to arm with `results/s1v3-strict-rubrics.json`, and each gate's pass rate resampling NONE against itself |
| `--reuse` | Batch R1: descriptive means by task position and arm (steps, tool saves and runs, cache writes per later step, cost, pass) and every chain's runs; no p-values |

### Token saver benchmark

`saver.mjs` measures what the token saver packs a lead picks for its workers save: arms `NONE` and `CHOSEN` (a tool-less selector call on the lead model picks `tokenSaver` from the shipped lead guidance), seeds 1–5, over `tasks-saver.json` (localization and edit tasks from `tasks.json`, plus report tasks scored by anchored regex rubrics in `metrics.mjs`'s `scoreRubric`, reviews per finding). Every arm runs as a worker does: the worker brief's report sentence before the task, `pandacode_explore` from the `--snapshot` explore server (default `bin-f`) and the `LOOK` clause. Method and pre-registration (S1v3): [docs/token-saver-benchmark.md](../../docs/token-saver-benchmark.md). It writes to `~/Library/Caches/pandacode-bench/saver` with its own ledger and runner lock, and takes the pinned harness, repo clones, `sanity.json` and the explore snapshot from `--from` (the v2 directory). `--prepare` snapshots `src/token-saver.ts` and reads the lead guidance (`LEAD_SAVER_GUIDANCE` in `architect/saver.rs`, added to the lead's rules only when packs are active in its thread or named in team guidance rather than in the dispatch tool description, from `tokenSaver:` onward, plus `token_saver_schema`), the report sentence and `LOOK` from the live sources; a batch refuses to start if any of them changed since. `--simulate` prints the no-effect simulation behind the task-success gate's margin.

```sh
node scripts/agent-bench/saver.mjs --prepare && node scripts/agent-bench/saver.mjs --check-tasks
node scripts/agent-bench/saver.mjs --smoke              # smokeTasks × 2 arms, seed 99
node scripts/agent-bench/saver.mjs --batch S1v3 --run-cap-usd 5
node scripts/agent-bench/analyze.mjs --saver --runs ~/Library/Caches/pandacode-bench/saver/runs/S1v3
```

### Worker launch benchmarks (S2, S3)

`s2.mjs` (batch S2) compares a read-only worker's tool trim against the launch before it. `s3.mjs` (batch S3) compares round 18's worker launch (`Skill` denied, no agent-made tools) against the launch before it, for read-only and writer workers, with a copy of the user's `~/.claude/skills` loaded through `--add-dir` (`--copy-skills`). Both reuse `saver.mjs`'s tasks, checkouts and job order and the pinned harness and `bin-f` from `--from`, and write to `~/Library/Caches/pandacode-bench/s2` and `s3`. Method, registrations and results: [docs/worker-tokens.md](../../docs/worker-tokens.md) (S2) and [docs/worker-tokens-benchmark.md](../../docs/worker-tokens-benchmark.md) (S2 corrections, S3).

```sh
node scripts/agent-bench/s2.mjs --analyze --tools                 # main-agent explore and Bash calls per arm
node scripts/agent-bench/s2.mjs --analyze --strict-rubrics scripts/agent-bench/results/s1v3-strict-rubrics.json
node scripts/agent-bench/s3.mjs --copy-skills && node scripts/agent-bench/s3.mjs --power
node scripts/agent-bench/s3.mjs --batch S3 --min-free-gib 4      # no edits: 3 is the lowest floor allowed
node scripts/agent-bench/s3.mjs --analyze --summary scripts/agent-bench/results/s3-S3.json
```

### GUI launch benchmark (G1)

`gui.mjs` (batch G1) runs the same agent (Claude Code, Sonnet) launched four ways: like plain `claude -p` (PLAIN), like T3 Code (T3: its flags, system append and its 71 MCP tools served by a stand-in, `gui.mjs --t3-stub`), like a PandaCode task in Full access (PANDA: its flags, `app_instructions` and a real task's catalog from the ignored `panda_catalog_mcp_serve` in `src-tauri/src/providers/mcp_host/tests.rs`, with explore, the agent-made tools, change tracking and titles real and every other tool a stub), and like a round 18 team worker (PANDA_W, descriptive). It uses `tasks.json`'s localization and edit tasks and `tasks-edit-v2.json`, the pinned harness and clones from `--from`, an explore snapshot (`bin-g`), and writes to `~/Library/Caches/pandacode-bench/gui`. Method, registration, deviation G1-1 and results: [docs/gui-benchmark.md](../../docs/gui-benchmark.md).

```sh
node scripts/agent-bench/run.mjs --prepare --edit-v2 --snapshot bin-g
node scripts/agent-bench/gui.mjs --prepare        # pins texts, the T3 snapshot, bin-g, the harness; dumps PANDA's catalog
node scripts/agent-bench/gui.mjs --smoke --arm PLAIN,T3,PANDA,PANDA_W --tasks loc-agent-env,e2-ho-etag-commas
node scripts/agent-bench/gui.mjs --batch G1 --arm PLAIN,T3,PANDA,PANDA_W --concurrency 4
node scripts/agent-bench/gui.mjs --analyze --summary scripts/agent-bench/results/gui-G1.json --csv scripts/agent-bench/results/runs/gui-G1.csv
```

## After a restart

Run `--status`, then rerun the same command. The batch resumes with its recorded seed and skips finished runs. The runner stops what the last runner left, charges each run it never ended the larger of its cap and the cost its transcript last reported in `ledger.jsonl` (the real bill can't be known), and reruns it. A second runner on the same `--out` is refused, and so is resuming a batch with a different tool snapshot, harness or task list.

## Keeping results honest

- Metrics are derived from the transcript by `metrics.mjs` every time, so a metric fix reaches old runs. `check.test.mjs` and the other runner tests run in `npm run test:bench`.
- `run.mjs` and `saver.mjs` share one runner core in `lib.mjs` (`claimRunner`, `pinnedSeed`, `seededJobs`, `pool`, `measuredRun`; tests in `runner.test.mjs`).
- Runs record hashes of the prompt, instruction, server binary, explore sources (from `--prepare`, now also covering `providers/mcp_host.rs` and `lib.rs`) and the runner (`run.mjs`, `lib.mjs`, `metrics.mjs`, `ledger.mjs`). `batch.json` pins the binary, sources, harness and task files and records the runner hash; a resume with a changed runner is allowed but noted. Rerun `--prepare` after changing the tool, because runs use the snapshot and not your working tree.
- `tasks-v1.json` holds the gold sets of the v1 runs, which did not record their own.
- Only sanitized summaries and per-run CSVs in `results/` go in the repo: no transcripts or personal paths (`assertSanitized` refuses them).
- `tasks-heldout.json` holds tasks that are never used for tuning. Don't edit it; add a new file and a new pre-registration instead.
- Stop a run with `kill "$(cat <out>/runner.pid)"`, which also stops its children. Only PIDs the runner recorded are signalled, checked against their start time. **Never use `pkill -f 'claude -p'` or any other pattern**: PandaCode's own agents match it, and doing this once killed unrelated tasks.
- Keep slow work in the runner asynchronous. A blocking call stalls the event loop that drains other runs' stdout and inflates their wall clocks.
- Edit tasks need a Rust dependency cache at `<out>/targets/shared`, which each run clones (APFS clones, so macOS only as written). Nothing starts below `--min-free-gib` (6, the lowest allowed with edits; 3 without), a running Rust edit stops the runner at that floor, and edits build with `CARGO_INCREMENTAL=0`: each run's path is new, so incremental data is never reused and only costs disk.
- `scan-edits.mjs <commit...>` finds edit candidates: it reports whether a commit's tests fail at the parent on an assertion or on a build error.
- Public repos are third-party code run with permissions skipped, so their copies lose `.claude`, `.mcp.json` and `CLAUDE.md`. Only add repos you would be happy to run that way. From round 17 `materialize()` removes those (and `CLAUDE.local.md`) anywhere in every tree, PandaCode's too, and each run records `agentFilesRemoved`; `AGENTS.md` is kept.
- Registrations record the sha256 of `analyze.mjs`, `metrics.mjs` and `stats.mjs`; `analyze.mjs` prints a `MISMATCH` line when the code on disk differs from what a batch last registered. Registrations are hash-chained and timestamped by the local clock only.
- `--prepare` copies `src-tauri/Cargo.lock` and `Cargo.toml` into `<snapshot>/build/` and pins them with a fingerprint of `src-tauri/target/debug/deps` (own crates left out); Rust edits build with the copies, `batch.json` pins the hashes, and a run refuses to start if the target's dependencies drifted. `saver.mjs` takes them from its explore snapshot.
