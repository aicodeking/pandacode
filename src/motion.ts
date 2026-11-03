/* Springs drive every surface transition: motion starts from the current
 * on-screen value, can be interrupted, and never gates interaction. Reduced
 * motion keeps a short cross-fade so state changes stay legible. */

/** Apple's designer-facing spring: damping ratio (1 = no overshoot) and response in seconds. */
export type Spring = { damping?: number; response?: number; velocity?: number };

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Motion is on but restrained: short critically damped springs (~120–220 ms of visible
 *  travel), a few pixels of movement, never gating input. Every caller has an instant path,
 *  so setting this to false makes the whole interface instant again. */
const MOTION = true;
const canAnimate = (element: Element): boolean => MOTION && !document.hidden && typeof element.animate === 'function';
const FRAME = 1000 / 60;

/** Samples progress (0 → 1) one frame apart until the spring settles. */
export function springProgress({ damping = 1, response = 0.36, velocity = 0 }: Spring = {}): { samples: number[]; duration: number } {
  const omega = (2 * Math.PI) / Math.max(0.05, response);
  const x0 = -1, v0 = velocity;
  const displacement = (t: number): number => {
    if (Math.abs(damping - 1) < 1e-3) return (x0 + (v0 + omega * x0) * t) * Math.exp(-omega * t);
    if (damping < 1) {
      const wd = omega * Math.sqrt(1 - damping * damping);
      return Math.exp(-damping * omega * t) * (x0 * Math.cos(wd * t) + ((v0 + damping * omega * x0) / wd) * Math.sin(wd * t));
    }
    const root = omega * Math.sqrt(damping * damping - 1), r1 = -damping * omega + root, r2 = -damping * omega - root;
    const b = (v0 - r1 * x0) / (r2 - r1);
    return (x0 - b) * Math.exp(r1 * t) + b * Math.exp(r2 * t);
  };
  const samples: number[] = [];
  const limit = Math.min(2000, Math.max(200, response * 4000));
  let settled = 0;
  for (let ms = 0; ms <= limit; ms += FRAME) {
    const x = displacement(ms / 1000);
    samples.push(1 + x);
    settled = Math.abs(x) < 0.004 ? settled + 1 : 0;
    if (settled >= 3 && ms > 60) break;
  }
  samples[samples.length - 1] = 1;
  return { samples, duration: (samples.length - 1) * FRAME };
}

/** Builds evenly spaced keyframes from a spring, mapping progress to declarations. */
export function springKeyframes(spring: Spring, frame: (progress: number) => Keyframe): { keyframes: Keyframe[]; duration: number } {
  const { samples, duration } = springProgress(spring);
  return { keyframes: samples.map(frame), duration };
}

/** CSS `linear()` easing for the same spring, or undefined where unsupported. */
export function springEasing(spring: Spring): { easing: string; duration: number } | undefined {
  if (typeof CSS === 'undefined' || !CSS.supports('animation-timing-function', 'linear(0, 1)')) return undefined;
  const { samples, duration } = springProgress(spring);
  const step = Math.max(1, Math.round(samples.length / 40));
  const points = samples.filter((_, index) => index % step === 0 || index === samples.length - 1);
  return { easing: `linear(${points.map(value => value.toFixed(4).replace(/\.?0+$/, '') || '0').join(', ')})`, duration };
}

/** Every `state-pulse` (styles.css) breathes in one phase: each starts on the document timeline's zero, so a
 * pulse mounted later lands mid-breath with the others instead of starting its own. Pseudo-element pulses
 * (a sidebar dot's ::before) are found through `subtree`. Reduced motion has no pulses to align. */
