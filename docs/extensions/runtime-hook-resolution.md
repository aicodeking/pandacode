# Hook chains across packages: order, budgets and failure policy (runtime slice R0506)

Native owner: `src-tauri/src/extensions/runtime_hook_resolution.rs`. Preview twin and settings control:
`src/extensions/runtime-hook-resolution.ts`. Fixtures: `tests/fixtures/extensions/runtime-hook-resolution/` (`alpha/`
and `beta/`, two packages whose `tool.before` hooks rewrite and deny; `order.json`, the effective-order corpus and the
scripted life of `_hooks.json`; `chains.json`, chains on a controlled clock; `streaks.json`, failure streaks; all
`synthetic`). Spec: `tests/extensions-runtime-hook-resolution.spec.ts` (preview/Node column, plus the settings control
in the page). Native: `runtime_hook_resolution::tests`.

R0504 awaits the chains of `prompt.submit`, host-tool `tool.after` and `compaction`; R0505 the chain of `tool.before`.
Both asked packages in registration order and handled each failure inside its own loop. This slice gives every chain
one order the user controls, one member runner, the event ceilings, late answers, and a notice for a hook that keeps
failing.

## The order

The host keeps the order natively in `extension-grants-v1/_hooks.json`, beside the grants file:

```json
{ "schema": 1, "order": ["sample.hook-beta"], "firstEnabled": ["sample.hook-alpha", "sample.hook-beta"] }
```

- `order` is the user's (`{ schema: 1, order: [package ids] }` of the contract). Empty means the default.
- `firstEnabled` is the frozen default the host maintains: a package id is appended the first time the host sees it
  enabled (when a hook registers, and whenever the settings control reads the order). Packages seen enabled at the same
  moment are appended by id. A place never moves afterwards.
- The effective order is `order` first (a repeated id counts once, at its first place; an id not installed is
  skipped), then `firstEnabled`, then any other id by id.

| Event | `order` | `firstEnabled` |
|---|---|---|
| Restart | kept | kept |
| Disable, update | kept | kept (re-enabling restores the place) |
| Uninstall | the id is removed | the id is removed |
| Reinstall | not in it (default place) | appended at the end |
| Safe mode | untouched (nothing is read or written; no package runs) | untouched |
| Damaged file | kept on disk untouched; the default order (by first enabled in this launch) applies and Settings says so; the user's next change replaces the file | |

Every awaited chain asks its packages in this order: `HookRegistry::attached` sorts by it, so `prompt.submit`,
`tool.after`, `compaction`, `tool.before` and the ask-at-host holders (R0505) all follow it. A change takes effect with
the next chain asked.

### Settings -> Extensions: Hook order

A list of the installed packages that declare hooks, in the effective order, each with its events, whether the user
placed it ("Placed by you") or it is at its default place, whether it is disabled, and any failure streak. Native
buttons Move up / Move down and "Reset to the default order"; focus follows the moved package. The control has no order
of its own: it reads `extensions_hook_order` and sends every change to `extensions_hook_order_change`
(`{ op: 'move', id, to }`, `{ op: 'set', order }`, `{ op: 'reset' }`), which validates natively (`UnknownReference` for
an id that is not installed, `DuplicateId` for a repeated id, `Unavailable` in safe mode, `StorageUnavailable` when the
write fails; nothing changes on a refusal) and answers the new projection. A move makes the whole list as shown the
user's order, so every package keeps the place the user saw.

## Resolution across packages

The folds are R0504's and R0505's; the order only decides who is asked first:

- **Rewrites accumulate in order**: each package sees the input as the earlier ones rewrote it, and the last rewrite runs.
  With Alpha (`npm ` -> `pnpm `) before Beta (`pnpm ` -> `yarn `), `npm test` runs as `yarn test`; with the user's order
  Beta first, Beta sees `npm test` and does nothing, so `pnpm test` runs.
- **A deny wins whatever the order**; it ends the chain, so packages after it are not asked. An ask wins over any
  approve. An overridden approve or rewrite gets `overriddenBy` in its receipt.
- **Every shown decision names its owner**: the transcript line ("`<tool>` denied by `<Package>`. `<reason>`",
  "approved by", "`<Package>` asks you to decide"), `tool.after.decidedBy`, and a failure's "`<Package>` did not answer
  (`<code>`)".

## Members, budgets and failures

Both chain loops ask each package through `ask_member`:

1. **Still a member?** The hook must still be attached, the receiving grant (`harness.hooks.observe`) must hold for the
   run's project, and the service must not be stopped or stopping at the user's request. A hook removed by revoke,
   disable, uninstall, a user's stop or safe mode is **skipped**: no failure policy, no receipt. The check runs again
   after a failure, so a package disabled while it is being asked is removed, not failed.
2. **Budget.** `budgetMs` clamped to the event's ceiling (100 ms to 30 s for `tool.before`/`tool.after`, to 10 s for
   `prompt.submit`, to 120 s for `compaction`), and to what is left of the chain's 60 s. A member the 60 s did not
   reach fails with `Timeout` without being asked.
3. **Failure** (a throw, an invalid return, the budget passed, a service that is not running) follows the declared
   `onFailure`: `continue` leaves the package out, `ask` shows the prompt ("`<Package>` did not answer (`<code>`). Decide
   yourself."), `deny` denies (`tool.before`) or refuses the send (`prompt.submit`). A failure never approves.
4. **A crashed or parked service is not removed.** When a service process ends without being asked to stop (a crash;
   the lifetime then restarts it or parks it after five crashes), its hooks stay as members marked down: each chain
   applies their declared `onFailure` with `HostUnavailable` until the restarted service registers them again, or the
   user disables, uninstalls, stops or revokes it (then they are removed). A guard that crashes therefore keeps
   denying under `onFailure: "deny"` instead of silently dropping out.
5. **Late answers.** An answer that arrives after the budget is never applied. If it carried a value, the package gets
   a receipt `{ applied: false, code: 'Timeout' }` (`panda.hooks.onApplied`).

## Failure notice

Three failures in a row of one package's hook for one event give **one** notice, a line in the task where the third
failure happened:

> Alpha's tool.before hook failed 3 times in a row (Timeout). As it declared, tool calls are denied while it fails.
> Check it in Settings > Extensions.

(`ask`: "you are asked to decide while it fails"; `continue`: "it is left out while it fails"; `deny` on
`prompt.submit`: "messages are not sent while it fails".) The app also emits `extension-hook-notice`
(`{ package, name, event, code, policy }`), and the settings list shows the streak. A success ends the streak; the next
three failures in a row give a new notice. A member the chain never reached (60 s gone) does not count; a removed
package's streaks are forgotten.

## Columns and limits

- Preview/Node: the spec (both Playwright configurations, WebKit grep `extensions hook resolution:`, CI ports
  16481/16482). Native fixtures: `runtime_hook_resolution::tests` (the order corpus and the file script with a restart
  and a damaged file, the event ceilings, the streaks, every `chains.json` case on a paused tokio clock through the real
  member runner and the R0504/R0505 folds, the registry's order and down marks). Installed service qualification with
  `sample.hook-alpha` and `sample.hook-beta`: pending, not claimed. No harness was run.
- Streaks live in memory: a restart of the app starts every count again.
- Hooks of events nothing awaits (`turn.*`, `task.idle`, one-way `tool.before`/`tool.after`) are delivered one way and
  never waited for, so their order changes nothing; they have no failure policy.
- Companions (R06xx) hand their calls to the same `tool.before` chain and so follow the same order.
