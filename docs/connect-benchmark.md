# PandaConnect benchmark

How long PandaConnect operations take and where the time goes. The benchmark is
`src-tauri/src/remote/bench.rs`, a `#[cfg(test)]` module of ignored tests. It never contacts
the production relay or GitHub.

## Run it

```sh
cd src-tauri
# Optimized, as shipped builds are (numbers below):
cargo test --profile fast-release --lib remote::bench -- --ignored --nocapture --test-threads=1
# Or the plain debug build (crypto and JSON are 5-20x slower):
cargo test --lib remote::bench -- --ignored --nocapture --test-threads=1
# One bench:
cargo test --profile fast-release --lib remote::bench::image_upload -- --ignored --nocapture
```

Keep `--test-threads=1` so benches don't compete for the CPU. A full run takes about 6 min.
`image_upload` takes about 3 min of that because it measures the paced uploads in real time. Set
`PANDACODE_BENCH_OLD=1` to add the rows for the old stop-and-wait upload (about 5 min more).
`task_start_phases` clones the repository the tests run in. Set `PANDACODE_BENCH_REPO=/path/to/repo`
to use another repo. Every bench writes only under the system temp directory and removes what it creates.

| test | measures |
|---|---|
| `crypto_cost` | `crypto::pair_key`, `seal`, `open` and the full send path (stamp + JSON + seal + frame JSON) for 256 B to 180 KB |
| `connect_and_rpc` | WebSocket connect up to the first presence frame, and request→response round trip by reply size, with Nagle on (as `socket.rs` does) and off |
| `first_event_after_send` | `task.send` response, and the first `agent.events` frame with the host's 100 ms flush and without it |
| `task_start_phases` | `start.rs` phases against a local bare `file://` origin: finding (`project_repo` ×10 and `start::origins`, `providers::discover` and `providers::executable`), downloading (full, `--depth 1`, `--filter=blob:none`, `--no-checkout`), preparing (each git step, `create_worktree_with`), and a fresh clone's whole start before and now (in place and worktree) |
| `image_upload` | the real `images::chunks`, `parse_chunk`, `Uploads`, `store` and `images::upload`, sent through the relay (unpaced as the control, and with `PANDACODE_BENCH_OLD=1` the old pacing), for 1 and 4 images of 1 MB and 5 MB |
| `history_sync` | `mirror::sync` over `host::messages_page` + `mirror::store_page`, first sync of 200/1000/3000 messages and a 30-message run-end sync |
| `reconnect_resume` | drop the viewer socket, then backoff, reconnect, `subscribe`, catch-up sync |
| `three_g` | a viewer on 3G (400 kbit/s each way, 400 ms RTT): cold connect + open a 5.4 MB thread, reconnect, open threads of 5.4/5.2/3.6 MB, before (plain frames, afterId from 0), previous (packed frames, newest page first) and now (byte-capped first page, bigger packed pages), and the phone's tail-60 open; see [3G viewer](#3g-viewer). Takes about 70 min at 3 runs (`PANDACODE_BENCH_RUNS=1` for one, `PANDACODE_BENCH_MODES=previous,now` to skip modes) |

### What is real and what is modeled

- **Real code:** `crypto.rs`; `host::Replay`; `host::messages_page`, `PAGE_BUDGET`; `mirror::store_page` on
  in-memory `Store`s; `images::{chunks, parse_chunk, Uploads, store}`; `start::git`, `start::clone_percent`;
  `github_hub::project_repo`; `providers::discover`; `workspace::create_worktree_with`; tokio-tungstenite client
  and server.
- **Re-implemented in the bench, kept to the production logic:** the relay. It forwards `{to, body, ref}` as
  `{from, to, body}`, broadcasts presence on join and leave, answers `ping`/`pong` without spending a token, and
  applies the per-device token bucket from `relay/src/bucket.ts` (20 frames/s, burst 100, kept across reconnects).
  Undeliverable frames come back with their `ref`. The peers re-implement `socket.rs` `send_sealed`,
  `client.rs` `call` (20 s timeout), and the host's ordered request lane. Private constants are copied in with
  their source named (`PACE`, `FLUSH`, first backoff, `MAX_PAGES`).
- **Modeled:** the `wan` profile puts each computer 20 ms one way from the relay, so a request/response takes
  4 hops (≈80 ms), and gives each receiver a 50 Mbit/s downlink. A connect adds 2 RTTs for TCP + TLS 1.3 before
  the upgrade. `loopback` has no delay, no TLS and no Cloudflare edge or Durable Object wake-up.
- **Not measured:** the real network, TLS, Cloudflare, `gh repo clone` (GitHub API + network), the `starting`
  stage (creating the task and spawning a harness) and model latency. The test images are noise PNGs.
  The synthetic history uses a 32-word vocabulary, so its gzip ratio is better than real chat would get.

## Machine

Apple M4 Max (16 cores, 48 GB), macOS 27.0.1, git 2.54.0, rustc 1.93.0, `fast-release` profile
(opt-level "s", as release). Bench repo = this repository: 245 commits, 1205 files, 103 MB bare.

## Fixes: before and after

Bottlenecks 1, 2, 4 and 8 below are fixed in `images.rs` and `start.rs` (`catalog.rs` needed no change: the
per-project origin read is in `start.rs`). Numbers are p50 on the machine above; the "before" column is the
raw output further down, the "after" column is the second raw output.

| operation | before | after |
|---|---:|---:|
| upload 1×1 MB, loopback / wan | 1.09 s / 1.64 s | 0.015 s / 0.39 s |
| upload 4×1 MB, loopback / wan | 4.59 s / 6.66 s | 0.047 s / 1.29 s |
| upload 1×5 MB, loopback / wan | 5.46 s / 7.96 s | 0.056 s / 1.58 s |
| upload 4×5 MB, loopback / wan | 21.9 s / 31.8 s | 11.4 s / 11.5 s |
| relay rate-limit refusals during upload | none (paced) | none (284 chunks) |
| finding: harness check (`require_installed`) | 1.9 s (`providers::discover()`, 14 harnesses; 2.0-4.2 s over runs) | 0.05-0.14 ms (`providers::executable`) |
| finding: origins of 10 projects | 148-156 ms | 0.13 ms |
| fresh clone, in place: clone + prepare | 1.42-1.54 s | 1.12-1.16 s |
| fresh clone, worktree: clone + prepare | 1.51-1.53 s | 1.25-1.27 s |

The two start rows are local `file://` clones, so they show only the steps that moved: the fetch (0.04 s here, a
GitHub round trip or more on the wire), the redundant `rev-parse`/`switch`/`merge` after a clone, and the worktree
start's second checkout. The two runs of each row above came from separate full runs on a machine with other builds
running, so treat differences under about 0.1 s as noise. Transfer time (about 17 s for this repository at
50 Mbit/s) is unchanged. `--depth 1` and `--filter=blob:none` showed no clear gain over a full clone in the two runs
(full 1.03 and 1.24 s, `--depth 1` 1.18 and 1.09 s, `--filter=blob:none` 1.23 and 1.17 s), and they would leave a
shallow or partial repository for the later `git log`, `merge-base` and checkout work, so neither is used.