export function syncPulses(): void {
  document.addEventListener('animationstart', event => {
    if (event.animationName !== 'state-pulse' || reducedMotion() || !(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({ subtree: true })) {
      if ((animation as CSSAnimation).animationName !== 'state-pulse' || animation.startTime === 0) continue;
      const effect = animation.effect as KeyframeEffect | null;
      if (effect?.target === event.target && (effect.pseudoElement ?? '') === event.pseudoElement) animation.startTime = 0;
    }
  }, true);
}

/** Publishes spring curves for stylesheet transitions (segmented pills, switches, hover). */
export function publishSpringEasings(root: HTMLElement = document.documentElement): void {
  const curves: Record<string, Spring> = {
    '--spring': { damping: 1, response: 0.28 },
    '--spring-fast': { damping: 1, response: 0.2 },
    '--spring-bounce': { damping: 0.8, response: 0.3 },
  };
  for (const [name, spring] of Object.entries(curves)) {
    const curve = springEasing(spring);
    if (!curve) return;
    root.style.setProperty(name, curve.easing);
    root.style.setProperty(`${name}-duration`, `${Math.round(curve.duration)}ms`);
  }
}

const opacityLead = (progress: number): number => Math.max(0, Math.min(1, progress * 1.6));
const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
const fixed = (value: number): string => value.toFixed(4);

type Presentation = { opacity: number; scale: number; x: number; y: number };
/** What is on screen right now, including any animation in flight. */
function presentation(element: HTMLElement): Presentation {
  const style = getComputedStyle(element);
  const matrix = style.transform.match(/matrix\(([^)]+)\)/);
  const [a = 1, , , d = 1, e = 0, f = 0] = matrix ? matrix[1].split(',').map(Number) : [];
  return { opacity: Number(style.opacity), scale: (a + d) / 2, x: e, y: f };
}

const running = new WeakMap<Element, Animation>();
const inFlight = new Set<Animation>();
// A background native webview may never deliver completion; every animation has a
// deadline, and hiding the document settles them all onto their underlying styles.
document.addEventListener('visibilitychange', () => { if (document.hidden) for (const animation of [...inFlight]) animation.cancel(); });
function play(element: HTMLElement, keyframes: Keyframe[], duration: number, easing = 'linear', delay = 0): Animation | undefined {
  if (!MOTION) return undefined;
  running.get(element)?.cancel();
  let animation: Animation;
  try { animation = element.animate(keyframes, { duration, easing, delay, fill: delay ? 'backwards' : 'none' }); }
  catch { return undefined; }
  running.set(element, animation);
  inFlight.add(animation);
  const deadline = window.setTimeout(() => animation.cancel(), duration + delay + 80);
  const done = (): void => { clearTimeout(deadline); inFlight.delete(animation); if (running.get(element) === animation) running.delete(element); };
  animation.onfinish = done; animation.oncancel = done;
  return animation;
}
function settle(animation: Animation | undefined, duration: number): Promise<void> {
  if (!animation) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    const finish = (): void => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
    // Completion callbacks are unreliable in a background native webview.
    const timer = window.setTimeout(finish, duration + 80);
    animation.addEventListener('finish', finish, { once: true });
    animation.addEventListener('cancel', finish, { once: true });
  });
}

type Materialize = { scale?: number; x?: number; y?: number; spring?: Spring; origin?: string };

/** Glass arrives as a material: it fades, scales and rises into place (its blur is static).
 *  Interrupting a departure continues from wherever the surface currently is. */
export function materializeIn(element: HTMLElement, { scale = 0.97, x = 0, y = 6, spring = { response: 0.24 }, origin }: Materialize = {}): Animation | undefined {
  if (!canAnimate(element)) return undefined;
  if (origin) element.style.transformOrigin = origin;
  const live = running.has(element) ? presentation(element) : undefined;
  running.get(element)?.cancel();
  if (reducedMotion()) return play(element, [{ opacity: live?.opacity ?? 0 }, { opacity: 1 }], 120, 'ease-out');
  const start = { opacity: live?.opacity ?? 0, scale: live?.scale ?? scale, x: live?.x ?? x, y: live?.y ?? y };
  // Only opacity and transform move: an animated backdrop-filter re-blurs every frame. Opacity leads the spring.
  const { keyframes, duration } = springKeyframes(spring, progress => ({
    opacity: start.opacity + (1 - start.opacity) * opacityLead(progress),
    transform: `translate(${px(start.x * (1 - progress))}, ${px(start.y * (1 - progress))}) scale(${fixed(start.scale + (1 - start.scale) * progress)})`,
  }));
  return play(element, keyframes, duration);
}

