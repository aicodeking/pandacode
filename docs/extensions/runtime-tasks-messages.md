# Messages, notes and the revisioned queue (`tasks.message`)

Runtime phase R4, slice R0402. A trusted background service talks to a task the way the user does: it sends a message,
adds a note, and edits the queue of follow-ups. One permission, `tasks.message` (project scoped, granted with the trust
decision, rechecked natively on every request, revocable and narrowable), covers every call here; a note for the model
also needs `harness.hooks.context`. A package that holds them is never asked again per action (ADR-0005).

```js
const sent = await panda.tasks.message(taskId, { text: 'also run the linter' });
// -> { id, delivery: 'sent' | 'queued' | 'steered' }
await panda.tasks.note(taskId, { text: 'CI is red on main.' });                    // a line in the transcript, nothing else
await panda.tasks.note(taskId, { text: 'The linter is flaky.', forModel: true }); // also rides the next message as context
const { revision, entries } = await panda.tasks.queue.list(taskId);
await panda.tasks.queue.update(taskId, entries[0].id, { text: 'edited', revision });
await panda.tasks.queue.reorder(taskId, entries.map(entry => entry.id).reverse());
await panda.tasks.queue.sendNow(taskId, entries[0].id);
await panda.tasks.queue.remove(taskId, entries[0].id);
await panda.tasks.queue.resume(taskId);
```

## Message

| Task is | `delivery` unset | `'queue'` | `'steer'` |
|---|---|---|---|
| idle | a new turn (`sent`) | queued, and the queue's own drain sends it (`queued`) | a new turn: there is nothing to steer (`sent`) |
| running | queued behind the turn (`queued`) | queued (`queued`) | into the running turn where the harness takes it (`steered`) |

- `text` (at most 200,000 bytes) or up to 16 `attachments` (attachment ids, as the composer sends them) are required.
- The decision (busy or idle, then exactly one of send, queue, steer) is made under one lock per task, so two calls never
  both see the task idle. A queued entry leaves the queue only through the queue's own `take`, which deletes it in the
  statement that returns it: the run-end drain, the headless drain and `sendNow` cannot both send it.
