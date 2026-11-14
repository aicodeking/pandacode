/** Host-only action dock and team progress bindings: dock items, the flyout, team lists and workers never cross the
 * package boundary. */
import { isImeKey } from '../dom';
import { openChoiceMenu } from '../choice-menu';
import { teamActive, type TeamSnapshot, type TeamWorker } from '../architect-types';
import { createDockPresentation, snapshotDock, DOCK_ENTRY_CONTROLS, type DockAction, type DockControl, type DockPresentation, type DockWorkerStatus } from './dock-core';
import { applyDockPresentation, dockProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility, orderedControls } from './layout-host';
import { openContextActions } from './context-actions';
import { DOCK_CONTROLS, DOCK_CONTROLS_LOCATION, DOCK_GROUPS, DOCK_PINNED_CONTROLS, TEAM_CONTROLS_LOCATION, TEAM_PARTS, TEAM_PINNED_PARTS } from './surfaces';

export type DockHostState = { project?: string; task?: string; team?: TeamSnapshot | null; needsInput: (sessionId: string) => boolean };

/** The original node of each dock item (references inside the dock, not new actions). */
const DOCK_NODES: Readonly<Record<string, string>> = {
  inspector: '#inspector-toggle', terminal: '#terminal-toggle', browser: '#browser-toggle', moodboards: '[data-group=panels] > [data-action=moodboards]',
  agents: '#agents-toggle', run: '#run-project-button', deploy: '#deploy-button', 'task-menu': '#task-menu-trigger',
};
const LABELS: Readonly<Partial<Record<DockControl, string>>> = { run: 'Run project' };
const pending = (worker: TeamWorker) => !worker.abandoned && ['running', 'waiting', 'queued', 'parked'].includes(worker.status);
const TEAM_PART_IDS = TEAM_PARTS.map(([id]) => `${TEAM_CONTROLS_LOCATION}/${id}`);

