import type { Project } from './types';
import { t } from './i18n.ts';
import { escape, icon } from './dom';
import { showPopover, hidePopover } from './popover-motion';

type ProjectPickerOptions = {
  anchor: HTMLElement;
  projects: Project[];
  currentProjectId: string;
  onSelect: (projectId: string) => Promise<void>;
  onNewProject: () => void;
  onClose: () => void;
};

/** A transient project chooser. It owns no application state or global actions. */
export function openProjectPicker(options: ProjectPickerOptions): () => void {
  const { anchor, currentProjectId, onSelect, onNewProject, onClose } = options;
  const projects = options.projects.map(project => ({ ...project }));
  const panel = document.createElement('section');
  panel.className = 'project-menu floating-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Choose project'));
  panel.innerHTML = `<div class="project-menu-search">${icon('search')}<input type="search" aria-label="${t('Search projects')}" placeholder="${t('Search projects…')}" autocomplete="off" spellcheck="false" maxlength="200"></div><div class="project-menu-list" role="listbox" aria-label="${t('Projects')}"></div><p class="project-menu-count" role="status" hidden></p><p class="project-menu-empty" role="status" hidden></p><p class="project-menu-error" role="alert" hidden></p><p class="project-menu-pending" role="status" hidden>${t('Opening…')}</p><div class="project-menu-footer"><button type="button" class="project-menu-open">${icon('plus')}${t('Open project…')}</button></div>`;
  const search = panel.querySelector<HTMLInputElement>('input')!;
  const list = panel.querySelector<HTMLElement>('.project-menu-list')!;
  const count = panel.querySelector<HTMLElement>('.project-menu-count')!;
  const empty = panel.querySelector<HTMLElement>('.project-menu-empty')!;
  const error = panel.querySelector<HTMLElement>('.project-menu-error')!;
  const pendingStatus = panel.querySelector<HTMLElement>('.project-menu-pending')!;
  const openButton = panel.querySelector<HTMLButtonElement>('.project-menu-open')!;
  const anchorId = anchor.id;
  const originalExpanded = anchor.getAttribute('aria-expanded');
  let activeId = currentProjectId;
  let pending = false;
  let closed = false;
  let positionFrame = 0;

  function close(returnFocus = true): void {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(positionFrame);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition);
    window.visualViewport?.removeEventListener('scroll', schedulePosition);
    hidePopover(panel);
    if (originalExpanded === null) anchor.removeAttribute('aria-expanded');
    else anchor.setAttribute('aria-expanded', originalExpanded);
    if (returnFocus) (anchor.isConnected ? anchor : anchorId ? document.getElementById(anchorId) : null)?.focus({ preventScroll: true });
    onClose();
  }

  function position(): void {
    positionFrame = 0;
    if (closed) return;
    if (!anchor.isConnected) { close(); return; }
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12;
    const topEdge = (viewport?.offsetTop ?? 0) + 12;
    const width = Math.max(0, (viewport?.width ?? innerWidth) - 24);
    const height = Math.max(0, (viewport?.height ?? innerHeight) - 24);
    const rect = anchor.getBoundingClientRect();
    panel.style.width = `${Math.min(360, width)}px`;
    panel.style.maxHeight = `${Math.min(440, height)}px`;
    const desired = panel.offsetHeight;
    const above = Math.max(0, rect.top - topEdge - 8);
    const below = Math.max(0, topEdge + height - rect.bottom - 8);
    const placeBelow = below >= desired || below >= above;
    const available = placeBelow ? below : above;
    // On very short windows use the viewport, retaining access to search/footer.
    panel.style.maxHeight = `${Math.min(440, available >= 160 ? available : height)}px`;
    const panelHeight = panel.offsetHeight;
    const top = placeBelow ? rect.bottom + 8 : rect.top - panelHeight - 8;
    panel.style.left = `${Math.max(leftEdge, Math.min(rect.left, leftEdge + width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(top, topEdge + height - panelHeight))}px`;
    panel.dataset.placement = placeBelow ? 'below' : 'above';
  }

  function schedulePosition(event?: Event): void {
    if (event?.target instanceof Node && panel.contains(event.target)) return;
    if (!closed && !positionFrame) positionFrame = requestAnimationFrame(position);
  }
  function choices(): HTMLButtonElement[] { return [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; }
  function setActive(button?: HTMLButtonElement, focus = false): void {
    list.querySelectorAll<HTMLButtonElement>('button').forEach(option => {
      option.classList.toggle('project-menu-active', option === button);
      option.tabIndex = option === button ? 0 : -1;
    });
    activeId = button?.dataset.projectId ?? '';
    if (focus && button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest' }); }
  }
  function renderChoices(): void {
    if (closed) return;
    const query = search.value.trim().toLowerCase();
    const matches = projects.filter(project => `${project.name}\n${project.path}`.toLowerCase().includes(query));
    const visible = matches.slice(0, 100);
    list.innerHTML = visible.map(project => `<button type="button" role="option" class="project-menu-option" data-project-id="${escape(project.id)}" aria-label="${escape(project.name + ' — ' + project.path)}" aria-selected="${project.id === currentProjectId}" tabindex="-1" ${pending ? 'disabled' : ''}>${icon('folder')}<span class="project-menu-label"><span class="project-menu-name">${escape(project.name)}</span><span class="project-menu-path" title="${escape(project.path)}">${escape(project.path)}</span></span>${project.id === currentProjectId ? icon('check') : ''}</button>`).join('');
    empty.hidden = visible.length > 0;
    empty.textContent = projects.length ? t('No matching projects.') : t('No projects yet.');
    count.hidden = matches.length <= visible.length;
    count.textContent = count.hidden ? '' : t`Showing ${visible.length} of ${matches.length} projects. Refine your search.`;
    pendingStatus.hidden = !pending;
    openButton.disabled = pending;
    list.setAttribute('aria-busy', String(pending));
    const buttons = choices();
    setActive(buttons.find(button => button.dataset.projectId === activeId) ?? buttons.find(button => button.dataset.projectId === currentProjectId) ?? buttons[0]);
    position();
  }
  async function select(button: HTMLButtonElement): Promise<void> {
    if (pending || closed || button.disabled) return;
    const id = button.dataset.projectId!;
    if (id === currentProjectId) { close(); return; }
    pending = true;
    error.hidden = true;
    renderChoices();
    try { await onSelect(id); close(); }
    catch (reason) {
      if (closed) return;
      pending = false;
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
      activeId = id;
      renderChoices();
      search.focus({ preventScroll: true });
    }
  }
  function onOutside(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && !panel.contains(target) && !anchor.contains(target)) close(false);
  }
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); close();
  }

  search.addEventListener('input', () => { activeId = ''; error.hidden = true; renderChoices(); });
  list.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('.project-menu-option');
    if (button) void select(button);
  });
  openButton.addEventListener('click', () => { if (!pending) { close(); onNewProject(); } });
  panel.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const buttons = choices();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      setActive(buttons[next], true);
    } else if ((event.key === 'Home' || event.key === 'End') && document.activeElement !== search) {
      event.preventDefault(); setActive(buttons[event.key === 'Home' ? 0 : buttons.length - 1], true);
    } else if (event.key === 'Enter' && document.activeElement === search) {
      event.preventDefault();
      const button = buttons.find(button => button.dataset.projectId === activeId);
      if (button) void select(button);
    }
  });
  panel.addEventListener('focusout', event => {
    if (event.relatedTarget && !panel.contains(event.relatedTarget as Node)) close(false);
  });

  anchor.setAttribute('aria-expanded', 'true');
  document.body.append(panel);
  renderChoices();
  showPopover(panel, anchor);
  search.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onEscape, true);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  return () => close();
}