What changed:

- **Upload** (`images::upload`): a local copy of the relay's bucket (`Budget`) lets the first 80 chunks go at once,
  then 18 a second, so the relay's 100-frame burst and 20/s are never reached by images (20 frames and 2/s stay free for
  prompts and events). Up to 8 chunks are unanswered at a time. Frames are sent in chunk order from one task (each
  request is polled once as soon as it is made, which sends it), and the host runs `image.put` in arrival order on one
  lane per computer, so `Uploads::add`'s in-order check is unchanged. The bucket is shared by every upload from this
  computer, so two quick messages cannot overspend it together. An upload stops at the first failed reply.
- **Harness check**: `require_installed` looks up only the requested harness in the folders the app searches. It no
  longer runs `--version` on every harness.
- **Origins**: `start::origins` reads `remote.origin.url` from `.git/config` (the common directory's for a linked
  worktree). A config it can't read the way `git config --get` does (an `include`, a quoted or escaped value, an
  unusual header) goes to `github_hub::project_repo`, and those run in parallel.
- **Fresh clone**: no fetch right after it (the refs are fresh). A start on the default branch skips `switch` and
  `merge`. A worktree start clones with `--no-checkout` and fills the clone's own working tree (`git reset --hard`)
  at the same time as it creates the worktree, so the two checkouts overlap and the project is whole before the start
  goes on. If the start fails before that, the tree is restored anyway.
- **Cancel**: `start::run_cancellable(app, from, start, Arc<AtomicBool>)` checks the flag before and after the
  harness check, in the clone loop (killing the clone's process group within 100 ms and removing the folder it was
  making, also on timeout), after `pick_branch`, and before the task is created. A worktree made for a cancelled start
  is removed. It returns `Err(start::CANCELLED)` and sends no `error` stage. Once the task exists it is too late.

## Summary (p50)

These are the numbers before the fixes; see the table above for the changed rows.

| operation | loopback | wan (modeled) |
|---|---:|---:|
| connect → first presence | 1.4 ms | 125 ms (3 RTT) |
| RPC, 64 B / 4 KB / 64 KB / 180 KB reply | 0.7 / 0.9 / 3.8 / 7.4 ms | 85 / 86 / 99 / 131 ms |
| seal + open, 180 KB frame | 1.9 ms | – |
| `task.send` → response / first event | 0.4 / 104 ms | 85 / 189 ms |
| first event if the host flushed at once | 0.6 ms | 84 ms |
| finding: `providers::discover()` (14 harnesses) | 1.9–4.2 s (two runs) | same, host-local |
| finding: `project_repo` ×10 projects | 156 ms | same |
| downloading: full clone, 103 MB `.git` (local) | 0.92 s | ≈17 s on the wire at 50 Mbit/s |
| preparing: in-place (fetch + 5 git steps) / worktree | 327 ms / 344 ms | + fetch round trips to GitHub |
| upload 1×1 MB / 4×1 MB / 1×5 MB / 4×5 MB (today) | 1.09 / 4.59 / 5.46 / 21.9 s | 1.64 / 6.66 / 7.96 / 31.8 s |
| same, burst-aware pacing + 8 in flight | 0.015 / 0.047 / 0.056 / 10.3 s | 0.39 / 1.30 / 1.60 / 12.1 s |
| first sync 200 / 1000 / 3000 msgs | 30 / 160 / 286 ms | 0.86 / 3.7 / 6.4 s |
| run-end sync, 30 new msgs (1 page) | 3 ms | 110 ms |
| drop → caught up (incl. 1 s backoff) | 1007 ms | 1317 ms |

## Bottlenecks, ranked by user-visible time

1. **Image upload is stop-and-wait with a fixed 75 ms pace. (Fixed: see above.)** `images.rs:236-246` sends one `image.put`, waits
   for its reply, then waits until 75 ms after the previous send started (`images.rs:24`, `:242`, `:245`).
   - Each chunk costs max(75 ms, RTT + transfer), and the 75 ms applies even though the relay allows a
     100-frame burst (`relay/src/limits.ts:5-6`).
   - On a fast link the pace is the whole cost: 1×1 MB takes 1.09 s instead of 27 ms unpaced, and 4×5 MB takes
     21.9 s instead of 10.4 s with burst-aware pacing.
   - On the `wan` profile the pace costs nothing (Prod ≈ Unpaced ≈ 1.6 s for 1 MB). There the round trip per
     chunk is the cost.
   - Unpaced sending fails at chunk 103 with `undeliverable (rate)`, so pacing is needed past the burst.
   - **Fix:** pace with a local copy of the relay's bucket (send the first ~90 frames at once, then one per
     50 ms) and keep up to 8 chunks in flight. The host's ordered lane (`socket.rs:250-257`) and the relay keep
     them in order, which `Uploads::add` requires.
   - **Measured gain:** `wan` 1×1 MB 1.64→0.39 s, 4×1 MB 6.66→1.30 s, 1×5 MB 7.96→1.60 s, 4×5 MB 31.8→12.1 s;
     loopback 4×5 MB 21.9→10.3 s.
   - **Remaining limit:** past the burst the relay's 20 frames/s caps uploads at about 1.4 MB/s of image data.
     To go faster, take `image.put` off the frame bucket or move bulk bytes to an HTTP upload.
2. **`task.start` runs `providers::discover()` on every start. (Fixed.)** `start.rs:395` calls `require_installed`
   (`start.rs:372-373`). That runs `--version` on every installed harness, one after another, each with a 2 s
   timeout (`providers.rs:630-641`, `:608`).
   - Measured with 14 harnesses installed: 1.87 s p50 (2.94 s p95) in one run and 4.19 s p50 (6.51 s p95) in
     another.
   - **Fix:** check only the requested provider's executable (`providers::executable(id)`) without
     `--version`, or reuse a cached discovery.
   - **Expected gain:** 1.9-4.2 s per remote start, down to milliseconds.
3. **First history sync is serial, uncompressed and capped.**
   - `mirror.rs:211-226` requests one ≤180 KB page per round trip (`host.rs:36`) and stops after 50 pages
     (`mirror.rs:17`).
   - Pages are sealed as plain JSON, and base64 adds 1.34× on the wire (crypto table).
   - Measured: 1000 messages = 29 pages, 3.7 s on `wan`. 3000 messages = 50 pages, 6.4 s, and only 1793 of
     3030 messages are copied; the rest waits for the next run end or subscription.
   - gzip -6 shrinks a page to 22-23 % (synthetic text; real chat estimated 25-35 %).
   - **Fix:** deflate the page JSON before sealing. This also packs about 4× more messages into each frame
     under the same 180 KB budget, so a long history needs fewer round trips and fits under the cap.
   - **Expected gain (est.):** about 3-4× fewer bytes and pages, so 1000 messages on `wan` ≈ 1 s instead of
     3.7 s, and no truncated histories below about 6000 messages.
   - `end_turn` waits for this sync before it marks the turn done (`mirror.rs:156-159`), so run ends benefit
     too.
