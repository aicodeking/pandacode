# Architect and workers

By default, **Team** opens a menu that turns an automatic team led by the
selected model on or off. While its model catalog and setup are loading, the
button highlights immediately and shows a busy indicator. Sending and
model/permission changes wait for setup to finish, and queued follow-ups go out
once it does; the prompt stays editable. A failed save shows in the menu and
leaves the saved team as it was. Settings → Agents → **Classic team setup** opens the
manual setup described below instead.

Open **Team** in the composer, choose the architect model and one or more worker
profiles in the anchored popover, then **Save setup**. Profile and model pickers
open directly from it; **Run limits** contains the less common settings. Send a
task normally or start it from the board.
The architect can delegate several assignments in one call, review their results,
and send corrections to an existing worker context. **Open workers** shows each
assignment's streamed response, tools, saved conversation, and approval requests.

**Lead guidance** adds your own instructions to the built-in architect rules — for
example, that the architect should only coordinate and never edit files itself. It
is sent with the rules, so it reaches the architect whenever the rules do, and
**Reset to default** clears it back to the app-wide guidance, or the built-in rules alone when none is set. Settings → Agents
sets one for every team; a team's own guidance, set in its setup, replaces it for
that team. It is added after
the built-in rules and never replaces them, including the guard that treats worker
output as data rather than instructions.

The architect and each worker can independently use Claude Code, Codex, Kimi
Code, OpenCode, GLM through Claude Code, or Antigravity. Model and effort choices come from the existing harness catalog; configured
custom model IDs remain available. A model must be supported by the selected
harness and the user's account. PandaCode does not supply inference or API credits.

## Model routing

In an automatic team the lead can set `profileId: "auto"` on an assignment, and
PandaCode picks the worker's model locally from every installed harness's models.
The prompt box's Team menu chooses how: *Cheap team*, *Balanced team* or *Best team*,
one global mode that a running automatic team also follows. In Cheap and Balanced a
new worker starts on the ladder's first, cheapest safe rung. The lead verifies each
routed result (tests, typecheck or review); when a worker fails, or completes with a
result that fails that check, the lead dispatches a replacement with
`replaces: <worker ID>` and `profileId: "auto"`. The old worker counts as abandoned
and the router escalates to a stronger model than every model that failed the
assignment, for at most 2 retries; after that the lead reports the failure.
See [model routing](model-routing.md).

## Saved setups and profiles

**Save setup** remembers the complete team for this task and future tasks, across
projects and app restarts. That includes the architect and worker harnesses,
models, reasoning efforts, and run limits. New conversation, board, and worktree
tasks inherit a fresh copy; they do not start until you send a message or choose
Start. Existing tasks keep their own configurations and histories.

Use **Save as…** to keep a named team profile, then **Choose team profile** to load
one into the setup form. **Save setup** (or **Apply setup** for a used team) applies the selection and makes it the new
default. Editing a template with **Update profile** or saving a new one does not
silently change the current task or default. The profile menu also offers Rename
and Delete. Deleting a profile retains the applied setup and task histories.

**Use a single agent** disables team inheritance for new tasks while retaining
your saved setup and profiles. Teams that already have worker history retain their
team controls so those transcripts remain accessible. Up to
20 named team profiles can be saved. Profile changes never grant new permissions;
the task's existing approval behavior is preserved.

### Switching during work

Open **Team**, or the composer's model label while a team is enabled, choose a
saved profile, and select **Apply setup**. Models and limits remain editable while
the team runs. If the architect is responding, PandaCode queues the setup until
that turn finishes; the composer shows **queued** and reopening the picker shows
the pending selection. Choosing another setup replaces it, and choosing the
effective setup cancels the queued change. If only workers are running, the new
setup can apply immediately for the architect's next turn.

Existing assignments, including queued workers and follow-ups, keep their original
models and conversations. Newly dispatched assignments use the new worker profiles.
Switching never starts an extra turn, cancels work, or resets the review budget.
Limits cannot fall below rounds or assignments already used. Pending selections
survive a restart and apply when you explicitly resume the interrupted team.

Changing the architect model within the same harness preserves its native
conversation. Changing harnesses uses PandaCode's saved-history handoff (up to the
latest 200 messages and 64 KiB); the full visible transcript remains unchanged.

## Execution

- Worker profiles are reusable model choices, not permanently running processes.
  The architect creates named assignments from those profiles as needed.
