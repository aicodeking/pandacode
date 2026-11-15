/** JSON-only captured admission for the composer's queue, token saver and council panels. Queued text and attachments,
 * queue order and delivery, token saver packs and the council's team decisions stay in the host. */
import { validateContract } from './contracts.ts';
import { PANEL_QUEUE_CONTROLS, PANEL_SAVER_CONTROLS, PANEL_COUNCIL_CONTROLS, PANEL_PINNED, PANEL_FIXED, PANEL_PROTECTED, PANEL_QUEUE_LOCATION, PANEL_SAVER_LOCATION, PANEL_COUNCIL_LOCATION, PANEL_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured panel control ids (`composerPanelControlId`). */
export const PANEL_CONTROL_IDS = ['queue-steer', 'queue-send-now', 'queue-edit', 'queue-resume', 'saver-tighten', 'saver-default', 'saver-off', 'council-strip-toggle', 'council-open-worker', 'council-lower-target', 'council-raise-rounds'] as const;
export type PanelControl = typeof PANEL_CONTROL_IDS[number];
export type PanelsPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean; running: boolean;
  /** The queue is held (after a restart, a failure, a Stop or a usage limit). */
  held: boolean;
  /** Opaque handles of the queued entries, in delivery order; never their text. */
  entries: readonly string[];
  /** The token saver panel is open for this task. */
  saver: boolean;
  /** The council strip shows a cycle; `cycle` is its opaque handle ('' without one). */
  council: boolean; cycle: string;
  controls: readonly Readonly<{ id: string; controlId: PanelControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type PanelsAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: PanelControl; resource: string; requestId: string }>;
export type PanelsAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type PanelsAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Controls that send, resume delivery or change what the thread sends: each runs its original handler only after a
 * fresh host user choice. The others open, focus or disclose something, and the user acts there. */
export const PANEL_CHOICE_CONTROLS: readonly PanelControl[] = ['queue-steer', 'queue-send-now', 'queue-resume', 'saver-tighten', 'saver-default', 'saver-off'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. */
export const PANEL_PROTECTED_CONTROLS = ['queue-remove', 'queue-save', 'queue-cancel', 'queue-reorder', 'saver-pack', 'saver-level', 'saver-install', 'council-accept', 'council-dismiss', 'council-keep-fixing', 'council-set'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.composer.queue`, `.saver`, `.council`), with its
 * public locations, the operations it supports and the reason for each it does not. */
export type PanelsRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const reasons = (location: string) => Object.entries({ ...PANEL_PINNED, ...PANEL_FIXED }).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`).join(' ');
const protectedReason = (...ids: string[]) => PANEL_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const PANELS_REGISTRY: readonly PanelsRegistryEntry[] = Object.freeze([
  { member: 'panda.composer.queue', source: 'src/message-queue.ts', locations: ['panda.composer.queue.actions', PANEL_QUEUE_LOCATION, PANEL_PROTECTED_LOCATION], controls: PANEL_QUEUE_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.queue.actions', selection: 'queue-entry', reason: `${reasons(PANEL_QUEUE_LOCATION)} Steer, Send now and Resume need a fresh host choice. ${protectedReason('queue-remove', 'queue-edit-commit', 'queue-order', 'queue-text')}` },
  { member: 'panda.composer.saver', source: 'src/token-saver-panel.ts', locations: ['panda.composer.saver.actions', PANEL_SAVER_LOCATION, PANEL_PROTECTED_LOCATION], controls: PANEL_SAVER_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.saver.actions', selection: 'token-saver', reason: `${reasons(PANEL_SAVER_LOCATION)} Tighten, Start new threads like this and Turn all off need a fresh host choice. ${protectedReason('saver-packs', 'saver-install')}` },
  { member: 'panda.composer.council', source: 'src/council-panel.ts', locations: ['panda.composer.council.actions', PANEL_COUNCIL_LOCATION, PANEL_PROTECTED_LOCATION], controls: PANEL_COUNCIL_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.council.actions', selection: 'council-cycle', reason: `${reasons(PANEL_COUNCIL_LOCATION)} ${PANEL_PINNED[`${PANEL_COUNCIL_LOCATION}/target`]} ${protectedReason('council-decisions', 'council-settings')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotPanels(props: PanelsPresentation): PanelsPresentation {
  if (!validateContract('composerPanelsPresentation', props).ok) throw Error('Invalid composer panels presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate composer panel handle');
  return freeze(structuredClone(props));
}
export function createPanelControls(props: PanelsPresentation, owner: string, current: () => PanelsPresentation, authority: () => PanelsAuthority, dispatch: (action: PanelsAction) => void, applied = new Set<string>()) {
  const captured = snapshotPanels(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): PanelsAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((PANEL_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('composerPanelsAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as PanelsAction, live = current();
    // Switching task, an edited, moved, sent or removed entry, a new council cycle or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open picker, menu, dialog or pending host choice keeps its input: nothing acts until it ends.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (PANEL_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