4. **Clone and prepare steps run in sequence, and some are redundant. (Fixed except transfer size.)**
   - After a fresh clone, `pick_branch` fetches again (`start.rs:317`): 41 ms locally, one or more GitHub round
     trips in practice.
   - For a worktree start the clone still checks out the main working tree, and `create_worktree_with`
     (`start.rs:429`) then checks out a second copy: 344 ms locally for 110 MB of files. Switching the fresh
     checkout costs 222 ms.
   - `gh repo clone` fetches full history (`start.rs:188`). For this repo `--depth 1` saves little: 98.7 vs
     103 MB `.git`, because the HEAD tree dominates. Repos with long histories save much more.
   - **Fix:** skip the fetch when `cloned` is true. Clone with `--no-checkout` when a worktree is requested.
     Pass `-- --filter=blob:none` (or `--depth 1` with an unshallow later).
   - **Expected gain (est.):** 0.3-1 s of GitHub round trips, plus one checkout (~0.2-0.9 s here), plus
     transfer time proportional to the history size.
5. **First agent event waits 100 ms on the host.** `host.rs:23` and `host.rs:2367` sleep `FLUSH` before
   every batch, including the first one after a quiet period. Measured: first event 104 ms vs 0.6 ms
   (loopback) and 189 ms vs 84 ms (`wan`).
   - **Fix:** send the first batch at once and coalesce only the frames that follow within 100 ms.
   - **Gain:** ~100 ms on the first visible output of every turn, and on `run.finished`.
6. **Reconnect waits a fixed 1 s first.** `socket.rs:72` starts the delay at 1 s and `socket.rs:97` sleeps
   before the first retry.
   - Measured on `wan`: drop → caught up 1.32 s, of which 1.0 s is backoff. Connect, `subscribe` and
     catch-up take 0.32 s.
   - A half-open link (no FIN) is noticed only after 75-105 s (`socket.rs:14`, `:21`, relay
     `limits.ts:12`); this is computed from the constants, not measured.
   - **Fix:** retry the first time after 0-250 ms of jitter when the socket had been up, and back off only
     after that. Ping every 15 s and give up after 45 s silent.
   - **Gain:** ~0.75-1 s per drop, and half-open detection ≤ 60 s instead of ≤ 105 s.
7. **Relay rate limit (20 frames/s, burst 100) is shared by everything a device sends**
   (`relay/src/limits.ts:5-6`, `relay/src/account.ts` `webSocketMessage`). It caused the unpaced upload
   failure in (1). It also bounds any burst of pages or events: the bench had to space RPC samples 50 ms
   apart, because 4×43 back-to-back calls were refused.
   - **Fix:** a separate, larger bucket for `ref`'d replies and bulk transfer frames, or byte-based limits.
   - **Gain:** enables the upload and sync fixes above without spurious `undeliverable`.
8. **Finding a project reads every project's origin with a git process. (Fixed on the host; the viewer's `repo_status` is not.)** `start.rs:298-301` calls
   `github_hub::project_repo` (`github_hub.rs:404-408`) for each project in turn: 156 ms for 10 projects,
   about 16 ms per git process. The viewer's `repo_status` adds 5 more git processes before `task.start` is
   sent (`mirror.rs:342-349`, ≈80 ms by the same per-process cost).
   - **Fix:** read `remote.origin.url` from `.git/config` directly, or cache it per project.
   - **Gain:** ~150 ms per 10 projects on the host, ~60 ms on the viewer.
9. **Not bottlenecks.**
   - Crypto: XChaCha20-Poly1305 runs at about 190 MB/s, so a 180 KB frame takes ≤1.1 ms to send and about
     1 ms to open. `pair_key` takes 67 µs and is cached.
   - Nagle: `socket.rs:114` passes `disable_nagle = false`, but the bench measured no difference
     (64 B RPC 0.67 vs 0.71 ms loopback, 84.7 vs 84.7 ms `wan`).
   - Host image store: 5.6 ms for 1 MB and 14 ms for 5 MB (decode, PNG kept, write).
   - Viewer `store_page`: about 1 ms per page.

## 3G viewer

`three_g` puts the viewer on a modeled 3G link and keeps the host on the WAN link, to compare with the
external chart's method:

- **Viewer link:** 400 kbit/s down and 400 kbit/s up, 400 ms RTT to the relay (200 ms each way). Every
  frame is serialized over the uplink at the sender, then over the downlink at the receiver (`Link`,
  `start_relay_with`). Relay to host is the 20 ms, 50 Mbit/s `wan` hop.
- **Cold connect:** a new connection each run. It counts TCP, TLS 1.3 and the WebSocket upgrade as three
  round trips, up to the first presence frame. TLS certificate bytes and TCP slow start are not modeled.
  At this BDP (20 KB) slow start would add about one RTT to the first large reply.
- **Median of 3 runs,** each on a fresh relay (`PANDACODE_BENCH_RUNS` overrides). The spread was under 1 %.
- **Threads:** a synthetic transcript of whole turns: prompts, Markdown replies with code blocks, short
  notes, and tool calls stored as JSON (`{"tool", "input", "output"}`) with test logs, build logs,
  numbered file reads, grep hits and `git log -p` (hashes, paths, timestamps). The vocabulary has 400
  words. A, B and C total 5.50, 5.16 and 3.57 MB of `task.messages` JSON (1006, 968 and 660
  messages). They deflate 2.9-3.0x. Real threads with less random text likely compress somewhat better.
- **Before** is the v0.3.49 behavior: plain frames (no `"z": 1`), and the desktop's `mirror::sync`
  copies afterId pages from 0, oldest first. The newest messages show only when the last page lands.
  **Previous** is the step before byte budgets: requests carry `"z": 1`, the host packs replies (`crypto::pack`, as
  `socket.rs` `outgoing`), and the desktop takes the tail (30), then the afterId catch-up (one empty
  page), then `backfill` (beforeId, 200 per page) through the real `mirror::store_tail`/`store_older`.
  The host side is the real `host::messages_page_with` (`PAGE_BUDGET` 180 KB).
- **Phone:** client.ts `loadMessages` with nothing cached: one `task.messages {tail: true, limit: 60}`
  after connect. The phone has no full copy, because it pages older messages as you scroll. The
  phone's `tasks.list` before opening is not counted.
- **Desktop cold open** is connect, then `subscribe`, then the sync, as `subscribe_all` does.
  **Reconnect** drops the socket, waits `FIRST_BACKOFF` (1 s; before and previous only), connects,
  subscribes, and copies the 20 new messages (the next 20 of a transcript, 62 KB of JSON) with one
  afterId page. **Now** retries at once and sends that afterId page right behind `subscribe`
  instead of after its reply (mirror.rs `follow_host` on the socket's first presence, client.ts
  `earlyCopies` on the phone), then checks the reply's `lastId` against what the page stored. **Thread opens** run
  on a viewer that is already connected.
- **Bytes:** "down / up" are WebSocket payload bytes to and from the viewer at the relay, including
  presence. TCP/TLS/WS framing adds about 3 %. "Parsed" is the plaintext JSON the viewer opens
  after inflating.