/** Leaves along the arrival path, faster, from whatever is currently on screen. */
export function materializeOut(element: HTMLElement, { scale = 0.98, x = 0, y = 4 }: Materialize = {}): Promise<void> {
  if (!canAnimate(element) || !element.isConnected) return Promise.resolve();
  const live = presentation(element);
  const duration = reducedMotion() ? 90 : 130;
  const from: Keyframe = { opacity: live.opacity, transform: `translate(${px(live.x)}, ${px(live.y)}) scale(${fixed(live.scale)})` };
  const to: Keyframe = { opacity: 0, transform: `translate(${px(x)}, ${px(y)}) scale(${fixed(scale)})` };
  if (reducedMotion()) return settle(play(element, [{ opacity: live.opacity }, { opacity: 0 }], duration, 'ease-in'), duration);
  return settle(play(element, [from, to], duration, 'cubic-bezier(.4, 0, .9, .6)'), duration);
}

type Side = 'left' | 'right' | 'top' | 'bottom';
const offset = (side: Side, distance: number): { x: number; y: number } => ({ left: { x: -distance, y: 0 }, right: { x: distance, y: 0 }, top: { x: 0, y: -distance }, bottom: { x: 0, y: distance } })[side];

/** A pane glides in from the edge it lives on, so its home is obvious. Drawers that
 *  emerge from a window edge keep full opacity: only their position travels. */
export function glideIn(element: HTMLElement, side: Side, distance = 12, { fade = true, spring = { response: 0.26 } }: { fade?: boolean; spring?: Spring } = {}): void {
  if (!canAnimate(element)) return;
  if (reducedMotion()) { if (fade) play(element, [{ opacity: 0 }, { opacity: 1 }], 140, 'ease-out'); return; }
  const { x, y } = offset(side, distance);
  const { keyframes, duration } = springKeyframes(spring, progress => ({ ...(fade ? { opacity: opacityLead(progress) } : {}), transform: `translate(${px(x * (1 - progress))}, ${px(y * (1 - progress))})` }));
  play(element, keyframes, duration);
}

/** A pane is uncovered from one edge without moving: its geometry (and anything
 *  aligned to it, such as native views) is exact from the first frame. */
export function revealIn(element: HTMLElement, side: Side, spring: Spring = { response: 0.28 }): void {
  if (!canAnimate(element) || reducedMotion()) return;
  const inset = (progress: number): string => {
    const hidden = `${((1 - progress) * 100).toFixed(2)}%`;
    return { left: `inset(0 ${hidden} 0 0)`, right: `inset(0 0 0 ${hidden})`, top: `inset(0 0 ${hidden} 0)`, bottom: `inset(${hidden} 0 0 0)` }[side];
  };
  const { keyframes, duration } = springKeyframes(spring, progress => ({ clipPath: inset(Math.min(1, progress)) }));
  play(element, keyframes, duration);
}

/** Returns along the same edge; resolves once the pane may be hidden. */
export function glideOut(element: HTMLElement, side: Side, distance = 10): Promise<void> {
  if (!canAnimate(element) || element.hidden || !element.isConnected) return Promise.resolve();
  const { x, y } = offset(side, distance);
  const duration = reducedMotion() ? 90 : 120;
  const frames: Keyframe[] = reducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ opacity: 1, transform: 'translate(0px, 0px)' }, { opacity: 0, transform: `translate(${px(x)}, ${px(y)})` }];
  return settle(play(element, frames, duration, 'cubic-bezier(.4, 0, .9, .6)'), duration);
}

// Text fields match :focus-visible however they got focus, so the field ring keys off real keyboard
// navigation: Tab turns it on; a pointer press or a shortcut (which may focus a field by script) turns it off.
if (typeof document !== 'undefined') {
  const root = document.documentElement;
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab') root.setAttribute('data-keyboard-focus', '');
    else if (event.metaKey || event.ctrlKey) root.removeAttribute('data-keyboard-focus');
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', () => root.removeAttribute('data-keyboard-focus'), { capture: true, passive: true });
}

