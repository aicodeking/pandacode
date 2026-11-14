# Content, tools and workspace contract compatibility (experimental)

The content, tools and workspace contracts use version 1 DTOs and the existing declarative package
schema. This is **not** a stable API or a cross-platform qualification announcement.
The general platform completion/API stabilization gate is separate.

| Slot | Selectable presentation | Compatible movement | Core ownership retained |
| --- | --- | --- | --- |
| `panda.files` | `list` | Original file-list presentation | File enumeration, folder expansion, document open |
| `panda.documents` | `viewer-first` | Original header order; `panda.views/documents` Main/Inspector placement | Tab/document identities, bytes, selection, parsers/workers |
| `panda.changes` | `commit-first` | Original commit-form order | Repository/diff/hunk identity, viewer, staged scope and Git policy |
| `panda.search` | `results-first` | Original form/results order | Query/options scheduler, captured results and original open handlers |
| `panda.browser` | `controls-below` | Original toolbar order | Guest/session, navigation, geometry and task attachments |
| `panda.terminal` | `tabs-below` | Original strip order; compatible `panda.views/terminal` placement | PTY/controller/job, tab selection and close approval |
| `panda.simulator` | `controls-first` | Original dock visual order; compatible hardware/menu siblings | Selected device, frames, input and platform/setup/clipboard policy |
| `panda.vm` | `controls-first` | Original dock visual order; compatible control siblings | Local/cloud machine, connection, canvas, serialized input and read-only share policy |
| `panda.design` | `comments-first` | Original comments region visual order, never iframe ancestors | Artboards, view, picked resource, comments, live draft and pending saves |
| `panda.btw` | `composer-first` | Original composer visual order and compatible control siblings | Distinct main/side task IDs, editor/undo, queue, stream, approvals and Stop |
| `panda.board` | `review-first` | Original four stage sections; compatible header/column/card/detail siblings | Tasks, stages, drafts, detail forms, running agents and worktree cleanup |
| `panda.githubHub` | `tabs-first` | Original tab bar; compatible unique sibling controls | Repositories, caches, sign-in, clone/task creation and workflow runs |
| `panda.pull` | `tabs-first` | Original tab bar; compatible header siblings | Pull identity, diff viewers, link/unlink and the merge confirmation |
| `panda.worktree` | `controls-first` | Original branch/worktree controls | Branches, worktree create/recreate and cleanup confirmations |
| `panda.actionDock` | `actions-first` | Original dock groups and items, Workers line parts | Team state, workers, approvals, answers, worker recovery and Stop |
| `panda.status` | `details-first` | Original usage overview sections, usage and visual progress toolbar controls | Usage reads, account details, the update prompt, notices and their Undo, Clear history and test reports |
| `panda.roster` | `running-first` | Original subagent rows, subagent view, team profile and main-window widget controls | Children, streams, lineage, profile rename/delete, Stop, the widget's preference and its pinned window |
| `panda.sidebar` | `filter-first` | Original header, project row, sections and row parts | Grouping, sorting, selection, manual order, unread state and confirmations |
| `panda.settings` | `actions-first` | Original sections, eligible rows and page headers | Preferences, credentials, grants, pairing, privacy, updates and safe-mode recovery |
| `panda.moodboards` | `viewer-first` | Original library/viewer order | Boards, images, captions, file picker/drop and delete confirmations |
| `panda.cloud` | `controls-below` | Original cloud strip and machine menu siblings | Machines, provisioning, credentials, spend and delete confirmation |
| `panda.machines` | `controls-below` | Original Run on rows and lineage siblings | Execution host, remote start, pairing, link/access consent and unlink |

These are deliberately closed host-rendered recipes, not arbitrary executable
renderers, DOM/selector APIs or business-service ownership grants. Inspect the
catalog for eligible controls, action/context locations, visibility and order.
Catalog pages are bounded: follow `nextCursor` until exhausted. Discovery does not
authorize invocation. Menus, icons, commands, dialogs and selects use the same
contracts as header/sidebar contributions; there is no content-only UI framework.

Install/enable does not select a component or a customization proposal. The user
chooses the provider/proposal explicitly. Incompatible versions remain unavailable;
competing packages never win by activation order. Hiding is presentation, not
revocation. Independent metadata/content permissions remain independent.

