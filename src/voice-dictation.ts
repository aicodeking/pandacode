import { createVoiceWaveCanvas } from './voice-wave-canvas.ts';
import { bindVoiceDictationKeys } from './voice-dictation-keys.ts';
import { createVoicePill } from './voice-pill.ts';
import { VoiceCaptures, logVoiceFailure, readVoiceSetup, type VoiceAnchor, type VoiceCapture, type VoiceNativeHost } from './voice-capture.ts';
import type { VoiceClosedTranscript, VoiceShortcutMode } from './voice-types';

/** `voice://transcript` through the app bridge, for hosts that don't pass their own. Without a page (the Node unit
 * harness has no `location`) there is no bridge to load, so nothing is subscribed. */
function subscribeClosedTranscripts(callback: (event: VoiceClosedTranscript) => void): Promise<() => void> {
  if (typeof window === 'undefined' || !('location' in window)) return Promise.resolve(() => {});
  return import('./bridge').then(bridge => bridge.subscribe('voice://transcript', callback));
}
export { ownsVoiceResult, voiceEventPhase, voiceConfigurationCancels, voiceCancelArgs } from './voice-capture.ts';
export { voiceActions, voiceButtonHtml, type VoiceAction } from './voice-pill.ts';

export function voiceInsertion(value: string, start: number, end: number, transcript: string) {
  const words = transcript.trim();
  if (!words) return { text: '', value, caret: start };
  const leading = start && !/\s$/.test(value.slice(0, start)) ? ' ' : '';
  const trailing = end < value.length && !/^\s/.test(value.slice(end)) ? ' ' : '';
  const text = `${leading}${words}${trailing}`;
  return { text, value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}
/** Context needed on either side of the caret before a partial match counts as the same place. */
const ANCHOR_CONTEXT = 8;
/** Where the saved caret is after edits: both sides of it must still be there, or the edit lay wholly before or
 * after it. Short or ambiguous context returns null, which sends the transcript to review. */
export function voiceInsertionRange(anchor: VoiceAnchor, draft: string, edited = false) {
  if (!edited && anchor.draft === draft) return { start: anchor.start, end: anchor.end };
  const { before, after } = anchor, selected = anchor.draft.slice(anchor.start, anchor.end), whole = before + selected + after;
  if (!whole) return null;
  const places = new Map<number, number>(), place = (start: number, length = selected.length) => places.set(start, start + length);
  if (draft.startsWith(whole)) place(before.length);
  if (draft.endsWith(whole)) place(draft.length - after.length - selected.length);
  // Both sides intact with new text typed between them (over the selection, if any): the place is where typing began.
  if (!places.size && draft !== whole && draft.length >= before.length + after.length
    && draft.startsWith(before) && draft.endsWith(after) && (before || after)) place(before.length, 0);
  if (!places.size) {
    const head = before.slice(-ANCHOR_CONTEXT), tail = selected + after.slice(0, ANCHOR_CONTEXT);
    if (head.length + tail.length - selected.length < ANCHOR_CONTEXT) return null;
    for (let at = draft.indexOf(head); at >= 0; at = draft.indexOf(head, at + 1)) {
      if (draft.startsWith(tail, at + head.length)) place(at + head.length);
      if (at >= draft.length) break;
    }
  }
  if (places.size !== 1) return null;
  const [[start, end]] = places;
  return { start, end };
}
interface Host extends VoiceNativeHost {
  isImeKey(event: KeyboardEvent): boolean;
  describePrompt?(): string;
  threadTitle?(id: string): string;
  showThread?(id: string): void;
  enter(element: HTMLElement): void;
  leave?(element: HTMLElement): Promise<void>;
}
class VoiceDictation {
  private prompt: HTMLTextAreaElement | null = null;
  private composing = false;
  private revision = 0;
  /** Pending sends per thread, by the order they began; a transcript is held only for sends that began after its anchor. */
  private sends = new Map<string, readonly number[]>();
  private sendSerial = 0;
  private selectionNeedsReview = false;
  private lockedPrompt: {
    element: HTMLTextAreaElement; readOnly: boolean; draft: string;
    start: number; end: number; direction: 'forward' | 'backward' | 'none';
  } | null = null;
  private popoverSelector: string | undefined;
  private captures: VoiceCaptures;
  private pill;
  private wave;
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    this.wave = createVoiceWaveCanvas(() => this.captures?.value?.level ?? 0);
    this.pill = createVoicePill(host);
    this.captures = new VoiceCaptures({
      ...host, subscribeTranscript: host.subscribeTranscript ?? subscribeClosedTranscripts,
      sendPending: (id, since) => this.sendPending(id, since), snapshot: () => this.snapshot(), changed: () => this.paint(),
      received: c => this.insert(c), configurationChanged: () => void this.refreshPreferences(),
    });
    document.addEventListener('selectionchange', () => this.restoreSelection());
    bindVoiceDictationKeys({
      prompt: () => this.prompt, phase: () => this.visible() ? this.captures.value?.phase : undefined,
      pill: this.pill.element, isImeKey: host.isImeKey, foreground: () => this.foreground(),
      action: name => this.action(name), start: () => this.start(), stop: () => this.stop(),
      cancel: () => this.action('cancel'),
      hint: text => this.pill.hint(text ?? 'Transcription is still running. Type a message to send.'),
      shortcutMode: () => this.shortcutMode, release: () => this.releaseHold(),
    });
    void this.refreshPreferences();
  }
  /** Saved preferences: the shortcut mode, and the Settings → Voice step missing before dictation can start. */
  private shortcutMode: VoiceShortcutMode = 'auto';
  private setup: string | null = null;
  private preferenceReads = 0;
  private stopOnRecording = false;
  async refreshPreferences() {
    const read = ++this.preferenceReads;
    try {
      const { prefs, setup } = await readVoiceSetup(this.host);
      if (read !== this.preferenceReads) return;
      this.shortcutMode = prefs?.shortcutMode ?? 'auto';
      this.setup = setup;
      this.pill.setSetup(this.setup);
    } catch (reason) { logVoiceFailure({ operation: 'preference refresh' }, reason); }
  }
  /** Hold (and a long Auto press) stops on release; a release during startup stops once recording begins. */
  private releaseHold() {
    const phase = this.visible() ? this.captures.value?.phase : undefined;
    if (phase === 'recording') void this.stop();
    else if (phase === 'starting') this.stopOnRecording = true;
  }
  private visible() { return Boolean(this.captures.value && this.captures.value.threadId === this.host.thread()); }
  private locked() {
    const phase = this.visible() ? this.captures.value?.phase : undefined;
    return phase === 'starting' || phase === 'recording';
  }
  private foreground() {
    if (!this.popoverSelector) {
      try { document.querySelector(':popover-open'); this.popoverSelector = '[popover]:popover-open'; }
      catch { this.popoverSelector = '[popover]'; }
    }
    const overlay = document.querySelector('.workspace.settings-open, dialog[open], .floating-menu:not([hidden])');
    const popover = [...document.querySelectorAll(this.popoverSelector)].some(el => el.getClientRects().length);
    return Boolean(this.prompt?.isConnected && this.prompt.getClientRects().length
      && !this.prompt.closest('[inert]') && !overlay && !popover);
  }
  private restoreSelection() {
    if (!this.lockedPrompt) return;
    const lock = this.lockedPrompt, { element } = lock;
    if (lock.draft !== element.value) {
      if (lock.draft && element.value.endsWith(lock.draft)) {
        const offset = element.value.length - lock.draft.length;
        lock.start += offset; lock.end += offset;
      } else {
        const range = voiceInsertionRange({
          draft: lock.draft, start: lock.start, end: lock.end,
          before: lock.draft.slice(0, lock.start), after: lock.draft.slice(lock.end),
        }, element.value, true);
        if (range) { lock.start = range.start; lock.end = range.end; }
        else this.selectionNeedsReview = true;
      }
      lock.draft = element.value;
    }
    if (this.selectionNeedsReview) return;
    const { start, end, direction } = lock;
    const first = Math.min(start, element.value.length), last = Math.min(end, element.value.length);
    if (element.selectionStart !== first || element.selectionEnd !== last || element.selectionDirection !== direction) {
      element.setSelectionRange(first, last, direction);
    }
  }
  private unlock() {
    if (!this.lockedPrompt) return;
    this.restoreSelection();
    const { element, readOnly } = this.lockedPrompt;
    this.lockedPrompt = null; element.readOnly = readOnly;
    element.setAttribute('aria-description', this.host.describePrompt?.() ?? 'Enter to send. Shift Enter for a new line.');
  }
  private syncPrompt() {
    const locked = this.locked(), recording = this.visible() && this.captures.value?.phase === 'recording';
    if (locked && this.prompt && !this.lockedPrompt) {
      this.selectionNeedsReview = false;
      this.lockedPrompt = {
        element: this.prompt, readOnly: this.prompt.readOnly, draft: this.prompt.value,
        start: this.prompt.selectionStart,
        end: this.prompt.selectionEnd, direction: this.prompt.selectionDirection,
      };
      this.prompt.readOnly = true;
    } else if (!locked) this.unlock();
    if (locked && this.prompt) {
      const text = recording ? 'Dictation recording. Enter stops and transcribes. Escape cancels dictation.'
        : 'Starting microphone. Enter does not send. Escape cancels dictation.';
      this.prompt.setAttribute('aria-description', text);
    }
    // Once dictation has run in this composer its prompt fades in and out; redraws start without it.
    if (this.visible()) this.prompt?.closest('form')?.setAttribute('data-voice-used', '');
    const showingWave = Boolean(recording && this.wave.available);
    this.prompt?.closest('form')?.toggleAttribute('data-voice-recording', showingWave);
    this.prompt?.closest('form')?.toggleAttribute('data-voice-locked', locked);
    if (showingWave) this.wave.start(); else this.wave.stop();
  }
  private paint() {
    const phase = this.visible() ? this.captures.value?.phase : undefined;
    if (phase !== 'starting' && phase !== 'recording') this.stopOnRecording = false;
    else if (phase === 'recording' && this.stopOnRecording) { this.stopOnRecording = false; queueMicrotask(() => void this.stop()); }
    this.syncPrompt();
    const visible = this.visible();
    this.pill.paint(visible ? this.captures.value : null, this.prompt, Boolean(this.captures.value && !visible));
    this.syncComposerFocus(visible);
  }
  /** The form takes focus (Enter/Space stop from it) only while dictation or its card owns the composer. */
  private syncComposerFocus(visible: boolean) {
    const composer = this.prompt?.closest('form'); if (!composer) return;
    const card = this.pill.element;
    if (visible || (!card.hidden && !card.hasAttribute('data-voice-leaving'))) { composer.tabIndex = -1; return; }
    if (!composer.hasAttribute('tabindex')) return;
    if (document.activeElement === composer) this.prompt?.focus({ preventScroll: true });
    composer.removeAttribute('tabindex');
  }
  private snapshot() {
    this.restoreSelection();
    const draft = this.prompt?.value ?? '', start = this.prompt?.selectionStart ?? 0, end = this.prompt?.selectionEnd ?? start;
    const anchor = { draft, start, end, before: draft.slice(0, start), after: draft.slice(end) };
    return { anchor, revision: this.revision, send: this.sendSerial };
  }
  private applyInsertion(c: VoiceCapture, range: { start: number; end: number }, explicit: boolean) {
    const prompt = this.prompt; if (!prompt) return;
    const { start, end } = range, insertion = voiceInsertion(prompt.value, start, end, c.transcript ?? '');
    const selection = { start: prompt.selectionStart, end: prompt.selectionEnd, direction: prompt.selectionDirection };
    const preserveSelection = !explicit && (selection.start !== start || selection.end !== end);
    const focused = document.activeElement as HTMLElement | null, composer = prompt.closest('form');
    const outside = focused?.isConnected && !composer?.contains(focused) && !this.pill.element.contains(focused);
    this.captures.consume(c); prompt.focus({ preventScroll: true }); prompt.setSelectionRange(start, end);
    // Native insertText keeps undo, but only writes into the focused element; a prompt that could not take focus
    // (mid-redraw after a thread switch) gets the text directly instead of silently losing it.
    const original = prompt.value;
    const native = insertion.text && document.activeElement === prompt && document.execCommand?.('insertText', false, insertion.text);
    if (insertion.text && (!native || prompt.value === original)) {
      prompt.setRangeText(insertion.text, start, end, 'end'); prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (preserveSelection) {
      const delta = insertion.text.length - (end - start);
      const shifted = (at: number) => {
        if (at >= end) return at + delta;
        if (at <= start) return at;
        return start + insertion.text.length;
      };
      prompt.setSelectionRange(shifted(selection.start), shifted(selection.end), selection.direction);
    }
    (outside || (!explicit && focused?.isConnected) ? focused : prompt)?.focus({ preventScroll: true });
    this.host.announce('Dictation inserted. Message has not been sent.');
  }
  private insert(c: VoiceCapture, explicit = false) {
    const prompt = this.prompt;
    if (!this.captures.owns(c)) return;
    if (!this.visible() || !prompt || (!explicit && (c.detached || c.reviewRequired))) { this.captures.review(c); return; }
    if (!explicit && this.selectionNeedsReview) { this.captures.review(c, 'Draft changed. Transcript ready to insert.'); return; }
    if (prompt.disabled) { this.captures.review(c, 'Transcript ready. Restore your draft to insert.'); return; }
    if (this.composing) { this.captures.review(c, 'Finish composing, then choose Insert at cursor.'); return; }
    if (!explicit && !this.foreground()) { this.captures.review(c, 'Transcript ready. Return to your draft to insert.'); return; }
    // Its draft was sent and every send settled: an empty composer takes it at the caret; other text needs review.
    const afterSend = !explicit && c.sentAway && !c.anchor;
    if (afterSend && prompt.value) { this.captures.review(c); return; }
    const range = explicit || afterSend ? { start: prompt.selectionStart, end: prompt.selectionEnd }
      : c.anchor && voiceInsertionRange(c.anchor, prompt.value, this.revision !== c.anchorRevision);
    if (!range) { this.captures.review(c, prompt.value ? 'Draft changed. Transcript ready to insert.' : undefined); return; }
    this.applyInsertion(c, range, explicit);
  }
  private async start() {
    this.captures.discardEmptyError();
    const current = this.captures.value;
    if (current) {
      if (!this.visible()) {
        const title = this.host.threadTitle?.(current.threadId) ?? 'Original thread';
        this.pill.hint(`Dictation is waiting in “${title}”.`, Boolean(this.host.showThread));
        return;
      }
      if (current.phase === 'recording') await this.stop();
      else this.pill.element.focus({ preventScroll: true });
      return;
    }
    if (!this.prompt || this.prompt.disabled || !this.host.thread()) return;
    // Voice off, or no usable model or service: say what is missing and open Settings → Voice instead of failing.
    if (this.setup) await this.refreshPreferences();
    if (this.setup) { this.host.announce(this.setup); this.host.settings(); return; }
    if (this.captures.value) return;
    this.wave.clear(); const pending = this.captures.start();
    this.prompt.focus({ preventScroll: true }); await pending;
  }
  private async stop(retry = false) {
    const pending = this.captures.finish(retry);
    if (this.visible() && this.prompt && !this.prompt.disabled) this.prompt.focus({ preventScroll: true });
    await pending;
  }
  private action(name: string) {
    if (name === 'toggle') void this.start();
    if (name === 'stop') void this.stop();
    if (name === 'retry') void this.stop(true);
    if (name === 'record') { this.invalidate('Previous dictation discarded.'); void this.start(); }
    if (name === 'cancel') { this.invalidate(); this.prompt?.focus({ preventScroll: true }); }
    if (name === 'insert' && this.captures.value) this.insert(this.captures.value, true);
    if (name === 'settings') this.host.settings();
    if (name === 'origin' && this.captures.value) this.host.showThread?.(this.captures.value.threadId);
  }
  private bindInput(next: HTMLTextAreaElement | null) {
    if (next === this.prompt) return;
    this.captures.detach(); this.unlock(); this.prompt = next; this.composing = false;
    if (!next) return;
    next.addEventListener('pointerdown', event => { if (this.lockedPrompt?.element === next) event.preventDefault(); });
    next.addEventListener('focus', () => this.restoreSelection());
    next.addEventListener('input', () => { this.revision++; if (!next.value) this.draftCleared(); });
    next.addEventListener('compositionstart', () => { this.composing = true; });
    next.addEventListener('compositionend', () => { this.composing = false; });
  }
  bind(next: HTMLTextAreaElement | null) {
    if (this.captures.value && this.host.thread() !== this.captures.value.threadId) this.captures.detach();
    this.bindInput(next); this.wave.bind(next);
    const c = this.captures.value;
    if (c?.detached && next && this.ownedBy(next, c.threadId)) this.returnTo(c);
    else if (this.returning) this.insertOnReturn();
    this.paint();
  }
  /** Back in the origin thread: speech held for review only because it was away inserts at its saved place once the
   * draft is usable again (the thread may still be loading); otherwise it stays in review with the caret there. */
  private returning: string | null = null;
  private returnTo(c: VoiceCapture) {
    const back = this.captures.reattach(c);
    if (!back || back.phase !== 'review' || !back.transcript?.trim() || !back.anchor) return;
    this.returning = back.requestId; this.insertOnReturn();
  }
  /** A redraw can rebind the outgoing textarea after the thread already switched; only the origin's own draft counts. */
  private ownedBy(prompt: HTMLTextAreaElement, threadId: string) {
    return this.host.thread() === threadId && (prompt.dataset.sessionId ?? threadId) === threadId;
  }
  private insertOnReturn() {
    const c = this.captures.value, prompt = this.prompt;
    if (!c || c.requestId !== this.returning || c.phase !== 'review' || !c.anchor || !prompt) { this.returning = null; return; }
    if (!this.ownedBy(prompt, c.threadId)) return;
    const range = voiceInsertionRange(c.anchor, prompt.value, this.revision !== c.anchorRevision);
    if (!range) { this.returning = null; return; }
    if (prompt.disabled || !this.foreground()) { prompt.setSelectionRange(range.start, range.end); return; }
    this.returning = null; this.insert(c);
  }
  detach() { this.captures.detach(); }
  invalidate(message?: string) { this.captures.invalidate(message); }
  discardThreads(ids: readonly string[]) { this.captures.discardThreads(ids); }
  ownsThread(id: string) { return this.captures.value?.threadId === id; }
  draftCleared(threadId = this.host.thread(), sent = false) {
    const c = this.captures.value;
    if (c && c.threadId === threadId) this.captures.forgetAnchor(c, sent);
  }
  prepareSubmit() {
    if (!this.locked()) return true;
    this.pill.hint('Stop dictation to send'); return false;
  }
  private sendPending(id: string, since = 0) {
    return (this.sends.get(id) ?? []).some(serial => serial > since);
  }
  beginSubmit(id = this.host.thread()) {
    if (!this.prepareSubmit()) return null;
    const serial = ++this.sendSerial;
    if (id) this.sends.set(id, [...this.sends.get(id) ?? [], serial]);
    this.draftCleared(id, true); this.pill.clearHint();
    return () => this.submitSettled(id, serial);
  }
  /** Settles the send `serial` (or the oldest pending one) and reviews a transcript nothing still holds. */
  submitSettled(id = this.host.thread(), serial?: number) {
    if (!id) return;
    const pending = this.sends.get(id) ?? [], settled = serial ?? pending[0];
    if (!pending.includes(settled!)) return;
    const rest = pending.filter(item => item !== settled);
    if (rest.length) this.sends.set(id, rest); else this.sends.delete(id);
    const c = this.captures.value;
    if (c?.threadId === id && c.phase === 'transcribing' && c.transcript !== undefined && !this.sendPending(id, c.anchorSend)) {
      this.captures.review(c, c.transcript.trim() ? undefined : 'No speech detected. Try recording again.');
    }
  }
  async submit(action: () => Promise<void>) {
    const finish = this.beginSubmit();
    if (!finish) return;
    try { await action(); } finally { finish(); }
  }
}
export function createVoiceDictation(host: Host) { return new VoiceDictation(host); }
