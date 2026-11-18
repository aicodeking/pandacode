import { reducedMotion } from './motion';

/* The composer tray's state change: colour and fill cross-fade and the icon pops, only when the same
 * thread's mode, Team or Saver really changed. renderComposer replaces the markup, so a CSS transition
 * alone would never run: the new element briefly takes the old state, then the new one. The play waits for
 * the next frame and finds the element then, since one change can redraw the tray twice in a tick (Team's
 * menu close, a removed team's own redraw), and a play on the first copy would be lost with it. */

type Item = { selector: string; attr: (el: HTMLElement) => string; key?: (el: HTMLElement) => string };
const ITEMS: Item[] = [
  { selector: '#mode-picker-trigger', attr: () => 'data-mode' },
  { selector: '.composer-team-button', attr: el => el.id === 'team-trigger' ? 'data-on' : 'aria-pressed' },
  { selector: '.composer-saver-button', attr: () => 'aria-pressed', key: el => el.querySelector('b')?.textContent ?? '' },
];
type Seen = { value: string | null; key: string };
let seenSession = '';
let seen = new Map<string, Seen>();
type Pending = { attr: string; from: string | null; to: string | null };
let pending = new Map<string, Pending>(), frame = 0;

function flush(): void {
  frame = 0;
  const plays = pending; pending = new Map();
  for (const [selector, { attr, from, to }] of plays) {
    const el = document.querySelector<HTMLElement>(`#composer ${selector}`);
    if (el && el.getAttribute(attr) === to && !quiet()) play(el, attr, from, to);
  }
}

const quiet = () => document.hidden || !document.documentElement.hasAttribute('data-ready') || reducedMotion();

function play(el: HTMLElement, attr: string, from: string | null, to: string | null): void {
  const icon = el.querySelector<SVGElement>('.icon');
  if (from !== to) {
    // The element may already have been styled in its new state: commit the old one without a transition
    // (else the step back starts a reverse transition the change below cancels), then change with one.
    const parts = [el, icon].filter(part => part !== null) as (HTMLElement | SVGElement)[];
    for (const part of parts) part.style.transition = 'none';
    if (from === null) el.removeAttribute(attr); else el.setAttribute(attr, from);
    for (const part of parts) { void getComputedStyle(part).color; part.style.transition = ''; }
    if (to === null) el.removeAttribute(attr); else el.setAttribute(attr, to);
  }
  icon?.animate({ scale: [1, 1.12, 1] }, { duration: 180, easing: 'ease-out' });
}

/** Call after anything that may redraw or change the tray. `teamKnown` is false until the thread's team has
 * loaded, so its first answer is never taken for a change. */
export function syncTrayState(sessionId: string, teamKnown: boolean): void {
  const next = new Map<string, Seen>();
  for (const item of ITEMS) {
    const el = document.querySelector<HTMLElement>(`#composer ${item.selector}`);
    if (!el || (!teamKnown && item.selector === '.composer-team-button')) continue;
    const attr = item.attr(el), value = el.getAttribute(attr), key = item.key?.(el) ?? '', last = seen.get(item.selector);
    next.set(item.selector, { value, key });
    if (sessionId === seenSession && last && (last.value !== value || last.key !== key) && !quiet()) {
      // Two changes before the frame play once, from the first state.
      const from = pending.get(item.selector)?.from ?? last.value;
      pending.set(item.selector, { attr, from, to: value });
    }
  }
  if (sessionId !== seenSession) pending.clear();
  if (pending.size) frame ||= requestAnimationFrame(flush);
  seenSession = sessionId; seen = next;
}
