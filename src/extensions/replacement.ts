import './replacement.css';
import { escape } from '../dom';
import { extensionsSnapshot, extensionIdentity } from './manager';
import { createComponentSelection, createComponentSlot, type ComponentProvider, type SlotProps, type SlotAction, type SlotId } from './component-slot';
import { runningFirst } from './roster-core';

export const componentSelection = createComponentSelection(localStorage);
const faults = new Set<string>();
/** The selected, unfaulted action dock provider. The dock carries it, so a redraw of its items keeps the same
 * presentation without remounting a button, the flyout or a panel. */
export function dockProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.actionDock', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Actions-first move on the original dock: the actions group's node goes ahead of the panels group's, the status
 * group stays last. Items, listeners, the roving stop and the flyout stay. Returns false only when the selected
 * provider faults now (built-in order restored), so the host reports it once. */
export function applyDockPresentation(dock: HTMLElement, qualify = () => {
  if (!dock.classList.contains('action-dock') || !dock.querySelector(':scope > [data-group="panels"]') || !dock.querySelector(':scope > [data-group="actions"]')) throw Error('Incomplete action dock');
}): boolean {
  const provider = componentSelection.resolve('panda.actionDock', componentProviders());
  const arrange = (first: boolean) => {
    const panels = dock.querySelector<HTMLElement>(':scope > [data-group="panels"]'), actions = dock.querySelector<HTMLElement>(':scope > [data-group="actions"]');
    if (!panels || !actions) return;
    const [lead, next] = first ? [actions, panels] : [panels, actions];
    if (lead.nextElementSibling === next) return;
    const focused = document.activeElement as HTMLElement | null;
    dock.insertBefore(lead, next);
    // Moving a node drops focus in some engines; the same item keeps it.
    if (focused && lead.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };
  if (!provider) { delete dock.dataset.dockProvider; arrange(false); return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); dock.dataset.dockProvider = provider.id; arrange(true); return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete dock.dataset.dockProvider; arrange(false);
    return !fresh;
  }
}
/** The selected, unfaulted agent roster provider. The subagents host carries it, so a list redraw keeps the same order
 * without remounting a row, the open child or its stream. */
export function rosterProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.roster', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Running-first on the original subagent rows: `arrange` hands the list its order (undefined restores start order).
 * Rows, the open child, its stream and focus stay. Returns false only when the selected provider faults now (built-in
 * order restored), so the host reports it once. */
export function applyRosterPresentation(host: HTMLElement, arrange: (order?: (rows: readonly { id: string; active: boolean }[]) => string[]) => void, qualify = () => {
  if (!host.classList.contains('subagents-host') || !host.querySelector(':scope > .subagents-trigger')) throw Error('Incomplete subagents host');
}): boolean {
  const provider = componentSelection.resolve('panda.roster', componentProviders());
  if (!provider) { delete host.dataset.rosterProvider; arrange(undefined); return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.rosterProvider = provider.id; arrange(runningFirst); return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.rosterProvider; arrange(undefined);
    return !fresh;
  }
}
/** The selected, unfaulted status provider. The dock's status group carries it, so a usage panel that mounts later
 * takes the same presentation without remounting a tab, the cached reads or the picture-in-picture. */
export function statusProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.status', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Details-first on the original usage overview: `arrange(true)` moves the cost breakdown ahead of the agent list
 * (false restores it). Nodes, the period, the breakdown, focus and cached reads stay. Returns false only when the
 * selected provider faults now (built-in order restored), so the host reports it once. */
export function applyStatusPresentation(group: HTMLElement, arrange: (detailsFirst: boolean) => void, qualify = () => {
  if (!group.matches('.action-dock-group[data-group="status"]') || !group.querySelector(':scope > #update-status')) throw Error('Incomplete status group');
}): boolean {
  const provider = componentSelection.resolve('panda.status', componentProviders());
  if (!provider) { delete group.dataset.statusProvider; arrange(false); return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); group.dataset.statusProvider = provider.id; arrange(true); return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete group.dataset.statusProvider; arrange(false);
    return !fresh;
  }
}
/** The selected, unfaulted sidebar provider. The sidebar root carries it, so a navigation redraw keeps the same
 * presentation without remounting a row, the filter field or a pending drag. */
export function sidebarProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.sidebar', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Filter-first visual move on the original sidebar: the filter row leads the header actions. No row, section,
 * selection, sort or preference changes. Returns false only when the selected provider faults now (built-in layout
 * restored), so the host reports it once. */