- **Now** adds `budget` to `task.messages`: the desktop's tail asks for 32 KB of JSON (mirror.rs
  `TAIL_BUDGET`), the phone's too (client.ts `TAIL_BUDGET`), and the desktop's afterId and beforeId
  pages ask for 1 MB, which the host cuts until the page packs into 180 KB (`messages_page_fit`).
  On these threads that tail is 3-9 messages, 14-29 KB of JSON, 6-11 KB packed (8-15 KB on the wire),
  and a 1 MB page holds 69-113 messages, about 485 KB of JSON packed to 160-167 KB.

### 3G viewer: before (v0.3.49) / previous (packed, newest page first) / now (byte-capped first page, bigger packed pages)

Newest visible, then full history, median of 3 runs. **Now** is the final rerun (`PANDACODE_BENCH_MODES=now`,
3 runs, after the final review fixes below); earlier "now" figures are in the next section. **Before** is the earlier run of this table
(v0.3.49 behavior, not rerun; its spread was under 1 %). **Previous** and **now** were rerun together,
3 runs each, while other work shared the machine; their spread was up to 4 % for previous and up to
19 % for now's sub-second opens (0.67-0.82 s for B).

| case | target | before | previous | now | bytes to newest, previous → now (down / parsed) | runs, newest s (now) |
|---|---|---:|---:|---:|---|---|
| 1. desktop cold connect + open A, newest | 3.6 s | 164.11 s | 3.39 s | **2.02 s** | 59 KB / 125 KB → 15 KB / 27 KB | 2.05, 2.01, 2.02 |
| 1. desktop cold connect + open A, full | - | 164.11 s | 68.36 s | 62.57 s | 2.4 MB / 5.3 MB → 2.3 MB / 5.2 MB | - |
| 1. phone cold connect + open A (tail 60) | 3.6 s / 490 KB parsed | 5.11 s | 2.91 s | **2.01 s** | 58 KB / 125 KB → 15 KB / 27 KB | 2.01, 2.01, 2.14 |
| 2. reconnect, 20 new msgs, excl. backoff | 1.3 s | 3.84 s | 2.70 s | **2.28 s** (2.71 s before pipelining) | 28 KB / 62 KB (same) | 2.30, 2.27, 2.28 |
| 2. reconnect, 20 new msgs, incl. backoff (1 s before, none now) | 1.3 s | 4.84 s | 3.71 s | **2.29 s** (3.71 s) | 28 KB / 62 KB (same) | 2.30, 2.27, 2.29 |
| 3. open thread A, newest | 2.3 s | 162.44 s | 1.68 s | **0.85 s** | 58 KB / 125 KB → 15 KB / 27 KB | 0.80, 0.88, 0.85 |
| 3. open thread A, full | - | 162.44 s | 66.54 s | 59.53 s | 2.4 MB → 2.3 MB | - |
| 3. open thread B, newest | 4.5 s | 152.89 s | 1.75 s | **0.66 s** | 60 KB / 139 KB → 8 KB / 14 KB | 0.65, 0.66, 0.77 |
| 3. open thread B, full | - | 152.89 s | 63.83 s | 55.70 s | 2.2 MB (same) | - |
| 3. open thread C, newest | 1.6 s | 106.15 s | 1.83 s | **0.80 s** | 65 KB / 147 KB → 15 KB / 29 KB | 0.82, 0.79, 0.80 |
| 3. open thread C, full | - | 106.15 s | 43.84 s | 39.25 s | 1.5 MB (same) | - |

**Where the time goes (now, 3G).** One round trip is 0.4 s, and 1 KB down takes about 20 ms.
Packed bytes are base64'd when sealed, which adds 33 %.

- **Cold connect + open A, 2.02 s (target 3.6 s, met):** 3 RTTs to connect (1.2 s), then
  `subscribe` with the tail RPC pipelined behind it (0.4 s); the 15 KB tail is about 0.3 s.
- **Phone, 2.01 s and 27 KB parsed (targets met):** connect + tail, 1.6 s of round trips. The tail
  holds the newest 3 messages of A (its newest turns carry big tool outputs); older ones load on scroll.
