/** Host-only cached usage, status and progress bindings (docs/extensions/status.md): usage reads and account data, the
 * update prompt, notices and their Undo, snapshots and test reports never cross the package boundary. */
import { isImeKey } from '../dom';
import { openChoiceMenu } from '../choice-menu';
import type { ProgressPip } from '../progress-pip';
import type { JevActivity } from '../jev-activity';
import { activeUsage, setUsageArrangement, STATUS_EVENT, type UsageView } from './status-state';
import { createStatusPresentation, snapshotStatus, STATUS_ENTRY_CONTROLS, type StatusAction, type StatusControl, type StatusPresentation } from './status-core';
import { applyStatusPresentation, statusProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility } from './layout-host';
import { openContextActions } from './context-actions';
import { STATUS_CONTROLS, STATUS_CONTROLS_LOCATION, STATUS_PINNED_CONTROLS, type StatusControlPart } from './surfaces';

export type StatusHostState = { project?: string; task?: string };
type Control = { id: string; controlId: StatusControl; resource: string; enabled: boolean; hidden: boolean };
/** The picture-in-picture's toolbar buttons and their captured actions. */
const PIP_ACTIONS: readonly (readonly [string, StatusControl])[] = [['collapse', 'progress-collapse'], ['prev', 'progress-prev'], ['play', 'progress-play'], ['next', 'progress-next'], ['marks', 'progress-marks'], ['compare', 'progress-compare'], ['enlarge', 'progress-enlarge']];