export function applySidebarPresentation(host: HTMLElement, qualify = () => {
  if (!host.classList.contains('sidebar') || !host.querySelector(':scope > .sidebar-search') || !host.querySelector('#navigation')) throw Error('Incomplete sidebar host');
}): boolean {
  const provider = componentSelection.resolve('panda.sidebar', componentProviders());
  if (!provider) { delete host.dataset.sidebarProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.sidebarProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.sidebarProvider;
    return !fresh;
  }
}
/** The selected, unfaulted Settings provider. The Settings root carries it, so a page change or a
 * redraw keeps the same presentation without remounting any page, embed or pending edit. */
export function settingsProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.settings', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Actions-first visual move on the original Settings page headers: no page remount, save, navigation or
 * preference change. Returns false only when the selected provider faults now (built-in layout restored),
 * so the host reports it once. */
export function applySettingsPresentation(host: HTMLElement, qualify = () => {
  if (!host.classList.contains('settings-page-root') || !host.querySelector('.settings-nav-list') || !host.querySelector('.settings-panel-head')) throw Error('Incomplete Settings host');
}): boolean {
  const provider = componentSelection.resolve('panda.settings', componentProviders());
  if (!provider) { delete host.dataset.settingsProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.settingsProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.settingsProvider;
    return !fresh;
  }
}
/** The selected, unfaulted machine coordination provider. The host orchestration slot carries it, so a
 * composer redraw keeps the same presentation without remounting a link card, dialog or pending start. */
export function machinesPresentationProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.machines', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Controls-below visual move on the original orchestration slot: no remote call, link, start or target change.
 * Returns false only when the selected provider faults now (built-in layout restored), so the host reports it once. */
export function applyMachinesPresentation(host: HTMLElement, qualify = () => {
  if (host.id !== 'machine-orchestration' || !host.closest('#composer-area')) throw Error('Incomplete machine coordination host');
}): boolean {
  const provider = componentSelection.resolve('panda.machines', componentProviders());
  if (!provider) { delete host.dataset.machinesProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.machinesProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.machinesProvider;
    return !fresh;
  }
}
/** The selected, unfaulted cloud machine provider. The host strip markup carries it, so a progress
 * redraw keeps the same presentation without remounting the menu, the dialog or a pending action. */
export function cloudPresentationProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.cloud', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Strip-below visual move on the original cloud strip: no cloud call, menu, dialog or target change.
 * Returns false only when the selected provider faults now (built-in layout restored), so the host reports it once. */
export function applyCloudPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.cloud-strip-status')) throw Error('Incomplete cloud machine host');
}): boolean {
  const provider = componentSelection.resolve('panda.cloud', componentProviders());
  if (!provider) { delete host.dataset.cloudProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.cloudProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.cloudProvider;
    return !fresh;
  }
}
/** Images-first visual move on the original moodboard library: no load, thumbnail, file, form or attach change.
 * Returns false only when the selected provider faults now (built-in layout restored), so the host reports it once. */
export function applyMoodboardPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.moodboard-library') || !host.querySelector('.moodboard-content')) throw Error('Incomplete moodboard host');
}): boolean {
  const provider = componentSelection.resolve('panda.moodboards', componentProviders());
  if (!provider) { delete host.dataset.moodboardProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.moodboardProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.moodboardProvider;
    return !fresh;
  }
}
/** The selected, unfaulted branch/worktree provider. The host composer markup carries it, so a
 * context-bar redraw keeps the same presentation without remounting chips, menus or forms. */
export function worktreeProvider(): ComponentProvider | undefined {
  const provider = componentSelection.resolve('panda.worktree', componentProviders());
  return provider && !faults.has(identity(provider)) ? provider : undefined;
}
/** Branch-first visual move on the original context bar: no git call, menu, form or cleanup change.
 * Returns false only when the selected provider faults now (built-in order restored), so the host reports it once. */
