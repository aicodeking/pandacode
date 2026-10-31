# Machine orchestration

Off by default. With **Settings → Remote access → Agent orchestration** on, an agent on this
computer can link one of the user's other computers (PandaCode Connect, `docs/remote-access.md`)
and then launch, message and wait on threads there. Each launched thread is an ordinary mirror
task on this computer (sidebar, transcript, approvals), recorded as a *child* of the task that
launched it. Nothing new crosses the network: launches, messages and events use the existing
encrypted host RPC (`task.start`, `task.find`, `task.send`, `task.steer`, `task.stop`, `task.messages`).

## Links

A link is this computer's permission for its agents to use another computer. It is stored in
`remote.json` (`Settings.links: { deviceId: { access, at } }`, `Settings.orchestration: bool`).
A link counts only while that device is a target (`remote_targets`: trusted with its current
key, hosting on). Untrusting, revoking or signing out removes links, and so does trusting a
new or changed key: a link belongs to the computer behind the key it was given to.

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
| `pandacode_machine_list` | no | Machines: id, name, platform, online, hosting, trusted, `access` (or null). Plus guidance: spread independent work across linked machines. |
| `pandacode_machine_link` `{ machine?, reason }` | no (the dialog is the approval) | Already linked → returns at once. Otherwise emits `machine-link-request` (once per task: a later call from the same task joins the same request, no second card) and waits ≤ 40 s. The request itself stays open for the user for 10 min, independent of the call; task stop cancels it. Unanswered → `{ linked: false, pending: true, requestId, hint }` (“Ask the user to answer the Link a machine card; call machine_link again or end your turn”). Answered → `{ linked, machine?, access?, reason? }`; every call joined to the request gets the same answer, including one that leaves while the answer is being saved (a call made then joins that request too). An answer no call is waiting for wakes an idle task once (see Waking); a call dropped without returning (its client closed) stops counting as waiting, and if it already held an unread answer the task is woken for it. Signing out cancels every request (`machine-link-settled`).
| `pandacode_machine_capabilities` `{ machine }` | no | Linked (any access). The machine's installed harnesses and their models (the cached `providers.list`), bounded. |
| `pandacode_machine_launch` `{ machine, prompt, provider, model, title?, effort?, worktree? }` | yes, unless Full access | `ask`/`full` link; not from a `plan` task. The provider's model list on that machine is fetched first (`providers.models`, cached), so an unavailable model is refused (`default` passes). Commits the mirror row and the child (with the commit-point re-check) and spawns `task.start` on the app runtime in the same step, so the tool deadline can't drop a launch between the two; returns at once with `{ thread, machine, mode, status: "starting" }` (`worktree` default true; title set; ≤ 8 running children per parent). `task.start` carries the thread id as `startId`, so it starts at most one task there; a lost reply or a quit is resolved with `task.find` (docs/remote-access.md): found → adopted, never received → `error` (“PandaCode quit while this thread was starting.”), host offline or still starting → retried at the next presence change. A start that fails keeps the child as `error`, with the reason as its final reply, and the normal wake reports it. Stopping a thread while it starts ends it here at once (`interrupted`, saved in the row) and stops it on the host when its task is adopted; if the start then fails or is not found there, the thread stays stopped (never an error, deleted or reset).
| `pandacode_machine_wait` `{ threads?, timeoutSeconds? }` | no | Waits (event driven, no polling, woken only by its own task's children; default 30 s, max 40 s) until each listed child (default: all running children) is no longer running, or needs the user (waiting). Returns each thread's status and final reply (≤ 8 KB each and 96 KB shared across all of them, measured as escaped JSON; the whole serialized result stays ≤ 120 KiB, replies halved until it fits, under the 128 KiB result limit of both host tool paths); a thread that can't be read (unlinked meanwhile, say) gets `{ thread, error }` in its entry instead. |
| `pandacode_machine_read` `{ thread, beforeId? }` | no | A bounded page of a child's messages. Content is untrusted data. |
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

Whatever the client: when a call is cancelled (`notifications/cancelled`), its client closes the connection (gave up), or the turn stops, the MCP host drops the call, which removes its pending approval (`approval_cancelled`), so a late Approve can never launch or message. A harness that gives up after approving but before the call ends (only possible under a shorter client limit) may still see a launch it was told timed out; the thread still shows in `machine_wait` (no ids) and the lineage strip.

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

## Storage

Schema 28: `machine_threads(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0)` with an index on `(parent_session_id, reported)`.

Schema 29: `machine_threads.reported_by INTEGER` (the wake message that reported the thread, indexed); `sessions.restart_interrupted INTEGER NOT NULL DEFAULT 0` (interrupted by a restart, not the user); and on the host `sessions.remote_caller TEXT` + `sessions.remote_start_id TEXT` with a unique index on the pair (where `remote_start_id` is set), the `startId` of the viewer that started the task, plus `sessions.remote_start_state TEXT` (`starting` | `started`).

Schema 30: `sessions.stop_requested INTEGER NOT NULL DEFAULT 0` (the user pressed Stop; `Store::open` never marks such a task `restart_interrupted`). A mirror row whose start ended without a host task after the user stopped it gets `remote_start_state='ended'`.

## Tauri commands (UI contract)

| Command | Args | Returns |
|---|---|---|
| `orchestration_status` | | `{ enabled, links: [{ deviceId, name, platform, online, access }] }` (current targets only) |
| `orchestration_set_enabled` | `{ enabled }` | status |
| `orchestration_set_link` | `{ deviceId, access: "read" \| "ask" \| "full" \| null }` | status. `deviceId` must be a target. `null` unlinks. |
| `orchestration_pending` | | `[{ requestId, sessionId, machine: deviceId \| null, reason }]`; `[]` while orchestration is off |
| `orchestration_link_respond` | `{ requestId, deviceId?, access? }` | status. Without `deviceId`/`access` it declines. Exactly one answer wins: a later one fails with “This link request was already answered.” |
| `orchestration_children` | `{ sessionId }` | `[{ sessionId, title, provider, model, status, machine: { id, name }, createdAt }]`, oldest first: every running/waiting child plus at most the 24 newest settled ones. `[]` while orchestration is off. |
| `orchestration_threads` | `{ sessionId, ids: string[] }` (≤ 64) | The `orchestration_children` row shape for only those `ids` that are this parent's own children, oldest first (others are skipped). For the transcript cards of older launches. `[]` while orchestration is off. |

Window events: `orchestration://status` (status; also on presence changes such as online,
offline or trust while orchestration is on and something is linked, coalesced to one per
250 ms), `machine-link-request` (a pending entry),
`machine-link-settled` (`{ requestId }`), plus the ordinary `sessions-changed` and `agent-event`.

## UI (`src/machine-orchestration.ts`, `src/machine-orchestration.css`)

- **Link card** above the composer of the requesting task: “Link a machine to this
  environment”, the agent's reason, **Not now** and **Link…**.
- **Link a machine** dialog, two steps. 1 *Machine*: every device on the account except this
  one, with badges (Linked, Offline, Remote control off, Not trusted); untrusted or non-hosting
  rows are disabled with the fix named. 2 *Access*: Read only / Ask first / Full access with the
  description above. Cancel · Continue, Back · Link.
- **Lineage strip** above the composer when the task has children: stacked harness initials,
  “N threads on ProMini”, running count; expands to one row per child (title, “on Machine ·
  Running”), opening the child on click, with Stop. While the parent is idle and children run it
  reads “Waiting on N threads” with Stop all.
- **Settings → Remote access** (signed in): the Agent orchestration switch and a Linked
  computers list (access select, Unlink).

Preview mocks: `src/preview-remote.ts`. Browser tests: `tests/machine-orchestration.spec.ts`.
