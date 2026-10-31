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

/** The identity of a filter list, so a material can form from clear glass. */
function clearFilter(filter: string): string | undefined {
  if (!filter || filter === 'none') return undefined;
  const identities: Record<string, string> = { blur: '0px', saturate: '1', brightness: '1', contrast: '1', opacity: '1', grayscale: '0', sepia: '0', invert: '0', 'hue-rotate': '0deg' };
  let valid = true;
  const cleared = filter.replace(/([a-z-]+)\(([^)]*)\)/g, (_, name: string) => {
    const identity = identities[name];
    if (identity === undefined) valid = false;
    return `${name}(${identity})`;
  });
  return valid ? cleared : undefined;
}
/** Interpolates two filter lists that share the same functions in the same order. */
function mixFilter(from: string, to: string, progress: number): string {
  const numbers = (value: string): number[] => (value.match(/-?[\d.]+/g) ?? []).map(Number);
  const a = numbers(from), b = numbers(to);
  let index = 0;
  return to.replace(/-?[\d.]+/g, () => { const i = index++; const start = a[i] ?? 0, end = b[i] ?? 0; return String(Math.round((start + (end - start) * progress) * 1000) / 1000); });
}
const filterShape = (filter: string): string => filter.replace(/\([^)]*\)/g, '');
function backdropOf(element: HTMLElement, style = getComputedStyle(element)): string {
  return style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') || 'none';
}
const backdropFrame = (filter: string): Keyframe => ({ backdropFilter: filter, webkitBackdropFilter: filter });

type Presentation = { opacity: number; scale: number; x: number; y: number; backdrop: string };
/** What is on screen right now, including any animation in flight. */
function presentation(element: HTMLElement): Presentation {
  const style = getComputedStyle(element);
  const matrix = style.transform.match(/matrix\(([^)]+)\)/);
  const [a = 1, , , d = 1, e = 0, f = 0] = matrix ? matrix[1].split(',').map(Number) : [];
  return { opacity: Number(style.opacity), scale: (a + d) / 2, x: e, y: f, backdrop: backdropOf(element, style) };
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

/** Glass arrives as a material: its blur condenses while it scales and rises into place.
 *  Interrupting a departure continues from wherever the surface currently is. */
export function materializeIn(element: HTMLElement, { scale = 0.97, x = 0, y = 6, spring = { response: 0.24 }, origin }: Materialize = {}): Animation | undefined {
  if (!canAnimate(element)) return undefined;
  if (origin) element.style.transformOrigin = origin;
  const live = running.has(element) ? presentation(element) : undefined;
  running.get(element)?.cancel();
  if (reducedMotion()) return play(element, [{ opacity: live?.opacity ?? 0 }, { opacity: 1 }], 120, 'ease-out');
  const target = backdropOf(element), clear = clearFilter(target);
  const start = {
    opacity: live?.opacity ?? 0, scale: live?.scale ?? scale, x: live?.x ?? x, y: live?.y ?? y,
    backdrop: clear ? (live && filterShape(live.backdrop) === filterShape(target) ? live.backdrop : clear) : undefined,
  };
  // Opacity leads the spring and blur leads it harder, so nothing bleeds through mid-flight.
  const blurLead = (progress: number): number => Math.max(0, Math.min(1, progress * 2.2));
  const { keyframes, duration } = springKeyframes(spring, progress => ({
    opacity: start.opacity + (1 - start.opacity) * opacityLead(progress),
    transform: `translate(${px(start.x * (1 - progress))}, ${px(start.y * (1 - progress))}) scale(${fixed(start.scale + (1 - start.scale) * progress)})`,
    ...(start.backdrop ? backdropFrame(progress >= 1 ? target : mixFilter(start.backdrop, target, blurLead(progress))) : {}),
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
  const clear = clearFilter(live.backdrop);
  if (clear) { Object.assign(from, backdropFrame(live.backdrop)); Object.assign(to, backdropFrame(clear)); }
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

/** A view that just became current rises softly into place. */
export function enterView(element: HTMLElement, distance = 6, spring: Spring = { response: 0.26 }): void {
  if (!canAnimate(element) || element.hidden) return;
  if (reducedMotion()) { play(element, [{ opacity: 0 }, { opacity: 1 }], 150, 'ease-out'); return; }
  const { keyframes, duration } = springKeyframes(spring, progress => ({ opacity: opacityLead(progress), transform: `translateY(${px(distance * (1 - progress))}) scale(${fixed(0.99 + 0.01 * progress)})` }));
  play(element, keyframes, duration);
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
    scrim.hidden = false; plate.hidden = false;
    rect = fitPlate(plate, dialog);
    if (!canAnimate(dialog)) return;
    play(scrim, [{ opacity: presentation(scrim).opacity }, { opacity: 1 }], reducedMotion() ? 120 : 180, 'ease-out');
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
function place(group: HTMLElement, selected: HTMLElement): void {
  // The pill's size snaps and a `scale` FLIP carries it from the old size, alongside the
  // stylesheet's translate transition: no layout property ever animates.
  const thumb = group.querySelector<HTMLElement>(':scope > .segment-thumb');
  const width = Number.parseFloat(group.style.getPropertyValue('--seg-w')) || 0, height = Number.parseFloat(group.style.getPropertyValue('--seg-h')) || 0;
  if (thumb && group.dataset.segmentReady !== undefined && width && height && selected.offsetWidth && selected.offsetHeight && canAnimate(thumb) && !reducedMotion()
    && (Math.abs(width - selected.offsetWidth) > 0.5 || Math.abs(height - selected.offsetHeight) > 0.5)) {
    const sx = width / selected.offsetWidth, sy = height / selected.offsetHeight;
    const { keyframes, duration } = springKeyframes({ damping: 1, response: 0.28 }, progress => ({ scale: `${fixed(sx + (1 - sx) * progress)} ${fixed(sy + (1 - sy) * progress)}` }));
    play(thumb, keyframes, duration);
  }
  group.style.setProperty('--seg-x', px(selected.offsetLeft));
  group.style.setProperty('--seg-y', px(selected.offsetTop));
  group.style.setProperty('--seg-w', px(selected.offsetWidth));
  group.style.setProperty('--seg-h', px(selected.offsetHeight));
  // Settle the first laid-out placement before transitions may run.
  if (group.dataset.segmentReady === undefined && selected.offsetWidth > 0) requestAnimationFrame(() => requestAnimationFrame(() => { group.dataset.segmentReady = ''; }));
}
