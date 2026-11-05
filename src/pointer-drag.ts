/** Drags inside the window, driven by the pointer. Tauri's file-drop handler claims every drag at the native view (wry never
 * passes `draggingEntered:` or `draggingUpdated:` on to WKWebView), so `dragstart` fires and `dragover` and `drop` never do.
 * Turning the handler off would lose real paths on OS file drops, which stay native. So a drag that starts on our own
 * `draggable=true` element is cancelled before it reaches the OS and replayed from the pointer as the same DOM events:
 * every handler keeps listening for `dragstart`, `dragover`, `drop` and `dragend`, and the preview runs this same path. */
const GHOST_OFFSET = 12;

const ghostFor = (source: Element, x: number, y: number): HTMLElement => {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = (source.querySelector('.task-title, .thread-tile-name, .queue-text') ?? source).textContent?.trim() ?? '';
  ghost.style.translate = `${x + GHOST_OFFSET}px ${y + GHOST_OFFSET}px`;
  document.body.append(ghost);
  return ghost;
};

function replay(source: Element, target: EventTarget, startX: number, startY: number): void {
  const data = new DataTransfer();
  const init = (x: number, y: number, relatedTarget: Element | null = null): DragEventInit => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, relatedTarget, dataTransfer: data });
  if (!target.dispatchEvent(new DragEvent('dragstart', init(startX, startY)))) return;
  const root = document.documentElement, ghost = ghostFor(source, startX, startY);
  root.toggleAttribute('data-pointer-drag', true);
  let over: Element | null = null, accepted = false, x = startX, y = startY;

  const moveTo = (nextX: number, nextY: number): void => {
    x = nextX; y = nextY;
    ghost.style.translate = `${x + GHOST_OFFSET}px ${y + GHOST_OFFSET}px`;
    const under = document.elementFromPoint(x, y);
    if (under !== over) {
      over?.dispatchEvent(new DragEvent('dragleave', init(x, y, under)));
      under?.dispatchEvent(new DragEvent('dragenter', init(x, y, over)));
      over = under;
    }
    // As in a native drag, a drop lands only where the last dragover accepted it.
    accepted = over ? !over.dispatchEvent(new DragEvent('dragover', init(x, y))) : false;
  };
  const move = (event: PointerEvent): void => {
    // The button came up where we could not see it (outside the window).
    if (event.buttons) moveTo(event.clientX, event.clientY); else finish(false);
  };
  // A quick flick can release before any move reached here: the release is a position too.
  const up = (event: PointerEvent): void => { moveTo(event.clientX, event.clientY); finish(accepted); };
  const cancel = (): void => finish(false);
  const key = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation();
    finish(false);
  };
  const stopSelection = (event: Event): void => event.preventDefault();
  function finish(drop: boolean): void {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('selectstart', stopSelection);
    root.removeAttribute('data-pointer-drag');
    ghost.remove();
    if (drop) over?.dispatchEvent(new DragEvent('drop', init(x, y)));
    else over?.dispatchEvent(new DragEvent('dragleave', init(x, y)));
    (source.isConnected ? source : document).dispatchEvent(new DragEvent('dragend', init(x, y)));
    // The release is on some control: a native drag never clicks it, so neither does this one.
    const swallow = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true));
  }
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('selectstart', stopSelection);
}

/** Selected text and links are left to the browser: only our own draggable elements are replayed. */
export function installPointerDrag(): void {
  if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') return;
  window.addEventListener('dragstart', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const source = event.target.closest('[draggable="true"]');
    if (!source) return;
    event.preventDefault(); event.stopPropagation();
    // Once this event is over: other listeners on the window must see it, cancelled, before they see the replay.
    const { target, clientX, clientY } = event;
    setTimeout(() => replay(source, target, clientX, clientY));
  }, true);
}
