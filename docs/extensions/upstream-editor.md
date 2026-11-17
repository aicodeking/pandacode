# Floating code editor after the upstream merge

Upstream sync P6 (S0602). PandaCode 0.3.128 replaced the "Open files" inspector tab with a floating code editor and
the extension build re-applied the document surfaces (`panda.documents.*`, see [Documents](documents.md)) on that
structure. With no extension installed, all disabled, or in safe mode, the editor behaves exactly as upstream.

## What the editor is

Not a Tauri window: an in-page pane, `#file-panel`, created by `createFileWindow` (`src/file-window.ts`) and filled by
`createFileTabs` (`src/file-tabs.ts`).

| Owner | What it holds |
|---|---|
| `file-window.ts` | Chrome only: heading with Maximize and Hide, drag, resize grip, keyboard move and resize, Escape to hide, clamping, first placement, focus return. |
| `file-tabs.ts` | Per-task tab sets, strip, header buttons (Save, Discard, Edit/Preview, preview in browser, copy, Attach), loading, dirty state, compare-and-write save, Ask/Fix selection, scroll, the 64 MiB background cache, the extension seams. |
| `document-viewer.ts`, `office-viewer.ts` | Rendered reading, PDF/Word/sheet/image from bytes with an abort controller and a dispose. |
| `extensions/upstream-editor.ts` | The adapter: navigation bindings, published editor state, captured identity and its verdict. |

Lifecycle (open, show, load, edit and dirty, save, reload, switch task, dispose) is documented in the S05A audit;
the rules that matter to a package: closing the window only hides it (tabs, drafts and scroll survive), every redraw
disposes the previous actions, office render and editor instance, and a task or workspace switch makes a new context.

## What a package can do (existing public primitives)

| Surface | Control | Host element |
|---|---|---|
| `panda.documents.navigation` | `open-files` | the dock button `#file-editor-toggle` (shows or hides the editor) |
| `panda.documents.navigation` | `close-open-files` | the pane's Hide button |
| `panda.documents.tabs` | `select`, `close` | each tab |
| `panda.documents.actions` | `attach`, `copy`, `preview` plus contributed buttons | the header actions |
| `panda.documents.context` | the captured tab's actions plus contributed menu entries | the tab context menu |
| `panda.documents.viewer` | `rendered`, `raw`, `wrap`, sheets, actual size | the viewer controls |

Navigation keeps the catalog ids and labels it had when "Open files" was an inspector tab; the ids now bind the dock
button and the Hide button. Hiding, showing and ordering follow the layout rules of every control: reversible, scoped,
ignored in safe mode, and never closing a tab or dropping a draft. Hiding a control that holds focus moves focus to
the prompt. Contributions use `ui.contribute`; hiding and ordering use `ui.customize`, granted with the trust decision
and revocable. Disabling or uninstalling removes the contributions and layout rules; open tabs and viewers survive.

Host-owned and not a restriction: Escape hides the editor, Maximize, drag and resize, focus return, and the unsaved-work
guards (close, rename, delete and view switch refuse while a tab is dirty or saving). They protect predictability and
data; a package neither loses nor gains authority over them.

## Captured identity

The editor publishes `data-editor-mode` (`source`, `preview`, `viewer`, `none`), `data-editor-dirty` and
`data-editor-saving` on the pane. An action captured from the editor carries `{context, revision, tabId, documentId}`
(`captureEditorIdentity`); `editorActionVerdict` rejects it with `StaleContext` when the context (task, workspace) or
revision (any redraw: tab, content, control or mode change) differs, and with `InvalidArguments` when the tab id now
belongs to another document. The tab context menu uses it as its liveness check, so a menu opened before a redraw can
no longer act. Paths are never accepted as targets.

## Repairs and findings after the merge

- The old anchors for the "Open files" tab and its close button no longer exist (`tab-open-files`,
  `.file-panel-tab`); `panda.documents.navigation/open-files` and `close-open-files` now bind the dock button and the
  Hide button, so the surface hides, shows and reorders again.
- Text files open in the CodeMirror source view first (`editing` defaults to true, as upstream); the reader's Raw/Wrap
  controls appear after Preview. The earlier extension specs that expected Raw straight after opening a file, and the
  upstream `office-viewer` spec that clicks an "Open files" inspector tab, describe the previous structure. The upstream
  spec is unchanged and is checked against upstream's own tree in the final phase; extension specs add the Preview step.
- Office abort and disposal are unchanged: a hidden, switched or closed tab aborts its render and disposes the viewer;
  a reply for a replaced render is discarded.

## Evidence

- Preview, Chromium and WebKit: `tests/upstream-editor-extensions.spec.ts` (zero-extension editor, install and enable of
  `tests/fixtures/extensions/upstream-editor/manifest.json`, contribution, reorder, hide/restore of both navigation
  controls, stale captured menu, keyboard and focus, disable, safe mode with a draft kept). Written before the final
  test phase; counts are recorded in the receipt when it runs.
- Native authority and installed WebView: no new native command or permission; the four host commands the editor uses
  (`workspace_file_stamp`, `read_file`, `read_document_file`, `write_workspace_file`) are unchanged upstream commands.
  Installed qualification of the pane (drag and resize in WKWebView or WebView2, focus return) is pending and is not
  claimed by the preview evidence.

## Named handoffs

Custom editors mounted in the pane, a host buffer with bounded reads and writes, and document hooks are owned by the
runtime phase: R0301-R0306 (rich mounts) and R0901-R0903 (documents). They reuse `tab.draft`, `tab.content`, the
stamp and the compare-and-write described above and mount through the same `.file-view-body` seam; no second shell
or second `#file-panel`.
