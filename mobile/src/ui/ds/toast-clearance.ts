// The room a toast leaves under itself above the safe area (or keyboard): the tallest bottom dock a
// focused screen registered (useToastClearance in Toast.tsx) or its tab bar (useTabBarClearance), else
// a fixed allowance for the composer or tab bar, none on the iPhone Duo's rail. Pure, so it is testable
// without React Native.

/** Registered dock heights by registration id. */
export type Clearances = Readonly<Record<number, number>>;

/** The tallest registered height, or `fallback` with none registered (non-finite or negative ignored). */
export function toastClearance(registered: Clearances, fallback: number): number {
  const heights = Object.values(registered).filter(h => Number.isFinite(h) && h >= 0);
  return heights.length ? Math.max(...heights) : fallback;
}

/** `registered` with `id` at `height` (null removes it); the same object when nothing changes. */
export function withClearance(registered: Clearances, id: number, height: number | null): Clearances {
  if (height === null) {
    if (!(id in registered)) return registered;
    const { [id]: _gone, ...rest } = registered;
    return rest;
  }
  return registered[id] === height ? registered : { ...registered, [id]: height };
}

/** The tab bar's height over the window's safe area: the bottom inset measured inside the tab
 * controller (tab bar plus home indicator) less the window's. 0 when the bar isn't at the bottom (the
 * Duo's side rail); bad values count as 0. */
export function tabBarClearance(tabInset: number, windowInset: number): number {
  const height = tabInset - windowInset;
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/** The allowance with nothing registered: the default off the Duo, none on its rail (no bottom tab bar;
 * a composer registers its own dock). */
export const fallbackClearance = (railed: boolean, fallback: number): number => (railed ? 0 : fallback);

/** A toast hidden (`id`, or whichever shows when undefined): the one left showing, and the one gone
 * without its action, whose onDismiss runs. A stale id (that toast already replaced) hides nothing. */
export function dismissal<T extends { id: number }>(current: T | null, id?: number): { next: T | null; gone: T | null } {
  if (!current || (id !== undefined && current.id !== id)) return { next: current, gone: null };
  return { next: null, gone: current };
}

/** How long a toast stays: null (no timer) for a sticky one, which waits for hideToast. */
export const toastDuration = (sticky: boolean | undefined, reader: boolean, ms: number, readerMs: number): number | null =>
  (sticky ? null : reader ? readerMs : ms);
