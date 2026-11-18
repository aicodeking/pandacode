import './sidebar-resize.css';

/** The grid track an element fills: its box plus horizontal margins (the inset shell's panels sit inside their tracks). */
function trackWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  // offsetWidth ignores transforms, so a panel mid-entrance (scaled) reads its real width.
  return element.offsetWidth + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
}

/** Resize the existing grid track without rebuilding navigation or conversation UI. */
export function initializeSidebarResizing(workspace: HTMLElement, sidebar: HTMLElement, right = false): () => void {
  const preferenceKey = right ? 'pandacode.inspectorWidth' : 'pandacode.sidebarWidth';
  const widthProperty = right ? '--inspector-width' : '--sidebar-width';
  const minimumWidth = right ? 270 : 190;
  const maximumWidth = right ? 10000 : 440;
  const resizingClass = right ? 'inspector-resizing' : 'sidebar-resizing';
  let preferredWidth: number | undefined;
  try {
    const saved = localStorage.getItem(preferenceKey);
    const width = saved === null ? NaN : Number(saved);
    if (Number.isFinite(width) && width >= minimumWidth && width <= maximumWidth) preferredWidth = width;
  } catch { /* Width still works when storage is unavailable. */ }

  const separator = document.createElement('div');
  separator.className = right ? 'inspector-resize-handle' : 'sidebar-resize-handle';
  separator.tabIndex = 0;
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-orientation', 'vertical');
  separator.setAttribute('aria-label', right ? 'Resize right sidebar' : 'Resize sidebar');
  separator.setAttribute('aria-description', 'Use Left and Right arrows to resize. Hold Shift for larger steps. Home and End select the smallest and largest size. Double-click to reset.');
  separator.title = `${right ? 'Resize right sidebar' : 'Resize sidebar'} · Double-click to reset`;
  if (!sidebar.id) sidebar.id = 'workspace-sidebar';
  separator.setAttribute('aria-controls', sidebar.id);
  sidebar.append(separator);

  const compact = matchMedia('(max-width: 650px)');
  const inspector = workspace.querySelector<HTMLElement>(right ? ':scope > .sidebar' : ':scope > .inspector');
  let width = 235, availableMinimum = minimumWidth, availableMaximum = maximumWidth, layoutFrame = 0;
  let drag: { id: number; startX: number; startWidth: number; moved: boolean } | undefined;
  const clamp = (value: number) => Math.round(Math.min(availableMaximum, Math.max(availableMinimum, value)));

  function paint(value: number, responsive = false): void {
    width = clamp(value);
    const valueInPixels = responsive ? '' : `${width}px`;
    if (workspace.style.getPropertyValue(widthProperty) !== valueInPixels) {
      workspace.style.setProperty(widthProperty, valueInPixels);
      // Menus and native browser bounds share this existing layout notification.
      if (!layoutFrame) layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        window.dispatchEvent(new Event('resize'));
      });
    }
    separator.setAttribute('aria-valuemin', String(availableMinimum));
    separator.setAttribute('aria-valuemax', String(availableMaximum));
    separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuetext', `${width} pixels`);
  }

  function persist(): void {
    try {
      if (preferredWidth === undefined) localStorage.removeItem(preferenceKey);
      else localStorage.setItem(preferenceKey, String(preferredWidth));
    } catch { /* Keep the current width for this session. */ }
  }

  function refreshConstraints(): void {
    const unavailable = sidebar.hidden || (!right && (compact.matches || workspace.classList.contains('board-view')));
    separator.hidden = unavailable;
    if (unavailable && drag) finishDrag(false);
    if (unavailable) return;

    const style = getComputedStyle(workspace);
    const conversationMinimum = parseFloat(style.getPropertyValue('--conversation-min-width')) || 420;
    const defaultWidth = parseFloat(style.getPropertyValue('--sidebar-default-width')) || 235;
    let inspectorWidth = 0;
    if (inspector && !inspector.hidden && (right || !workspace.classList.contains('inspector-closed'))) {
      const inspectorStyle = getComputedStyle(inspector);
      if (inspectorStyle.display !== 'none' && inspectorStyle.position !== 'absolute') inspectorWidth = trackWidth(inspector);
    }
    const overlay = right && getComputedStyle(sidebar).position === 'absolute';
    const remaining = Math.floor(workspace.clientWidth - inspectorWidth - (overlay ? 0 : conversationMinimum));
    availableMinimum = right ? Math.min(minimumWidth, Math.max(1, remaining)) : minimumWidth;
    availableMaximum = Math.max(availableMinimum, Math.min(maximumWidth, remaining));
    // A temporary viewport/inspector clamp must never replace the saved choice.
    if (right && preferredWidth === undefined && !drag) {
      // Keep the wider Browser default and responsive overlay sizes until resized.
      workspace.style.removeProperty(widthProperty);
      paint(trackWidth(sidebar), true);
    } else paint(drag ? width : preferredWidth ?? defaultWidth);
  }

  function finishDrag(commit: boolean): void {
    if (!drag) return;
    const finished = drag;
    drag = undefined;
    workspace.classList.remove(resizingClass);
    if (separator.hasPointerCapture(finished.id)) separator.releasePointerCapture(finished.id);
    if (commit && finished.moved) {
      preferredWidth = width;
      persist();
    }
    refreshConstraints();
  }

  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || separator.hidden || drag) return;
    event.preventDefault();
    refreshConstraints();
    drag = { id: event.pointerId, startX: event.clientX, startWidth: trackWidth(sidebar), moved: false };
    separator.setPointerCapture(event.pointerId);
    separator.focus({ preventScroll: true });
    workspace.classList.add(resizingClass);
  }

  function pointerMove(event: PointerEvent): void {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    drag.moved ||= distance !== 0;
    paint(drag.startWidth + distance * (right ? -1 : 1));
  }

  function pointerUp(event: PointerEvent): void {
    if (drag?.id === event.pointerId) finishDrag(true);
  }

  function pointerCancel(event: PointerEvent): void {
    if (drag?.id === event.pointerId) finishDrag(false);
  }

  function keyDown(event: KeyboardEvent): void {
    if (separator.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finishDrag(false);
      return;
    }
    const step = (event.shiftKey ? 32 : 8) * (right ? -1 : 1);
    const next = event.key === 'ArrowLeft' ? width - step
      : event.key === 'ArrowRight' ? width + step
      : event.key === 'Home' ? availableMinimum
      : event.key === 'End' ? availableMaximum : undefined;
    if (next === undefined) return;
    event.preventDefault();
    paint(next);
    preferredWidth = width;
    persist();
  }

  function reset(): void {
    if (separator.hidden) return;
    finishDrag(false);
    preferredWidth = undefined;
    persist();
    refreshConstraints();
  }

  const resize = new ResizeObserver(refreshConstraints);
  resize.observe(workspace);
  // Lazy browser styles can change this track after the workspace class has changed.
  if (inspector) resize.observe(inspector);
  if (right) resize.observe(sidebar);
  const layout = new MutationObserver(refreshConstraints);
  layout.observe(workspace, { attributes: true, attributeFilter: ['class'] });
  layout.observe(sidebar, { attributes: true, attributeFilter: ['hidden'] });
  if (right && inspector) layout.observe(inspector, { attributes: true, attributeFilter: ['hidden'] });
  compact.addEventListener('change', refreshConstraints);
  separator.addEventListener('pointerdown', pointerDown);
  separator.addEventListener('pointermove', pointerMove);
  separator.addEventListener('pointerup', pointerUp);
  separator.addEventListener('pointercancel', pointerCancel);
  separator.addEventListener('lostpointercapture', pointerUp);
  separator.addEventListener('keydown', keyDown);
  separator.addEventListener('dblclick', reset);
  refreshConstraints();

  return () => {
    finishDrag(false);
    resize.disconnect();
    layout.disconnect();
    compact.removeEventListener('change', refreshConstraints);
    cancelAnimationFrame(layoutFrame);
    separator.remove();
    workspace.style.removeProperty(widthProperty);
  };
}
