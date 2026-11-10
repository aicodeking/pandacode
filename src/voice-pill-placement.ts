const FLOATING_CARD_WIDTH = 760;
const DOCK_GUTTER = 64;
const FLOATING_GAP = 8;
const VIEWPORT_MARGIN = 8;
const MIN_PROMPT_HEIGHT = 36;
/** Short windows still give a floating card this much room (when its content needs it) before its details scroll. */
const SHORT_WINDOW_CARD_FLOOR = 240;
const CARD_CAP_VIEWPORT_SHARE = 0.45;
const CARD_CAP_REM = 28;

class VoicePillPlacement {
  private area: HTMLElement | null = null;
  private composer: HTMLFormElement | null = null;
  private active = false;
  private recovery = false;
  private observing = false;
  private frame: number | undefined;
  private resize: ResizeObserver;
  private pill: HTMLElement;
  private details: HTMLElement;
  constructor(pill: HTMLElement, details: HTMLElement) {
    this.pill = pill; this.details = details;
    this.resize = new ResizeObserver(this.queue);
    window.addEventListener('resize', this.queue);
  }
  paint(prompt: HTMLTextAreaElement | null, active: boolean, recovery: boolean) {
    this.active = active; this.recovery = recovery;
    const composer = prompt?.closest('form') ?? null;
    if (composer !== this.composer) {
      this.clearCompactDraft();
      this.resize.disconnect(); this.observing = false; this.area?.removeAttribute('data-voice-surface'); this.area = null;
      this.composer = composer;
    }
    if (!active && this.frame !== undefined) { window.cancelAnimationFrame(this.frame); this.frame = undefined; }
    if (this.composer && !this.idle() && !this.observing) {
      this.resize.observe(this.composer); this.resize.observe(this.details); this.observing = true;
    }
    this.refresh();
  }
  /** No capture, no hint and the card hidden: nothing to place, measure or observe on a composer redraw. */
  private idle() { return !this.active && this.pill.hidden; }
  refresh = () => {
    if (this.idle()) { this.rest(); return; }
    this.position(); this.syncDetails();
  };
  private rest() {
    this.clearCompactDraft(); this.area?.removeAttribute('data-voice-surface');
    if (this.observing) { this.resize.disconnect(); this.observing = false; }
  }
  private syncDetails() {
    const scrolling = !this.pill.hidden && !this.pill.hasAttribute('data-voice-leaving')
      && this.pill.hasAttribute('data-floating') && this.details.scrollHeight > this.details.clientHeight;
    this.details.tabIndex = scrolling ? 0 : -1;
    if (scrolling) {
      this.details.setAttribute('role', 'region'); this.details.setAttribute('aria-label', 'Dictation details');
    } else {
      this.details.removeAttribute('role'); this.details.removeAttribute('aria-label');
    }
  }
  private inlineMount(composer: HTMLFormElement) {
    const input = composer.querySelector('.composer-input'), controls = composer.querySelector('.composer-actions');
    if (input && controls) {
      if (this.pill.parentElement !== input || this.pill.nextElementSibling !== controls) input.insertBefore(this.pill, controls);
    } else if (this.pill.parentElement !== composer) composer.append(this.pill);
  }
  private position() {
    const composer = this.composer;
    if (!composer) { this.pill.remove(); return; }
    const style = getComputedStyle(composer);
    const width = composer.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const narrow = width <= FLOATING_CARD_WIDTH;
    composer.toggleAttribute('data-voice-narrow', narrow);
    const area = composer.closest<HTMLElement>('.composer-area'); this.area = area;
    if (!area) { this.inlineMount(composer); return; }
    area.toggleAttribute('data-voice-surface', !this.pill.hidden);
    if (!this.active) { this.clearCompactDraft(); if (!this.pill.isConnected) this.inlineMount(composer); return; }
    const floating = this.recovery || this.pill.hasAttribute('data-hint') || narrow
      || !composer.hasAttribute('data-voice-active');
    this.pill.toggleAttribute('data-floating', floating);
    if (!floating) {
      this.clearCompactDraft();
      this.inlineMount(composer);
      this.pill.style.left = ''; this.pill.style.right = ''; this.pill.style.bottom = ''; this.pill.style.top = '';
      this.pill.style.removeProperty('--voice-available-height'); this.pill.style.removeProperty('--voice-card-cap'); return;
    }
    if (this.pill.parentElement !== area || this.pill.nextElementSibling !== composer) area.insertBefore(this.pill, composer);
    this.pill.style.left = `${composer.offsetLeft}px`;
    this.pill.style.right = `${Math.max(0, area.clientWidth - composer.offsetLeft - composer.offsetWidth)
      + (window.innerWidth > 650 ? DOCK_GUTTER : 0)}px`;
    this.fitAbove(composer, area);
  }
  private clearCompactDraft() {
    this.area?.removeAttribute('data-voice-compact');
    this.composer?.removeAttribute('data-voice-compact');
    this.composer?.style.removeProperty('--voice-prompt-height');
  }
  /** The card's height with its details holding `body` pixels: padding, border, row gap and the actions. */
  private cardHeight(body: number) {
    const style = getComputedStyle(this.pill), controls = this.pill.querySelector<HTMLElement>('.voice-controls');
    const chrome = ['paddingTop', 'paddingBottom', 'rowGap', 'borderTopWidth', 'borderBottomWidth'] as const;
    return Math.ceil(body + (controls?.offsetHeight ?? 28) + chrome.reduce((sum, name) => sum + (parseFloat(style[name]) || 0), 0));
  }
  /**
   * How tall the card wants to be: all of its details when they fit under the cap, else the cap (never under two lines).
   * The cap is the usual share of the window, but short windows keep a floor so a status or short review is never clipped.
   */
  private desiredCardHeight() {
    const line = parseFloat(getComputedStyle(this.details).lineHeight) || 18;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const cap = Math.max(Math.min(window.innerHeight * CARD_CAP_VIEWPORT_SHARE, CARD_CAP_REM * rem), SHORT_WINDOW_CARD_FLOOR);
    const minimum = this.cardHeight(2 * line), natural = this.cardHeight(this.details.scrollHeight);
    return { cap: Math.max(cap, minimum), wanted: Math.max(minimum, Math.min(natural, cap)) };
  }
  private fitAbove(composer: HTMLFormElement, area: HTMLElement) {
    this.clearCompactDraft();
    let anchor = composer.getBoundingClientRect();
    let available = anchor.top - FLOATING_GAP - VIEWPORT_MARGIN;
    const { cap, wanted } = this.desiredCardHeight(), prompt = composer.querySelector<HTMLTextAreaElement>('#prompt');
    this.pill.style.setProperty('--voice-card-cap', `${cap}px`);
    // Every floating card (live or recovery) shows its details unclipped when they fit the cap, and never fewer
    // than two lines above its actions; the draft scrolls instead.
    if (prompt && available < wanted) {
      const overflow = Math.max(0, area.getBoundingClientRect().bottom - window.innerHeight);
      const height = Math.max(MIN_PROMPT_HEIGHT, prompt.offsetHeight - (wanted - available) - overflow);
      composer.style.setProperty('--voice-prompt-height', `${height}px`);
      composer.setAttribute('data-voice-compact', '');
      area.setAttribute('data-voice-compact', '');
      anchor = composer.getBoundingClientRect();
      available = anchor.top - FLOATING_GAP - VIEWPORT_MARGIN;
    }
    this.pill.style.setProperty('--voice-available-height', `${Math.max(0, available)}px`);
    const top = Math.max(VIEWPORT_MARGIN, anchor.top - FLOATING_GAP - this.pill.offsetHeight);
    this.pill.style.top = `${top - area.getBoundingClientRect().top - area.clientTop + area.scrollTop}px`;
    this.pill.style.bottom = 'auto';
  }
  private queue = () => {
    if (!this.active || document.hidden || this.frame !== undefined) return;
    this.frame = window.requestAnimationFrame(() => { this.frame = undefined; this.refresh(); });
  };
}
export function createVoicePillPlacement(pill: HTMLElement, details: HTMLElement) {
  return new VoicePillPlacement(pill, details);
}
