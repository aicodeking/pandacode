# Open harness consoles and run command-center actions (`harness.console`)

Runtime phase R4, slice R0408. A trusted background service opens the interactive console of a task's harness, lists the
commands a harness offers and runs one on a task, exactly as the user would. The permission is `harness.console`: project
scoped, granted with the trust decision, rechecked natively on every request, revocable and narrowable. A package that
holds it is never asked again per action (ADR-0005).

```js
await panda.harnesses.console.open({ taskId });                       // the console the user opens for that task
await panda.harnesses.console.open({ harness: 'codex', projectId });  // a console of a harness for a project
const commands = await panda.harnesses.commands.list({ harness: 'codex' });   // [{ id: '/compact', title: 'Free up context' }]
await panda.harnesses.commands.run({ taskId, command: '/compact', arguments: '' });
```

Nothing is a second implementation:

- `console.open` shows the terminal panel's harness console (the harness CLI in the task's folder), the same one the
  `/console` command and the dock's "Open harness console" entry open. It needs the task stopped, as for the user (`Busy`).
- `commands.list` answers from the slash catalog the command center shows, as `{ id, title }`. It reads the cached catalog of
  a task of that harness in a project the package may use; it never starts a harness. No such task gives `[]`.
- `commands.run` resolves the command with `resolve_slash_command` and performs the same action (or sends the same prompt)
  as a command typed in the composer, with the arguments unchanged. The window says which package took the action
  ("<package> ran /compact."), so it is never anonymous.

## Refusals

| Case | Answer |
|---|---|
| No grant, revoked, disabled package, project outside the narrowed scope | `PermissionDenied`, `path: "harness.console"` |
| Unknown or removed task or project, a command the harness does not offer | `NotFound` |
| A package provider's console (it has no interactive terminal mode, `docs/extensions/providers.md`) | `UnsupportedCapability` |
| A command the provider does not advertise, or a console-only command of a package provider | `UnsupportedCapability` / `NotFound` |
| A running task asked for a console | `Busy` |
| Extra fields, a command with spaces or control characters, a `harness` without a `projectId` | `InvalidShape` |
| A command over 128 characters, arguments over 4,096 characters | `LimitExceeded` |

A package provider's console is `UnsupportedCapability`, while a command the package declares (`contributes.slashCommands`)
stays callable through `commands.run`. A refusal leaves no console and no agent behind: the grant is read again just before
the window is asked, and a disable or revoke in between opens and runs nothing.

## Refusal-test reconciliation (Q007, Q065, Q073, Q100, Q129)

| Operation | Before | Now |
|---|---|---|
| Open a harness console, list or run command-center actions | refused | allowed through `panda.harnesses.console.*` and `commands.*` for a package that holds `harness.console` for the project |
| A contributed UI action that opens the console (`task-console` is a protected control) | refused at a protected location | still refused, as a UI action: a contributed control runs on a click the user did not make; a package that wants the effect calls the permissioned API |
| A package provider's console | refused | still `UnsupportedCapability`: it has no interactive terminal mode (a functional fact) |
| Forged, stale or foreign-owner requests; no grant; disabled package | refused | unchanged |

Retained refusals and their non-security reasons: unknown task or command (`NotFound`: nothing to act on), a package
provider console (`UnsupportedCapability`: no such mode exists), a running task (`Busy`: the console needs it stopped, as for
the user), shape and size bounds (input validation), four rounds waiting per package (fault isolation).

## Bounds (predictability and fault isolation, never trust)

Four rounds per package waiting for the window and 15 s for each answer. A service that ends cancels its waiting rounds:
they open and run nothing, and answer `Revoked`.

## Evidence columns

Preview/model: `tests/extensions-runtime-harness-console.spec.ts` (ports 16351 Chromium, 16352 WebKit). Native unit tests:
`runtime_harness_console::tests`. Fixture package: `tests/fixtures/extensions/runtime-harness-console/`. The installed service
opening a real console and running a real command is the native column, reported separately.
