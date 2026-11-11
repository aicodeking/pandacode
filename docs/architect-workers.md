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
open directly from it. Send a
task normally or start it from the board.
The architect can delegate several assignments in one call, review their results,
and send corrections to an existing worker context. **Open workers** shows each
assignment's streamed response, tools and saved conversation.

The team panel's compact **Workers** list (`WorkerList` and `teamTally` in `src/architect-worker-list.ts`) shows one row per
worker, sorted by status, under a tally ("3 working · 2 done") and a progress bar;
a row's chevron opens that worker's details. The `?workers` preview seeds a running
team with a worker in every state.

**Lead guidance** adds your own instructions to the built-in architect rules — for
example, that the architect should only coordinate and never edit files itself. It
is sent with the rules, so it reaches the architect whenever the rules do, and
**Reset to default** clears it back to the app-wide guidance, or the built-in rules alone when none is set. Settings → Agents
sets one for every team; a team's own guidance, set in its setup, replaces it for
that team. It is added after
the built-in rules and never replaces them, including the guard that treats worker
output as data rather than instructions.

The architect and each worker can independently use any of 18 harnesses: Claude
Code, Codex, Kimi Code, OpenCode, GLM and Xiaomi MiMo through Claude Code,
Antigravity, Grok Build, Pi, DeepSeek, Command Code, Cline, Kilo Code, omp, GitHub
Copilot CLI, Muse Code, Devin CLI, or Hermes Agent (`HARNESSES` in `architect.rs`;
ZCode is left out until it can bridge the team tools). Model and effort choices come from the existing harness catalog; configured
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

## Worker access and effort

**Policy: a lead in Plan or Ask mode still dispatches full-access workers.** The lead's
permission mode applies to the lead only. This is deliberate (Auto and Review leads too):
a worker that waited for approvals would stall the whole team.

Workers always run with **full access** (`WORKER_PERMISSION_MODE`, `"full"`, in
`architect.rs`). Each worker session is created in that mode and set back to it before every
worker turn, so retries and follow-ups never block. The lead started the team with your
authority, so the backend (`src-tauri/src/worker_approvals.rs`) answers a worker's requests:

- **Approvals** are granted. A worker's request never flips the task to "waiting" and never
  appears in the request list remote clients read.
- **Always-ask tools** (`ALWAYS_ASK` in `src-tauri/src/cloud/deploy.rs`: cloud CLI, scheduled
  messages) are declined; the worker is told to ask its lead. They are recognised by tool name,
  from an `Allow <tool>?` label or a bare (MCP-prefixed) tool-name label as Claude's permission
  prompt uses. On PandaCode's tool host, Codex host tools and Claude's permission prompt the
  decline itself says so ("Declined: team workers cannot run <tool>; ask your lead…");
  elsewhere the running turn is told, only on a harness that takes a message mid-turn
  (Claude-family, Codex, Pi, OpenCode, Devin). A user's own decline still reads "Declined by
  the user".
