/* Keyboard reach for the one app toast (#toast, a polite role="status" region at the end of the page):
 * F6 moves focus to its first button and back again, so its actions are reachable without tabbing
 * through the page; Escape inside it closes a toast that has a close button, or just leaves a
 * toast without one. Escape only works with focus in the toast (elsewhere it belongs to the page:
 * it stops a running agent), so the close button promises it only then, and Escape pressed inside
 * the toast never reaches the page. Focus goes back to where it was once a button in the toast
 * has done its work; leaving by key with no such place (focus came in by a click) goes to the composer. */
import { icon, isImeKey } from './dom';

export const TOAST_SHORTCUT = 'F6';
/** Where keyboard focus leaves the toast for when it has no place of its own to go back to. */
const COMPOSER = '#prompt';
/** Keys are announced through aria-keyshortcuts (F6, and Escape while it works), never in a tooltip. */
export const DISMISS_LABEL = 'Dismiss';

/** Appends the close button; notify() calls it for every toast. */
export function addToastClose(toast: HTMLElement, close: () => void): void {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'toast-close'; button.setAttribute('aria-label', DISMISS_LABEL);
  button.innerHTML = icon('close');
  button.addEventListener('click', close);
  toast.append(button);
}

/** Announces F6 on the button it focuses (the first), and Escape on the close button while focus
 * is in the toast (the only time it dismisses). Called when the toast is filled and as focus moves. */
export function labelToastShortcut(toast: HTMLElement): void {
  const first = toast.querySelector<HTMLButtonElement>('button'), close = toast.querySelector<HTMLButtonElement>('.toast-close');
  const escape = close && toast.contains(document.activeElement);
  for (const button of new Set([first, close])) {
    if (!button) continue;
    // A button's own shortcuts (Undo's) stay.
    const own = (button.getAttribute('aria-keyshortcuts') ?? '').split(' ').filter(key => key && key !== 'Escape' && key !== TOAST_SHORTCUT);
    const keys = [...own, ...(button === close && escape ? ['Escape'] : []), ...(button === first ? [TOAST_SHORTCUT] : [])];
    if (keys.length) button.setAttribute('aria-keyshortcuts', keys.join(' ')); else button.removeAttribute('aria-keyshortcuts');
  }
}

export function wireToastKeys(toast: HTMLElement): void {
  let returnTo: HTMLElement | undefined;
  const firstButton = () => toast.hidden ? null : toast.querySelector<HTMLButtonElement>('button');
  /** `fallback`: leaving by key (F6, Escape) goes to the composer when nothing was recorded (focus
   * came in by a click or Tab) or the recorded element is gone or no longer takes focus. */
  const goBack = (fallback = false) => {
    const target = returnTo;
    returnTo = undefined;
    if (!toast.contains(document.activeElement) && document.activeElement !== document.body) return;
    for (const element of [target, fallback ? document.querySelector<HTMLElement>(COMPOSER) : null]) {
      if (!element?.isConnected) continue;
      element.focus({ preventScroll: true });
      if (document.activeElement === element) return;
    }
  };
  document.addEventListener('keydown', event => {
    if (event.key !== TOAST_SHORTCUT || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isImeKey(event)) return;
    if (toast.contains(document.activeElement)) { event.preventDefault(); goBack(true); return; }
    const button = firstButton();
    if (!button) return;
    const from = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
    button.focus({ preventScroll: true });
    // A modal dialog makes the toast inert: focus stays put and F6 is left alone.
    if (document.activeElement !== button) return;
    event.preventDefault();
    returnTo = from;
  }, true);
  // Escape with focus in the toast is meant for the toast: it never goes on to stop a running agent.
  toast.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || isImeKey(event)) return;
    event.preventDefault(); event.stopPropagation();
    const close = toast.querySelector<HTMLButtonElement>('.toast-close');
    // After the click's own goBack: a toast entered by a click leaves focus in the composer, not on the page.
    if (close) { close.click(); queueMicrotask(() => goBack(true)); } else goBack(true);
  });
  toast.addEventListener('focusin', () => labelToastShortcut(toast));
  toast.addEventListener('focusout', event => { if (!toast.contains(event.relatedTarget as Node | null)) queueMicrotask(() => labelToastShortcut(toast)); });
  // After the click handlers ran (the toast is on its way out).
  toast.addEventListener('click', event => { if ((event.target as Element).closest('button')) queueMicrotask(goBack); });
}
