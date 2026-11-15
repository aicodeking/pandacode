/** Internal host adapter. This bridge is never exposed to packages. */
import { call, preview } from '../bridge';
import { validateContract, type Json } from './contracts';
import type { LayoutProposal } from './ordering';
import type { DialogDefinition } from './dialog-state';
import type { SettingsPageDefinition, Keybinding } from './settings-state';
import type { ViewDefinition } from './views-state';
import { applyExtensionAppearance, type ExtensionTheme } from './appearance';
import type { ComponentProvider } from './component-slot';
import type { ConnectionDescriptor } from './sdk';
import { packageHarnesses } from './harnesses';
import { setPackageProviders } from './provider-state';

export type ExtensionMenuItem = { id: string; kind: 'command' | 'submenu' | 'separator' | 'checkbox' | 'radio'; title?: string; command?: string; icon?: string; checked?: boolean; group?: string; visible?: Json; enabled?: Json; items?: ExtensionMenuItem[] };
export type ExtensionAction = { kind: 'showMessage'; message: string } | { kind: 'showDialog'; dialog: DialogDefinition } | { kind: 'openView'; view: string } | { kind: 'showProjectContext' } | { kind: 'runCommand' };
export type ExtensionTool = { id: string; command: string; executable: 'node'; arguments: { maxItems: number; maxLength: number }; cwd: 'project'; timeoutMs: number };
export type UpdateStatus = { version?: string | null; digest?: string | null; addedPermissions: string[]; executable: boolean; draining: boolean; pinned: number; rollback: boolean; reason: string };
export type ExtensionPackage = { update?: UpdateStatus; storageGranted?: boolean; executable?: { digest: string; trusted: boolean } | null; manifest: { id: string; version: string; extensionKind?: 'ui' | 'workspace' | 'split'; dependencies?: Record<string, string>; permissions?: string[]; runtime?: { kind: 'node'; entrypoint: 'main.cjs'; activationEvents: string[] }; contributes: { services?: import('./sdk').ServiceDescriptor[]; connections?: ConnectionDescriptor[]; tools?: ExtensionTool[]; components?: ComponentProvider[]; themes?: ExtensionTheme[]; views?: ViewDefinition[]; settings?: SettingsPageDefinition[]; keybindings?: Keybinding[]; slashCommands?: import('./commands-core').SlashDeclaration[]; dialogExtras?:{ id: string; dialog: import('./surfaces').MainDialogId; text: string }[]; layouts?: LayoutProposal[]; icons?: { id: string; asset: string; host?: string }[]; commands?: { id: string; title: string; action: ExtensionAction; enabled?: Json }[]; menus?: { id: string; location: string; command: string; icon?: string; visible?: Json; enabled?: Json; items?: ExtensionMenuItem[]; presentation?: 'icon' | 'button' | 'status' | 'badge'; text?: string; badge?: string }[] } }; icons: Record<string, string>; enabled: boolean; reason?: string | null; /** Selected projects; absent = all projects (every pre-scope record). */ projects?: string[]; /** Set only on the effective snapshot: enabled, but the active project is outside its scope. */ scopeWithheld?: boolean };
export type ExtensionSnapshot = { safeMode: boolean; packages: ExtensionPackage[]; diagnostics: string[]; development?: { id: string; revision: number; logs: string[] }[] };
/** The shared `projectScope` contract (schema-v1.json), sent to the native broker. */
export type ProjectScope = { schemaVersion: 1; mode: 'all' } | { schemaVersion: 1; mode: 'selected'; projects: string[] };
// `managed` is the native snapshot. `snapshot` is what contributes now: a package whose project scope
// excludes the active project (or any project-less window) is presented as not enabled. The package's
// own management surfaces (Settings → Extensions and its settings pages) read `managed`.
let managed: ExtensionSnapshot = { safeMode: false, packages: [], diagnostics: [] };
let snapshot: ExtensionSnapshot = managed;
let activeProject: string | undefined;
const listeners = new Set<() => void>();
let generation = 0;
export function packageInScope(item: Pick<ExtensionPackage, 'projects'>, project: string | undefined): boolean { return !item.projects || Boolean(project) && item.projects.includes(project!); }
function effective(value: ExtensionSnapshot): ExtensionSnapshot {
  if (!value.packages.some(item => item.projects && item.enabled && !packageInScope(item, activeProject))) return value;
  return { ...value, packages: value.packages.map(item => item.projects && item.enabled && !packageInScope(item, activeProject) ? { ...item, enabled: false, scopeWithheld: true } : item) };
}
export function extensionsSnapshot(): ExtensionSnapshot { return structuredClone(snapshot); }
/** Management view (Settings → Extensions, a package's own settings pages): ignores the active project's scope. */
export function extensionsManagementSnapshot(): ExtensionSnapshot { return structuredClone(managed); }
/** Hot paths (control order/visibility on every render) need only this flag, not a deep copy of every package. */
export function extensionsSafeMode(): boolean { return snapshot.safeMode; }
export function onExtensionsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Scope withdrawal is not revocation: work captured in project A keeps running (and targeting A) after B becomes active. */
export function extensionIdentity(owner: string): string {
  const { projects: _projects, ...item } = managed.packages.find(item => item.manifest.id === owner) ?? { projects: undefined };
  return JSON.stringify({ safe: managed.safeMode, package: managed.packages.some(item => item.manifest.id === owner) ? item : undefined, reload: managed.development?.find(item => item.id === owner)?.revision });
}
let projectDirectory: () => { id: string; name: string }[] = () => [];
/** The main window supplies its project list for the scope control; auxiliary windows have none. */
export function registerExtensionProjects(directory: () => { id: string; name: string }[]): void { projectDirectory = directory; }
export function extensionProjects(): { id: string; name: string }[] { return projectDirectory(); }
export function extensionsActiveProject(): string | undefined { return activeProject; }
/** Called whenever the main window's active project may have changed; a no-op unless a scoped package's presence changes. */
export function setExtensionsProject(project: string | undefined): void {
  const next = project || undefined;
  if (next === activeProject) return;
  activeProject = next;
  const previous = snapshot, value = effective(managed);
  snapshot = value;
  if (JSON.stringify(previous.packages) === JSON.stringify(value.packages)) return;
  // Called from the host's header render: re-render contributions after it, not re-entrantly inside it.
  queueMicrotask(publish);
}
function publish(): void {
  applyExtensionAppearance(snapshot);
  setPackageProviders(packageHarnesses(snapshot));
  listeners.forEach(listener => listener());
}
/** Unrelated package reload/log events must not cancel another owner's in-flight UI. */
export function onExtensionChanged(owner: string, listener: () => void): () => void {
  const fingerprint = () => extensionIdentity(owner);
  let previous = fingerprint();
  return onExtensionsChanged(() => { const next = fingerprint(); if (next !== previous) { previous = next; listener(); } });
}
function accept(value: ExtensionSnapshot): void {
  // A stale activation reply cannot revive contributions after protected recovery.
  if (managed.safeMode && !value.safeMode) return;
  const previous = JSON.stringify(managed);
  // A scope-only change is a preference, not a new package lifecycle generation.
  const lifecycle = (state: ExtensionSnapshot) => JSON.stringify([state.safeMode, state.packages.map(({ projects: _projects, ...item }) => item), state.development?.map(dev => [dev.id, dev.revision])]);
  const previousLifecycle = lifecycle(managed);
  const active = value.packages.filter(item => item.enabled);
  const checked = validateContract('packages', active.map(item => item.manifest));
  const next = structuredClone(value);
  if (!checked.ok) {
    next.packages.forEach(item => { if (item.enabled) { item.enabled = false; item.reason = `Activation rejected: ${checked.error.code}`; } });
    next.diagnostics.push(`Activation rejected: ${checked.error.code}`);
  } else {
    for (const item of next.packages.filter(item => item.enabled)) {
      const visit = (entries: { id: string; icon?: string; items?: ExtensionMenuItem[] }[]) => {
        for (const entry of entries) {
          if (entry.icon && !item.icons[entry.icon]) next.diagnostics.push(`${entry.id}: missing icon asset; using a safe fallback host icon.`);
          if (entry.items) visit(entry.items);
        }
      };
      visit(item.manifest.contributes.menus ?? []);
    }
  }
  if (next.safeMode) next.packages = [];
  // A lifecycle notification can race its command response. Identical state must not remount UI,
  // discard focus/fields or cancel a newly opened transient a second time.
  if (JSON.stringify(next) === previous) return;
  managed = next;
  snapshot = effective(managed);
  if (previousLifecycle !== lifecycle(managed)) generation++;
  publish();
}
export async function loadExtensions(): Promise<void> {
  try { accept(await call<ExtensionSnapshot>('extensions_snapshot')); }
  catch { accept({ safeMode: false, packages: [], diagnostics: ['Extensions unavailable; built-in controls remain available.'] }); }
}
/** Host-only auxiliary bootstrap; the native reply supplies the actual invoking label. */
export async function loadWindowExtensions(): Promise<string> {
  type WindowSnapshot = { windowId: string; snapshot: ExtensionSnapshot };
  // The launcher has its own bounded preview transport and must not load the full workspace mock.
  const value = preview ? (await import('./preview')).previewExtensions('extensions_window_snapshot', {}) as WindowSnapshot : await call<WindowSnapshot>('extensions_window_snapshot');
  accept(value.snapshot); return value.windowId;
}
export async function installExtension(): Promise<void> {
  const path = preview ? 'sample.project-helper.zip' : await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Install a local extension (execution requires separate trust)', filters: [{ name: 'PandaCode extension', extensions: ['zip'] }] });
  if (typeof path !== 'string') return;
  accept(await call<ExtensionSnapshot>('extensions_install', { path }));
}
export async function enableExtension(id: string, enabled: boolean): Promise<void> { accept(await call<ExtensionSnapshot>('extensions_enable', { id, enabled })); }
export async function selectDevelopmentExtension(): Promise<void> {
  const path = preview ? 'preview-selected-folder' : await (await import('@tauri-apps/plugin-dialog')).open({ directory: true, multiple: false, title: 'Select an extension development package folder (separate executable trust required)' });
  if (typeof path !== 'string') return;
  const reply = await call<{ ok: true; value: ExtensionSnapshot } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'developmentSelect', path } });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value);
}
export async function reloadDevelopmentExtension(id: string): Promise<void> {
  const reply = await call<{ ok: true; value: { snapshot: ExtensionSnapshot; validated: boolean } } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'developmentReload', id } });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value.snapshot);
  if (!reply.value.validated) throw new Error('Development validation failed; selection disabled. Package output redacted.');
}
export async function trustExecutable(id: string, digest: string, allow: boolean): Promise<void> {
  const reply = await call<{ ok: true; value: ExtensionSnapshot } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'trust', id, digest, allow } });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value);
}
/** Persists a package's project scope natively; `null` = all projects. */
export async function setExtensionProjectScope(id: string, projects: string[] | null): Promise<void> {
  const scope: ProjectScope = projects ? { schemaVersion: 1, mode: 'selected', projects } : { schemaVersion: 1, mode: 'all' };
  const checked = validateContract('projectScope', scope);
  if (!checked.ok) throw new Error(checked.error.code);
  const reply = await call<{ ok: true; value: ExtensionSnapshot } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'projectScope', id, scope } });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value);
}
export async function uninstallExtension(id: string): Promise<void> { accept(await call<ExtensionSnapshot>('extensions_uninstall', { id })); }
async function updateRequest(request: Record<string, string>): Promise<void> {
  const reply = await call<{ ok: true; value: ExtensionSnapshot } | { ok: false; error: { code: string } }>('extensions_runtime', { request });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value);
}
export async function stageExtensionUpdate(id: string): Promise<void> {
  const path = preview ? 'preview-update.zip' : await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Stage a local extension update (review required)', filters: [{ name: 'PandaCode extension', extensions: ['zip'] }] });
  if (typeof path === 'string') await updateRequest({ op: 'stageUpdate', id, path });
}
export async function reviewExtensionUpdate(id: string, digest: string): Promise<void> { await updateRequest({ op: 'reviewUpdate', id, digest }); }
export async function rollbackExtensionUpdate(id: string): Promise<void> { await updateRequest({ op: 'rollbackUpdate', id }); }
export async function grantExtensionStorage(id: string, allow: boolean): Promise<void> {
  const reply = await call<{ ok: true; value: ExtensionSnapshot } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'storageGrant', id, allow } });
  if (!reply.ok) throw new Error(reply.error.code);
  accept(reply.value);
}
export async function removeExtensionOwnData(id: string): Promise<void> {
  const reply = await call<{ ok: true } | { ok: false; error: { code: string } }>('extensions_runtime', { request: { op: 'removeOwnData', id, confirmation: id } });
  if (!reply.ok) throw new Error(reply.error.code);
}
export async function enterExtensionsSafeMode(): Promise<void> {
  // Immediate, protected recovery; package data remains untouched.
  accept({ safeMode: true, packages: [], diagnostics: [] });
  accept(await call<ExtensionSnapshot>('extensions_safe_mode'));
}
export function extensionGeneration(): number { return generation; }
/** Lifetime gate: open views/dialogs subscribe per owner and must unsubscribe when they close. */
export function extensionChangeListenerCount(): number { return listeners.size; }
