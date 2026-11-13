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
import toolManifest from '../../tests/fixtures/extensions/test-runner/extension.json';
import connectionManifest from '../../tests/fixtures/extensions/fake-service/extension.json';
import harnessManifest from '../../tests/fixtures/extensions/fake-harness/extension.json';
import { createConnectionsPreview } from './connections-preview';
import { createServicesPreview } from './services-preview';
export const previewServices = createServicesPreview();
export const previewConnections = createConnectionsPreview();
import { createJobsPreview } from './jobs-preview';
export const previewOwnedJobs = createJobsPreview();
import developmentManifest from '../../examples/extensions/project-summary/package/extension.json';
import dataPanelManifest from '../../tests/fixtures/extensions/data-panel/extension.json';
import richViewManifest from '../../tests/fixtures/extensions/rich-view/extension.json';
import appearanceManifest from '../../tests/fixtures/extensions/appearance/extension.json';
import replacementManifest from '../../tests/fixtures/extensions/replacement/extension.json';
import composerManifest from '../../tests/fixtures/extensions/composer/extension.json';
import transcriptManifest from '../../tests/fixtures/extensions/transcript/extension.json';
import appearanceSvg from '../../tests/fixtures/extensions/appearance/assets/symbol.svg?raw';
import windowSvg from '../../tests/fixtures/extensions/window-laboratory/assets/info.svg?raw';
import { validSettingsValues } from './settings-state';
import { validateContract } from './contracts';
import type { ExtensionPackage, ExtensionSnapshot, ExtensionMenuItem } from './manager';
import { createDeclarativeActivation } from './activation';
import { surfaceWindow } from './window-surfaces';
import { createStoragePreview } from './storage-preview';
export const previewPrivateStorage = createStoragePreview(localStorage);
const key = 'pandacode.preview.extensions.v1';
const windowLabel = location.pathname.endsWith('/agents-dock.html') ? 'agents-dock' : new URLSearchParams(location.search).get('view') === 'tray' ? 'tray' : new URLSearchParams(location.search).get('view') === 'launcher' ? 'launcher' : 'main';
// A main-page reload is the preview's existing simulated application restart. Safe recovery is
// shared with currently open compact windows, not persisted as an enabled-preference mutation.
if (windowLabel === 'main') localStorage.removeItem('pandacode.preview.extensions.safe');
let safeMode = new URLSearchParams(location.search).has('safe-mode');
let development: NonNullable<ExtensionSnapshot['development']> = [];
function read(): ExtensionSnapshot {
  safeMode ||= localStorage.getItem('pandacode.preview.extensions.safe') === 'true';
  if (safeMode) return { safeMode, packages: [], diagnostics: [] };
  try {
    const text = localStorage.getItem(key) ?? '[]';
    if (text.length > 3 * 1024 * 1024) throw new Error('Limit');
    const packages: ExtensionPackage[] = JSON.parse(text);
    for (const item of packages) item.storageGranted = previewPrivateStorage.granted(item.manifest.id, item.manifest.version);
    if (!Array.isArray(packages) || packages.some(item => typeof item.enabled !== 'boolean') || !validateContract('packages', packages.map(item => item.manifest)).ok) throw new Error('Invalid');
    // Assets always come from the canonical fixture, never untrusted localStorage markup.
    return { safeMode, development: structuredClone(development), packages: packages.map(item => ({ ...item, icons: { 'sample.project-helper/info': svg, ...(item.manifest.id === appearanceManifest.id ? { 'sample.appearance/symbol': appearanceSvg, 'sample.appearance/file': appearanceSvg } : {}), ...(item.manifest.id === 'sample.view-laboratory' ? { 'sample.view-laboratory/info': viewSvg } : {}), ...(item.manifest.id === threadManifest.id ? { 'sample.thread-laboratory/info': threadSvg } : {}), ...(item.manifest.id === windowManifest.id ? { 'sample.window-laboratory/info': windowSvg } : {}) } })), diagnostics: packages.flatMap(item => (item.manifest.contributes.menus ?? []).filter(menu => !menu.icon).map(menu => `${menu.id}: missing icon; using a safe fallback host icon.`)) };
  } catch { return { safeMode, packages: [], diagnostics: ['Corrupt preview extension record; activation bypassed.'] }; }
}
export const previewExtensionSnapshot = read;
export function previewExtensions(command: string, args: Record<string, unknown>, notify: (name: string, value: unknown) => void = () => undefined): unknown {
  if (command === 'extensions_enable' && args.enabled === false || command === 'extensions_uninstall') previewServices.stop(String(args.id));
  if (command === 'extensions_safe_mode' || command === 'extensions_window_recover') previewServices.stop();
  if (command === 'extensions_runtime' && ['developmentReload', 'trust'].includes((args.request as { op: string })?.op)) previewServices.stop((args.request as { id: string }).id);
  if (command === 'extensions_enable' && args.enabled === false || command === 'extensions_uninstall') previewConnections.stop(String(args.id));
  if (command === 'extensions_safe_mode' || command === 'extensions_window_recover') previewConnections.stop();
  if (command === 'extensions_runtime' && (args.request as { op?: string; allow?: boolean })?.op === 'trust' && (args.request as { allow?: boolean }).allow === false) previewConnections.stop((args.request as { id: string }).id);
  if (command === 'extensions_enable' && args.enabled === false || command === 'extensions_uninstall') previewOwnedJobs.stop(String(args.id));
  if (command === 'extensions_safe_mode' || command === 'extensions_window_recover') previewOwnedJobs.stop();
  if (command === 'extensions_runtime' && (args.request as { op?: string; allow?: boolean })?.op === 'trust' && (args.request as { allow?: boolean }).allow === false) previewOwnedJobs.stop((args.request as { id: string }).id);
  const label = windowLabel;
  if (label === 'main' && command.startsWith('extensions_window_')) throw new Error('PermissionDenied');
  if (label !== 'main' && !['extensions_window_snapshot', 'extensions_window_action', 'extensions_window_recover'].includes(command)) throw new Error('PermissionDenied');
  if (command === 'extensions_safe_mode' || command === 'extensions_window_recover') { safeMode = true; previewPrivateStorage.dispose(); localStorage.setItem('pandacode.preview.extensions.safe', 'true'); notify('extensions-changed', null); return command === 'extensions_safe_mode' ? read() : null; }
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
  if (command === 'extensions_rich_view_open') return { opened: false, reason: 'Rich HTML views are disabled: installed native isolation qualification is pending. Use the host-rendered view instead.' };
  if (safeMode) throw new Error('Safe mode: package loading is bypassed.');
  if (command === 'extensions_runtime') {
    const request = args.request as { op: string; id: string; digest: string; allow: boolean; path?: string };
    if (request.op === 'storageGrant') {
      previewPrivateStorage.grant(snapshot, request.id, request.allow);
      notify('extensions-changed', null); return { ok: true, value: read() };
    }
    if (request.op === 'removeOwnData') {
      const confirmation = (args.request as { confirmation: string }).confirmation;
      previewPrivateStorage.remove(snapshot, request.id, confirmation);
      const pages = JSON.parse(localStorage.getItem(`pandacode.preview.extension-private-pages.v1.${request.id}`) ?? '[]') as unknown;
      if (Array.isArray(pages)) for (const page of pages) if (typeof page === 'string' && page.startsWith(`${request.id}/`)) localStorage.removeItem(`pandacode.preview.extension-settings.v1.${request.id}.${page}`);
      localStorage.removeItem(`pandacode.preview.extension-private-pages.v1.${request.id}`);
      return { ok: true, value: null };
    }
    if (request.op === 'developmentSelect') {
      if (request.path !== 'preview-selected-folder' || snapshot.packages.some(item => item.manifest.id === developmentManifest.id)) throw new Error('InvalidPackage');
      development.push({ id: developmentManifest.id, revision: 0, logs: ['Validation passed; immutable folder snapshot selected. No code executed.', 'Executable trust and explicit enable required. Package output redacted.'] });
      snapshot.packages.push({ manifest: developmentManifest as ExtensionPackage['manifest'], enabled: false, icons: {}, executable: { digest: 'preview-development-0', trusted: false } });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return { ok: true, value: read() };
    }
    if (request.op === 'developmentReload') {
      const dev = development.find(dev => dev.id === request.id), item = snapshot.packages.find(item => item.manifest.id === request.id);
      if (!dev || !item?.executable) throw new Error('PermissionDenied');
      dev.revision++;
      // Synthetic changed content for deterministic UI coverage; native folder tests own validation.
      item.enabled = false; item.executable = { digest: `preview-development-${dev.revision}`, trusted: false };
      previewPrivateStorage.dispose(request.id);
      dev.logs.push('Reload validated; changed content disabled. Review executable trust again.');
      dev.logs = dev.logs.slice(-32);
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null);
      return { ok: true, value: { snapshot: read(), validated: true } };
    }
    if (request.op !== 'trust') return { ok: false, error: { schemaVersion: 1, code: 'UnsupportedRuntime', path: '$', ids: [] } };
    const item = snapshot.packages.find(item => item.manifest.id === request.id);
    if (!item?.executable || item.executable.digest !== request.digest) throw new Error('StaleContext');
    item.executable.trusted = request.allow;
    if (!request.allow) { item.enabled = false; previewPrivateStorage.dispose(request.id); }
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
    if (new URLSearchParams(location.search).has('extension-harness')) {
      if (snapshot.packages.some(item => item.manifest.id === harnessManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: harnessManifest as ExtensionPackage['manifest'], icons: {}, enabled: false, executable: { digest: 'recorded-harness-digest', trusted: false } });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    const selected = new URLSearchParams(location.search).has('extension-connections') ? connectionManifest : new URLSearchParams(location.search).has('extension-jobs') ? toolManifest : new URLSearchParams(location.search).has('transcript-conformance') ? transcriptManifest : new URLSearchParams(location.search).has('composer-conformance') ? composerManifest : new URLSearchParams(location.search).has('replacement') ? replacementManifest : new URLSearchParams(location.search).has('appearance') ? appearanceManifest : new URLSearchParams(location.search).has('rich-view') ? richViewManifest : new URLSearchParams(location.search).has('data-panel') ? dataPanelManifest : new URLSearchParams(location.search).has('executable-extension') ? executableManifest : new URLSearchParams(location.search).has('project-context') ? contextManifest : new URLSearchParams(location.search).has('window-laboratory') ? windowManifest : new URLSearchParams(location.search).has('settings-laboratory') ? settingsManifest : new URLSearchParams(location.search).has('thread-laboratory') ? threadManifest : manifest;
    if (snapshot.packages.some(item => item.manifest.id === selected.id)) throw new Error('Duplicate package ownership; already installed.');
    snapshot.packages.push({ manifest: selected as ExtensionPackage['manifest'], enabled: false, icons: {}, ...([executableManifest, toolManifest, connectionManifest].includes(selected as typeof executableManifest) ? { executable: { digest: 'preview-content-digest-not-native-trust', trusted: false } } : {}) });
  } else if (command === 'extensions_uninstall') {
    const item = snapshot.packages.find(item => item.manifest.id === args.id);
    if (item) localStorage.setItem(`pandacode.preview.extension-private-pages.v1.${item.manifest.id}`, JSON.stringify((item.manifest.contributes.settings ?? []).map(page => page.id)));
    previewPrivateStorage.dispose(String(args.id));
    development = development.filter(dev => dev.id !== args.id);
    snapshot.packages = snapshot.packages.filter(item => item.manifest.id !== args.id);
  } else if (command === 'extensions_enable') {
    const item = snapshot.packages.find(item => item.manifest.id === args.id);
    if (!item) throw new Error('Extension not found.');
    if (args.enabled === true && item.executable && !item.executable.trusted) throw new Error('ExecutableTrustRequired');
    item.enabled = args.enabled === true;
    if (!item.enabled) previewPrivateStorage.dispose(item.manifest.id);
    item.reason = null;
  } else throw new Error('Unsupported extension preview command.');
  localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
}
