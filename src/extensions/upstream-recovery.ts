/* Crash restart and quit, as an extension adapter (S0608, upstream sync P6). It adds to PandaCode's own recovery
 * notice and Settings group and takes nothing from them: with no package contributing, in safe mode, disabled or
 * uninstalled, every function here returns nothing and the notice, the Settings group and the quit question are
 * exactly upstream's (0.3.128, whose crash-guard and quit sources this branch does not change).
 *
 * Built only from public primitives, no new contract:
 * - a package's settings page `<owner>/crash-recovery` placed in General (`contributes.settings`, `section:
 *   "general"`) with a switch `show` and a text `note`: the note is shown in the crash notice, labelled with the
 *   package's name; the values are the package's own namespace (`extensions_settings_get`);
 * - the package's declared command `<owner>/checklist` (`contributes.commands`), offered as a quiet button in the
 *   crash notice and run through `invokeExtensionCommand`, which rechecks the owner at invocation;
 * - quit: the package's service status (`lifetime.setStatus({ text, working })`, permission `runtime.service`) is the
 *   one input of the native quit account (`quit_guard.rs`, fed by `runtime_service_status::quit_packages`). This
 *   module only reads the same `quit` list back (`quitLine`) for Settings; it keeps no counter or dialog of its own.
 * Recovery dialogs, the restart switch, drafts and reports stay built in; a package cannot change, answer or hide them. */
import { call } from '../bridge';
import { extensionGeneration, extensionIdentity, extensionsManagementSnapshot, onExtensionsChanged } from './manager';
import { invokeExtensionCommand } from './commands';
import { SETTINGS_SAVED_EVENT } from './settings-pages';
import { settingsDefaults, validSettingsValues, type SettingsPageDefinition } from './settings-state';
import { quitMessage, type QuitPackage } from './runtime-service-status';
import { extrasLine, EXTRAS_LIMIT, NOTE_LIMIT, type RecoveryNote } from '../crash-recovery-model';
import type { DialogValues } from './dialog-state';

export type RecoveryDisposition = 'adapter' | 'protected';
export type RecoveryMember = Readonly<{ member: string; upstream: string; disposition: RecoveryDisposition; by: string; reason?: string; handoff?: string }>;
/** One entry per upstream crash/quit member. `protected` keeps only fault isolation, predictability, stability or
 * irreversibility (ADR-0005); a capability that needs a new runtime ability names its handoff, never a permanent refusal.
 * Handoff rows go to S07C and are consumed by R1212. */
const MEMBERS: RecoveryMember[] = [
  { member: 'crash-notice-text', upstream: 'crashNotice: what happened, when, the cause, the kept-closed thread, paused restarts', disposition: 'adapter', by: 'settings page <owner>/crash-recovery (section general): a labelled note after the notice text', },
  { member: 'crash-notice-actions', upstream: 'Open thread, Show crash report, Crash settings', disposition: 'adapter', by: 'command <owner>/checklist as one quiet button; captured generation and identity refuse a stale one', },
  { member: 'crash-notice-arrangement', upstream: 'the notice as one toast slot', disposition: 'adapter', by: 'Settings → General → Crash recovery: Hide, Show again, Move up, Move down, Restore all notes (a local preference)', },
  { member: 'quit-confirmation', upstream: 'ExitRequested asks while agents run (quit_guard.rs)', disposition: 'adapter', by: 'runtime.service status {text, working}: the one native QuitAccount names the package; Settings shows the same sentence' },
  { member: 'crash-restart-decision', upstream: 'crash_restart_enabled and the guard relaunch policy', disposition: 'protected', by: 'host switch', reason: 'Whether PandaCode relaunches itself is decided before any package runs and by the user alone; a package that is the cause of a crash must not decide it (stability).', handoff: 'R0106: supervised service restart policy (the package service, not the app, is what a package may restart)' },
  { member: 'crash-report', upstream: 'crash_report_reveal and the report file', disposition: 'protected', by: 'host button', reason: 'A report can hold file paths, work text and credentials; it is revealed in the file manager, never read by a package (ADR-0006).' },
  { member: 'unsent-drafts', upstream: 'Keep unsent drafts, Clear saved drafts (launch-restore.ts)', disposition: 'protected', by: 'host switch and button', reason: 'Draft text is the user\'s prompt content and Clear is irreversible; the switch stays the user\'s.', handoff: 'R0403: edit drafts and attachments without sending (the task-contract draft owner)' },
  { member: 'window-reload-notice', upstream: 'launch-restore.ts window died / reloaded wording', disposition: 'protected', by: 'host toast', reason: 'It runs before extensions load, so no package could contribute to it (predictability).' },
  { member: 'safe-mode', upstream: 'Settings → Extensions safe mode and tray recovery', disposition: 'protected', by: 'host recovery dialogs', reason: 'Recovery dialogs stay built in; safe mode removes every note and checklist button, restoring upstream exactly.' },
];
export const RECOVERY_REGISTRY: readonly RecoveryMember[] = Object.freeze(MEMBERS.map(entry => Object.freeze(entry)));

