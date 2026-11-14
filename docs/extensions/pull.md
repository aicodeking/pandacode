# Pull request presentation v1 (experimental)

## Decision

Before v1, the Pull inspector (`src/github-pull.ts`) privately owned its cached
detail, diff promises, mounted task/section/viewers, request generation and merge
state, with no public state, action or replacement contract. v1 adds an explicitly
selected `panda.pull` closed `tabs-first` recipe with `host-pull`, `host-diffs`,
`original-actions`. It moves the original section tabs ahead of the header; it does
not move viewers, controllers, requests or merge ownership. Arbitrary renderers,
selectors, generic `PullHost.call` forwarding, copied merge handlers and a public
"confirm merge" action are rejected: each would let a package bypass the host
confirmation, pick the merge method or retarget a pending merge to another task.

## Contract and policy

`pullPresentation` and `pullAction` are bounded JSON v1 contracts shared by the
schema, SDK (`PullComponent`, `PullPresentation`, `PullAction`), native validator
and catalog. They capture window, mount, project, task, repository, pull, base,
head, section and revision as opaque handles; a base/head retarget or a task switch
changes them. At most 500 file summaries and 256 eligible controls are returned;
the title and file paths require `projects.summary`. No credentials, URLs, bodies,
patches, comments, raw native IDs, selectors or IPC cross the contract. Loading,
error, offline, busy (merging or unlinking), merge state, method and truncation are
explicit. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current
mount/identity/revision, a currently eligible host control with the same resource,
replay admission and no pending merge/unlink. Rejections use stable reasons:
`Revoked`, `WrongOwner`, `PermissionDenied`, `UnsupportedCapability`,
`InvalidArguments`, `StaleContext`, `AlreadyApplied`, `Busy`, `Offline`. `unlink`,
`merge-start` and `merge-cancel` also need independent host-user Pull control
consent scoped to activation and the mounted pull. `link`, `review` and `check`
open GitHub only after a fresh host choice ("Extension requested a GitHub entry").

## Merge safeguards

`merge-start` only opens the original host confirmation. Confirm merge and the
method select inside it have no public control ID: the schema rejects
`merge-confirm`, so they cannot be forged, invoked or replayed. `merge-method`
opens the original host menu; the user picks. The protected `panda.pull.merge`
catalog location is inspect-only: it is not a layout location, never receives
order or visibility overlays (a forged stored overlay is ignored), and package
discovery, install, enable or selection never fetches or merges. The native
`github_merge_pull_request` policy and its single captured-task reply are unchanged.

## Presentation and recovery

`panda.pull.controls` catalogs the original section tabs, checks toggle, check,
review, mergeability, link, file, refresh and unlink controls. Unique sibling
order and reversible visibility apply to original nodes; tabs keep their order
for the segment thumb. `panda.pull.actions` and `panda.pull.context` use shared
host contributions. Conflict never auto-selects; future contract versions are
disabled. Fault, disable and safe mode restore the built-in order without
remounting, fetching again, disposing live diff viewers or moving focus. Pending
merge, unlink and load replies stay bound to the task they started on and never
render into another pull. Browser fixtures are not installed-native
qualification.
