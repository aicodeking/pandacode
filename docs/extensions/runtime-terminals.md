# Read and operate terminals (`terminals.read`, `terminals.write`)

Runtime phase R4, slice R0409. A trusted background service lists and reads the terminals of a project and subscribes to
their output, and, with a second and independent grant, opens a terminal, types into it and closes it. The permissions are
`terminals.read` (`list`, `read`, `onOutput`) and `terminals.write` (`open`, `write`, `close`); both are project scoped,
granted with the trust decision, rechecked natively on every request, revocable and narrowable. A package that holds them is
never asked again per action (ADR-0005). Holding one never implies the other: a package that reads cannot write, open or
close, and a package that writes cannot read what the terminal printed.

```js
const terminals = await panda.terminals.list({ projectId });             // [{ id, title, cwd, projectId, taskId, kind, running, exitCode }]
const page = await panda.terminals.read({ terminalId, cursor: 0 });      // { schemaVersion: 1, data, cursor, nextCursor, dropped, exited, exitCode }
const watch = panda.terminals.onOutput({ terminalId }, chunk => { /* same shape as a page */ });   // at most ten chunks a second
watch.dispose();

const { id } = await panda.terminals.open({ projectId, taskId, cols: 100, rows: 30 });   // { id, projectId, taskId }
await panda.terminals.write({ terminalId: id, data: 'echo ready\r' });                      // up to 64 KiB of input
await panda.terminals.close({ terminalId: id });
```

## Which terminals a package sees

A terminal belongs to a project, and the grant is the project's:

1. the project the package opened it for (`open`), else
2. the project of the task it was opened for (the Terminal tab and a phone attach shells to a task), else
3. the project whose folder contains its working directory (the longest folder wins).

A terminal that belongs to no project is invisible to every package. `list` shows the terminals of every project the grant
reaches (or of one `projectId`, which must be in the grant), newest first; `kind` is `shell`, `script` (the project's run
script) or `harness` (a harness console).

## Output: pages, cursors and subscriptions

PandaCode records the last 256 KiB of each terminal at monotonically increasing byte offsets, and keeps the log of a terminal
that ended (with its exit code) until eight newer ones ended.

- **`read`** answers one page of at most 64 KiB (counted JSON-escaped, never splitting a character) after the byte `cursor`
  (default 0). `cursor` is where `data` starts and `nextCursor` where the next page starts, so pages join without a gap or a
  repeat. `dropped` is the number of bytes that left the log before the package asked, so nothing is skipped silently; a
  cursor past the end resumes at the end. `exited` is true once the terminal ended and `data` reaches the end of its output.
- **`onOutput(options, handler)`** subscribes from the end by default, or from an explicit `cursor` to replay. The host keeps
  the cursor: it hands out at most one chunk per 100 ms (ten chunks a second), each coalescing everything printed since the
  last one (up to 64 KiB), and each chunk starts exactly where the previous ended. A chunk has the shape of a page; one with
  `exited: true` is the last. A package may hold 16 subscriptions (`LimitExceeded` past that). The service pumps the
  subscription (`poll`, rechecking the grant each time) and the returned handle's `dispose()` stops it.

Everything the package does is attributed to it: a terminal it opens is a normal terminal in the Terminal tab (the tab adopts it
through `terminal-opened`), and its input is typed into the user's own shell session.

## Where each part runs

- **Native** (`src-tauri/src/extensions/runtime_terminals.rs`): shape, the frozen refusals, attribution of a terminal to a
  project, the grant check for the terminal's project (again just before an effect, and while a read is in flight), pages, the
  subscription table and the cleanup. One request, `terminals`, of `node-host.cjs` with an `op`, served in
  `runtime_service_lifetime.rs`. It uses `terminal.rs` as the Terminal tab does: `start` (with the same admission as
  `start_terminal`), `write`, `close`, `output_list` and `read_output`.
- **Preview twin** (`src/extensions/runtime-terminals.ts`): `readRequest`, `gate`, `attribute`, `OutputLog` and
  `TerminalModel` run the same order of checks, pages and coalescing with no I/O. The browser spec drives them; there is no new
  IPC command, so there is no new preview mock beyond the model.

## Order of the refusals (frozen)

1. The operation: an unknown `op` is `InvalidShape`.
2. The permission itself: a package that holds the permission the operation needs for no project at all gets
   `PermissionDenied` with `path: "terminals.read"` or `"terminals.write"` whatever the target, so a refusal never says whether
   a terminal exists. Losing the read grant altogether also drops the package's subscriptions. (`unsubscribe` needs no
   grant: stopping is cleanup, and it cannot touch another package's subscription.)
3. The shape: `InvalidShape` for an unknown field or a bad id, cursor, size or dimension; `LimitExceeded` for input over 64 KiB.
4. What must exist and the grant for the project: an unknown terminal or one of no project is `NotFound`; a project outside the
   narrowed scope is `PermissionDenied`. `open` for an unknown project or task is `NotFound`; a shell that cannot start is
   `HostUnavailable`. Input to a terminal that already ended is `NotFound`.
5. The permission is read again just before the effect and before a read is handed over: a revoke, a narrowing or a disable in
   between changes nothing (a terminal opened while the grant was being revoked is closed again) and the answer is
   `PermissionDenied`.

## What ends what

- `close`, and a terminal that exits or is closed from the Terminal tab, end its subscriptions: the next pump answers once
  that the subscription ended (`closed`, or the final chunk with the exit code) and the subscription is gone.
- A revoke or narrowing of the read grant, a disable, an uninstall, safe mode or a crash end the subscriptions at the next
  pump (within 100 ms) or at once when the service stops. The shells the package opened keep running: from then on they are
  the user's, and the user closes them like any other.
- A package that ends leaves no timer, handle or subscription behind.

## Limits (for predictability, never for trust)

64 KiB per page and per write, a 256 KiB log per terminal, ten chunks a second per subscription and 16 subscriptions per
package. Reading the output of a terminal never changes it,
and `terminals.read` cannot send a byte.

## Refusals that remain, and why

- No grant, revoked, disabled or outside the narrowed project: `PermissionDenied` (the user's authority, rechecked natively).
- A terminal of no project: invisible (not a project resource, so no project grant reaches it).
- Input to an ended terminal: `NotFound` (nothing receives it).
- Input over 64 KiB: `LimitExceeded` (the terminal's own bound on one write).
- Reading what a terminal printed with `terminals.write` alone, or writing with `terminals.read` alone: separate grants by
  design (R0409), so each is granted, narrowed and revoked on its own.
