# Branch and worktree presentation v1 (experimental)

## Decision

Before v1, the branch control (`src/worktrees.ts`) privately owned the composer
context-bar chip, the Branch and worktree menu, the branch picker, the create form
and the cleanup offer, with no public state, action or replacement contract. v1 adds
an explicitly selected `panda.worktree` closed `controls-first` recipe with
`host-branch`, `host-worktree`, `original-actions`. It moves the original branch
and linked-work chips ahead of the checkout indicator; it does not move menus,
forms, git calls or cleanup ownership. Arbitrary renderers, selectors, branch-name
or path arguments, copied create/switch/cleanup handlers and public "create" or
"confirm cleanup" actions are rejected: each would let a package bypass the host
form or cleanup confirmation, choose a branch for the user, or retarget a pending
operation to another task.

## Contract and policy

`worktreePresentation` and `worktreeAction` are bounded JSON v1 contracts shared by
the schema, SDK (`WorktreeComponent`, `WorktreePresentation`, `WorktreeAction`),
native validator and catalog. They capture window, mount, project, task,
repository, branch, base (the default branch, once the host has listed branches)
and worktree as opaque handles plus a revision; a branch switch, a new worktree or
a task switch changes them, so an older request is refused as `StaleContext`
instead of being retargeted. At most 64 eligible controls are returned; the branch
name requires `projects.summary`. No paths, URLs, credentials, raw IDs, selectors
or IPC cross the contract. Checkout kind (`local`, `worktree`, `missing`,
`remote`, `none`), loading, git error, detached HEAD, running agent, pending
operation, open create form, open cleanup offer, linked issue/pull and truncation
are explicit. Metadata is not authority.

Actions require the selected enabled provider and `ui.contribute`, the current
mount/identity/revision, a currently eligible and enabled host control with the
same resource, and replay admission. Rejections use stable reasons: `Revoked`,
`WrongOwner`, `PermissionDenied`, `UnsupportedCapability`, `InvalidArguments`,
`StaleContext`, `AlreadyApplied`, `Busy`, `Offline`. Controls the original menu
disables while the agent runs stay `UnsupportedCapability`. While an operation
runs or any host dialog is open, everything except the open cleanup offer's own
cancel is `Busy`, so pending form inputs are never replaced. Only `open-pull` and
`open-url` need the network; local git controls keep working offline.

`switch-default`, `worktree-merge`, `worktree-remove`, `worktree-recreate`,
`settle-task` and `cleanup-cancel` need independent host-user branch control
consent, granted from a row in the original Branch and worktree menu and scoped to
the activation. `switch-default`, `worktree-merge`, `worktree-recreate`,
`settle-task`, `copy-path` and `open-url` also run only after a fresh host choice
("Extension requested a branch action"). `switch-other` opens the original branch
picker and `worktree-attach`/`worktree-new` open the original create form: the
user still picks the branch and submits.

## Protected policy

The create form submit, the cleanup confirmation and its remove-folder option,
the branch picker rows, the current-checkout row and the missing-worktree recovery
rows (`worktree-recreate`, `settle-task`) are catalogued in the inspect-only
`panda.worktree.protected` location. The schema has no `worktree-confirm`,
`cleanup-confirm` or `cleanup-remove` control, so they cannot be forged, invoked or
replayed; the protected location is not a layout location and its rows are pinned
in the menu even against a forged stored overlay. Discovery, install, enable and
selection never call git. Native worktree commands and their policy (refusing to
remove dirty work, keeping unmerged branches, settle-before-cleanup) are unchanged.
The host now runs one branch operation at a time: a repeated create submit, switch
or cleanup while one is pending is ignored with a notice, never started twice.

## Presentation and recovery

`panda.worktree.controls` catalogs the checkout indicator, branch chip and linked
issue/pull chips; their order and reversible visibility are written into the host
context-bar markup, so a redraw keeps them and keyboard focus stays on the same
chip. `panda.worktree.actions` holds the original eligible menu rows (switch,
other branch, create, merge, remove, copy path) plus shared contributed entries,
with order and visibility; integration rows and the consent row stay pinned.
`panda.worktree.context` adds contributed entries on the chip's context menu
(right click, Shift+F10 or the menu key). Conflict never auto-selects; future
contract versions are disabled. Fault, disable and safe mode restore the built-in
order without closing the open form or cleanup offer, changing the selected task
or branch, or repeating a pending switch, create or cleanup. Browser fixtures use
the in-memory preview checkout and are not installed-native qualification; no real
worktree is created or removed by the tests.