export function mountStatusAdoption(options: {
  /** The dock's status group (`#action-dock > [data-group="status"]`): the update prompt and contributed status items. */
  group: HTMLElement;
  /** The sidebar footer's original Agent usage button. */
  usageButton: HTMLElement;
  toast: HTMLElement;
  /** The visual progress root (`#progress-pip`) and its lazily mounted controller. */
  pipRoot: HTMLElement;
  pip: () => ProgressPip | undefined;
  jev: JevActivity;
  state: () => StatusHostState;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
}) {
  const { group, usageButton, toast, pipRoot, jev } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, closeContext: (() => void) | undefined;
  const handle = (key: string) => { if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const tabHandle = (tab: string) => handle(tab === 'overview' ? 'tab:overview' : `provider:${tab}`);
  const update = () => group.querySelector<HTMLElement>(':scope > #update-status');
  const contributes = (location: string) => extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (node: Element) => node.getClientRects().length > 0;
  /** The open usage panel, while its dialog shows. */
  const openUsage = (): UsageView | undefined => { const view = activeUsage(); return view?.host.isConnected && view.host.closest('dialog[open]') ? view : undefined; };
  /** The original node of each layout part (references inside the host, not new actions). */
  const NODES: Readonly<Record<StatusControlPart, () => HTMLElement | null>> = {
    tabs: () => openUsage()?.host.querySelector<HTMLElement>(':scope > .usage-toolbar > .usage-tabs') ?? null,
    refresh: () => openUsage()?.host.querySelector<HTMLElement>(':scope > .usage-toolbar > .usage-refresh') ?? null,
    prev: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="prev"]'), play: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="play"]'),
    next: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="next"]'), marks: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="marks"]'),
    compare: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="compare"]'), enlarge: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="enlarge"]'),
    clear: () => pipRoot.querySelector<HTMLElement>('.pp-bar > [data-pp="clear"]'),
  };
  const bindings = () => STATUS_CONTROLS.map(([id]) => [`${STATUS_CONTROLS_LOCATION}/${id}`, NODES[id]()] as const);

  function authority() {
    const provider = statusProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const permissions = owner?.manifest.permissions ?? [];
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider && group.dataset.statusProvider === provider.id), granted: permissions.includes('ui.contribute'), userChoice: true, inventory: permissions.includes('harnesses.inventory'), progress: permissions.includes('tasks.summary') };
  }
  function presentation(): StatusPresentation {
    const state = options.state(), auth = authority(), usage = openUsage(), task = state.task ?? '';
    const modal = document.querySelector<HTMLDialogElement>('dialog[open]'), usageModal = Boolean(usage && modal && usage.host.closest('dialog') === modal);
    const pip = options.pip()?.status(), pipShown = Boolean(pip && pip.state !== 'hidden' && task && pip.sessionId === task);
    const jevState = jev.status(), jevShown = Boolean(task && jevState.task === task && jevState.shown);
    finders.clear();
    const controls: Control[] = [];
    const add = (controlId: StatusControl, key: string, resource: string, find: () => HTMLElement | null, enabled = true) => {
      const node = find(); if (!node) return;
      const id = handle(`control:${controlId}:${key}`); finders.set(id, find);
      controls.push({ id, controlId, resource, enabled: enabled && !(node as HTMLButtonElement).disabled && !node.hidden, hidden: Boolean(node.closest('[data-layout-hidden]')) });
    };
    add('usage-open', 'usage', '', () => usageButton.isConnected ? usageButton : null, !modal);
    if (usage) {
      // Usage controls act only inside the open panel, as a pointer could; overview controls only on the overview.
      const tab = usage.tab(), overview = tab === 'overview', within = (selector: string) => () => openUsage()?.host.querySelector<HTMLElement>(selector) ?? null;
      for (const button of usage.host.querySelectorAll<HTMLElement>(':scope > .usage-toolbar [role="tab"][data-tab]')) {
        const id = button.dataset.tab!; add('usage-tab', id, tabHandle(id), within(`:scope > .usage-toolbar [role="tab"][data-tab="${CSS.escape(id)}"]`), usageModal);
      }
      for (const row of usage.host.querySelectorAll<HTMLElement>('.usage-agents .usage-agent-row[data-provider]')) {
        const id = row.dataset.provider!; add('usage-details', id, handle(`provider:${id}`), within(`.usage-agents .usage-agent-row[data-provider="${CSS.escape(id)}"]`), usageModal && overview);
      }
      for (const button of usage.host.querySelectorAll<HTMLElement>('.usage-range [data-range]')) {
        const id = button.dataset.range!; add('usage-range', id, handle(`range:${id}`), within(`.usage-range [data-range="${CSS.escape(id)}"]`), usageModal && overview);
      }
      for (const button of usage.host.querySelectorAll<HTMLElement>('.usage-cost-details [data-breakdown]')) {
        const id = button.dataset.breakdown!; add('usage-breakdown', id, handle(`breakdown:${id}`), within(`.usage-cost-details [data-breakdown="${CSS.escape(id)}"]`), usageModal && overview);
      }
      add('usage-refresh', 'refresh', '', NODES.refresh, usageModal);
    }
    if (pipShown) {
      // The picture-in-picture acts only while no dialog covers it, it is not changing size and Clear is not asking.
      const idle = !modal && !pip!.moving && !pip!.confirming;
      if (pip!.state === 'collapsed') add('progress-expand', 'expand', '', () => pipRoot.querySelector<HTMLElement>('.pp-pill:not(.is-overlay)'), idle);
      else {
        for (const [part, controlId] of PIP_ACTIONS) add(controlId, part, '', () => pipRoot.querySelector<HTMLElement>(`.pp-card:not(.is-overlay) [data-pp="${part}"]`), idle);
        for (const thumb of pipRoot.querySelectorAll<HTMLElement>('.pp-card:not(.is-overlay) .pp-strip .pp-thumb')) {
          const snapshot = thumb.querySelector<HTMLElement>('img[data-thumb]')?.dataset.thumb ?? ''; if (!snapshot) continue;
          add('progress-thumb', snapshot, handle(`snapshot:${pip!.sessionId}:${snapshot}`), () => [...pipRoot.querySelectorAll<HTMLElement>('.pp-card:not(.is-overlay) .pp-strip .pp-thumb')].find(node => node.querySelector<HTMLElement>('img[data-thumb]')?.dataset.thumb === snapshot) ?? null, idle);
        }
      }
    }
    if (jevShown) add('jev-open', 'jev', '', () => jev.host.isConnected && !jev.host.hidden ? jev.host.querySelector<HTMLElement>('button') : null, !modal);
    // Harness reads need harnesses.inventory and task feedback tasks.summary; presentation and actions never depend on them.
    const providers = auth.inventory && usage ? usage.providers() : [];
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      provider: usage && usage.tab() !== 'overview' ? tabHandle(usage.tab()) : '', range: usage?.range() ?? 'month' as const,
      revision: 0, visible: !disposed && group.isConnected, busy: choosing || Boolean(modal && !usageModal) || Boolean(pipShown && pip!.confirming), safeMode: extensionsSnapshot().safeMode,
      usage: Boolean(usage), tab: !usage ? 'closed' as const : usage.tab() === 'overview' ? 'overview' as const : 'provider' as const, breakdown: usage?.breakdown() ?? 'model' as const, loading: usage?.pending() ?? false,
      update: Boolean(update() && !update()!.hidden), toast: toast.hidden ? 'hidden' as const : toast.querySelector('.toast-undo') ? 'undo' as const : toast.querySelector('.toast-action') ? 'action' as const : 'notice' as const,
      pip: pipShown ? pip!.state as 'collapsed' | 'expanded' : 'hidden' as const, jev: jevShown,
      inventory: auth.inventory,
      providers: providers.slice(0, 64).map(item => ({ id: handle(`provider:${item.id}`), provider: item.id, status: item.status, peak: item.peak === null ? -1 : Math.round(item.peak), stale: item.stale })),
      progress: auth.progress, iterations: auth.progress && pipShown ? Math.min(pip!.total, 10000) : 0, iteration: auth.progress && pipShown && pip!.total ? Math.min(pip!.index + 1, 10000) : 0,
      jevStatus: auth.progress && jevShown ? jevState.state : 'none' as const,
      controls: controls.slice(0, 128), truncated: providers.length > 64 || controls.length > 128,
    };
    const next = JSON.stringify([value, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotStatus({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; a package Refresh asks the providers again only after a
   * fresh host choice, inside the usage panel. */
  function execute(action: StatusAction, alive: () => boolean) {
    const node = finders.get(action.control)?.(); if (!node) return;
    if (!STATUS_ENTRY_CONTROLS.includes(action.controlId)) { node.click(); return; }
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: node, title: 'Extension requested a status action', items: [{ id: 'continue', label: 'Continue: Refresh usage', icon: 'refresh' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createStatusPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order inside each control's own parent and reversible visibility on the original nodes: nodes, listeners and
   * focus stay. Pinned controls never hide, even under a forged overlay. Safe mode is built-in. */
  function applyLayout() {
    const safe = disposed || extensionsSnapshot().safeMode, items = bindings();
    applyControlOrder(STATUS_CONTROLS_LOCATION, items, safe);
    const pinned = (id: string) => Boolean(STATUS_PINNED_CONTROLS[id.slice(STATUS_CONTROLS_LOCATION.length + 1) as StatusControlPart]);
    for (const [id, node] of items) if (node && (safe || pinned(id)) && node.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; }
    if (!safe) {
      // A control that hides under focus hands it to the first shown control of the same toolbar.
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null, scope = focused?.closest<HTMLElement>('.usage-toolbar, .pp-bar') ?? null;
      applyControlVisibility(items.filter(([id]) => !pinned(id)), () => [...scope?.querySelectorAll<HTMLElement>('button') ?? []].find(node => !node.closest('[data-layout-hidden]') && shown(node)) ?? null);
    }
  }
  function refresh() {
    if (disposed) return;
    closeContext?.(); closeContext = undefined; lastProject = layoutProject();
    if (!applyStatusPresentation(group, setUsageArrangement)) options.notify('Status presentation failed. The built-in usage panel and status remain active.');
    applyLayout();
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (disposed || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    if (extensionsSnapshot().safeMode) return;
    const usage = openUsage(), row = event.target.closest<HTMLElement>('.usage-agents .usage-agent-row[data-provider]'), harness = row?.dataset.provider ?? '';
    if (!usage || !row || !harness || !usage.host.contains(row)) return;
    // With nothing contributed here an agent row keeps its zero-extension behavior: no new menu.
    if (!contributes('panda.status.context')) return;
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    const alive = () => !disposed && row.isConnected && openUsage() === usage;
    // Usage is not task-scoped: the context names the harness only (empty project and task ids are omitted).
    closeContext = openContextActions(row, 'panda.status.context', { revision: presentation().revision, selection: { kind: 'usage-provider', ids: [handle(`provider:${harness}`)] } }, { title: 'Harness usage', items: [{ id: 'open', label: 'Show details', icon: 'activity' }], onSelect: id => {
      if (alive() && id === 'open') row.click();
    }, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: alive, onClose: () => { closeContext = undefined; } });
  }
  document.addEventListener('contextmenu', openContext); document.addEventListener('keydown', openContext);
  // The usage panel and the picture-in-picture mount later and redraw: each draw re-applies the layout to the new nodes.
  const onStatus = () => { if (!disposed) applyLayout(); };
  addEventListener(STATUS_EVENT, onStatus);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); closeContext?.(); stopExtensions(); stopLayout(); stopContext();
      document.removeEventListener('contextmenu', openContext); document.removeEventListener('keydown', openContext);
      removeEventListener(STATUS_EVENT, onStatus); window.removeEventListener('pandacode-components-change', refresh);
      applyLayout(); delete group.dataset.statusProvider; setUsageArrangement(false);
    },
  };
}