/** The page and command ids the adapter looks for, relative to the package id. */
export const RECOVERY_PAGE = 'crash-recovery';
export const RECOVERY_COMMAND = 'checklist';
/** Local UI preference: which extension notes the user hid and in which order the rest go. Never a package value. */
export const ARRANGEMENT_KEY = 'pandacode.crashRecovery.extras.v1';

export type RecoveryExtra = RecoveryNote & { owner: string; name: string; command?: string };
export type Arrangement = { hidden: string[]; order: string[] };
export type Rejection = 'Revoked' | 'WrongOwner' | 'StaleContext' | 'AlreadyApplied' | 'Hidden';
export type Admission = { ok: true } | { ok: false; reason: Rejection };

/** The package's display name: the part of its id after the publisher, never author-controlled markup. */
export function extraName(owner: string): string {
  const name = owner.includes('.') ? owner.slice(owner.indexOf('.') + 1) : owner;
  return name.replace(/[-_]+/g, ' ').trim() || owner;
}

function contributions(): { owner: string; page: SettingsPageDefinition; command?: string }[] {
  const snapshot = extensionsManagementSnapshot();
  if (snapshot.safeMode) return [];
  return snapshot.packages.filter(item => item.enabled && item.manifest.permissions?.includes('ui.contribute')).flatMap(item => {
    const owner = item.manifest.id;
    const page = (item.manifest.contributes.settings ?? []).find(entry => entry.id === `${owner}/${RECOVERY_PAGE}` && entry.section === 'general');
    if (!page || !page.fields.some(field => field.id === 'show' && field.kind === 'switch') || !page.fields.some(field => field.id === 'note' && field.kind === 'text')) return [];
    const command = (item.manifest.contributes.commands ?? []).find(entry => entry.id === `${owner}/${RECOVERY_COMMAND}`)?.id;
    return [{ owner, page: page as SettingsPageDefinition, command }];
  });
}

/** Stored arrangement; anything unreadable is the default (nothing hidden, discovery order). */
export function readArrangement(raw: string | null = safeGet(ARRANGEMENT_KEY)): Arrangement {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<Arrangement> | null;
    const list = (input: unknown) => Array.isArray(input) ? input.filter((id): id is string => typeof id === 'string').slice(0, 64) : [];
    return { hidden: list(value?.hidden), order: list(value?.order) };
  } catch { return { hidden: [], order: [] }; }
}
function safeGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writeArrangement(value: Arrangement): void { try { localStorage.setItem(ARRANGEMENT_KEY, JSON.stringify(value)); } catch { /* A private window keeps the choice for this page only. */ } }

/** Applies the user's order to the discovered notes (unlisted ones follow, in discovery order). */
export function arranged<T extends { owner: string }>(items: readonly T[], arrangement: Arrangement): T[] {
  const rank = (owner: string) => { const at = arrangement.order.indexOf(owner); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.owner) - rank(b.item.owner) || a.index - b.index).map(entry => entry.item);
}

/** Every enabled package's note, shown or hidden, in the user's order. A failing read drops that package only. */
export async function loadRecoveryExtras(read: (owner: string, page: string) => Promise<unknown> = (owner, page) => call('extensions_settings_get', { id: owner, page })): Promise<{ all: RecoveryExtra[]; arrangement: Arrangement }> {
  const found = contributions(), arrangement = readArrangement();
  const all: RecoveryExtra[] = [];
  for (const { owner, page, command } of found) {
    let values: DialogValues;
    try { const stored = await read(owner, page.id); values = stored && validSettingsValues(page, stored) ? stored : settingsDefaults(page); }
    catch { continue; }
    if (values.show !== true) continue;
    const text = typeof values.note === 'string' ? values.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_LIMIT) : '';
    if (text) all.push({ owner, name: extraName(owner), text, command });
  }
  return { all: arranged(all, arrangement), arrangement };
}

