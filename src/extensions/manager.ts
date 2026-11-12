/** Internal host adapter. This bridge is never exposed to packages. */
import { call, preview } from '../bridge';
import { validateContract, type Json } from './contracts';
import type { LayoutProposal } from './ordering';
import type { DialogDefinition } from './dialog-state';
import type { SettingsPageDefinition, Keybinding } from './settings-state';

export type ExtensionMenuItem = { id: string; kind: 'command' | 'submenu' | 'separator' | 'checkbox' | 'radio'; title?: string; command?: string; icon?: string; checked?: boolean; group?: string; visible?: Json; enabled?: Json; items?: ExtensionMenuItem[] };
export type ExtensionAction = { kind: 'showMessage'; message: string } | { kind: 'showDialog'; dialog: DialogDefinition } | { kind: 'openView'; view: string };
export type ExtensionPackage = { manifest: { id: string; version: string; contributes: { settings?: SettingsPageDefinition[]; keybindings?: Keybinding[]; dialogExtras?: { id: string; dialog: 'colors' | 'wallpapers'; text: string }[]; layouts?: LayoutProposal[]; icons?: { id: string; asset: string }[]; commands?: { id: string; title: string; action: ExtensionAction; enabled?: Json }[]; menus?: { id: string; location: string; command: string; icon?: string; visible?: Json; enabled?: Json; items?: ExtensionMenuItem[]; presentation?: 'icon' | 'button' | 'status' | 'badge'; text?: string; badge?: string }[] } }; icons: Record<string, string>; enabled: boolean; reason?: string | null };
export type ExtensionSnapshot = { safeMode: boolean; packages: ExtensionPackage[]; diagnostics: string[] };
let snapshot: ExtensionSnapshot = { safeMode: false, packages: [], diagnostics: [] };
const listeners = new Set<() => void>();
let generation = 0;
export function extensionsSnapshot(): ExtensionSnapshot { return structuredClone(snapshot); }
export function onExtensionsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function accept(value: ExtensionSnapshot): void {
  // A stale activation reply cannot revive contributions after protected recovery.
  if (snapshot.safeMode && !value.safeMode) return;
  const previous = JSON.stringify(snapshot);
  const active = value.packages.filter(item => item.enabled);
  const checked = validateContract('packages', active.map(item => item.manifest));
  snapshot = structuredClone(value);
  if (!checked.ok) {
    snapshot.packages.forEach(item => { if (item.enabled) { item.enabled = false; item.reason = `Activation rejected: ${checked.error.code}`; } });
    snapshot.diagnostics.push(`Activation rejected: ${checked.error.code}`);
  } else {
    for (const item of snapshot.packages.filter(item => item.enabled)) {
      const visit = (entries: { id: string; icon?: string; items?: ExtensionMenuItem[] }[]) => {
        for (const entry of entries) {
          if (entry.icon && !item.icons[entry.icon]) snapshot.diagnostics.push(`${entry.id}: missing icon asset; using a safe fallback host icon.`);
          if (entry.items) visit(entry.items);
        }
      };
      visit(item.manifest.contributes.menus ?? []);
    }
  }
  if (snapshot.safeMode) snapshot.packages = [];
  // A lifecycle notification can race its command response. Identical state must not remount UI,
  // discard focus/fields or cancel a newly opened transient a second time.
  if (JSON.stringify(snapshot) === previous) return;
  generation++;
  listeners.forEach(listener => listener());
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
  const path = preview ? 'sample.project-helper.zip' : await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Install a local declarative extension', filters: [{ name: 'PandaCode extension', extensions: ['zip'] }] });
  if (typeof path !== 'string') return;
  accept(await call<ExtensionSnapshot>('extensions_install', { path }));
}
export async function enableExtension(id: string, enabled: boolean): Promise<void> { accept(await call<ExtensionSnapshot>('extensions_enable', { id, enabled })); }
export async function uninstallExtension(id: string): Promise<void> { accept(await call<ExtensionSnapshot>('extensions_uninstall', { id })); }
export async function enterExtensionsSafeMode(): Promise<void> {
  // Immediate, protected recovery; package data remains untouched.
  accept({ safeMode: true, packages: [], diagnostics: [] });
  accept(await call<ExtensionSnapshot>('extensions_safe_mode'));
}
export function extensionGeneration(): number { return generation; }
