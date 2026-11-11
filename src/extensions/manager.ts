/** Internal host adapter. This bridge is never exposed to packages. */
import { call, preview } from '../bridge';
import { validateContract, type Json } from './contracts';

export type ExtensionPackage = { manifest: { id: string; version: string; contributes: { icons?: { id: string; asset: string }[]; commands?: { id: string; title: string; action: { kind: string; message?: string } }[]; menus?: { id: string; location: string; command: string; icon?: string; visible?: Json; enabled?: Json }[] } }; icons: Record<string, string>; enabled: boolean };
export type ExtensionSnapshot = { safeMode: boolean; packages: ExtensionPackage[]; diagnostics: string[] };
let snapshot: ExtensionSnapshot = { safeMode: false, packages: [], diagnostics: [] };
const listeners = new Set<() => void>();
let generation = 0;
export function extensionsSnapshot(): ExtensionSnapshot { return structuredClone(snapshot); }
export function onExtensionsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function accept(value: ExtensionSnapshot): void {
  // A stale activation reply cannot revive contributions after protected recovery.
  if (snapshot.safeMode && !value.safeMode) return;
  const active = value.packages.filter(item => item.enabled);
  const checked = validateContract('packages', active.map(item => item.manifest));
  snapshot = structuredClone(value);
  if (!checked.ok) {
    snapshot.packages.forEach(item => { item.enabled = false; });
    snapshot.diagnostics.push(`Activation rejected: ${checked.error.code}`);
  }
  if (snapshot.safeMode) snapshot.packages = [];
  generation++;
  listeners.forEach(listener => listener());
}
export async function loadExtensions(): Promise<void> {
  try { accept(await call<ExtensionSnapshot>('extensions_snapshot')); }
  catch { accept({ safeMode: false, packages: [], diagnostics: ['Extensions unavailable; built-in controls remain available.'] }); }
}
export async function installExtension(): Promise<void> {
  const path = preview ? 'sample.project-helper.zip' : await (await import('@tauri-apps/plugin-dialog')).open({ multiple: false, title: 'Install a local declarative extension', filters: [{ name: 'PandaCode extension', extensions: ['zip'] }] });
  if (typeof path !== 'string') return;
  accept(await call<ExtensionSnapshot>('extensions_install', { path }));
}
export async function enableExtension(id: string, enabled: boolean): Promise<void> { accept(await call<ExtensionSnapshot>('extensions_enable', { id, enabled })); }
export async function enterExtensionsSafeMode(): Promise<void> {
  // Immediate, protected recovery; package data remains untouched.
  accept({ safeMode: true, packages: [], diagnostics: [] });
  accept(await call<ExtensionSnapshot>('extensions_safe_mode'));
}
export function extensionGeneration(): number { return generation; }
