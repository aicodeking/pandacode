import type { Phase } from './voice-pill.ts';
import type { VoiceShortcutMode } from './voice-types';

/** Auto mode: a press shorter than this toggles; holding at least this long stops on release. */
export const HOLD_THRESHOLD_MS = 300;

export interface VoiceKeys {
  prompt(): HTMLTextAreaElement | null;
  phase(): Phase | undefined;
  pill: HTMLElement;
  isImeKey(event: KeyboardEvent): boolean;
  foreground(): boolean;
  action(name: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  hint(text?: string): void;
  /** Toggle: press starts/stops. Hold: release stops. Auto: press toggles, a hold of HOLD_THRESHOLD_MS stops on release. */
  shortcutMode?(): VoiceShortcutMode;
  /** The shortcut was released after it started dictation (Hold, or a long Auto press). */
  release?(): void;
}
export class VoiceKeyActions {
  private enterHeld = false;
  /** The dictation shortcut is down: when it was pressed, and whether that press started a capture. */
  private held: { at: number; started: boolean } | null = null;
  private host: VoiceKeys;
  constructor(host: VoiceKeys) { this.host = host; }
  private locked = () => this.host.phase() === 'starting' || this.host.phase() === 'recording';
  private inside = () => Boolean(this.host.prompt()?.closest('form')?.contains(document.activeElement)
    || this.host.pill.contains(document.activeElement));
  private consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
  /** Focus dropped to BODY (an overlay closed) while no overlay is open still belongs to the locked draft. */
  private stray = () => (!document.activeElement || document.activeElement === document.body) && this.host.foreground();
  private stopSurface = () => {
    const target = document.activeElement as HTMLElement | null, prompt = this.host.prompt();
    if (target === prompt || target === prompt?.closest('form') || this.stray()) return true;
    return this.host.pill.contains(target) && !target?.closest(
      'button, input, textarea, select, a[href], [role="button"], [contenteditable], .voice-details',
    );
  };
  private enter = (event: KeyboardEvent) => {
    const target = document.activeElement as HTMLElement | null, prompt = this.host.prompt();
    if (this.enterHeld && event.repeat) { this.consume(event); return; }
    if (!event.repeat) this.enterHeld = false;
    if (target?.dataset.voice) {
      this.enterHeld = true; this.consume(event);
      if (!event.repeat) this.host.action(target.dataset.voice);
      return;
    }
    if (this.stopSurface() && this.locked()) {
      this.consume(event);
      if (this.host.phase() === 'recording') {
        this.enterHeld = true;
        if (!event.repeat) void this.host.stop();
      }
      return;
    }
    if (prompt && target === prompt && this.host.phase() === 'transcribing'
      && !prompt.value.trim() && !event.shiftKey) {
      this.consume(event); this.host.hint(); return;
    }

  };
  /** Escape cancels startup/recording and dismisses review; it never discards an error's retained audio, which only
   * Discard does, so there it just returns to the draft. */
  private escape = (event: KeyboardEvent) => {
    const phase = this.host.phase();
    if (!phase || phase === 'transcribing' || !this.host.foreground()) return;
    const target = document.activeElement, composer = this.host.prompt()?.closest('form');
    if (!this.host.pill.contains(target) && !(this.locked() && (composer?.contains(target) || this.stray()))) return;
    this.consume(event);
    if (phase === 'error') this.host.prompt()?.focus({ preventScroll: true }); else this.host.cancel();
  };
  private tab = (event: KeyboardEvent) => {
    const prompt = this.host.prompt(), composer = prompt?.closest('form');
    if (!prompt || !composer || !this.host.phase()) return;
    const buttons = [...this.host.pill.querySelectorAll<HTMLButtonElement>('button')];
    const details = this.host.pill.querySelector<HTMLElement>('.voice-details');
    const stops: HTMLElement[] = [...buttons];
    if (details?.tabIndex === 0) stops.push(details);
    const first = stops[0], last = stops.at(-1), target = document.activeElement;
    const external = !composer.contains(this.host.pill), attach = composer.querySelector<HTMLElement>('.composer-actions button');
    const index = stops.indexOf(target as HTMLElement);
    let next: HTMLElement | undefined | null;
    if (index >= 0 && !event.shiftKey && index < stops.length - 1) next = stops[index + 1];
    else if (index > 0 && event.shiftKey) next = stops[index - 1];
    else if (target === prompt && !event.shiftKey) next = first;
    else if (target === first && event.shiftKey) next = prompt;
    else if (target === last && !event.shiftKey) next = attach;
    else if (target === attach && event.shiftKey) next = last;
    else if (external && target === prompt && event.shiftKey) {
      const nodes = [...document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, [tabindex]')]
        .filter(el => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length
          && !el.closest('[inert]') && !this.host.pill.contains(el));
      next = nodes[nodes.indexOf(prompt) - 1];
    }
    if (next) { this.consume(event); next.focus({ preventScroll: true }); }
  };
  private scrollDetails = (event: KeyboardEvent) => {
    const details = this.host.pill.querySelector<HTMLElement>('.voice-details');
    if (!details || document.activeElement !== details || event.metaKey || event.ctrlKey || event.altKey) return false;
    const line = Number.parseFloat(getComputedStyle(details).lineHeight) || 16;
    const positions: Record<string, number> = {
      ArrowDown: details.scrollTop + line, ArrowUp: details.scrollTop - line,
      PageDown: details.scrollTop + details.clientHeight, PageUp: details.scrollTop - details.clientHeight,
      Home: 0, End: details.scrollHeight,
      ' ': details.scrollTop + (event.shiftKey ? -details.clientHeight : details.clientHeight),
    };
    const top = positions[event.key];
    if (top === undefined) return false;
    this.consume(event); details.scrollTop = top; return true;
  };
  keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || this.host.isImeKey(event)) return;
    if (event.key === 'Tab') { this.tab(event); return; }
    if (this.scrollDetails(event)) return;
    const active = document.activeElement as HTMLElement | null;
    const selects = /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key)
      || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a');
    if (this.locked() && active === this.host.prompt() && selects) { this.consume(event); return; }
    if (event.key === ' ' && this.locked() && this.stopSurface() && active !== this.host.prompt()) {
      this.consume(event); if (this.host.phase() === 'recording' && !event.repeat) void this.host.stop(); return;
    }
    if (event.key === 'Enter') { this.enter(event); return; }
    if (event.key === 'Escape') { this.escape(event); return; }
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'd') return;
    if (event.repeat) { if (this.held) this.consume(event); return; }
    if (!this.host.foreground()) return;
    const target = document.activeElement as HTMLElement | null, prompt = this.host.prompt();
    if ((this.locked() && (this.inside() || this.stray())) || target === prompt || this.host.pill.contains(target)
      || (prompt?.closest('form')?.contains(target) && target?.dataset.voice === 'toggle')) {
      this.consume(event);
      this.held = { at: event.timeStamp, started: !this.host.phase() };
      void this.host.start();
    }
  };
  /** Releasing the letter or a modifier ends the press (macOS drops the letter's keyup while ⌘ is down). */
  private releaseShortcut(event: KeyboardEvent) {
    const held = this.held;
    if (!held || !/^(d|D|Meta|Control|Shift)$/.test(event.key)) return;
    this.held = null;
    if (event.key.toLowerCase() === 'd') this.consume(event);
    const mode = this.host.shortcutMode?.() ?? 'auto';
    const long = event.timeStamp - held.at >= HOLD_THRESHOLD_MS;
    if (held.started && (mode === 'hold' || (mode === 'auto' && long))) this.host.release?.();
  }
  keyup = (event: KeyboardEvent) => {
    if (this.host.isImeKey(event)) return;
    if (event.key === 'Enter' && this.enterHeld) { this.enterHeld = false; this.consume(event); return; }
    this.releaseShortcut(event);
  };
  /** Losing the window loses the keyup too: a Hold press ends there. */
  blur = () => {
    this.enterHeld = false;
    const held = this.held; this.held = null;
    if (held?.started && this.host.shortcutMode?.() === 'hold') this.host.release?.();
  };
  submit = (event: Event) => {
    if (this.locked() && event.target === this.host.prompt()?.closest('form')) {
      event.preventDefault(); event.stopImmediatePropagation(); this.host.hint('Stop dictation to send');
    }
  };
  click = (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-voice]');
    if (button) { event.preventDefault(); this.host.action(button.dataset.voice!); }
  };
}