- PandaCode imposes no global limit on simultaneous agents. New team setups use
  **Unlimited** parallel workers; existing finite team preferences remain saved.
  A team with a finite limit queues excess assignments until a slot is available.
  Each worker has its own persistent harness session and conversation.
- Workers use the parent task's project and checkout. If the task is already in
  a worktree, the team works there. Workers do not create projects or clutter the
  sidebar and board. Their transcripts remain accessible through the team panel.
- Every new assignment declares its `files` scope explicitly; omitted scopes are
  rejected instead of silently reserving the checkout. For writing assignments,
  scopes cover only files they may edit, not files they need to read. Overlapping
  writing scopes are serialized; an explicitly empty writer scope reserves the
  checkout. `readOnly: true` assignments must not edit files and can run alongside
  readers and writers, while still honoring dependencies and the parallel limit.
  Follow-ups inherit the previous scope and access unless explicitly changed.
  The architect batches independent work and can reuse the same model profile for
  several assignments. Queued workers explain dependency, slot, or edit-scope waits
  in the team panel and worker tools. These are advisory task
  boundaries, not an operating-system filesystem sandbox. Normal harness approval
  and sandbox behavior applies. Other apps and terminals can still edit files.
- Dependencies refer to already-created assignments. The scheduler launches work
  only when its dependencies have completed. Assignment keys prevent a retried
  tool call from creating the same worker twice within one objective; a new
  request may reuse a key and gets a new worker. Repeating a key whose worker
  already finished returns that worker with `duplicates`, so the architect knows
  nothing new will run. The assignment limit counts only the current objective's
  workers.
- An architect may end its turn while workers run. Native completion events wake
  it for a compact review after work settles. There is no background model polling
  loop and no repeated prompt when worker state is unchanged. Each turn ends the
  harness process, so background commands, monitors and scheduled wakeups never
  report back; Claude runs disable ScheduleWakeup, Monitor and CronCreate, and
  the instructions say so.
- If a review or update turn ends without dispatching work or finishing, the
  architect gets one **Continuing the plan** turn; a second stall pauses the team
  with a notice. A turn that answers the user's own message without delegating
  (a question about the work) leaves the team ready, not paused.
- A worker that cannot start (for example while an agent update installs) fails
  alone; the rest of the team keeps working and the architect reviews it.
- A worker that fails while others still run goes to the architect right away in
  a **Handling a failed worker** turn, so it can retry or replace that worker
  without waiting for the slowest one. It uses a round, and never the last one.
- A team turn with no harness output for 20 minutes is stopped. Claude's longest
  tool timeout is 10 minutes, and a turn waiting on your approval or answer never
  counts as silent. A silent worker settles as failed and the architect handles it.
  A silent architect turn shows a notice; its workers keep running, and if
  nothing was dispatched the architect gets one **Continuing the plan** turn.
- An architect turn ends with no pre-started spare process while its workers are
  unsettled; the wake after they settle starts cold, so no idle process holds
  memory meanwhile.
- Explicit completion moves the parent task to Review. Marking the task complete
  and its seven-day archive policy work as before.

## Sub-workers

A direct worker can start its own sub-workers, only when genuinely needed (the
work is truly parallel or needs a different model). This is one level deep:
sub-workers cannot start workers. The worker gets `pandacode_dispatch_workers`
and one `pandacode_sub_workers` tool (`action`: `list`, `read`, `followup`,
`cancel`), both limited to its own children, with at most 3 unsettled and 6 in
all; they count against the team's assignment limit. A sub-worker's write scope
must lie inside its parent's, `dependsOn` names only its siblings, and a
read-only parent starts only read-only children. A parent and its children never
block each other's scopes.

When a worker's run ends cleanly while its children still work, it is **parked**:
its process exits, freeing its memory, and the team panel shows
**Waiting on sub-workers**. When they settle, it resumes with one compact turn of
their results, using no attempt and no architect round. A sub-worker's failure
goes to its parent, never to the architect. Cancelling a parent, or its failure,
stops its unfinished children; Pause and Stop stop them with the rest of the team,
and a parked parent resumes after them. The team panel lists sub-workers indented
under their parent.

## Communication and checkpoints

Architects and workers can send direct messages to teammates, even when they use
different harnesses. This is local team coordination, not a public A2A network
endpoint. Open **Workers → Team messages** to inspect questions and handoffs.
Select a worker to see its latest progress checkpoint alongside its transcript.

