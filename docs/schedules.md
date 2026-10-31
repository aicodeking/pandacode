# Task schedules

Agents and the user can schedule wake-ups and timed messages for any task (thread): "check the deploy in 20 minutes", "poll CI every hour", "every weekday at 09:00", "on a cron", or "when task B finishes, continue here". A schedule sends an ordinary message to its task when it fires, so it works with every harness.

## Module map

- Native: `src-tauri/src/schedules.rs` (types, validation, IPC commands), `src-tauri/src/schedules/firing.rs` (the clock loop, delivery, `run_finished`), `src-tauri/src/schedules/cron.rs` (the cron parser and next-fire scan), `src-tauri/src/schedules/tools.rs` (agent tools), `src-tauri/src/schedules/tests.rs`. Clock arithmetic is shared with bots: `next_run_on`/`next_run_zoned` in `src-tauri/src/bots/schedule.rs`.
- Window: the IPC contract is `src/schedules-api.ts` (keep it in step with `schedules.rs`); the thread panel is `src/schedules-thread.ts`, Settings → Schedules is `src/schedules-settings.ts`, and preview mocks are in `src/preview-schedules.ts`.

## Tables (schema 37)

- `task_schedules`: one row per schedule. `session_id` is the receiving task and `watch_session_id` the watched task for `after`; both cascade on task deletion. `created_by` is `user` or `agent`, and `created_by_session` (set to null when that task is deleted) is the agent's thread. Also `kind`, `interval_minutes`, `time_of_day` (HH:MM), `days` (JSON, 0 = Sunday), `cron` (the five-field expression, for the `cron` kind), `timezone` (an IANA name; null = this computer's zone), `only_on_success`, `next_run_at`, `last_run_at`, `enabled`, `run_count`, `max_runs`, `consecutive_failures`, `trigger_ok` (the pending `after` trigger's result), `workflow_id` (indexed; groups a workflow's steps) and `chain_from_id` (a workflow step's predecessor).
- `task_schedule_runs`: the run history. `schedule_id` has no foreign key, so history outlives a deleted schedule. Each run records an outcome (`started`, `queued`, `skipped` or `failed`), a detail, its sequence number and whether it was `manual` (Run now). Only the newest 200 runs per task are kept.
- `scheduler_settings`: one JSON row (`SchedulerSettings`).

## Commands

`schedules_list {sessionId?}`, `schedule_create {input}`, `schedule_update {scheduleId, input}`, `schedule_set_enabled {scheduleId, enabled}`, `schedule_delete {scheduleId}`, `schedule_run_now {scheduleId}` (returns a `ScheduleRun`), `schedule_snooze {scheduleId, minutes}`, `schedule_runs {sessionId?, scheduleId?, limit}`, `scheduler_settings`, `scheduler_set_settings {settings}`. Every mutation emits `schedules-changed {sessionId | null}`.

Validation rules:
- Title: at most 120 characters. When it is empty, it defaults from the prompt.
- Prompt: 1 to 8000 characters.
- Interval: 5 to 10080 minutes.
- Times: HH:MM.
- Weekly days: a non-empty set from 0 to 6.
- Cron: a parseable five-field expression that fires within 5 years.
- Timezone: an IANA name ("Unknown timezone: X"); empty or unset = this computer's zone.
- Once: within 366 days and not more than 1 minute in the past.
- Max runs: 1 to 1000, or none. An edit cannot set Max runs at or below the runs already made.
- The target task must exist and must not be a draft.
- The watched task must be in the same project and must not be the target.
- An `after` schedule is refused, with "This would loop: …", when enabled `after` schedules lead from its target back to its watched task. The check runs on create, update and re-enable.

## Cron

The `cron` kind takes a five-field expression: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, where 7 is also accepted and normalized to Sunday). Fields support `*` (any), `,` (lists), `-` (ranges) and `/` (steps); names (`MON`) and macros (`@hourly`) are out of scope. When both day-of-month and day-of-week are restricted (neither is `*`), a day matching either one fires (Vixie's rule); when either is `*`, both must match. A day like February 30th that never comes is refused at save time with "does not fire within 5 years".

Clock kinds (`daily`, `weekdays`, `weekly`, `cron`) accept a `timezone`: an IANA name; empty or unset keeps today's behaviour, this computer's zone. Wall-clock times are computed in the schedule's zone and converted back to epoch time, so 09:00 stays 09:00 across daylight-saving changes, and at fall-back an hour that happens twice takes the earlier offset and fires once (all clock kinds). Cron handles the spring-forward gap too: a local time that does not exist that day (02:30 in New York) fires at the next existing minute (03:00). `daily` and `weekly` use the bot scheduler's once-per-run offset adjustment instead, which lands on one side of the spring-forward shift and may sit an hour off for that day's run. Bots' schedules keep their own local-zone arithmetic.

## Firing

- The clock loop ticks once at startup and then every 15 s. Overdue runs after a restart fire once; there is no backlog. Before a run fires, the loop advances `next_run_at` and `run_count` under the store lock. A one-off schedule, or one that reaches `max_runs`, turns off after the run.
- **Paused** holds everything: due runs stay due, and resuming triggers a tick right away.
- `after` schedules: `schedules::run_finished` (called from `lib.rs` beside `bots::run_finished`, and from `remote/mirror.rs` when a mirror's turn ends unstopped) does not fire anything itself. It marks the watching schedules due (`next_run_at = now`, respecting enabled, onlyOnSuccess and maxRuns), and the loop fires them. So a pause holds triggers, and several quick finishes coalesce into one pending run. An `after` schedule runs at most once per 30 s.
- Delivery uses `send_prompt` in `lib.rs`, the same routing as the composer: team tasks start their architect, mirrors go to their host, and anything else starts a turn here. When the thread's agent is running, or its team is active (architect `running`/`waiting` or any worker running), the message is queued instead (`message_queue::add` + `queue-changed`).
- An open harness console with no agent run cannot take a message (the window's queue cannot send to it either), so that thread's due schedules are left due: not advanced, not counted as failures, no run recorded. They fire on the first tick after the console closes. Run now refuses with a message instead.
- The loop reads due threads, checks consoles without holding the store lock, then advances; `advance` only succeeds if `run_count` is unchanged, so overlapping ticks never run a schedule twice.
- Archived threads are recorded as `skipped` ("Thread is archived"). A delivery error is recorded as `failed`; after 3 failures in a row the schedule turns off, and the run detail says so.

## Workflows

A workflow is a chain of `after` steps sharing a `workflowId` (at most 64 characters). A step's `chainFromId` names the step before it. The predecessor must be in the same project, and its target thread must be the thread this step watches; only `after` schedules can be chained. A chained step arms only when its predecessor's `last_run_at` is newer than its own. So it runs once per pass, after the previous step has woken its thread, and never on an unrelated turn end of that thread. Steps without `chainFromId` keep plain `after` behaviour. The loop check still applies: a pass that returns to an earlier thread must start from a clock or one-off step, not from a plain `after` step.

User-facing errors say "thread", not "task".

## Trace format

The UI parses this text; keep it exact.

```
{prompt}

Scheduled wake-up (PandaCode scheduler): {title}
Schedule ID: {id} · {cadence} · run {n}[ of {max}] · set by {the user|this thread's agent|an agent in “{task title}” ({task id})}[ · started with Run now]
Trigger: {clock time reached|Run now|“{title}” ({id}) finished successfully|“{title}” ({id}) finished with an error} · local time {YYYY-MM-DD HH:MM}
From: “{title}” ({id}). Reply there with pandacode_schedule_message if useful.
You set this earlier in this thread. Pick up where you left off; cancel it with pandacode_cancel_schedule if it is no longer needed.
```

- The `From:` line appears only when an agent in another thread created the schedule.
- The last line appears only for an agent's self wake-up.
- The cadence wording is lower case: `every 30 min`, `weekdays at 09:00`, `Mon, Fri at 18:30`, the cron expression, `once`, `after “X” finishes`. A schedule with a timezone appends ` · Asia/Tokyo` to its cadence, whatever the kind.
- A Run now always reports `Run now` as its trigger.
- `TRACE_HEADER` is exported from both `schedules.rs` and `schedules-api.ts`.

## Agent tools

`with_schedules` in `schedules/tools.rs` joins the host chain in `lib.rs` beside `bots::tools::with_bot`. It is added only while `agentsMaySchedule` is on, and never in bot conversations, which use `bot_schedule`.

- `pandacode_schedule_wakeup {note, title?, kind?, inMinutes | at, intervalMinutes, timeOfDay, cron, timezone, days, afterTaskId, onlyOnSuccess, maxRuns}`: wakes this thread later.
  - When `kind` is left out it is inferred: `afterTaskId` → `after`, `days` → `weekly`, `intervalMinutes` → `interval`, `timeOfDay` → `daily`, `cron` → `cron`, else `once`. Missing fields are named in the error ("kind interval needs intervalMinutes (5 to 10080).").
  - `afterTaskId` fires when that thread's run ends; a run in progress counts. A wake-up cannot watch its own thread ("…would wake on its own turn end").
  - `at` takes RFC 3339, a local `YYYY-MM-DDTHH:MM`, or a local `HH:MM` (its next occurrence).
- `pandacode_schedule_message {taskId, text, …timing}`: messages another task in the same project.
- `pandacode_list_schedules {taskId?, project?}`: lists schedules with their last 5 runs. The result also has `thisTaskId` and the project's open `tasks` (id, title, running; at most 50), so agents can find IDs.
- `pandacode_cancel_schedule {scheduleId}`: allowed only for agent-created schedules in this project that target this thread or that this thread created. A user-created schedule is refused with "Ask the user to remove it in Settings → Schedules."

Every result carries `nowLocal`; created schedules also carry their `id`, `cadence` and `nextRunLocal`. Agents cannot edit or pause schedules: they cancel and recreate them.

Limits and approvals:
- Each creating thread may have up to `agentLimitPerTask` active agent schedules (default 10).
- Agent schedules without `maxRuns`: `after` runs once, other recurring kinds stop after 20 runs. Create results include `stopsAfter` ("runs once; pass maxRuns for repeats", "stops after 20 runs; pass maxRuns up to 1000 to keep going").
- Wake-up, list and cancel need no approval. They are `schedules::tools::self_scoped`, which the Claude allow-list in `providers.rs` checks.
- `pandacode_schedule_message` is an approval tool while `askBeforeMessagingOtherTasks` is on. It is in `cloud::deploy::ALWAYS_ASK`, so it asks even in Full mode, but only while the setting makes it an approval tool.
- `TURN_ENDS` in `lib.rs` tells agents that `pandacode_schedule_wakeup`, when listed, survives the turn.

## Settings

`agentsMaySchedule` (default on), `askBeforeMessagingOtherTasks` (on), `paused` (off), `agentLimitPerTask` (10, 0 to 100).