- **Questions** get "decide yourself" where text is accepted. A choice-only question gets the
  option marked recommended or default: a `recommended`/`default`/`isDefault` flag, a label
  starting with the word "Recommended", or a label or description ending in a whole
  "(Recommended)"/"(default)" clause ("No (Recommended)" counts; "(not recommended)",
  "riskier than recommended", "Unrecommended" and a description such as "Recommended only if
  you are sure" do not). With none marked it is cancelled, never "Yes" for coming first;
  answers are all or nothing, so one unmarked choice cancels a multi-question request. Secret
  questions are cancelled. An answered question leaves the pending lists at once and counts as
  worker activity for the silence watchdog; one asked while a pooled run changes accounts keeps
  waiting for the next account (up to two extra minutes).
- **Audit:** each automatic decision (with the request's first 300 characters) is kept as a
  note in the worker's transcript. The transcript's approval card for a worker stays only
  because a remote host on an older PandaCode version can still forward a pending worker
  approval.
- **Unresolvable requests** (no automatic answer, an answer that cannot be given, a request with
  no ID or that could not be saved, a decision the harness could not take while the request
  waits) end the worker's turn: it fails with the reason (failed, not stopped, everywhere), with
  no failover and nothing held against the model. The stop's error and transcript note appear
  only once the run's end confirms the stop ended the run. If the harness ended first (it
  finished the turn, or crashed, whose own error then stands), the reason is dropped; if the
  user or the team stopped the worker too, it stays stopped.
- **Pooled account switch:** when a pooled run moves to another account, every request the old
  account's process left open is cancelled, a user's own pending approvals and questions too
  (the new account's process never asked them and cannot answer them): the cards drop, the task
  reads as running, approval cards forwarded to a bot conversation are withdrawn, and no late
  answer is sent on to the new account.
- **Run identity:** a request only acts on the run that raised it. If that run is gone, the
  request is cleared and never shown (a newer run's status is untouched); a decision after the
  harness cancelled or expired the request is a no-op; a request after the team paused or
  stopped the worker is dropped quietly, and Resume picks the worker up.

Worker sessions stay out of manual use, so their full access never carries into a user's own
chat:

- `readOnly` is advisory, not enforced: it shapes the worker's rules and lets read-only work
  run alongside writers, but a read-only worker still has full access.
- A worker session cannot be continued by hand, during or after its team: `architect::check_manual`
  refuses messages, settings changes and Codex commands that change the conversation.
- **Console:** opening a worker's harness console is refused (checked when it opens and again
  right before it starts).
- **Fork:** Codex `/fork` of a worker session is refused. A transcript fork of a worker (fork
  at a message) starts in its lead's mode, or Ask if the lead is gone, never in full access.
- **Remote devices** cannot prompt, steer, resume, approve for or answer a team's lead unless
  "Full access for remote tasks" is on (declining an approval or cancelling a question still works), since its workers would run with full access, and a task they start
  then gets no saved default team ([remote-access.md](remote-access.md)).
- A `reasoningEffort` that is not a level (over 32 characters, or anything but letters,
  digits, dashes and underscores) is refused for an explicit provider and ignored with a note
  otherwise.

An assignment or follow-up may set `reasoningEffort` (a worker's own sub-worker follow-ups
accept it too, and the `sub_workers` schema advertises it) (`low`…`max`; some models also
`off`, `minimal`); it overrides the profile's or the lead's default. It is normalised
(trimmed, lowercase) and fitted to the chosen model (`architect/model_efforts.rs`):
- A level is lowered only when the model's harness catalog is known to lack it (the
  nearest supported level, else the default). With no catalog, the harness's general
  rule decides and the level is kept: missing data never lowers an effort. Inherited
  defaults (the lead's own, or a roster profile's for that same model) are kept unless a
  fresh catalog shows the model lacks them (the scheduler refits before each launch).
- Catalogs are looked up at dispatch and follow-up only, for the harnesses that will
  run, and only when an effort is set: such a dispatch can wait up to about 8 seconds
  for the lookup (including a busy discovery); failures are remembered for a minute. Only a catalog confirmed within the last ten minutes lowers a level; an
  older one kept after a failed refresh decides nothing. The lookup is the same local CLI
  model discovery the model picker runs; PandaCode makes no network request of its own for
  it (a harness CLI may contact its own provider, as it does for the picker).
- A thinking switch (Kimi's `on`/`off`) gets `on` for any level other than `off`, and a
  positive level is never lowered to `off` or `none`; `off` and `none` (some Codex
  catalogs) fit each other.
- A provider and model the lead names explicitly get an error listing the valid levels.
  Failover refits the lead's original request to the new model (with none, the new model
  takes its own default, not the old harness's level), and the scheduler fits
  once more before each launch from cached data only.
- If a harness still refuses the effort at startup (Codex and Claude check it; ACP
  harnesses report that the model does not advertise an adjustable reasoning effort, or
  the selected `thought_level`/`effort`), the worker is relaunched once on
  the model's default with the same prompt that launch sent (a parked worker's results,
  say), without repeating it in the transcript (only the refused turn's prompt row that
  launch recorded and its error rows are dropped; change records and notes stay; after an
  app restart nothing is deleted and the prompt may repeat once); this spends no
  attempt or failover and does not count against the model's health (a worker its team
  stopped meanwhile is not relaunched, and then the refusal does count). Only a refusal
  before any reply or tool counts; a second one, or a later error, is a normal failure.
- Every change is reported in the dispatch or follow-up result and in the worker's
  `note` (JSON field `note` in the team snapshot and `list_workers`), never in its error.
  A change before launch is added to an earlier note; a follow-up without
  `reasoningEffort` clears an effort note.

## Council

With Council on, the lead convenes independent read-only reviewers who each score the work out of
10. It fixes what they find and convenes a fresh round until every reviewer reaches the target, the
lowest score rather than the average. `finish_team` enforces this; the rules only explain it. Set it
with `architect_set_council`, which takes effect at once, even during a run. A new setup that names
no Council keeps the team's, and removing the team removes it. Council is per task: the saved default and saved team profiles never carry it.

