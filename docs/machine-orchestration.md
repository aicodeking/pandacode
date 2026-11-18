# Machine orchestration

Off by default. With **Settings → Remote access → Agent orchestration** on, an agent on this
computer can link one of the user's other computers (PandaCode Connect, `docs/remote-access.md`)
and then launch, message and wait on threads there. Each launched thread is an ordinary mirror
task on this computer (sidebar, transcript, approvals), recorded as a *child* of the task that
launched it. Nothing new crosses the network: launches, messages and events use the existing
encrypted host RPC (`task.start`, `task.startStatus`, `task.cancelStart`, `task.send`, `task.steer`, `task.stop`, `task.messages`).

## Links

A link is this computer's permission for its agents to use another computer. It is stored in
`remote.json` (`Settings.links: { deviceId: { access, at, key, name } }`, `Settings.orchestration: bool`).
A link counts only while that device is on the account, is hosting or offline (presence reports
every offline device as not hosting, so an offline computer keeps its link until it comes back
with remote control off), and still has the public key it was linked under (`key`): a link
belongs to the computer behind that key, so a changed key (or a link saved without one) counts
for nothing until the user links it again.
Revoking or signing out removes links. A computer that left the account another way keeps its
stored link, which still serves `machine_wait` and `machine_read` from the local copy, so Settings
lists it as “<name> · Left the account” (`name`, kept at link time; “Removed computer” for an
older link) with Unlink only. It can't be given access, and no tool, warm or dialog offers it.
What the other computer lets this one do there is its
own scoped pairing grant (docs/remote-access.md); launching needs `full` there.

| Access | Agents here may |
|---|---|
| `read` | see the machine's harnesses and models, read threads they launched there. Cannot start, message or stop anything. |
| `ask` | also launch and message threads; launched threads run in Standard (`ask`) mode, so their approvals come back here. |
| `full` | as `ask`, but a thread runs in Full access when the launching task itself is in Full access. |

An agent never gets more access there than its own mode here: the child's mode is `full` only
when the link is `full` **and** the parent's mode is `full`; otherwise (`ask`, `auto`) `ask`. A
parent in `plan` mode cannot launch. The link and the parent's mode are read again where the
mirror row is made, after the launch's slow checks, so a link removed or lowered below `ask`
meanwhile refuses the launch. Agents can change only threads their own task launched (the
`machine_threads` row), never that machine's own threads; messaging a `full` thread needs a
current `full` link.

Agents never link on their own: `pandacode_machine_link` asks the user with a card and the
Link a machine dialog, and the user picks the machine and the access.

## Agent tools (`src-tauri/src/remote/orchestrate.rs`)

Composed in `lib.rs` beside `with_vm` (`with_machines`), only when orchestration is on and the
user is signed in, and never for team tasks (architect or worker), which coordinate through
their team; every call re-checks both. Machine arguments take a device id or a name
(case-insensitive). Thread ids are the local mirror session ids.