export function applyWorktreePresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.composer-local')) throw Error('Incomplete branch and worktree host');
}): boolean {
  const provider = componentSelection.resolve('panda.worktree', componentProviders());
  if (!provider) { delete host.dataset.worktreeProvider; return true; }
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.worktreeProvider = provider.id; return true;
  } catch {
    const fresh = !faults.has(identity(provider));
    faults.add(identity(provider)); delete host.dataset.worktreeProvider;
    return !fresh;
  }
}
/** Section-first visual move on the original Pull view: no fetch, remount, viewer disposal or merge-state change. */
export function applyPullPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.pull-tabs') || !host.querySelector('.pull-header')) throw Error('Incomplete Pull request host');
}): void {
  delete host.dataset.pullProvider;
  const status = host.querySelector<HTMLElement>('[data-pull-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.pull', componentProviders());
  if (!provider) return;
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.pullProvider = provider.id;
  } catch {
    faults.add(identity(provider));
    const notice = status ?? document.createElement('p');
    notice.dataset.pullPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Pull request replacement failed. Built-in view remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  }
}
/** Compatible visual move on original nodes, without fetching or remounting. */
export function applyGithubHubPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.gh-bar') || !host.querySelector('.gh-head')) throw Error('Incomplete GitHub host');
}): void {
  delete host.dataset.githubHubProvider;
  const bar = host.querySelector<HTMLElement>('.gh-bar');
  if (bar) bar.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-github-hub-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.githubHub', componentProviders());
  if (!provider) return;
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.githubHubProvider = provider.id;
    if (bar) bar.style.order = '-1';
  } catch {
    faults.add(identity(provider));
    const notice = status ?? document.createElement('p');
    notice.dataset.githubHubPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'GitHub replacement failed. Built-in hub remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  }
}
/** Reorder original stage sections; never mutate task stages or remount details. */
export function applyBoardPresentation(host: HTMLElement, qualify = () => {
  if (host.querySelectorAll('.board-column').length !== 4) throw Error('Incomplete Board host');
}): void {
  delete host.dataset.boardProvider;
  const columns = [...host.querySelectorAll<HTMLElement>('.board-column')];
  columns.forEach(column => { column.style.order = ''; });
  const status = host.querySelector<HTMLElement>('[data-board-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.board', componentProviders());
  if (!provider) return;
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.boardProvider = provider.id;
    const review = columns.find(column => column.dataset.stage === 'review');
    if (review) review.style.order = '-1';
  } catch {
    faults.add(identity(provider));
    const notice = status ?? document.createElement('p');
    notice.dataset.boardPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Board replacement failed. Built-in board remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  }
}
/** BTW reorders the original composer, never its editor/history/controller. */
export function applyBtwPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.btw-input') || !host.querySelector('.btw-stream-region') || !host.querySelector('.btw-above')) throw Error('Incomplete BTW host');
}): void {
  delete host.dataset.btwProvider;
  const composer = host.querySelector<HTMLElement>('.btw-composer-area');
  if (composer) composer.style.order = '';
  const provider = componentSelection.resolve('panda.btw', componentProviders());
  const status = host.querySelector<HTMLElement>('[data-btw-presentation-status]');
  if (status) status.hidden = true;
  if (!provider) return;
  try {
    if (faults.has(identity(provider))) throw Error('Faulted provider');
    qualify(); host.dataset.btwProvider = provider.id;
    if (composer) composer.style.order = '-1';
  } catch {
    faults.add(identity(provider));
    const notice = status ?? document.createElement('p');
    notice.dataset.btwPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'BTW replacement failed. Built-in conversation remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  }
}
/** Visual movement only: reparenting iframe ancestors would reload live documents. */
export function applyDesignPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.design-comments') || !host.querySelector('.design-viewport')) throw Error('Incomplete Design host');
}): void {
  delete host.dataset.designProvider;
  const comments = host.querySelector<HTMLElement>('.design-comments');
  if (comments) comments.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-design-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.design', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.designPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Design replacement failed. Built-in canvas remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.designProvider = provider.id; if (comments) comments.style.order = '-1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** VM v1 keeps the original canvas/input/frame controller and changes dock placement only. */
export function applyVmPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.vm-dock') || !host.querySelector('.vm-stage')) throw Error('Incomplete VM host');
}): void {
  delete host.dataset.vmProvider;
  const dock = host.querySelector<HTMLElement>('.vm-dock');
  if (dock) dock.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-vm-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.vm', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.vmPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'VM replacement failed. Built-in VM remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.vmProvider = provider.id; if (dock) dock.style.order = '-1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Closed Simulator recipe moves the original dock, never the frame/input controller. */
export function applySimulatorPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.sim-dock') || !host.querySelector('.sim-stage')) throw Error('Incomplete Simulator host');
}): void {
  delete host.dataset.simulatorProvider;
  const dock = host.querySelector<HTMLElement>('.sim-dock');
  if (dock) dock.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-simulator-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.simulator', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.simulatorPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Simulator replacement failed. Built-in simulator remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.simulatorProvider = provider.id; if (dock) dock.style.order = '-1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Closed Terminal recipe changes only the original tab strip's visual order. */
export function applyTerminalPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('[role="tablist"]') || !host.querySelector('#terminal-host')) throw Error('Incomplete Terminal host');
}): void {
  delete host.dataset.terminalProvider;
  const strip = host.querySelector<HTMLElement>('[role="tablist"]')?.parentElement;
  if (strip) strip.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-terminal-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.terminal', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.terminalPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Terminal replacement failed. Built-in terminal remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.terminalProvider = provider.id; if (strip) strip.style.order = '1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Move only the original toolbar. Native guest geometry remains host-managed. */
export function applyBrowserPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.browser-toolbar') || !host.querySelector('.browser-viewport')) throw Error('Incomplete Browser host');
}): void {
  delete host.dataset.browserProvider;
  const toolbar = host.querySelector<HTMLElement>('.browser-toolbar');
  if (toolbar) toolbar.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-browser-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.browser', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.browserPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Browser replacement failed. Built-in browser remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.browserProvider = provider.id; if (toolbar) toolbar.style.order = '1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Compatible region order only; original input/results and business handlers stay alive. */
export function applySearchPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.search-form') || !host.querySelector('.search-results')) throw Error('Incomplete Search host');
}): void {
  delete host.dataset.searchProvider;
  const results = host.querySelector<HTMLElement>('.search-results');
  if (results) results.style.order = '';
  const status = host.querySelector<HTMLElement>('[data-search-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.search', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.searchPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Search replacement failed. Built-in search remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.searchProvider = provider.id; if (results) results.style.order = '-1'; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Closed Changes recipe: move only the original commit form's visual order. */
export function applyChangesPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('.cv-header') || !host.querySelector('.cv-commit')) throw Error('Incomplete Changes host');
}): void {
  delete host.dataset.changesProvider;
  const status = host.querySelector<HTMLElement>(':scope > [data-changes-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.changes', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.changesPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Changes replacement failed. Built-in diff remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.changesProvider = provider.id; }
  catch { faults.add(identity(provider)); failed(); }
}
export function componentProviders(): ComponentProvider[] {
  const snapshot = extensionsSnapshot();
  return snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled && item.manifest.permissions?.includes('ui.contribute')).flatMap(item => item.manifest.contributes.components ?? []).sort((a, b) => a.id.localeCompare(b.id));
}
export function selectComponent(slot: SlotId, id?: string): void {
  componentSelection.select(slot, id, componentProviders());
  window.dispatchEvent(new Event('pandacode-components-change'));
}
const identity = (provider: ComponentProvider) => `${provider.id}:${extensionIdentity(provider.id.split('/')[0])}`;
/** Attribute-only recipe: never rerender the host document or dispose a live viewer. */
export function applyDocumentPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('#file-tabs') || !host.querySelector('#file-view')) throw new Error('Incomplete document host');
}): void {
  delete host.dataset.documentProvider;
  const status = host.querySelector<HTMLElement>(':scope > [data-document-presentation-status]');
  if (status) status.hidden = true;
  const provider = componentSelection.resolve('panda.documents', componentProviders());
  if (!provider) return;
  const failed = () => {
    const notice = status ?? document.createElement('p');
    notice.dataset.documentPresentationStatus = ''; notice.setAttribute('role', 'status');
    notice.textContent = 'Document replacement failed. Built-in viewer remains active.'; notice.hidden = false;
    if (!notice.parentElement) host.append(notice);
  };
  if (faults.has(identity(provider))) { failed(); return; }
  try { qualify(); host.dataset.documentProvider = provider.id; }
  catch { faults.add(identity(provider)); failed(); }
}
/** Declarative composer v1 reorders host-owned regions, never substitutes an editor or
 * dispatches an extension action. Recovery changes attributes only: native input/IME,
 * undo, grants, approvals, queue and submission remain exclusively core-owned. */