- **Reviewers.** The lead chooses the lenses and dispatches at least 2 reviewers, or exactly the
  configured count, with `councilLens` (1-80 characters). That forces `readOnly`, and the reviewer's rules
  say to inspect the work its assignment names (code, output, frames, renders) and report rather than fix,
  without changing the work under review: any renders or builds go outside the checkout. Sub-workers cannot
  convene, and a lens with Council off is refused. `followup_worker` is refused: the next round uses fresh
  reviewers, who never see earlier scores or the target. A seat with a score stands: `cancel_worker` and
  `replaces` refuse it, and also a seat whose score nudge is pending or that started and is running or parked
  (the watchdog fails a hung one). A stopped, failed or never-started seat can be cancelled or replaced; a replacement keeps the replaced seat's lens. In one dispatch, routed reviewers avoid repeating a
  provider and model (`routing::diversify`); with routing off the rules ask for a different roster model per
  reviewer.
- **Rounds.** A reviewer joins the latest round while it is open, current and has room, and a `replaces` joins
  the round of the seat it replaces; otherwise it opens the next round. `maxRounds` (1-100, 10 by default)
  counts every round that started this cycle (one of its seats ran), an overtaken one too: at the limit no new
  round opens, and once nothing is live the lead may finish. A round takes at most 8 seats, abandoned ones
  included; a round with no room left gives way to the next. Round 1 fixes the lenses from every seat it had, cancelled
  or overtaken ones included (names compare without case or surrounding spaces): a later round cannot add one,
  and every round-1 lens sits again in each later round. A round is complete when every seat that counts (not abandoned, or scored, since a score stands) has
  settled with a score, at least `max(2, reviewers)` have scored, and every round-1 lens has sat. A current
  round with a score below the target, full or complete, is not re-rolled until something changed after it
  started. A round starts at its
  seats' first runs (`council.startedAt`), so a reviewer waiting on a dependency or a free slot is not out of
  date. When a new round opens over an incomplete one, that round's unscored reviewers, parked ones included,
  are settled as stopped and abandoned with a note; their runs are stopped once the dispatch is saved, so a
  refused batch stops nothing, and an abandoned worker never runs again. Turning Council off stops the cycle's
  reviewers that are still out.
- **Cycles.** `councilSince` (`storage::now` milliseconds) starts a cycle. Turning Council on while the team is idle (ready or
  completed) starts one too, so it reviews what comes next rather than the thread's earlier work. Turned on during
  a request, or while it is paused, failed or interrupted, it keeps that request's start, so its writes are still
  reviewed. A setting that changes or lifts the refusal shown as the team's `error` updates or clears it. A user message starts a new one
  only when the old cycle has nothing outstanding (Council passed, the limit was reached, or nothing changed),
  so "keep going" after a stop continues its rounds. Earlier cycles' reviewers stay on the snapshot for
  history but do not count.
- **Scores.** A reviewer ends its report with `Council score: N/10`. PandaCode reads the tail of its last
  message and takes the last line that starts with those words, past markdown; a number outside 0-10 is no
  score. A run that ends without one is asked once on the same session to repeat its final report in full,
  ending with that line (`scoreNudged`, which no reply resets), so the summary and `read_worker` carry the whole
  report. A second miss fails the reviewer so the lead wakes. A failover to another harness clears the nudge,
  the summary and the score.
- **Changes.** A cycle has changes when a writer ran (`Worker.wroteAt`, set when a writing run starts and ends,
  and when a live writer is cancelled, paused or stopped), or when any team conversation recorded changed files in
  `turn_changes`. That covers the lead and workers, in git and non-git projects alike. Reviewers' records, and
  those of their sub-workers, count only for real writes (`lastWriteAt`: a write tool or `track_files`), so a
  reviewer that edits the work outdates its round, while one rendering frames with shell commands does not. The snapshot keeps the newest such record in `changedAt`, refreshed on every save with one indexed
  query over this cycle's records of the team's conversations. A lead record counts by its own files:
  `persist` saves `ownFiles` before rolling its workers' changes in, so a lead edit to a file a worker also
  changed still counts. `updatedAt` is not used: checkpoints move it, and
  so does cancelling or replacing a worker that already settled, none of which edits anything.
