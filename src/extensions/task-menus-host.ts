/** Host-only bindings for the Team menu and Architect & workers setup, the dock's Task actions menu, the Deploy menu and
 * the task Bot assignment menu: each menu passes an extension surface with its captured task, team, connections or bot
 * (contributed items, the user's order and reversible visibility of the eligible entries), and captured actions run
 * the menus' original handlers in main.ts. Team configuration, the harness console, platform connections and
 * credentials, and a bot's own settings never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createTaskMenusControls, snapshotTaskMenus, TASK_MENUS_CHOICE_CONTROLS, type TaskMenusAction, type TaskMenusControl, type TaskMenusOpen, type TaskMenusPresentation } from './task-menus-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { TASK_MENUS_ENTRIES, TASK_MENUS_PINNED, type TaskMenusActionLocation } from './surfaces';

/** What the host's menus offer for the open task right now. `bots` is undefined while the task cannot choose a bot; `deploy`
 * while no project can be deployed. Names are the host's own words for the fresh choice and never reach a package. */
export type TaskMenusHostState = {
  task?: string; project?: string; team: boolean; teamCurrent: string; teamEntries: readonly string[]; setup: boolean;
  taskEntries: readonly { id: string; enabled: boolean }[];
  /** Whether a project can be deployed; the platforms are the connected ones. */
  deploy: boolean; connected: readonly string[];
  bot?: string; bots?: readonly { id: string; name: string }[];
  /** The host menu that is open; `setup` while Architect & workers is. */
  menu: TaskMenusOpen; busy: boolean; generation: number;
};
/** One host request: the original handler resolves `key` against the captured task. */
export type TaskMenusHostRequest = { controlId: TaskMenusControl; key: string; task: string };
type Anchor = 'team' | 'setup' | 'task' | 'deploy' | 'bot';
type Control = { id: string; controlId: TaskMenusControl; resource: string; enabled: boolean; hidden: boolean };

const shown = (element: Element | null | undefined): element is Element => Boolean(element && element.isConnected && element.getClientRects().length > 0);
const TEAM_LABELS: Readonly<Record<string, string>> = { off: 'No team', lead: 'Team: the lead picks models', ...Object.fromEntries(TASK_MENUS_ENTRIES['panda.team.menu'].map(([id, label]) => [id, label])) };
const TASK_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TASK_MENUS_ENTRIES['panda.task.menu'].map(([id, label]) => [id, label]));
const DEPLOY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TASK_MENUS_ENTRIES['panda.deploy.menu'].map(([id, label]) => [id, label]));
export const TASK_MENUS_LABELS = { team: TEAM_LABELS, task: TASK_LABELS, deploy: DEPLOY_LABELS } as const;

