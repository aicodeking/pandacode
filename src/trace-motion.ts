/** Live tool-trace choreography: the one exception to PandaCode's instant UI (MOTION = false).
 * Timings were measured frame by frame from the reference trace: a new step blurs in, a result
 * card unfolds under it, the card two results back folds away, and the turn folds to one line at
 * the end. Everything uses the Web Animations API (CSS transitions are globally off) and is
 * instant under prefers-reduced-motion. */

/** The reference keeps the two newest result cards open. */
export const OPEN_CARDS = 2;
// Counted frame by frame at 30 fps: a new row fades in over 3 frames; the header's new sentence lands
// 4 frames after its row; a card unfolds in 5 frames (ease-out) with rows a frame apart; a folding card's
// content is gone in 1 frame and its height closes over 7 (ease-in-out); the turn folds in ~5 frames.
const ENTER_MS = 100;
const HEADER_DELAY_MS = 130;
const EXPAND_MS = 170;
const COLLAPSE_MS = 230;
const FOLD_MS = 150;
const ROW_STAGGER_MS = 33;
const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
const EASE_IN_OUT = 'cubic-bezier(.4,0,.2,1)';
const BLUR_IN: Keyframe[] = [{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }];

const still = (): boolean => document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
const seen = new Map<string, Set<string>>();
// Tools the reader opened or closed by hand keep that state for the rest of the turn.
const pinned = new Map<string, Set<string>>();

document.addEventListener('click', event => {
  const summary = (event.target as Element | null)?.closest?.('.live-activity details.tool-trace > summary');
  const tool = summary?.parentElement as HTMLElement | undefined;
  const turnKey = tool?.closest<HTMLElement>('[data-turn-key]')?.dataset.turnKey;
  if (!tool?.dataset.toolKey || !turnKey) return;
  pinned.set(turnKey, (pinned.get(turnKey) ?? new Set()).add(tool.dataset.toolKey));
  delete tool.dataset.auto;
}, true);

/** A new step row (or, after `delay`, the header's new sentence) arrives out of a soft blur. */
export function enterText(element: Element, delay = 0): void {
  if (!still()) element.animate(BLUR_IN, { duration: ENTER_MS, delay, easing: EASE_OUT, fill: 'backwards' });
}
/** The header's sentence follows its row a beat later, as in the reference. */
export function enterHeader(element: Element): void { enterText(element, HEADER_DELAY_MS); }

function body(details: HTMLDetailsElement): HTMLElement | null {
  return details.querySelector<HTMLElement>(':scope > .tool-activity-body, :scope > .turn-activity-body');
}

/** Height from the current height to `to`, with overflow clipped while it runs. */
function resize(element: HTMLElement, frames: Keyframe[], duration: number, easing: string, done: () => void): void {
  element.style.overflow = 'hidden';
  const animation = element.animate(frames, { duration, easing });
  const finish = () => { element.style.overflow = ''; done(); };
  animation.onfinish = finish;
  animation.oncancel = finish;
}

function expand(details: HTMLDetailsElement): void {
  delete details.dataset.closing;
  details.open = true;
  const content = body(details);
  if (!content || still()) return;
  resize(content, [{ height: '0px', opacity: 0 }, { height: `${content.offsetHeight}px`, opacity: 1 }], EXPAND_MS, EASE_OUT, () => {});
  content.querySelectorAll('.trace-row, .tool-trace-more, .tc-row').forEach((row, index) => {
    row.animate([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: EXPAND_MS, delay: index * ROW_STAGGER_MS, easing: EASE_OUT, fill: 'backwards' });
  });
}

/** Content fades first, then the height closes; the chevron turns right away (`data-closing`). */
function collapse(details: HTMLDetailsElement, duration = COLLAPSE_MS, done = () => {}): void {
  const content = body(details);
  if (!content || still()) { details.open = false; done(); return; }
  if (details.dataset.closing !== undefined) return;
  details.dataset.closing = '';
  resize(content, [{ height: `${content.offsetHeight}px`, opacity: 1 }, { opacity: 0, offset: .15 }, { height: '0px', opacity: 0 }], duration, EASE_IN_OUT, () => {
    if (details.dataset.closing === undefined) return;
    delete details.dataset.closing;
    details.open = false;
    done();
  });
}

/** Opens the newest result cards, folds older ones and blurs in rows it has not shown before.
 * `answering` folds every card while the reply streams; `expandAll` honours the reader's setting. */
export function choreograph(host: HTMLElement, turnKey: string, options: { answering: boolean; expandAll: boolean }): void {
  const first = !seen.has(turnKey);
  const known = seen.get(turnKey) ?? new Set<string>();
  seen.set(turnKey, known);
  const tools = [...host.querySelectorAll<HTMLDetailsElement>('details.tool-trace[data-tool-key]')];
  for (const tool of tools) {
    const key = tool.dataset.toolKey!;
    // A thread opened mid-turn draws what is already there without replaying it.
    if (!known.has(key) && !first) enterText(tool.querySelector('summary')!);
    known.add(key);
  }
  if (options.expandAll) return;
  // Cards in steps the agent has narrated past stay folded (see paintLiveActivity).
  const withCard = tools.filter(tool => tool.dataset.toolStatus !== 'running' && !tool.closest('.tool-group[data-earlier]') && tool.querySelector(':scope > .tool-activity-body > :not(.tool-activity-note, .tool-trace-raw)'));
  const keep = new Set(options.answering ? [] : withCard.slice(-OPEN_CARDS));
  for (const tool of tools) {
    // `data-auto` marks cards opened for the reader; their raw record stays out of the way (tool-trace.css).
    if (pinned.get(turnKey)?.has(tool.dataset.toolKey!)) { delete tool.dataset.auto; continue; }
    tool.dataset.auto = '';
    const want = keep.has(tool);
    if (!want && tool.closest('.tool-group[data-earlier]:not([open])')) { tool.open = false; delete tool.dataset.closing; continue; }
    if (want && (!tool.open || tool.dataset.closing !== undefined)) expand(tool);
    else if (!want && tool.open) first ? (tool.open = false) : collapse(tool);
  }
}

/** True while the reader keeps a tool of this turn open by hand; the turn then stays open at the end. */
export function readingTrace(activity: Element): boolean {
  const held = pinned.get(activity.closest<HTMLElement>('[data-turn-key]')?.dataset.turnKey ?? '');
  return !!held && [...activity.querySelectorAll<HTMLDetailsElement>('details.tool-trace[open]')].some(tool => held.has(tool.dataset.toolKey!));
}

/** The end of a turn: every card closes, the step list folds under the summary header. */
export function foldTurn(activity: HTMLDetailsElement): void {
  activity.dataset.folded = '';
  activity.querySelectorAll<HTMLDetailsElement>('details.tool-trace[open]').forEach(tool => { tool.open = false; delete tool.dataset.closing; });
  const turnKey = activity.dataset.turnKey ?? '';
  pinned.delete(turnKey);
  seen.delete(turnKey);
  if (activity.open) collapse(activity, FOLD_MS);
}
