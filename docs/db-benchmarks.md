# Database benchmarks

The SQLite fixture models a mature workspace with 20 projects, 665 sessions, about 25,000 messages, and teams, subagents, turn changes, bots, schedules, a moodboard and a Connect mirror. The [test-only harness](../src-tauri/src/storage_bench.rs) and its [seeded fixture](../src-tauri/src/storage_bench/fixture.rs) run against real file-backed databases.

The recorded 54-case comparison used a development build that advanced the schema to 38. PandaCode 0.3.155 retains `PRAGMA user_version = 37` for full 0.3.151–0.3.154 read-only rollback compatibility. On first launch it installs the same additive indexes and trackers with `PRAGMA temp_store = FILE` during DDL so index sorts can spill to disk.

## How to run

Run one benchmark process at a time to avoid overlapping its disk I/O.

```sh
# The 54 paired cases.
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_all -- --ignored --exact --nocapture --test-threads=1

# The one-time migration at two scales. Alternate 1x_first and 2x_first across invocations.
PANDACODE_BENCH_MIGRATION_ORDER=1x_first CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_migration -- --ignored --exact --nocapture --test-threads=1
```

Each invocation prints a table and one JSON line per case. JSON timings are in milliseconds rounded to six fractional digits. Destructive workloads get a fresh copy per sample. Fast lookup workloads batch consecutive calls and report per-call time. Set `PANDACODE_STORAGE_BENCH_EXPORT=<file>` to retain the pristine fixture for `sqlite3` inspection.

Rebuild both baselines from the version 38 checkout using the checked-in harness, fixture and patches. Set `baseline_dir` to an absolute path for a detached worktree. [Baseline patch](../scripts/db-bench-baseline.patch) · [Connection settings patch](../scripts/db-bench-settings.patch)

```sh
git worktree add --detach "$baseline_dir" f7961a0a
mkdir -p "$baseline_dir/src-tauri/src/storage_bench"
cp src-tauri/src/storage_bench.rs "$baseline_dir/src-tauri/src/"
cp src-tauri/src/storage_bench/fixture.rs "$baseline_dir/src-tauri/src/storage_bench/"
git -C "$baseline_dir" apply "$PWD/scripts/db-bench-baseline.patch"

export CARGO_TARGET_DIR="$PWD/src-tauri/target" CARGO_INCREMENTAL=0
(cd "$baseline_dir" && cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib --no-run --message-format=json)
```

Copy the `pandacode_lib` test executable named in Cargo's JSON output to the artifact directory as `before_bin`. Apply the settings patch with `git -C "$baseline_dir" apply "$PWD/scripts/db-bench-settings.patch"` and repeat the build in the detached worktree. Archive that executable as `before_settings_bin`. Build from the version 38 checkout last and archive its executable as `after_bin`. Run `db_bench_all` from the archived executables in the schedules below and `db_bench_migration` from AFTER in alternating order.

To replay the comparison to stdout without writing files, run the analysis script:

```sh
python3 scripts/db-bench-compare.py <artifact-dir>
```

Replay reads the pinned `BEFORE_REV` from `before_build.txt`. Use `--before-rev` to supply a missing revision or verify the recorded one. `prepare_cached_sites.txt` supplies the call-site counts when present, so replay produces the same stdout without a Git checkout even after `HEAD` advances.

Use `--write-doc docs/db-benchmarks.md` to save Markdown, `--write-inventory <path>` to save the call-site inventory, and `--repo <path>` to select the source checkout for the inventory. The [analysis script](../scripts/db-bench-compare.py) expects the three archived `*_bin` files, their `*_build.txt` records, `binaries.sha256`, `run_all.out` and the 27 run logs with their metadata headers and exit footers. Runs are named `b1.txt` through `b6.txt` and `a1.txt` through `a6.txt` for A/B, `ablation_b1.txt` through `ablation_b3.txt` (and the corresponding `p` and `a` files) for ablation, and `m1.txt` through `m6.txt` for migration.
Optional `benchmark_build_overlap.log` and `migration_build_overlap.log` files record observed overlap with a build from another checkout.

The first line of each log records `RUN`, `SLOT` and one of `SIDE`, `CONFIG` or `ORDER`. Additional lines record `BIN_SHA256`, `CMD`, `START_UTC`, `START_LOAD`, `EXIT`, `END_UTC` and `END_LOAD`. Use timestamps in `YYYY-MM-DDTHH:MM:SSZ` format and 1/5/15-minute load averages. The runner transcript records each run ID and `EXIT` in sequence.

## How the numbers were made

- B (BEFORE) uses commit `f7961a0a` and its version 37 storage. The detached harness exposes the equivalent entry points and shares AFTER's fixture, case order, notes, batching, warm-ups and sample counts.
- P (BEFORE with v38 settings) changes only the four settings in `Store::open` described in section 6.
- A (AFTER) uses the version 38 working tree. All three test binaries use `fast-release` with `CARGO_INCREMENTAL=0`. The 27 invocations ran sequentially on one shared host.

## Results

| Binary | SHA-256 |
|---|---|
| B | `5b66dbcd7bcb02261ffdeba45518139472072c8c1801d0c7eac6badb91cc3e9c` |
| P | `bec1edb0e95297ccfc24acfc7ef6b77ebb6b34349dc2cfd7ae7305d74d0c27ea` |
| A | `fba53140e5b24cb373cf9cf4f8ae6dce9dc408cdd10f9c7bc1f53686f8898e29` |

The A/B order was B1 A1 A2 B2 A3 B3 B4 A4 B5 A5 A6 B6. The six BEFORE slots and six AFTER slots each sum to 39. The unit of analysis is each process's p50 for the case. Ratios use BEFORE/AFTER, so > 1× means faster on AFTER. The ratio of minima shows the timing floor.

- `perm p` is the two-sided exact mean-log difference test over all 924 assignments. `FDR q` applies Benjamini–Hochberg to the 54 permutation p-values.
- `rank p` is the two-sided exact Mann–Whitney rank-sum test over those same assignments, using midranks for ties. The classification uses the primary FDR q.
- All 12 A/B and 9 ablation processes exited 0 with identical case names, notes, order and n. All 27 recorded hashes match the three distinct binaries. Sections 7 and 8 record the migration outcomes.

A Rust build in another checkout overlapped part of the A/B or ablation phase.

### 1. Host load and controls

The shared host was under substantial load. The 1-minute load across A/B starts and ends was 10.3–18.7. Median start load was 12.8 on BEFORE and 13.2 on AFTER. The fixed schedule balances linear drift by slot index. Its order was chosen without randomization, so the 924-way permutation p- and q-values are conditional on exchangeability across the 12 slots. The six-pair adjacent sign-flip test checks sensitivity to run order. A formal confirmatory trial would need randomized balanced blocks on an isolated, quiet host.

The controls bypass `Store::open` and use fixed settings. `control_pk_lookup_500` makes 500 primary-key lookups against each binary's fixture database, so the control still sees the schema. `control_write_50` makes 50 autocommit 2 KiB WAL writes to a separate database. The analysis uses the observed timings directly.

- `control_pk_lookup_500` p50 by run in ms. BEFORE 0.497, 0.560, 0.507, 0.525, 0.541, 0.520. AFTER 0.562, 0.504, 0.523, 0.527, 0.519, 0.512. Median ratio 1.00×, perm p 0.9740, rank p 1.0000, FDR q 0.9740.
- `control_write_50` p50 by run in ms. BEFORE 0.487, 0.444, 0.503, 0.533, 0.536, 0.437. AFTER 0.444, 0.455, 0.443, 0.498, 0.435, 0.435. Median ratio 1.12×, perm p 0.0996, rank p 0.0931, FDR q 0.1075.

