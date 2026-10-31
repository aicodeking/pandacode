import { escape, icon } from './dom';
import './message-actions.css';

/** Keys identify saved messages or a live text buffer; never embed message text. */
export function messageActionsHtml(sessionId: string, key: string | number, canFork = true, canEdit = false): string {
  const data = `data-message-session="${escape(sessionId)}" data-message-key="${escape(key)}"`;
  return `<div class="message-actions" role="group" aria-label="Message actions"><button type="button" data-message-action="copy" ${data} aria-label="Copy message" title="Copy message">${icon('copy')}</button>${canFork ? `<button type="button" data-message-action="fork" ${data} aria-label="Fork from here" title="Fork through this message into a new task in the same checkout">${icon('branch')}</button>` : ''}${canEdit ? `<button type="button" data-message-action="edit" ${data} aria-label="Edit and resend" title="Rewind to before this message in a new task and edit it there">${icon('edit')}</button>` : ''}<span class="message-action-status" role="status" aria-live="polite"></span></div>`;
}

/** Clipboard APIs can be unavailable in older desktop webviews. */
async function copyText(value: string | undefined | Promise<string | undefined>): Promise<void> {
  const resolved = Promise.resolve(value).then(text => {
    if (text === undefined) throw new Error('This message is no longer available. Please reopen the conversation.');
    return text;
  });
  // Begin the write during the click itself. WebKit requires user activation,
  // while a saved message can arrive from the native database asynchronously.
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const blob = resolved.then(text => new Blob([text], { type: 'text/plain' }));
    void blob.catch(() => {});
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]); return; }
    catch { /* Older webviews may support writeText instead. */ }
  }
  const text = await resolved;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Use the user-gesture fallback below. */ }
  const focused = document.activeElement as HTMLElement | null;
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  // Stay inside an open modal: its focus trap makes document.body inert.
  (focused?.closest('dialog[open]') ?? document.body).append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Could not copy this message. Please select its text and copy it manually.');
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
    if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? undefined);
    if (selection && ranges.length) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}

export function bindMessageActions(root: HTMLElement, options: {
  content: (sessionId: string, key: string) => string | undefined | Promise<string | undefined>;
  onFork?: (sessionId: string, messageId: number) => Promise<void>;
  onEdit?: (sessionId: string, messageId: number) => Promise<void>;
  report: (error: unknown) => void;
}): () => void {
  const pending = new Set<string>();
  const feedback = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  const click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-message-action]') : null;
    if (!button || !root.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (button.disabled) return;
    const sessionId = button.dataset.messageSession!, key = button.dataset.messageKey!;
    const action = button.dataset.messageAction;
    const token = JSON.stringify([sessionId, key, action]);
    if (pending.has(token)) return;
    const handler = action === 'fork' ? options.onFork : action === 'edit' ? options.onEdit : undefined;
    if (action !== 'copy' && (!handler || !Number.isSafeInteger(Number(key)) || Number(key) <= 0)) return;
    const hadFocus = document.activeElement === button;
    pending.add(token);
    // Keep Copy focused while text is fetched; disabling it blurs keyboard focus.
    button.disabled = action !== 'copy'; button.setAttribute('aria-busy', 'true'); button.setAttribute('aria-disabled', 'true');
    const work = (async () => handler ? handler(sessionId, Number(key)) : copyText(options.content(sessionId, key)))();
    void work.then(() => {
      if (action !== 'copy' || !button.isConnected) return;
      clearTimeout(feedback.get(button));
      button.innerHTML = icon('check'); button.dataset.copied = 'true';
      button.title = 'Copied'; button.setAttribute('aria-label', 'Copied');
      const status = button.parentElement?.querySelector<HTMLElement>('.message-action-status');
      if (status) status.textContent = 'Message copied';
      feedback.set(button, setTimeout(() => {
        feedback.delete(button); delete button.dataset.copied;
        button.innerHTML = icon('copy'); button.title = 'Copy message'; button.setAttribute('aria-label', 'Copy message');
        if (status) status.textContent = '';
      }, 1600));
    }).catch(options.report).finally(() => {
      pending.delete(token); button.disabled = false; button.removeAttribute('aria-busy'); button.removeAttribute('aria-disabled');
      if (hadFocus && button.isConnected && document.activeElement === document.body) button.focus({ preventScroll: true });
    });
  };
  root.addEventListener('click', click);
  return () => { root.removeEventListener('click', click); feedback.forEach(clearTimeout); feedback.clear(); };
}
