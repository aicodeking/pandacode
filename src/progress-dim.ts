import { fadeTo } from './progress-motion';

/* Keeps the expanded PiP card out of the way. It softens to READING while the user scrolls
 * the transcript (wheel, touch, scroll keys: never the app's own stick-to-bottom scrolling)
 * or types in the composer, coming back after IDLE ms; whenever it covers the transcript's text column it
 * softens to AWAY while the pointer is over the transcript. While soft, only the header takes the pointer
 * (`.is-dim`): clicks anywhere else on the card reach the transcript underneath, and
 * hovering the header wakes it. Hover, keyboard focus inside, the lightbox and a new iteration
 * (`wake()`) bring it back to full strength. */

const READING = 0.55, AWAY = 0.14, IDLE = 1200, NARROW = 1000;
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

export type DimHost = { card(): HTMLElement | null; busy(): boolean };
export type Dimmer = { apply(): void; wake(ms?: number): void };

export function createDimmer(root: HTMLElement, host: DimHost): Dimmer {
  let active = 0, away = false, hovered = false, wokenUntil = 0, wakeTimer = 0;
  const pane = () => root.parentElement;
  /** The card sits over the transcript's text column (narrow panes, or wide ones with panels open). */
  function covers(): boolean {
    const card = host.card()?.getBoundingClientRect(), column = document.querySelector('#transcript > *')?.getBoundingClientRect();
    if (!card || !column) return (pane()?.clientWidth ?? NARROW) < NARROW;
    return card.right > column.left && card.left < column.right;
  }
  function level(): number {
    // Keyboard focus holds it; focus left behind by a click does not.
    if (hovered || host.busy() || root.querySelector(':focus-visible') || Date.now() < wokenUntil) return 1;
    return active ? READING : away ? AWAY : 1;
  }
  function apply(): void {
    const card = host.card();
    if (!card) { root.classList.remove('is-dim'); return; }
    const value = level();
    root.classList.toggle('is-dim', value < 1);
    root.classList.toggle('is-away', value === AWAY);
    fadeTo(card, value, value < 1 ? 420 : 240);
  }
  function activity(): void {
    clearTimeout(active);
    active = window.setTimeout(() => { active = 0; apply(); }, IDLE);
    apply();
  }
  const on = (target: EventTarget | null, type: string, listener: EventListener) => target?.addEventListener(type, listener, { passive: true });
  const transcript = document.querySelector('#transcript');
  on(transcript, 'wheel', activity);
  on(transcript, 'touchmove', activity);
  on(transcript, 'keydown', event => { if (SCROLL_KEYS.has((event as KeyboardEvent).key)) activity(); });
  on(document, 'input', event => { if ((event.target as Element).closest?.('#composer-area')) activity(); });
  on(document, 'pointermove', event => {
    const target = event.target as Element;
    const next = covers() && Boolean(target.closest?.('#transcript')) && !root.contains(target);
    if (next !== away) { away = next; apply(); }
  });
  on(root, 'pointerenter', () => { hovered = true; away = false; apply(); });
  on(root, 'pointerleave', () => { hovered = false; apply(); });
  on(root, 'focusin', apply);
  on(root, 'focusout', () => queueMicrotask(apply));
  return {
    apply,
    /** Full strength for a moment, as when a new iteration arrives. */
    wake(ms = 1800) {
      wokenUntil = Date.now() + ms;
      clearTimeout(wakeTimer); wakeTimer = window.setTimeout(apply, ms + 20);
      apply();
    },
  };
}
