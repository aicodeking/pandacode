# Projects, worktrees, branches, tasks, pulls and project checks (`workspace.manage`, `projects.checks.run`)

Runtime phase R4, slice R0405. A trusted service manages the workspace with `panda.workspace.projects.*`,
`worktrees.*`, `branches.*`, `tasks.*` and `pulls.*`, and runs a project's check script with
`panda.projects.checks.run({ taskId })`. Every call is a thin adapter over the command the interface already uses, so a
package gets exactly what the user's own click gets, with the package's name on the action (nothing here is hidden from
the user).

## Permissions (ADR-0005)

- `workspace.manage` covers the nineteen calls below. It is **project scoped**: the grants file is asked on every request
  for the project the call touches (the task's project for a task, worktree or pull call; the project named for a project
  or branch call; both projects for `tasks.move`), and once more right before anything changes, so a revoke or a
  narrowing between the two changes nothing. `projects.add` has no project yet: only a grant for every project covers it.
- `projects.checks.run` is its own permission with the same rules, granted at install with the trust decision, per project
  where a project applies. A package that holds it is never asked per run. It is revocable and narrowable by the user;
  a revoke while the script runs withdraws the report. The same grant is what the existing "Project checks after turns"
  control (`turn-checks`) now rests on for a package, so there is one reviewed operation behind both.
- A package that holds a permission is never asked to confirm a call, except the irreversible deletions below.

## The calls and their native shapes

Every input is an object with exactly these keys (anything else is `InvalidShape`; no key names a credential, a pairing,
a remote device or a consent). A worktree is identified by the task that works in it; a branch by its name.

| SDK call | Native adapter | Input | Answer |
|---|---|---|---|
| `workspace.projects.add(input)` | `add_project` | `{path}` (a folder path; the folder chooser stays the user's own tool) | `{projectId, name}` |
| `projects.remove(projectId)` | `remove_project` | `{projectId}` | `null` |
| `projects.rename(projectId, name)` | `UPDATE projects` (no command existed) | `{projectId, name}`, 1-200 characters | `{projectId, name}` |
| `projects.relink(projectId, path)` | `relink_project` | `{projectId, path}` | `{projectId, name}` |
| `worktrees.create(input)` | `create_worktree` (a new task in its own checkout) | `{taskId, branch, base?, existing?}` | `{worktreeId, taskId, projectId, branch}` |
| `worktrees.remove(worktreeId, options?)` | `remove_worktree` | `{worktreeId, deleteBranch?}` | `{removed, branch, branchDeleted, note}` |
| `worktrees.recreate(worktreeId)` | `recreate_worktree` | `{worktreeId}` | `{worktreeId, branch}` |
| `worktrees.merge(worktreeId)` | `merge_worktree` | `{worktreeId}` | `{branch, target, commits, switchedFrom}` |
| `branches.create(input)` | bounded `git branch` | `{projectId, taskId?, name, from?, switch?}` | `{current, branches, defaultBranch}` |
| `branches.switch(input)` | `git_switch_branch` | `{projectId, taskId?, branch}` | `{current, branches, defaultBranch}` |
| `branches.rename(input)` | bounded `git branch -m` | `{projectId, taskId?, from, to}` | `{current, branches, defaultBranch}` |
| `branches.remove(input)` | bounded `git branch -d` (`-D` with `force`) | `{projectId, taskId?, branch, force?}` | `{current, branches, defaultBranch}` |
| `tasks.remove(taskId)` | `delete_session` | `{taskId}` | `{taskIds}` (the task and its owned workers) |
| `tasks.rename(taskId, title)` | `update_session` | `{taskId, title}`, 1-200 characters | `null` |
| `tasks.move(taskId, projectId)` | `UPDATE sessions` (no command existed) | `{taskId, projectId}` | `{taskId, projectId}` |
| `pulls.link(taskId, input)` | `github_link_pull_request` | `{taskId, reference}` (number or URL, at most 512 characters) | `{number, url, title, state}` |
| `pulls.unlink(taskId)` | `set_task_link` | `{taskId}` | `null` |
| `pulls.check(taskId)` | `github_pull_request` | `{taskId}` | `{number, title, state, url, base, head, mergeable, reviewDecision, mergedAt, checks}` |
| `pulls.merge(taskId, options?)` | `github_merge_pull_request` | `{taskId, method?}` (`squash`, `merge`, `rebase`; default `merge`) | `{number, url, title, state}` |
| `projects.checks.run({taskId})` | `run_turn_checks` (`checks::turn_report`) | `{taskId}` | `{schemaVersion: 1, report}` |

The three calls with no command of their own are small bounded operations on the same store and the same bounded Git
runner (`workspace::run_git_bounded`, `workspace::checked`): a project's name (a label; a later relink takes the folder's
name again), a branch's create, rename and delete, and a task's project. Rules they keep because they protect work, not
because the author is distrusted: a task that is running, mirrored from another computer, a cloud task, a team's task or
one that works in its own worktree is not moved (its checkout belongs to its project); a branch a task's worktree works
on, or that is checked out, is not renamed or deleted; `git branch -d` refuses an unmerged branch unless `force` is set.

