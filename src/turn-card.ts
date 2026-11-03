/** One card per agent turn: a header (the step sentence or the turn's summary, and the elapsed time)
 * that opens the trace, an inner card with the latest reply (clamped to REPLY_LINES with Read more),
 * and a footer with the turn's changes. Markup is composed in main.ts; this module owns the reply's
 * clamp, its live growth and the footer's arrival, all with the Web Animations API (the trace is the
 * one surface allowed richer choreography) and instant under reduced motion or before first paint. */
import { escape } from './dom.ts';
import { formatDuration } from './turn-activity.ts';
import './turn-card.css';

export const REPLY_LINES = 6;
/** The thread's line height (styles.css: `.after-trace>.message-content`), so the clamp lands on a line. */
const LINE_HEIGHT = 1.6;
const READ_MS = 180;
const GROW_MS = 160;
const FOLD_MS = 180;
const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
const EASE_IN_OUT = 'cubic-bezier(.45,0,.2,1)';
const BRIDGE_MAX_MS = 480;
/** The footer's arrival: its fade, and its row's height (with whatever the held live card gives back) on a longer ease-out. */
const FOOT_MS = 160;
const FOOT_GROW_MS = 220;

const still = (): boolean => document.hidden || !document.documentElement.hasAttribute('data-ready') || matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Replies the reader opened (or watched stream in), by turn key (stable when saved ids replace live ones); they stay open across redraws. */
const openReplies = new Set<string>();
export const openReply = (key: string): void => { openReplies.add(key); };

/** The header's elapsed time. Live times carry `data-live` and tick from main.ts's work timer. */
export function timeHtml(ms: number | null, live = false): string {
  if (ms === null) return '';
  // Read as `… took 4s` (live: `working for 4s`); the prefix sits beside the time, so its text stays the number.
  return `<span class="sr-only turn-card-time-lead">${live ? 'working for' : 'took'} </span><span class="turn-card-time"${live ? ' data-live' : ''}>${escape(formatDuration(ms))}</span>`;
}

/** Three breathing lines hold the reply's place until the first token. */
export const SKELETON_HTML = '<div class="turn-card-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>';

let replyIds = 0;
/** The inner card. `actions` (copy, fork) sit in its last row beside Read more; a live reply keeps its own. */
export function replyHtml(content: string, key: string, actions = '', live = false): string {
  const id = `turn-reply-${++replyIds}`, open = live || openReplies.has(key);
  return `<div class="turn-card-reply ds-card-inner${live ? ' is-live' : ''}"${open ? ' data-open' : ''} data-reply-key="${escape(key)}"><div class="turn-card-reply-body" id="${id}"><div class="turn-card-reply-content">${content}</div></div>${live ? '' : `<div class="turn-card-reply-row"><button type="button" class="turn-card-more" aria-controls="${id}" aria-expanded="${open}" hidden>${open ? 'Show less' : 'Read more'}</button>${actions}</div>`}</div>`;
}

const clampHeight = (body: HTMLElement): number => parseFloat(getComputedStyle(body).fontSize) * LINE_HEIGHT * REPLY_LINES;
const sizes = new WeakMap<Element, number>();
const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(entries => {
  for (const entry of entries) {
    const content = entry.target as HTMLElement, reply = content.closest<HTMLElement>('.turn-card-reply');
    const body = content.parentElement;
    if (!reply || !body || !content.isConnected) continue;
    const height = content.offsetHeight, before = sizes.get(content);
    sizes.set(content, height);
    if (reply.classList.contains('is-live')) { if (before !== undefined && before !== height) grow(body, before, height); }
    else syncOverflow(reply, body, height);
  }
});

/** Starts watching every reply under `root` (new ones only). */
export function watchReplies(root: ParentNode): void {
  const fresh = [...root.querySelectorAll<HTMLElement>('.turn-card-reply-content')].filter(content => !sizes.has(content));
  // A saved reply is clamped in the task it is drawn, never one frame late from the observer: read every height, then write.
  const saved = fresh.flatMap(content => {
    const reply = content.closest<HTMLElement>('.turn-card-reply'), body = content.parentElement;
    return reply && body && !reply.classList.contains('is-live') ? [{ reply, body, height: content.offsetHeight }] : [];
  });
  saved.forEach(({ reply, body, height }) => syncOverflow(reply, body, height));
  fresh.forEach(content => { sizes.set(content, -1); observer?.observe(content); });
}

/** Read more shows only when the reply runs past the clamp by more than half a line. */
function syncOverflow(reply: HTMLElement, body: HTMLElement, height: number): void {
  const limit = clampHeight(body), overflow = height > limit + limit / REPLY_LINES / 2;
  if (reply.hasAttribute('data-overflow') !== overflow) reply.toggleAttribute('data-overflow', overflow);
  const button = reply.querySelector<HTMLButtonElement>(':scope > .turn-card-reply-row > .turn-card-more');
  if (button && button.hidden === overflow) button.hidden = !overflow;
}

