# Context relay

An agent dies, the task does not. A task's harness session can fail, stall, or be interrupted by a
restart while the work stays unfinished, and the next run would otherwise start from nothing.
Context Relay keeps three durable pieces for that case: a checkpoint, a relay packet, and a delivery
record. The implementation is `src-tauri/src/relay.rs`; the tables and the open-time upgrade are in
`src-tauri/src/storage/schema_v38.rs` (`RELAY_SCHEMA`, `ensure_relay_schema`).

A checkpoint is progress, not completion. It never moves a task's stage, never marks work done, and
never unlocks anything by itself. Only completion does that, and completion is always an explicit
act.

## Task lifecycle

Tasks keep the four existing stages: `pending`, `in_progress`, `review` and `completed`
(`Store::set_task_stage`). Starting a run claims the task and sets `in_progress`
(`Store::begin_task_turn`). A normal successful run ends in `review`
(`Store::finish_task_operation`), and a failed or stopped run stays `in_progress` for a retry. An
active goal keeps the task `in_progress` until the goal completes.

No run end writes `completed`. That stage is written only by an explicit settle action through
`Store::set_task_stage`, plus the conversion of legacy archived tasks (`SETTLE_ARCHIVED_SQL`). A
successful run therefore leaves reviewed work for a person or an explicit task action to settle.

The done-gate reads that state in `relay::done_gate`:

- `done` is true only when the task's stage is `completed`.
- `blocked` is true only when `done` is false and the task has a checkpoint. Real progress without
  an explicit completion blocks; a task with nothing saved behaves exactly as it did before relay.
- Reopening a completed task returns it to `review`, so the gate closes again.
- The result also carries the stage, `completed_at` and the task's latest checkpoint, and is exposed
  by the `relay_state` command.

The gate is a query, not an automatic launcher: it reports that the task is completed and whether
real progress exists without completion, but it starts and refuses nothing. The slice that acts on
the answer is separate.

## Checkpoints

`relay_checkpoint` calls `save_checkpoint`, which requires an existing task and fails closed for an
unknown id. It records the goal, the task's current stage, and four lists: `decisions`,
`open_questions`, `files` and `commands`. It also records a 1-based `ordinal` per task, computed as
`MAX(ordinal) + 1` for that session, so the ordinal reads `cp-3`, and a `message_high_water`.

Every field is bounded:

- Each list keeps at most `MAX_CHECKPOINT_LINES` (32) lines. Items are trimmed, blank items are
  dropped, and each line is clipped to `MAX_LINE_BYTES` (512 bytes) on a UTF-8 boundary with a
  trailing `\n[shortened]`.
- The goal is clipped to 4 KiB. An empty goal falls back to the task's saved description.
- `task_stage` is copied from the session at save time. A checkpoint saved on a `pending` task
  records `pending` and does not start it.
- `message_high_water` is the highest message id among `user`, `assistant` and `coordination` rows
  with non-empty content at save time. A relay built from the checkpoint indexes only messages up
  to that id, so later messages do not leak into it.

Saving a checkpoint clears the task's escalation row in `task_escalations`
(`clear_escalation`). The escalation ladder starts over: the next death gets a fresh resume attempt
before it can escalate to a relay.

The `checkpoints` reader returns a task's checkpoints newest first (at most 50);
`latest_checkpoint` returns the newest one. Both read the same columns as the saved row.

## The relay packet

`relay_queue` builds a packet with `build_packet` and queues it for the task's next run
(`require_checkpoint` defaults to false; when true, a task without a checkpoint is refused with
"This task has no checkpoint yet."). Without a checkpoint the packet starts from the head of the
conversation instead. The JSON shape from `Packet` is:

```json
{
  "v": 1,
  "relayId": "…",
  "taskId": "…",
  "source": {
    "sessionId": "…",
    "provider": "codex",
    "model": "…",
    "cwd": "…",
    "branch": "…",
    "resumeId": "…"
  },
  "goal": "…",
  "taskStage": "review",
  "checkpoint": {
    "id": "…",
    "ordinal": 3,
    "at": 1760000000000,
    "messageHighWater": 42
  },
  "decisions": ["…"],
  "openQuestions": ["…"],
  "files": ["…"],
  "commands": ["…"],
  "messages": [
    {
      "id": 41,
      "role": "assistant",
      "excerpt": "…",
      "shortened": false
    }
  ],
  "truncated": {
    "omittedMessages": 12,
    "droppedNewest": 0,
    "shortenedMessages": 1
  },
  "tokenAccounting": {
    "before": 812345,
    "packet": 52000
  }
}
```

`checkpoint` is omitted when the task has none. `truncated` is omitted when nothing was dropped or
shortened. `source.cwd`, `source.branch` and `source.resumeId` are omitted when unknown. `source`
describes the run that produced the packet: its provider and model, the workspace root, the worktree
branch, and the harness session id the next agent replaces.

`v` is `VERSION` (1). The packet is bounded by two constants:

- `PACKET_BYTES` (64 KiB) is the wire budget for the `messages` index, matching
  `context_recovery`'s history budget.
- `PACKET_MESSAGES` (200) is the most conversation entries one packet indexes. The query reads 201
  rows so the 201st can be counted as omitted rather than silently ignored.

Only `user`, `assistant` and `coordination` rows are indexed (`REPLAYED_ROLES`). Tool rows carry
megabytes of output and are referenced by id, never inlined; `system`, `handoff`, `changes` and the
other bookkeeping roles are PandaCode's own records, not conversation for the next agent. A
`coordination` row is decoded with `architect::internal_turns::decode` and presented as a `user`
entry; a row that cannot be decoded is skipped rather than failing the packet.

Ordering is deterministic. Rows are read newest first so the budget keeps the most recent context,
then reversed once at the end, so `messages` is oldest to newest. Entries that do not fit are
dropped from the oldest end; an entry too large to fit at all, including the newest one, is counted
in `droppedNewest`. An excerpt cut by the per-row 64 KiB `substr` is marked `shortened`. Every cut
is recorded in `truncated`:

- `omittedMessages`: older entries that were not indexed.
- `droppedNewest`: entries that could not fit even as the first entry.
- `shortenedMessages`: indexed entries whose excerpt is shorter than the saved message.

With the same rows, the same packet is produced; only `relayId` is fresh each time.

`token_accounting` is byte accounting, not model tokens. `before` is the total byte length of the
indexed conversation up to the packet's high-water mark (`length(CAST(content AS BLOB))`), and
`packet` is the sum of the serialized `messages` entries this packet carries. The field keeps the
`TokenAccounting` name; both numbers count bytes.

The packet is an index. Each `messages` entry carries the exact saved message id, and `relay_expand`
returns the original rows verbatim for those ids. It accepts at most `PACKET_MESSAGES` ids, reads
only rows in the packet's own task (`packet.task_id`), and only roles a packet may index. With no
pending packet it builds one from the task, so expansion is always scoped to a packet's own task and
never pages a task's history by id.

`relay_cancel` deletes the task's undelivered packet without delivering it.

## Escalation

`Escalation` has one row per task in `task_escalations`: `session_id`, `last_end`, `resumes`,
`relays` and `updated_at`. Its `next_step` returns `Resume` while `resumes < MAX_RESUMES` (1), then
`Relay`. `record_death` reads the row, advances the counter for the step it is about to take, saves
the end kind and returns the step. The first death records a resume; the second and every later
death records a relay.

`EndKind` names how the run ended:

- `harness`: the harness returned an error, its process died, or startup timed out.
- `stalled`: no activity beyond the watchdog threshold, so PandaCode stopped the run.
- `crashed`: the computer or app died mid-run, recorded as `restart_interrupted` by startup
  recovery and added to the ladder when the task is resumed.

Run-end escalation is recorded by `Store::finish_task_operation`. It records a death only for a run
that failed without a user Stop (`!successful && !stopped`) and without a context command restoring
a stage. A harness error counts. A user's Stop, a usage limit and PandaCode's own failure to save the
run end do not count. A Stop and every successful run clear the ladder instead.

