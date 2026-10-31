/* Motion for the visual-progress PiP. The rest of PandaCode is instant; this surface
 * animates by request, with element.animate() only (the global transition:none stays), and
 * every helper is a no-op under prefers-reduced-motion. */

export const EASE = 'cubic-bezier(.22,1,.36,1)';
export const still = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function play(el: Element, frames: Keyframe[], duration: number, options: { delay?: number; fill?: FillMode; easing?: string } = {}): Animation | undefined {
  if (still() || typeof el.animate !== 'function') return undefined;
  return el.animate(frames, { duration, delay: options.delay ?? 0, easing: options.easing ?? EASE, fill: options.fill ?? 'backwards' });
}

/** Freeze an element where its animations have it now, then drop them. */
export function settle(el: Element): void {
  for (const animation of el.getAnimations()) {
    try { animation.commitStyles(); } catch { /* not rendered: nothing to keep */ }
    animation.cancel();
  }
}

const fades = new WeakMap<Element, Animation>(), heights = new WeakMap<Element, Animation>();

/** Fade to `to` from wherever the opacity is now. */
export function fadeTo(el: HTMLElement, to: number, duration = 320): void {
  const from = Number(getComputedStyle(el).opacity);
  fades.get(el)?.cancel();
  el.style.opacity = to === 1 ? '' : String(to);
  if (Math.abs(from - to) < 0.01) return;
  const animation = play(el, [{ opacity: from }, { opacity: to }], duration);
  if (animation) fades.set(el, animation);
}

/** Glide the element's height from `from` px to its current height. */
export function flipHeight(el: HTMLElement, from: number): void {
  heights.get(el)?.cancel();
  const to = el.offsetHeight;
  if (Math.abs(to - from) < 2) return;
  const animation = play(el, [{ height: `${from}px` }, { height: `${to}px` }], 300);
  if (animation) heights.set(el, animation);
}