### 2. Summary

- **Wins** — 45 (44 clear, 1 small).
- **Slowdowns** — 4 (4 trade-offs, 0 small). `remote_mirror_ops/save_subagents_5`, `remote_mirror_ops/save_subagents_5_changing`, `delete_project_cascade`, `architect_team_save`.
- **Neutral** — 5 (0 met nominal p ≤ 0.05 with q > 0.05).

**Order sensitivity (6 adjacent pairs).** The sign-flip test enumerates all 64 sign assignments on the six adjacent log ratios and adjusts over the same cases. Primary FDR-significant cases with pair q > 0.05 (0) — none. Primary non-significant cases with pair q ≤ 0.05 (0) — none. The paired analysis has fewer possible assignments and tests the effect within neighboring runs.

At q ≤ 0.05, a ratio ≥ 1.10× is a clear win and a ratio ≤ 1/1.10× is a trade-off. Significant ratios between those bounds are small wins above 1× and small slowdowns below 1×. Equal medians or q > 0.05 are neutral.

### 3. Full 54-case paired table

The 924-way permutation p- and q-values assume exchangeability across the 12 slots of the fixed balanced schedule. The pair p- and q-values come from sign flips within the six adjacent pairs and show how results change when the comparison is restricted to neighboring runs.

| Case | n | B median ms | B min..max ms | A median ms | A min..max ms | B/A median | B/A min | perm p | FDR q | rank p | pair p | pair q | Class |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `startup_open_recovery` | 15 | 44.583 | 42.666..51.378 | 9.234 | 8.594..10.725 | 4.83× | 4.96× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `startup_open_reopen` | 15 | 7.762 | 7.478..8.688 | 0.972 | 0.861..0.991 | 7.99× | 8.69× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `sidebar_sessions` | 30 | 0.815 | 0.781..0.831 | 0.716 | 0.676..0.747 | 1.14× | 1.15× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `sidebar_sessions_and_reconcile` | 30 | 3.320 | 3.208..3.401 | 0.781 | 0.764..0.833 | 4.25× | 4.20× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `agents_dock_snapshot` | 30 | 3.396 | 3.278..3.687 | 0.877 | 0.850..0.892 | 3.87× | 3.86× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `single_session_lookup` | 25 | 0.07511 | 0.07465..0.07919 | 0.00436 | 0.00422..0.00478 | 17.2× | 17.7× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `control_pk_lookup_500` | 30 | 0.523 | 0.497..0.560 | 0.521 | 0.504..0.562 | 1.00× | 0.99× | 0.9740 | 0.9740 | 1.0000 | 1.0000 | 1.0000 | neutral |
| `control_write_50` | 20 | 0.495 | 0.437..0.536 | 0.443 | 0.435..0.498 | 1.12× | 1.01× | 0.0996 | 0.1075 | 0.0931 | 0.0938 | 0.1013 | neutral |
| `thread_open_message_page` | 50 | 0.386 | 0.364..0.399 | 0.195 | 0.191..0.197 | 1.98× | 1.90× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `thread_open_subagent_rows` | 50 | 0.689 | 0.685..0.712 | 0.330 | 0.327..0.344 | 2.09× | 2.09× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `prompt_activity_calendar` | 20 | 13.609 | 13.097..13.919 | 1.940 | 1.848..1.990 | 7.02× | 7.09× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `search_tasks_project` | 20 | 1.269 | 1.214..1.331 | 0.564 | 0.555..0.579 | 2.25× | 2.19× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `search_tasks_project_miss` | 20 | 1.047 | 0.992..1.093 | 0.348 | 0.344..0.353 | 3.01× | 2.88× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `workspace_root_lookup` | 25 | 0.08847 | 0.08658..0.09344 | 0.00900 | 0.00845..0.00947 | 9.83× | 10.2× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `workspace_root_lock_hold` | 25 | 0.08969 | 0.08569..0.09572 | 0.00217 | 0.00195..0.00238 | 41.4× | 43.9× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `user_turns_count` | 25 | 0.04710 | 0.04498..0.04900 | 0.01101 | 0.01056..0.01153 | 4.28× | 4.26× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `imported_task_lookup` | 25 | 0.03505 | 0.03456..0.03626 | 0.00107 | 0.00098..0.00117 | 32.9× | 35.3× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `due_limit_resumes` | 25 | 0.04991 | 0.04918..0.05172 | 0.00608 | 0.00578..0.00625 | 8.21× | 8.50× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `schedules_list_session` | 25 | 0.03024 | 0.02949..0.03265 | 0.00670 | 0.00634..0.00704 | 4.51× | 4.65× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `update_link_states_20` | 30 | 0.921 | 0.856..0.997 | 0.214 | 0.201..0.228 | 4.30× | 4.25× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `reorder_sessions_500` | 20 | 1.889 | 1.792..1.960 | 1.088 | 1.007..1.143 | 1.74× | 1.78× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `architect_active_scan/scheduler_query` | 30 | 2.051 | 1.989..2.192 | 0.226 | 0.219..0.234 | 9.09× | 9.07× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `architect_active_scan/watchdog_reconcile` | 15 | 1.922 | 1.831..1.963 | 0.00387 | 0.00366..0.00400 | 496× | 501× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `architect_active_scan/watchdog_stale_candidates` | 15 | 1.894 | 1.869..1.950 | 0.01589 | 0.01567..0.01603 | 119× | 119× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `architect_active_scan/is_active_500` | 30 | 2.406 | 2.318..2.478 | 0.451 | 0.438..0.503 | 5.34× | 5.29× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `architect_active_scan/load_active` | 30 | 0.150 | 0.146..0.167 | 0.137 | 0.129..0.144 | 1.10× | 1.13× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | small win |
| `remote_mirror_ops/of` | 25 | 0.00210 | 0.00188..0.00252 | 0.00199 | 0.00186..0.00212 | 1.05× | 1.01× | 0.1602 | 0.1663 | 0.1797 | 0.1250 | 0.1324 | neutral |
| `remote_mirror_ops/unfinished_cut_lookup` | 20 | 0.189 | 0.183..0.198 | 0.00135 | 0.00133..0.00153 | 140× | 138× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `remote_mirror_ops/message_page` | 30 | 0.357 | 0.333..0.366 | 0.177 | 0.175..0.184 | 2.02× | 1.91× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/failover_switches` | 20 | 0.483 | 0.455..0.491 | 0.01070 | 0.01063..0.01095 | 45.1× | 42.9× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/log` | 160 | 0.105 | 0.09696..0.120 | 0.02194 | 0.02158..0.02250 | 4.77× | 4.49× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/log_interleaved` | 160 | 0.108 | 0.103..0.108 | 0.02167 | 0.02150..0.02267 | 4.97× | 4.80× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/activity_page` | 50 | 0.02792 | 0.02725..0.02913 | 0.02756 | 0.02721..0.02804 | 1.01× | 1.00× | 0.1450 | 0.1536 | 0.1017 | 0.2812 | 0.2921 | neutral |
| `bots_log_and_shared_channels/list` | 50 | 0.05758 | 0.05412..0.06300 | 0.00844 | 0.00821..0.00863 | 6.82× | 6.59× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/detail` | 50 | 0.09008 | 0.08942..0.09250 | 0.05233 | 0.05063..0.05367 | 1.72× | 1.77× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `bots_log_and_shared_channels/delivery_lookups` | 25 | 0.06370 | 0.06300..0.06634 | 0.01733 | 0.01691..0.01782 | 3.67× | 3.73× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `streaming_tool_upserts_50` | 30 | 3.535 | 3.425..3.791 | 2.378 | 2.298..2.435 | 1.49× | 1.49× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `streaming_message_inserts_50` | 30 | 3.859 | 3.664..4.602 | 2.133 | 2.005..2.837 | 1.81× | 1.83× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `turn_end_finish_tools_and_subagents` | 20 | 2.831 | 2.670..3.112 | 0.230 | 0.226..0.238 | 12.3× | 11.8× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `turn_changes_persist` | 20 | 0.512 | 0.449..0.526 | 0.261 | 0.246..0.284 | 1.97× | 1.83× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `turn_changes_persist_solo_history` | 20 | 0.545 | 0.476..0.650 | 0.277 | 0.263..0.321 | 1.97× | 1.81× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `turn_changes_persist_dense_team` | 10 | 17.829 | 17.328..18.372 | 1.307 | 1.257..1.352 | 13.6× | 13.8× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `turn_changes_persist_merged_team` | 10 | 30.173 | 29.319..31.998 | 1.300 | 1.235..1.446 | 23.2× | 23.7× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `remote_mirror_ops/store_page_10` | 20 | 0.526 | 0.511..0.555 | 0.231 | 0.225..0.366 | 2.28× | 2.27× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `remote_mirror_ops/save_subagents_5` | 30 | 0.116 | 0.112..0.124 | 0.164 | 0.157..0.178 | 0.71× | 0.71× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | trade-off |
| `remote_mirror_ops/save_subagents_5_changing` | 30 | 0.154 | 0.147..0.158 | 0.223 | 0.220..0.233 | 0.69× | 0.67× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | trade-off |
| `message_queue_ops` | 30 | 0.126 | 0.125..0.168 | 0.04915 | 0.04804..0.05179 | 2.57× | 2.59× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `attachments_link_batch` | 20 | 2.750 | 2.620..3.171 | 0.899 | 0.865..1.301 | 3.06× | 3.03× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `subagent_state_flush` | 20 | 1.224 | 1.185..1.266 | 0.386 | 0.381..0.391 | 3.17× | 3.11× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `conversation_fork_200` | 20 | 18.486 | 18.147..20.109 | 9.909 | 9.618..12.610 | 1.87× | 1.89× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |
| `delete_moodboard_64_images` | 15 | 14.902 | 14.529..15.926 | 15.110 | 14.450..16.750 | 0.99× | 1.01× | 0.3745 | 0.3815 | 0.5887 | 0.4062 | 0.4139 | neutral |
| `delete_project_cascade` | 15 | 70.353 | 68.868..78.217 | 88.958 | 84.065..98.503 | 0.79× | 0.82× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | trade-off |
| `architect_team_save` | 30 | 0.08081 | 0.07913..0.08171 | 0.09215 | 0.08971..0.108 | 0.88× | 0.88× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | trade-off |
| `architect_team_save_1mb` | 30 | 0.659 | 0.654..0.671 | 0.564 | 0.546..0.595 | 1.17× | 1.20× | 0.0022 | 0.0024 | 0.0022 | 0.0312 | 0.0344 | clear win |

<details>
<summary>Workload notes</summary>

- `startup_open_recovery` — first Store::open + discard_empty_drafts after a quit with 2 running teams, 3+2 running tasks, 5 drafts (fresh copy each)
- `startup_open_reopen` — Store::open + discard_empty_drafts on the populated DB (close untimed)
- `sidebar_sessions` — store.sessions() (500 tasks, task_links attached)
- `sidebar_sessions_and_reconcile` — store.sessions() + crate::reconcile_listed, as listed_sessions (empty agents map, 2 active teams)
- `agents_dock_snapshot` — agents_dock::snapshot_in_store, as agents_dock::snapshot after its locks (empty agents map, 2 active teams)
- `single_session_lookup` — store.session(heavy) (batched ×100/sample)
- `control_pk_lookup_500` — pragma-invariant control: 500 sessions primary-key lookups through prepare (not prepare_cached) on its own plain rusqlite connection with fixed PRAGMA cache_size=-1024 and temp_store=DEFAULT, so Store::open's pragmas (cache_size, temp_store) cannot reach it; SQL, connection settings and Rust are identical before and after and only the sessions primary key is used, close to, not completely, schema-independent (reads sessions by primary key on the fixture file itself, whose size and sessions indexes differ between v37 and v38; control_write_50 uses a standalone file outside the fixture)
- `control_write_50` — disk-write control: 50 autocommit INSERT OR REPLACE INTO kv(k,v) of a 2 KiB row (each its own WAL commit) on a standalone file with fixed PRAGMA journal_mode=WAL, synchronous=NORMAL, cache_size=-1024, temp_store=DEFAULT and one table, independent of Store::open and the schema; wal_checkpoint(TRUNCATE) untimed before each sample; a shift measures disk/WAL write skew between runs, not the change
- `thread_open_message_page` — store.message_page(heavy, None): 300 rows, 200 tool rows of ~12 KiB
- `thread_open_subagent_rows` — store.finish_subagents(heavy, stopped) + store.subagent_rows(heavy) (24 children); startup recovery settles the running subagents before warm-up, so every timed call sees the already-settled steady state, as when reopening an existing thread
- `prompt_activity_calendar` — store.prompt_activity(now - 366 d), as the command
- `search_tasks_project` — store.search_tasks(project, "deploy_pipeline", 20)
- `search_tasks_project_miss` — store.search_tasks(project, "zz_no_such_token", 20): scans every chat row
- `workspace_root_lookup` — store.workspace_root(project, Some(heavy)) (worktree with .git file) (batched ×50/sample)
- `workspace_root_lock_hold` — uncontended store-mutex lock/unlock + SQL critical section of AppState::root (BEFORE holds the lock across workspace_root including disk checks; AFTER holds it only across workspace_paths) (batched ×100/sample)
- `user_turns_count` — store.user_turns(heavy) (batched ×100/sample)
- `imported_task_lookup` — store.imported_task("claude", resume_id) (batched ×100/sample)
- `due_limit_resumes` — store.due_limit_resumes(now) (batched ×100/sample)
- `schedules_list_session` — schedules::list(Some(task)) on the task holding the most of the 100 schedules, as schedules_list for a thread (batched ×100/sample)
- `update_link_states_20` — store.update_link_states(project, 20 links), alternating open/closed states and title suffixes each sample
- `reorder_sessions_500` — store.reorder_sessions(10 of 500 ranked tasks), order flipped each run; includes its sessions() reply
- `architect_active_scan/scheduler_query` — architect::runnable_team_rows + TeamSnapshot parse, as next_action_state
- `architect_active_scan/watchdog_reconcile` — watchdog::reconcile_candidates: the active-team query watchdog::reconcile runs every 30 s (batched ×50/sample)
- `architect_active_scan/watchdog_stale_candidates` — watchdog::stale_candidates: settle_stale's one-time startup candidate selection (settle_stale then loads each candidate's full team snapshot, not timed here) (batched ×50/sample)
- `architect_active_scan/is_active_500` — architect::is_active for every listed task: the single-task fallback (listed_sessions uses active_team_session_ids)
- `architect_active_scan/load_active` — architect::load for both active team snapshots (~60 KiB each); two-team total per sample
- `remote_mirror_ops/of` — remote::mirror::of(mirror) (batched ×100/sample)
- `remote_mirror_ops/unfinished_cut_lookup` — remote::mirror::cut_copies(mirror); 2 cut rows of 500 (batched ×100/sample)
- `remote_mirror_ops/message_page` — store.message_page(mirror, None)
- `bots_log_and_shared_channels/failover_switches` — bots::failover::switches(delivery task): the 12 model-switch rows among the 5,500 bot_activity rows, as bot_model_switches (batched ×50/sample)
- `bots_log_and_shared_channels/log` — bots::log on one bot near its 5,000-row cap: 160 consecutive inserts cross a 128-row trim boundary within the window. max_ms is the unattributed tail maximum of the 160 samples
- `bots_log_and_shared_channels/log_interleaved` — bots::log alternating two bots near their 5,000-row caps: 160 consecutive interleaved inserts crossing a 128-row global row-ID trim boundary. max_ms is the unattributed tail maximum of the 160 samples
- `bots_log_and_shared_channels/activity_page` — bots::activity(bot, None, 50)
- `bots_log_and_shared_channels/list` — bots::shared_channels::list (10 channels)
- `bots_log_and_shared_channels/detail` — shared_channels::detail(channel, 200)
- `bots_log_and_shared_channels/delivery_lookups` — shared_channels::current_hop_depth + open_posts for both bots (batched ×50/sample)
- `streaming_tool_upserts_50` — 50 store.tool_message(heavy): 10 new tools × 5 snapshots of ~8 KiB
- `streaming_message_inserts_50` — 50 store.message(heavy), alternating user (300 B) / assistant (2 KiB)
- `turn_end_finish_tools_and_subagents` — store.finish_tools(heavy) + finish_subagents(heavy, stopped); 2 running tools and 1 running child added untimed
- `turn_changes_persist` — turn_changes::persist(heavy) with 10 changed files of ~4 KiB patches
- `turn_changes_persist_solo_history` — turn_changes::persist under the Store mutex with 10 changed files of ~4 KiB patches; solo thread seeded with 250 ~8 KiB summaries on its own fresh copy
- `turn_changes_persist_dense_team` — turn_changes::persist under the Store mutex on its own fresh copy: 4 finished workers with 1,000 interleaved attributed captures (250 each), the newest 250 already rolled up across multiple pages; seeded history restored between samples
- `turn_changes_persist_merged_team` — turn_changes::persist under the Store mutex on its own fresh copy: 4 finished workers with 1,000 interleaved attributed captures (250 each), all 1,000 already rolled up (zero new sources); seeded history restored between samples
- `remote_mirror_ops/store_page_10` — remote::mirror::store_page with 10 new host messages
- `remote_mirror_ops/save_subagents_5` — remote::mirror::save_subagents_in_store with 5 unchanged children (duplicate-replay upsert + trigger check)
- `remote_mirror_ops/save_subagents_5_changing` — remote::mirror::save_subagents_in_store (each sample updates all 5 children with fresh timestamps and tool output text)
- `message_queue_ops` — message_queue::add + list(Some(heavy)) + take of the added entry: a queued follow-up delivered
- `attachments_link_batch` — attachments::link_message_attachments: 4 8×8 PNG captures copied into app data + the 64-image moodboard named in the prompt (68 rows) for a new message in a new task of the moodboard's project (task, message and capture files created untimed)
- `subagent_state_flush` — subagent_state::SubagentState::finish(heavy, stopped): flushes 5 running children (recorded untimed through record, ~10-20 tools each) and settles the task's unfinished children, as at turn end
- `conversation_fork_200` — conversation_fork::at_message on a 200-message task (one copy; forks accumulate)
- `delete_moodboard_64_images` — moodboards::delete_in_store(project, moodboard_id) (the exact DB work of delete_moodboard: targeted board lookup + DELETE cascade of 64 images and 144 attachments); fresh copy each
- `delete_project_cascade` — remove_project_with_team_check on a project of 25 tasks (the exact DB work of remove_project: active/malformed team check + cascade delete of teams, links, changes, schedules); fresh copy each
- `architect_team_save` — the real architect::save of a working team (62.7 KiB snapshot, no Council or lead failure): stamp, refresh_council (no query without Council), serde_json::to_string, then one SAVEPOINT that sets its architect_team_meta row with skip_sync=1 and upserts the snapshot, so the update triggers parse no JSON for an existing team
- `architect_team_save_1mb` — architect::save of the second working team with its objective padded with corpus text to a 1033.8 KiB snapshot (saved once untimed first): the same SAVEPOINT + skip_sync path, so the cost is serializing and writing the large row

</details>

### 4. Trade-offs and write/delete costs

**Tail latency (descriptive median of per-run p95).** AFTER was faster in 49 cases, slower in 5 and tied in 0 across all 54 cases (41 single-call and 13 batch-average). The table includes each non-control case with an AFTER p95 at least 10% higher (B/A ≤ 1/1.10×).

| Case | BEFORE p95 ms | AFTER p95 ms | B/A p95 | Adjacent pairs slower on AFTER |
|---|---:|---:|---:|---:|
| `remote_mirror_ops/save_subagents_5` (single-call p95) | 0.124 | 0.207 | 0.60× | 4 of 6 |
| `remote_mirror_ops/save_subagents_5_changing` (single-call p95) | 0.165 | 0.240 | 0.69× | 4 of 6 |
| `architect_team_save` (single-call p95) | 0.08750 | 0.116 | 0.75× | 5 of 6 |
| `delete_project_cascade` (single-call p95) | 78.270 | 97.884 | 0.80× | 6 of 6 |

The timings include each workload's application-level database work. Section 3 gives the primary A/B status for each case.

- `delete_project_cascade` — BEFORE 70.353 ms, AFTER 88.958 ms (0.79×, FDR q 0.0024, trade-off). Both paths check the `architect_teams` base table directly and run the full cascade. AFTER checks strict `json_valid(content)` and active status inside an immediate transaction before deleting. The cascade also maintains the v38 indexes and removes tracker rows through foreign keys.
- `architect_team_save` — BEFORE 0.08081 ms, AFTER 0.09215 ms (0.88×, FDR q 0.0024, trade-off). AFTER's savepoint sets `skip_sync=1` in `architect_team_meta` before upserting the team. That fixed work keeps scheduler, watchdog and listing queries off the snapshot JSON.
- `architect_team_save_1mb` — BEFORE 0.659 ms, AFTER 0.564 ms (1.17×, FDR q 0.0024, clear win). Serialization and the snapshot write account for more of the total at 1 MiB.
- `remote_mirror_ops/save_subagents_5` — BEFORE 0.116 ms, AFTER 0.164 ms (0.71×, FDR q 0.0024, trade-off). Each timed sample replays the same five child snapshots. BEFORE upserts each row through `Store::save_subagent`. AFTER uses one batch transaction with per-row savepoints and checks the `running_subagents` trigger predicates.
- `remote_mirror_ops/save_subagents_5_changing` — BEFORE 0.154 ms, AFTER 0.223 ms (0.69×, FDR q 0.0024, trade-off). Each sample advances all five timestamps and changes tool output, so the upserts write WAL frames. AFTER commits the changing snapshots through the batch path. BEFORE saves each row individually.
- `conversation_fork_200` — BEFORE 18.486 ms, AFTER 9.909 ms (1.87×, FDR q 0.0024, clear win). Forking inserts a session and copies 200 messages. The v38 writes update the applicable indexes and check the running-tool trigger predicate.
- `delete_moodboard_64_images` — BEFORE 14.902 ms, AFTER 15.110 ms (0.99×, FDR q 0.3815, neutral). Both paths look up the targeted board, then delete it. The cascade removes 64 images and 144 attachments and maintains the two new attachment indexes on AFTER.

**Other writes:**

- `update_link_states_20` — BEFORE 0.921 ms, AFTER 0.214 ms (4.30×, FDR q 0.0024, clear win).
- `reorder_sessions_500` — BEFORE 1.889 ms, AFTER 1.088 ms (1.74×, FDR q 0.0024, clear win).
- `bots_log_and_shared_channels/log` — BEFORE 0.105 ms, AFTER 0.02194 ms (4.77×, FDR q 0.0024, clear win).
- `bots_log_and_shared_channels/log_interleaved` — BEFORE 0.108 ms, AFTER 0.02167 ms (4.97×, FDR q 0.0024, clear win).
- `streaming_tool_upserts_50` — BEFORE 3.535 ms, AFTER 2.378 ms (1.49×, FDR q 0.0024, clear win).
- `streaming_message_inserts_50` — BEFORE 3.859 ms, AFTER 2.133 ms (1.81×, FDR q 0.0024, clear win).
- `turn_end_finish_tools_and_subagents` — BEFORE 2.831 ms, AFTER 0.230 ms (12.3×, FDR q 0.0024, clear win).
- `turn_changes_persist` — BEFORE 0.512 ms, AFTER 0.261 ms (1.97×, FDR q 0.0024, clear win).
- `turn_changes_persist_solo_history` — BEFORE 0.545 ms, AFTER 0.277 ms (1.97×, FDR q 0.0024, clear win).
- `turn_changes_persist_dense_team` — BEFORE 17.829 ms, AFTER 1.307 ms (13.6×, FDR q 0.0024, clear win).
- `turn_changes_persist_merged_team` — BEFORE 30.173 ms, AFTER 1.300 ms (23.2×, FDR q 0.0024, clear win).
- `remote_mirror_ops/store_page_10` — BEFORE 0.526 ms, AFTER 0.231 ms (2.28×, FDR q 0.0024, clear win).
- `message_queue_ops` — BEFORE 0.126 ms, AFTER 0.04915 ms (2.57×, FDR q 0.0024, clear win).
- `attachments_link_batch` — BEFORE 2.750 ms, AFTER 0.899 ms (3.06×, FDR q 0.0024, clear win).
- `subagent_state_flush` — BEFORE 1.224 ms, AFTER 0.386 ms (3.17×, FDR q 0.0024, clear win).

The 160-insert windows capture consecutive inserts on one bot (`log`) and alternating inserts on two bots near their 5,000-row caps (`log_interleaved`).

| Case | Window statistic | BEFORE median ms | AFTER median ms | B/A | Adjacent pairs slower on AFTER |
|---|---|---:|---:|---:|---:|
| `bots_log_and_shared_channels/log` | Per-run mean (`mean_ms`) | 0.122 | 0.02905 | 4.20× | 0 of 6 |
| `bots_log_and_shared_channels/log` | Per-run maximum (`max_ms`) | 1.660 | 0.766 | 2.17× | 0 of 6 |
| `bots_log_and_shared_channels/log_interleaved` | Per-run mean (`mean_ms`) | 0.114 | 0.02837 | 4.02× | 0 of 6 |
| `bots_log_and_shared_channels/log_interleaved` | Per-run maximum (`max_ms`) | 0.243 | 0.587 | 0.41× | 6 of 6 |

`max_ms` is the unattributed window maximum. The benchmark does not identify which calls hit the trim boundary. `bots::log` trims once per 128 consecutive single-bot inserts, so activity can briefly exceed the cap. With interleaved bots, a quiet bot that logs once per global row-ID block can hit a trim boundary on each insert and scan 5,000 index entries on that insert.

Each team case seeds four finished workers with 250 interleaved attributed captures per worker. `turn_changes_persist_dense_team` starts with the newest 250 pre-merged. `turn_changes_persist_merged_team` starts with all 1,000 pre-merged and zero new sources. The fixture stops at 1,000 captures. Above that, a fully merged team still revisits eligible worker history in adaptive 32→2,048-row index pages over `turn_changes_session` and materializes the parent `teamSources` in linear time under the Store mutex. BEFORE's quadratic `NOT EXISTS` repeatedly re-parses the parent's JSON rollups. `prune_retained` runs `RETAINED_BYTES_SQL` over only the compact covering partial index `turn_changes_retained_bytes WHERE diff_bytes > 0`, whose size is bounded by the `RETAINED_BYTES` retention cap.

### 5. Lock hold and watchdog

- `workspace_root_lock_hold` — BEFORE 0.08969 ms, AFTER 0.00217 ms (41.4×, FDR q 0.0024, clear win). Each call measures uncontended `Mutex::lock`, the SQL critical section and guard release. AFTER calls `workspace_paths` under the guard and ends the timed call at release. In production, the AFTER path performs the disk checks after releasing the guard. BEFORE calls `workspace_root` under the guard, so the same section also includes `canonicalize`, `is_dir` and the `.git` check.

- `workspace_root_lookup` — BEFORE 0.08847 ms, AFTER 0.00900 ms (9.83×, FDR q 0.0024, clear win). This case includes SQL and the filesystem checks on both configurations.
- `architect_active_scan/watchdog_reconcile` — BEFORE 1.922 ms, AFTER 0.00387 ms (496×, FDR q 0.0024, clear win).
- `architect_active_scan/watchdog_stale_candidates` — BEFORE 1.894 ms, AFTER 0.01589 ms (119×, FDR q 0.0024, clear win).
- `architect_active_scan/load_active` — BEFORE 0.150 ms, AFTER 0.137 ms (1.10×, FDR q 0.0024, small win).

The two watchdog cases measure candidate selection. BEFORE uses uncached statement preparation and scans team JSON. AFTER uses prepared queries over `architect_team_meta`. The separate active-team load case measures loading the two full working snapshots.

### 6. Connection-settings ablation

B is BEFORE, P is BEFORE with only the four v38 connection settings, and A is AFTER. The 3×3 Latin square ran B P A / P A B / A B P. Each configuration occupied each block position once and its slots sum to 15. Ratios divide left by right, so > 1× is faster on the right. Separation means all three timings on one side beat all three on the other. The three runs per configuration support descriptive comparisons.

`Store::open` changes `cache_size=-1024` to `-8192`, sets `temp_store=MEMORY` and `journal_size_limit=67108864` (64 MiB), and calls `set_prepared_statement_cache_capacity(256)`. `Store::open_read_only` uses a 4 MiB page cache and memory-backed temporary storage for the Skills manager launch lookup. That lookup uses uncached queries and falls outside this benchmark.

The 1-minute load across ablation starts and ends was 7.6–10.3. BEFORE has 3 non-test `.prepare_cached(` call sites in 2 files. AFTER has 217 in 25 files. `--write-inventory` records each source location.

The three-cell ablation measures the four `Store::open` settings on version 37. A fourth cell with v38 and the old settings would be needed to isolate any interaction between the 256-entry statement cache or 8 MiB page cache and v38's 217 cached call sites. The combined P→A schema and queries step includes those interactions.

| Case | B median ms | P median ms | A median ms | Settings B/P | Schema + queries P/A | Total B/A | B→P | P→A | B→A |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| `startup_open_recovery` | 46.945 | 44.394 | 10.117 | 1.06× | 4.39× | 4.64× | overlap | faster | faster |
| `startup_open_reopen` | 7.684 | 7.507 | 1.105 | 1.02× | 6.79× | 6.95× | overlap | faster | faster |
| `sidebar_sessions` | 0.781 | 0.802 | 0.718 | 0.97× | 1.12× | 1.09× | overlap | faster | faster |
| `sidebar_sessions_and_reconcile` | 3.152 | 3.223 | 0.712 | 0.98× | 4.52× | 4.42× | overlap | faster | faster |
| `agents_dock_snapshot` | 3.308 | 3.384 | 0.810 | 0.98× | 4.18× | 4.08× | overlap | faster | faster |
| `single_session_lookup` | 0.07444 | 0.07723 | 0.00434 | 0.96× | 17.8× | 17.2× | overlap | faster | faster |
| `control_pk_lookup_500` | 0.521 | 0.501 | 0.513 | 1.04× | 0.98× | 1.02× | overlap | overlap | overlap |
| `control_write_50` | 0.449 | 0.434 | 0.508 | 1.03× | 0.85× | 0.88× | overlap | slower | slower |
| `thread_open_message_page` | 0.366 | 0.364 | 0.196 | 1.00× | 1.86× | 1.86× | overlap | faster | faster |
| `thread_open_subagent_rows` | 0.688 | 0.660 | 0.332 | 1.04× | 1.99× | 2.07× | overlap | faster | faster |
| `prompt_activity_calendar` | 13.008 | 15.172 | 1.871 | 0.86× | 8.11× | 6.95× | slower | faster | faster |
| `search_tasks_project` | 1.155 | 0.755 | 0.550 | 1.53× | 1.37× | 2.10× | faster | faster | faster |
| `search_tasks_project_miss` | 0.994 | 0.523 | 0.353 | 1.90× | 1.48× | 2.81× | faster | faster | faster |
| `workspace_root_lookup` | 0.08556 | 0.08671 | 0.00889 | 0.99× | 9.75× | 9.63× | overlap | faster | faster |
| `workspace_root_lock_hold` | 0.08618 | 0.08883 | 0.00214 | 0.97× | 41.5× | 40.2× | overlap | faster | faster |
| `user_turns_count` | 0.04602 | 0.04793 | 0.01037 | 0.96× | 4.62× | 4.44× | overlap | faster | faster |
| `imported_task_lookup` | 0.03449 | 0.03549 | 0.00104 | 0.97× | 34.0× | 33.0× | slower | faster | faster |
| `due_limit_resumes` | 0.04867 | 0.05083 | 0.00584 | 0.96× | 8.71× | 8.34× | overlap | faster | faster |
| `schedules_list_session` | 0.03059 | 0.03210 | 0.00638 | 0.95× | 5.03× | 4.80× | slower | faster | faster |
| `update_link_states_20` | 0.888 | 0.942 | 0.207 | 0.94× | 4.55× | 4.29× | slower | faster | faster |
| `reorder_sessions_500` | 1.884 | 1.907 | 1.023 | 0.99× | 1.86× | 1.84× | overlap | faster | faster |
| `architect_active_scan/scheduler_query` | 2.050 | 2.129 | 0.218 | 0.96× | 9.75× | 9.39× | overlap | faster | faster |
| `architect_active_scan/watchdog_reconcile` | 1.839 | 1.857 | 0.00349 | 0.99× | 532× | 527× | overlap | faster | faster |
| `architect_active_scan/watchdog_stale_candidates` | 1.881 | 1.816 | 0.01583 | 1.04× | 115× | 119× | faster | faster | faster |
| `architect_active_scan/is_active_500` | 2.342 | 2.331 | 0.452 | 1.00× | 5.15× | 5.18× | overlap | faster | faster |
| `architect_active_scan/load_active` | 0.144 | 0.153 | 0.136 | 0.95× | 1.12× | 1.06× | slower | faster | overlap |
| `remote_mirror_ops/of` | 0.00204 | 0.00201 | 0.00194 | 1.01× | 1.04× | 1.05× | overlap | overlap | overlap |
| `remote_mirror_ops/unfinished_cut_lookup` | 0.186 | 0.04233 | 0.00138 | 4.40× | 30.7× | 135× | faster | faster | faster |
| `remote_mirror_ops/message_page` | 0.337 | 0.343 | 0.182 | 0.98× | 1.89× | 1.85× | overlap | faster | faster |
| `bots_log_and_shared_channels/failover_switches` | 0.466 | 0.179 | 0.01081 | 2.61× | 16.5× | 43.1× | faster | faster | faster |
| `bots_log_and_shared_channels/log` | 0.09858 | 0.09767 | 0.02192 | 1.01× | 4.46× | 4.50× | overlap | faster | faster |
| `bots_log_and_shared_channels/log_interleaved` | 0.106 | 0.104 | 0.02258 | 1.02× | 4.63× | 4.70× | overlap | faster | faster |
| `bots_log_and_shared_channels/activity_page` | 0.02779 | 0.02788 | 0.02742 | 1.00× | 1.02× | 1.01× | overlap | overlap | overlap |
| `bots_log_and_shared_channels/list` | 0.05700 | 0.07025 | 0.00842 | 0.81× | 8.35× | 6.77× | slower | faster | faster |
| `bots_log_and_shared_channels/detail` | 0.09067 | 0.132 | 0.05479 | 0.69× | 2.41× | 1.65× | slower | faster | faster |
| `bots_log_and_shared_channels/delivery_lookups` | 0.06262 | 0.104 | 0.01746 | 0.60× | 5.95× | 3.59× | slower | faster | faster |
| `streaming_tool_upserts_50` | 3.652 | 3.296 | 2.425 | 1.11× | 1.36× | 1.51× | overlap | faster | faster |
| `streaming_message_inserts_50` | 3.592 | 3.628 | 2.364 | 0.99× | 1.53× | 1.52× | overlap | faster | faster |
| `turn_end_finish_tools_and_subagents` | 2.890 | 2.560 | 0.261 | 1.13× | 9.81× | 11.1× | faster | overlap | overlap |
| `turn_changes_persist` | 0.514 | 0.544 | 0.285 | 0.95× | 1.91× | 1.80× | overlap | overlap | overlap |
| `turn_changes_persist_solo_history` | 0.482 | 0.536 | 0.285 | 0.90× | 1.88× | 1.69× | overlap | overlap | overlap |
| `turn_changes_persist_dense_team` | 17.934 | 17.691 | 1.340 | 1.01× | 13.2× | 13.4× | overlap | faster | faster |
| `turn_changes_persist_merged_team` | 29.983 | 29.864 | 1.484 | 1.00× | 20.1× | 20.2× | overlap | faster | faster |
| `remote_mirror_ops/store_page_10` | 0.540 | 0.517 | 0.229 | 1.04× | 2.26× | 2.36× | faster | faster | faster |
| `remote_mirror_ops/save_subagents_5` | 0.119 | 0.116 | 0.166 | 1.03× | 0.70× | 0.72× | overlap | slower | slower |
| `remote_mirror_ops/save_subagents_5_changing` | 0.153 | 0.151 | 0.220 | 1.01× | 0.69× | 0.69× | overlap | slower | slower |
| `message_queue_ops` | 0.128 | 0.124 | 0.04738 | 1.03× | 2.62× | 2.71× | faster | faster | faster |
| `attachments_link_batch` | 2.781 | 2.543 | 0.996 | 1.09× | 2.55× | 2.79× | faster | overlap | overlap |
| `subagent_state_flush` | 1.183 | 0.861 | 0.385 | 1.37× | 2.24× | 3.07× | faster | faster | faster |
| `conversation_fork_200` | 17.687 | 15.972 | 11.609 | 1.11× | 1.38× | 1.52× | faster | faster | faster |
| `delete_moodboard_64_images` | 14.831 | 15.323 | 15.977 | 0.97× | 0.96× | 0.93× | overlap | overlap | slower |
| `delete_project_cascade` | 77.412 | 69.657 | 90.606 | 1.11× | 0.77× | 0.85× | overlap | slower | slower |
| `architect_team_save` | 0.08083 | 0.08008 | 0.09212 | 1.01× | 0.87× | 0.88× | overlap | slower | slower |
| `architect_team_save_1mb` | 0.692 | 0.559 | 0.568 | 1.24× | 0.98× | 1.22× | faster | overlap | faster |

`ctrl_bp_band` is 1.0411× and `ctrl_pa_band` is 1.1717×. Each band is the largest of r and 1/r across the two control median ratios for that step. A shift in P moves B/P and P/A in opposite directions by the same factor because P sits in the denominator of B/P and the numerator of P/A. Report both steps against their own control shifts and use the independent 12-run A/B to assess the combined change.

| Control | B min..max ms (max/min) | P min..max ms (max/min) | A min..max ms (max/min) | B/P | P/A |
|---|---:|---:|---:|---:|---:|
| `control_pk_lookup_500` | 0.500..0.528 (1.0549×) | 0.492..0.540 (1.0970×) | 0.495..0.530 (1.0717×) | 1.0411× | 0.9763× |
| `control_write_50` | 0.434..0.452 (1.0422×) | 0.422..0.456 (1.0816×) | 0.465..0.590 (1.2702×) | 1.0346× | 0.8535× |

Across all 54 cases, including 52 non-control cases, the following counts describe the non-control cases.

- **B→P settings** separated faster for 12 of 52. 10 exceeded the control band (`search_tasks_project`, `search_tasks_project_miss`, `remote_mirror_ops/unfinished_cut_lookup`, `bots_log_and_shared_channels/failover_switches`, `turn_end_finish_tools_and_subagents`, `remote_mirror_ops/store_page_10`, `attachments_link_batch`, `subagent_state_flush`, `conversation_fork_200`, `architect_team_save_1mb`). 2 fell within the band (`architect_active_scan/watchdog_stale_candidates`, `message_queue_ops`).
- **B→P settings** separated slower for 8 of 52. 7 exceeded the control band (`prompt_activity_calendar`, `schedules_list_session`, `update_link_states_20`, `architect_active_scan/load_active`, `bots_log_and_shared_channels/list`, `bots_log_and_shared_channels/detail`, `bots_log_and_shared_channels/delivery_lookups`). 1 fell within the band (`imported_task_lookup`).
- **P→A schema and queries** separated faster for 40 of 52. 38 exceeded the control band (`startup_open_recovery`, `startup_open_reopen`, `sidebar_sessions_and_reconcile`, `agents_dock_snapshot`, `single_session_lookup`, `thread_open_message_page`, `thread_open_subagent_rows`, `prompt_activity_calendar`, `search_tasks_project`, `search_tasks_project_miss`, `workspace_root_lookup`, `workspace_root_lock_hold`, `user_turns_count`, `imported_task_lookup`, `due_limit_resumes`, `schedules_list_session`, `update_link_states_20`, `reorder_sessions_500`, `architect_active_scan/scheduler_query`, `architect_active_scan/watchdog_reconcile`, `architect_active_scan/watchdog_stale_candidates`, `architect_active_scan/is_active_500`, `remote_mirror_ops/unfinished_cut_lookup`, `remote_mirror_ops/message_page`, `bots_log_and_shared_channels/failover_switches`, `bots_log_and_shared_channels/log`, `bots_log_and_shared_channels/log_interleaved`, `bots_log_and_shared_channels/list`, `bots_log_and_shared_channels/detail`, `bots_log_and_shared_channels/delivery_lookups`, `streaming_tool_upserts_50`, `streaming_message_inserts_50`, `turn_changes_persist_dense_team`, `turn_changes_persist_merged_team`, `remote_mirror_ops/store_page_10`, `message_queue_ops`, `subagent_state_flush`, `conversation_fork_200`). 2 fell within the band (`sidebar_sessions`, `architect_active_scan/load_active`).
- **P→A schema and queries** separated slower for 4 of 52. 3 exceeded the control band (`remote_mirror_ops/save_subagents_5`, `remote_mirror_ops/save_subagents_5_changing`, `delete_project_cascade`). 1 fell within the band (`architect_team_save`).
- **B→A total** separated faster for 40 of 52. 39 also separated faster at P→A.
- **B→A total** separated slower for 5 of 52. `remote_mirror_ops/save_subagents_5`, `remote_mirror_ops/save_subagents_5_changing`, `delete_moodboard_64_images`, `delete_project_cascade`, `architect_team_save`.

**Ablation and A/B discrepancies.** P→A separated faster while B→A overlapped or separated slower for 1 of 52 cases (`architect_active_scan/load_active`). Ablation B→A separation and primary A/B classification disagreed for 6 of 52 cases (`architect_active_scan/load_active` (B→A overlap at 1.06×, A/B small win at 1.10×, FDR q 0.0024), `turn_end_finish_tools_and_subagents` (B→A overlap at 11.1×, A/B clear win at 12.3×, FDR q 0.0024), `turn_changes_persist` (B→A overlap at 1.80×, A/B clear win at 1.97×, FDR q 0.0024), `turn_changes_persist_solo_history` (B→A overlap at 1.69×, A/B clear win at 1.97×, FDR q 0.0024), `attachments_link_batch` (B→A overlap at 2.79×, A/B clear win at 3.06×, FDR q 0.0024), `delete_moodboard_64_images` (B→A slower at 0.93×, A/B neutral at 0.99×, FDR q 0.3815)).

### 7. Migration at two scales

Six AFTER processes alternated `1x_first` and `2x_first`. Each completed invocation times five opens per scale after one warm-up, using fresh copies of compacted version 37 files.

Completed 6 of 6 invocations. The 1-minute load across all six starts and ends was 8.8–18.0.

A Rust build in another checkout overlapped part of the migration phase.

| Case | Version 37 file | Messages | Median p50 (s) | Min..max p50 (s) | Median per-run max (s) |
|---|---:|---:|---:|---:|---:|
| `migration_v37_to_v38` | 217.6 MiB | 24,717 | 1.048 | 0.971..1.148 | 1.122 |
| `migration_v37_to_v38_2x` | 405.7 MiB | 49,434 | 2.139 | 1.878..2.949 | 2.403 |

| Run | Order | 1× p50 (s) | 2× p50 (s) | 2×/1× |
|---|---|---:|---:|---:|
| M1 | `1x_first` | 1.104 | 2.199 | 1.992× |
| M2 | `2x_first` | 1.012 | 1.975 | 1.950× |
| M3 | `1x_first` | 1.084 | 2.202 | 2.031× |
| M4 | `2x_first` | 0.971 | 1.878 | 1.934× |
| M5 | `1x_first` | 0.984 | 2.078 | 2.113× |
| M6 | `2x_first` | 1.148 | 2.949 | 2.570× |

The median within-run ratio was 2.012× (range 1.934..2.570×).

- `1x_first` (3 completed) — median 1.084 s at 1×, 2.199 s at 2× and 2.031× within runs.
- `2x_first` (3 completed) — median 1.012 s at 1×, 1.975 s at 2× and 1.950× within runs.

The harness checks that a revert and upgrade restores the exact schema before timing. `upgrade_v38` runs synchronously during `Store::open` with a temporary 64 MiB page cache. The steady cache returns to 8 MiB after commit. These runs used a `VACUUM`ed layout and warm OS caches. `db_bench_migration` uses `std::fs::copy` before each sample. On macOS APFS, Rust uses the `clonefile` family (`fclonefileat`) for copy-on-write clones. Timed writes to shared blocks allocate new extents. An in-place upgrade can overwrite materialized blocks. A cold or fragmented database can take longer.

### 8. Raw run log

All 27 attempts appear below in execution order. Binary IDs refer to the hashes in the results introduction. A dash marks a measurement the process did not print.

| Slot | Run | Binary | Workload | Exit | Start (UTC) | End (UTC) | Start load 1/5/15 | End load 1/5/15 | Bench total (s) | Fixture build (s) | File (MiB) |
|---:|---|---|---|---:|---|---|---|---|---:|---:|---:|
| 1 | B1 | B | A/B | 0 | 2026-11-26T03:51:06Z | 2026-11-26T03:51:23Z | 18.72 / 28.43 / 31.32 | 16.35 / 27.28 / 30.84 | 15.9 | 2.3 | 218.3 |
| 2 | A1 | A | A/B | 0 | 2026-11-26T03:51:23Z | 2026-11-26T03:51:30Z | 16.35 / 27.28 / 30.84 | 15.92 / 27.01 / 30.72 | 5.9 | 1.5 | 219.3 |
| 3 | A2 | A | A/B | 0 | 2026-11-26T03:51:30Z | 2026-11-26T03:51:36Z | 15.92 / 27.01 / 30.72 | 15.37 / 26.71 / 30.59 | 5.6 | 1.5 | 219.3 |
| 4 | B2 | B | A/B | 0 | 2026-11-26T03:51:36Z | 2026-11-26T03:51:51Z | 15.37 / 26.71 / 30.59 | 14.12 / 25.88 / 30.23 | 15.4 | 1.7 | 218.3 |
| 5 | A3 | A | A/B | 0 | 2026-11-26T03:51:51Z | 2026-11-26T03:51:56Z | 14.12 / 25.88 / 30.23 | 13.31 / 25.51 / 30.07 | 5.4 | 1.5 | 219.3 |
| 6 | B3 | B | A/B | 0 | 2026-11-26T03:51:57Z | 2026-11-26T03:52:12Z | 13.31 / 25.51 / 30.07 | 12.22 / 24.67 / 29.69 | 15.3 | 1.8 | 218.3 |
| 7 | B4 | B | A/B | 0 | 2026-11-26T03:52:12Z | 2026-11-26T03:52:27Z | 12.22 / 24.67 / 29.69 | 12.22 / 24.08 / 29.39 | 15.4 | 1.8 | 218.3 |
| 8 | A4 | A | A/B | 0 | 2026-11-26T03:52:27Z | 2026-11-26T03:52:33Z | 12.22 / 24.08 / 29.39 | 11.48 / 23.53 / 29.14 | 5.7 | 1.4 | 219.3 |
| 9 | B5 | B | A/B | 0 | 2026-11-26T03:52:33Z | 2026-11-26T03:52:48Z | 11.48 / 23.53 / 29.14 | 11.46 / 22.95 / 28.83 | 15.2 | 1.7 | 218.3 |
| 10 | A5 | A | A/B | 0 | 2026-11-26T03:52:48Z | 2026-11-26T03:52:54Z | 11.46 / 22.95 / 28.83 | 10.86 / 22.63 / 28.68 | 5.5 | 1.4 | 219.3 |
| 11 | A6 | A | A/B | 0 | 2026-11-26T03:52:54Z | 2026-11-26T03:53:00Z | 10.86 / 22.63 / 28.68 | 10.71 / 22.40 / 28.57 | 5.6 | 1.3 | 219.3 |
| 12 | B6 | B | A/B | 0 | 2026-11-26T03:53:00Z | 2026-11-26T03:53:15Z | 10.71 / 22.40 / 28.57 | 10.33 / 21.75 / 28.23 | 15.2 | 1.8 | 218.3 |
| 1 | AB_B1 | B | ablation | 0 | 2026-11-26T03:53:15Z | 2026-11-26T03:53:30Z | 10.33 / 21.75 / 28.23 | 9.87 / 21.09 / 27.88 | 14.9 | 1.7 | 218.3 |
| 2 | AB_P1 | P | ablation | 0 | 2026-11-26T03:53:30Z | 2026-11-26T03:53:46Z | 9.87 / 21.09 / 27.88 | 9.15 / 20.38 / 27.51 | 14.6 | 1.3 | 218.3 |
| 3 | AB_A1 | A | ablation | 0 | 2026-11-26T03:53:46Z | 2026-11-26T03:53:57Z | 9.15 / 20.38 / 27.51 | 8.52 / 19.87 / 27.24 | 11.3 | 1.9 | 219.3 |
| 4 | AB_P2 | P | ablation | 0 | 2026-11-26T03:53:57Z | 2026-11-26T03:54:11Z | 8.52 / 19.87 / 27.24 | 7.58 / 19.11 / 26.84 | 13.4 | 1.1 | 218.3 |
| 5 | AB_A2 | A | ablation | 0 | 2026-11-26T03:54:11Z | 2026-11-26T03:54:16Z | 7.58 / 19.11 / 26.84 | 7.93 / 18.99 / 26.75 | 5.6 | 1.4 | 219.3 |
| 6 | AB_B2 | B | ablation | 0 | 2026-11-26T03:54:16Z | 2026-11-26T03:54:31Z | 7.93 / 18.99 / 26.75 | 8.16 / 18.50 / 26.44 | 15.0 | 1.8 | 218.3 |
| 7 | AB_A3 | A | ablation | 0 | 2026-11-26T03:54:31Z | 2026-11-26T03:54:37Z | 8.16 / 18.50 / 26.44 | 8.15 / 18.33 / 26.33 | 5.8 | 1.4 | 219.3 |
| 8 | AB_B3 | B | ablation | 0 | 2026-11-26T03:54:37Z | 2026-11-26T03:54:53Z | 8.15 / 18.33 / 26.33 | 8.17 / 17.84 / 26.02 | 15.4 | 1.8 | 218.3 |
| 9 | AB_P3 | P | ablation | 0 | 2026-11-26T03:54:53Z | 2026-11-26T03:55:07Z | 8.17 / 17.84 / 26.02 | 8.83 / 17.52 / 25.76 | 13.9 | 1.2 | 218.3 |
| 1 | M1 | A | migration `1x_first` | 0 | 2026-11-26T03:55:07Z | 2026-11-26T03:55:35Z | 8.83 / 17.52 / 25.76 | 11.25 / 17.24 / 25.37 | 28.5 | 1.4 | 219.3 |
| 2 | M2 | A | migration `2x_first` | 0 | 2026-11-26T03:55:35Z | 2026-11-26T03:56:00Z | 11.25 / 17.24 / 25.37 | 11.98 / 16.90 / 25.01 | 25.1 | 1.4 | 219.3 |
| 3 | M3 | A | migration `1x_first` | 0 | 2026-11-26T03:56:00Z | 2026-11-26T03:56:31Z | 11.98 / 16.90 / 25.01 | 17.66 / 17.84 / 25.07 | 30.2 | 1.5 | 219.3 |
| 4 | M4 | A | migration `2x_first` | 0 | 2026-11-26T03:56:31Z | 2026-11-26T03:56:56Z | 17.66 / 17.84 / 25.07 | 15.57 / 17.35 / 24.69 | 25.3 | 1.5 | 219.3 |
| 5 | M5 | A | migration `1x_first` | 0 | 2026-11-26T03:56:56Z | 2026-11-26T03:57:22Z | 15.57 / 17.35 / 24.69 | 14.21 / 16.89 / 24.31 | 25.6 | 1.5 | 219.3 |
| 6 | M6 | A | migration `2x_first` | 0 | 2026-11-26T03:57:22Z | 2026-11-26T03:57:53Z | 14.21 / 16.89 / 24.31 | 18.02 / 17.53 / 24.28 | 31.1 | 1.4 | 219.3 |
