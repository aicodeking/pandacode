/** JSON-only captured admission for the Team menu and setup, the dock's Task actions menu, the Deploy menu and the task
 * Bot assignment menu. Starting or stopping a team, a task action, a deployment and a bot assignment run the original
 * handlers in main.ts; the draft, team configuration, credentials and the harness console never cross the boundary. */
import { validateContract } from './contracts.ts';
import { TASK_MENUS_ENTRIES, TASK_MENUS_PINNED, TASK_MENUS_PROTECTED, TASK_MENUS_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured control ids (`taskMenusControlId`). */
export const TASK_MENUS_CONTROL_IDS = ['team-select', 'team-setup-open', 'task-run', 'task-delete', 'deploy-run', 'bot-assign'] as const;
export type TaskMenusControl = typeof TASK_MENUS_CONTROL_IDS[number];
export type TaskMenusOpen = 'none' | 'team' | 'setup' | 'task' | 'deploy' | 'bot';
/** `team`, `connection` and `bot` are opaque handles ('' when the task has none): the task's team, the connected deploy
 * platforms (their set, never a token or project ID) and the task's bot. `menu` is the host menu that is open. */
export type TaskMenusPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; team: string; connection: string; bot: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; menu: TaskMenusOpen;
  controls: readonly Readonly<{ id: string; controlId: TaskMenusControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type TaskMenusAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; team: string; connection: string; bot: string; revision: number; control: string; controlId: TaskMenusControl; resource: string; requestId: string }>;
export type TaskMenusAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type TaskMenusAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Changing a team, deleting a task, deploying and assigning a bot run the original handler only after a fresh host
 * user choice bound to the same task, team, connections and bot. Opening the setup and the entries that only open a
 * dialog or copy a path act on what the user already sees. */
export const TASK_MENUS_CHOICE_CONTROLS: readonly string[] = ['team-select', 'task-delete', 'deploy-run', 'bot-assign'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check. Saving a
 * team, profiles, the harness console, connecting a platform, credentials and a bot's own settings stay in the host. */
export const TASK_MENUS_PROTECTED_CONTROLS = ['team-save', 'team-profile-edit', 'task-console', 'task-delete-confirm', 'deploy-connect', 'deploy-credentials', 'bot-credentials', 'bot-create', 'bot-delete'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.menus.team`, `.task`, `.deploy`, `.bot-assignment`). */
export type TaskMenusRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const protectedReason = (...ids: string[]) => TASK_MENUS_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
const pinnedReason = (location: string) => Object.entries(TASK_MENUS_PINNED).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`).join(' ');
const entryIds = (location: keyof typeof TASK_MENUS_ENTRIES) => TASK_MENUS_ENTRIES[location].map(([id]) => id);
export const TASK_MENUS_REGISTRY: readonly TaskMenusRegistryEntry[] = Object.freeze([
  { member: 'panda.menus.team', source: 'src/main.ts', locations: ['panda.team.menu', 'panda.team.setup.actions', TASK_MENUS_PROTECTED_LOCATION], controls: entryIds('panda.team.menu'), order: true, hide: true, actions: true, context: 'panda.team.menu', selection: 'team', reason: `The kinds of automatic team hide and reorder in the Team menu; contributed items there and in Architect & workers capture the task and its team. Choosing a team for a package needs a fresh host choice. ${pinnedReason('panda.team.menu')} ${protectedReason('team-save', 'team-profile')}` },
  { member: 'panda.menus.task', source: 'src/main.ts', locations: ['panda.task.menu', TASK_MENUS_PROTECTED_LOCATION], controls: entryIds('panda.task.menu'), order: true, hide: true, actions: true, context: 'panda.task.menu', selection: 'task', reason: `The dock's Task actions entries hide and reorder; contributed items capture the open task. ${pinnedReason('panda.task.menu')} ${protectedReason('task-delete', 'task-console')}` },
  { member: 'panda.menus.deploy', source: 'src/main.ts', locations: ['panda.deploy.menu', TASK_MENUS_PROTECTED_LOCATION], controls: entryIds('panda.deploy.menu'), order: true, hide: true, actions: true, context: 'panda.deploy.menu', selection: 'connection', reason: `The deploy platforms hide and reorder; contributed items capture the project and the connected platforms. ${protectedReason('deploy-run', 'deploy-credentials')}` },
  { member: 'panda.menus.bot-assignment', source: 'src/main.ts', locations: ['panda.bot.assignment', TASK_MENUS_PROTECTED_LOCATION], controls: [], order: false, hide: false, actions: true, context: 'panda.bot.assignment', selection: 'bot', reason: `Contributed items capture the task and the bots listed; the listed bots keep the bots list's order. ${pinnedReason('panda.bot.assignment')} ${protectedReason('bot-assign', 'bot-rows', 'bot-credentials')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'team', 'connection', 'bot', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotTaskMenus(props: TaskMenusPresentation): TaskMenusPresentation {
  if (!validateContract('taskMenusPresentation', props).ok) throw Error('Invalid task menus presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate task menus handle');
  return freeze(structuredClone(props));
}
export function createTaskMenusControls(props: TaskMenusPresentation, owner: string, current: () => TaskMenusPresentation, authority: () => TaskMenusAuthority, dispatch: (action: TaskMenusAction) => void, applied = new Set<string>()) {
  const captured = snapshotTaskMenus(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): TaskMenusAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((TASK_MENUS_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('taskMenusAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as TaskMenusAction, live = current();
    // Another task, team, set of connections or bot, a redraw or a hidden trigger is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open menu, another dialog or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (TASK_MENUS_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