`projects.checks.run` answers what the user's own run answers: the declared check's `{checked, name, ok, output,
truncated}` or `{checked: false, reason}` when the project declares none (no plan is a report, never an error). The
script runs in the task's checkout through the one bounded runner (60-second and output bounds of `checks.rs`), at most
two at once per package.

## Irreversible actions keep the host's confirmation

`projects.remove`, `tasks.remove`, `worktrees.remove`, `branches.remove` and `pulls.merge` ask the main window first,
through `runtime_family_consents`: the dialog names the package and what goes ("Delete the task Second and its history.
This cannot be undone."), takes a second step, and **Cancel, Escape or an ended service answers `Cancelled`** and changes
nothing. The user can turn the confirmation off for one package; then the action proceeds at once. With no window
(a headless host) a confirmation that is on answers `HostUnavailable`. Merging a worktree into its project
(`worktrees.merge`) is not on the frozen irreversible list: Git keeps the history and the merge refuses a dirty or
conflicting checkout, so it acts at once. Four confirmations may wait per package, five minutes each (`Timeout`).

Pairing a machine and granting remote access have no call: a name such as `projects.pair` answers
`UnsupportedCapability`, and a `pair`, `remoteAccess`, `trusted` or `confirmed` key in any input is `InvalidShape`.
Trust in a package's author is not trust in another machine.

## Order of the refusals (frozen)

1. A call outside the vocabulary: `UnsupportedCapability`. An input that is not an object with exactly the call's keys, or
   an id that is not a plain identifier: `InvalidShape`.
2. The permission, for the project the call touches: `PermissionDenied`, `path` naming the permission. A task or project the
   package may not touch is `PermissionDenied` before it is ever `NotFound`: a narrowed package learns nothing about other
   projects.
3. The rest of the shape: `InvalidShape` (a path, name, branch or reference the call does not take) or `LimitExceeded`
   (a size bound).
4. What must exist: `NotFound`.
5. The confirmation: `Cancelled`, `Timeout`, `HostUnavailable`, `LimitExceeded` (a fifth waiting).
6. The permission again, then the host operation. A host failure maps to a frozen code; nothing of its text reaches the
   package: `Conflict` (the agent is running, the branch is checked out or in use, the name exists, the folder belongs to
   another project), `NotFound` (no such branch, no linked pull request, the task uses the main checkout),
   `InvalidShape`, `UnsupportedCapability` (the task runs on another computer) or `HostUnavailable`.

## Where each part runs

- Native: `src-tauri/src/extensions/runtime_workspace_projects.rs` (admission, the confirmation slots, the check gate,
  the execution through the commands, `service_stopped`), declared next to the other runtime slices, one command
  `extensions_runtime_workspace_confirm_answer` (main window only), one service method `workspaceProjects`, state
  `WorkspaceProjects` managed in `lib.rs`.
- SDK: `panda.workspace.{projects,worktrees,branches,tasks,pulls}` and `panda.projects.checks.run` (`node-host.cjs`).
- Window and preview twin: `src/extensions/runtime-workspace-projects.ts` mirrors the rules with no I/O
  (`WorkspaceManager`) and runs the window half: the host's confirmation dialog, the project list reload after a change
  (`extensions-runtime-workspace-changed`). Preview mock: `extensions_runtime_workspace_confirm_answer` records its answers
  in `window.__runtimeWorkspaceAnswers`.
- A change reloads the interface: `sessions-changed` for task, worktree, branch and pull changes, and
  `extensions-runtime-workspace-changed` with `projects: true` for project changes.

## Bounds (predictability and fault isolation, never trust)

Paths 4096 characters, names and titles 200, branches 120, references 512, four confirmations waiting per package for five
minutes, two checks at once per package; Git calls run through the bounded runner (64 KiB output, 30 s).

## Refusal-test reconciliation

Owner rows: Q008, Q012, Q016, Q018, Q074, Q078, Q088, Q089, Q101, Q113, Q114. They are mixed rows, split by operation
among their listed owners.

What this slice delivers is the **service call**: a service holding `workspace.manage` (and `projects.checks.run`) now
adds, removes, renames and relinks projects; creates, removes, recreates and merges worktrees; creates, switches, renames
and deletes branches; removes, renames and moves tasks; links, unlinks, checks and merges pull requests. The permissioned
assertions that change are the ones that said "a package cannot change these": they are carried by
`tests/extensions-runtime-workspace-projects.spec.ts` and `runtime_workspace_projects::tests`.

| Rows | Surface | Changed by this slice | Retained refusal and its non-security reason |
|---|---|---|---|
| Q008, Q074, Q101 | task menus | `tasks.remove`, `tasks.rename`, `tasks.move`, the pull link, check and merge, and the worktree create, remove, recreate and merge are granted service calls | The nine task-menu controls stay refused as **contribution actions**: a declarative menu entry carries no owner and no grant to check, and each run must be a fresh user choice (predictability). Team, delete-task and deploy stay the user's gesture there; the protected location stays protected |
| Q012, Q078 | sidebar | `projects.remove`, `projects.rename`, `tasks.rename`, `tasks.remove` and `tasks.move` are granted service calls | `delete`, `rename`, `reorder`, `remove-project`, `pin`, `drag` stay refused as contribution actions for the same reason: they are the user's gestures on rows |
| Q016 | settings | `projects.checks.run` is the permissioned form of `turn-checks`; `projects.remove` is the permissioned form of `project-remove` | `turn-checks`, `project-remove`, `provider-credentials`, `remote-pairing`, `github-sign-in`, `safe-mode` and `app-update` stay refused as settings **controls**: a declarative settings component has no grant; the credentials, pairing, sign-in and recovery items stay the user's (ADR-0006, answer D3) |
| Q018 | machines, cloud, moodboards, worktrees, pull | the worktree and pull operations are granted service calls | The host-owned machine controls (pairing, remote access) and the fields `credentials`, `token`, `apiKey`, `path`, `prompt` stay refused in declarative state and actions: a component must never carry a secret or a path (the service call takes the path as its own typed input); cloud and machine families belong to R0406C and R1003 |
| Q088, Q113 | pull | `pulls.link`, `unlink`, `check` and `merge` are granted service calls | `merge-start` and `unlink` before consent stay refused as contribution actions; `merge-confirm` still answers `InvalidShape` and cannot be forged or hidden: the confirmation is the host's own dialog, answered by the window only, `Cancelled` on refusal |
| Q089, Q114 | worktrees | `worktrees.create`, `remove`, `recreate` and `merge` are granted service calls | `switch-default`, `worktree-remove`, `worktree-recreate` as contribution actions stay refused; `worktree-confirm` and `cleanup-confirm` still answer `InvalidShape`: the confirmation cannot be forged |

No assertion of an old test file was edited by this slice: those rows assert that **contribution actions** are refused,
a contract this slice leaves as it was (a workspace change from code is a service call, not a declarative control), so
every old refusal still holds. The changed permissioned assertion is the new one: a service with the grant succeeds, one
without it (narrowed, revoked, in safe mode) is `PermissionDenied`, and an irreversible action is `Cancelled` when the
user refuses. The hub owners of `contracts.rs` and the `extensions-*` unit tests keep the old rows green; any row whose
wording needs the permissioned counterpart is updated in the final test phase.

## Evidence columns

Preview/model: `tests/extensions-runtime-workspace-projects.spec.ts` (ports 16281 Chromium, 16282 WebKit). Native unit
tests: `runtime_workspace_projects::tests`. An installed service driving `sample.runtime-workspace-projects` over a
temporary fixture project (operations, an inert check script, a cancelled deletion, revoke and repeat): the final test
phase and R1212 qualification; nothing here claims it.