export function mountDockAdoption(options: {
  dock: HTMLElement;
  root: HTMLElement;
  flyout: HTMLElement;
  state: () => DockHostState;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
}) {
  const { dock, root, flyout } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, closeContext: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const dockBindings = () => DOCK_CONTROLS.map(([id]) => [`${DOCK_CONTROLS_LOCATION}/${id}`, dock.querySelector<HTMLElement>(DOCK_NODES[id])] as const);
  const contributes = (location: string) => extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (node: Element) => node.getClientRects().length > 0;
  /** The open task's Workers lines in the main transcript (saved turns and the live turn); tile mirrors are inert copies. */
  const lists = (task: string) => [...document.querySelectorAll<HTMLElement>('#transcript .team-progress')].filter(list => list.dataset.sessionId === task && !list.closest('.thread-mirror'));

  function authority() {
    const provider = dockProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider && dock.dataset.dockProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true, progress: Boolean(owner?.manifest.permissions?.includes('tasks.summary')) };
  }
  function presentation(): DockPresentation {
    const state = options.state(), auth = authority(), team = state.task && state.team?.sessionId === state.task ? state.team : undefined, teamHidden = new Set((root.dataset.teamHidden ?? '').split(' ').filter(Boolean));
    finders.clear();
    const controls: { id: string; controlId: DockControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    const add = (controlId: DockControl, key: string, resource: string, find: () => HTMLElement | null, enabled = true, hidden = false) => {
      const node = find(); if (!node) return;
      const id = handle(`control:${controlId}:${key}`); finders.set(id, find);
      controls.push({ id, controlId, resource, enabled: enabled && !(node as HTMLButtonElement).disabled && !node.hidden, hidden: hidden || Boolean(node.closest('[data-layout-hidden]')) });
    };
    for (const [id] of DOCK_CONTROLS) add(id, id, '', () => dock.querySelector<HTMLElement>(DOCK_NODES[id]));
    const teamHandle = team ? handle(`team:${team.sessionId}`) : '';
    const workerHandle = (id: string) => handle(`worker:${team?.sessionId}:${id}`);
    if (team) for (const list of lists(team.sessionId)) {
      // A list is keyed by its first worker: a redraw keeps the key, a re-placement is a new list.
      const key = list.querySelector<HTMLElement>('.team-progress-worker')?.dataset.workerId ?? '', within = (selector: string) => () => lists(team.sessionId).find(item => (item.querySelector<HTMLElement>('.team-progress-worker')?.dataset.workerId ?? '') === key)?.querySelector<HTMLElement>(selector) ?? null;
      add('team-toggle', key, teamHandle, within('.team-progress-toggle'));
      add('team-open', key, teamHandle, within('.team-progress-menu'), true, teamHidden.has('menu'));
      add('workers-more', key, teamHandle, within('.team-progress-more'), list.hasAttribute('data-open'));
      // A worker row acts only while its list is open, as a pointer could.
      for (const row of list.querySelectorAll<HTMLElement>('.team-progress-worker')) {
        const worker = row.dataset.workerId ?? ''; if (!worker || !team.workers.some(item => item.id === worker)) continue;
        add('worker-open', worker, workerHandle(worker), () => lists(team.sessionId).flatMap(item => [...item.querySelectorAll<HTMLElement>('.team-progress-worker')]).find(node => node.dataset.workerId === worker) ?? null, list.hasAttribute('data-open'));
      }
    }
    // Progress is permissioned (tasks.summary); presentation and actions never depend on it.
    const progress = Boolean(team && auth.progress), spawned = progress ? team!.workers : [];
    const workerStatus = (worker: TeamWorker): DockWorkerStatus => worker.abandoned ? 'skipped' : !teamActive(team!) && pending(worker) ? 'paused' : worker.status;
    const attention = (worker: TeamWorker) => !worker.abandoned && (worker.status === 'waiting' || worker.status === 'running' && state.needsInput(worker.sessionId));
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: state.task ? handle(`task:${state.task}`) : '', team: teamHandle,
      revision: 0, visible: !disposed && dock.isConnected && shown(dock), busy: choosing || Boolean(document.querySelector('dialog[open]')) || dock.hasAttribute('data-snap'),
      safeMode: extensionsSnapshot().safeMode, row: getComputedStyle(dock).position !== 'absolute', flyout: !flyout.hidden,
      progress, status: progress ? team!.status : 'none' as const,
      running: spawned.filter(worker => worker.status === 'running' && !worker.abandoned && teamActive(team!)).length,
      attention: spawned.filter(attention).length, failed: spawned.filter(worker => worker.status === 'failed' && !worker.abandoned).length, total: Math.min(spawned.length, 10000),
      groups: DOCK_GROUPS.map(id => { const group = dock.querySelector<HTMLElement>(`:scope > [data-group="${id}"]`); return { id, shown: Boolean(group && shown(group)) }; }),
      workers: spawned.slice(0, 64).map(worker => ({ id: workerHandle(worker.id), status: workerStatus(worker), attention: attention(worker) })),
      controls: controls.slice(0, 128), truncated: spawned.length > 64 || controls.length > 128,
    };
    const next = JSON.stringify([value, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotDock({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; running the project's script needs a fresh host choice. */
  function execute(action: DockAction, alive: () => boolean) {
    const node = finders.get(action.control)?.(); if (!node) return;
    if (!DOCK_ENTRY_CONTROLS.includes(action.controlId)) { node.click(); return; }
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: node, title: 'Extension requested a dock action', items: [{ id: 'continue', label: `Continue: ${LABELS[action.controlId] ?? action.controlId}`, icon: 'play' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createDockPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order inside each group and reversible visibility on the original dock items, and the Workers line's parts
   * through one workspace attribute: nodes, listeners, the roving stop and focus stay. Safe mode is built-in. */
  function applyLayout() {
    const safe = disposed || extensionsSnapshot().safeMode, items = dockBindings();
    applyControlOrder(DOCK_CONTROLS_LOCATION, items, safe);
    const hideable = items.filter(([id]) => !DOCK_PINNED_CONTROLS[id.slice(DOCK_CONTROLS_LOCATION.length + 1) as keyof typeof DOCK_PINNED_CONTROLS]);
    if (safe) for (const [, node] of items) { if (node?.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; } }
    else {
      // A forged overlay never hides a pinned item.
      for (const [id, node] of items) if (node && !hideable.some(([other]) => other === id) && node.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; }
      applyControlVisibility(hideable, () => [...dock.querySelectorAll<HTMLElement>('button')].find(node => !node.closest('[data-layout-hidden]') && shown(node)) ?? null);
    }
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const parts = safe ? '' : TEAM_PARTS.filter(([id]) => !TEAM_PINNED_PARTS[id] && layout.isHidden(`${TEAM_CONTROLS_LOCATION}/${id}`, layoutProject())).map(([id]) => id).join(' ');
    const order = !safe && orderedControls(TEAM_CONTROLS_LOCATION, TEAM_PART_IDS)[0] === `${TEAM_CONTROLS_LOCATION}/menu` ? 'menu-first' : '';
    for (const [name, value] of [['teamHidden', parts], ['teamOrder', order]] as const) if ((root.dataset[name] ?? '') !== value) { if (value) root.dataset[name] = value; else delete root.dataset[name]; }
    // An Open team button that hid under focus hands focus to its Workers toggle.
    if (focused?.matches('.team-progress-menu') && !shown(focused)) focused.closest('.team-progress')?.querySelector<HTMLElement>('.team-progress-toggle')?.focus({ preventScroll: true });
  }
  function refresh() {
    if (disposed) return;
    closeContext?.(); closeContext = undefined; lastProject = layoutProject();
    if (!applyDockPresentation(dock)) options.notify('Action dock presentation failed. The built-in dock remains active.');
    applyLayout();
  }
  /** Context for contributed team actions: the parent task's team, never a worker. Empty ids are omitted. */
  function actionContext(task: string) {
    const project = options.state().project;
    return { ...(project ? { projectId: project } : {}), sessionId: task, revision: presentation().revision, selection: { kind: 'team', ids: [task] } };
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (disposed || extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    const head = event.target.closest<HTMLElement>('.team-progress-head'), list = head?.closest<HTMLElement>('.team-progress');
    const task = options.state().task;
    if (!head || !list || !task || list.dataset.sessionId !== task || !list.closest('#transcript') || list.closest('.thread-mirror')) return;
    // With nothing contributed here the Workers head keeps its zero-extension behavior: no new menu.
    if (!contributes('panda.team.context')) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    if (event.target.closest('[data-extension-contribution]')) return;
    const open = list.hasAttribute('data-open');
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    const alive = () => !disposed && list.isConnected && options.state().task === task;
    closeContext = openContextActions(head, 'panda.team.context', actionContext(task), { title: 'Workers', items: [{ id: 'toggle', label: open ? 'Hide workers' : 'Show workers', icon: 'chevron' }, { id: 'open', label: 'Open team', icon: 'team' }], onSelect: id => {
      if (!alive()) return;
      if (id === 'toggle') list.querySelector<HTMLElement>('.team-progress-toggle')?.click();
      else if (id === 'open') list.querySelector<HTMLElement>('.team-progress-menu')?.click();
    }, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: alive, onClose: () => { closeContext = undefined; } });
  }
  root.addEventListener('contextmenu', openContext); root.addEventListener('keydown', openContext);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); closeContext?.(); stopExtensions(); stopLayout(); stopContext();
      root.removeEventListener('contextmenu', openContext); root.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh);
      applyLayout(); delete dock.dataset.dockProvider;
      // The built-in group order: panels, actions, status.
      const panels = dock.querySelector<HTMLElement>(':scope > [data-group="panels"]'), actions = dock.querySelector<HTMLElement>(':scope > [data-group="actions"]');
      if (panels && actions && panels.nextElementSibling !== actions) dock.insertBefore(panels, actions);
    },
  };
}
