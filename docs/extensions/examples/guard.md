# Example: the Command guard (hooks that observe, deny and rewrite)

Task R1204. One installable package, `sample.guard` (`examples/extensions/guard/`), the reference example of the harness hooks
of runtime phase R5: a trusted background service whose `tool.before` hook analyses shell commands with a local, deterministic
parser and answers with an R0505 decision. It uses the decisions of [tool decisions](../runtime-hook-decisions.md) (deny with a
reason, rewrite only where the call allows it), the order and failure policy of [hook resolution](../runtime-hook-resolution.md),
the intent rules of [cli intent](../runtime-cli-intent.md) as the vocabulary of what a command is, and the tool-row
replacement of [tool rows](../runtime-tool-row-replacement.md) for the package's attribution.

## What the package does

| Behavior | What happens |
|---|---|
| Deny | `git reset --hard` is refused before it runs. No prompt appears; the agent receives `Denied by Command guard [git.reset-hard]: <reason> Command: <shortened command>`. The host labels the tool row with the package (`denied by Command guard`) and the manifest's tool-row signal adds the chip `Denied by Command guard`. |
| No decision | `git status`, `npm test`, `rm -rf ./build` at the standard level and `rm -rf /tmp/x` return nothing: the normal prompt (or the harness's own flow) continues. The guard never returns `approve`. |
| Projects | With the project at `P`: `rm -rf ../outside` is denied; `rm -rf ./build` is allowed at the standard level (and strict, being a build folder) and denied at paranoid; `rm -rf <temp>/x` is allowed; `rm -rf .`, `rm -rf ~`, `rm -rf /` and a temp root are denied at every level; a variable the guard cannot resolve is denied (`rm.unresolved`). |
| Wrappers and chains | `sh -c "git push --force origin main"` and `sudo env X=1 git stash drop` are denied; ten nested wrappers are followed and the eleventh is denied as `analysis.recursion-limit`; `echo ok | rm -rf ~` is denied and the reason names `segment 2`. `$(...)` and backticks are analysed as commands of their own. PowerShell (`Remove-Item -Recurse`) and `cmd /c rd /s` are read with Windows paths. |
| Rewrite | `git push --force origin main` (one plain command, no wrapper) becomes `git push --force-with-lease origin main` when the call's `can` lists `rewriteInput`. The rewrite carries an attributed one-line note with the original and the new arguments (`ui.presentation`), the log and audit keep both, and the signal `Args rewritten (guard)` shows on the row. Where the harness cannot run new arguments, or the command is wrapped, the same call is denied (`git.push-force`) and never runs as written. `approve` coverage stays in the R5 fixtures. |
| Levels and policy | The settings page holds the level (`standard`, `strict`, `paranoid`) and custom rules (`{ "command": "terraform", "blockArgs": ["destroy"], "reason": "..." }`); a change applies at the next call without a restart. The user policy (`<data directory>/policy.json`) and the project policy (`.sample-guard/policy.json`) are read on every call; a project file can add rules and raise the level, not lower it. A write or edit tool aimed at `.sample-guard/` is denied (`guard.policy-protected`), as is a shell command that writes it. An invalid file falls back to the defaults and the status item reads `degraded`. |
| Status, log, audit | The status item reads `Guard <level>` and `N denied`. **Guard log** is a host-rendered table of the last 50 decisions, newest first. Every decision is one JSON line in `<data directory>/audit.jsonl`, with secrets replaced by `<redacted>`. **Explain a command** (command, `/guard-explain`) asks for a command line and shows the verdict and the steps of the analysis. |
| Slow or broken | A handler that throws or passes its 2 s budget (`guard-test sleep 60`, `guard-test throw`; only with `PANDA_GUARD_TEST=1`) falls under the declaration's `onFailure: "ask"`: the normal prompt appears with "Command guard did not answer (`code`). Decide yourself." and the call is never approved. The agent is not blocked: the next call is judged normally. |
| Another package approves | Deny wins (R0505): the tool row shows both decisions, and the guard's overridden rewrite or ask carries `overriddenBy`. |
| Unchecked | A shell call that reaches the guard only through `tool.after` (source `activity`) raises one notice per harness and mode, "A command ran without a check on `harness` (`mode` mode).", and the status item reads `not enforced for <harness> in <mode> mode`. The words come from `panda.harnesses.list` (R0509). |
| Off | Disable, revoke of a grant, safe mode and uninstall remove both hooks with the service; the harness then behaves as it did without the package. No panel exists to dismiss. |

## How it is built

- `package/lib/analyzer.mjs`: the parser (quotes, pipes, chains, substitutions), the unwrapping, the path classification and the
  rules, as one browser-safe ES module with no imports; it only reads text.
- `package/lib/guard.mjs`: the service (hooks, status, table, audit, explain, settings). It imports the analyser and takes every
  machine detail as `io`.
- `package/main.cjs`: the installed `io` (data directory from `panda.storage.directory`, the policy and audit files, the home and
  temp folders). `PANDA_GUARD_TEST=1` turns on the `guard-test` commands.
- Permissions: `ui.contribute`, `runtime.service`, `events.workspace`, `harness.hooks.observe`, `harness.hooks.decide`, `ui.dynamic`,
  `ui.notify`, `ui.presentation`, `harnesses.inventory`, `storage.private`. The decision is checked natively for the project and tool
  kind on every call; without `harness.hooks.decide` a return is a `PermissionDenied` receipt and the normal prompt.

## Coverage, reported honestly

The guard sees what the host hands it, and the host says how much that is. In the default modes a permission request is
`askedCalls` or `escalationsOnly` (Codex asks only to leave its sandbox, in `full` it asks nothing), and the report names it.
Where a harness never asks in a mode, a `full` launch of OpenCode, Kilo, Cline, Kimi, Grok, Command Code, GitHub Copilot, Hermes or
ZCode is launched in `ask` and answered at the host **only while this package holds an attached `tool.before` hook with the observe
and decide grants** (scoped full mode, R0505); disposing the hook, revoking either grant, disabling or safe mode restores the
original launch from the next run. Nothing about every call of every harness is claimed.

**Companions: pending — companions deferred (user decision 2026-11-17).** The R06 companion line (R0601 to R0606) was skipped in this
run, so no companion source or target version is named here and no companion coverage is claimed; the guard's `not enforced` status
is the visible form of that gap. Where a companion later makes a hook cover every call, the guard needs no change: it reads the same
`HookCall`.

## What it cannot express (decisions left to the person)

- It fails open by default (`onFailure: "ask"`: the person is asked; a permissive mode with no decision runs the call). A guard that
  must fail closed would declare `"deny"`; the plan hands that choice to the user.
- It does not read secret files or block network commands; its rules are the ones in `analyzer.mjs`, extended by custom rules.
- Whether hooks fire for team workers, bot tasks and tasks on another machine is the host's coverage report, not the guard's.
- A command line is judged as text: a program that builds its own destructive command at run time cannot be seen.

## Evidence

Everything below is **prepared, not run (deferred to the final test phase)**; nothing in this guide is an observation. The columns
are kept apart in `tests/fixtures/extensions/example-guard/evidence-columns.json`.

- Preview/Node, both engines: `tests/extensions-example-guard.spec.ts` (grep `command guard preview:`; Chromium port 16631, WebKit
  16632). It runs the shipped modules against a stand-in service and the R0505 and R0509 twins: the analyser table
  (`commands.json`, 78 commands and 3 paths), deny with reason and rule, permitted work, the rewrite with both versions, a slow and a
  throwing handler, levels and policy, the log of 50, the audit redaction, the unchecked notice and the removal of the hooks.
- Native: the five scripted scenarios of `scenarios.json` (denied, permitted, rewritten, slow, unchecked) through the real approval
  path with the B5 fake agent (`FAKE_AGENT_PANDACODE=reason,updatedInput`). No Rust acceptance test was written in this task.
- Installed Windows: the same scenarios against the installed package on a dedicated profile.
- Companion-specific coverage: pending — companions deferred (user decision 2026-11-17).