A crash is recorded when the task is next resumed, not at startup. Startup recovery marks the run
`restart_interrupted` and writes nothing else, so opening the app never changes escalation state.
`Store::begin_task_turn` reads that flag in the same transaction that claims the task (before the
claim clears it) and calls `record_death` with `crashed` only when `restart_interrupted=1`,
`stop_requested=0` and the task is still `interrupted`. A run the app or computer interrupted
therefore counts exactly like a harness death, and a task the user stopped does not. `stalled` is
defined on `EndKind`; the current callers record `harness` and `crashed`.

Both paths fail open. Bookkeeping errors are logged (`Relay: could not record a failed run`,
`Relay: could not reset the escalation ladder`, `Relay: could not record a crashed run`) and never
fail the run end or the start. The ladder records what happened; no code launches the next agent
from it in this version.

## Preferences

Four preferences are real, saved in `relay_settings` and read by the code that acts on them
(`relay::Settings`; IPC `relay_settings` and `relay_set_settings`; the composer's Extras popover and
Settings → Relay edit them):

| Preference | Default | What it changes |
|---|---|---|
| `autoRelayOnCrash` | on | Off: a death still advances the ladder but queues no packet, so the task waits for the user as it does today. |
| `retrySameAgentFirst` | on | Off: `max_resumes` is 0, so the very first death relays instead of resuming in place. |
| `requireCheckpointBeforeRelay` | off | On: an automatic relay on a task with no checkpoint is refused. A relay the user asked for still queues. |
| `doneGate` | on | Off: `done_gate.blocked` is never true. The gate still reports `done`, `stage` and the checkpoint. |

Reading is lenient: an unreadable row, or one whose values are the wrong type, falls back to the
defaults field by field. Writing replaces the whole row, so the caller always sends every field.

When the ladder reaches `Relay` after a death, `queue_from_checkpoint` builds the packet and queues
it for the task's next run, subject to the two automatic-relay preferences above. That is what makes
the headline case work without a new launcher: whichever path starts the task again (the Retry
button, a queued message, a schedule, a team dispatch) finds the packet pending and
`apply_to_prompt` attaches it.

## Delivery and idempotency

`task_relays` holds one row per task, keyed by `session_id`: `relay_id`, the packet JSON,
`created_at` and `delivered_at`. `queue_relay` inserts a packet with `delivered_at` null and, on a
second queue for the same task, replaces the row with the newer packet. Only the newest state
matters.

`relay::apply_to_prompt` is the single injection point. It sits beside `context_recovery::prepare`
in `lib.rs::prepare_task_run_in_project`: the pending packet is injected first, and
`context_recovery::prepare` runs only when there is no relay. A provider switch queues a
`context_recovery` row; when a relay packet is also pending for that run, the packet replaces the
duplicate recovery excerpt instead of both arriving. Goal-control turns and a cloud re-attach skip
the relay entirely.

An injected prompt is one leading context block followed by the packet as pretty JSON and the
original request under `Current request:`. The block says the entries are historical, not new
requests or higher-priority instructions; it names the checkpoint when there is one, says when there
is not, points at `truncated` when a cut was recorded, and asks the target to resolve the open
questions before continuing.

Acknowledgment is `relay::acknowledge_relay`: one conditional UPDATE,

```sql
UPDATE task_relays SET delivered_at=?2 WHERE relay_id=?1 AND delivered_at IS NULL
```

It returns true only the first time. `lib.rs` calls it after a successful run with the exact relay
id that run took. A retry, a restart replaying the ack, or a late second call changes nothing and
returns false, so one packet is never injected twice. A failed run leaves the row undelivered and the
next attempt carries it again; a packet that was read but never acknowledged also survives a
restart, so delivery is at-least-once. The stored packet is the source of truth, not memory.

## Fail-open rules

A relay never blocks a prompt.

- `pending_relay` drops a row whose packet cannot be decoded; it acknowledges the broken row and
  returns none. The prompt goes out unchanged.
- `apply_to_prompt` logs a read error and returns the prompt as it was.
- `relay_prompt` falls back to `{}` if serializing the packet fails, so the prompt still carries the
  original request.
