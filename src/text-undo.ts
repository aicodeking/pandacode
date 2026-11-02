/** Linux builds run WebKitGTK, whose Ctrl+Z never reaches the field's own undo stack (#277): the key arrives at the page but the text does not change, while `document.execCommand('undo')` on the same field works. Linux therefore routes the shortcuts to execCommand itself; macOS (WKWebView) and Windows (WebView2) undo natively and are left alone. */

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/** Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo. */
export function undoDirection(key: string, shiftKey: boolean): 'undo' | 'redo' | null {
  const lower = key.toLowerCase();
  if (lower !== 'z' && lower !== 'y') return null;
  return lower === 'y' || shiftKey ? 'redo' : 'undo';
}

/** Fields whose text execCommand can edit; buttons and checkboxes are left to their own shortcuts. */
export function isEditableField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.tagName === 'TEXTAREA') return true;
  if (el?.tagName === 'INPUT') return TEXT_INPUTS.has((el as HTMLInputElement).type);
  return Boolean(el?.isContentEditable);
}

/** The pieces of document and KeyboardEvent the handler needs, so tests can stub both. */
export interface TextUndoEvent {
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean; defaultPrevented: boolean; preventDefault(): void;
}
export interface TextUndoHost {
  activeElement: EventTarget | null;
  execCommand(command: string): boolean;
  addEventListener(type: string, listener: (event: TextUndoEvent) => void, capture?: boolean): void;
}

/** One document-level capture listener covers the composer and every other text field.
  The terminal is excluded: xterm feeds the shell through a hidden textarea, where Ctrl+Z suspends the foreground job and Ctrl+Y yanks, they are PTY input, not text edits. */
export function attachTextUndo(doc: TextUndoHost, platform: string): void {
  if (!/Linux/i.test(platform)) return;
  doc.addEventListener('keydown', (event: TextUndoEvent) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    const direction = undoDirection(event.key, event.shiftKey);
    const el = doc.activeElement as Element | null;
    if (!direction || !isEditableField(el) || el?.closest?.('.xterm')) return;
    event.preventDefault();
    doc.execCommand(direction);
  }, true);
}

export function mountTextUndo(): void {
  attachTextUndo(document, navigator.platform);
}
