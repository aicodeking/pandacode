import { escape, icon } from './dom';

/** One shared tooltip for `[data-tip]` elements: details live behind a small info
 * mark instead of a second line. Shown on hover and on keyboard focus of the row
 * that contains the mark; hidden on any press, key, scroll, or when the mark leaves. */
let bubble: HTMLElement | undefined, anchor: Element | undefined, frame = 0, pinned = false;
/** The bubble's id, which a pinned toggle mark names in `aria-controls`. */
const BUBBLE_ID = 'tip-bubble';
/** Watches the page only while a tip is pinned: a repaint that detaches or hides its mark takes the tip with it. */
let watcher: MutationObserver | undefined;

/** A Tab stop of its own (the tip shows on keyboard focus and is its accessible description); pass `inline`
 * inside a control (a menu row, a summary) that already shows the tip on its own focus. With `toggle` the mark is a
 * button whose click, tap, Enter or Space pins the tip until it is pressed again, Escape, focus leaves, or a press elsewhere. */
export function infoMark(text: string, label = 'Details', inline = false, toggle = false): string {
  const tip = escape(text);
  if (toggle) return `<button type="button" class="info-mark info-mark-toggle" aria-label="${escape(label)}" aria-description="${tip}" aria-expanded="false" data-tip="${tip}" data-tip-toggle>${icon('info')}</button>`;
  const focus = inline ? '' : ` tabindex="0" aria-description="${tip}"`;
  return `<span class="info-mark" role="img" aria-label="${escape(label)}"${focus} data-tip="${tip}">${icon('info')}</span>`;
}

function hide(): void {
  cancelAnimationFrame(frame); frame = 0;
  if (bubble) { bubble.remove(); bubble = undefined; }
  if (pinned) { anchor?.setAttribute('aria-expanded', 'false'); anchor?.removeAttribute('aria-controls'); }
  watcher?.disconnect(); watcher = undefined;
  anchor = undefined; pinned = false;
}

/** Hides a pinned tip (its mark keeps focus); true when there was one, so an Escape handler can stop there.
 * With `within`, only a tip whose mark is inside it (a closing panel's own tip). */
export function dismissPinnedTip(within?: Node): boolean {
  if (!pinned || (within && !(anchor && within.contains(anchor)))) return false;
  hide(); return true;
}

/** False once the mark is detached or hidden (a closed panel), so its bubble does not float alone. */
function shown(mark: Element): boolean {
  if (!mark.isConnected) return false;
  return typeof mark.checkVisibility === 'function' ? mark.checkVisibility() : mark.getClientRects().length > 0;
}

function place(): void {
  frame = 0;
  if (!bubble || !anchor) return;
  if (!shown(anchor)) { hide(); return; }
  const rect = anchor.getBoundingClientRect();
  const width = bubble.offsetWidth, height = bubble.offsetHeight;
  const gap = 8, margin = 10;
  const above = rect.top - height - gap >= margin;
  const top = above ? rect.top - height - gap : rect.bottom + gap;
  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - margin));
  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
  bubble.dataset.placement = above ? 'above' : 'below';
}

function show(mark: Element): void {
  const text = mark.getAttribute('data-tip');
  if (!text) return;
  if (anchor === mark && bubble) return;
  hide();
  anchor = mark;
  bubble = document.createElement('div');
  bubble.className = 'tip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.id = BUBBLE_ID;
  bubble.textContent = text;
  // Inside a modal the bubble must share the dialog's top layer.
  (mark.closest('dialog[open]') ?? document.body).append(bubble);
  place();
  bubble.classList.add('tip-visible');
}

function pin(mark: Element): void {
  if (anchor !== mark || !bubble) return;
  pinned = true; mark.setAttribute('aria-expanded', 'true'); mark.setAttribute('aria-controls', BUBBLE_ID);
  // Only checks (never places, whose style writes would re-trigger it).
  watcher = new MutationObserver(() => { if (anchor && !shown(anchor)) hide(); });
  watcher.observe(document.body, { childList: true, subtree: true, attributes: true });
}

function markFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-tip]') ?? (target.matches('button, [role="menuitem"], [role="menuitemradio"], [role="option"]') ? target.querySelector('[data-tip]') : null);
}

/** Setting rows read as one line: a short note beside the title, a long one behind a mark.
 * Live status lines (classed `small`s) stay inline and trim; help text stays in the DOM for
 * assistive technology. Safe to call repeatedly. */
export function compactSublines(root: ParentNode): void {
  for (const small of root.querySelectorAll<HTMLElement>('.setting-row > div > small:not([data-compact])')) {
    small.dataset.compact = 'inline';
    const text = small.textContent?.trim() ?? '';
    if (small.className || text.length <= BRIEF_NOTE) continue;
    small.dataset.compact = 'mark';
    small.classList.add('sr-only');
    small.insertAdjacentHTML('beforebegin', infoMark(text));
  }
}
const BRIEF_NOTE = 44;

export function installTooltips(): void {
  // Focus reveals a tip only when it arrived by keyboard; a menu opened with the
  // pointer must not pop a bubble on its first row.
  let keyboard = false;
  document.addEventListener('keydown', () => { keyboard = true; }, true);
  document.addEventListener('pointerdown', () => { keyboard = false; }, true);
  document.addEventListener('pointerover', event => {
    const mark = markFor(event.target);
    // A pinned tip stays while the pointer wanders, but another mark's hover replaces it.
    if (pinned && (!mark || mark === anchor)) return;
    if (mark) show(mark);
    else if (anchor && !(event.target instanceof Node && (anchor.contains(event.target) || bubble?.contains(event.target)))) hide();
  });
  document.addEventListener('focusin', event => { const mark = markFor(event.target); if (pinned && mark === anchor) return; if (mark && keyboard) show(mark); else hide(); });
  document.addEventListener('focusout', event => { if (anchor && event.target instanceof Node && anchor.contains(event.target)) hide(); });
  // A pinned tip survives presses and keys on its own mark (its click toggles it); Escape, a press elsewhere or
  // focus leaving the mark hides it.
  const dismiss = (event: Event) => {
    if (pinned && anchor && event.target instanceof Node && anchor.contains(event.target) && (event as KeyboardEvent).key !== 'Escape') return;
    hide();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(type, dismiss, true);
  document.addEventListener('click', event => {
    const mark = event.target instanceof Element ? event.target.closest('[data-tip-toggle]') : null;
    if (!mark) return;
    if (pinned && anchor === mark) { hide(); return; }
    hide(); show(mark); pin(mark);
  });
  // A scroll (often programmatic: a list revealing its row) moves the bubble with its anchor; wheel and
  // keys already hide it, and a pointer left off the anchor hides it through the next pointerover.
  document.addEventListener('scroll', place, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