/** A view that just became current rises softly into place. */
export function enterView(element: HTMLElement, distance = 6, spring: Spring = { response: 0.24 }): void {
  if (!canAnimate(element) || element.hidden) return;
  // Reduced motion: the view simply appears (a send or a thread switch plays nothing).
  if (reducedMotion()) return;
  const { keyframes, duration } = springKeyframes(spring, progress => ({ opacity: opacityLead(progress), transform: `translateY(${px(distance * (1 - progress))}) scale(${fixed(0.99 + 0.01 * progress)})` }));
  play(element, keyframes, duration);
}

/** New content settles where it is drawn: opacity rises from 0.7 (never from blank) with a few
 *  pixels of rise. A call while one is running continues from what is on screen, so a burst of
 *  thread switches never dims the transcript again; a nearly opaque start skips the rise. */
export function settleIn(element: HTMLElement, distance = 4, spring: Spring = { response: 0.22 }, start = SETTLE_FROM): void {
  if (!canAnimate(element) || element.hidden) return;
  const current = running.get(element);
  const live = current ? presentation(element) : undefined;
  const rate = current ? opacityRate(current) : 0;
  current?.cancel();
  const from = live?.opacity ?? start;
  if (from >= 0.99) return;
  if (reducedMotion()) return;
  const rise = !distance ? 0 : live ? live.y : from > 0.85 ? 0 : distance;
  const moving = Math.abs(rise) >= 0.5;
  // Carries the running fade's speed over, so a burst of switches rises smoothly instead of in steps.
  const { keyframes, duration } = springKeyframes({ ...spring, velocity: Math.max(0, rate) / (1 - from) }, progress => {
    const y = rise * (1 - progress);
    // Opacity follows the spring itself (no lead): the cross-fade is the soothing part, ~200 ms.
    // The tail ends on an explicit translateY(0) (never `none`), and the finished animation clears it.
    return { opacity: from + (1 - from) * Math.min(1, progress), ...(moving ? { transform: `translateY(${px(Math.abs(y) < 0.5 ? 0 : y)})` } : {}) };
  });
  play(element, keyframes, duration);
}
const SETTLE_FROM = 0.7;
/** Opacity per second of a spring animation right now (its keyframes are one frame apart). */
function opacityRate(animation: Animation): number {
  const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
  const at = Math.floor(Number(animation.currentTime ?? 0) / FRAME);
  const [a, b] = [frames[at]?.opacity, frames[at + 1]?.opacity];
  return a === undefined || b === undefined ? 0 : ((Number(b) - Number(a)) / FRAME) * 1000;
}

/** The previous thread's rows, held while a first-visit page loads: inert, dimmed to 0.7 from what is
 *  on screen (~120 ms), so a fast load never blinks through an empty pane. False when motion is off
 *  (the caller then clears the pane as before). */
export function holdDim(element: HTMLElement): boolean {
  if (!canAnimate(element)) return false;
  const from = Number(getComputedStyle(element).opacity);
  element.inert = true; element.style.opacity = String(SETTLE_FROM);
  play(element, [{ opacity: from }, { opacity: SETTLE_FROM }], 120, 'ease-out');
  return true;
}
/** Ends a hold: the new content settles in from the live opacity, or the dim simply ends. */
export function releaseHold(element: HTMLElement, settle: boolean): void {
  element.inert = false;
  // A fast page lands before the dim shows: nothing to settle from, so it gets a soft fade of its own instead of a hard cut.
  const current = running.get(element);
  if (settle && current && presentation(element).opacity > 0.9) { current.cancel(); settleIn(element, 0, undefined, 0.85); }
  else if (settle) settleIn(element); else current?.cancel();
  element.style.removeProperty('opacity');
}

/* Panels with their own grid column (the inspector). Opening: the column appears at once and the
 * panel slides 6px in from the right with opacity only (no scale), dropping its transform once less
 * than half a pixel remains (ending on translateX(0), which the finished animation clears) so text is never left resampled. Closing: the panel keeps its column,
 * inert, while it fades (~130 ms); `done` runs when it is hidden, so the caller snaps the column
 * after the fade and the conversation never rewraps under it. Showing it mid-exit turns back from
 * what is on screen. */