/** What the notice shows: not hidden, at most EXTRAS_LIMIT. */
export function visibleExtras(all: readonly RecoveryExtra[], arrangement: Arrangement): RecoveryExtra[] {
  return all.filter(extra => !arrangement.hidden.includes(extra.owner)).slice(0, EXTRAS_LIMIT);
}

export function hideExtra(owner: string): Arrangement { const current = readArrangement(); const next = { ...current, hidden: [...new Set([...current.hidden, owner])] }; writeArrangement(next); return next; }
export function restoreExtra(owner: string): Arrangement { const current = readArrangement(); const next = { ...current, hidden: current.hidden.filter(id => id !== owner) }; writeArrangement(next); return next; }
export function restoreAllExtras(): Arrangement { const next = { hidden: [], order: [] }; writeArrangement(next); return next; }
/** Moves `owner` one place among `owners` (the current visible order); the other owners keep their places. */
export function moveExtra(owners: readonly string[], owner: string, by: -1 | 1): Arrangement {
  const at = owners.indexOf(owner), to = at + by;
  const current = readArrangement();
  if (at < 0 || to < 0 || to >= owners.length) return current;
  const order = [...owners]; [order[at], order[to]] = [order[to], order[at]];
  const next = { ...current, order }; writeArrangement(next); return next;
}

/** The notice text the adapter adds: one labelled sentence per visible note, after upstream's own text. */
export function extrasText(extras: readonly RecoveryExtra[]): string { return extras.map(extra => extrasLine(extra.name, extra.text)).join(' '); }

/** Captured when the notice shows its extras: the crash, the lifecycle generation (the revision), the package's identity
 * and the user's arrangement. An action built from it is refused once the package, its enablement or permissions, safe
 * mode, the extras shown or their arrangement changed, once the notice dropped it, and a second time for the same request. */
export function captureExtras(extras: readonly RecoveryExtra[], crashedAt: number | undefined, notify: (message: string) => void = () => {}) {
  const captured = new Map(extras.filter(extra => extra.command).map(extra => [extra.owner, { command: extra.command!, identity: extensionIdentity(extra.owner) }]));
  const generation = extensionGeneration(), arrangement = JSON.stringify(readArrangement());
  const applied = new Set<string>();
  let closed = false;
  return {
    crashedAt,
    /** The notice replaced these extras or ended: an older request no longer targets what is on screen. */
    close(): void { closed = true; },
    run(owner: string, requestId: string): Admission {
      const entry = captured.get(owner);
      if (closed) return { ok: false, reason: 'Revoked' };
      if (!entry) return { ok: false, reason: 'WrongOwner' };
      if (applied.has(requestId)) return { ok: false, reason: 'AlreadyApplied' };
      if (generation !== extensionGeneration() || entry.identity !== extensionIdentity(owner)) return { ok: false, reason: 'StaleContext' };
      if (arrangement !== JSON.stringify(readArrangement())) return { ok: false, reason: 'StaleContext' };
      if (readArrangement().hidden.includes(owner)) return { ok: false, reason: 'Hidden' };
      applied.add(requestId);
      return invokeExtensionCommand(entry.command, { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.crash.notice' }, notify) ? { ok: true } : { ok: false, reason: 'Revoked' };
    },
  };
}

/** Subscribes to lifecycle changes of any package (install, enable, disable, grant change, uninstall, safe mode) and to saved notes. */
export function onRecoveryExtrasChanged(listener: () => void): () => void {
  const stop = onExtensionsChanged(listener);
  // A package saved its note: the same event the settings page fires, no polling.
  addEventListener(SETTINGS_SAVED_EVENT, listener);
  return () => { stop(); removeEventListener(SETTINGS_SAVED_EVENT, listener); };
}

/** The quit sentence for Settings, from the same `quit` list the native account uses. Empty when nothing is working. */
export function quitLine(packages: readonly QuitPackage[]): string {
  return packages.length ? `Quitting now asks first. ${quitMessage(0, [...packages])}` : '';
}