/** A streaming reply grows from where it is to its new height, so appended lines never jump in. */
function grow(body: HTMLElement, before: number, after: number): void {
  if (still() || before < 0) return;
  const running = body.getAnimations().length > 0, from = running ? body.getBoundingClientRect().height : before;
  body.getAnimations().forEach(animation => animation.cancel());
  body.style.overflow = 'hidden';
  const animation = body.animate([{ height: `${from}px` }, { height: `${after}px` }], { duration: GROW_MS, easing: EASE_OUT });
  animation.onfinish = () => { body.style.overflow = ''; };
}

let collapsed: ((shrink: number, timing?: EffectTiming) => void) | undefined;
/** main.ts keeps a closing reply's top in place near the end of the thread (`shrink` px, on `timing`; none when instant). */
export function onReplyCollapse(handler: typeof collapsed): void { collapsed = handler; }

function toggleReply(reply: HTMLElement): void {
  const body = reply.querySelector<HTMLElement>('.turn-card-reply-body'), button = reply.querySelector<HTMLButtonElement>('.turn-card-more');
  if (!body || !button) return;
  const key = reply.dataset.replyKey ?? '', open = !reply.hasAttribute('data-open');
  const from = body.getBoundingClientRect().height;
  body.getAnimations().forEach(animation => animation.cancel());
  // Measured and handed to main.ts before the attribute changes, so no layout read sees the clamped reply without its room.
  const to = open ? body.scrollHeight : clampHeight(body), quiet = still();
  if (!open) collapsed?.(from - to, quiet ? undefined : { duration: READ_MS, easing: EASE_OUT });
  reply.toggleAttribute('data-open', open);
  if (open) openReplies.add(key); else openReplies.delete(key);
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Show less' : 'Read more';
  // The transcript stops following the bottom on this click (main.ts), so the reply's top stays where it is;
  // the view moves only to keep a collapsed reply's button in sight.
  const settle = () => { body.style.overflow = ''; if (!open) button.scrollIntoView({ block: 'nearest' }); };
  if (quiet) { settle(); return; }
  body.style.overflow = 'hidden';
  const animation = body.animate([{ maxHeight: `${from}px` }, { maxHeight: `${to}px` }], { duration: READ_MS, easing: EASE_OUT });
  animation.onfinish = settle;
}

document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest?.('.turn-card-more');
  const reply = button?.closest<HTMLElement>('.turn-card-reply');
  if (reply) toggleReply(reply);
});

/** The reply the reader just watched stream stays at its full height when the saved card takes over. */
export function keepReplyOpen(reply: HTMLElement): void {
  openReplies.add(reply.dataset.replyKey ?? '');
  reply.setAttribute('data-open', '');
  const button = reply.querySelector<HTMLButtonElement>('.turn-card-more');
  if (button) { button.setAttribute('aria-expanded', 'true'); button.textContent = 'Show less'; }
}

/** At the end of a run the saved card replaces the live one in the same task: it eases from the live card's
 * height (`from`) to its own, so the footer folds in under the reply and nothing above it jumps. */
export function bridgeCard(card: HTMLElement, from: number): EffectTiming | undefined {
  if (still() || from <= 0) return;
  const to = card.getBoundingClientRect().height;
  fadeInFoot(card);
  if (Math.abs(to - from) < 1) return;
  card.style.overflow = 'clip';
  // The footer alone grows in under its fade (FOOT_GROW_MS); a long fold (an open trace closing) takes a little longer on a
  // gentler curve, so it never lurches. The timing is returned so main.ts can ease the room under the card with it.
  const distance = Math.abs(to - from);
  // Either curve keeps the edge under ~16 px a frame: ease-out starts at ~4.5× its mean speed, the in-out peaks at ~2.2×.
  // Past ~40 px (a footer row) the edge ramps in on the in-out curve over at least 260 ms, so its first frame is a few px, not 8–14.
  const gentle = distance > 40;
  const duration = gentle ? Math.min(BRIDGE_MAX_MS, Math.max(260, distance * 2.2)) : Math.max(FOOT_GROW_MS, distance * 4.6);
  const timing = { duration, easing: gentle ? EASE_IN_OUT : EASE_OUT };
  const animation = card.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
  animation.onfinish = animation.oncancel = () => { card.style.overflow = ''; };
  return timing;
}

/** A saved card whose open trace folds at the handoff starts at the live card's height and closes with the fold
 * (`timing`), so its bottom never steps; anything taller than the card is clipped until the fold catches up. */
export function holdCard(card: HTMLElement, from: number, to: number, timing: EffectTiming): void {
  if (still() || from <= 0 || Math.abs(from - to) < 1) return;
  card.style.overflow = 'clip';
  const animation = card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: timing.duration, easing: timing.easing });
  animation.onfinish = animation.oncancel = () => { card.style.overflow = ''; };
}

/** The footer arrives FOOT_DELAY_MS into the card's fold, so the two overlap rather than run one after the other. */
const FOOT_DELAY_MS = 60;
export function fadeInFoot(card: HTMLElement): void {
  if (still()) return;
  card.querySelector<HTMLElement>(':scope > .turn-card-foot')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOOT_MS, delay: FOOT_DELAY_MS, easing: 'ease-out', fill: 'backwards' });
}

/** The first text replaces the skeleton with a soft fade. */
export function fadeInReply(element: HTMLElement): void {
  if (!still()) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GROW_MS, easing: 'ease-out' });
}
