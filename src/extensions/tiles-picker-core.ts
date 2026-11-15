/** JSON-only captured admission for thread tiles and the draft project picker. Tile layout, mirrors' rows, drafts and
 * moving a draft to another project stay in the host. */
import { validateContract } from './contracts.ts';
import { TILES_CONTROLS, PICKER_ENTRIES, TILES_PICKER_PINNED, TILES_PICKER_FIXED, TILES_PICKER_PROTECTED, TILES_LOCATION, PICKER_LOCATION, TILES_PICKER_PROTECTED_LOCATION } from './surfaces.ts';
/** Captured tile control ids (`tilesControlId`). */
export const TILES_CONTROL_IDS = ['tile-focus', 'tile-close', 'tile-composer'] as const;
/** Captured project picker control ids (`projectPickerControlId`). */
export const PICKER_CONTROL_IDS = ['picker-toggle', 'picker-select', 'picker-open'] as const;
export type TilesControl = typeof TILES_CONTROL_IDS[number];
export type PickerControl = typeof PICKER_CONTROL_IDS[number];
type Control<T> = Readonly<{ id: string; controlId: T; resource: string; enabled: boolean; hidden: boolean }>;
type Common = { contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; visible: boolean; busy: boolean; safeMode: boolean; truncated: boolean };
/** `task` is the focused thread; `tiles` the opaque handles of the tiled threads in their order (never titles or rows). */
export type TilesPresentation = Readonly<Common & { tiles: readonly string[]; controls: readonly Control<TilesControl>[] }>;
/** `task` is the draft; `draft` whether it has text (never the text); `entries` how many projects the open picker lists. */
export type PickerPresentation = Readonly<Common & { open: boolean; draft: boolean; entries: number; controls: readonly Control<PickerControl>[] }>;
type Action<T> = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: T; resource: string; requestId: string }>;
export type TilesAction = Action<TilesControl>;
export type PickerAction = Action<PickerControl>;
export type TilesPickerAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type TilesPickerAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Closing a view changes the user's tiles and choosing a project moves the draft: each runs its original handler only
 * after a fresh host user choice. Focusing a tile is an ordinary thread switch; the toggle and Open project… open the
 * host's own picker or folder dialog, where the user chooses. */
export const TILES_PICKER_CHOICE_CONTROLS: readonly string[] = ['tile-close', 'picker-select'];
/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check of the
 * request's shape. A mirror is read-only: nothing sends input to a tile. */
export const TILES_PROTECTED_CONTROLS = ['tile-send-input', 'tile-read-rows', 'tile-open', 'tile-move', 'tile-resize'] as const;
export const PICKER_PROTECTED_CONTROLS = ['picker-move', 'picker-read-draft', 'picker-set-search', 'picker-create-project', 'picker-clear-attachments'] as const;

/** One explicit entry per ledger member this adapter owns (`panda.workspace.views.tiles`, `.project-picker`), with its
 * public locations, the operations it supports and the reason for each it does not. */
export type TilesPickerRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; context: string; selection: string; reason: string }>;
const reasons = (location: string) => [...new Set(Object.entries({ ...TILES_PICKER_PINNED, ...TILES_PICKER_FIXED }).filter(([id]) => id.startsWith(`${location}/`)).map(([id, why]) => `${id.slice(location.length + 1)}: ${why}`))].join(' ');
const protectedReason = (...ids: string[]) => TILES_PICKER_PROTECTED.filter(([id]) => ids.includes(id)).map(([, , why]) => why).join(' ');
export const TILES_PICKER_REGISTRY: readonly TilesPickerRegistryEntry[] = Object.freeze([
  { member: 'panda.workspace.views.tiles', source: 'src/thread-tiles.ts', locations: ['panda.workspace.tiles.actions', TILES_LOCATION, TILES_PICKER_PROTECTED_LOCATION], controls: TILES_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.workspace.tiles.actions', selection: 'tile', reason: `${reasons(TILES_LOCATION)} A tile's actions capture that tile's own thread, never the focused one; closing a view needs a fresh host choice. ${protectedReason('mirror-input', 'tile-layout')}` },
  { member: 'panda.workspace.views.project-picker', source: 'src/main.ts', locations: ['panda.workspace.project-picker.actions', PICKER_LOCATION, TILES_PICKER_PROTECTED_LOCATION], controls: PICKER_ENTRIES.map(([id]) => id), order: true, hide: true, actions: true, context: 'panda.workspace.project-picker.actions', selection: 'draft-project', reason: `${reasons(PICKER_LOCATION)} Choosing a project for a package needs a fresh host choice. ${protectedReason('draft', 'project-move')}` },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
type Shape = 'tiles' | 'projectPicker';
function snapshot<T extends Common & { controls: readonly Control<string>[] }>(shape: Shape, props: T): T {
  if (!validateContract(`${shape}Presentation`, props).ok) throw Error(`Invalid ${shape} presentation`);
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error(`Duplicate ${shape} handle`);
  return freeze(structuredClone(props));
}
export const snapshotTiles = (props: TilesPresentation): TilesPresentation => snapshot('tiles', props);
export const snapshotPicker = (props: PickerPresentation): PickerPresentation => snapshot('projectPicker', props);
function controls<T extends Common & { controls: readonly Control<string>[] }, A extends Action<string>>(shape: Shape, protectedIds: readonly string[], props: T, owner: string, current: () => T, authority: () => TilesPickerAuthority, dispatch: (action: A) => void, applied: Set<string>) {
  const captured = snapshot(shape, props); let disposed = false;
  return { props: captured, dispatch(input: unknown): TilesPickerAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((protectedIds as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateContract(`${shape}Action`, input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as A, live = current();
    // Another focused tile, another draft text, another project or a redraw is another target.
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, menu, drag, pending project change or host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (TILES_PICKER_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
export const createTilesControls = (props: TilesPresentation, owner: string, current: () => TilesPresentation, authority: () => TilesPickerAuthority, dispatch: (action: TilesAction) => void, applied = new Set<string>()) =>
  controls<TilesPresentation, TilesAction>('tiles', TILES_PROTECTED_CONTROLS, props, owner, current, authority, dispatch, applied);
export const createPickerControls = (props: PickerPresentation, owner: string, current: () => PickerPresentation, authority: () => TilesPickerAuthority, dispatch: (action: PickerAction) => void, applied = new Set<string>()) =>
  controls<PickerPresentation, PickerAction>('projectPicker', PICKER_PROTECTED_CONTROLS, props, owner, current, authority, dispatch, applied);