- **The gate.** Once this cycle has changes or a round, `finish_team` refuses until the latest round is complete,
  no change landed after it started, and its lowest score reaches the target, or the round limit is reached with
  nothing live. Each refusal says what to do next; an incomplete round
  whose open seats stopped or failed names them to cancel. A lead that ends its turn while Council refuses, after a user
  message too, is brought back once: the Continue turn quotes the refusal and keeps it as the team's `error`.
  Below the target the refusal says to fix the blockers through workers and convene a new round; only if a
  blocker should not be fixed, to end the turn and tell the user, who can lower the target or turn Council off,
  and, if the user says to accept the current scores, to tell them to press Accept and finish on the Council
  card (which calls `architect_council_accept`). If the lead stops again below the target, it is asking the user: the
  team rests `ready` with the refusal as its `error`. For other refusals the team pauses and `error` carries
  the refusal. A finish whose own turn then records changes (the lead's edits are saved as its turn ends) is
  reopened for review, and that review turn says so; a second reopen in the same cycle rests the team instead
  (asking, or paused with the refusal), so editing and finishing every turn cannot loop.
- **What the gate cannot see.** The lead's shell or script edits that no write tool made and it did not report
  with `track_files`, and edits from outside PandaCode. A reviewer that stopped or failed before scoring can be
  cancelled and its lens seated again within the round's 8 seats. The other way round, a writer run that changed nothing still counts
  as a change. A change is dated by its turn's last real write, a write tool with paths or a `track_files`
  capture (`lastWriteAt` in its `turn_changes` summary), so a lead that edits and then convenes in the same
  turn is not out of date; a reported edit with no write tool event is dated by the turn's end.
- **Status.** Every saved and emitted snapshot, and `architect_get`, carries `councilStatus` while Council is
  on: `{state, round, lowest, target, stale, notice?}`. `state` is `accepted` (the user accepted this cycle's
  scores), `waiting` (no round yet), `reviewing`
  (a seat of the latest round is live), `dispatch` (the latest round is incomplete and no seat is live: the lead
  must act), `asking` (the team rests with its below-target refusal as its error: the lead asked the user),
  `fixing` (below target or out of date), `passed`, or `limit` (the limit is reached without passing). `notice`
  is a short plain sentence for the user whenever a Council refusal holds the team as its `error` (asking, or
  paused with the refusal), and absent otherwise. It comes from the same
  checks as the gate, so the webview shows it as it is and never reads refusal text. When a setting ends the
  `asking` state (the target lowered, Council off, or a changed reviewer count), the lead is woken once: with the
  refusal that now stands, if any, else to verify and finish with the first-and-final table, the prompt carrying
  each lens's first and final score. Accept and finish (`architect_council_accept`) marks this cycle accepted
  (`councilAccepted` holds its `councilSince`): the gate lets the lead finish, Council stays on, the cycle's live reviewers stop, an idle lead is woken once
  to finish with the table when the accept lifted a refusal, and the next cycle reviews as usual; a setting that gives a resting team (ready or completed) a refusal again, such as a raised round limit
  after a round below the target, wakes the lead once with that refusal; a refusal lifted from a paused team's error leaves the pause
  note. The lead's review carries `council`: `round`, `target`, `lowest`, `complete`, `passed`, `roundsLeft`,
  `scores` (the latest round), `firstScores` (each lens's first score this cycle) and `next`.

## Saved setups and profiles

**Save setup** remembers the complete team for this task and future tasks, across
projects and app restarts. That includes the architect and worker harnesses,
models, reasoning efforts, and workers at once. New conversation, board, and worktree
tasks inherit a fresh copy; they do not start until you send a message or choose
Start. Existing tasks keep their own configurations and histories.

Use **Save as…** to keep a named team profile, then **Choose team profile** to load
one into the setup form. **Save setup** (or **Apply setup** for a used team) applies the selection and makes it the new
default. Editing a template with **Update profile** or saving a new one does not
silently change the current task or default. The profile menu also offers Rename
and Delete. Deleting a profile retains the applied setup and task histories.

**Use a single agent** disables team inheritance for new tasks while retaining
your saved setup and profiles. Teams that already have worker history retain their
team controls so those transcripts remain accessible. Profile changes do not change
the lead's own permission mode; workers always run with full access (see above).

### Switching during work

Open **Team**, or the composer's model label while a team is enabled, choose a
saved profile, and select **Apply setup**. Models and workers at once remain editable while
the team runs. If the architect is responding, PandaCode queues the setup until
that turn finishes; the composer shows **queued** and reopening the picker shows
the pending selection. Choosing another setup replaces it, and choosing the
effective setup cancels the queued change. If only workers are running, the new
setup can apply immediately for the architect's next turn.

Existing assignments, including queued workers and follow-ups, keep their original
models and conversations. Newly dispatched assignments use the new worker profiles.
Switching never starts an extra turn or cancels work. Pending selections
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
  boundaries, not an operating-system filesystem sandbox. Workers run with full
  access (see above). Other apps and terminals can still edit files.
- Dependencies refer to already-created assignments. The scheduler launches work
  only when its dependencies have completed. Assignment keys prevent a retried
  tool call from creating the same worker twice within one objective; a new
  request may reuse a key and gets a new worker. Repeating a key whose worker
  already finished returns that worker with `duplicates`, so the architect knows
  nothing new will run.
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
  without waiting for the slowest one.
- A team turn with no harness output for 20 minutes is stopped. Claude's longest
  tool timeout is 10 minutes, and a turn waiting on your approval or answer never
  counts as silent, nor does time the computer spent asleep. A silent worker settles
  as failed and the architect handles it.
  A silent architect turn shows a notice; its workers keep running, and if
  nothing was dispatched the architect gets one **Continuing the plan** turn.
- A worker whose run ends with no reply is asked once to finish and report; if it
  happens again it settles as failed and the architect handles it. The harness's
  empty result for a leftover background task does not end a run.
- Every 30 seconds the app also settles a worker whose run is gone without reporting
  back, releases a lead turn that never started, and runs the scheduler. One team's
  error never stops scheduling for the others.
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
`cancel`), both limited to its own children. A sub-worker's write scope
must lie inside its parent's, `dependsOn` names only its siblings, and a
read-only parent starts only read-only children. A parent and its children never
block each other's scopes.

When a worker's run ends cleanly while its children still work, it is **parked**:
its process exits, freeing its memory, and the team panel shows
**Waiting on sub-workers**. When they settle, it resumes with one compact turn of
the results it has not seen, using no attempt. A child that settled before the run
ended counts too: the parent resumes at once with it, unless it already read that
result with `sub_workers` `read`. That is at most one extra turn per batch, because
results a resume turn carried count as reported (a follow-up clears that). A
sub-worker's failure goes to its parent, never to the architect. Cancelling a parent, or its failure,
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
  recipient; otherwise it stays in the mailbox. A steer carries the first 4 KiB, and
  a message cut this way stays unread so the worker can read the rest. `delivered`
  says `sent` (handed to the run, which may still refuse it, leaving it unread) or
  `mailbox`. The architect is never steered.
- `pandacode_read_team_mailbox` reads only messages addressed to the calling agent,
  with a cursor for incremental reads. Every team tool result carries a digest of
  unread messages, so agents never poll. Agent identities are bound by the host;
  agents cannot supply another team or sender identity.
- `pandacode_team_notes` (`set`, `get`, `list`) is a shared blackboard for durable
  facts such as API shapes and decisions; an empty value deletes a note. Briefs include the newest notes up to a budget and
  count the rest ("N more notes: use pandacode_team_notes list"); later turns get only notes changed since.
- `pandacode_checkpoint_worker` saves a worker's progress summary, concrete next
  steps, and optional blocker. Checkpoints survive app restarts and are included in resumed worker prompts and
  compact architect reviews. They report progress; they do not mark work complete.

Each team conversation gets the full team rules and coordination guide once. While
the harness resumes the same conversation, later turns get a one-line reminder (which
names the user's team guidance when one is set) and only the messages they have not
seen. The full rules go out again when they change, when the harness starts a new conversation, and on every
eighth turn so a compacted conversation never loses them for long. The architect's
review, update, failure and continue turns quote the objective in full only on those
turns or when it is under 2,000 bytes; otherwise they carry its first 1,400 and last 600 bytes, marked "objective unchanged". An objective over 8 KiB is also saved whole as the reserved `objective` note, and turns say so. Update and failure turns list only changed or unsettled workers.

Tool descriptions are terse and leave out what the rules already say; harness names
and unknown fields are checked by the handlers rather than repeated in every turn's
schemas.
`team_turn_overhead_stays_within_budget` keeps the architect's team tools under
4,200 bytes and a worker's under 3,000.

Only an urgent message or a new blocker wakes an idle architect while workers
continue; other messages wait for its next review or turn. These wakes run at most
once a minute per team (`lastWakeAt`): one inside that minute is deferred, never dropped,
and the watchdog's next 30 s tick delivers it.
Workers see new messages in the digest on their next team tool call; apart from
an urgent steer, PandaCode does not interrupt a running model response, and it
never restarts a completed worker to deliver a message. The architect uses a follow-up assignment
when a completed worker needs to do more work.

Messages, notes and checkpoints are stored in SQLite with no count cap (a broadcast
stores one message per recipient); one message may be up to 16 MiB. `read_team_mailbox`,
`pandacode_team_notes`, `pandacode_team_directory`, `list_workers` and `read_worker` return
pages of 24 KiB, measured in serialized bytes, with a cursor or offset, so nothing is lost to a
harness's output limit. `route_models` past that size drops every task's alternatives and ladder
(`trimmed`), then leaves out the last tasks (`omittedTasks`; route them in another call), and a
dispatch leaves out its `routing` notes (`routingOmitted`), since `list_workers` shows each model. A mailbox `offset` must come with the `offsetId` returned beside `nextOffset`.
Note lists page by key, so an update never moves a note past the cursor. Briefs, `list_workers` and
`read_worker` at offset 0 show about 2 KiB of a checkpoint (`checkpointTruncated`), and lists and
`read_worker` bound `files` (`filesTruncated`); `read_worker` or `sub_workers` read with
`checkpoint: true` pages the whole checkpoint. Send and checkpoint results carry an unread digest, not the messages. Only the latest
checkpoint is included in team snapshots. Message history loads on demand and
refreshes from team events, with no polling timer. These reports never override
the user's instructions, file scopes, or harness approval policy.

## Limits and recovery

Setup offers one limit, workers at once. PandaCode enforces no rounds, assignments,
batch size, file scopes, sub-worker counts or follow-up attempts; the kept brakes
are the replacement chain (3 tries for an assignment), sub-workers one level deep,
the silence watchdog, one urgent wake a minute per team, the no-progress pause, a roster of
24 models in a team's setup (automatic routing picks from the wider catalog), and workers
at once. None of them bound a provider's bill. The no-progress pause is not a capacity limit and never
stops live work: after 8 lead turns in a row that PandaCode started with no worker completing and no new
assignment (follow-ups and replacements are retries), wakes wait while any worker runs and stay due (the
panel and the phone show a short note saying why the lead is quiet), so
the next completion resets the count and delivers them, and the silence watchdog still catches a hung
worker. Only with nothing running does the next wake pause the team and say why. Resume continues and
resets the count. A lead turn PandaCode started that the harness fails (an overload, a rate limit) never
stops workers: the team stays waiting with a note, what the turn was woken for is due again, and the
watchdog's tick retries it at least a minute later, as the same round. While the lead's usage limit has a
known reset that has not passed, the retry holds: the snapshot's `leadFailure.heldUntil` carries the reset, the panel says
"Usage limit, resumes at <time>", and with no worker at work the sidebar row and composer read as limited
instead of working (Stop still works and prompts still queue). Continue now or dismissing the banner lifts the
hold, as does switching the lead to another harness; the retry starts on the watchdog's next tick. A retry that
starts clears the limit from the task, and a new limit event sets it again. These retries count toward the 8
turns, so with nothing running a lead that keeps failing pauses the team with its last error for Resume. A failed
turn the user started is retried the same way when it leaves work out (a worker unsettled or a result not yet
reviewed), reporting only what came after that turn began; with nothing dispatched it ends the team as before.
Pause and Stop cancel active team
processes and prevent queued work from starting; Resume explicitly retries
unfinished work. Pausing, stopping and restarting do not use up worker attempts;
only failures do. Resume waits briefly for stopping agents to exit.
Team errors and pauses you did not ask for appear as a notice, and a worker that
needs an approval or answer is announced even with the panel closed. An app restart recovers the team as interrupted instead of
silently starting more inference. Team profiles and workers at once can be changed during
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
notes, the version 9 catalog) restarts its native context the same way; other
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

Configuration includes one or more worker profiles, `maxParallel` (0 for Unlimited,
or a positive integer for a finite limit), and optional `leadGuidance` (absent or blank means the
app-wide guidance, else the built-in rules alone). `workspace` is currently `shared`. `maxRounds`, `maxAssignments` and `summaryLimit` still parse in saved setups and are ignored. These do not authorize
broader permissions. Each assignment retains its original model selection even
when the team's profiles change. `TeamSnapshot.pendingSetup` contains the queued
`{architect, config}` until the parent process finishes; it is persisted with the
team and cleared atomically when applied. `config` and the parent `Session` always
describe the effective setup. No schema migration is needed for this optional field.
An architect can explicitly resolve cancelled work with a reason; unresolved
failures prevent successful completion.