- **Thread opens, 0.66-0.85 s (all targets met, C's 1.6 s too):** one round trip plus 8-15 KB.
- **Reconnect, 2.28 s (target 1.3 s, still missed; was 2.71 s, 3.71 s with the backoff):** 4 round
  trips (connect 3, then `subscribe` and the afterId page together) are 1.6 s and 28 KB is about
  0.6 s. What changed, rerun with `PANDACODE_BENCH_MODES=now`, 3 runs (the other columns are the
  earlier run):
  - The afterId page goes right behind `subscribe` (one RTT, 0.4 s). Old hosts take it too: it is
    an ordinary `task.messages`, and the reply's `lastId` is checked only after the page is stored,
    so a page the host read before newer messages still leads to the usual copy.
  - No backoff before the first retry (1 s on the phone before; the desktop already retried at once,
    so its old "incl." figure was really the phone's). Covered by `mobile/tests/backoff.test.ts`.
  - The desktop's first subscribe round after a connect no longer waits the 250 ms presence
    debounce. The bench never modeled that wait, so the desktop was 0.25 s slower than its old row.
  - Not modeled, so not in the numbers: one shared rustls config (socket.rs `tls()`) resumes the TLS
    session, which skips the certificate chain (a few KB, roughly 0.05-0.1 s at 400 kbit/s) and its
    check, but TLS 1.3 takes one round trip either way.
  - Not done: 0-RTT early data. A captured upgrade (bearer token in it) could be replayed to
    replace the device's socket at the relay (close 4000 and a 60 s wait), the relay can't detect
    replays, and Cloudflare needs a zone setting for it. Presence is no wait: the relay sends it
    with the upgrade reply. Token refresh runs beside the socket, and pair keys come from cached
    presence keys, so neither adds a round trip.
  1.3 s would need a connect of at most about 2 RTTs (TCP Fast Open or QUIC, neither of which the
  relay or the clients use) and fewer bytes.
- **Full history** (A 60.2 s, B 55.6 s, C 38.3 s, from 66.5/63.8/43.8 s): A moves 2.3 MB on the wire
  (about 46 s at 400 kbit/s) in about 12 pages instead of 30, so round trips fall from about 12 s
  to 5 s. Bytes dominate; base64 is the largest part left.

### 3G viewer: after the review fixes (now, rerun)

Rerun with `PANDACODE_BENCH_MODES=now`, 3 runs, after the host and desktop review fixes: message pages
are read once under the store lock (one attachment query) and fitted without it, with the packed size
estimated by fast deflate and corrected at most once; a small first page cuts its one oversized message
to the budget (`cut: true`, fetched whole after the catch-up, which the bench now models); event
pacing counts frames; replays are bigger for packing viewers; inflate is capped at 2 MB. Every run was
identical to 10 ms.

| case | before the fixes (now) | after | final fixes |
|---|---:|---:|---:|
| 1. desktop cold connect + open A, newest / full | 2.51 / 59.07 s | 2.44 / 59.58 s | 2.02 / 62.57 s |
| 1. phone cold connect + open A (tail 60) | 1.98 s | 1.98 s | 2.01 s |
| 2. reconnect, 20 new msgs | 2.27 s | 2.25 s | 2.28 s |
| 3. open thread A, newest / full | 0.80 / 60.22 s | 0.77 / 58.05 s | 0.85 / 59.53 s |
| 3. open thread B, newest / full | 0.73 / 55.60 s | 0.63 / 55.07 s | 0.66 / 55.70 s |
| 3. open thread C, newest / full | 0.81 / 38.34 s | 0.77 / 38.31 s | 0.80 / 39.25 s |

The 1 MB page now holds 53-73 messages, 294-342 KB of JSON packed to 98-117 KB (was 69-113 messages
packed to 160-167 KB): fast deflate packs worse than the socket's level 6, so the estimate is
conservative and pages come out smaller. Full history is unchanged within noise because bytes, not
round trips, dominate it; tightening the estimate (the measured level-6 ratio) would save a few round
trips. Earlier "now" figures came from runs sharing the machine with other work, so the sub-second
deltas are mostly that.

**Final fixes** (rerun with `PANDACODE_BENCH_MODES=now`, 3 runs; spread under 0.15 s on the newest
figures): pages are sized by packing at the socket's level 6, not fast deflate, so a 1 MB page holds
105-112 messages, 480-486 KB of JSON packed to 159-161 KB (was 53-73 messages, 98-117 KB); a mirror
with nothing copied asks its tail right behind the first `subscribe` (mirror.rs `pipelined`), which
takes one round trip off the desktop's cold open (2.44 → 2.02 s, now the same as the phone); backfill
keeps going in rounds until the history is whole; replies are packed by their own request's `"z"`.
Full history did not get faster: fewer pages, but bytes still dominate, and the full-history figures
moved by up to +3 s between runs on a shared machine, which is within that noise.

## Raw output, before the fixes

From the `fast-release` run on the machine above. An earlier run on the same machine measured
`providers::discover()` at 4194.698 ms p50 (6505.524 ms p95), a full clone at 1726.518 ms, and
`checkout: switch` at 954.961 ms. The run pasted below measured 1872.019 ms, 920.836 ms and 221.573 ms.
The bench also prints a blank line between rows and their `###` title; those blank lines are removed here.

```text
# remote::bench::crypto_cost
### Crypto (crypto.rs): X25519 + HKDF pair key; XChaCha20-Poly1305 seal/open incl. base64
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| pair_key (cached per peer by socket.rs) | 200 | 0.067 | 0.081 | 0.558 |  |
| seal 256 B | 1000 | 0.005 | 0.005 | 0.221 | 52 MB/s |
| open 256 B | 1000 | 0.003 | 0.004 | 0.030 | 76 MB/s |
| send path 256 B (stamp+JSON+seal+frame) | 1000 | 0.009 | 0.010 | 0.114 | frame 665 B = 2.60x payload |
| seal 4 KB | 1000 | 0.025 | 0.028 | 0.044 | 158 MB/s |
| open 4 KB | 1000 | 0.022 | 0.024 | 0.035 | 179 MB/s |
| send path 4 KB (stamp+JSON+seal+frame) | 1000 | 0.027 | 0.033 | 0.049 | frame 5785 B = 1.41x payload |
| seal 64 KB | 1000 | 0.320 | 0.353 | 0.611 | 195 MB/s |
| open 64 KB | 1000 | 0.344 | 0.384 | 0.501 | 182 MB/s |
| send path 64 KB (stamp+JSON+seal+frame) | 1000 | 0.367 | 0.404 | 0.443 | frame 87705 B = 1.34x payload |
| seal 180 KB | 200 | 0.902 | 0.972 | 1.012 | 195 MB/s |
| open 180 KB | 200 | 0.980 | 1.054 | 1.084 | 179 MB/s |
| send path 180 KB (stamp+JSON+seal+frame) | 200 | 1.049 | 1.112 | 1.167 | frame 246085 B = 1.34x payload |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 1.74s

# remote::bench::connect_and_rpc
### Connect (TCP+WS upgrade until first presence) and RPC round trip by reply size
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback connect, nagle on (prod) | 20 | 1.364 | 1.431 | 1.439 | loopback, no TLS |
| loopback rpc reply 64 B, nagle on (prod) | 40 | 0.670 | 0.962 | 1.067 |  |
| loopback rpc reply 4 KB, nagle on (prod) | 40 | 0.898 | 1.527 | 1.866 |  |
| loopback rpc reply 64 KB, nagle on (prod) | 40 | 3.844 | 4.622 | 5.206 |  |
| loopback rpc reply 180 KB, nagle on (prod) | 40 | 7.362 | 8.639 | 10.194 |  |
| loopback connect, nodelay | 20 | 1.413 | 1.561 | 1.595 | loopback, no TLS |
| loopback rpc reply 64 B, nodelay | 40 | 0.705 | 0.886 | 0.963 |  |
| loopback rpc reply 4 KB, nodelay | 40 | 0.932 | 1.154 | 1.251 |  |
| loopback rpc reply 64 KB, nodelay | 40 | 4.037 | 4.729 | 5.045 |  |
| loopback rpc reply 180 KB, nodelay | 40 | 8.168 | 10.723 | 10.801 |  |
| wan connect, nagle on (prod) | 20 | 124.845 | 125.609 | 125.718 | 3 modeled RTTs: TCP, TLS 1.3, upgrade |
| wan rpc reply 64 B, nagle on (prod) | 40 | 84.703 | 85.745 | 86.719 |  |
| wan rpc reply 4 KB, nagle on (prod) | 40 | 85.766 | 86.797 | 87.298 |  |
| wan rpc reply 64 KB, nagle on (prod) | 40 | 99.149 | 100.933 | 105.539 |  |
| wan rpc reply 180 KB, nagle on (prod) | 40 | 130.668 | 134.102 | 136.174 |  |
| wan connect, nodelay | 20 | 124.894 | 125.462 | 125.535 | 3 modeled RTTs: TCP, TLS 1.3, upgrade |
| wan rpc reply 64 B, nodelay | 40 | 84.706 | 85.507 | 85.858 |  |
| wan rpc reply 4 KB, nodelay | 40 | 85.562 | 89.072 | 105.758 |  |
| wan rpc reply 64 KB, nodelay | 40 | 99.426 | 101.704 | 102.380 |  |
| wan rpc reply 180 KB, nodelay | 40 | 126.271 | 127.440 | 129.039 |  |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 74.06s

# remote::bench::first_event_after_send
### task.send: response and first agent.events frame (harness start and model latency excluded)
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback task.send response, nagle on (prod) | 30 | 0.404 | 0.712 | 0.720 |  |
| loopback task.send first event, nagle on (prod) | 30 | 104.421 | 105.557 | 105.753 | host.rs FLUSH = 100 ms |
| loopback task.send.noflush response, nagle on (prod) | 30 | 0.539 | 0.961 | 1.119 |  |
| loopback task.send.noflush first event, nagle on (prod) | 30 | 0.600 | 1.066 | 1.291 | model: flush at once |
| loopback task.send response, nodelay | 30 | 0.505 | 6.328 | 6.507 |  |
| loopback task.send first event, nodelay | 30 | 105.405 | 108.757 | 110.027 | host.rs FLUSH = 100 ms |
| loopback task.send.noflush response, nodelay | 30 | 0.561 | 6.408 | 7.363 |  |
| loopback task.send.noflush first event, nodelay | 30 | 0.574 | 6.470 | 8.109 | model: flush at once |
| wan task.send response, nagle on (prod) | 30 | 84.557 | 87.984 | 88.438 |  |
| wan task.send first event, nagle on (prod) | 30 | 188.797 | 192.495 | 192.653 | host.rs FLUSH = 100 ms |
| wan task.send.noflush response, nagle on (prod) | 30 | 84.448 | 85.137 | 85.200 |  |
| wan task.send.noflush first event, nagle on (prod) | 30 | 84.445 | 85.179 | 85.199 | model: flush at once |
| wan task.send response, nodelay | 30 | 84.800 | 88.655 | 93.285 |  |
| wan task.send first event, nodelay | 30 | 189.025 | 191.679 | 214.694 | host.rs FLUSH = 100 ms |
| wan task.send.noflush response, nodelay | 30 | 84.545 | 89.232 | 98.074 |  |
| wan task.send.noflush first event, nodelay | 30 | 84.538 | 88.524 | 97.736 | model: flush at once |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 47.76s

# remote::bench::task_start_phases
Bench repository: 245 commits, 1205 files at HEAD, 102.9 MB on disk as a bare repo (made in 0.9 s, not counted)
### task.start phases (start.rs), local file:// origin instead of GitHub
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| finding: project_repo over 10 projects | 5 | 156.489 | 159.793 | 159.793 | one `git config` per project, serial |
| finding: require_installed -> providers::discover() | 3 | 1872.019 | 2939.375 | 2939.375 | 14 harnesses installed; `--version` each, serial |
| downloading: git clone full | 5 | 920.836 | 932.377 | 932.377 | what gh repo clone runs today; .git 103.0 MB (~17.3 s at 50 Mbit/s), 213.2 MB on disk, 204 progress lines |
| downloading: git clone --depth 1 | 5 | 859.210 | 895.442 | 895.442 | not used today; .git 98.7 MB (~16.6 s at 50 Mbit/s), 208.8 MB on disk, 116 progress lines |
| downloading: git clone --filter=blob:none | 5 | 996.710 | 1419.774 | 1419.774 | not used today; .git 99.2 MB (~16.6 s at 50 Mbit/s), 209.4 MB on disk, 204 progress lines |
| preparing: fetch origin (pick_branch) | 5 | 41.100 | 44.808 | 44.808 |  |
| preparing: rev-parse origin/<branch> (on_origin) | 5 | 15.913 | 16.196 | 16.196 |  |
| preparing: symbolic-ref origin/HEAD | 5 | 16.004 | 16.358 | 16.358 |  |
| preparing: checkout: rev-parse refs/heads | 5 | 16.005 | 16.191 | 16.191 |  |
| preparing: checkout: switch | 5 | 221.573 | 234.057 | 234.057 |  |
| preparing: checkout: merge --ff-only | 5 | 16.089 | 16.180 | 16.180 |  |
| preparing: worktree: create_worktree_with | 5 | 343.761 | 354.617 | 354.617 |  |
| preparing: total in-place path (6 git steps) | 5 | 327.206 | 336.450 | 336.450 | fetch right after a fresh clone |
| starting: create task + send_message | 0 | - | - | - | not measured: needs the app store and a harness |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 27.90s

# remote::bench::image_upload
### Image work on one computer (images.rs), per image
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| 1 MB chunks() base64 encode | 3 | 0.460 | 0.544 | 0.544 | 1048577 B, 15 chunks |
| 1 MB host parse_chunk + Uploads::add | 3 | 0.698 | 1.030 | 1.030 |  |
| 1 MB host store (decode, PNG kept, write) | 3 | 5.597 | 5.598 | 5.598 |  |
| 1 MB pacing floor, 15 chunks x 75 ms | 1 | 1050.000 | 1050.000 | 1050.000 | images.rs PACE, serial |
| 5 MB chunks() base64 encode | 3 | 1.511 | 1.637 | 1.637 | 5173678 B, 71 chunks |
| 5 MB host parse_chunk + Uploads::add | 3 | 3.065 | 3.106 | 3.106 |  |
| 5 MB host store (decode, PNG kept, write) | 3 | 13.579 | 14.312 | 14.312 |  |
| 5 MB pacing floor, 71 chunks x 75 ms | 1 | 5250.000 | 5250.000 | 5250.000 | images.rs PACE, serial |
### Image upload through the relay, viewer start to last imageId
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback 1x1MB Prod | 3 | 1091.703 | 1092.319 | 1092.319 | 15 chunks, 0.92 MB/s |
| loopback 1x1MB Unpaced | 3 | 27.183 | 27.891 | 27.891 | 15 chunks, 36.79 MB/s |
| loopback 1x1MB Burst | 3 | 27.053 | 27.105 | 27.105 | 15 chunks, 36.97 MB/s |
| loopback 1x1MB Pipelined | 3 | 14.924 | 15.079 | 15.079 | 15 chunks, 67.01 MB/s |
| loopback 4x1MB Prod | 3 | 4592.104 | 4595.895 | 4595.895 | 60 chunks, 0.87 MB/s |
| loopback 4x1MB Unpaced | 3 | 106.183 | 106.504 | 106.504 | 60 chunks, 37.67 MB/s |
| loopback 4x1MB Burst | 3 | 107.810 | 108.369 | 108.369 | 60 chunks, 37.10 MB/s |
| loopback 4x1MB Pipelined | 3 | 47.359 | 47.830 | 47.830 | 60 chunks, 84.46 MB/s |
| loopback 1x5MB Prod | 2 | 5460.563 | 5460.563 | 5460.563 | 71 chunks, 0.90 MB/s |
| loopback 1x5MB Unpaced | 2 | 124.379 | 124.379 | 124.379 | 71 chunks, 39.67 MB/s |
| loopback 1x5MB Burst | 2 | 113.298 | 113.298 | 113.298 | 71 chunks, 43.55 MB/s |
| loopback 1x5MB Pipelined | 2 | 56.434 | 56.434 | 56.434 | 71 chunks, 87.43 MB/s |
| loopback 4x5MB Prod | 2 | 21922.129 | 21922.129 | 21922.129 | 284 chunks, 0.90 MB/s |
| loopback 4x5MB Unpaced | 0 | - | - | - | FAILED after 103 chunks: undeliverable (rate) |
| loopback 4x5MB Burst | 2 | 10374.371 | 10374.371 | 10374.371 | 284 chunks, 1.90 MB/s |
| loopback 4x5MB Pipelined | 2 | 10288.409 | 10288.409 | 10288.409 | 284 chunks, 1.92 MB/s |
| wan 1x1MB Prod | 3 | 1635.483 | 1638.679 | 1638.679 | 15 chunks, 0.61 MB/s |
| wan 1x1MB Unpaced | 3 | 1611.927 | 1616.375 | 1616.375 | 15 chunks, 0.62 MB/s |
| wan 1x1MB Burst | 3 | 1610.308 | 1628.124 | 1628.124 | 15 chunks, 0.62 MB/s |
| wan 1x1MB Pipelined | 3 | 391.869 | 392.580 | 392.580 | 15 chunks, 2.55 MB/s |
| wan 4x1MB Prod | 3 | 6659.331 | 6670.600 | 6670.600 | 60 chunks, 0.60 MB/s |
| wan 4x1MB Unpaced | 3 | 6685.805 | 6686.087 | 6686.087 | 60 chunks, 0.60 MB/s |
| wan 4x1MB Burst | 3 | 6668.798 | 6671.960 | 6671.960 | 60 chunks, 0.60 MB/s |
| wan 4x1MB Pipelined | 3 | 1298.132 | 1300.441 | 1300.441 | 60 chunks, 3.08 MB/s |
| wan 1x5MB Prod | 2 | 7964.758 | 7964.758 | 7964.758 | 71 chunks, 0.62 MB/s |
| wan 1x5MB Unpaced | 2 | 7936.130 | 7936.130 | 7936.130 | 71 chunks, 0.62 MB/s |
| wan 1x5MB Burst | 2 | 7934.216 | 7934.216 | 7934.216 | 71 chunks, 0.62 MB/s |
| wan 1x5MB Pipelined | 2 | 1596.827 | 1596.827 | 1596.827 | 71 chunks, 3.09 MB/s |
| wan 4x5MB Prod | 2 | 31784.039 | 31784.039 | 31784.039 | 284 chunks, 0.62 MB/s |
| wan 4x5MB Unpaced | 2 | 31671.030 | 31671.030 | 31671.030 | 284 chunks, 0.62 MB/s |
| wan 4x5MB Burst | 2 | 31660.895 | 31660.895 | 31660.895 | 284 chunks, 0.62 MB/s |
| wan 4x5MB Pipelined | 2 | 12133.454 | 12133.454 | 12133.454 | 284 chunks, 1.63 MB/s |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 470.00s

# remote::bench::history_sync
### History sync, local work per page
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| 200 msgs host messages_page (first page) | 5 | 1.173 | 1.314 | 1.314 | gzip -6 page 23% of raw |
| 200 msgs viewer store_page per page | 3 | 0.923 | 0.947 | 0.947 |  |
| 1000 msgs host messages_page (first page) | 5 | 2.043 | 2.112 | 2.112 | gzip -6 page 23% of raw |
| 1000 msgs viewer store_page per page | 3 | 1.010 | 1.017 | 1.017 |  |
| 3000 msgs host messages_page (first page) | 5 | 1.913 | 2.044 | 2.044 | gzip -6 page 22% of raw |
| 3000 msgs viewer store_page per page | 3 | 1.001 | 1.030 | 1.030 |  |
### History sync (mirror.rs sync, host.rs messages_page, PAGE_BUDGET 180 KB)
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback first sync, 200+30 msgs | 3 | 29.552 | 29.724 | 29.724 | 901 KB raw content; 7 pages, 1.0 MB sent; copied 230/230 |
| loopback run-end sync, 30 new msgs | 3 | 3.046 | 3.062 | 3.062 | 1 pages, 102 KB sent |
| wan first sync, 200+30 msgs | 3 | 856.773 | 863.116 | 863.116 | 901 KB raw content; 7 pages, 1.0 MB sent; copied 230/230 |
| wan run-end sync, 30 new msgs | 3 | 110.810 | 111.621 | 111.621 | 1 pages, 102 KB sent |
| loopback first sync, 1000+30 msgs | 3 | 159.973 | 160.357 | 160.357 | 4.5 MB raw content; 29 pages, 4.8 MB sent; copied 1030/1030 |
| loopback run-end sync, 30 new msgs | 3 | 2.775 | 2.823 | 2.823 | 1 pages, 95 KB sent |
| wan first sync, 1000+30 msgs | 3 | 3711.680 | 3719.820 | 3719.820 | 4.5 MB raw content; 29 pages, 4.8 MB sent; copied 1030/1030 |
| wan run-end sync, 30 new msgs | 3 | 110.260 | 110.293 | 110.293 | 1 pages, 95 KB sent |
| loopback first sync, 3000+30 msgs | 3 | 286.404 | 291.109 | 291.109 | 13.4 MB raw content; 50 pages, 8.3 MB sent; copied 1793/3030 |
| loopback run-end sync, 30 new msgs | 3 | 2.610 | 2.807 | 2.807 | 1 pages, 89 KB sent |
| wan first sync, 3000+30 msgs | 3 | 6437.797 | 6445.087 | 6445.087 | 13.4 MB raw content; 50 pages, 8.3 MB sent; copied 1793/3030 |
| wan run-end sync, 30 new msgs | 3 | 109.212 | 109.598 | 109.598 | 1 pages, 89 KB sent |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 38.13s

# remote::bench::reconnect_resume
### Reconnect after a dropped socket: backoff, connect, subscribe, catch-up of 20 new messages
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback backoff before the first retry | 1 | 1000.000 | 1000.000 | 1000.000 | socket.rs run(): delay starts at 1 s |
| loopback connect until presence | 5 | 1.646 | 1.799 | 1.799 |  |
| loopback subscribe RPC | 5 | 0.329 | 0.338 | 0.338 |  |
| loopback catch-up sync | 5 | 2.263 | 2.374 | 2.374 |  |
| loopback drop to caught up, excl. backoff | 5 | 7.326 | 7.530 | 7.530 |  |
| loopback drop to caught up, total | 5 | 1007.326 | 1007.530 | 1007.530 |  |
| wan backoff before the first retry | 1 | 1000.000 | 1000.000 | 1000.000 | socket.rs run(): delay starts at 1 s |
| wan connect until presence | 5 | 126.478 | 126.601 | 126.601 |  |
| wan subscribe RPC | 5 | 86.471 | 86.654 | 86.654 |  |
| wan catch-up sync | 5 | 102.502 | 103.165 | 103.165 |  |
| wan drop to caught up, excl. backoff | 5 | 316.843 | 318.672 | 318.672 |  |
| wan drop to caught up, total | 5 | 1316.843 | 1318.672 | 1318.672 |  |
Half-open socket (no FIN): socket.rs pings every 30 s and gives up after 75 s silent, so a dead link is noticed after 75-105 s (computed from constants, not measured).
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1417 filtered out; finished in 12.69s

```

## Raw output, after the fixes

From the `fast-release` run on the same machine, 2026-10-26, with `task_start_phases` and `image_upload` run on their
own (`PANDACODE_BENCH_REPO` set to this repository). Other builds were running at the same time. The old upload
rows (`Before`) were not rerun; their numbers are in the first raw output (`Prod`, `Burst` and `Pipelined` there).
`Shipped` is `images::upload`. The bench also prints a blank line between rows and their `###` title; those blank
lines are removed here.

```text
# remote::bench::task_start_phases
Bench repository: 245 commits, 1205 files at HEAD, 102.9 MB on disk as a bare repo (made in 1.0 s, not counted)
### task.start phases (start.rs), local file:// origin instead of GitHub
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| finding: project_repo over 10 projects (before) | 5 | 153.439 | 156.028 | 156.028 | one `git config` per project, serial |
| finding: start::origins over 10 projects (now) | 5 | 0.129 | 0.342 | 0.342 | reads .git/config; git only for unusual configs |
| finding: require_installed -> providers::discover() (before) | 3 | 1953.762 | 4013.299 | 4013.299 | 14 harnesses installed; `--version` each, serial |
| finding: require_installed -> providers::executable (now) | 20 | 0.051 | 0.075 | 0.146 | one harness, PATH lookup only |
| downloading: git clone full | 5 | 1240.577 | 1251.249 | 1251.249 | what gh repo clone runs for an in-place start; .git 103.0 MB (~17.3 s at 50 Mbit/s), 213.2 MB on disk, 204 progress lines |
| downloading: git clone --depth 1 | 5 | 1086.008 | 1119.594 | 1119.594 | not used; .git 98.7 MB (~16.6 s at 50 Mbit/s), 208.8 MB on disk, 115 progress lines |
| downloading: git clone --filter=blob:none | 5 | 1166.625 | 1376.624 | 1376.624 | not used; .git 99.2 MB (~16.6 s at 50 Mbit/s), 209.4 MB on disk, 303 progress lines |
| downloading: git clone --no-checkout | 5 | 1004.340 | 1516.816 | 1516.816 | what a worktree start runs now (the tree is filled in later); .git 102.9 MB (~17.3 s at 50 Mbit/s), 102.9 MB on disk, 204 progress lines |
| preparing: fetch origin (pick_branch) | 5 | 39.494 | 51.836 | 51.836 |  |
| preparing: rev-parse origin/<branch> (on_origin) | 5 | 13.778 | 16.347 | 16.347 |  |
| preparing: symbolic-ref origin/HEAD | 5 | 13.784 | 15.496 | 15.496 |  |
| preparing: checkout: rev-parse refs/heads | 5 | 13.956 | 16.336 | 16.336 |  |
| preparing: checkout: switch | 5 | 230.854 | 241.122 | 241.122 |  |
| preparing: checkout: merge --ff-only | 5 | 17.009 | 27.962 | 27.962 |  |
| preparing: worktree: create_worktree_with | 5 | 502.952 | 509.124 | 509.124 |  |
| preparing: total in-place path (6 git steps) | 5 | 335.062 | 352.451 | 352.451 | fetch right after a fresh clone |
| start, fresh clone, in place: clone + prepare (before) | 3 | 1537.543 | 1930.351 | 1930.351 | clone, fetch, rev-parse origin/<branch> and refs/heads, switch, merge |
| start, fresh clone, in place: clone + prepare (now) | 3 | 1162.013 | 1805.309 | 1805.309 | clone, rev-parse origin/<branch>, symbolic-ref HEAD |
| start, fresh clone, worktree: clone + prepare (before) | 3 | 1530.197 | 2008.078 | 2008.078 | clone, fetch, rev-parse origin/<branch>, worktree add |
| start, fresh clone, worktree: clone + prepare (now) | 3 | 1273.163 | 1626.488 | 1626.488 | clone --no-checkout, rev-parse origin/<branch>, worktree add in parallel with reset --hard |
| starting: create task + send_message | 0 | - | - | - | not measured: needs the app store and a harness |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1425 filtered out; finished in 62.30s

# remote::bench::image_upload
### Image work on one computer (images.rs), per image
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| 1 MB chunks() base64 encode | 3 | 0.294 | 0.374 | 0.374 | 1048577 B, 15 chunks |
| 1 MB host parse_chunk + Uploads::add | 3 | 0.634 | 0.817 | 0.817 |  |
| 1 MB host store (decode, PNG kept, write) | 3 | 5.562 | 5.993 | 5.993 |  |
| 1 MB old pacing floor, 15 chunks x 75 ms | 1 | 1050.000 | 1050.000 | 1050.000 | images.rs PACE before the fix, serial |
| 5 MB chunks() base64 encode | 3 | 1.608 | 1.613 | 1.613 | 5173678 B, 71 chunks |
| 5 MB host parse_chunk + Uploads::add | 3 | 3.024 | 3.062 | 3.062 |  |
| 5 MB host store (decode, PNG kept, write) | 3 | 15.411 | 24.171 | 24.171 |  |
| 5 MB old pacing floor, 71 chunks x 75 ms | 1 | 5250.000 | 5250.000 | 5250.000 | images.rs PACE before the fix, serial |
### Image upload through the relay, viewer start to last imageId (Before = old images.rs, Shipped = images::upload)
| case | n | p50 ms | p95 ms | max ms | note |
|---|---:|---:|---:|---:|---|
| loopback 1x1MB Unpaced | 3 | 28.201 | 33.376 | 33.376 | 15 chunks, 35.46 MB/s |
| loopback 1x1MB Shipped | 3 | 14.802 | 31.678 | 31.678 | 15 chunks, 67.56 MB/s |
| loopback 4x1MB Unpaced | 3 | 106.781 | 107.676 | 107.676 | 60 chunks, 37.46 MB/s |
| loopback 4x1MB Shipped | 3 | 47.073 | 54.549 | 54.549 | 60 chunks, 84.98 MB/s |
| loopback 1x5MB Unpaced | 2 | 127.090 | 127.090 | 127.090 | 71 chunks, 38.82 MB/s |
| loopback 1x5MB Shipped | 2 | 56.025 | 56.025 | 56.025 | 71 chunks, 88.07 MB/s |
| loopback 4x5MB Unpaced | 0 | - | - | - | FAILED after 104 chunks: undeliverable (rate) |
| loopback 4x5MB Shipped | 2 | 11368.840 | 11368.840 | 11368.840 | 284 chunks, 1.74 MB/s |
| wan 1x1MB Unpaced | 3 | 1610.799 | 1677.296 | 1677.296 | 15 chunks, 0.62 MB/s |
| wan 1x1MB Shipped | 3 | 391.003 | 391.252 | 391.252 | 15 chunks, 2.56 MB/s |
| wan 4x1MB Unpaced | 3 | 6437.627 | 6450.305 | 6450.305 | 60 chunks, 0.62 MB/s |
| wan 4x1MB Shipped | 3 | 1289.032 | 1289.879 | 1289.879 | 60 chunks, 3.10 MB/s |
| wan 1x5MB Unpaced | 2 | 7925.040 | 7925.040 | 7925.040 | 71 chunks, 0.62 MB/s |
| wan 1x5MB Shipped | 2 | 1577.935 | 1577.935 | 1577.935 | 71 chunks, 3.13 MB/s |
| wan 4x5MB Unpaced | 2 | 31769.819 | 31769.819 | 31769.819 | 284 chunks, 0.62 MB/s |
| wan 4x5MB Shipped | 2 | 11460.569 | 11460.569 | 11460.569 | 284 chunks, 1.72 MB/s |
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1425 filtered out; finished in 163.79s
```
