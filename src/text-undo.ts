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

/** One document-level capture listener covers the composer and every other text field. */
export function mountTextUndo(): void {
  if (!/Linux/i.test(navigator.platform)) return;
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    const direction = undoDirection(event.key, event.shiftKey);
    if (!direction || !isEditableField(document.activeElement)) return;
    event.preventDefault();
    document.execCommand(direction);
  }, true);
}
