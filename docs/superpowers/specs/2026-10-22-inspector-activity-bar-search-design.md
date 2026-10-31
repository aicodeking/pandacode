# Inspector icon bar, Search view and Files by default

## Requested outcome

Make the project inspector feel like VS Code's side bar: views chosen from a
vertical icon bar, a Search view that finds text across the project, and the
Files view open as soon as a project is opened.

## Icon bar

- The inspector stays on the right. Its horizontal tab strip becomes a 44 px
  icon column on the panel's left edge, next to the conversation: **Files**,
  **Search**, **Changes** (with the changed-file count as a badge), **Browser**,
  then **PR**, **Simulators** and **VM** where they apply today.
- Every icon has an accessible name and a tooltip; the selected view gets an
  accent bar on its outer edge. The `.inspector-tabs` class and the existing
  `data-action` names are kept, so existing actions and tests address the same
  buttons.
- **Update (2026-10-24):** the icons moved from that column to one row along
  the panel's top edge, level with the workspace header, so the panel's content
  keeps its full width. The selected view is underlined on the row's bottom
  edge, and the view heading below it is a slim row. Everything else here is
  unchanged.
- The panel header names the current view (FILES, SEARCH, CHANGES, …) beside
  the refresh button.
- The icon bar belongs to the panel and closes with it. A bar that stays
  visible while the panel is closed would change every workspace column layout
  (browser mode, board view, narrow windows) and is left for later.

## Files by default

- A task or project without saved panel state opens the inspector on Files in
  the Conversation view. Per-task panel state (open or closed, view, folder,
  selected file) is still remembered and restored, so a panel the user closed
  stays closed.
- It stays closed when the window is 920 px or narrower, where the panel would
  cover the conversation, and when a task is opened from the Board.

## Search view

- One field with **Match case**, **Whole word** and **Regex** toggles. Results
  show two sections:
  - **Files**: up to eight file-name matches from the existing `search_files`
    index (the `@` mention search).
  - **Text**: find-in-files matches grouped by file, collapsible, each line with
    its highlighted match and line number.
- Clicking a result opens the file in the inspector's viewer; Back returns to
  the search with its query and results intact. Jumping to the matched line is
  not supported by the document viewer and is out of scope.
- Searching runs 250 ms after typing pauses (Enter searches at once), and
  responses for older queries are dropped. The form stays mounted while the view
  is open, so background inspector refreshes do not steal the caret. Results are
  cleared when the project or task checkout changes.
- Not included: replace, include/exclude globs, search history.

## `search_text` command

- `search_text(projectId, sessionId?, query, matchCase, wholeWord, regex)`
  searches the task's checkout (worktrees search their own copy).
- Walks with the `ignore` crate using the same rules as file-name search:
  `.gitignore` (also outside Git repositories), hidden files included, `.git`,
  `node_modules`, build and cache folders excluded, depth 48, symlinks not
  followed.
- Matching uses the `regex` crate (already in the lockfile through `ignore`).
  Literal queries are escaped; whole word wraps the pattern in `\b…\b`; Match
  case off is case-insensitive. Invalid regular expressions return
  `Invalid regular expression: …`, shown inline.
- Skips files over 1 MiB, files with a NUL byte in the first 8 KiB and
  non-UTF-8 files. Stops after 2,000 matches or 50,000 files and reports
  `truncated`.
- Each matching line returns its number, a trimmed preview (up to 300
  characters, keeping 40 characters before a far-off first match) and highlight
  ranges in UTF-16 units for the web view.
- Runs on the blocking pool so the UI thread stays responsive.

## Testing

- Rust unit tests: matches and previews with UTF-16 ranges, each toggle,
  ignored/excluded/binary/large files, the match limit, long-line windows,
  invalid queries, and (on Unix) symlinks out of the project.
- Playwright (`tests/search-panel.spec.ts`) against a `search_text` preview
  mock: the icon bar and Files default, file-name and text results, collapse,
  toggles reaching the backend, invalid regex, and opening a match then going
  Back. Existing tests that assumed a closed panel at start are updated.