const leaving = new WeakMap<HTMLElement, () => void>();
function land(element: HTMLElement): void {
  leaving.delete(element);
  delete element.dataset.leaving; element.inert = false;
}
export function showPanel(element: HTMLElement, animate: boolean, still = false): void {
  const wasHidden = element.hidden || leaving.has(element);
  if (leaving.has(element)) land(element);
  element.hidden = false;
  if (!wasHidden || !animate || !canAnimate(element)) return;
  const live = running.has(element) ? presentation(element) : undefined;
  running.get(element)?.cancel();
  const from = { opacity: live?.opacity ?? 0, x: still ? 0 : live?.x ?? 6 };
  if (reducedMotion() || Math.abs(from.x) < 0.5) { play(element, [{ opacity: from.opacity }, { opacity: 1 }], reducedMotion() ? 120 : 160, 'ease-out'); return; }
  const { keyframes, duration } = springKeyframes({ response: 0.2 }, progress => {
    const x = from.x * (1 - progress);
    return { opacity: from.opacity + (1 - from.opacity) * opacityLead(progress), transform: `translateX(${px(Math.abs(x) < 0.5 ? 0 : x)})` };
  });
  play(element, keyframes, duration);
}
export function hidePanel(element: HTMLElement, animate: boolean, done: () => void, returnFocus?: HTMLElement | null): void {
  if (leaving.has(element)) return;
  // Focus inside a closing panel would fall to <body> (inert or hidden); hand it to the panel's toggle.
  if (returnFocus !== undefined && element.contains(document.activeElement)) {
    // A toggle that is not on screen (narrow rail, hidden header) cannot take focus; the prompt does.
    (returnFocus?.offsetParent ? returnFocus : document.querySelector<HTMLElement>('#prompt'))?.focus({ preventScroll: true });
  }
  if (element.hidden || !animate || !canAnimate(element)) { element.hidden = true; done(); return; }
  element.dataset.leaving = ''; element.inert = true;
  const finish = (): void => { if (leaving.get(element) !== finish) return; land(element); element.hidden = true; done(); };
  leaving.set(element, finish);
  void materializeOut(element, { scale: 1, x: 4, y: 0 }).then(finish);
}

/** Lists arrive as lists: a short cascade, capped so nobody waits for it. */
export function cascade(elements: Iterable<HTMLElement>, stepMs = 16, maxDelayMs = 120): void {
  if (!MOTION || document.hidden || reducedMotion()) return;
  const { keyframes, duration } = springKeyframes({ response: 0.26 }, progress => ({ opacity: opacityLead(progress), transform: `translateY(${px(6 * (1 - progress))})` }));
  let index = 0;
  for (const element of elements) play(element, keyframes, duration, 'linear', Math.min(maxDelayMs, index++ * stepMs));
}

/* Toast: drifts up into the bottom-right corner and eases out toward the edge it came from. */
let toastGeneration = 0;
export function showToast(toast: HTMLElement): void {
  toastGeneration++;
  const visible = !toast.hidden && !running.has(toast);
  toast.hidden = false;
  if (!canAnimate(toast) || visible) return;
  if (reducedMotion()) { play(toast, [{ opacity: 0 }, { opacity: 1 }], 120, 'ease-out'); return; }
  materializeIn(toast, { scale: 0.98, x: 6, y: 10, spring: { response: 0.3 }, origin: '100% 100%' });
}
export async function hideToast(toast: HTMLElement): Promise<void> {
  const generation = toastGeneration;
  if (canAnimate(toast) && !toast.hidden) await materializeOut(toast, { scale: 0.98, x: 10, y: 0 });
  if (generation === toastGeneration) toast.hidden = true;
}

/* Modal dialog. The <dialog> stays transparent and untransformed so menus that
 * open inside it keep viewport coordinates; a plate behind it carries the glass,
 * a scrim dims the workspace, and a ghost carries the exit so state stays synchronous. */
