import type { ProviderId } from './types';
import { escape, icon, isImeKey } from './dom';
import { providerLogo } from './provider-logos';
import { showPopover, hidePopover } from './popover-motion';
import { trackSegment } from './motion';
import { infoMark } from './tooltip';

/** Label plus detail up to this length fit on one row; longer details move behind an info mark. */
const BRIEF_ROW = 48;
/** Space between a menu and its trigger. */
const GAP = 4;

export type ChoiceItem = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** Ready-made leading markup (a project's app icon), used in place of `icon`. */
  leading?: string;
  provider?: ProviderId;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Starts a named group (radio groups in a settings menu); the name is shown above it. */
  heading?: string;
  /** Draws a line above the item, starting an unnamed group. */
  separator?: boolean;
  /** Consecutive items with the same `segment` share one row named by it, as a segmented choice
   * showing `short` (← and → move along it, like ↑ and ↓). Search results list them as plain rows. */
  segment?: string;
  short?: string;
  /** Explicit state variants; legacy flat choices retain their radio/action behavior. */
  kind?: 'checkbox' | 'radio';
  children?: ChoiceItem[];
};
type ChoiceMenuOptions = {
  anchor: HTMLElement;
  /** Opens at this viewport point (a right-click) instead of under the anchor, which still owns focus. */
  point?: { x: number; y: number };
  title: string;
  items: ChoiceItem[];
  onSelect: (id: string) => void | Promise<void>;
  onClose: () => void;
  actions?: boolean;
  searchPlaceholder?: string;
  width?: number;
  /** Host-validated small action catalogs can opt into all 128 rows. Legacy menus stay at 100. */
  itemLimit?: number;
};

/** A bounded, transient menu. Callbacks own all application changes. */
export function openChoiceMenu(options: ChoiceMenuOptions): () => void {
  // Defensive host boundary too: callers can accidentally supply cyclic objects even
  // though extension JSON already has stricter depth/item budgets.
  const seen = new Set<ChoiceItem[]>();
  let count = 0;
  function check(items: ChoiceItem[], depth: number): boolean {
    if (depth > 5 || seen.has(items) || (depth > 1 && (count += items.length) > 512)) return false;
    seen.add(items);
    return items.every(item => !item.children || check(item.children, depth + 1));
  }
  if (!check(options.items, 1)) { options.onClose(); return () => {}; }
  const tree: MenuTree = { anchor: options.anchor, panels: new Set(), levels: [], pending: false, close: () => {} };
  const close = openLevel(options, tree);
  tree.close = close;
  return close;
}

