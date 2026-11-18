import { icon, isImeKey } from './dom';

export function createFileWindow(pane: HTMLElement, hide: () => void, focusFallback: () => void) {
  pane.classList.add('file-window');
  pane.setAttribute('aria-label', 'File editor');
  pane.dataset.tauriDragRegion = 'false';
  pane.tabIndex = -1;
  pane.insertAdjacentHTML('afterbegin', `<div class="file-window-heading" tabindex="0" aria-label="Move editor"><span>${icon('edit')}Editor</span><div><button class="icon-button" data-file-window="maximize" aria-label="Maximize editor"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button><button class="icon-button" data-file-window="close" aria-label="Hide editor">${icon('close')}</button></div></div>`);
  pane.insertAdjacentHTML('beforeend', '<div class="file-window-resize" role="separator" tabindex="0" aria-label="Resize editor" aria-orientation="horizontal"></div>');
  const heading = pane.querySelector<HTMLElement>('.file-window-heading')!;
  const grip = pane.querySelector<HTMLElement>('.file-window-resize')!;
  let placed = false, maximized = false, restore: DOMRect | undefined, previousFocus: HTMLElement | null = null;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

  function fit(): void {
    if (pane.hidden) return;
    const box = pane.getBoundingClientRect();
    const width = Math.min(box.width, innerWidth - 32), height = Math.min(box.height, innerHeight - 64);
    pane.style.width = `${width}px`; pane.style.height = `${height}px`;
    pane.style.left = `${clamp(box.left, 16, innerWidth - width - 16)}px`;
    pane.style.top = `${clamp(box.top, 48, innerHeight - height - 16)}px`;
    grip.setAttribute('aria-valuenow', String(Math.round(height)));
    grip.setAttribute('aria-valuemin', String(Math.min(240, innerHeight - 64)));
    grip.setAttribute('aria-valuemax', String(innerHeight - 64));
  }
  function maximize(): void {
    if (!maximized) {
      restore = pane.getBoundingClientRect();
      pane.style.left = '16px'; pane.style.top = '48px';
      pane.style.width = `${innerWidth - 32}px`; pane.style.height = `${innerHeight - 64}px`;
    } else if (restore) {
      pane.style.left = `${restore.left}px`; pane.style.top = `${restore.top}px`;
      pane.style.width = `${restore.width}px`; pane.style.height = `${restore.height}px`;
    }
    maximized = !maximized;
    pane.querySelector('[data-file-window="maximize"]')!.setAttribute('aria-label', maximized ? 'Restore editor' : 'Maximize editor');
    fit();
  }
  pane.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLElement>('[data-file-window]')?.dataset.fileWindow;
    if (action === 'close') hide();
    if (action === 'maximize') maximize();
  });
  heading.addEventListener('dblclick', event => { if (!(event.target as Element).closest('button')) maximize(); });
  function drag(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const handle = event.currentTarget as HTMLElement, resizing = handle === grip;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const box = pane.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    const move = (next: PointerEvent) => {
      if (resizing) pane.style.height = `${clamp(box.height + next.clientY - y, Math.min(240, innerHeight - 64), innerHeight - box.top - 16)}px`;
      else { pane.style.left = `${box.left + next.clientX - x}px`; pane.style.top = `${box.top + next.clientY - y}px`; }
      fit();
    };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', end); };
    handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', end);
  }
  heading.addEventListener('pointerdown', drag); grip.addEventListener('pointerdown', drag);
  heading.addEventListener('keydown', event => {
    if (event.target !== heading || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    pane.style.left = `${pane.offsetLeft + (event.key === 'ArrowRight' ? 32 : event.key === 'ArrowLeft' ? -32 : 0)}px`;
    pane.style.top = `${pane.offsetTop + (event.key === 'ArrowDown' ? 32 : event.key === 'ArrowUp' ? -32 : 0)}px`;
    fit();
  });
  grip.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    pane.style.height = `${clamp(pane.offsetHeight + (event.key === 'ArrowDown' ? 32 : -32), Math.min(240, innerHeight - 64), innerHeight - pane.offsetTop - 16)}px`; fit();
  });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && !isImeKey(event)) { event.preventDefault(); hide(); } if (event.defaultPrevented) event.stopPropagation(); });
  const resize = new ResizeObserver(fit); resize.observe(pane);
  window.addEventListener('resize', fit);
  return {
    show(): void {
      const wasHidden = pane.hidden;
      if (wasHidden) previousFocus = document.activeElement as HTMLElement;
      pane.hidden = false;
      if (!placed) {
        const box = document.querySelector('.main-pane')!.getBoundingClientRect();
        const width = Math.min(960, Math.max(480, box.width - 112), innerWidth - 32), height = Math.min(640, innerHeight - 112);
        pane.style.width = `${width}px`; pane.style.height = `${height}px`;
        pane.style.left = `${box.left + Math.max(16, (box.width - width - 64) / 2)}px`; pane.style.top = `${Math.max(48, box.top + 48)}px`; placed = true;
      }
      fit(); if (wasHidden) pane.focus({ preventScroll: true });
    },
    hide(): void {
      const focused = pane.contains(document.activeElement);
      pane.hidden = true;
      if (focused) {
        if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
        else focusFallback();
      }
    },
  };
}
