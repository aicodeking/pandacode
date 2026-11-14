# GitHub hub presentation v1 (experimental)

## Decision

Use an explicitly selected `panda.githubHub` closed `tabs-first` recipe with
`host-repositories`, `host-runs`, `original-actions`. It moves the original tab
bar ahead of the repository heading, not controllers or request ownership.
Arbitrary renderers, selectors, generic HubHost.call forwarding and copied task
handlers are rejected: they would bypass opt-in, clone destination selection or
retarget a pending repository operation. Toolbar-only replacement is insufficient.

## Contract and policy

`githubHubPresentation` and `githubHubAction` are bounded JSON v1 contracts.
Capture window, mount, repository, project, tab, resource, attempt and revision.
Opaque handles never authorize another repository. At most 500 permissioned row
summaries and 256 eligible controls are returned; titles/query/filter metadata
require `projects.summary`. No credentials, paths, prompts, Markdown, raw native
IDs, selectors or IPC cross the contract. Loading/error/offline and truncation are
explicit. Metadata is not authority. Discovery, installation, selection and enable
never sign in or fetch: only the original opted-in mounted hub loads GitHub data.
`filter` is bounded JSON containing eight-character repository/event summaries,
the pull number and latest-per-pull switch. It is redacted without summary
permission; full filter changes still invalidate revisions even beyond summaries.

Actions require the selected enabled provider and `ui.contribute`, current
identity/revision, a currently eligible host control and replay/pending admission.
Task-start/review/solve/fix/workflow actions additionally require independent
host-user task-control consent scoped to activation and repository. Clone and
external links require a fresh host user choice; clone keeps the original folder
picker. There is no external mutation/login API. Pull menus and clone/task
continuations retain the repository captured before opening asynchronous UI.

## Presentation and recovery

`panda.githubHub.controls` catalogs original repository/list/tab/filter/refresh,
thread/pull/issue/workflow controls. Compatible sibling order and reversible
visibility preserve original handlers. `panda.githubHub.actions` and
`panda.githubHub.context` use shared host contributions. The selected recipe moves
only the original bar. Conflict never auto-selects. Fault/disable/safe mode restore
core presentation without remounting, loading again, discarding query/expanded
details/drafts/pending clone/task, or stealing original focus. Host GitHub opt-in
remains authoritative. Browser fixtures are not installed-native qualification.