- `pandacode_team_directory` (workers; the architect's `list_workers` covers it)
  returns teammate IDs, status, and advisory file scopes.
- `pandacode_send_team_message` sends a bounded message to the architect, one
  worker, or `all` (one copy per active teammate). `replyTo` threads a reply to a
  message the sender received. Stable request keys deduplicate retried sends;
  different content cannot reuse the same key. `urgent: true` also steers the text
  into a running worker's current turn, at most once a minute per sender and
  recipient; otherwise it stays in the mailbox. The architect is never steered.
- `pandacode_read_team_mailbox` reads only messages addressed to the calling agent,
  with a cursor for incremental reads. Every team tool result carries a digest of
  unread messages, so agents never poll. Agent identities are bound by the host;
  agents cannot supply another team or sender identity.
- `pandacode_team_notes` (`set`, `get`, `list`) is a shared blackboard for durable
  facts such as API shapes and decisions: up to 64 notes of 1 KiB per team; an
  empty value deletes a note. Briefs include the newest notes in full, and later
  turns only notes changed since.
- `pandacode_checkpoint_worker` saves a worker's progress summary, concrete next
  steps, and optional blocker. It returns the worker's recent incoming messages.
  Checkpoints survive app restarts and are included in resumed worker prompts and
  compact architect reviews. They report progress; they do not mark work complete.

Each team conversation gets the full team rules and coordination guide once. While
the harness resumes the same conversation, later turns get a one-line reminder (which
names the user's team guidance when one is set) and only the messages they have not
seen. The full rules go out again when they change
(for example new limits), when the harness starts a new conversation, and on every
eighth turn so a compacted conversation never loses them for long. The architect's
review, update, failure and continue turns quote the objective in full only on those
turns or when it is under 2,000 bytes; otherwise they carry its first 1,400 and last 600 bytes, marked "objective unchanged".

Tool descriptions are terse and leave out what the rules already say; string
limits, harness names and unknown fields are checked by the handlers, whose errors
name the limit, rather than repeated in every turn's schemas.
`team_turn_overhead_stays_within_budget` keeps the architect's team tools under
4,200 bytes and a worker's under 3,000.

Only an urgent message or a new blocker wakes an idle architect while workers
continue; other messages wait for its next review or turn. Notification turns use
the same round budget, reserving the final round for settled-result review.
Workers see new messages in the digest on their next team tool call; apart from
an urgent steer, PandaCode does not interrupt a running model response, and it
never restarts a completed worker to deliver a message. The architect uses a follow-up assignment
when a completed worker needs to do more work.

Messages, notes and checkpoints are stored in SQLite. Each team accepts at most
1,000 messages of 2 KiB each (a broadcast stores one per recipient) and 64 notes
of 1 KiB; each worker can save up to 200 checkpoints. Only the latest
checkpoint is included in team snapshots. Message history loads on demand and
refreshes from team events, with no polling timer. These reports never override
the user's instructions, file scopes, or harness approval policy.

## Limits and recovery

Setup offers parallelism, architect-round, assignment-count, and worker-summary
limits. A worker gets at most three attempts, including follow-ups. These limits
bound orchestration, not a provider's bill. Pause and Stop cancel active team
processes and prevent queued work from starting; Resume explicitly retries
unfinished work. Pausing, stopping and restarting do not use up worker attempts;
only failures do. Resume waits briefly for stopping agents to exit. Resuming a
team paused at its round limit grants four more rounds, up to the maximum of 20.
Team errors and pauses you did not ask for appear as a notice, and a worker that
needs an approval or answer is announced even with the panel closed. An app restart recovers the team as interrupted instead of
silently starting more inference. Team profiles and limits can be changed during
work or while paused using the same setup picker.

Switching between a team and a single agent preserves Claude and Kimi's native
conversation; they reload the MCP tools when resuming. Codex binds dynamic tools
at thread creation, so changing its catalog starts a new native context with a
one-time transfer of the saved conversation. Saving an unchanged setup never
resets context. The transfer is bounded to the latest 200 user/assistant messages
and 64 KiB of encoded history, with an explicit notice if any history is shortened.
It stays pending through failures or restarts until a normal turn succeeds.
Workers receive their assignment, scope, and concise output instructions rather
than a copy of the parent conversation. Reviews use bounded results, and the
architect can request more worker detail when necessary.

The existing context-usage numbers measure current context occupancy. They are
not billed-token totals and are not used to invent dollar or percentage savings.
Using a less expensive worker model can reduce cost, but results depend on the
task, selected models, retries, and the provider's pricing. The
[user's reference](https://www.reddit.com/r/vibecoding/comments/1wg5ogw/astra_8_deepseek_41_subagents_insanely_cheap/)
is an anecdotal example of this workflow, not a performance guarantee.

## Native integration

`architect_teams` persists configuration and run state. `architect_workers` links
each managed assignment to a real task. Generation checks prevent stale starts
and callbacks after cancellation. The existing provider runner still owns
streaming, approvals, process cleanup, and transcript persistence.

Codex receives the team's dynamic tool catalog on thread creation. Other supported
harnesses receive their role's catalog through a temporary, native loopback MCP
endpoint, using Claude's MCP configuration or ACP HTTP MCP negotiation. The endpoint is authenticated per run, bound to literal loopback,
rejects browser origins, bounds requests and results, and closes with its provider
run. It adds no Node/Python server, permanent configuration file, or resident
service. ACP harnesses must advertise HTTP MCP support. Existing user integrations remain
configured; this bridge does not grant access to PandaCode's broader app tools.
Team tools (dispatch, list, read, follow up, cancel, finish, directory,
messages, notes and checkpoints) run without a Claude permission prompt: they only
change this team's state and every call is checked against the caller's team,
generation and role. Other tools keep the harness's normal approval modes.
Team workers do not keep a pre-started process, so the architect's stays
available for its review turn.

Team snapshots also track the architect tool-catalog version. An older Codex
architect gets a fresh native context on its next turn when its saved catalog
cannot describe the new assignment fields. The visible transcript stays intact;
the existing bounded conversation handoff restores its recent context. This is
atomic and happens once. A Codex worker whose tools changed (sub-workers, team
notes, the version 8 catalog) restarts its native context the same way; other
tasks keep their native IDs.

The architect has scoped tools for batch delegation, status, worker details,
follow-ups, cancellation, and final review. Both roles receive team communication
tools and team notes; workers additionally receive checkpoint saving. A direct
worker's dispatch and `sub_workers` tools reach only its own sub-workers; sub-workers get none, and no worker can finish the team. Generation and attempt checks reject late calls after
pause, cancellation, or retry. Native goals and team orchestration cannot be
active together on the same task.

The regular browser preview runs clearly labeled simulations. Native and protocol
tests use local fixture processes and do not purchase or consume model inference.

## IPC

Schema version 11 adds the team, worker relationship, and idempotent-request
tables; version 12 adds the saved team library. On upgrade, the most recently
saved existing team seeds the default once. An explicit single-agent preference
is not overwritten on a later restart. The frontend receives `architect-event` snapshots with a monotonically
increasing `revision`; disabling an unused team emits `{sessionId, removed:true}`.
Worker streaming continues through `agent-event`, keyed by the worker's real
session ID. The UI uses `architect_worker_messages` with both parent and worker
IDs to page history without exposing managed workers as ordinary tasks.

Schema version 16 adds `architect_messages`. Existing Codex team contexts receive
a one-time saved-history transfer on their next explicit run, because Codex binds
dynamic tools at native thread creation. An upgrade does not start inference.
`architect_team_messages` pages the current task's coordination history for the
user interface, separately from the agent's recipient-scoped mailbox.

Configuration includes one to six worker profiles, `maxParallel` (0 for Unlimited,
or a positive integer for a finite limit),
`maxRounds` (1–20), `maxAssignments` (1–50), `summaryLimit` (512–6000 UTF-8
bytes), and optional `leadGuidance` (under 2000 UTF-8 bytes; absent or blank means the
app-wide guidance, else the built-in rules alone). `workspace` is currently `shared`. Limits and summaries do not authorize
broader permissions. Each assignment retains its original model selection even
when the team's profiles change. `TeamSnapshot.pendingSetup` contains the queued
`{architect, config}` until the parent process finishes; it is persisted with the
team and cleared atomically when applied. `config` and the parent `Session` always
describe the effective setup. No schema migration is needed for this optional field.
An architect can explicitly resolve cancelled work with a reason; unresolved
failures prevent successful completion.
