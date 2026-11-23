import './terminal-resize.css';

const PREFERENCE_KEY = 'pandacode.terminalHeight';
const FALLBACK_HEIGHT = 245;
const MINIMUM_HEIGHT = 150;
/** Room the conversation keeps below the header when no composer shows (board, tiles, maximized). */
const MINIMUM_WORK_AREA = 160;
/** A strip of transcript kept above the composer (the transcript's own padding is 64px). */
const TRANSCRIPT_STRIP = 96;
/** However tall the composer grows (a long prompt, attachments), the terminal may still take half the pane. */
const MAXIMUM_RESERVE_FRACTION = 0.5;

export interface TerminalResizer {
  readonly maximized: boolean;
  toggleMaximize(): void;
  restore(): void;
  destroy(): void;
}

/**
 * The terminal drawer's top edge and Maximize button. The drawer owns its height, so
 * the terminal's own ResizeObserver still refits xterm and the PTY on every change.
 */
export function initializeTerminalResizing(drawer: HTMLElement, mainPane: HTMLElement): TerminalResizer {
  let preferredHeight: number | undefined;
  try {
    const saved = localStorage.getItem(PREFERENCE_KEY);
    const height = saved === null ? NaN : Number(saved);
    if (Number.isFinite(height) && height >= MINIMUM_HEIGHT && height <= 10000) preferredHeight = height;
  } catch { /* Resizing still works when storage is unavailable. */ }

  const separator = document.createElement('div');
  separator.className = 'terminal-resize-handle';
  separator.tabIndex = 0;
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-orientation', 'horizontal');
  separator.setAttribute('aria-label', 'Resize terminal');
  separator.setAttribute('aria-description', 'Use Up and Down arrows to resize. Hold Shift for larger steps. Home and End select the shortest and tallest size. Double-click to reset.');
  separator.title = 'Resize terminal · Double-click to reset';
  separator.setAttribute('aria-controls', drawer.id || 'terminal-drawer');
  drawer.prepend(separator);

  // styles.css owns the default; it still computes while the drawer is hidden.
  const cssDefault = parseFloat(getComputedStyle(drawer).getPropertyValue('--terminal-height'));
  const defaultHeight = Number.isFinite(cssDefault) && cssDefault >= MINIMUM_HEIGHT ? cssDefault : FALLBACK_HEIGHT;
  let height = defaultHeight;
  let availableMaximum = defaultHeight;
  let maximized = false;
  let frame = 0;
  let drag: { id: number; startY: number; startHeight: number; moved: boolean; returnFocus?: HTMLElement } | undefined;
  const header = mainPane.querySelector<HTMLElement>(':scope > .workspace-header');
  const composer = mainPane.querySelector<HTMLElement>('#composer-area');

  const clamp = (value: number) => Math.round(Math.min(availableMaximum, Math.max(MINIMUM_HEIGHT, value)));

  function paint(value: number): void {
    height = clamp(value);
    drawer.style.setProperty('--terminal-height', `${height}px`);
    separator.setAttribute('aria-valuemin', String(MINIMUM_HEIGHT));
    separator.setAttribute('aria-valuemax', String(availableMaximum));
    separator.setAttribute('aria-valuenow', String(height));
    separator.setAttribute('aria-valuetext', `${height} pixels`);
  }

  function persist(): void {
    try {
      if (preferredHeight === undefined) localStorage.removeItem(PREFERENCE_KEY);
      else localStorage.setItem(PREFERENCE_KEY, String(preferredHeight));
    } catch { /* Keep the current height for this session. */ }
  }

  function refreshConstraints(): void {
    // Keep the header, the whole composer and a strip of transcript above the drawer, so the prompt is never under the terminal.
    const pane = mainPane.clientHeight;
    const conversation = composer?.getClientRects().length ? composer.offsetHeight + TRANSCRIPT_STRIP : MINIMUM_WORK_AREA;
    const reserve = (header?.offsetHeight ?? 0) + Math.min(Math.max(MINIMUM_WORK_AREA, conversation), pane * MAXIMUM_RESERVE_FRACTION);
    availableMaximum = Math.max(MINIMUM_HEIGHT, Math.floor(pane - reserve));
    if (maximized) return;
    // Repaint from the preferred height so a temporary narrow window never replaces the saved choice.
    paint(drag ? height : preferredHeight ?? defaultHeight);
  }

  function finishDrag(commit: boolean): void {
    if (!drag) return;
    const finished = drag;
    drag = undefined;
    drawer.classList.remove('terminal-resizing');
    if (separator.hasPointerCapture(finished.id)) separator.releasePointerCapture(finished.id);
    if (commit && finished.moved) {
      preferredHeight = height;
      persist();
    }
    refreshConstraints();
    // A pointer drag borrows focus for Escape; give it back so typing continues in the terminal.
    if (finished.returnFocus?.isConnected && document.activeElement === separator) finished.returnFocus.focus({ preventScroll: true });
  }

  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || maximized || drawer.hidden || drag) return;
    event.preventDefault();
    refreshConstraints();
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && active !== separator && active !== document.body ? active : undefined;
    drag = { id: event.pointerId, startY: event.clientY, startHeight: drawer.getBoundingClientRect().height, moved: false, returnFocus: focused };
    separator.setPointerCapture(event.pointerId);
    separator.focus({ preventScroll: true });
    drawer.classList.add('terminal-resizing');
  }

  function pointerMove(event: PointerEvent): void {
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    const distance = drag.startY - event.clientY;
    drag.moved ||= distance !== 0;
    paint(drag.startHeight + distance);
  }

  function pointerUp(event: PointerEvent): void {
    if (drag?.id === event.pointerId) finishDrag(true);
  }

  /** Also handles `lostpointercapture`: after a real `pointerup` the drag has already finished, so
   * capture lost any other way (the drawer hid mid-drag) cancels instead of saving a partial height. */
  function pointerCancel(event: PointerEvent): void {
    if (drag?.id === event.pointerId) finishDrag(false);
  }

  function keyDown(event: KeyboardEvent): void {
    if (separator.hidden || maximized || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finishDrag(false);
      return;
    }
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === 'ArrowUp' ? height + step
      : event.key === 'ArrowDown' ? height - step
      : event.key === 'Home' ? MINIMUM_HEIGHT
      : event.key === 'End' ? availableMaximum : undefined;
    if (next === undefined) return;
    event.preventDefault();
    paint(next);
    preferredHeight = height;
    persist();
  }

  function reset(): void {
    finishDrag(false);
    preferredHeight = undefined;
    persist();
    paint(defaultHeight);
  }

  function restore(): void {
    if (!maximized) return;
    maximized = false;
    drawer.classList.remove('terminal-maximized');
    mainPane.classList.remove('terminal-maximized');
    separator.hidden = false;
    // The composer is shown again, so measure it before choosing the height.
    refreshConstraints();
  }

  function toggleMaximize(): void {
    if (drawer.hidden) return;
    if (maximized) { restore(); return; }
    maximized = true;
    drawer.classList.add('terminal-maximized');
    mainPane.classList.add('terminal-maximized');
    separator.hidden = true;
  }

  const resize = new ResizeObserver(() => {
    // Coalesce the observer's first callback with the outer window resize.
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; refreshConstraints(); });
  });
  resize.observe(mainPane);
  if (composer) resize.observe(composer);
  separator.addEventListener('pointerdown', pointerDown);
  separator.addEventListener('pointermove', pointerMove);
  separator.addEventListener('pointerup', pointerUp);
  separator.addEventListener('pointercancel', pointerCancel);
  separator.addEventListener('lostpointercapture', pointerCancel);
  separator.addEventListener('keydown', keyDown);
  separator.addEventListener('dblclick', reset);
  refreshConstraints();

  return {
    get maximized() { return maximized; },
    toggleMaximize,
    restore,
    destroy: () => {
      finishDrag(false);
      resize.disconnect();
      cancelAnimationFrame(frame);
      separator.removeEventListener('pointerdown', pointerDown);
      separator.removeEventListener('pointermove', pointerMove);
      separator.removeEventListener('pointerup', pointerUp);
      separator.removeEventListener('pointercancel', pointerCancel);
      separator.removeEventListener('lostpointercapture', pointerCancel);
      separator.removeEventListener('keydown', keyDown);
      separator.removeEventListener('dblclick', reset);
      restore();
      separator.remove();
      drawer.style.removeProperty('--terminal-height');
    },
  };
}
