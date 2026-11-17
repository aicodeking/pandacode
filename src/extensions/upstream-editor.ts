/**
 * Floating code editor adapter (S0602, upstream sync P6).
 *
 * Upstream 0.3.128 replaced the "Open files" inspector tab with an in-page floating pane (`#file-panel`, shown by
 * `src/file-window.ts`, filled by `src/file-tabs.ts`). The extension surfaces of the document family (`panda.documents.*`)
 * were re-applied on that structure through public primitives only:
 *
 * - `panda.documents.navigation/open-files` is the dock button that shows or hides the editor (`#file-editor-toggle`) and
 *   `panda.documents.navigation/close-open-files` is the pane's Hide button (`[data-file-window="close"]`). Both keep their
 *   catalog ids and labels; a layout proposal hides, shows and reorders them like any other control, and neither change
 *   closes a tab, drops a draft or moves the scroll position.
 * - the editor publishes a small, DOM-only state (`data-editor-*` on the pane) so characterization can observe source or
 *   preview, dirty and saving without reaching into private nodes.
 * - an action captured from the editor carries `{context, revision, tab id, document id}`; `editorActionVerdict` is the
 *   single comparison that rejects it once any of them moved on (a new draw, another task or workspace, a closed or
 *   replaced tab).
 *
 * Window chrome (maximize, hide by Escape, drag, resize, focus return) stays host-owned: the host cannot lose placement or
 * focus to a package, and the pane's drafts and the unsaved-work guards are stability rules, not a permission restriction.
 * The text buffer stays `tab.draft` / `tab.content` / `stamp` with compare-and-write on save; a later host buffer (R0901)
 * reuses them. No DOM node, selector, byte or path crosses to a package. A capability that needs new runtime abilities
 * (custom editors, host buffers) is the named handoff to R0301-R0306 and R0901-R0903, never a refusal.
 */
import { applyControlOrder, applyControlVisibility } from './layout-host';

export const EDITOR_NAVIGATION = 'panda.documents.navigation';

/** What the editor shows for the selected tab: CodeMirror source, the rendered preview, or a viewer-only document. */
export type EditorMode = 'source' | 'preview' | 'viewer' | 'none';
export type EditorState = Readonly<{ mode: EditorMode; dirty: boolean; saving: boolean }>;

/** The two host controls of the navigation surface, bound by catalog id (never by selector from a package). */
export function editorNavigationBindings(root: ParentNode = document): ReadonlyArray<readonly [string, HTMLElement | null]> {
  return [
    [`${EDITOR_NAVIGATION}/open-files`, root.querySelector<HTMLElement>('#file-editor-toggle')],
    [`${EDITOR_NAVIGATION}/close-open-files`, root.querySelector<HTMLElement>('#file-panel [data-file-window="close"]')],
  ];
}

/**
 * Orders and hides the navigation controls. Safe mode (or a launch whose recovery policy is not read yet) keeps the
 * built-in order and never hides; `fallback` receives focus when the focused control is hidden.
 */
export function applyEditorNavigation(builtInOnly: boolean, fallback: () => HTMLElement | null, root: ParentNode = document): void {
  const bindings = editorNavigationBindings(root);
  applyControlOrder(EDITOR_NAVIGATION, bindings, builtInOnly);
  if (!builtInOnly) applyControlVisibility(bindings, fallback);
}

/** Publishes the editor state on the pane; unchanged values are not rewritten. */
export function publishEditorState(pane: HTMLElement, state: EditorState): void {
  const next = { editorMode: state.mode, editorDirty: String(state.dirty), editorSaving: String(state.saving) };
  for (const [key, value] of Object.entries(next)) if (pane.dataset[key] !== value) pane.dataset[key] = value;
}

export type EditorIdentity = Readonly<{ context: string; revision: number; tabId: string; documentId: string }>;
export type EditorVerdict = 'ok' | 'StaleContext' | 'InvalidArguments';

/** Copies the identity an action was captured with; later changes to the live editor never leak into it. */
export function captureEditorIdentity(identity: EditorIdentity): EditorIdentity {
  return Object.freeze({ context: identity.context, revision: identity.revision, tabId: identity.tabId, documentId: identity.documentId });
}

/**
 * Compares a captured identity with the live one. A different context (task, workspace) or revision (any redraw,
 * tab, content or control change) is stale; the same tab id with another document id means the tab was replaced.
 */
export function editorActionVerdict(captured: EditorIdentity, live: EditorIdentity | undefined): EditorVerdict {
  if (!live || captured.context !== live.context || captured.revision !== live.revision) return 'StaleContext';
  if (captured.tabId !== live.tabId || captured.documentId !== live.documentId) return 'InvalidArguments';
  return 'ok';
}