function sibling(dialog: HTMLDialogElement, className: string): HTMLElement {
  let element = document.querySelector<HTMLElement>(`.${className}`);
  if (!element) {
    element = document.createElement('div');
    element.className = className;
    element.setAttribute('aria-hidden', 'true');
    element.hidden = true;
    dialog.before(element);
  }
  return element;
}
type Rect = { left: number; top: number; width: number; height: number };
function fitPlate(plate: HTMLElement, dialog: HTMLDialogElement, previous?: Rect): Rect | undefined {
  const rect = dialog.getBoundingClientRect();
  if (!rect.width || !rect.height) return undefined;
  const next = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  Object.assign(plate.style, { left: px(next.left), top: px(next.top), width: px(next.width), height: px(next.height), borderRadius: getComputedStyle(dialog).borderRadius });
  const keys = ['left', 'top', 'width', 'height'] as const;
  const moved = previous && keys.some(key => Math.abs(previous[key] - next[key]) > 0.5);
  if (moved && canAnimate(plate) && !reducedMotion()) {
    // Content changed inside the open dialog: the sheet takes its new geometry at once and
    // a FLIP transform carries it from the old box (layout never animates); the dialog is
    // clipped to it meanwhile (clip-path leaves fixed descendants alone). A morph already
    // in flight retargets from wherever the sheet currently is on screen.
    const live = running.has(plate) ? running.get(plate) : undefined;
    const box = live ? plate.getBoundingClientRect() : undefined;
    live?.cancel();
    const from: Rect = box ? { left: box.left, top: box.top, width: box.width, height: box.height } : previous;
    const mix = (start: number, end: number, progress: number): number => start + (end - start) * progress;
    const { samples, duration } = springProgress({ response: 0.28 });
    plate.style.transformOrigin = '0 0';
    play(plate, samples.map(progress => {
      const width = mix(from.width, next.width, progress), height = mix(from.height, next.height, progress);
      return { transform: `translate(${px(mix(from.left, next.left, progress) - next.left)}, ${px(mix(from.top, next.top, progress) - next.top)}) scale(${fixed(width / next.width)}, ${fixed(height / next.height)})` };
    }), duration);
    const radius = getComputedStyle(dialog).borderRadius;
    play(dialog, samples.map(progress => {
      const top = mix(from.top, next.top, progress) - next.top, left = mix(from.left, next.left, progress) - next.left;
      const right = next.left + next.width - mix(from.left + from.width, next.left + next.width, progress);
      const bottom = next.top + next.height - mix(from.top + from.height, next.top + next.height, progress);
      return { clipPath: `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${radius})` };
    }), duration);
  }
  return next;
}
function copyLiveState(source: HTMLElement, target: HTMLElement): void {
  const inputs = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  const clones = target.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  inputs.forEach((input, index) => {
    const clone = clones[index]; if (!clone) return;
    if (input instanceof HTMLInputElement && clone instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio')) clone.checked = input.checked;
    else if (!(input instanceof HTMLInputElement && input.type === 'password')) clone.value = input.value;
  });
  const sources = [source, ...source.querySelectorAll<HTMLElement>('*')], targets = [target, ...target.querySelectorAll<HTMLElement>('*')];
  sources.forEach((node, index) => { if (node.scrollTop || node.scrollLeft) { const clone = targets[index]; if (clone) { clone.scrollTop = node.scrollTop; clone.scrollLeft = node.scrollLeft; } } });
}
/* The departing copy lives in a closed shadow root: it inherits nothing the document
 * can query (no duplicate ids, classes, or dialogs), while a mirrored <html> carrier
 * and the page's own stylesheets render it exactly as the dialog looked. */
let ghostStage: { host: HTMLElement; root: ShadowRoot; page: HTMLElement } | undefined;
const mirroredSheets = new WeakSet<Element>();
function stage(): { host: HTMLElement; root: ShadowRoot; page: HTMLElement } {
  if (!ghostStage) {
    const host = document.createElement('div');
    host.className = 'dialog-ghost-stage';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    host.hidden = true;
    const root = host.attachShadow({ mode: 'closed' });
    const page = document.createElement('html');
    root.append(page);
    document.body.append(host);
    ghostStage = { host, root, page };
  }
  const { root, page } = ghostStage;
  for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    if (mirroredSheets.has(sheet)) continue;
    mirroredSheets.add(sheet);
    root.insertBefore(sheet.cloneNode(true), page);
  }
  for (const { name, value } of document.documentElement.attributes) page.setAttribute(name, value);
  return ghostStage;
}
function ghostOf(dialog: HTMLDialogElement, rect: Rect): HTMLDialogElement {
  const ghost = dialog.cloneNode(true) as HTMLDialogElement;
  ghost.removeAttribute('open'); ghost.removeAttribute('aria-label');
  ghost.classList.add('dialog-ghost');
  ghost.inert = true;
  ghost.style.cssText = `display:block;position:fixed;left:${px(rect.left)};top:${px(rect.top)};width:${px(rect.width)};height:${px(rect.height)};max-width:none;max-height:none;margin:0;pointer-events:none;transform-origin:50% 45%`;
  copyLiveState(dialog, ghost);
  const { host, page } = stage();
  page.append(ghost);
  host.hidden = false;
  return ghost;
}
function dismissGhost(ghost: HTMLElement): void {
  ghost.remove();
  if (ghostStage && !ghostStage.page.childElementCount) ghostStage.host.hidden = true;
}
function contentArrives(dialog: HTMLDialogElement, x: number, delay: number): void {
  if (!canAnimate(dialog) || reducedMotion()) return;
  const { keyframes, duration } = springKeyframes({ response: 0.24 }, progress => ({ opacity: opacityLead(progress), transform: `translate(${px(x * (1 - progress))}, ${px(4 * (1 - progress))})` }));
  for (const child of dialog.children) play(child as HTMLElement, keyframes, duration, 'linear', delay);
}