- A text that starts with a slash command is resolved exactly as typed text is: an idle send goes through `send_prompt`
  (the composer's path, `launch_task_in_project` resolves the command), a queued one is stored as typed and the queue's own
  delivery resolves it, and a switched-off skill is refused as it is for the user.
- **Steering is explicit.** A harness or team that cannot steer answers `UnsupportedCapability` (`path: "delivery"`),
  and so does a steer with attachments (`path: "attachments"`). The message is never quietly queued in its place, so the
  package always knows whether it landed. Steering never stops a run. A run that ended between the check and the steer
  turns the steer into a plain send, once.
- The thread shows `Sent by <package>` or `Steered by <package>` under the message; a queued entry carries the package's name
  as a chip on its queue row.

## Note

`note` adds one labelled line (`Note from <package>: ...`) to the transcript and starts no turn. With `forModel: true` the
line reads `Note for the model from <package>: ...` and the text is kept (file-backed, `task-notes.json`, at most 20 per
task) until the task's next message, which carries it as one labelled block in front of the text:

```
Notes added by extensions for this message (not written by the user):
- [Task messenger] The linter is flaky.
```

`take_context` (native, `runtime_tasks_messages.rs`) is the one reader of that store: it removes the notes in one step, so
exactly one message carries them, and `restore_context` puts them back at the front when that message never saved. This
module's own send path uses it for the messages it sends; R0504 uses the same function during `prompt.submit` for every
other send (the composer's, a queue drain). Nothing else stores or sends next-send notes. A typed slash command is the
harness's own syntax and takes no block: the notes wait for the next message that is not one.

## Queue

`list` answers `{ revision, entries }`. An entry is `{ id, position, text, truncated, attachments (count), createdAt,
updatedAt, package?, changedBy? }`; a text over 20,000 characters is cut in the answer (the entry itself is whole).

**The revision** is a content hash (FNV-1a, 53 bits) of the queue's ids, order, texts, attachment counts and edit times, so
every change by anyone (the user, an agent, a phone, a package) moves it and no counter has to be kept in step.

| Call | Consistency |
|---|---|
| `update(task, entry, {text, revision?})` | Read, compare and write happen in one store critical section. A `revision` that no longer matches is `StaleContext` and changes nothing. Without `revision` the edit is last-writer-wins. Attachments are kept. |
| `remove(task, entry)` | An entry that is gone, was sent, or belongs to another task is `NotFound`. |
| `reorder(task, ids)` | `ids` must name exactly the queue's entries (a repeat is `InvalidShape`; a missing or extra id is `StaleContext`), applied in one transaction. |
| `sendNow(task, entry)` | Idle: the entry is taken out and sent as a turn (a failed send puts it back at the front). Running: steered into the turn where the harness takes it. Stopping a run to send is `tasks.control`, so a harness that cannot steer, or an entry with attachments, is `UnsupportedCapability` and the entry stays queued. |
| `resume(task)` | Releases a hold exactly as the user's Resume does. The hold (after a restart, a failure, a stop or a limit) is the main window's state, so the call reaches it through `extensions-runtime-queue-resume`; a headless host drains natively. |

Queued entries a package adds are kept with its name (`task-message-origins.json`, 5,000 at most, the oldest goes first;
independent of SQLite, so the label survives the package). An edit by another package never takes the entry over: the
creator stays and `changedBy` names the editor. The user's own entries and ones they edit are untouched.

## Refusals (frozen)

The grant answers first, so nothing about a task is revealed without it:

1. Shape of `taskId`: `InvalidShape`.
2. The grant: no grant, a revoked one, a disabled package, or a project outside the narrowed scope is `PermissionDenied` with
   `path: "tasks.message"` (`"harness.hooks.context"` for a `forModel` note). An unknown task answers `NotFound` only to a
   package that holds the permission for some project; otherwise `PermissionDenied`.
3. The rest of the shape: `InvalidShape`, or `LimitExceeded` for a size bound.
4. What must exist: `NotFound` (task, entry), `StaleContext` (revision, order).
5. The grant again, once the task's turn is ours: a revoke or narrowing in between sends nothing.
6. The harness: `UnsupportedCapability` (steer), `HostUnavailable` (it did not take the message now; nothing of the host's
   text reaches the package).

## Bounds (predictability and fault isolation, never trust)

200,000 bytes of text, 16,000 of note, 16 attachments, 20 pending notes per task, 50 queued entries per task (the queue's
own limit), 5,000 labels. A queued message with a switched-off skill is refused like the user's.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_tasks_messages.rs`): admission, the frozen refusals, the plan, the revision,
  the ledger and the notes, and the three requests `tasksMessage`, `tasksNote`, `tasksQueue` served in
  `runtime_service_lifetime.rs`. It reuses `send_prompt`, `message_queue::{queue_add, list, update, reorder, take, restore,
  remove_delivered, steer_task}` and `crate::headless::queue_changed`, so the user's path and the package's are the same code.
- **Main window** (`src/extensions/runtime-tasks-messages.ts`, mounted from `src/main.ts`): releases a hold when asked and
  draws the package chip on queued rows (`extensions_runtime_message_origins` and `extensions-runtime-message-origins`).
- **Preview twin**: the same file holds `admitMessage`, `admitNote`, `admitQueue`, `plan`, `revision`, `TaskMessages` and
  `TaskMessenger`; the browser spec and `runtime-preview.ts` (`panda.tasks.message`, `note`, `queue`) run it.

## Refusal-test reconciliation (Q001, Q002, Q003, Q007, Q010, Q019, Q068, Q069, Q073, Q076, Q090, Q092, Q094, Q096, Q100, Q103, Q115, Q127)

These rows pin that the declarative surfaces (thread action kinds `send_message` and friends, composer controls, panels,
commands, bot controls, BTW, GitHub and board actions) cannot send, queue or edit. This slice delivers the permissioned
way to do it: a service calls `panda.tasks.message`, `note` and `queue.*` under `tasks.message`. The specific permissioned
assertions delivered here are in `tests/extensions-runtime-tasks-messages.spec.ts` (a granted package sends, queues,
steers, notes, edits, reorders and resumes; one without the grant, with the grant narrowed away, or revoked in between gets
`PermissionDenied` and delivers nothing).

Retained refusals and their non-security reasons:

- The existing contract and coverage assertions (`contracts.rs` rows, `extensions-*.test.mjs`, `*-coverage.spec.ts`) keep
  refusing the action kinds and protected controls of the declarative layer. The reason is predictability of the manifest
  surface (a contribution is a presentation; a task mutation is a service call, so there is one path to audit), not trust.
  Those files belong to other tasks and to upstream, and an extension test is not weakened to match; their permissioned
  counterpart is the service call tested here. Row-by-row wiring of the surfaces that call the service (composer queue
  controls, slash send) stays with the owners that edit those hosts (R0404, R0404B, R0407, R0403, R0408, R0505, R1001).
- Unauthorized, stale and foreign-owner denials stay: no grant, narrowed, an entry that belongs to another task
  (`NotFound`), a stale revision or order (`StaleContext`: predictability of a read-modify-write), and the unsupported steer
  (`UnsupportedCapability`: the harness lacks it).
- Pairing a machine and granting remote access have no call here (the user's decision, answer D3).

## Evidence columns

Preview/model: `tests/extensions-runtime-tasks-messages.spec.ts` (ports 16241 Chromium, 16242 WebKit). Native unit tests:
`runtime_tasks_messages::tests`. Installed service reaching the scripted ACP agent (`fake-agent.mjs` over B5, declared by
`sample.launch-agent`, R0801), exactly one delivery per send and a real queue edit in the app: the final test phase and R1212
qualification. Nothing here was run in this slice.
