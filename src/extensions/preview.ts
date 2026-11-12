/** Synthetic browser lifecycle. Native archive/security tests remain authoritative. */
import manifest from '../../tests/fixtures/extensions/sample-project-helper/extension.json';
import svg from '../../tests/fixtures/extensions/sample-project-helper/assets/info.svg?raw';
import viewSvg from '../../tests/fixtures/extensions/view-laboratory/assets/info.svg?raw';
import threadManifest from '../../tests/fixtures/extensions/thread-laboratory/extension.json';
import threadSvg from '../../tests/fixtures/extensions/thread-laboratory/assets/info.svg?raw';
import settingsManifest from '../../tests/fixtures/extensions/settings-laboratory/extension.json';
import windowManifest from '../../tests/fixtures/extensions/window-laboratory/extension.json';
import contextManifest from '../../tests/fixtures/extensions/project-context/extension.json';
import executableManifest from '../../tests/fixtures/extensions/project-summary/extension.json';
import windowSvg from '../../tests/fixtures/extensions/window-laboratory/assets/info.svg?raw';
import { validSettingsValues } from './settings-state';
import { validateContract } from './contracts';
import type { ExtensionPackage, ExtensionSnapshot, ExtensionMenuItem } from './manager';
import { createDeclarativeActivation } from './activation';
import { surfaceWindow } from './window-surfaces';
const key = 'pandacode.preview.extensions.v1';
const windowLabel = location.pathname.endsWith('/agents-dock.html') ? 'agents-dock' : new URLSearchParams(location.search).get('view') === 'tray' ? 'tray' : new URLSearchParams(location.search).get('view') === 'launcher' ? 'launcher' : 'main';
// A main-page reload is the preview's existing simulated application restart. Safe recovery is
// shared with currently open compact windows, not persisted as an enabled-preference mutation.
if (windowLabel === 'main') localStorage.removeItem('pandacode.preview.extensions.safe');
let safeMode = new URLSearchParams(location.search).has('safe-mode');
function read(): ExtensionSnapshot {
  safeMode ||= localStorage.getItem('pandacode.preview.extensions.safe') === 'true';
  if (safeMode) return { safeMode, packages: [], diagnostics: [] };
  try {
    const text = localStorage.getItem(key) ?? '[]';
    if (text.length > 3 * 1024 * 1024) throw new Error('Limit');
    const packages: ExtensionPackage[] = JSON.parse(text);
    if (!Array.isArray(packages) || packages.some(item => typeof item.enabled !== 'boolean') || !validateContract('packages', packages.map(item => item.manifest)).ok) throw new Error('Invalid');
    // Assets always come from the canonical fixture, never untrusted localStorage markup.
    return { safeMode, packages: packages.map(item => ({ ...item, icons: { 'sample.project-helper/info': svg, ...(item.manifest.id === 'sample.view-laboratory' ? { 'sample.view-laboratory/info': viewSvg } : {}), ...(item.manifest.id === threadManifest.id ? { 'sample.thread-laboratory/info': threadSvg } : {}), ...(item.manifest.id === windowManifest.id ? { 'sample.window-laboratory/info': windowSvg } : {}) } })), diagnostics: packages.flatMap(item => (item.manifest.contributes.menus ?? []).filter(menu => !menu.icon).map(menu => `${menu.id}: missing icon; using a safe fallback host icon.`)) };
  } catch { return { safeMode, packages: [], diagnostics: ['Corrupt preview extension record; activation bypassed.'] }; }
}
export const previewExtensionSnapshot = read;
export function previewExtensions(command: string, args: Record<string, unknown>, notify: (name: string, value: unknown) => void = () => undefined): unknown {
  const label = windowLabel;
  if (label === 'main' && command.startsWith('extensions_window_')) throw new Error('PermissionDenied');
  if (label !== 'main' && !['extensions_window_snapshot', 'extensions_window_action', 'extensions_window_recover'].includes(command)) throw new Error('PermissionDenied');
  if (command === 'extensions_safe_mode' || command === 'extensions_window_recover') { safeMode = true; localStorage.setItem('pandacode.preview.extensions.safe', 'true'); notify('extensions-changed', null); return command === 'extensions_safe_mode' ? read() : null; }
  const snapshot = read();
  if (command === 'extensions_window_snapshot') return { windowId: label, snapshot };
  if (command === 'extensions_window_action' || command === 'extensions_present_action') {
    const request = args.request as { surfaceId: string; id: string; version: string };
    if (!request || Object.keys(request).sort().join(',') !== 'id,surfaceId,version' || typeof request.surfaceId !== 'string' || typeof request.id !== 'string' || typeof request.version !== 'string') throw new Error('PermissionDenied');
    const origin = surfaceWindow(request.surfaceId);
    if (origin === 'main' || command === 'extensions_window_action' && label !== origin) throw new Error('PermissionDenied');
    const activation = createDeclarativeActivation(snapshot, 1);
    try {
      const owns = (items: ExtensionMenuItem[]): boolean => items.some(item => item.id === request.id || item.items && owns(item.items));
      const entry = activation.entries.find(entry => entry.menu.location === request.surfaceId && entry.owner.version === request.version && (entry.menu.id === request.id || owns(entry.menu.items ?? [])));
      const context = { schemaVersion: 1, windowId: origin, surfaceId: request.surfaceId, revision: 1 };
      const action = entry && activation.actionFor(request.id, context);
      if (!action) throw new Error('PermissionDenied');
      if (command === 'extensions_present_action') return { owner: entry.owner.extensionId, context, action };
      if (action.kind === 'showDialog') { localStorage.setItem('pandacode.preview.extensions.presentation', JSON.stringify({ request, nonce: crypto.randomUUID() })); notify('extensions-present-action', request); return null; }
      return action;
    } finally { activation.dispose(); }
  }
  if (command === 'extensions_snapshot') return snapshot;
  if (safeMode) throw new Error('Safe mode: package loading is bypassed.');
  if (command === 'extensions_runtime') {
    const request = args.request as { op: string; id: string; digest: string; allow: boolean };
    if (request.op !== 'trust') return { ok: false, error: { schemaVersion: 1, code: 'UnsupportedRuntime', path: '$', ids: [] } };
    const item = snapshot.packages.find(item => item.manifest.id === request.id);
    if (!item?.executable || item.executable.digest !== request.digest) throw new Error('StaleContext');
    item.executable.trusted = request.allow;
    if (!request.allow) item.enabled = false;
    localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null);
    return { ok: true, value: read() };
  }
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
    const selected = new URLSearchParams(location.search).has('executable-extension') ? executableManifest : new URLSearchParams(location.search).has('project-context') ? contextManifest : new URLSearchParams(location.search).has('window-laboratory') ? windowManifest : new URLSearchParams(location.search).has('settings-laboratory') ? settingsManifest : new URLSearchParams(location.search).has('thread-laboratory') ? threadManifest : manifest;
    if (snapshot.packages.some(item => item.manifest.id === selected.id)) throw new Error('Duplicate package ownership; already installed.');
    snapshot.packages.push({ manifest: selected as ExtensionPackage['manifest'], enabled: false, icons: {}, ...(selected === executableManifest ? { executable: { digest: 'preview-content-digest-not-native-trust', trusted: false } } : {}) });
  } else if (command === 'extensions_uninstall') {
    snapshot.packages = snapshot.packages.filter(item => item.manifest.id !== args.id);
  } else if (command === 'extensions_enable') {
    const item = snapshot.packages.find(item => item.manifest.id === args.id);
    if (!item) throw new Error('Extension not found.');
    if (args.enabled === true && item.executable && !item.executable.trusted) throw new Error('ExecutableTrustRequired');
    item.enabled = args.enabled === true;
    item.reason = null;
  } else throw new Error('Unsupported extension preview command.');
  localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
}