/** Observes the shared dialog: materialize on open, morph on reuse, dissolve on close. */
export function installDialogMotion(dialog: HTMLDialogElement): () => void {
  const scrim = sibling(dialog, 'dialog-scrim'), plate = sibling(dialog, 'dialog-plate');
  const nativeClose = dialog.close;
  let rect: Rect | undefined, departed = false;
  stage();

  function arrive(): void {
    departed = false;
    // Mirror any stylesheet that arrived since the last open, so the exit copy is styled on time.
    stage();
    // A hidden scrim computes opacity 1, so a first open fades from 0; a reopen mid-exit continues from what is on screen.
    const wasHidden = scrim.hidden;
    scrim.hidden = false; plate.hidden = false;
    rect = fitPlate(plate, dialog);
    if (!canAnimate(dialog)) return;
    play(scrim, [{ opacity: wasHidden ? 0 : presentation(scrim).opacity }, { opacity: 1 }], reducedMotion() ? 120 : 180, 'ease-out');
    materializeIn(plate, { scale: 0.97, y: 8, spring: { response: 0.26 }, origin: '50% 45%' });
    contentArrives(dialog, 0, 20);
  }
  function depart(): void {
    if (!dialog.open || departed) return;
    departed = true;
    const bounds = rect ?? fitPlate(plate, dialog);
    rect = undefined;
    if (!canAnimate(dialog) || !bounds) { scrim.hidden = true; plate.hidden = true; return; }
    const ghost = ghostOf(dialog, bounds);
    void materializeOut(ghost, { scale: 0.98, y: 6 }).then(() => dismissGhost(ghost));
    plate.style.transformOrigin = '50% 45%';
    void materializeOut(plate, { scale: 0.97, y: 6 }).then(() => { if (!dialog.open) plate.hidden = true; });
    void settle(play(scrim, [{ opacity: presentation(scrim).opacity }, { opacity: 0 }], 140, 'ease-out'), 140).then(() => { if (!dialog.open) scrim.hidden = true; });
  }
  function refit(): void { if (dialog.open && !departed) rect = fitPlate(plate, dialog, rect); }

  dialog.close = function close(this: HTMLDialogElement, returnValue?: string): void { depart(); nativeClose.call(this, returnValue); };
  // Escape closes natively; cancel is the last moment the dialog is still on screen.
  const onCancel = (event: Event): void => { if (!event.defaultPrevented) depart(); };
  const onClose = (): void => { if (!running.has(scrim)) { scrim.hidden = true; plate.hidden = true; } };
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClose);
  window.addEventListener('resize', refit);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : undefined;
  resize?.observe(dialog);
  // Menus and tooltips mount inside the open dialog to share its top layer; they are
  // overlays, not new content, so they must not replay the arrival.
  const overlay = (node: Node) => node instanceof Element && (node.classList.contains('floating-menu') || node.classList.contains('tip-bubble'));
  const contentChanged = (record: MutationRecord) => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => !overlay(node));
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' && record.attributeName === 'open' && dialog.open)) { arrive(); return; }
    if (dialog.open && !departed && records.some(contentChanged)) { refit(); contentArrives(dialog, 8, 0); }
  });
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'], childList: true });
  return () => {
    observer.disconnect(); resize?.disconnect();
    window.removeEventListener('resize', refit);
    dialog.removeEventListener('cancel', onCancel);
    dialog.removeEventListener('close', onClose);
    dialog.close = nativeClose;
    scrim.remove(); plate.remove();
    ghostStage?.host.remove(); ghostStage = undefined;
  };
}

