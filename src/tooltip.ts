import { t } from './i18n.ts';
import { escape, icon } from './dom';

/** One shared tooltip for `[data-tip]` elements: details live behind a small info
 * mark instead of a second line. Shown on hover and on keyboard focus of the row
 * that contains the mark; hidden on any press, key, scroll, or when the mark leaves. */
let bubble: HTMLElement | undefined, anchor: Element | undefined, frame = 0;

export function infoMark(text: string, label = t('Details')): string {
  return `<span class="info-mark" role="img" aria-label="${escape(label)}" data-tip="${escape(text)}">${icon('info')}</span>`;
}

function hide(): void {
  cancelAnimationFrame(frame); frame = 0;
  if (bubble) { bubble.remove(); bubble = undefined; }
  anchor = undefined;
}

function place(): void {
  frame = 0;
  if (!bubble || !anchor) return;
  if (!anchor.isConnected) { hide(); return; }
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
  bubble.textContent = text;
  // Inside a modal the bubble must share the dialog's top layer.
  (mark.closest('dialog[open]') ?? document.body).append(bubble);
  place();
  bubble.classList.add('tip-visible');
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
    if (mark) show(mark);
    else if (anchor && !(event.target instanceof Node && (anchor.contains(event.target) || bubble?.contains(event.target)))) hide();
  });
  document.addEventListener('focusin', event => { const mark = markFor(event.target); if (mark && keyboard) show(mark); else hide(); });
  document.addEventListener('focusout', event => { if (anchor && event.target instanceof Node && anchor.contains(event.target)) hide(); });
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(type, hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
