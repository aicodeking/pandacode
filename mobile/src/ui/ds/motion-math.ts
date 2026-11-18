// Pure motion numbers, apart from Reanimated so tests can run them.

export const STAGGER_CAP = 8;
export const STAGGER_STEP_MS = 30;

/** The entrance delay for a list item, or null past the cap: later items appear without an entrance. */
export function staggerDelay(index: number): number | null {
  if (index >= STAGGER_CAP) return null;
  return Math.max(0, index) * STAGGER_STEP_MS;
}

/** Apple's spring parameters (response in seconds, damping ratio) as mass, stiffness and damping. */
export function springParams(response: number, dampingRatio = 1) {
  const omega = (2 * Math.PI) / response;
  return { mass: 1, stiffness: omega * omega, damping: 2 * dampingRatio * omega };
}
