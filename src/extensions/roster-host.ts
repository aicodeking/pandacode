/** Host-only agent roster bindings (docs/extensions/agent-roster.md): children, their streams and lineage, team
 * profiles and the Running agents widget never cross the package boundary. */
import { isImeKey } from '../dom';
import type { Subagents } from '../subagents';
import { activeTeamProfiles, TEAM_PROFILES_EVENT } from '../team-profiles';
import { createRosterPresentation, snapshotRoster, ROSTER_ENTRY_CONTROLS, type RosterAction, type RosterControl, type RosterPresentation } from './roster-core';
import { applyRosterPresentation, rosterProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility } from './layout-host';
import { openContextActions } from './context-actions';
import { ROSTER_CONTROLS, ROSTER_CONTROLS_LOCATION, ROSTER_PINNED_CONTROLS, type RosterControlPart } from './surfaces';

export type RosterHostState = { project?: string; task?: string };
type Control = { id: string; controlId: RosterControl; resource: string; enabled: boolean; hidden: boolean };

export function mountRosterAdoption(options: {
  subagents: Subagents;
  /** The main subagent view's host (`#subagents-host`): its trigger, and the panel while it is open. */
  subagentsHost: HTMLElement;
  /** The main-window Running agents widget host (`#agents-dock-host`). */
  widget: HTMLElement;
  state: () => RosterHostState;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
}) {
  const { subagents, subagentsHost, widget } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>();
  const finders = new Map<string, () => HTMLElement | null>(), profileTargets = new Map<string, string>();
  let disposed = false, identity = '', revision = 0, signature = '', lastProject = layoutProject();
  let closeContext: (() => void) | undefined;
  const handle = (key: string) => { if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const panel = () => document.getElementById(subagents.roster().panelId);
  const profilesHost = () => activeTeamProfiles()?.host;
  /** The original node of each layout part (references inside the host, not new actions). */
  const NODES: Readonly<Record<RosterControlPart, () => HTMLElement | null>> = {
    back: () => panel()?.querySelector<HTMLElement>('.subagents-back') ?? null, close: () => panel()?.querySelector<HTMLElement>('.subagents-close') ?? null,
    picker: () => profilesHost()?.querySelector<HTMLElement>('.team-library-picker') ?? null, manage: () => profilesHost()?.querySelector<HTMLElement>('.team-library-manage') ?? null,
    create: () => profilesHost()?.querySelector<HTMLElement>('.team-library-create') ?? null, update: () => profilesHost()?.querySelector<HTMLElement>('.team-library-update') ?? null,
    widget: () => widget.querySelector<HTMLElement>('.agents-dock-trigger'), pin: () => widget.querySelector<HTMLElement>('.agents-dock-pin'),
  };
  const bindings = () => ROSTER_CONTROLS.map(([id]) => [`${ROSTER_CONTROLS_LOCATION}/${id}`, NODES[id]()] as const);
  const contributes = (location: string) => extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (node: Element) => node.getClientRects().length > 0;

  function authority() {
    const provider = rosterProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider && subagentsHost.dataset.rosterProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true, progress: Boolean(owner?.manifest.permissions?.includes('tasks.summary')) };
  }
  function presentation(): RosterPresentation {
    const state = options.state(), auth = authority(), view = subagents.roster(), profiles = activeTeamProfiles();
    // Children belong to the task they were reported for: another task's children are never in this snapshot.
    const task = state.task && view.task === state.task ? state.task : '';
    const child = (id: string) => handle(`child:${task}:${id}`);
    finders.clear(); profileTargets.clear();
    const controls: Control[] = [];
    const add = (controlId: RosterControl, key: string, resource: string, find: () => HTMLElement | null, enabled = true) => {
      const node = find(); if (!node) return '';
      const id = handle(`control:${controlId}:${key}`); finders.set(id, find);
      controls.push({ id, controlId, resource, enabled: enabled && !(node as HTMLButtonElement).disabled && !node.hidden, hidden: Boolean(node.closest('[data-layout-hidden]')) });
      return id;
    };
    const open = panel(), list = open?.querySelector<HTMLElement>('.subagents-list');
    if (task) {
      add('subagents', 'subagents', '', () => subagentsHost.querySelector<HTMLElement>(':scope > .subagents-trigger'));
      add('subagents-back', 'back', '', NODES.back); add('subagents-close', 'close', '', NODES.close);
      add('subagents-retry', 'retry', '', () => panel()?.querySelector<HTMLElement>('.subagents-retry') ?? null);
      // A row opens its child only while the list shows, as a pointer could.
      for (const row of list?.querySelectorAll<HTMLElement>('[data-subagent-id]') ?? []) {
        const id = row.dataset.subagentId ?? ''; if (!id || !view.children.some(item => item.id === id)) continue;
        add('subagent-open', id, child(id), () => panel()?.querySelector<HTMLElement>(`.subagents-list [data-subagent-id="${CSS.escape(id)}"]`) ?? null, !list!.hidden);
      }
    }
    if (profiles) {
      add('profile-picker', 'picker', '', NODES.picker); add('profile-manage', 'manage', '', NODES.manage);
      add('profile-create', 'create', '', NODES.create); add('profile-update', 'update', '', NODES.update);
      for (const choice of profiles.choices()) {
        const id = add('profile-select', choice.id, handle(`profile:${choice.id}`), NODES.picker);
        if (id) profileTargets.set(id, choice.id);
      }
    }
    const trigger = NODES.widget(), popover = widget.querySelector<HTMLElement>('.agents-dock-popover');
    add('widget', 'widget', '', NODES.widget);
    // A widget row opens its task only while the widget is open.
    for (const row of widget.querySelectorAll<HTMLElement>('.agents-dock-list [data-agent-id]')) {
      const id = row.dataset.agentId ?? ''; if (!id) continue;
      add('widget-open', id, handle(`agent:${id}`), () => [...widget.querySelectorAll<HTMLElement>('.agents-dock-list [data-agent-id]')].find(node => node.dataset.agentId === id) ?? null, Boolean(popover && !popover.hidden));
    }
    // Child and running-agent data are permissioned (tasks.summary); presentation and actions never depend on it.
    const progress = auth.progress, known = new Set(view.children.map(item => item.id));
    const children = progress && task ? view.children : [];
    const agents = progress ? [...widget.querySelectorAll<HTMLElement>('.agents-dock-list [data-agent-id]')] : [];
    const profile = profiles?.selectedId();
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '', profile: profile ? handle(`profile:${profile}`) : '',
      revision: 0, visible: !disposed && subagentsHost.isConnected,
      busy: Boolean(document.querySelector('dialog[open]')) || Boolean(profiles && (profiles.pending() || profiles.hasMenu())),
      safeMode: extensionsSnapshot().safeMode, view: !open || !task ? 'closed' as const : view.selected ? 'detail' as const : 'list' as const, child: task && view.selected ? child(view.selected) : '',
      setup: Boolean(profiles), widget: Boolean(trigger && !trigger.hidden), widgetOpen: Boolean(popover && !popover.hidden),
      progress, running: Math.min(children.filter(item => item.status === 'running' || item.status === 'waiting').length, 10000),
      children: children.slice(0, 64).map(item => ({ id: child(item.id), parent: item.parentId && known.has(item.parentId) ? child(item.parentId) : '', status: item.status, active: item.status === 'running' || item.status === 'waiting' })),
      agents: agents.slice(0, 64).map(row => ({ id: handle(`agent:${row.dataset.agentId}`), status: row.querySelector('.agents-dock-status-dot.running') ? 'running' as const : 'waiting' as const })),
      controls: controls.slice(0, 128), truncated: children.length > 64 || agents.length > 64 || controls.length > 128,
    };
    const next = JSON.stringify([value, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotRoster({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; applying or updating a profile needs a fresh host choice
   * that the profile form itself shows, so its setup stays open. */
  function execute(action: RosterAction, alive: () => boolean) {
    const node = finders.get(action.control)?.(), profiles = activeTeamProfiles(); if (!node) return;
    if (!ROSTER_ENTRY_CONTROLS.includes(action.controlId)) { node.click(); return; }
    const choice = profileTargets.get(action.control);
    profiles?.confirm(action.controlId === 'profile-update' ? 'Update profile' : 'Apply team profile', () => {
      if (!alive()) return;
      if (action.controlId === 'profile-update') finders.get(action.control)?.()?.click();
      else if (choice) profiles.choose(choice);
    });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createRosterPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order inside each control's own parent and reversible visibility on the original nodes: nodes, listeners and
   * focus stay. Pinned controls never hide, even under a forged overlay. Safe mode is built-in. */
  function applyLayout() {
    const safe = disposed || extensionsSnapshot().safeMode, items = bindings();
    applyControlOrder(ROSTER_CONTROLS_LOCATION, items, safe);
    const pinned = (id: string) => Boolean(ROSTER_PINNED_CONTROLS[id.slice(ROSTER_CONTROLS_LOCATION.length + 1) as RosterControlPart]);
    for (const [id, node] of items) if (node && (safe || pinned(id)) && node.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; }
    if (!safe) {
      const hideable = items.filter(([id]) => !pinned(id));
      // A control that hides under focus hands it to the first shown control of the same view.
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null, scope = focused?.closest<HTMLElement>('.team-library, .agents-dock-host') ?? null;
      applyControlVisibility(hideable, () => [...scope?.querySelectorAll<HTMLElement>('button') ?? []].find(node => !node.closest('[data-layout-hidden]') && shown(node)) ?? null);
    }
  }
  function refresh() {
    if (disposed) return;
    closeContext?.(); closeContext = undefined; lastProject = layoutProject();
    if (!applyRosterPresentation(subagentsHost, order => subagents.setArrange(order))) options.notify('Agent roster presentation failed. The built-in roster remains active.');
    applyLayout();
  }
  /** Context for contributed subagent actions: the parent task and that child's opaque handle. Empty ids are omitted. */
  function actionContext(task: string, child: string) {
    const project = options.state().project;
    return { ...(project ? { projectId: project } : {}), sessionId: task, revision: presentation().revision, selection: { kind: 'subagent', ids: [handle(`child:${task}:${child}`)] } };
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (disposed || extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('.subagents-list [data-subagent-id]'), task = options.state().task, child = row?.dataset.subagentId ?? '';
    if (!row || !task || !child || subagents.roster().task !== task || !panel()?.contains(row)) return;
    // With nothing contributed here a subagent row keeps its zero-extension behavior: no new menu.
    if (!contributes('panda.roster.context')) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    const alive = () => !disposed && row.isConnected && options.state().task === task && subagents.roster().task === task;
    closeContext = openContextActions(row, 'panda.roster.context', actionContext(task, child), { title: 'Subagent', items: [{ id: 'open', label: 'Open subagent', icon: 'chevron' }], onSelect: id => {
      if (alive() && id === 'open') row.click();
    }, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: alive, onClose: () => { closeContext = undefined; } });
  }
  subagentsHost.addEventListener('contextmenu', openContext); subagentsHost.addEventListener('keydown', openContext);
  // The subagent view and the profile form mount later and redraw: each draw re-applies the layout to the new nodes.
  const onRoster = () => { if (!disposed) applyLayout(); };
  addEventListener('pandacode:agents', onRoster); addEventListener(TEAM_PROFILES_EVENT, onRoster);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; closeContext?.(); stopExtensions(); stopLayout(); stopContext();
      subagentsHost.removeEventListener('contextmenu', openContext); subagentsHost.removeEventListener('keydown', openContext);
      removeEventListener('pandacode:agents', onRoster); removeEventListener(TEAM_PROFILES_EVENT, onRoster); window.removeEventListener('pandacode-components-change', refresh);
      applyLayout(); delete subagentsHost.dataset.rosterProvider; subagents.setArrange(undefined);
    },
  };
}