type MenuTree = { anchor: HTMLElement; panels: Set<HTMLElement>; levels: { panel: HTMLElement; close: () => void; renderPending: () => void }[]; pending: boolean; close: (returnFocus?: boolean) => void };
function openLevel(options: ChoiceMenuOptions, tree: MenuTree, parent?: HTMLElement): () => void {
  const { anchor, title, onSelect, onClose, actions = false, searchPlaceholder } = options;
  let items: ChoiceItem[] = [], buttons: HTMLButtonElement[] = [], matches = 0;
  const panel = document.createElement('section');
  panel.className = 'choice-menu floating-menu';
  panel.id = `choice-menu-${crypto.randomUUID()}`;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.innerHTML = `${searchPlaceholder ? `<div class="choice-menu-search">${icon('search')}<input type="search" aria-label="${escape(searchPlaceholder.replace(/(?:…|\.{3})$/, ''))}" placeholder="${escape(searchPlaceholder)}" autocomplete="off" spellcheck="false" maxlength="200"></div>` : ''}<div class="choice-menu-list" role="menu" aria-label="${escape(title)}"></div><p class="choice-menu-error" role="alert" hidden></p><p class="choice-menu-status" role="status" hidden></p>`;
  const search = panel.querySelector<HTMLInputElement>('input');
  const list = panel.querySelector<HTMLElement>('.choice-menu-list')!;
  const error = panel.querySelector<HTMLElement>('.choice-menu-error')!;
  const status = panel.querySelector<HTMLElement>('.choice-menu-status')!;
  const originalExpanded = anchor.getAttribute('aria-expanded');
  const originalControls = anchor.getAttribute('aria-controls');
  const anchorId = anchor.id;
  let closed = false, pending = false, positionFrame = 0;
  let active = -1;
  let typed = '', typedAt = 0;
  let closeChild: (() => void) | undefined, childIndex = -1;
  const contains = (target: Node | null) => [...tree.panels].some(panel => panel.contains(target));

  function close(returnFocus = true): void {
    if (closed) return;
    const focused = document.activeElement;
    const restoreFocus = returnFocus && (contains(focused) || focused === document.body);
    closed = true;
    closeChild?.();
    tree.panels.delete(panel);
    tree.levels = tree.levels.filter(level => level.panel !== panel);
    if (pending) { tree.pending = false; tree.levels.forEach(level => level.renderPending()); }
    cancelAnimationFrame(positionFrame);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEscape, true);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition);
    window.visualViewport?.removeEventListener('scroll', schedulePosition);
    if (originalExpanded === null) anchor.removeAttribute('aria-expanded');
    else anchor.setAttribute('aria-expanded', originalExpanded);
    if (originalControls === null) anchor.removeAttribute('aria-controls');
    else anchor.setAttribute('aria-controls', originalControls);
    if (restoreFocus) (anchor.isConnected ? anchor : anchorId ? document.getElementById(anchorId) : null)?.focus({ preventScroll: true });
    hidePopover(panel);
    onClose();
  }
  function position(): void {
    positionFrame = 0;
    if (closed) return;
    if (!anchor.isConnected) { close(false); return; }
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12, topEdge = (viewport?.offsetTop ?? 0) + 12;
    const width = Math.max(0, (viewport?.width ?? innerWidth) - 24);
    const height = Math.max(0, (viewport?.height ?? innerHeight) - 24);
    const rect = options.point ? new DOMRect(options.point.x, options.point.y, 0, 0) : anchor.getBoundingClientRect();
    panel.style.position = 'fixed';
    // One-line rows need room for a label and its detail: 280px unless the caller sizes it.
    panel.style.width = `${Math.min(340, options.width ?? Math.max(280, rect.width), width)}px`;
    panel.style.maxHeight = `${Math.min(400, height)}px`;
    const desired = panel.offsetHeight;
    const above = Math.max(0, rect.top - topEdge - GAP), below = Math.max(0, topEdge + height - rect.bottom - GAP);
    const placeBelow = below >= desired || below >= above;
    const available = placeBelow ? below : above;
    panel.style.maxHeight = `${Math.min(400, available >= 120 ? available : height)}px`;
    const panelHeight = panel.offsetHeight;
    const top = placeBelow ? rect.bottom + GAP : rect.top - panelHeight - GAP;
    panel.style.left = `${Math.max(leftEdge, Math.min(rect.left, leftEdge + width - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(top, topEdge + height - panelHeight))}px`;
    if (parent) {
      const rtl = getComputedStyle(anchor).direction === 'rtl';
      const right = rect.right + GAP, left = rect.left - panel.offsetWidth - GAP;
      const fitsRight = right + panel.offsetWidth <= leftEdge + width, fitsLeft = left >= leftEdge;
      const x = rtl ? fitsLeft ? left : right : fitsRight ? right : left;
      panel.style.left = `${Math.max(leftEdge, Math.min(x, leftEdge + width - panel.offsetWidth))}px`;
      // When neither side fits, cascade vertically rather than covering the
      // trigger row (which makes a real pointer hover/click impossible).
      const y = fitsLeft || fitsRight ? rect.top : rect.bottom + GAP + panelHeight <= topEdge + height ? rect.bottom + GAP : rect.top - GAP - panelHeight;
      panel.style.top = `${Math.max(topEdge, Math.min(y, topEdge + height - panelHeight))}px`;
    }
    panel.dataset.placement = placeBelow ? 'below' : 'above';
  }
  function schedulePosition(event?: Event): void {
    if (event?.target instanceof Node && panel.contains(event.target)) return;
    if (!closed && !positionFrame) positionFrame = requestAnimationFrame(position);
  }
  function focusItem(index: number): void {
    if (tree.pending || closed || !buttons[index] || buttons[index].disabled) return;
    markActive(index);
    buttons[active].focus({ preventScroll: true });
    buttons[active].scrollIntoView({ block: 'nearest' });
  }
  function markActive(index: number): void {
    active = index;
    buttons.forEach((button, n) => {
      button.tabIndex = n === active ? 0 : -1;
      button.classList.toggle('choice-menu-active', n === active);
    });
  }
  function renderChoices(): void {
    const query = search?.value.trim().toLocaleLowerCase() ?? '';
    const limit = Number.isInteger(options.itemLimit) ? Math.max(1, Math.min(128, options.itemLimit!)) : 100;
    items = []; matches = 0;
    let selected: ChoiceItem | undefined;
    for (const item of options.items) {
      if (item.children && !item.children.length) continue;
      if (query && !item.label.toLocaleLowerCase().includes(query) && !item.description?.toLocaleLowerCase().includes(query)) continue;
      matches++;
      if (items.length < limit) items.push({ ...item });
      if (item.selected) selected = item;
    }
    // Keep a later current project visible on reopening, without rendering the
    // full catalog. Search still reaches every option, not only this first page.
    if (!query && selected && !items.some(item => item.id === selected.id)) items[items.length - 1] = { ...selected };
    // Groups only make sense over the full list, not search results.
    const grouped = !query;
    let open = false;
    list.innerHTML = items.map((item, index) => {
      if (grouped && item.segment) {
        const first = items[index - 1]?.segment !== item.segment, last = items[index + 1]?.segment !== item.segment;
        const start = first ? `${open ? '</div>' : ''}${index ? '<div class="choice-menu-separator" role="separator"></div>' : ''}<div class="choice-menu-segments" role="group" aria-label="${escape(item.segment)}"><span class="choice-menu-label" aria-hidden="true">${escape(item.segment)}</span><span class="choice-menu-segment-list">` : '';
        if (first) open = false;
        return `${start}<button type="button" class="choice-menu-option choice-menu-segment${item.selected ? ' selected' : ''}" role="menuitemradio" aria-checked="${Boolean(item.selected)}" aria-label="${escape(item.label)}" data-choice-index="${index}" tabindex="-1" ${item.disabled ? 'disabled aria-disabled="true"' : ''}>${escape(item.short ?? item.label)}</button>${last ? '</span></div>' : ''}`;
      }
      const heading = grouped && item.heading ? `${open ? '</div>' : ''}${index ? '<div class="choice-menu-separator" role="separator"></div>' : ''}<div class="choice-menu-group" role="group" aria-label="${escape(item.heading)}"><div class="choice-menu-heading" aria-hidden="true">${escape(item.heading)}</div>` : '';
      if (heading) open = true;
      const separator = grouped && !item.heading && item.separator && index ? '<div class="choice-menu-separator" role="separator"></div>' : '';
      const descriptionId = `${panel.id}-description-${index}`;
      // Rows stay one line: a short detail sits beside the label, a long one behind a mark.
      const brief = Boolean(item.description) && item.label.length + item.description!.length <= BRIEF_ROW;
      const detail = item.description ? brief
        ? `<span id="${descriptionId}" class="choice-menu-description">${escape(item.description)}</span>`
        : `<span id="${descriptionId}" class="sr-only">${escape(item.description)}</span>` : '';
      // In an action menu a selected row is the current state (the branch checked out): checked, never re-run.
      const role = item.children ? 'menuitem' : item.kind ? `menuitem${item.kind}` : actions ? 'menuitem' : 'menuitemradio';
      const state = item.children ? 'aria-haspopup="menu" aria-expanded="false"' : item.kind || !actions ? `aria-checked="${Boolean(item.selected)}"` : item.selected ? 'aria-current="true"' : '';
      return `${heading}${separator}<button type="button" class="choice-menu-option${item.danger ? ' is-danger' : ''}" role="${role}" ${state} aria-label="${escape(item.label)}" ${item.description ? `aria-describedby="${descriptionId}"` : ''} data-choice-index="${index}" tabindex="-1" ${item.disabled ? 'disabled aria-disabled="true"' : ''}>${item.provider ? providerLogo(item.provider) : item.leading ? item.leading : item.icon ? icon(item.icon) : ''}<span class="choice-menu-copy"><span class="choice-menu-label">${escape(item.label)}</span>${detail}</span>${item.description && !brief ? infoMark(item.description, undefined, true) : ''}${item.selected ? icon('check') : ''}${item.children ? icon(getComputedStyle(anchor).direction === 'rtl' ? 'chevron-left' : 'chevron-right') : ''}</button>`;
    }).join('') + (open ? '</div>' : '');
    buttons = [...list.querySelectorAll<HTMLButtonElement>('.choice-menu-option')];
    for (const group of list.querySelectorAll<HTMLElement>('.choice-menu-segment-list')) trackSegment(group, group.querySelector<HTMLElement>(':scope>.selected'));
    const current = actions ? -1 : items.findIndex(item => item.selected && !item.disabled);
    markActive(current >= 0 ? current : items.findIndex(item => !item.disabled && !(actions && item.selected && !item.kind && !item.children)));
    renderPending();
    buttons[active]?.scrollIntoView({ block: 'nearest' });
  }
  function renderPending(): void {
    buttons.forEach((button, index) => { button.disabled = tree.pending || Boolean(items[index].disabled); });
    if (search) search.disabled = tree.pending;
    list.setAttribute('aria-busy', String(tree.pending));
    status.textContent = pending ? 'Applying…' : !items.length ? search?.value.trim() ? 'No matching options.' : 'No options available.' : matches > items.length ? `Showing ${items.length} of ${matches} options.${search ? ' Search to narrow the list.' : ''}` : '';
    status.hidden = !status.textContent;
    position();
  }
  async function select(index: number): Promise<void> {
    if (closed || tree.pending || !items[index] || items[index].disabled) return;
    if (items[index].children) { openChild(index); return; }
    if (actions && items[index].selected && !items[index].kind) { tree.close(); return; }
    pending = true; tree.pending = true; error.hidden = true;
    panel.focus({ preventScroll: true });
    tree.levels.forEach(level => level.renderPending());
    try { await onSelect(items[index].id); if (!closed) tree.close(); }
    catch (reason) {
      if (closed) return;
      pending = false; tree.pending = false;
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
      tree.levels.forEach(level => level.renderPending());
      focusItem(index);
    }
  }
  function openChild(index: number): void {
    const item = items[index];
    if (closed || tree.pending || !item?.children?.length || item.disabled) return;
    if (childIndex === index) return;
    closeChild?.(); childIndex = index;
    closeChild = openLevel({ ...options, anchor: buttons[index], point: undefined, title: item.label, searchPlaceholder: undefined, items: item.children, actions: true, onClose: () => { childIndex = -1; closeChild = undefined; } }, tree, panel);
  }
  function onOutside(event: PointerEvent): void {
    const target = event.target;
    if (target instanceof Node && !contains(target) && !tree.anchor.contains(target)) tree.close(false);
  }
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || isImeKey(event) || tree.levels.at(-1)?.panel !== panel) return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }

  list.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.choice-menu-option') : null;
    if (button && list.contains(button)) void select(Number(button.dataset.choiceIndex));
  });
  list.addEventListener('focusin', event => {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index >= 0) { if (childIndex >= 0 && childIndex !== index) closeChild?.(); markActive(index); }
  });
  list.addEventListener('pointermove', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.choice-menu-option') : null;
    const index = buttons.indexOf(button!);
    if (index < 0 || button?.disabled || tree.pending || closed) return;
    // No leave timer: crossing the gap or moving diagonally into the child cannot
    // remove it. Only entering another enabled sibling changes the open branch.
    if (index !== childIndex) { closeChild?.(); if (items[index].children) openChild(index); }
  });
  search?.addEventListener('input', () => {
    if (closed || pending) return;
    error.hidden = true; typed = ''; renderChoices();
  });
  panel.addEventListener('keydown', event => {
    if (isImeKey(event)) return;
    // Restore the trigger before the browser's default Tab step, so the menu
    // does not jump to the end of the body or trap focus in a parent dialog.
    if (event.key === 'Tab') { tree.close(); return; }
    if (tree.pending) return;
    const enabled = buttons.flatMap((button, index) => button.disabled ? [] : [index]);
    if (!enabled.length) return;
    if (event.target === search && (event.key === 'Home' || event.key === 'End')) return;
    // Along a segmented row, → and ← step like ↓ and ↑.
    const segment = event.target instanceof Element && event.target.classList.contains('choice-menu-segment');
    const rtl = getComputedStyle(anchor).direction === 'rtl';
    if (!segment && event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') && items[active]?.children) {
      event.preventDefault(); openChild(active); return;
    }
    if (!segment && parent && event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      event.preventDefault(); close(); return;
    }
    const key = segment && event.key === 'ArrowRight' ? 'ArrowDown' : segment && event.key === 'ArrowLeft' ? 'ArrowUp' : event.key;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault();
      const current = enabled.indexOf(active);
      const step = (from: number) => (from + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      let next = event.target === search ? key === 'ArrowUp' ? enabled.length - 1 : Math.max(0, current) : key === 'Home' ? 0 : key === 'End' ? enabled.length - 1 : step(current);
      // ↓ and ↑ leave a segmented row whole (← and → move along it), and enter one at its current choice.
      const group = (n: number) => items[enabled[n]]?.segment;
      if (segment && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && (key === 'ArrowDown' || key === 'ArrowUp')) {
        for (let n = 0; n < enabled.length && group(next) === group(current); n++) next = step(next);
      }
      const entered = group(next) && group(next) !== group(current) ? enabled.findIndex(index => items[index].segment === group(next) && items[index].selected) : -1;
      focusItem(enabled[entered >= 0 ? entered : next]);
    } else if (event.key === 'Enter' && event.target === search) {
      event.preventDefault(); void select(active);
    } else if (event.target !== search && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const now = performance.now();
      typed = ((now - typedAt < 700 ? typed : '') + event.key.toLocaleLowerCase()).slice(-100); typedAt = now;
      const query = [...typed].every(character => character === typed[0]) ? typed[0] : typed;
      const start = enabled.indexOf(active) + (query.length === 1 ? 1 : 0);
      for (let n = 0; n < enabled.length; n++) {
        const index = enabled[(start + n + enabled.length) % enabled.length];
        if (items[index].label.trimStart().toLocaleLowerCase().startsWith(query)) { focusItem(index); break; }
      }
    }
    // Enter and Space retain native button activation.
  });
  panel.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !contains(event.relatedTarget) && !(parent && tree.anchor.contains(event.relatedTarget))) tree.close(false);
  });

  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', panel.id);
  tree.panels.add(panel); tree.levels.push({ panel, close, renderPending });
  (anchor.closest('dialog[open]') ?? document.body).append(panel);
  renderChoices();
  showPopover(panel, anchor);
  if (search) search.focus({ preventScroll: true });
  else if (active >= 0 && buttons[active] && !buttons[active].disabled) focusItem(active);
  else panel.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onEscape, true);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  return () => close();
}
