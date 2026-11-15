/** JSON-only captured admission for the composer's Attach menu, Workflow recipes and wake-ups. Draft attachments,
 * recipe steps, deletes and schedule changes stay in the host. */
import { validateContract } from './contracts.ts';
import { ATTACH_MENU_ENTRIES, ATTACH_WAKE_MENU_ENTRIES, ATTACH_RECIPES_CONTROLS, ATTACH_WAKE_CONTROLS, ATTACH_PINNED, ATTACH_FIXED, ATTACH_PROTECTED, ATTACH_MENU_LOCATION, ATTACH_WAKE_MENU_LOCATION, ATTACH_RECIPES_LOCATION, ATTACH_WAKE_LOCATION, ATTACH_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured attach control ids (`composerAttachControlId`). */
export const ATTACH_CONTROL_IDS = ['attach-open', 'attach-file', 'recipe-pick', 'recipe-new', 'recipe-edit', 'recipe-run', 'wake-expand', 'wake-add', 'wake-run', 'wake-enable', 'wake-more'] as const;
export type AttachControl = typeof ATTACH_CONTROL_IDS[number];
export type AttachPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean;
  /** The task's draft holds text or attachments; never the text itself. */
  draft: boolean;
  /** How many attachments the draft holds; never their paths or contents. */
  attachments: number;
  /** The Workflow recipes dialog is open for this task; `recipe` is the selected recipe's opaque handle ('' without one). */
  recipes: boolean; recipe: string;
  /** The task's wake-up strip shows; `schedules` are opaque handles of its wake-ups. */
  wake: boolean; schedules: readonly string[];
  controls: readonly Readonly<{ id: string; controlId: AttachControl; resource: string; enabled: boolean; hidden: boolean }>[];
  truncated: boolean;
}>;
export type AttachAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: AttachControl; resource: string; requestId: string }>;
export type AttachAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type AttachAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Controls that change the draft, queue a recipe's steps or change a schedule: each runs its original handler only
 * after a fresh host user choice. The others open, select or disclose something, and the user acts there. */
export const ATTACH_CHOICE_CONTROLS: readonly AttachControl[] = ['attach-file', 'recipe-run', 'wake-run', 'wake-enable'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. */
export const ATTACH_PROTECTED_CONTROLS = ['attach-paths', 'attach-remove', 'recipe-delete', 'recipe-save', 'recipe-cancel', 'wake-create', 'wake-remove', 'wake-snooze', 'wake-set'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.menus.attach`, `panda.composer.recipes`,
 * `panda.composer.wake`, `panda.menus.wake`), with its public locations, the operations it supports and the reason for
 * each it does not. */
export type AttachRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const reasons = (location: string) => Object.entries({ ...ATTACH_PINNED, ...ATTACH_FIXED }).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`).join(' ');
const protectedReason = (...ids: string[]) => ATTACH_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const ATTACH_REGISTRY: readonly AttachRegistryEntry[] = Object.freeze([
  { member: 'panda.menus.attach', source: 'src/main.ts', locations: [ATTACH_MENU_LOCATION, ATTACH_PROTECTED_LOCATION], controls: ATTACH_MENU_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: ATTACH_MENU_LOCATION, selection: 'draft', reason: `${reasons(ATTACH_MENU_LOCATION)} The composer's Attach button and a Files row's Attach button are captured controls; attaching a file from the Files tab needs a fresh host choice. ${protectedReason('draft-attachments')}` },
  { member: 'panda.composer.recipes', source: 'src/recipes.ts', locations: ['panda.composer.recipes.actions', ATTACH_RECIPES_LOCATION, ATTACH_PROTECTED_LOCATION], controls: ATTACH_RECIPES_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.recipes.actions', selection: 'recipe', reason: `${reasons(ATTACH_RECIPES_LOCATION)} Run needs a fresh host choice. ${protectedReason('recipe-delete', 'recipe-edit-commit', 'recipe-steps')}` },
  { member: 'panda.composer.wake', source: 'src/schedules-thread.ts', locations: ['panda.composer.wake.actions', ATTACH_WAKE_LOCATION, ATTACH_PROTECTED_LOCATION], controls: ATTACH_WAKE_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.composer.wake.actions', selection: 'task', reason: `${reasons(ATTACH_WAKE_LOCATION)} Run now and the wake-up switch need a fresh host choice. ${protectedReason('wake-create', 'wake-change')}` },
  { member: 'panda.menus.wake', source: 'src/schedules-thread.ts', locations: [ATTACH_WAKE_MENU_LOCATION, ATTACH_PROTECTED_LOCATION], controls: ATTACH_WAKE_MENU_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: ATTACH_WAKE_MENU_LOCATION, selection: 'schedule', reason: `${reasons(ATTACH_WAKE_MENU_LOCATION)} Snooze, pause and resume run only from the user's own choice in the menu. ${protectedReason('wake-remove', 'wake-change')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotAttach(props: AttachPresentation): AttachPresentation {
  if (!validateContract('composerAttachPresentation', props).ok) throw Error('Invalid composer attach presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate composer attach handle');
  return freeze(structuredClone(props));
}
export function createAttachControls(props: AttachPresentation, owner: string, current: () => AttachPresentation, authority: () => AttachAuthority, dispatch: (action: AttachAction) => void, applied = new Set<string>()) {
  const captured = snapshotAttach(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): AttachAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((ATTACH_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract('composerAttachAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as AttachAction, live = current();
    // Switching task, an edited draft, a changed recipe or wake-up, or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open picker, menu, foreign dialog or pending host choice keeps its input: nothing acts until it ends.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (ATTACH_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
