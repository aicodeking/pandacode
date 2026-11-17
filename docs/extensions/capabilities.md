# Supported locations and capabilities (experimental API 1.0.0)

This table is the catalog PandaCode itself serves through `ui.listSurfaces`, with no package
installed. `tests/extensions-examples.test.mjs` regenerates it from `src/extensions/catalog.ts` and
fails when the two differ, so a row here is a tested capability flag, not a promise. Regenerate it
after a catalog change with `UPDATE_EXTENSION_DOCS=1 node --test tests/extensions-examples.test.mjs`
(PowerShell: `$env:UPDATE_EXTENSION_DOCS='1'; node --test tests/extensions-examples.test.mjs`)
and review the diff.

How to read a row:

- **Kind** `action` is a location a package may place `contributes.menus[]` entries in (button,
  menu trigger and, where listed, `status`/`badge`). `data` is a host-rendered surface: a component
  slot (its item type is the selectable `presentation`), a control group, a view host or a
  protected inspect-only list.
- **Operations**: `inspect` is metadata discovery; `contribute` accepts package entries; `hide`,
  `show` and `reorder` are user/layout presentation overlays (compatible sibling order only);
  `replace` and `move` mean a closed host recipe can be selected in **Settings → Extensions** for
  that slot. Only `inspect` means the location is protected: it is listed so authors can see it,
  and no package can add to, hide, reorder or replace it.
- **Windows**: the window whose catalog serves the location. A query from another window reports
  `available: false, reason: "HostUnavailable"`. Nothing is inherited across windows.
- **Host fallbacks**: controls the location cannot render inline and where the host shows them
  instead (`host-quick-pick` for selects, `main-dialog` for forms, another location for icons or
  passive status). Native OS menus have no inline selects, fields or SVG icons.

