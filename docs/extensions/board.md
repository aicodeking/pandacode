# Board presentation v1 (experimental)

## Decision

Use an explicitly selected `panda.board` closed `review-first` recipe with
`host-tasks`, `host-details`, `original-actions`. It changes column presentation
order, not stages, task ordering, selection or lifecycle. Arbitrary renderers,
selectors and copied task business logic were rejected because they could lose
drafts, duplicate starts or bypass original worktree/approval/import policy.
Toolbar-only replacement was rejected: revisioned state and captured actions
must also be available. Installation and conflicting providers never select one.

## Contract and authority

`boardPresentation` and `boardAction` are bounded JSON v1 shapes shared by schema,
SDK and native validator. Window, mount, selected project/task, project filter,
revision and opaque task row/project/stage/revision are captured. Rows contain
at most 500 summaries, with explicit truncation. Titles require `projects.summary`;
descriptions, paths, prompts, credentials and draft text are never returned.
Actions require the currently selected enabled provider's `ui.contribute` grant;
task mutations additionally require independent host-user task-control consent,
scoped to package/version/activation/project for this launch. Metadata is not authority.

Open/add/edit/start/retry/settle/reopen/filter/import delegate original host entry
handlers. Forms, project selection, import opt-in, active-run restrictions and
worktree cleanup decisions stay core-owned. No action sets an arbitrary stage or
submits package text. Edit/settle/reopen require the captured selected task.
Start/retry distinguish pending from interrupted work, and never start review or
settled work. In-flight operations are serialized, request IDs are consumed before
dispatch, and a later selection cannot retarget the captured task.

## Controls and continuity

`panda.board.header`, `.columns`, `.cards`, `.detail` expose eligible original
controls, reversible visibility and compatible sibling ordering. Header/card/detail
accessories and `.context` use shared declarative actions. Column movement only
changes visual ordering of the same original sections. Card actions do not imply
task movement. Original links retain their opt-in GitHub policy. Detail editors,
composer, running streams and protected Stop/approvals are outside replacement;
disable, safe mode and faults restore the built-in board without remounting them.
No arbitrary task lifecycle, extra writable stage, package-owned editor, raw IPC
or host DOM API is introduced. Browser previews are not installed native evidence.
