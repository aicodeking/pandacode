import { captureView, paintCopy, paintTime, recoveryPhase, voiceAnnouncement, type CaptureView } from './voice-pill-copy.ts';
import { createVoicePillPlacement } from './voice-pill-placement.ts';
import { isMac } from './platform.ts';

export type Phase = 'starting' | 'recording' | 'transcribing' | 'error' | 'review';
export interface VoicePillCapture {
  requestId?: string; phase: Phase; captureId: string; transcript?: string; message?: string;
  retryable?: boolean; attempted?: boolean; elapsedMs: number; level: number;
  source?: string; maxSeconds?: number; zeroSince?: number;
  /** Transcribed by a built-in model on this device; `source` is the model name. */
  local?: boolean;
}
interface PillHost {
  enter(element: HTMLElement): void;
  leave?(element: HTMLElement): Promise<void>;
  announce(text: string): void;
}
const HINT_MS = 3000;

export type VoiceAction = 'stop' | 'retry' | 'record' | 'settings' | 'insert' | 'cancel';
/** Retry resends the retained audio with its original profile; Record again discards it and uses current Settings. */
export function voiceActions(phase: Phase, c: { captureId: string; transcript?: string; retryable?: boolean }): VoiceAction[] {
  if (phase === 'recording') return ['stop', 'cancel'];
  if (phase === 'error') return c.captureId && c.retryable !== false ? ['retry', 'record', 'settings', 'cancel'] : ['record', 'settings', 'cancel'];
  if (phase === 'review') return c.transcript?.trim() ? ['insert', 'cancel'] : ['record', 'cancel'];
  return ['cancel'];
}
const ACTION_LABELS: Record<VoiceAction, [text: string, aria: string]> = {
  stop: ['Stop', 'Stop and transcribe'], retry: ['Retry', 'Retry original recording'], record: ['Record again', 'Discard and record again'],
  settings: ['Settings', 'Open voice input settings'], insert: ['Insert at cursor', 'Insert transcript at cursor'], cancel: ['Cancel', 'Cancel dictation'],
};

const MIC = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
const STOP = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const BUSY_UPDATE_MS = 1000;
const LIMIT_WARNING_SECONDS = 10;
/** The dictation shortcut as this platform writes it (both chords work; the tooltip names the native one). */
const SHORTCUT = isMac ? '⌘⇧D' : 'Ctrl⇧D';
export const voiceButtonHtml = `<button type="button" class="icon-button voice-mic" data-voice="toggle" aria-label="Start dictation" aria-keyshortcuts="Meta+Shift+D Control+Shift+D" data-tip="Start dictation · ${SHORTCUT}">${MIC}</button>`;


