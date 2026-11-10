import { isImeKey } from './dom';

interface Edit { value: string; start: number; end: number }
const bound = new WeakSet<HTMLTextAreaElement>();

/** A prompt owns its history: native document undo can otherwise undo an xterm
 * edit, and Chromium discards native history when the prompt is reattached. */
export function bindComposerHistory(field: HTMLTextAreaElement): void {
  if (bound.has(field)) return;
  bound.add(field);
  const snapshot = (): Edit => ({ value: field.value, start: field.selectionStart, end: field.selectionEnd });
  let current = snapshot(), before = current, composing = false, applying = false;
  let lastType = '', lastTime = 0;
  const past: Edit[] = [], future: Edit[] = [];
  const synchronize = (): void => {
    // A send/restore or other programmatic replacement starts a new edit history;
    // undo must never resurrect an already sent draft.
    if (field.value !== current.value) { past.length = future.length = 0; current = snapshot(); lastType = ''; }
  };
  const restore = (undo: boolean): void => {
    synchronize();
    const source = undo ? past : future, destination = undo ? future : past;
    const edit = source.pop();
    if (!edit) return;
    destination.push(snapshot());
    field.value = edit.value;
    field.setSelectionRange(edit.start, edit.end);
    current = snapshot(); lastType = '';
    applying = true;
    try { field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: undo ? 'historyUndo' : 'historyRedo' })); }
    finally { applying = false; }
  };
  field.addEventListener('keydown', event => {
    if (event.defaultPrevented || isImeKey(event) || composing || field.disabled || field.readOnly || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && !(key === 'y' && event.ctrlKey && !event.shiftKey)) return;
    event.preventDefault();
    restore(key === 'z' && !event.shiftKey);
  });
  field.addEventListener('beforeinput', event => {
    if (applying || field.readOnly || field.disabled) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (event.cancelable) { event.preventDefault(); restore(event.inputType === 'historyUndo'); }
      return;
    }
    if (composing) return;
    synchronize();
    before = snapshot();
  });
  field.addEventListener('compositionstart', () => { synchronize(); before = snapshot(); composing = true; lastType = ''; });
  const record = (type: string): void => {
    if (field.value === current.value) return;
    const now = performance.now();
    const grouped = type === 'insertText' && lastType === type && now - lastTime < 1000 && before.start === current.end && before.start === before.end;
    if (!grouped) { past.push(before); if (past.length > 100) past.shift(); }
    future.length = 0;
    current = snapshot(); lastType = type; lastTime = now;
  };
  field.addEventListener('input', event => {
    if (applying || composing) return;
    if (!event.isTrusted) { synchronize(); return; }
    record((event as InputEvent).inputType || 'replacement');
  });
  field.addEventListener('compositionend', () => { composing = false; record('composition'); });
}