Discovery never grants authority: invoking still needs the manifest permission, the user's grant
and a captured, unrevoked context. Platform limits that are not visible here are listed in the
[author guide](README.md#platform-limits).

## Upstream surfaces without a contract yet

The post-merge baseline (PandaCode 0.3.128 merged, audit S05A, published by S05B) inventories every
renderer member in `tests/fixtures/extensions/surfaces.json`. The members below exist in the product
but are **not** in the table that follows: no location serves them, so no package can place, hide or
reorder anything there today. They are listed as `open` in `completionAudit.gaps` (the completion
audit stays `blocked` until each one gets a contract or a named exception) and are never counted as
closed.

| Surface | Members | Owner slice |
|---|---|---|
| Project explorer (`src/file-explorer.ts`) | `close-dialog`, create/rename/delete dialog, file context menu; in `src/main.ts`: `file-menu`, `new-workspace-file`, `new-workspace-folder`, dock `toggle-files` | S0601 |
| Floating editor dock button | `toggle-file-editor` (the editor body is `panda.documents`, already a table row) | S0602 |
| Grouped thread errors | `dismiss-error`, `dismiss-errors`, `dismiss-failover-error`, `toggle-error` in `src/main.ts`; `dismiss-error` in `src/bots.ts` and `src/agents-dock-window.ts`; `models-retry` in `src/bots.ts` | S0607 (S0605 owns the dock window file) |

Named exceptions, with provenance (`_work/30-plan/upstream-sync/PLAN-upstream-content.md`, sections 1
and 5). An exception is a decision with a reason, not a closure, and none of them is a security
restriction (ADR-0005):

| Item | Why it is not a location | Owner of the record |
|---|---|---|
| `settings-page` in `src/usage-labels.ts` | Inline fix link whose only effect is `revealSetting(providers)`; the destination page is already a Settings page surface. | S0609 |
| Floating editor chrome (`src/file-window.ts`: maximize, hide, drag, resize, Escape) | The host owns placement, focus return and Escape; the discovery regexes cannot see it. | S0602 |
| Shell intent classifier (`shell-intent*.ts`) | Internal classification, no extension path. | S0603 |
| Application menu Quit item (`src-tauri/src/app_menu.rs`) | System-owned item on macOS that routes quit through the exit path. | S0609 |
| Crash guard native (`src-tauri/src/crash_guard/*`) | Fault isolation and recovery stay built-in. | S0608 |

The counts and names in the table are generated from `src/extensions/catalog.ts` and were not changed
by this publication; regenerate and compare them in the final test phase.

<!-- capability-table:start -->
| Location | Kind | Operations | Item types | Windows | Host fallbacks |
| --- | --- | --- | --- | --- | --- |
| `panda.actionDock` | data | inspect, replace, move | actions-first | main | — |
| `panda.actionDock.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.actionDock.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.actionDock.protected` | data | inspect | button | main | — |
| `panda.agents.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.agentsDock.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | agents-dock | select → `host-quick-pick`, form → `main-dialog` |
| `panda.agentsDock.protected` | data | inspect | button | agents-dock | — |
| `panda.board` | data | inspect, replace, move | review-first | main | — |
| `panda.board.card` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.board.cards` | data | inspect, hide, show, reorder | button | main | — |
| `panda.board.columns` | data | inspect, hide, show, reorder | button | main | — |
| `panda.board.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.board.detail` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.board.header` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.bot.assignment` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.bot.channel.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.bot.channel.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.bot.conversation.protected` | data | inspect | button | main | — |
| `panda.bot.thread.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.bot.thread.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.browser` | data | inspect, replace, move | controls-below | main | — |
| `panda.browser.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.browser.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.browser.controls` | data | inspect, hide, show, reorder | button, input | main | — |
| `panda.btw` | data | inspect, replace, move | composer-first | main | — |
| `panda.btw.composer` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.btw.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.btw.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.btw.header` | action | inspect, contribute, hide, show, reorder | button | main | — |
| `panda.btw.message` | data | inspect, hide, show, reorder | button | main | — |
| `panda.btw.queue` | data | inspect, hide, show, reorder | button | main | — |
| `panda.changes` | data | inspect, replace | commit-first | main | — |
| `panda.changes.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.changes.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.changes.file` | data | inspect, hide, show, reorder | button | main | — |
| `panda.changes.viewer` | data | inspect, hide, show, reorder | button | main | — |
| `panda.cloud` | data | inspect, replace, move | controls-below | main | — |
| `panda.cloud.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.cloud.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.cloud.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.cloud.protected` | data | inspect | button | main | — |
| `panda.cloud.targets` | data | inspect, hide, show, reorder | button | main | — |
| `panda.commands` | data | inspect, contribute | command | main | — |
| `panda.commands.harness.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.commands.harness.entries` | data | inspect, hide, show, reorder | button | main | — |
| `panda.commands.protected` | data | inspect | button | main | — |
| `panda.commands.slash` | data | inspect, contribute, hide, show | slash-command | main | — |
| `panda.commands.slash.entries` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.composer.attach.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.attach.protected` | data | inspect | button | main | — |
| `panda.composer.attachments` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.composer.council.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.council.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.model.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.model.entries` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.panels.protected` | data | inspect | button | main | — |
| `panda.composer.permissions.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.protected` | data | inspect | button | main | — |
| `panda.composer.queue.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.queue.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.recipes.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.recipes.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.saver.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.saver.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.steering.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.steering.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.tray` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.composer.tray.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.composer.wake.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.wake.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.composer.wake.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.deploy.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.design` | data | inspect, replace, move | comments-first | main | — |
| `panda.design.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.design.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.design.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.dialog.agent-updates.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.agent-updates.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.attachment.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.attachment.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.bot-settings.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.bot-settings.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.bots.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.bots.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.changed-files.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.changed-files.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.channel-create.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.channel-create.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.channel-settings.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.channel-settings.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.colors.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.colors.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.command-center.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.command-center.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.command-palette.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.command-palette.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.conversation-import.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.conversation-import.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.github-import.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.github-import.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.github-link.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.github-link.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.github-pr.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.github-pr.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.integrations-fallback.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.integrations-fallback.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.integrations.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.integrations.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.jev-assist.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.jev-assist.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.jev-settings.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.jev-settings.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.jev-tests.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.jev-tests.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.moodboards.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.moodboards.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.open-project.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.open-project.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.opencode-models.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.opencode-models.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.progress-lightbox.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.progress-lightbox.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.protected` | data | inspect | button | main | — |
| `panda.dialog.recipes.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.recipes.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.rename-task.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.rename-task.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.sketch.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.sketch.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.subagents.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.subagents.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.task-details.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.task-details.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.task-status.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.task-status.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.team-model-add.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.team-model-add.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.tool-image-viewer.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.tool-image-viewer.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.usage.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.usage.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.wallpapers.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.wallpapers.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.working-directory.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.working-directory.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.dialog.worktree-create.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.dialog.worktree-create.bodyExtras` | data | inspect, contribute | text | main | — |
| `panda.documents` | data | inspect, replace, move, hide, show | viewer-first | main | — |
| `panda.documents.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.documents.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.documents.navigation` | data | inspect, hide, show, reorder | button | main | — |
| `panda.documents.tabs` | data | inspect, hide, show, reorder | button | main | — |
| `panda.documents.viewer` | data | inspect, hide, show, reorder | button | main | — |
| `panda.githubHub` | data | inspect, replace, move | tabs-first | main | — |
| `panda.githubHub.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.githubHub.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.githubHub.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.inspector.actions` | action | inspect, contribute | button, menu-trigger | main | — |
| `panda.inspector.changes.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.changes.toolbar` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.files.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.files.toolbar` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.search.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.search.toolbar` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.inspector.views` | data | inspect, contribute, hide, show, reorder | view, list, tree, table, tabs, progress | main | — |
| `panda.launcher.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | launcher | select → `host-quick-pick`, form → `main-dialog` |
| `panda.launcher.protected` | data | inspect | button | launcher | — |
| `panda.machines` | data | inspect, replace, move | controls-below | main | — |
| `panda.machines.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.machines.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.machines.protected` | data | inspect | button | main | — |
| `panda.machines.targets` | data | inspect, hide, show, reorder | button | main | — |
| `panda.menus.task.protected` | data | inspect | button | main | — |
| `panda.menus.window.protected` | data | inspect | button | main | — |
| `panda.moodboards` | data | inspect, replace, move | viewer-first | main | — |
| `panda.moodboards.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.moodboards.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.moodboards.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.moodboards.protected` | data | inspect | button | main | — |
| `panda.projects.filter.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.pull` | data | inspect, replace, move | tabs-first | main | — |
| `panda.pull.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.pull.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.pull.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.pull.merge` | data | inspect | button | main | — |
| `panda.roster` | data | inspect, replace, move | running-first | main | — |
| `panda.roster.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.roster.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.roster.protected` | data | inspect | button | main | — |
| `panda.search` | data | inspect, replace, move | results-first | main | — |
| `panda.search.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.settings` | data | inspect, replace, move | actions-first | main | — |
| `panda.settings.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.settings.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.settings.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.settings.pages` | data | inspect, contribute | settings-page | main | — |
| `panda.settings.protected` | data | inspect | button | main | — |
| `panda.settings.sections` | data | inspect, hide, show, reorder | button | main | — |
| `panda.shortcuts` | data | inspect, contribute | keybinding | main | — |
| `panda.sidebar` | data | inspect, replace, move | filter-first | main | — |
| `panda.sidebar.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.bots` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.bots.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.bots.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.bots.groups` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.bots.protected` | data | inspect | button | main | — |
| `panda.sidebar.bots.rows` | data | inspect, hide, show | button | main | — |
| `panda.sidebar.channel.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.footer` | action | inspect, contribute | button, menu-trigger | main | — |
| `panda.sidebar.header` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.project.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.projects` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.protected` | data | inspect | button | main | — |
| `panda.sidebar.rows` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.sections` | data | inspect, hide, show, reorder | button | main | — |
| `panda.sidebar.sort.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.sidebar.task.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.simulator` | data | inspect, replace, move | controls-first | main | — |
| `panda.simulator.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.simulator.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.simulator.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.status` | data | inspect, replace, move | details-first | main | — |
| `panda.status.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.status.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.status.items` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.status.protected` | data | inspect | button | main | — |
| `panda.task.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.team.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.team.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.team.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.team.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.team.setup.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.terminal` | data | inspect, replace, move, hide, show | tabs-below | main | — |
| `panda.terminal.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.terminal.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.terminal.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.thread.attachments.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.thread.attachments.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.thread.changes.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.thread.changes.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.thread.extras.protected` | data | inspect | button | main | — |
| `panda.thread.find.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.thread.find.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.thread.header` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.thread.message.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.thread.trace.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | main | — |
| `panda.thread.usage-limit.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.thread.usage-limit.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.tray.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger, status, badge | tray | select → `host-quick-pick`, form → `main-dialog` |
| `panda.tray.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | tray | select → `host-quick-pick`, form → `main-dialog`, icons → `panda.tray.actions`, status → `panda.tray.actions`, badge → `panda.tray.actions` |
| `panda.tray.protected` | data | inspect | button | tray | — |
| `panda.vm` | data | inspect, replace, move | controls-first | main | — |
| `panda.vm.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.vm.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.vm.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.workspace.header.actions` | action | inspect, contribute | button, menu-trigger | main | — |
| `panda.workspace.project-picker.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.workspace.project-picker.entries` | data | inspect, hide, show, reorder | button | main | — |
| `panda.workspace.tiles-picker.protected` | data | inspect | button | main | — |
| `panda.workspace.tiles.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.workspace.tiles.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.workspace.view.menu` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.worktree` | data | inspect, replace, move | controls-first | main | — |
| `panda.worktree.actions` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.worktree.context` | action | inspect, contribute, hide, show, reorder | button, menu-trigger | main | — |
| `panda.worktree.controls` | data | inspect, hide, show, reorder | button | main | — |
| `panda.worktree.protected` | data | inspect | button | main | — |
<!-- capability-table:end -->