| Tool | Approval | Does |
|---|---|---|
| `pandacode_machine_list` | no | Machines: id, name, platform, online, hosting, `access` (or null), `lastSeen`, `runningThreads` (this task's running children there) and `harnesses` (installed harness ids from the catalog cache; null when not cached; list never calls the network). `runningThreads` leaves out threads waiting on the user. Plus guidance: spread independent work across linked machines. |
| `pandacode_machine_link` `{ machine?, reason }` | no (the dialog is the approval) | Already linked → returns at once. Otherwise emits `machine-link-request` (once per task: a later call from the same task joins the same request, no second card) and waits ≤ 40 s. The request itself stays open for the user for 10 min, independent of the call; task stop cancels it. Unanswered → `{ linked: false, pending: true, requestId, hint }` (“Ask the user to answer the Link a machine card; call machine_link again or end your turn”). Answered → `{ linked, machine?, access?, reason? }`; every call joined to the request gets the same answer, including one that leaves while the answer is being saved (a call made then joins that request too). An answer no call is waiting for wakes an idle task once (see Waking); a call dropped without returning (its client closed) stops counting as waiting, and if it already held an unread answer the task is woken for it. Signing out cancels every request (`machine-link-settled`).
| `pandacode_machine_capabilities` `{ machine }` | no | Linked (any access). The machine's installed harnesses and their models (the cached `providers.list`), bounded. |
| `pandacode_machine_launch` `{ machine, prompt, provider, model, title?, effort?, worktree? }` | yes, unless Full access | `ask`/`full` link, computer online (`<name> is offline.`, before anything is committed); not from a `plan` task. `machine: "auto"` (always this meaning, even if a computer is named auto) picks the online computer with an `ask`/`full` link that has the provider and the model, with the fewest running threads across the whole app (threads waiting on the user don't count), tie-broken by name (`pick_machine`). It first asks any candidate whose lists aren't cached, at most 10 s per round (`AUTO_ASK`), so the tool still answers under 45 s; one that can't name its harnesses does not qualify, and one that can't name its models goes after those known to have the model (the launch still checks it). `default` passes everywhere. If none qualifies the error says why: none linked, all offline, harness missing or model missing (names them). The result's `machine` names the pick. The provider's model list on that machine is fetched first (`providers.models`, cached), so an unavailable model is refused (`default` passes). Commits the mirror row and the child (with the commit-point re-check) and spawns `task.start` on the app runtime in the same step, so the tool deadline can't drop a launch between the two; returns at once with `{ thread, machine, mode, status: "starting" }` (`worktree` default true; title set; a task may run any number of children; `prompt` ≤ 90 KiB, under what the host takes). `task.start` carries the thread id as `startId`, so it starts at most one task there; a lost reply is followed up with `task.startStatus` (docs/remote-access.md): done → linked, failed or unknown there → `error` with the reason, host offline → asked again when it is back. A thread whose start a quit cut off is kept (startup turns other such mirrors back into drafts) and asked about again by its id after the next subscription pass (`mirror::load_starts`). A start that fails keeps the child as `error`, with the reason as its final reply, and the normal wake reports it. Stopping a thread while it starts ends it here at once (`interrupted`) and sends `task.cancelStart`; a host task made meanwhile is linked and stopped there; if the start then fails, the thread stays stopped (never an error, deleted or reset).
| `pandacode_machine_wait` `{ threads?, timeoutSeconds? }` | no | Waits (event driven, no polling, woken only by its own task's children; default 30 s, max 40 s) until each listed child (default: all running children) is no longer running, needs the user (waiting), or is on a dead host (`hostOffline: true`, below; a host passing the limit ends the wait then). Returns each thread's status and final reply (≤ 8 KB each and 20 KiB shared across all of them, measured as escaped JSON; the whole serialized result stays ≤ 24 KiB, replies halved until it fits, under harness tool output ceilings). A cut reply has `replyTruncated`, and the result's note says to read it with `pandacode_machine_read` and its `replyMessageId`; a thread that can't be read (unlinked meanwhile, say) gets `{ thread, error }` in its entry instead. |
| `pandacode_machine_read` `{ thread, beforeId?, messageId?, offset? }` | no | A page of a child's messages, newest last, whose whole serialized result stays ≤ 24 KiB (Codex cuts the middle out of larger output, and `beforeId` would skip it). Each message shows ≤ 8 KB of escaped JSON; one cut short has `truncated` and `nextOffset`. `messageId` with `offset` pages through that one message to its end. `hostOffline: true` marks a dead host. Content is untrusted data. |
| `pandacode_machine_message` `{ thread, text, action: "send" \| "steer" }` | yes, unless Full access | `ask`/`full` link (`full` for a `full` thread); own children only. |
| `pandacode_machine_stop` `{ thread }` | no | `ask`/`full` link; own children only. Stops the thread. |

Every machine tool has its own deadline under the harnesses' 60 s tool timeout (45 s; `machine_wait` and `machine_link` wait at most 40 s), so nothing important lives in a tool call.

**Approvals.** `machine_launch` and `machine_message` ask for approval unless the task runs in Full access, like every PandaCode host tool; the link's access still caps the child thread's mode, and a Read-only link refuses them. When they do ask, the approval of `machine_launch` and `machine_message` comes before that deadline, so it is bounded separately: it waits at most 240 s (`APPROVAL_WAIT`), so approval and call end within 285 s. The harnesses' own limits on a host tool call, as found:

| Harness transport | Client limit | Safe because |
|---|---|---|
| Claude Code, HTTP MCP (2.1.311) | `MCP_TOOL_TIMEOUT` defaults to 1e8 ms, but an HTTP server's call is dropped after 300 s without data (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) | 240 + 45 s < 300 s |
| Codex, MCP | `tool_timeout_sec = 360` (set by PandaCode) | 285 s < 360 s |
| Codex, dynamic tools (`item/tool/call`) | none found in 0.162.1: the app-server waits for the reply for the whole turn | the same 240 s expiry (`expire_approvals` in `host_tools.rs`): an expired approval is declined and a late Approve runs nothing; stop or interrupt also declines it (`cancel_requests`) |
| ACP harnesses (MCP) | their own MCP client's (the MCP TypeScript SDK's default is 60 s, which sends `notifications/cancelled`) | a cancelled call or a closed connection ends the call |

Whatever the client: when a call is cancelled (`notifications/cancelled`), its client closes the connection (gave up), or the turn stops, the MCP host drops the call, which removes its pending approval (`approval_cancelled`), so a late Approve can never launch or message. A harness that gives up after approving but before the call ends (only possible under a shorter client limit) may still see a launch it was told timed out; the thread still shows in `machine_wait` (no ids) and the Lineage panel.

**Waking.** Agents should end their turn after launching. When a parent's last running child
settles and the parent is idle, PandaCode starts the parent's next turn with one app-origin
message listing every unreported child (title, machine, status, final reply excerpt ≤ 2 KB).
If the parent is running then, it is woken at its run end. Each child is reported at least once and, once the agent saw it, never again
(`machine_threads.reported`, `reported_by`): the run claims the children under its admission
lock and marks them reported, with the message that carries them, in the transaction that
saves the app-origin message. A wake turn that never reached its agent (no assistant or tool
message after it: a failed preparation, a harness that did not start, a crash) gives them back
at its run end, or at startup (not for a task running then). A turn that gave its claim back
does not wake again right away, so a harness that cannot start does not loop; the claim waits
for the next run end, reopen or startup. A wake turn whose run fails while it is being
prepared also deletes its saved message and ends the turn, so the retry shows one message. A
link answer works the same way: it stays unread until its wake turn is saved, and such a turn
that never reached the agent puts it back; reopening a task, startup and turning
orchestration on deliver an unread answer too.

A restart marks running tasks `interrupted` with `restart_interrupted = 1`; a task the user
stopped is `interrupted` with it 0 (every turn start and end clears it). Stop saves the user's
intent (`sessions.stop_requested`) before the run hears of it, so a quit right after Stop still
leaves 0; the next turn start clears the flag. Only the former can be
woken: the user stopped the latter on purpose, and its wake waits until the user resumes it.
Mirrors keep their status across a restart (their host runs them; the subscription catches
up), so a child still running there still holds its parent's wake. At startup, link wakes are found from each task's newest message (one indexed lookup per task), never by scanning every message. Due wakes are retried at the parent's next run end, when it is
reopened (moved out of `completed`, restored from the archive), at startup and when
orchestration is turned on again. A wake reads only unreported children (at most 20 per turn)
once none is running. When the user answers a link request that no `machine_link` call is
waiting for and the task is idle, PandaCode starts its next turn once with a short app-origin
`MachineLink` message (“Machine link answered”) giving the result; otherwise the next
`machine_link` call (or run end) delivers it. A stopped (by the user), completed, archived or team parent,
or one with queued prompts, is not woken; its children keep running.

**A dead host.** A thread still running or waiting on a computer offline for longer than
`HOST_OFFLINE_AFTER` (5 min, by the relay's `lastSeen`), or one that left the account, reports
`hostOffline: true` in `orchestration_children`, `orchestration_threads`, `machine_wait` and
`machine_read`. Its status stays as stored; a settled thread never carries the field, and before
the first presence frame nothing does. When every running child of an idle parent is on such a
host, the parent gets one `MachineThreads` turn saying so, with any settled children due. That
turn sets `reported_by` on a child still running but leaves `reported` at 0, so no schema change:
it is not told again, and if its host returns and it finishes it reports as usual, once. A turn
that never reached its agent gives this back like any other wake. A computer that left the
account and still has a stored link stays readable through `machine_wait` and `machine_read` from
its local copy (`read_access`); launch, message and stop keep the current check, and unlinking cuts
it. Presence only says when a host left, so one sleeper (`watch_offline`, `links::Sleeper`) waits
for the next to pass the limit, re-aimed by every presence update and ended when orchestration is
off or nothing is due. A tick touches no database while nothing is linked and `machine_threads` is
known to be empty (`links::tick_idle`; the first row clears that), and skips the parents query
while no thread is active. A host passing the limit emits `sessions-changed` (once when a host with threads passes the
limit, once when it returns), ends the waits on its threads and wakes parents if due. `claim` reads a snapshot
of presence (`links::remember_presence`) since it holds the store lock and the commit point takes
those locks the other way round.

## Speed

Between `machine_launch` and the first look at the thread:

- **Catalog warming** (`catalog::warm`): when a link is made, orchestration turns on, or presence
  changes, each online linked computer's `providers.list` and the models of any provider already
  asked for are fetched in the background, at most once per the 10-minute cache per list (a failed
  fetch may be retried at the next warm). Each call re-checks orchestration, sign-in and the link
  right before it goes out (`links::may_warm`), so nothing is sent once they change. A provider's first
  launch on a computer still waits for its model list.
- **Fewer git processes**: the commit reads only the repository (config file) and branch (one git
  process); `repo_status`, with `git status`, stays for the UI's own check.
- **No wait after the reply**: the host already follows a task it starts for its viewer, so events
  flow from the link on. `linked` runs the subscribe round at once with the first page beside it
  (`subscribe_reconnected`) instead of debouncing, then copying.

An event that reaches the viewer before the `task.start` reply is dropped (no mirror row names it
yet). That is the run's `status` event, which the row already shows, since a harness takes far
longer than the reply to do anything.

Measured with `cargo test --lib remote::bench::machine_launch_phases -- --ignored --nocapture`
(debug build, Apple silicon, 2026-11-01; p50 of 5 launches, `claude` as the provider, this repository as
both checkout and `file://` origin). Before uses the old steps at the same commit. Real: git, the
local model list, host start steps, sealing and the relay emulator. Excluded: harness start and
model latency. Host start steps dominate what remains (a fetch and a worktree).

| from `machine_launch`, emulated WAN (20 ms each way to the relay, about 85 ms per call) | before | now |
|---|---:|---:|
| checkout read (`repo_status` / `start_target`, 10 runs) | 167 ms | 20 ms |
| catalog check, cold / warmed | 1305 ms | 0 ms |
| first agent event | 3559 ms | 1621 ms |
| first look (transcript copied) | 3989 ms | 1720 ms |

On the emulator's loopback link first look went from 4278 ms to 1255 ms. The cold catalog was the slowest avoidable
step; a launch that still misses the cache (its provider's first) keeps that cost.

## Tests

`src-tauri/src/remote/loopback.rs` runs the viewer's start path (`commit_row`, `start_body`,
`after_start`, `start_state`, `cancel_outcome`, `record_not_started`, `link`, `store_first`,
`finish_once`, `claim`) against the host's `parse`, `start_keyed`, `create_task`, `start_status_of`,
`cancel_start_of` and message pages, on two in-memory stores: launch → host task → run end → parent
wake; stop before and after the host commits; a lost reply and a start the host lost. Frames pass
by function call, because `tauri::AppHandle` means the Wry runtime here (the mock runtime is
another type, and a real one needs the main thread). **Not run by those tests:** `mirror::commit`,
`start` and `resume_start` as async functions, `client::call`, the socket and relay, subscribe
rounds, emitted events, `watch_offline`'s wiring (its `Sleeper` and `hosts_crossed` are tested), warming's calls, `machine_launch`'s tool
layer (`auto_machine`), and `start::start_task`'s git, clone and harness steps.

`remote::bench::live_two_computers` covers a real launch by a real host: an `#[ignore]`d test that
skips unless these are set. It has compiled but has never run. Quit PandaCode on the viewer first
and pair it with `full` scope on the host.

```sh
PANDACODE_RELAY_URL=https://… PANDACODE_LIVE_DIR=<viewer's signed-in app data> \
PANDACODE_LIVE_HOST=<host device id> PANDACODE_LIVE_REPO=owner/name PANDACODE_LIVE_PROVIDER=claude \
cargo test --lib remote::bench::live_two_computers -- --ignored --nocapture
```

## Storage

Schema 36 (one step, each part guarded so it can run again): `machine_threads(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0, reported_by INTEGER)` with indexes on `(parent_session_id, reported)` and `reported_by` (the wake message that reported the thread); `sessions.restart_interrupted INTEGER NOT NULL DEFAULT 0` (interrupted by a restart, not the user); `sessions.stop_requested INTEGER NOT NULL DEFAULT 0` (the user pressed Stop; `Store::open` never marks such a task `restart_interrupted`).

## Tauri commands (UI contract)

| Command | Args | Returns |
|---|---|---|
| `orchestration_status` | | `{ enabled, links: [{ deviceId, name, platform, online, access, departed? }] }` (links that count: an offline computer stays listed with `online: false`; then, after the first presence frame, stored links whose computer left the account, with `platform: ""`, `online: false`, `departed: true`) |
| `orchestration_set_enabled` | `{ enabled }` | status |
| `orchestration_set_link` | `{ deviceId, access: "read" \| "ask" \| "full" \| null }` | status. `deviceId` must be a target, except that `null` unlinks anything stored, including a computer that left the account. |
| `orchestration_pending` | | `[{ requestId, sessionId, machine: deviceId \| null, reason }]`; `[]` while orchestration is off |
| `orchestration_link_respond` | `{ requestId, deviceId?, access? }` | status. Without `deviceId`/`access` it declines. Exactly one answer wins: a later one fails with “This link request was already answered.” |
| `orchestration_children` | `{ sessionId }` | `[{ sessionId, title, provider, model, status, machine: { id, name }, createdAt, hostOffline? }]`, oldest first: every running/waiting child plus at most the 24 newest settled ones. `[]` while orchestration is off. |
| `orchestration_threads` | `{ sessionId, ids: string[] }` (≤ 64) | The `orchestration_children` row shape for only those `ids` that are this parent's own children, oldest first (others are skipped). For the transcript cards of older launches. `[]` while orchestration is off. |

Window events: `orchestration://status` (status; also on presence changes such as online,
offline or hosting while orchestration is on and something is linked, coalesced to one per
250 ms), `machine-link-request` (a pending entry),
`machine-link-settled` (`{ requestId }`), plus the ordinary `sessions-changed` and `agent-event`.

## UI (`src/machine-orchestration.ts`, `src/machine-orchestration.css`)

- **Link card** above the composer of the requesting task: “Link a machine to this
  environment”, the agent's reason, **Not now** and **Link…**.
- **Link a machine** dialog, two steps. 1 *Machine*: every device on the account except this
  one, with badges (Linked, Offline, Remote control off); non-hosting rows are disabled with
  the fix named. 2 *Access*: Read only / Ask first / Full access with the
  description above. Cancel · Continue, Back · Link.
- **Lineage panel** in the dock's Agents flyout (`#agents-flyout`) when the task has children: heading “Lineage · N running”, one keyed row per child (harness initials, title, “on Machine · Running”, or “Offline” for `hostOffline`) that opens the child on click, with Stop and Stop all. The Agents item appears for machine threads, and its badge and name count running ones.
- **Waiting line** above the composer, only while the parent is idle and children run: “Waiting on N threads · titles · Stop”. Its Stop leaves threads that need you alone.
- **Threads card** in the transcript: one per turn with launches, “N threads · M working”, a live elapsed time and expandable rows. A status change patches only that child's row.
- **Settings → Remote access** (signed in): the Agent orchestration switch and a Linked
  computers list (access select, Unlink; a computer that left the account has Unlink only).
  An offline computer keeps its link and its access can still change; a changed key needs linking again.

Preview mocks: `src/preview-remote.ts`. Browser tests: `tests/machine-orchestration.spec.ts`.
