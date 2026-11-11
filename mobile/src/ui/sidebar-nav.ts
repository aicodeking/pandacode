// The iPhone Duo sidebar's navigation, decided from the root Stack's routes so it holds on any screen:
// the highlighted task is the nearest task route in the stack (Changes, Files... pushed over it keep it
// lit), and picking a task never grows the stack: over the open task it replaces it, over a feature
// screen it goes back to the root first, then opens the task.
// Pure (tests/sidebar.test.ts); Sidebar.tsx's openFromSidebar acts on it.

export const TASK_ROUTE = 'task/[device]/[session]';
/** The tab navigator's route in the root Stack: what everything else is pushed over. */
const ROOT_ROUTE = '(tabs)';

export interface StackRoute { name: string; params?: object; state?: StackState }
export interface StackState { index?: number; routes: readonly StackRoute[] }

/** How a sidebar pick opens: over the root, over the open task alone, or over anything else. */
export type SidebarOpen = 'push' | 'replace' | 'reset';

/** The root Stack's state inside the container's (expo-router may wrap it in a single route). */
export function rootStack(state: StackState | undefined): StackState | undefined {
  let current = state;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.routes.some(r => r.name === ROOT_ROUTE || r.name === TASK_ROUTE)) return current;
    current = current.routes[current.index ?? current.routes.length - 1]?.state;
  }
  return undefined;
}

/** The routes up to and including the focused one (a stack's later routes are being popped). */
const shown = (stack: StackState) => stack.routes.slice(0, (stack.index ?? stack.routes.length - 1) + 1);

export function sidebarOpen(stack: StackState | undefined): SidebarOpen {
  const routes = stack ? shown(stack) : [];
  const above = routes.filter(r => r.name !== ROOT_ROUTE);
  if (!above.length) return 'push';
  return above.length === 1 && above[0].name === TASK_ROUTE ? 'replace' : 'reset';
}

/** `device/session` of the nearest task under the focused screen, or '' with none in the stack. */
export function sidebarSelection(stack: StackState | undefined): string {
  const routes = stack ? shown(stack) : [];
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    const params = route.params as { device?: unknown; session?: unknown } | undefined;
    if (route.name === TASK_ROUTE && typeof params?.device === 'string' && typeof params.session === 'string') return `${params.device}/${params.session}`;
  }
  return '';
}

/** The router calls a pick makes: `how` undefined is a row outside the sidebar (the inbox, search), a push. */
export type SidebarStep = 'replace' | 'dismissAll' | 'push';
export function sidebarSteps(how: SidebarOpen | undefined, canDismiss: boolean): SidebarStep[] {
  if (how === 'replace') return ['replace'];
  // A reset with nothing to dismiss still must not grow the stack: replace the focused screen.
  if (how === 'reset') return canDismiss ? ['dismissAll', 'push'] : ['replace'];
  return ['push'];
}

/** How long a pick waits for its dismiss to land before taking it as prevented. expo-router queues router
 * calls and applies them after a render, so the stack can't be read right after dismissAll(). A prevented
 * dismiss shows the discard alert, which nobody answers this fast. */
export const DISMISS_SETTLE_MS = 400;

/** The router calls `runSidebarSteps` makes; `dismissed` resolves once the dismiss landed, false when a
 * screen prevented it. */
export interface SidebarRouter { replace(): void; dismissAll(): void; push(): void; dismissed(): Promise<boolean> }

/** Makes a pick's calls in order. A dismiss a screen's discard guard prevented (usePreventRemove blocks
 * the whole pop) ends the pick there: pushing anyway would open the task over the dirty screen. The
 * guard's Discard then pops, and the user picks again. Resolves whether the pick went through. */
export async function runSidebarSteps(steps: readonly SidebarStep[], nav: SidebarRouter): Promise<boolean> {
  for (const step of steps) {
    if (step === 'replace') nav.replace();
    else if (step === 'push') nav.push();
    else {
      nav.dismissAll();
      if (!(await nav.dismissed())) return false;
    }
  }
  return true;
}

/** Resolves true on the first frame `done()` holds, false once `timeoutMs` passes without it. */
export function settles(done: () => boolean, timeoutMs: number, clock: { now(): number; frame(run: () => void): void }): Promise<boolean> {
  const deadline = clock.now() + timeoutMs;
  return new Promise(resolve => {
    const check = () => {
      if (done()) resolve(true);
      else if (clock.now() >= deadline) resolve(false);
      else clock.frame(check);
    };
    clock.frame(check);
  });
}
