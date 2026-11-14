/** JSON-only captured moodboard admission; the asset store, file selection, confirmations and attach policy stay in the host. */
import { validateContract } from './contracts.ts';
export type MoodboardControl = 'board-new' | 'board-select' | 'board-rename' | 'board-delete' | 'delete-cancel' | 'image-add' | 'image-preview' | 'image-caption' | 'image-remove' | 'preview-close' | 'attach';
export type MoodboardPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; board: string; image: string; destination: string; revision: number; visible: boolean; loading: boolean; busy: boolean; error: boolean; draft: boolean; create: boolean; confirm: boolean; preview: boolean; attach: boolean; boardName: string; boardCount: number; imageCount: number; truncated: boolean; controls: readonly Readonly<{ id: string; controlId: MoodboardControl; resource: string; enabled: boolean }>[] }>;
export type MoodboardAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; board: string; image: string; destination: string; revision: number; control: string; resource: string; controlId: MoodboardControl; requestId: string }>;
export type MoodboardAuthority = { owner: string; active: boolean; granted: boolean; moodboardControl: boolean; userChoice: boolean };
export type MoodboardAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Removing an image and attaching to a draft need separate host-user consent. */
export const MOODBOARD_CONSENT_CONTROLS: readonly MoodboardControl[] = ['image-remove', 'attach'];
/** The file chooser, removal and attach also run only after a fresh host user choice. */
export const MOODBOARD_ENTRY_CONTROLS: readonly MoodboardControl[] = ['image-add', 'image-remove', 'attach'];
/** Controls that keep an unsaved create name, board name or caption on screen; the rest wait for it to be saved. */
export const MOODBOARD_DRAFT_SAFE_CONTROLS: readonly MoodboardControl[] = ['board-new', 'board-rename', 'image-caption', 'image-preview', 'preview-close', 'delete-cancel'];
const CAPTURED = ['window', 'context', 'project', 'board', 'image', 'destination', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotMoodboard(props: MoodboardPresentation): MoodboardPresentation {
  if (!validateContract('moodboardPresentation', props).ok) throw Error('Invalid moodboard presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate moodboard control');
  return freeze(structuredClone(props));
}
export function createMoodboardPresentation(props: MoodboardPresentation, owner: string, current: () => MoodboardPresentation, authority: () => MoodboardAuthority, dispatch: (action: MoodboardAction) => void, applied = new Set<string>()) {
  const captured = snapshotMoodboard(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): MoodboardAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('moodboardAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as MoodboardAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // A load or an add/remove/create/delete in flight keeps its target; only closing the preview may act meanwhile.
    if ((live.loading || live.busy) && action.controlId !== 'preview-close') return { ok: false, reason: 'Busy' };
    if (live.draft && !MOODBOARD_DRAFT_SAFE_CONTROLS.includes(action.controlId)) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    if (!control || !now || [control, now].some(control => control.resource !== action.resource || control.controlId !== action.controlId)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled) return { ok: false, reason: 'UnsupportedCapability' };
    if (MOODBOARD_CONSENT_CONTROLS.includes(action.controlId) && !auth.moodboardControl || MOODBOARD_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
