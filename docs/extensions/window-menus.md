# Workspace view, Sort and view and Filter projects menus v1 (experimental)

## Decision

Before v1 the Workspace view menu, the sidebar Sort and view menu and the searchable Filter projects menu had no extension
adapter: none passed an extension surface, so no package could add an item and the user could not hide or reorder an
entry. v1 makes them extensible without moving a handler out of `src/main.ts` (the sort choice is the pure
`sortAfterChoice` in `src/sidebar-sort.ts`), owned by `src/extensions/window-menus-core.ts` (registry
`WINDOW_MENUS_REGISTRY`, admission) and `src/extensions/window-menus-host.ts` (extension surfaces, captured actions):

- `panda.workspace.view.menu`: contributed items beside Conversation, Board and GitHub, captured with
  `selection.kind = "workspace-view"` (`ids = [<the open view>]`). A package that wants a main view of its own declares
  a view (`contributes.views`), a command with an `openView` action and a menu item here: clicking it opens the view
  through the existing view navigation (`requestInspectorView`), the same path as the header and the command palette.
  Conversation, Board and GitHub hide and reorder; the open view stays listed and checked, even if the user hid it;
- `panda.sidebar.sort.menu`: contributed items in Sort and view, captured with `selection.kind = "sidebar-sort"`
  (`ids = [<task order>, "per-<count>"]`). Recent activity, Created and the four tasks-per-section counts hide and
  reorder; Manual (it leads the Sort tasks group and keeps drag-to-arrange) and the selected order and count never hide;
- `panda.projects.filter.menu`: contributed items in Filter projects, captured with `selection.kind = "project-filter"`
  (`ids = [<the filtered project>]` or `["all-projects"]`). The projects are the user's own, in the projects list's order;
  every row keeps its place, its search and its right-click project actions;
- `panda.menus.window.protected`, inspect-only, with a reason for each: the open view, switching the view, GitHub
  availability, Manual sort, the selected sort and count, changing the sort or count, All projects, the filter
  selection, changing the filter and a project's own actions;
- the `windowMenusPresentation` / `windowMenusAction` contract for captured actions, and the new selection kinds
  `workspace-view`, `sidebar-sort` and `project-filter` (schema `context.selection.kind`, SDK `WindowMenusSelectionKind`,
  native `contracts.rs`).

A menu passes its extension surface (`showChoices` `extensionSurface`) only when an enabled package contributes to it or
the user arranged its entries; otherwise, and in safe mode, it keeps exactly the host's own rows, search and roles (the
rows keep their radio role also when the surface is engaged). The captured context is built once, when the menu opens,
with the window, the revision and the open task's project; the menu ends if the view, the sort or the filter it was opened
for changes. The view, the sort, the tasks per section and the project filter are host settings, never changed by
discovery, install, enable, selection or contribution.

Rejected alternatives: letting a package set the sort, the count or the filter directly (they are the user's own
settings and a project filter also selects a project); a package-owned project list (it would put project names and paths
in a package's hands); hiding the open view (the user could lose where they are); a new replacement recipe (the selected
`panda.composer` provider is reused as owner of captured actions, as for the slash and task menus).

## Captured actions

A `windowMenusAction` carries the opaque window, mount, view, sort, filter and revision of the `windowMenusPresentation`
it was built from, plus a control handle and its resource (a menu entry). The presentation carries which host menu is
open and the controls; it never carries labels, project names or IDs, paths or search text. A change of view, sort,
count or filter, or any redraw, changes the revision: an older request is `StaleContext`.

| Control | Effect |
| --- | --- |
| `view-open` | Fresh host choice ("Extension requested a window menu action"); Continue runs the original `setWorkspaceView`. |
| `sort-set` | Fresh host choice, then the original `chooseSidebarSort` for Manual, Recent activity or Created. |
| `scope-set` | Fresh host choice, then the same `chooseSidebarSort` for the tasks shown per section. |
| `filter-set` | Fresh host choice, then the original `chooseProjectFilter` for a project or all projects. |

`view-hide-current`, `sort-reorder`, `project-actions`, `project-remove`, `project-add` and `github-enable` are refused
with `PermissionDenied` before any other check. Other reasons: `Revoked` (safe mode, fault, disable, another owner's
identity), `WrongOwner`, `InvalidArguments`, `UnsupportedCapability` (the target is already in use, hidden, or its menu has
no trigger on screen, as the sort in the board), `Busy` (an open menu, another dialog or a host choice), `AlreadyApplied`.
The fresh choice runs the handler exactly once and only for the same view, sort and filter; Escape declines and nothing
runs.

## Recovery

Conflict, fault, disable, another selected provider and safe mode keep the active view, sort, count and filter: the
host's rows return once each, a contributed item that cannot run leaves the menu, and a closed menu runs nothing. Safe
mode restores the built-in order and every entry without deleting the stored preferences. Installed WebView
qualification is not claimed; evidence is the browser preview (`tests/extensions-window-menus-coverage.spec.ts`,
Chromium and WebKit), the Node contract tests (`tests/extensions-window-menus.test.mjs`) and the native contract and
package tests.
