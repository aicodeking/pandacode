/** Synthetic browser lifecycle. Native archive/security tests remain authoritative. */
import manifest from '../../tests/fixtures/extensions/sample-project-helper/extension.json';
import svg from '../../tests/fixtures/extensions/sample-project-helper/assets/info.svg?raw';
import viewSvg from '../../tests/fixtures/extensions/view-laboratory/assets/info.svg?raw';
import threadManifest from '../../tests/fixtures/extensions/thread-laboratory/extension.json';
import threadSvg from '../../tests/fixtures/extensions/thread-laboratory/assets/info.svg?raw';
import settingsManifest from '../../tests/fixtures/extensions/settings-laboratory/extension.json';
import { validSettingsValues } from './settings-state';
import { validateContract } from './contracts';
import type { ExtensionPackage, ExtensionSnapshot } from './manager';
const key = 'pandacode.preview.extensions.v1';
let safeMode = new URLSearchParams(location.search).has('safe-mode');
function read(): ExtensionSnapshot {
  if (safeMode) return { safeMode, packages: [], diagnostics: [] };
  try {
    const text = localStorage.getItem(key) ?? '[]';
    if (text.length > 3 * 1024 * 1024) throw new Error('Limit');
    const packages: ExtensionPackage[] = JSON.parse(text);
    if (!Array.isArray(packages) || packages.some(item => typeof item.enabled !== 'boolean') || !validateContract('packages', packages.map(item => item.manifest)).ok) throw new Error('Invalid');
    // Assets always come from the canonical fixture, never untrusted localStorage markup.
    return { safeMode, packages: packages.map(item => ({ ...item, icons: { 'sample.project-helper/info': svg, ...(item.manifest.id === 'sample.view-laboratory' ? { 'sample.view-laboratory/info': viewSvg } : {}), ...(item.manifest.id === threadManifest.id ? { 'sample.thread-laboratory/info': threadSvg } : {}) } })), diagnostics: packages.flatMap(item => (item.manifest.contributes.menus ?? []).filter(menu => !menu.icon).map(menu => `${menu.id}: missing icon; using a safe fallback host icon.`)) };
  } catch { return { safeMode, packages: [], diagnostics: ['Corrupt preview extension record; activation bypassed.'] }; }
}
export function previewExtensions(command: string, args: Record<string, unknown>): unknown {
  if (command === 'extensions_safe_mode') { safeMode = true; return read(); }
  const snapshot = read();
  if (command === 'extensions_snapshot') return snapshot;
  if (safeMode) throw new Error('Safe mode: package loading is bypassed.');
  if (command === 'extensions_settings_get' || command === 'extensions_settings_set') {
    const owner = snapshot.packages.find(item => item.enabled && item.manifest.id === args.id);
    const page = owner?.manifest.contributes.settings?.find(page => page.id === args.page);
    if (!owner || !page) throw new Error('Unknown or dormant settings namespace.');
    const storageKey = `pandacode.preview.extension-settings.v1.${owner.manifest.id}.${page.id}`;
    if (command === 'extensions_settings_get') { const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); return validSettingsValues(page, value) ? value : null; }
    if (!validSettingsValues(page, args.values)) throw new Error('Invalid extension settings values.');
    localStorage.setItem(storageKey, JSON.stringify(args.values)); return null;
  }
  if (command === 'extensions_install') {
    const selected = new URLSearchParams(location.search).has('settings-laboratory') ? settingsManifest : new URLSearchParams(location.search).has('thread-laboratory') ? threadManifest : manifest;
    if (snapshot.packages.some(item => item.manifest.id === selected.id)) throw new Error('Duplicate package ownership; already installed.');
    snapshot.packages.push({ manifest: selected as ExtensionPackage['manifest'], enabled: false, icons: {} });
  } else if (command === 'extensions_uninstall') {
    snapshot.packages = snapshot.packages.filter(item => item.manifest.id !== args.id);
  } else if (command === 'extensions_enable') {
    const item = snapshot.packages.find(item => item.manifest.id === args.id);
    if (!item) throw new Error('Extension not found.');
    item.enabled = args.enabled === true;
    item.reason = null;
  } else throw new Error('Unsupported extension preview command.');
  localStorage.setItem(key, JSON.stringify(snapshot.packages)); return read();
}
