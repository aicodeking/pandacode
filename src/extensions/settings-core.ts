/** JSON-only captured core Settings admission; preferences, secrets, grants and recovery stay in the host. */
import { validateContract } from './contracts.ts';
import { SECTIONS } from '../settings-sections.ts';
import { SETTINGS_CORE_CONTROLS, SETTINGS_FIELD_PAGES, SETTINGS_PINNED_SECTIONS, SETTINGS_PROTECTED_CONTROLS } from './surfaces.ts';
export type SettingsControl = typeof SETTINGS_CORE_CONTROLS[number][0];
export type SettingsCorePage = 'recommended' | 'general' | 'appearance' | 'voice' | 'agents' | 'providers' | 'teams' | 'routing' | 'schedules' | 'tools' | 'skills' | 'rules' | 'extensions' | 'cloud' | 'remote' | 'github' | 'about';
export type SettingsPresentation = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; page: SettingsCorePage | 'extension'; section: string; revision: number; visible: boolean; focused: boolean; busy: boolean; offline: boolean; safeMode: boolean; sections: readonly Readonly<{ id: string; pinned: boolean; hidden: boolean }>[]; controls: readonly Readonly<{ id: string; controlId: SettingsControl; page: SettingsCorePage; enabled: boolean; hidden: boolean }>[]; truncated: boolean }>;
export type SettingsAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; page: SettingsCorePage | 'extension'; revision: number; control: string; controlId: SettingsControl; requestId: string }>;
export type SettingsAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type SettingsAdmission = { ok: true } | { ok: false; reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Preference changes and the external support link run only after a fresh host user choice. */
export const SETTINGS_ENTRY_CONTROLS: readonly SettingsControl[] = ['compact-mode', 'expand-tool-activity', 'toggle-theme', 'daily-wallpapers', 'support'];
/** Only the support link reaches the network. */
export const SETTINGS_NETWORK_CONTROLS: readonly SettingsControl[] = ['support'];
/** One explicit entry per existing core page: section-level visibility, order, actions, context, eligible
 * controls, protected controls and shared-field placement, each exception with its reason. */
export type SettingsRegistryEntry = Readonly<{ page: SettingsCorePage; section: string; order: true; actions: true; context: true; hide: boolean; hideReason?: string; controls: readonly SettingsControl[]; protected: readonly string[]; fields: boolean; fieldsReason?: string }>;
const FIELD_REASONS: Partial<Record<SettingsCorePage, string>> = {
  recommended: 'A live local checklist computed by the host; it has no stable rows to extend.',
  voice: 'Hosts speech provider key entry.', agents: 'Hosts harness setup and the project-checks consent.',
  providers: 'Hosts credential entry.', routing: 'Hosts the router download opt-in.',
  extensions: 'Hosts package trust and safe-mode recovery.', cloud: 'Hosts cloud credentials.',
  remote: 'Hosts pairing consent and revocation.', github: 'Hosts GitHub sign-in.', about: 'Hosts updates and recovery.',
};
export const SETTINGS_REGISTRY: readonly SettingsRegistryEntry[] = Object.freeze(SECTIONS.flatMap(section => section.pages.map(({ id }) => {
  const page = id as SettingsCorePage, pinned = SETTINGS_PINNED_SECTIONS[section.id];
  const fields = (SETTINGS_FIELD_PAGES as readonly string[]).includes(page);
  return Object.freeze({
    page, section: section.id, order: true as const, actions: true as const, context: true as const,
    hide: !pinned, ...(pinned ? { hideReason: pinned } : {}),
    controls: SETTINGS_CORE_CONTROLS.filter(control => control[2] === page).map(control => control[0]),
    protected: SETTINGS_PROTECTED_CONTROLS.filter(control => control[2] === page).map(control => control[0]),
    fields, ...(fields ? {} : { fieldsReason: FIELD_REASONS[page] ?? 'Not an eligible field page.' }),
  });
})));
const CAPTURED = ['window', 'context', 'project', 'page', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function snapshotSettings(props: SettingsPresentation): SettingsPresentation {
  if (!validateContract('settingsPresentation', props).ok) throw Error('Invalid Settings presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate Settings control');
  return freeze(structuredClone(props));
}
export function createSettingsPresentation(props: SettingsPresentation, owner: string, current: () => SettingsPresentation, authority: () => SettingsAuthority, dispatch: (action: SettingsAction) => void, applied = new Set<string>()) {
  const captured = snapshotSettings(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): SettingsAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'contractVersion')?.value !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if (!validateContract('settingsAction', input).ok) return { ok: false, reason: 'InvalidArguments' };
    const action = input as SettingsAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    if (SETTINGS_NETWORK_CONTROLS.includes(action.controlId) && live.offline) return { ok: false, reason: 'Offline' };
    // An open host dialog or pending host choice keeps its inputs: nothing acts until it closes.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(control => control.id === action.control), now = live.controls.find(control => control.id === action.control);
    // A control acts only on the page it is shown on; another page's control is a different target.
    if (!control || !now || [control, now].some(control => control.controlId !== action.controlId || control.page !== action.page)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (SETTINGS_ENTRY_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= 4096) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}