export function applyComposerPresentation(host: HTMLElement, qualify = () => {
  if (!host.querySelector('#prompt') || !host.querySelector('.composer-tray')) throw new Error('Incomplete host composer');
}): void {
  delete host.dataset.componentProvider;
  host.classList.remove('component-toolbar-first');
  const provider = componentSelection.resolve('panda.composer', componentProviders());
  if (!provider || faults.has(identity(provider))) return;
  try {
    qualify();
    host.classList.add('component-toolbar-first');
    host.dataset.componentProvider = provider.id;
  } catch { faults.add(identity(provider)); }
}
/** Closed transcript recipe: no cloned history, content delivery, action proxy or
 * extra event subscription. Failure/revocation never touches host reading state. */
export function applyTranscriptPresentation(host: HTMLElement, qualify = () => {
  if (host.id !== 'transcript') throw new Error('Unsupported transcript host');
}): void {
  delete host.dataset.componentProvider;
  host.classList.remove('component-timeline');
  const status = host.parentElement?.querySelector<HTMLElement>(':scope > [data-transcript-presentation-status]');
  if (status) { status.hidden = true; status.textContent = ''; }
  const provider = componentSelection.resolve('panda.transcript', componentProviders());
  if (!provider) return;
  const owner = extensionsSnapshot().packages.find(item => item.manifest.id === provider.id.split('/')[0]);
  const missing = ['tasks.transcript.read', 'tasks.tools.read'].filter(permission => !owner?.manifest.permissions?.includes(permission));
  const unavailable = (message: string) => {
    if (!host.parentElement) return;
    const notice = status ?? document.createElement('p');
    notice.dataset.transcriptPresentationStatus = '';
    notice.className = 'transcript-presentation-status';
    notice.setAttribute('role', 'status'); notice.hidden = false; notice.textContent = message;
    if (!notice.parentElement) host.before(notice);
  };
  if (missing.length) { unavailable(`Unsupported replacement — content redacted (${missing.join(', ')} not granted). Built-in transcript remains active.`); return; }
  if (faults.has(identity(provider))) { unavailable('Transcript replacement failed. Built-in transcript remains active.'); return; }
  try { qualify(); host.classList.add('component-timeline'); host.dataset.componentProvider = provider.id; }
  catch { faults.add(identity(provider)); unavailable('Transcript replacement failed. Built-in transcript remains active.'); }
}
/** Host-only fault boundary. The optional painter supports controlled conformance faults. */
export function renderComponent(host: HTMLElement, props: SlotProps, current: () => SlotProps, dispatch: (action: SlotAction) => void, paint = componentHtml): (() => void) | undefined {
  const provider = componentSelection.resolve(props.slot, componentProviders());
  if (!provider || faults.has(identity(provider))) return;
  let instance: ReturnType<typeof createComponentSlot>;
  try { instance = createComponentSlot(props, current, dispatch); host.innerHTML = paint(provider, instance.props); }
  catch { instance!?.dispose(); host.replaceChildren(); faults.add(identity(provider)); return; }
  const click = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-component-object]') : undefined;
    const object = instance.props.objects.find(object => object.id === button?.dataset.componentObject);
    if (!object || !button || !host.contains(button)) return;
    instance.dispatch({ contractVersion: 1, kind: props.slot === 'panda.projects' ? 'select' : object.directory ? 'toggle' : 'open', id: object.id, objectRevision: object.revision, revision: props.revision, context: props.context });
  };
  host.addEventListener('click', click);
  return () => { instance.dispose(); host.removeEventListener('click', click); };
}
function componentHtml(provider: ComponentProvider, props: SlotProps): string {
  const state = props.state;
  return `<section class="component-replacement component-${provider.presentation}" data-component-provider="${escape(provider.id)}" aria-label="${escape(provider.title)}" aria-busy="${state.loading}" ${state.visible ? '' : 'hidden'}>
    ${state.loading || state.offline ? `<p role="status">${state.offline ? 'Offline — built-in recovery remains available.' : 'Loading…'}</p>` : ''}
    ${props.objects.map(object => `<button type="button" class="ds-btn ${provider.presentation === 'cards' ? 'ds-card' : 'ds-row'}" data-component-object="${escape(object.id)}" ${object.id === state.selected ? 'aria-current="true"' : ''} ${object.directory ? `aria-expanded="${Boolean(object.expanded)}"` : ''} ${state.loading || state.offline ? 'disabled' : ''}>${escape(object.label)}${object.directory ? object.expanded ? ' ▾' : ' ▸' : ''}</button>`).join('') || (!state.loading && !state.offline ? '<p role="status">No items</p>' : '')}
  </section>`;
}