function createPillElements() {
  const pill = document.createElement('div');
  pill.className = 'voice-pill'; pill.tabIndex = -1; pill.hidden = true;
  pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Voice dictation');
  const dot = document.createElement('span'); dot.className = 'voice-dot'; dot.setAttribute('aria-hidden', 'true');
  const details = document.createElement('span'); details.className = 'voice-details'; details.tabIndex = -1;
  const label = document.createElement('span'); label.className = 'voice-label';
  const context = document.createElement('span'); context.className = 'voice-context'; context.tabIndex = -1;
  const transcript = document.createElement('span'); transcript.className = 'voice-transcript'; transcript.hidden = true;
  details.append(label, context, transcript);
  const meter = document.createElement('meter'); meter.min = 0; meter.max = 1;
  meter.setAttribute('aria-label', 'Microphone input level');
  const clock = document.createElement('span'); clock.className = 'voice-clock';
  clock.setAttribute('role', 'timer'); clock.setAttribute('aria-live', 'off');
  const actions = document.createElement('span'); actions.className = 'voice-controls';
  pill.append(dot, details, clock, meter, actions);
  return { pill, dot, details, label, context, transcript, meter, clock, actions };
}
class VoicePill {
  private elements = createPillElements();
  readonly element = this.elements.pill;
  private capture: VoicePillCapture | null = null;
  private prompt: HTMLTextAreaElement | null = null;
  private hintUntil = 0; private hintText = ''; private hintOrigin = false; private elsewhere = false;
  private hintHovered = false;
  private hintTimer: number | undefined; private busyTimer: number | undefined;
  private limitAnnouncedFor = ''; private paintedPhase = ''; private paintedActions = ''; private paintedStatus = '';
  private phaseStartedAt = 0; private surfaceVersion = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private host: PillHost;
  private placement: ReturnType<typeof createVoicePillPlacement>;
  constructor(host: PillHost) {
    this.host = host;
    this.placement = createVoicePillPlacement(this.element, this.elements.details);
    this.element.addEventListener('pointerenter', () => { this.hintHovered = true; this.refreshHintTimeout(); });
    this.element.addEventListener('pointerleave', () => { this.hintHovered = false; this.refreshHintTimeout(); });
    this.element.addEventListener('focusin', this.refreshHintTimeout);
    this.element.addEventListener('focusout', () => queueMicrotask(this.refreshHintTimeout));
  }
  private setLeaving = (leaving: boolean) => {
    this.element.inert = leaving;
    this.element.toggleAttribute('data-voice-leaving', leaving);
    if (leaving) this.element.setAttribute('aria-hidden', 'true'); else this.element.removeAttribute('aria-hidden');
    for (const button of this.elements.actions.children) (button as HTMLButtonElement).disabled = leaving;
  };
  private hidePill = (changed: boolean) => {
    this.paintedPhase = ''; this.paintedActions = ''; this.paintedStatus = '';
    if (!changed) return;
    if (this.element.contains(document.activeElement)) this.prompt?.focus({ preventScroll: true });
    this.setLeaving(true);
    if (!this.element.hidden && this.host.leave) {
      const version = this.surfaceVersion;
      void this.host.leave(this.element).then(() => {
        if (!this.capture && version === this.surfaceVersion) {
          this.element.hidden = true; this.placement.refresh();
        }
      });
    } else this.element.hidden = true;
  };
  private announceCapture = (c: VoicePillCapture, view: CaptureView) => {
    const status = voiceAnnouncement(c, view);
    if (this.paintedStatus !== status) { this.paintedStatus = status; this.announce(status); }
  };
  private announce = (text: string) => { this.host.announce(text); };
  private paintMic = (c: VoicePillCapture | null) => {
    let text = 'Start dictation';
    if (c) text = 'Show dictation status';
    if (c?.phase === 'recording') text = 'Stop dictation';
    if (this.elsewhere) text = 'Dictation pending in another thread';
    // Nothing to dictate with yet: the mic still works (it opens Settings → Voice), so it is never aria-disabled;
    // its label says Set up dictation and its tooltip names the missing step.
    const setup = !c && !this.elsewhere && this.setup;
    if (setup) text = 'Set up dictation';
    const tip = setup ? `${text} · ${setup}` : `${text} · ${SHORTCUT}`, pressed = String(c?.phase === 'recording');
    // Only buttons whose label or state differ are written; a fresh composer's mic gets its full set once.
    // One tooltip: `data-tip` (the app's own) plus aria-label, never a native `title` that would show a second one.
    document.querySelectorAll<HTMLElement>('.voice-mic').forEach(button => {
      if (button.getAttribute('data-tip') === tip && button.getAttribute('aria-label') === text
        && button.getAttribute('aria-pressed') === pressed && !button.hasAttribute('title') && !button.hasAttribute('aria-disabled')) return;
      button.setAttribute('aria-label', text); button.setAttribute('data-tip', tip);
      button.removeAttribute('title'); button.removeAttribute('aria-disabled'); button.setAttribute('aria-pressed', pressed);
    });
  };
  private setup: string | null = null;
  setSetup = (text: string | null) => { if (this.setup !== text) { this.setup = text; this.render(); } };
  private beginPhase = (c: VoicePillCapture | null, composer: HTMLFormElement | null, wasActive: boolean) => {
    this.surfaceVersion++; this.phaseStartedAt = Date.now();
    if (c) this.hintUntil = 0;
    window.clearInterval(this.busyTimer); this.busyTimer = undefined;
    if (c?.phase === 'starting' || c?.phase === 'transcribing') {
      this.busyTimer = window.setInterval(this.render, BUSY_UPDATE_MS);
    }
    if (wasActive && !composer?.hasAttribute('data-voice-active')) {
      const tray = composer?.querySelector<HTMLElement>('.composer-tray');
      if (tray) this.host.enter(tray);
    }
  };
  private showPill = (c: VoicePillCapture, recovery: boolean) => {
    const entering = this.elements.pill.hidden;
    const relocating = !entering && this.elements.pill.hasAttribute('data-recovery') !== recovery;
    this.elements.pill.hidden = false; this.setLeaving(false);
    if (entering) this.host.enter(this.elements.pill);
    this.elements.pill.toggleAttribute('data-recovery', recovery);
    if (relocating && !this.reducedMotion.matches) this.host.enter(this.elements.pill);
    this.elements.pill.setAttribute('aria-busy', String(c.phase === 'starting' || c.phase === 'transcribing'));
    this.elements.pill.dataset.phase = c.phase;
    return { entering, relocating };
  };
  private announceLimit = (c: VoicePillCapture) => {
    if (c.phase !== 'recording' || !c.maxSeconds) return;
    const identity = c.requestId || c.captureId;
    if (this.limitAnnouncedFor === identity) return;
    if (c.elapsedMs < (c.maxSeconds - LIMIT_WARNING_SECONDS) * 1000) return;
    this.limitAnnouncedFor = identity;
    const remaining = Math.max(0, Math.ceil(c.maxSeconds - c.elapsedMs / 1000));
    this.announce(`${remaining} seconds until the recording limit. Stop to transcribe.`);
  };
  private actionLabels = (c: VoicePillCapture, action: VoiceAction): [string, string] => {
    if (action === 'cancel' && recoveryPhase(c)) return ['Discard', 'Discard dictation'];
    if (action === 'retry' && !c.attempted) return ['Transcribe recording', 'Transcribe recording'];
    return ACTION_LABELS[action];
  };
  private paintActions = (c: VoicePillCapture, composer: HTMLFormElement | null, entering: boolean, relocating: boolean) => {
    const key = `${c.phase}:${c.retryable}:${c.attempted}`;
    if (this.paintedActions === key) return;
    const focused = document.activeElement === this.elements.pill || this.elements.actions.contains(document.activeElement)
      || (composer?.contains(document.activeElement) && (document.activeElement as HTMLElement)?.dataset.voice === 'toggle');
    this.elements.actions.replaceChildren();
    voiceActions(c.phase, c).forEach((action, index) => {
      const [name, aria] = this.actionLabels(c, action);
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.voice = action; button.setAttribute('aria-label', aria);
      button.className = 'voice-control';
      if (index === 0 && action !== 'cancel') button.className += ' voice-control-primary';
      if (action === 'stop') button.innerHTML = STOP;
      button.append(name); this.elements.actions.append(button);
    });
    if (this.paintedActions && !entering && !relocating && !this.reducedMotion.matches) this.host.enter(this.elements.actions);
    this.paintedActions = key;
    if (focused) {
      let target: HTMLElement = this.elements.pill;
      if (['starting', 'recording', 'transcribing'].includes(c.phase) && this.prompt && !this.prompt.disabled) target = this.prompt;
      target.focus({ preventScroll: true });
    }
  };
  private render = () => {
    const c = this.capture, hinting = this.elsewhere && !c && Date.now() < this.hintUntil;
    const phase = c?.phase ?? (hinting ? 'hint' : ''), changed = this.paintedPhase !== phase;
    const composer = this.prompt?.closest('form') ?? null;
    const wasActive = Boolean(composer?.hasAttribute('data-voice-active'));
    const recovery = Boolean(c && recoveryPhase(c));
    composer?.toggleAttribute('data-voice-active', c?.phase === 'starting' || c?.phase === 'recording');
    this.paintMic(c);
    if (changed) this.beginPhase(c, composer, wasActive);
    if (!c) {
      if (hinting) this.paintHint(); else this.hidePill(changed);
      this.paintedPhase = phase;
      this.placement.paint(this.prompt, hinting, false); return;
    }
    this.elements.pill.removeAttribute('data-hint');
    this.elements.dot.hidden = this.elements.context.hidden = this.elements.actions.hidden = false;
    const { entering, relocating } = this.showPill(c, recovery);
    const view = captureView(c, this.phaseStartedAt, this.hintUntil, this.hintText);
    paintCopy(this.elements, c, view); paintTime(this.elements, c, view.waiting); this.announceLimit(c);
    this.paintActions(c, composer, entering, relocating);
    this.paintedPhase = phase;
    this.announceCapture(c, view);
    this.placement.paint(this.prompt, true, recovery);
  };
  private paintHint = () => {
    this.elements.pill.hidden = false; this.setLeaving(false); this.elements.pill.dataset.phase = 'hint';
    this.elements.pill.setAttribute('data-hint', ''); this.elements.pill.removeAttribute('data-recovery');
    this.elements.pill.setAttribute('aria-busy', 'false'); this.elements.pill.removeAttribute('aria-description');
    this.elements.label.textContent = this.hintText;
    for (const element of [this.elements.dot, this.elements.context, this.elements.transcript, this.elements.clock, this.elements.meter]) {
      element.hidden = true;
    }
    this.elements.actions.hidden = !this.hintOrigin;
    if (this.hintOrigin && this.elements.actions.firstElementChild?.getAttribute('data-voice') !== 'origin') {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'voice-control'; button.dataset.voice = 'origin';
      button.textContent = 'Go to thread'; this.elements.actions.replaceChildren(button); this.paintedActions = '';
    }
  };
  hint = (text: string, origin = false) => {
    window.clearTimeout(this.hintTimer);
    this.hintText = text; this.hintOrigin = origin; this.hintUntil = Date.now() + HINT_MS;
    this.render(); if (this.paintedStatus !== text) this.announce(text);
    if (!this.capture && this.elsewhere) {
      this.host.enter(this.elements.pill);
    }
    this.scheduleHintTimeout();
  };
  /** A committed send answers any send hint, so it goes at once instead of waiting out its timeout. */
  clearHint = () => {
    if (!this.hintUntil) return;
    window.clearTimeout(this.hintTimer); this.hintTimer = undefined; this.hintUntil = 0; this.hintHovered = false;
    this.render();
  };
  private refreshHintTimeout = () => {
    if (this.hintOrigin && this.elsewhere && !this.capture && this.hintUntil) this.scheduleHintTimeout();
  };
  private scheduleHintTimeout = () => {
    window.clearTimeout(this.hintTimer); this.hintTimer = undefined;
    if (this.hintOrigin && (this.hintHovered || this.element.contains(document.activeElement))) {
      this.hintUntil = Infinity; return;
    }
    this.hintUntil = Date.now() + HINT_MS;
    this.hintTimer = window.setTimeout(() => {
      this.hintUntil = 0; this.hintTimer = undefined; this.render();
    }, HINT_MS);
  };
  paint = (next: VoicePillCapture | null, field: HTMLTextAreaElement | null, pendingElsewhere = false) => {
    if (this.elsewhere !== pendingElsewhere || (!next && !pendingElsewhere)) {
      window.clearTimeout(this.hintTimer); this.hintTimer = undefined; this.hintUntil = 0; this.hintHovered = false;
    }
    this.elsewhere = pendingElsewhere; this.capture = next; this.prompt = field; this.render();
  };
}
export function createVoicePill(host: PillHost) {
  const view = new VoicePill(host);
  return { element: view.element, paint: view.paint, hint: view.hint, clearHint: view.clearHint, setSetup: view.setSetup };
}