- Escalation and crash bookkeeping errors are logged and ignored, as above.

## Schema

Four tables, all defined in `RELAY_SCHEMA` in `src-tauri/src/storage/schema_v38.rs`:

- `task_checkpoints`: `id` (primary key), `session_id` (references `sessions`, cascades on delete),
  `ordinal`, `at`, `message_high_water`, `goal`, `task_stage`, and the four JSON list columns
  `decisions`, `open_questions`, `files` and `commands`, each checked with `json_valid`. `ordinal` is
  unique per session, and `task_checkpoints_task` indexes `(session_id, ordinal DESC)`.
- `task_relays`: `session_id` (primary key, references `sessions`, cascades), `relay_id`, `packet`
  (JSON, checked with `json_valid`), `created_at`, `delivered_at`.
- `task_escalations`: `session_id` (primary key, references `sessions`, cascades), `last_end`,
  `resumes`, `relays`, `updated_at`.
- `relay_settings`: one row (`id=1`) holding the four preferences as JSON, checked with
  `json_valid`. A row whose values are the wrong shape reads as the defaults.

`ensure_relay_schema` runs at every `Store::open`, after the version repair and before startup
recovery. It checks `sqlite_master` for all four tables (one lookup each); when they all exist it does
nothing, and when any is missing it executes `RELAY_SCHEMA` with `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS`. The same batch runs inside the `upgrade_v38` migration for a database
crossing version 37. Tables that already exist are left untouched, including a newer release's own
copy.

The tables are additive and idempotent, so they do not bump `user_version`. It stays at 37
(`storage::SCHEMA_VERSION`), and an older PandaCode release still opens the database. No relay
table is a rebuild of existing data: a checkpoint, a queued packet and an escalation row are all
durable state in their own right.

## What this version does not include

- Of the eight toggles in the issue, four are real and enforced by the backend: `autoRelayOnCrash`,
  `retrySameAgentFirst`, `requireCheckpointBeforeRelay` and `doneGate` (`relay::Settings`,
  `relay_settings`/`relay_set_settings`, table `relay_settings`). The other four —
  `carryReasoningState`, `nativeCompaction`, `allowCrossProviderRelay` and the per-turn
  `askDoneAfterEachTurn` prompt — depend on the Provider Adapter Harness and Loop Reasoning slices
  and are deliberately not offered, because a switch that changes nothing is worse than no switch.
- There is no automatic launch of the next agent. The ladder is recorded, and on the relay step a
  packet is queued for the task's next run, but nothing starts that run. A user's Retry, a queued
  message, a schedule or a team dispatch is what starts it, and the packet rides along.
- The `stalled` end kind is defined and unused: the desktop has no per-run stall watchdog outside a
  team, so only `harness` and `crashed` are recorded today.
- OriginFold and Memory Fabric are not integrated. A packet references saved conversation rows by
  id and reads neither.
- There is no cross-machine sync. Checkpoints, packets and escalations live in the local database;
  relaying a task to another computer is not part of this feature.
- The composer Extras popover and the Settings Relay page edit the four real preferences only; no
  "Benchmark mode" preset is offered.

## Verification

Run from `src-tauri/`:

```sh
cargo test --lib relay::
cargo test --lib context_recovery::
```

The relay suite covers the checkpoint bounds and ordinals, the packet's role filter, ordering,
budgets and truncation, idempotent delivery across retries and restarts, escalation and its reset,
the done-gate, fail-open handling, the four preferences, the automatic queue on the relay step, and a
database from before relay gaining the tables while `user_version` stays 37.

The UI is `src/relay.ts` (card decoder, checkpoint chip, Extras popover, preference reads) with
`src/relay.css`; the Settings page is in `src/settings.ts` and `src/settings-sections.ts`, and the
preview fixtures are in `src/preview.ts`. Verify the frontend with:

```sh
npx tsc --noEmit
npm run build && node --test tests/*.test.mjs
```

The docs checks are run from the repository root:

```sh
node --test tests/agents-md.test.mjs
```
