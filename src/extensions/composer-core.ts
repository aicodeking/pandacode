/** JSON-only captured composer controls admission: tray controls, the model picker, the Permissions menu and the steer
 * bar. Drafts, the selected model, the approval mode, Send, Stop and approvals stay in the host. */
import { validateContract } from './contracts.ts';
import { COMPOSER_TRAY_CONTROLS, COMPOSER_TRAY_PINNED, COMPOSER_TRAY_FIXED, COMPOSER_MODEL_ENTRIES, COMPOSER_STEER_PARTS, COMPOSER_STEER_PINNED, COMPOSER_PROTECTED, COMPOSER_PERMISSION_REASON, COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION, COMPOSER_PERMISSIONS_LOCATION, COMPOSER_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured composer control ids (`composerControlId`): the tray controls, then the steer bar's parts. */
export const COMPOSER_CONTROL_IDS = ['model', 'mode', 'team', 'saver', 'council', 'run-target', 'steer-edit', 'steer', 'steer-clear'] as const;
export type ComposerControl = typeof COMPOSER_CONTROL_IDS[number];
export type ComposerMode = 'ask' | 'auto' | 'review' | 'plan' | 'full';
export type ComposerPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; running: boolean; steering: boolean; draft: boolean; mode: ComposerMode;
  controls: readonly Readonly<{ id: string; controlId: ComposerControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type ComposerAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: ComposerControl; resource: string; requestId: string }>;
export type ComposerAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type ComposerAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Steering sends the user's draft into the running turn and Clear empties it: both run only after a fresh host user
 * choice. Every other control opens its original host menu, picker or panel, where the user makes the choice. */
export const COMPOSER_ENTRY_CONTROLS: readonly ComposerControl[] = ['steer', 'steer-clear'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. A mode or model change happens only through the user's choice in the original menu or picker. */
export const COMPOSER_PROTECTED_CONTROLS = ['mode-set', 'model-set', 'effort-set', 'team-set', 'send', 'stop', 'approve', 'deny'] as const;

/** One explicit entry per member of the ledger's composer families this adapter owns (`panda.composer.tray`,
 * `.model`, `.permissions`, `.steering` and the `panda.menus.permissions` menu). Each lists its public locations,
 * the operations it supports and the reason for each it does not. */
export type ComposerRegistryEntry = Readonly<{ member: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; reason: string }>;
const reasons = (...records: Readonly<Record<string, string | undefined>>[]) => records.flatMap(record => Object.entries(record)).map(([id, why]) => `${id}: ${why}`).join(' ');
export const COMPOSER_REGISTRY: readonly ComposerRegistryEntry[] = Object.freeze([
  { member: 'panda.composer.tray', locations: ['panda.composer.tray', COMPOSER_TRAY_LOCATION, COMPOSER_PROTECTED_LOCATION], controls: COMPOSER_TRAY_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'none', reason: `Contributed tray buttons stay panda.composer.tray. ${reasons(COMPOSER_TRAY_PINNED, COMPOSER_TRAY_FIXED)}` },
  { member: 'panda.composer.model', locations: [COMPOSER_MODEL_LOCATION, 'panda.composer.model.actions', COMPOSER_PROTECTED_LOCATION], controls: COMPOSER_MODEL_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.model.actions', reason: `The task's current harness and a selected team never hide; package harnesses keep their entry. ${COMPOSER_PROTECTED[1][2]}` },
  { member: 'panda.composer.permissions', locations: [COMPOSER_PERMISSIONS_LOCATION, COMPOSER_PROTECTED_LOCATION], controls: ['mode'], order: false, hide: false, actions: true, context: COMPOSER_PERMISSIONS_LOCATION, reason: `${COMPOSER_PERMISSION_REASON} ${COMPOSER_PROTECTED[0][2]}` },
  { member: 'panda.composer.steering', locations: ['panda.composer.steering.actions', COMPOSER_STEER_LOCATION, COMPOSER_PROTECTED_LOCATION], controls: COMPOSER_STEER_PARTS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.steering.actions', reason: `${reasons(COMPOSER_STEER_PINNED)} Steer and Clear need a fresh host choice; ${COMPOSER_PROTECTED[2][2]}` },
  { member: 'panda.menus.permissions', locations: [COMPOSER_PERMISSIONS_LOCATION], controls: ['ask', 'auto', 'review', 'plan', 'full'], order: false, hide: false, actions: true, context: COMPOSER_PERMISSIONS_LOCATION, reason: COMPOSER_PERMISSION_REASON },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotComposer(props: ComposerPresentation): ComposerPresentation {
  if (!validateContract('composerPresentation', props).ok) throw Error('Invalid composer presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate composer handle');
  return freeze(structuredClone(props));
}
export function createComposerControls(props: ComposerPresentation, owner: string, current: () => ComposerPresentation, authority: () => ComposerAuthority, dispatch: (action: ComposerAction) => void, applied = new Set<string>()) {
  const captured = snapshotComposer(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): ComposerAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((COMPOSER_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('composerAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as ComposerAction, live = current();
    // Switching task, an edited draft, a new mode or a redraw is another target; so is a hidden composer.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open picker, menu, dialog or pending host choice keeps its input: nothing acts until it ends.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (COMPOSER_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
