/** Whether PandaCode's window has focus, read from the native window rather than the page. While the in-app browser (a
 * native child webview, `browser.rs`) holds focus, the page's `document.hasFocus()` is false and no pointer or key event
 * reaches it, yet the user is still working in this window. In the app, Tauri reports the native window's focus (its
 * `isFocused()` once, then its focus-changed events); reads are synchronous and return the last report. The browser
 * preview has no native window and reads `document.hasFocus()`. */
type Listener = (focused: boolean) => void;

// Node's unit tests import brand-mark.ts (and so this module) for its pure geometry, where there is no window.
const hasWindow = typeof window !== 'undefined';
const tauri = hasWindow && '__TAURI_INTERNALS__' in window;
const listeners = new Set<Listener>();
/** The native window's last reported focus; undefined until Tauri answers (or if it never does). */
let native: boolean | undefined;
/** Preview only: a spec's stand-in for the native window. */
let override: boolean | undefined;
let started = false;

function report(focused: boolean): void {
  if (native === focused) return;
  native = focused;
  if (override === undefined) for (const listener of listeners) listener(focused);
}

function start(): void {
  if (started || !tauri) return;
  started = true;
  // A focus event in this page means its window holds focus, and it lands before Tauri's event crosses the IPC.
  window.addEventListener('focus', () => report(true));
  let heard = false;
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
    const current = getCurrentWindow();
    await current.onFocusChanged(({ payload }) => { heard = true; report(payload); });
    const focused = await current.isFocused();
    if (!heard) report(focused);
  }).catch(error => {
    // Without the native answer every read falls back to the page's own focus, as before.
    console.warn('PandaCode could not read the window focus; using the page focus instead.', error);
  });
}

/** Whether the window has focus: the native window's in the app, the document's in the preview. */
export function windowFocused(): boolean {
  start();
  return override ?? native ?? document.hasFocus();
}

/** Calls back when the native window gains or loses focus (in the preview, only when a spec sets it). */
export function onWindowFocus(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (hasWindow && !tauri) {
  // Preview only: specs stand in for the native window, e.g. focused while the page itself is not (the in-app browser).
  Object.defineProperty(window, '__windowFocus', { configurable: true, value: {
    set(focused: boolean | null): void {
      override = focused ?? undefined;
      const now = windowFocused();
      for (const listener of listeners) listener(now);
    },
  } });
}