Actions carry captured opaque host context, identities and revisions. Unsupported,
stale, revoked, malformed and replayed operations fail closed; do not retry an
ambiguous mutation automatically. Pull snapshots/pages require fresh reads after
invalidation; Search cursors report `ResyncRequired`. No new live event or source
content endpoint is implied. Original document control availability and native
process/approval policy still apply. The original read-only diff has no hunk-stage
handler; unsupported hunk mutations never become whole-file staging.

## Recovery and qualification

Choose Built-in, disable the package, or disable extensions for the launch. Safe
mode ignores saved hidden-control/order overlays, including later host refreshes,
without erasing the saved preferences. Original documents, draft, query, guest
and PTY remain core-owned. Package removal disposes its transient UI/listeners;
it does not repeat dispatched work or kill unrelated processes.

Tools use the same catalog, commands, menus, dialogs, selects, icons and component
selection contracts, not private source imports or selectors. Each tool's captured
state/actions have independent version/revision/resource admission. Metadata is
not content authority. BTW additionally requires independent revocable host-user
`btw.taskControl` consent for mutations and `btw.content` for visible-answer
insertion; install/enable/select is not consent. Insertion never sends. Stop,
approval/mode and recovery stay host-owned. Simulator clipboard/setup/create and
VM setup/create/delete/share choices remain host-confirmed. Presentation recovery
does not restart a device/VM connection or repeat an accepted operation.

Workspace surfaces follow the same rules. Contributed toolbar and context actions
on Board, GitHub hub and Pull see `selection.kind` `board`, `github-hub` and `pull`
(worktree uses `task`, moodboards `moodboard`/`moodboard-image`, cloud and machines
`machine`); `projectId` and `sessionId` are omitted when there is none, never sent
empty. A click runs only the package command: it does not move the selected task,
repository or pull request, and does not fetch, merge, clone or start anything.
GitHub, cloud and multi-machine fixtures are synthetic; no GitHub mutation, cloud
spend, pairing or real device is exercised.

Design intentionally detaches artboard documents when the entire panel is hidden;
that original lifecycle is not used for recipe movement, faults or disable.
The existing VM inspector is macOS-only and local virtualization needs Apple
silicon. Synthetic MacIntel/local/cloud fixtures do not broaden that native policy.
The integrated tools suite exercises all four selected providers together,
captured device/machine typing, a pending Design save/new input, and independent
BTW draft/queue/Stop recovery, plus each location's shared package primitives.

Automated Chromium/WebKit fixtures prove preview behavior, not installed WebView2,
WKWebView or WebKitGTK guest/drag/IME qualification. Native library/archive/policy
tests and the real Windows ConPTY registry/job test are separate native evidence.
Installed Windows and Linux/WSL interactive acceptance is user-deferred; macOS,
ARM, mobile devices and real multi-machine acceptance remain unavailable/deferred.
Native website context menus and Linux's existing system-browser fallback are
platform boundaries, not exemptions for missing supported host controls.

See [documents](documents.md), [diff](diff.md), [Search](search.md),
[Browser](browser.md) and [Terminal](terminal.md) for exact bounds and authoring
examples; tools have separate [Simulator](simulator.md), [VM](vm.md),
[Design](design.md) and [BTW](btw.md) contracts; workspace surfaces have [Board](board.md),
[GitHub hub](github-hub.md), [Pull](pull.md), [worktree](worktree.md),
[moodboards](moodboards.md), [cloud](cloud.md) and [machines](machines.md); core Settings has [settings](settings.md); the sidebar has [sidebar](sidebar.md); the action dock and team progress have [action dock](action-dock.md); subagents, team profiles and the main-window Running agents widget have [agent roster](agent-roster.md); cached usage, the dock's status group, notices, visual progress and the Jev entry have [status](status.md); eligible main dialogs have the accessory band in [core dialogs](core-dialogs.md), and module-owned and directly mounted dialogs reuse it in [owned dialogs](owned-dialogs.md). Canonical implementation evidence and historical failed checks remain
in the project's extensibility receipt, not in a claim of universal API stability.