/* Segmented controls: one pill slides between the selected options. */
const groups = new WeakMap<HTMLElement, ResizeObserver>();
export function trackSegment(group: HTMLElement, selected: HTMLElement | null): void {
  if (!group.querySelector(':scope > .segment-thumb')) {
    const thumb = document.createElement('span');
    thumb.className = 'segment-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    group.prepend(thumb);
    group.dataset.segmented = '';
  }
  if (!groups.has(group) && typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => { const current = group.dataset.segmentSelected ? group.querySelector<HTMLElement>(`:scope > ${group.dataset.segmentSelected}`) : null; if (current) place(group, current); });
    observer.observe(group);
    groups.set(group, observer);
  }
  if (!selected || selected.parentElement !== group) { group.style.setProperty('--seg-w', '0px'); return; }
  group.dataset.segmentSelected = selected.hasAttribute('aria-pressed') ? '[aria-pressed="true"]' : selected.hasAttribute('aria-selected') ? '[aria-selected="true"]' : '.selected';
  place(group, selected);
}
// A thumb whose stylesheet turns its transition off jumps to the new spot, so a size FLIP
// would play in the wrong place; it then lands at once instead.
function slides(thumb: HTMLElement): boolean {
  return getComputedStyle(thumb).transitionDuration.split(',').some(value => Number.parseFloat(value) > 0);
}

function place(group: HTMLElement, selected: HTMLElement): void {
  // The pill's size snaps and a `scale` FLIP carries it from the old size, alongside the
  // stylesheet's translate transition: no layout property ever animates.
  const thumb = group.querySelector<HTMLElement>(':scope > .segment-thumb');
  const width = Number.parseFloat(group.style.getPropertyValue('--seg-w')) || 0, height = Number.parseFloat(group.style.getPropertyValue('--seg-h')) || 0;
  if (thumb && group.dataset.segmentReady !== undefined && width && height && selected.offsetWidth && selected.offsetHeight && canAnimate(thumb) && !reducedMotion()
    && group.dataset.segmentLast !== selected.textContent && slides(thumb) && (Math.abs(width - selected.offsetWidth) > 0.5 || Math.abs(height - selected.offsetHeight) > 0.5)) {
    const sx = width / selected.offsetWidth, sy = height / selected.offsetHeight;
    const { keyframes, duration } = springKeyframes({ damping: 1, response: 0.2 }, progress => ({ scale: `${fixed(sx + (1 - sx) * progress)} ${fixed(sy + (1 - sy) * progress)}` }));
    play(thumb, keyframes, duration);
  }
  group.dataset.segmentLast = selected.textContent ?? '';
  group.style.setProperty('--seg-x', px(selected.offsetLeft));
  group.style.setProperty('--seg-y', px(selected.offsetTop));
  group.style.setProperty('--seg-w', px(selected.offsetWidth));
  group.style.setProperty('--seg-h', px(selected.offsetHeight));
  // Settle the first laid-out placement before transitions may run.
  if (group.dataset.segmentReady === undefined && selected.offsetWidth > 0) requestAnimationFrame(() => requestAnimationFrame(() => { group.dataset.segmentReady = ''; }));
}
