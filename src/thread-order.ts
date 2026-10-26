import './thread-order.css';

export { compareManual as compareThreadOrder } from './sidebar-sort';

/** Everything in the list that takes focus: rows, folder and section headings, "Show more". */
const STOPS = '.task-item, .folder-heading, .section-toggle, .folder-more';
function stops(nav: HTMLElement): HTMLElement[] {
  return [...nav.querySelectorAll<HTMLElement>(STOPS)].filter(item => !item.closest('[hidden]') && item.getClientRects().length > 0);
}
/** The list is one Tab stop: the open row (or the first one) takes Tab; arrows move between rows. */
export function syncRovingFocus(nav: HTMLElement): void {
  const items = stops(nav), focused = items.find(item => item === document.activeElement);
  const current = focused ?? items.find(item => item.classList.contains('selected')) ?? items[0];
  for (const item of nav.querySelectorAll<HTMLElement>(`${STOPS}, .task-action, .folder-new-task`)) item.tabIndex = item === current ? 0 : -1;
}
function moveFocus(nav: HTMLElement, from: HTMLElement, key: string): boolean {
  const items = stops(nav), index = items.indexOf(from);
  const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : index + (key === 'ArrowUp' ? -1 : 1);
  const target = items[next];
  if (index < 0 || !target) return false;
  from.tabIndex = -1; target.tabIndex = 0; target.focus(); target.scrollIntoView({ block: 'nearest' });
  return true;
}

export function threadGroupRows(row: HTMLElement): HTMLElement[] {
  return [...(row.closest('[data-thread-group]')?.querySelectorAll<HTMLElement>('.task-item') ?? [])].filter(item => item.dataset.pinned === row.dataset.pinned);
}

