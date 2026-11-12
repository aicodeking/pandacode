// Opens a task from a row: in the iPhone Duo's sidebar as `sidebarOpen` decided (back to the root first
// over a feature screen, or a replace when nothing can be dismissed, so the stack never grows), elsewhere a plain push.
import { router, type Href } from 'expo-router';
import { DISMISS_SETTLE_MS, runSidebarSteps, settles, sidebarSteps, type SidebarOpen } from './sidebar-nav.ts';

const CLOCK = { now: () => Date.now(), frame: (run: () => void) => { requestAnimationFrame(run); } };

/** Opens `href` as a sidebar pick; a dismiss a discard guard blocked leaves the stack as it was. */
export function openFromSidebar(href: Href, how?: SidebarOpen): void {
  void runSidebarSteps(sidebarSteps(how, router.canDismiss()), {
    replace: () => router.replace(href),
    dismissAll: () => router.dismissAll(),
    push: () => router.push(href),
    // Landed once nothing is left to dismiss; still dismissable past the window, a guard kept it.
    dismissed: () => settles(() => !router.canDismiss(), DISMISS_SETTLE_MS, CLOCK),
  });
}