export function mountTaskMenusAdoption(options: {
  state: () => TaskMenusHostState;
  /** The control that opens each menu, for the fresh host choice's anchor and for visibility. */
  anchor: (menu: Anchor) => HTMLElement | null;
  /** Runs the original handler; `alive` re-checks the captured identity after any host choice. */
  execute: (request: TaskMenusHostRequest, alive: () => boolean) => void;
  /** Reads the connected deploy platforms once a package consumes them. */
  loadConnections: () => void;
  notify: (message: string) => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), keys = new Map<string, string>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, asked = false;
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const hidden = (location: TaskMenusActionLocation, id: string) => !safe() && !TASK_MENUS_PINNED[`${location}/${id}`] && layout.isHidden(`${location}/${id}`, layoutProject());
  const contributes = (location: TaskMenusActionLocation) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));

  function authority() {
    const provider = componentSelection.resolve('panda.composer', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const composer = document.querySelector<HTMLElement>('#composer');
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && composer?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }

  function presentation(): TaskMenusPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '';
    keys.clear();
    // The deploy platforms are read once a package consumes them: nothing is requested while no owner is active.
    if (auth.active && task && !asked) { asked = true; options.loadConnections(); }
    const controls: Control[] = [];
    const add = (controlId: TaskMenusControl, key: string, enabled: boolean, location?: TaskMenusActionLocation, id?: string) => {
      const control = handle(`control:${task}:${controlId}:${key}`);
      keys.set(control, key);
      controls.push({ id: control, controlId, resource: handle(`resource:${task}:${key}`), enabled, hidden: Boolean(location && id && hidden(location, id)) });
    };
    if (task) {
      for (const id of state.teamEntries) if (id !== 'named') add('team-select', `team:${id}`, id !== state.teamCurrent && shown(options.anchor('team')), 'panda.team.menu', id);
      if (shown(options.anchor('setup')) || shown(options.anchor('team'))) add('team-setup-open', 'setup', true);
      for (const item of state.taskEntries) {
        if (item.id === 'harness-console') continue;
        add(item.id === 'delete-task' ? 'task-delete' : 'task-run', `task:${item.id}`, item.enabled && shown(options.anchor('task')), 'panda.task.menu', item.id);
      }
      if (state.deploy) for (const [id] of TASK_MENUS_ENTRIES['panda.deploy.menu']) add('deploy-run', `deploy:${id}`, state.connected.includes(id) && shown(options.anchor('deploy')), 'panda.deploy.menu', id);
      if (state.bots) {
        add('bot-assign', 'bot:none', state.bot !== undefined && shown(options.anchor('bot')));
        for (const bot of state.bots) add('bot-assign', `bot:${bot.id}`, bot.id !== state.bot && shown(options.anchor('bot')));
      }
    }
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: task && state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      team: task && state.team ? handle(`team:${task}`) : '', connection: task && state.connected.length ? handle(`connections:${state.project ?? ''}:${state.connected.join(',')}`) : '', bot: task && state.bot ? handle(`bot:${state.bot}`) : '',
      revision: 0, visible: !disposed && Boolean(task && (['team', 'setup', 'task', 'deploy', 'bot'] as const).some(menu => shown(options.anchor(menu)))),
      // An open menu or setup, another dialog or a pending host choice holds input.
      busy: choosing || state.busy || state.menu !== 'none' || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, menu: state.menu,
      controls: controls.slice(0, 64), truncated: controls.length > 64,
    };
    const next = JSON.stringify([value, state.teamCurrent, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotTaskMenus({ ...value, revision });
  }

  /** A fresh host choice bound to the same target; Escape declines and nothing runs. */
  function ask(anchor: HTMLElement, label: string, icon: string, run: () => void, alive: () => boolean) {
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor, title: 'Extension requested a task menu action', items: [{ id: 'continue', label: `Continue: ${label}`, icon }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      closeChoice?.(); run();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createTaskMenusControls(presentation(), owner, presentation, authority, (action: TaskMenusAction) => {
      const key = keys.get(action.control) ?? '', state = options.state(), task = state.task!, held = identity;
      const alive = () => {
        const live = presentation();
        return authority().active && held === identity && live.task === action.task && live.team === action.team && live.connection === action.connection && live.bot === action.bot && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden);
      };
      const request = { controlId: action.controlId, key, task };
      if (!TASK_MENUS_CHOICE_CONTROLS.includes(action.controlId)) { options.execute(request, alive); return; }
      const [kind, id] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
      const menu: Anchor = action.controlId === 'team-select' ? 'team' : action.controlId === 'task-delete' ? 'task' : action.controlId === 'deploy-run' ? 'deploy' : 'bot';
      const label = kind === 'team' ? `Switch the team to ${TEAM_LABELS[id] ?? id}`
        : kind === 'task' ? 'Delete this task'
        : kind === 'deploy' ? `${DEPLOY_LABELS[id] ?? 'Deploy'} and start its task`
        : id === 'none' ? 'Start this task without a bot' : `Start this task with ${state.bots?.find(bot => bot.id === id)?.name ?? 'another bot'}`;
      const anchor = options.anchor(menu) ?? document.body;
      // The choice runs the same handler for the same task, team, connections and bot it was asked for.
      ask(anchor, label, kind === 'task' ? 'trash' : kind === 'deploy' ? 'upload' : kind === 'bot' ? 'bot' : 'team', () => options.execute(request, alive), alive);
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  const arranged = (location: TaskMenusActionLocation) => {
    const ids = TASK_MENUS_ENTRIES[location].map(([id]) => `${location}/${id}`);
    return ids.some(id => !TASK_MENUS_PINNED[id] && layout.isHidden(id, layoutProject())) || orderedControls(location, ids).some((id, index) => id !== ids[index]);
  };
  /** The extension surface of a host menu: undefined in safe mode and while nothing is contributed or arranged, so the
   * zero-extension menu keeps its own rows and roles. The captured context is built once at open; `alive` ends it when
   * the task, team, connections or bot changes. */
  function surface(location: TaskMenusActionLocation, selection: { kind: 'team' | 'task' | 'connection' | 'bot' | 'project'; ids: readonly string[] }, alive: () => boolean, pinned: readonly string[]) {
    if (safe() || !contributes(location) && !arranged(location)) return undefined;
    const state = options.state();
    const captured: Record<string, Json> = { revision: state.generation, ...(state.project ? { projectId: state.project } : {}), ...(state.task ? { sessionId: state.task } : {}), selection: { kind: selection.kind, ids: [...selection.ids] } };
    return { location, context: captured, isAlive: alive, pinned: pinned.filter(id => !TASK_MENUS_ENTRIES[location].some(([entry]) => entry === id)) };
  }
  /** Contributed actions in Architect & workers: a slot appended to the setup panel with the captured task and team. */
  function mountSetup(panel: HTMLElement, task: string, project: string | undefined): () => void {
    if (!contributes('panda.team.setup.actions')) return () => {};
    const state = options.state();
    const captured: Record<string, Json> = { revision: state.generation, ...(project ? { projectId: project } : {}), sessionId: task, selection: { kind: 'team', ids: [task] } };
    const host = document.createElement('div'); host.className = 'task-menus-setup-extensions'; panel.append(host);
    const dispose = mountExtensionActions(host, 'panda.team.setup.actions', () => captured, options.notify);
    // A contributed dialog keeps its captured team until it closes, then the actions end.
    return () => { const finish = () => { dispose(); host.remove(); }; const dialog = document.querySelector<HTMLDialogElement>('dialog[open]'); if (dialog) dialog.addEventListener('close', finish, { once: true }); else finish(); };
  }

  const stopExtensions = onExtensionsChanged(() => { asked = false; });
  return {
    surface, mountSetup, presentation, dispatch,
    dispose() { if (disposed) return; closeChoice?.(); stopExtensions(); disposed = true; },
  };
}