/** Native drag events keep the actual row as the drag image; no per-row listeners. */
export function bindThreadReordering(nav: HTMLElement, options: {
  busy(): boolean;
  reorder(ids: string[], focusedId: string): void;
  /** Folder headings are draggable only under Projects: Manual; ids are project ids in order. */
  reorderFolders(ids: string[], focusedId: string): void;
  dragging(active: boolean): void;
  menu(row: HTMLElement, point?: { x: number; y: number }): void;
  folderMenu(heading: HTMLElement, point?: { x: number; y: number }): void;
}): void {
  const folderIds = () => [...nav.querySelectorAll<HTMLElement>('.folder-heading[draggable=true]')].map(item => item.dataset.project!);
  let folder: HTMLElement | null = null, folderTarget: HTMLElement | null = null, folderAfter = false;
  const clearFolder = () => { folderTarget?.classList.remove('drop-before', 'drop-after'); folderTarget = null; };
  nav.addEventListener('dragstart', event => {
    const heading = (event.target as Element).closest<HTMLElement>('.folder-heading[draggable=true]');
    if (!heading || !event.dataTransfer) return;
    event.stopImmediatePropagation();
    folder = heading; event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-pandacode-folder', heading.dataset.project!);
    heading.classList.add('task-dragging'); options.dragging(true);
  });
  nav.addEventListener('dragover', event => {
    if (!folder) return;
    event.stopImmediatePropagation();
    const heading = (event.target as Element).closest('.folder-group')?.querySelector<HTMLElement>('.folder-heading[draggable=true]');
    clearFolder();
    if (!heading) return;
    event.preventDefault(); folderTarget = heading;
    const box = heading.getBoundingClientRect(); folderAfter = event.clientY > box.top + box.height / 2;
    if (heading !== folder) heading.classList.add(folderAfter ? 'drop-after' : 'drop-before');
  });
  const endFolder = () => { const active = Boolean(folder); folder?.classList.remove('task-dragging'); folder = null; clearFolder(); if (active) options.dragging(false); };
  nav.addEventListener('drop', event => {
    if (!folder) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const id = folder.dataset.project!, current = folderIds(), ids = current.filter(value => value !== id);
    if (folderTarget && folderTarget !== folder) {
      ids.splice(ids.indexOf(folderTarget.dataset.project!) + Number(folderAfter), 0, id);
      if (ids.join('\0') !== current.join('\0')) options.reorderFolders(ids, id);
    }
    endFolder();
  });
  nav.addEventListener('dragend', () => { if (folder) endFolder(); });
  let source: HTMLElement | null = null, target: HTMLElement | null = null, after = false;
  let scroll = 0, speed = 0;
  const clearTarget = () => { target?.classList.remove('drop-before', 'drop-after'); target = null; };
  const finish = () => {
    const active = Boolean(source);
    source?.classList.remove('task-dragging'); source = null; clearTarget();
    cancelAnimationFrame(scroll); scroll = 0; speed = 0;
    if (active) options.dragging(false);
  };
  const autoScroll = () => { nav.scrollTop += speed; scroll = speed && source ? requestAnimationFrame(autoScroll) : 0; };
  nav.addEventListener('dragstart', event => {
    const row = (event.target as Element).closest<HTMLElement>('.task-item');
    if (!row || options.busy() || !event.dataTransfer) { event.preventDefault(); return; }
    source = row; event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-pandacode-thread', row.dataset.id!);
    row.classList.add('task-dragging'); options.dragging(true);
  });
  nav.addEventListener('dragover', event => {
    const row = (event.target as Element).closest<HTMLElement>('.task-item');
    if (!source || !row || options.busy() || row.dataset.pinned !== source.dataset.pinned || row.closest('[data-thread-group]') !== source.closest('[data-thread-group]')) { clearTarget(); speed = 0; return; }
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearTarget(); target = row;
    const box = row.getBoundingClientRect(); after = event.clientY > box.top + box.height / 2;
    if (row !== source) row.classList.add(after ? 'drop-after' : 'drop-before');
    const bounds = nav.getBoundingClientRect();
    speed = event.clientY < bounds.top + 32 ? -7 : event.clientY > bounds.bottom - 32 ? 7 : 0;
    if (speed && !scroll) scroll = requestAnimationFrame(autoScroll);
  });
  nav.addEventListener('drop', event => {
    if (!source || !target || options.busy()) { finish(); return; }
    event.preventDefault(); event.stopPropagation();
    const id = source.dataset.id!, rows = threadGroupRows(source), current = rows.map(row => row.dataset.id!);
    const ids = current.filter(value => value !== id);
    if (target !== source) {
      ids.splice(ids.indexOf(target.dataset.id!) + Number(after), 0, id);
      if (ids.join('\0') !== current.join('\0')) options.reorder(ids, id);
    }
    finish();
  });
  nav.addEventListener('dragend', finish);
  nav.addEventListener('dragleave', event => { if (!nav.contains(event.relatedTarget as Node | null)) { clearTarget(); speed = 0; } });
  window.addEventListener('blur', finish);
  nav.addEventListener('contextmenu', event => {
    // A pointer opens the menu where it is; the menu key (no coordinates) keeps it on the row.
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
    // Anywhere on a row, its tick and … buttons and the gap beside them included.
    const target = event.target as Element;
    const row = target.closest('.task-row')?.querySelector<HTMLElement>(':scope>.task-item') ?? target.closest<HTMLElement>('.task-item');
    if (row) { event.preventDefault(); options.menu(row, point); return; }
    const heading = (event.target as Element).closest('.folder-row')?.querySelector<HTMLElement>('.folder-heading');
    if (heading) { event.preventDefault(); options.folderMenu(heading, point); }
  });
  nav.addEventListener('focusin', event => { if ((event.target as Element).matches(STOPS)) syncRovingFocus(nav); });
  nav.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (!event.altKey && !event.metaKey && !event.ctrlKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && target.matches(STOPS)) {
      if (moveFocus(nav, target, event.key)) event.preventDefault();
      return;
    }
    // Alt+↑/↓ moves a folder under Projects: Manual; the menu key opens its menu.
    if (target.matches('.folder-heading')) {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); options.folderMenu(target); return; }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        if (target.draggable) {
          const ids = folderIds(), index = ids.indexOf(target.dataset.project!), next = index + (event.key === 'ArrowUp' ? -1 : 1);
          if (index >= 0 && next >= 0 && next < ids.length) { [ids[index], ids[next]] = [ids[next], ids[index]]; options.reorderFolders(ids, target.dataset.project!); }
        }
        return;
      }
    }
    // → opens and ← closes a folder or section from its heading.
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && target.matches('.folder-heading, .section-toggle')) {
      if ((target.getAttribute('aria-expanded') === 'true') !== (event.key === 'ArrowRight')) { event.preventDefault(); target.click(); }
      return;
    }
    const row = target.closest<HTMLElement>('.task-item');
    if (!row) return;
    // ⌘/Ctrl Enter completes or reopens the row: its tick is not a Tab stop.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      const tick = row.parentElement?.querySelector<HTMLButtonElement>('.task-check');
      if (tick && !tick.disabled) { event.preventDefault(); tick.click(); }
      return;
    }
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); options.menu(row); return;
    }
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); if (options.busy() || !row.draggable) return;
    const ids = threadGroupRows(row).map(item => item.dataset.id!), index = ids.indexOf(row.dataset.id!);
    const next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    options.reorder(ids, row.dataset.id!);
  });
}
