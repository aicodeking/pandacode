# Design canvas

First version of [issue #14](https://github.com/AICodeKing/PandaCode/issues/14): agents design UI as HTML artboards, the user reviews them beside the chat and comments on exact elements, and the agent revises.

- **Artboards** are files in the task checkout: `.pandacode/design/<name>.html` (letters, digits, `.`, `_`, `-`; up to 64 characters). Turn changes, diffs, review and worktree merges cover them like any other file. `<meta name="artboard-width" content="390">` sets an artboard's width (default 1280); its height fits the content (up to 6000 px).
- **Comments** are `.pandacode/design/comments.json`: `[{ id, artboard, selector, bbox: {x, y, width, height}, text, status: "open" | "resolved", createdAt, note? }]`. `selector` is a CSS path from `body` (ids when unique, else `:nth-of-type`); `bbox` is in artboard pixels.
- **Canvas** (`src/design-canvas.ts`, `src/design-canvas.css`): the inspector's Design view. Each artboard is an `<iframe sandbox="allow-same-origin" srcdoc>`: no scripts run (no `allow-scripts`), and the srcdoc document inherits the app CSP, so remote assets never load. `allow-same-origin` lets the canvas read the frame's document to find the element under a click (`elementFromPoint` on an overlay mapped through the zoom); nothing in the frame can run code to use it. Drag pans, Shift-scroll pans horizontally, ⌘/Ctrl-scroll or pinch zooms, and ordinary scroll pans. Comment mode (speech-bubble button) picks an element; open comments show as numbered marks. *Send comments to agent* puts a prompt in the composer (not sent) naming each comment's id, file, selector and box, and asking the agent to resolve them.
- **Live reload**: the native `design-changed` event (emitted after `pandacode_design_write`/`pandacode_design_resolve`) and every run end call `refresh()`, which re-reads only artboards whose size or mtime changed. Artboards written with the agent's own file tools appear at run end or with the reload button. A hidden canvas makes no calls; there are no timers, watchers or processes.
- **Native** (`src-tauri/src/design.rs`): IPC `design_list`, `design_read`, `design_comments`, `design_save_comments` (`projectId`, `sessionId`), all through `Store::workspace_root`, so remote mirrors are refused. Every path step (`.pandacode`, `.pandacode/design`, the file) must be a real folder/file, not a link, inside the canonical checkout; names never contain separators or `..`. Bounds: 512 KiB per artboard read, 128 KiB per tool write (the MCP body limit is 160 KiB), 100 artboards, 500 comments, 4000-character text, 1024-character selectors; writes are atomic (temp file + rename).
- **Agent tools** (every harness, no approval; they only touch `.pandacode/design/`): `pandacode_design_list`, `pandacode_design_write {name, html}`, `pandacode_design_comments {status?: open|resolved|all}`, `pandacode_design_resolve {id, note?}`.
- **Preview** mock: `src/preview-design.ts` (two artboards, one comment). **Tests**: `cargo test --lib design::` and `tests/design-canvas.spec.ts` (mounts the module on its own under the app CSP, so it does not depend on the wiring below).

Not in this version: style/text patch tools, node-tree reads, screenshots and cropped comment images, design tokens, editing inside artboards.

## Wiring

Files outside the design scope; apply these hunks.

`src-tauri/src/lib.rs`:

```diff
 mod conversation_import;
+mod design;
 mod file_preview;
```

```diff
         let host = vm::tools::with_vm(host, app.clone(), session_id.clone(), stopped.clone());
+        let host = design::with_design(host, app.clone(), session_id.clone(), stopped.clone());
         let host = cloud::deploy::with_deploy(host, app.clone(), session_id.clone(), stopped.clone());
```

```diff
                 list_files,
                 search_files,
                 read_file,
+                design::design_list,
+                design::design_read,
+                design::design_comments,
+                design::design_save_comments,
```

(`agent_tools.rs` needs no change: `design::with_design` wraps the host like `vm::tools::with_vm` and reuses `agent_tools::{spec, validate_spec}`.)

`src/main.ts`:

```diff
-  query: '', archived: false, inspector: false, inspectorTab: 'changes' as 'changes' | 'files' | 'browser' | 'pull' | 'simulator' | 'vm',
+  query: '', archived: false, inspector: false, inspectorTab: 'changes' as 'changes' | 'files' | 'browser' | 'pull' | 'simulator' | 'vm' | 'design',
```

```diff
 let vmPanel: ReturnType<typeof import('./vm-panel').mountVmPanel> | undefined, vmLoading: Promise<void> | undefined;
+let designPanel: ReturnType<typeof import('./design-canvas').mountDesignCanvas> | undefined, designLoading: Promise<void> | undefined;
```

In the inspector markup (line ~280), after the VM tab button and after the VM section:

```diff
-<button data-action="tab-vm" aria-label="Virtual machines" title="Virtual machines" ${isMac ? '' : 'hidden'}>${icon('monitor')}</button></div>
+<button data-action="tab-vm" aria-label="Virtual machines" title="Virtual machines" ${isMac ? '' : 'hidden'}>${icon('monitor')}</button><button data-action="tab-design" aria-label="Design" title="Design canvas">${icon('sketch')}</button></div>
```

```diff
-<section id="vm-panel" class="vm-panel" aria-label="Virtual machines" hidden></section></aside>
+<section id="vm-panel" class="vm-panel" aria-label="Virtual machines" hidden></section><section id="design-panel" class="design-panel" aria-label="Design" hidden></section></aside>
```

After `function syncVmPanel() { … }`:

```ts
/** The design canvas stays mounted once opened; hidden, it makes no calls. */
function syncDesignPanel(): void {
  const wanted = state.inspector && state.inspectorTab === 'design' && !inspectorSuppressed;
  $('#design-panel').hidden = !wanted;
  if (wanted) { $('#inspector-content').hidden = true; $('.inspector-heading>[data-action="refresh-inspector"]').hidden = true; }
  if (!wanted) { designPanel?.hide(); return; }
  if (designPanel) { designPanel.show(); return; }
  designLoading ??= import('./design-canvas').then(({ mountDesignCanvas }) => {
    designPanel = mountDesignCanvas($('#design-panel'), {
      call, notify,
      context: () => state.projectId ? { projectId: state.projectId, sessionId: state.sessionId || null } : null,
      compose: text => { const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (prompt) { prompt.value = text; prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.focus(); } },
    });
    if (state.inspector && state.inspectorTab === 'design' && !inspectorSuppressed) designPanel.show();
  }).catch(error => { designLoading = undefined; report(error); });
}
```

In `renderInspector()`:

```diff
   syncVmPanel();
-  if (state.inspectorTab === 'browser' || state.inspectorTab === 'simulator' || state.inspectorTab === 'vm') { pullView.dispose(); return; }
+  syncDesignPanel();
+  if (state.inspectorTab === 'browser' || state.inspectorTab === 'simulator' || state.inspectorTab === 'vm' || state.inspectorTab === 'design') { pullView.dispose(); return; }
```

In the action switch:

```diff
     case 'tab-vm': openVm(); break;
+    case 'tab-design': inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'design'; state.selectedKind = ''; renderInspector(); break;
```

Beside the `vm-changed` subscription:

```diff
   run(subscribe('vm-changed', event => { if (event && !Array.isArray(event) && event.show) openVm(); void vmPanel?.refresh(); }).then(() => undefined));
+  run(subscribe('design-changed', () => void designPanel?.refresh()).then(() => undefined));
+  run(subscribe('agent-event', (event: AgentEvent) => { if (event.kind === 'done' && event.sessionId === state.sessionId) void designPanel?.refresh(); }).then(() => undefined));
```

(Thread switches already call `renderInspector()`; `show()` reloads when the project/task changed.)

`src/preview.ts`:

```diff
 import { createPreviewCloud, createPreviewVm } from './preview-vm';
+import { createPreviewDesign } from './preview-design';
```

```diff
 const previewVm = createPreviewVm();
+const previewDesign = createPreviewDesign();
```

```diff
     case 'vm_desktop': result = previewVm.desktop(args.name); break;
+    case 'design_list': result = previewDesign.list(); break;
+    case 'design_read': result = previewDesign.read(args.name); break;
+    case 'design_comments': result = previewDesign.comments(); break;
+    case 'design_save_comments': result = previewDesign.saveComments(args.comments); break;
```

`playwright.config.ts` `testMatch`:

```diff
-'**/vm.spec.ts', 
+'**/vm.spec.ts', '**/design-canvas.spec.ts', 
```
