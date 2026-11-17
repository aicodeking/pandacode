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
import harnessSvg from '../../tests/fixtures/extensions/fake-harness/assets/mark.svg?raw';
import { createConnectionsPreview } from './connections-preview';
import { createServicesPreview } from './services-preview';
import * as runtimeGrants from './runtime-grants';
import { createServiceLifetimePreview } from './runtime-service-lifetime';
import * as serviceSupervision from './runtime-service-supervision';
import { createPrivateSecretsPreview } from './runtime-private-secrets';
import { createSignInPreview } from './runtime-sign-in';
import { createConnectionAdaptersPreview, type Transport } from './runtime-connection-adapters';
import { createHeldCredentialsPreview } from './runtime-held-credentials';
import { call } from '../bridge';
import * as nativeConsents from './runtime-native-consents';
import * as familyConsents from './runtime-family-consents';
import * as codeFolders from './runtime-code-folders';
// One store per page, so a ticket minted by a gate is the one the choice presents; a reload is the preview's restart.
const previewFamilyConsents = familyConsents.createFamilyConsentsPreview(runtimeGrants.createRuntimeGrantsPreview());
(window as unknown as { __extensionFamilyConsents?: unknown }).__extensionFamilyConsents = { ...familyConsents, createRuntimeGrantsPreview: runtimeGrants.createRuntimeGrantsPreview };
// Test hook of the preview only (the production build has no module paths): the grants module and the validator.
(window as unknown as { __extensionRuntimeGrants?: unknown }).__extensionRuntimeGrants = { ...runtimeGrants, validateContract };
(window as unknown as { __extensionNativeConsents?: unknown }).__extensionNativeConsents = { ...nativeConsents, createRuntimeGrantsPreview: runtimeGrants.createRuntimeGrantsPreview };
// Code folders, the service environment and the data directory (R0105): the webview mirror of the native rules.
(window as unknown as { __extensionCodeFolders?: unknown }).__extensionCodeFolders = codeFolders;
export const previewServices = createServicesPreview();
export const previewConnections = createConnectionsPreview();
import { createJobsPreview } from './jobs-preview';
export const previewOwnedJobs = createJobsPreview();
import developmentManifest from '../../examples/extensions/project-summary/package/extension.json';
import dataPanelManifest from '../../tests/fixtures/extensions/data-panel/extension.json';
import richViewManifest from '../../tests/fixtures/extensions/rich-view/extension.json';
import appearanceManifest from '../../tests/fixtures/extensions/appearance/extension.json';
import replacementManifest from '../../tests/fixtures/extensions/replacement/extension.json';
import documentsManifest from '../../tests/fixtures/extensions/documents/extension.json';
import diffManifest from '../../tests/fixtures/extensions/diff/extension.json';
import searchManifest from '../../tests/fixtures/extensions/search/extension.json';
import browserManifest from '../../tests/fixtures/extensions/browser/extension.json';
import simulatorManifest from '../../tests/fixtures/extensions/simulator/extension.json';
import vmManifest from '../../tests/fixtures/extensions/vm/extension.json';
import designManifest from '../../tests/fixtures/extensions/design/extension.json';
import boardManifest from '../../tests/fixtures/extensions/board/extension.json';
import githubHubManifest from '../../tests/fixtures/extensions/github-hub/extension.json';
import pullManifest from '../../tests/fixtures/extensions/pull/extension.json';
import worktreeManifest from '../../tests/fixtures/extensions/worktree/extension.json';
import settingsCoreManifest from '../../tests/fixtures/extensions/settings-core/extension.json';
import sidebarManifest from '../../tests/fixtures/extensions/sidebar/extension.json';
import dockManifest from '../../tests/fixtures/extensions/action-dock/extension.json';
import upstreamWorkersManifest from '../../tests/fixtures/extensions/upstream-workers/manifest.json';
import composerControlsManifest from '../../tests/fixtures/extensions/composer-controls/extension.json';
import composerPanelsManifest from '../../tests/fixtures/extensions/composer-panels/extension.json';
import composerAttachManifest from '../../tests/fixtures/extensions/composer-attach/extension.json';
import threadExtrasManifest from '../../tests/fixtures/extensions/thread-extras/extension.json';
import tilesPickerManifest from '../../tests/fixtures/extensions/tiles-picker/extension.json';
import upstreamExplorerManifest from '../../tests/fixtures/extensions/upstream-explorer/manifest.json';
import commandsExtrasManifest from '../../tests/fixtures/extensions/commands-extras/extension.json';
import taskMenusManifest from '../../tests/fixtures/extensions/task-menus/extension.json';
import windowMenusManifest from '../../tests/fixtures/extensions/window-menus/extension.json';
import botConversationManifest from '../../tests/fixtures/extensions/bot-conversation/extension.json';
import rosterManifest from '../../tests/fixtures/extensions/agent-roster/extension.json';
import statusManifest from '../../tests/fixtures/extensions/status/extension.json';
import moodboardManifest from '../../tests/fixtures/extensions/moodboards/extension.json';
import cloudManifest from '../../tests/fixtures/extensions/cloud/extension.json';
import machinesManifest from '../../tests/fixtures/extensions/machines/extension.json';
import btwManifest from '../../tests/fixtures/extensions/btw/extension.json';
import terminalManifest from '../../tests/fixtures/extensions/terminal/extension.json';
import composerManifest from '../../tests/fixtures/extensions/composer/extension.json';
import transcriptManifest from '../../tests/fixtures/extensions/transcript/extension.json';
import appearanceSvg from '../../tests/fixtures/extensions/appearance/assets/symbol.svg?raw';
import windowSvg from '../../tests/fixtures/extensions/window-laboratory/assets/info.svg?raw';
import windowCoverageManifest from '../../tests/fixtures/extensions/window-coverage/extension.json';
import windowCoverageSvg from '../../tests/fixtures/extensions/window-coverage/assets/mark.svg?raw';
import coreDialogsManifest from '../../tests/fixtures/extensions/core-dialogs/extension.json';
import coreDialogsSvg from '../../tests/fixtures/extensions/core-dialogs/assets/note.svg?raw';
import ownedDialogsManifest from '../../tests/fixtures/extensions/owned-dialogs/extension.json';
import ownedDialogsSvg from '../../tests/fixtures/extensions/owned-dialogs/assets/mark.svg?raw';
import toolImageViewerManifest from '../../tests/fixtures/extensions/upstream-tool-images/manifest.json';
import primitivesManifest from '../../tests/fixtures/extensions/primitives/extension.json';
import primitivesSvg from '../../tests/fixtures/extensions/primitives/assets/mark.svg?raw';
import { validSettingsValues } from './settings-state';
import { validateContract } from './contracts';
import type { ExtensionPackage, ExtensionSnapshot, ExtensionMenuItem } from './manager';
import { createDeclarativeActivation } from './activation';
import { surfaceWindow } from './window-surfaces';
import { createStoragePreview } from './storage-preview';
import { createUpdatePreview } from './updates-preview';
const previewUpdates = createUpdatePreview();
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
    previewUpdates.decorate(packages);
    for (const item of packages) item.storageGranted = previewPrivateStorage.granted(item.manifest.id, item.manifest.version);
    if (!Array.isArray(packages) || packages.some(item => typeof item.enabled !== 'boolean') || !validateContract('packages', packages.map(item => item.manifest)).ok) throw new Error('Invalid');
    // Assets always come from the canonical fixture, never untrusted localStorage markup.
    return { safeMode, development: structuredClone(development), packages: packages.map(item => ({ ...item, icons: { 'sample.project-helper/info': svg, ...(item.manifest.id === harnessManifest.id ? { 'sample.fake-harness/mark': harnessSvg } : {}), ...(item.manifest.id === appearanceManifest.id ? { 'sample.appearance/symbol': appearanceSvg, 'sample.appearance/file': appearanceSvg } : {}), ...(item.manifest.id === 'sample.view-laboratory' ? { 'sample.view-laboratory/info': viewSvg } : {}), ...(item.manifest.id === threadManifest.id ? { 'sample.thread-laboratory/info': threadSvg } : {}), ...(item.manifest.id === windowManifest.id ? { 'sample.window-laboratory/info': windowSvg } : {}), ...(item.manifest.id === windowCoverageManifest.id ? { 'sample.window-coverage/mark': windowCoverageSvg } : {}), ...(item.manifest.id === coreDialogsManifest.id ? { 'sample.core-dialogs/mark': coreDialogsSvg } : {}), ...(item.manifest.id === ownedDialogsManifest.id ? { 'sample.owned-dialogs/mark': ownedDialogsSvg } : {}), ...(item.manifest.id === primitivesManifest.id ? { 'sample.primitives/mark': primitivesSvg } : {}) } })), diagnostics: packages.flatMap(item => (item.manifest.contributes.menus ?? []).filter(menu => !menu.icon).map(menu => `${menu.id}: missing icon; using a safe fallback host icon.`)) };
  } catch { return { safeMode, packages: [], diagnostics: ['Corrupt preview extension record; activation bypassed.'] }; }
}
export const previewExtensionSnapshot = read;
export function previewProviderStarted(id: string): void { const snapshot = read(); previewUpdates.pin(snapshot.packages, id); localStorage.setItem(key, JSON.stringify(snapshot.packages)); }
export function previewProviderFinished(id: string, notify: (name: string, value: unknown) => void): void { const snapshot = read(); if (snapshot.safeMode) return; previewUpdates.release(snapshot.packages, id); localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); }
// Background services (R0104): synthetic stand-in of the native owner; every extensions command reconciles it.
const previewServiceLifetime = createServiceLifetimePreview();
if (windowLabel === 'main') previewServiceLifetime.launch();
if (new URLSearchParams(location.search).has('service-lifetime')) (window as unknown as { __extensionServiceLifetime?: unknown }).__extensionServiceLifetime = { call: (command: string, args?: Record<string, unknown>) => call(command, args) };
// Service supervision (R0106): labelled stand-in on a simulated clock; crashes are scripted by a test hook only.
const previewServiceSupervision = serviceSupervision.createServiceSupervisionPreview();
if (new URLSearchParams(location.search).has('service-supervision')) (window as unknown as { __extensionServiceSupervision?: unknown }).__extensionServiceSupervision = { ...serviceSupervision, call: (command: string, args?: Record<string, unknown>) => call(command, args) };
function serviceSupervisionPreview(args: Record<string, unknown>): unknown {
  const id = String(args.id);
  switch (args.op) {
    case 'crash': return previewServiceSupervision.crash(id, typeof args.code === 'string' ? args.code : undefined);
    case 'hang': previewServiceSupervision.hang(id); return null;
    case 'advance': previewServiceSupervision.advance(Number(args.ms)); return null;
    default: throw new Error('InvalidArguments');
  }
}
// Private package secrets (R0802): labelled stand-in of the native owner; service calls come from a test hook only.
const previewPrivateSecrets = createPrivateSecretsPreview();
if (new URLSearchParams(location.search).has('private-secrets')) (window as unknown as { __extensionPrivateSecrets?: unknown }).__extensionPrivateSecrets = { call: (command: string, args?: Record<string, unknown>) => call(command, args) };
function privateSecretsCall(args: Record<string, unknown>): unknown {
  const snapshot = read(), id = String(args.id), grants = runtimeGrants.createRuntimeGrantsPreview();
  if (!snapshot.safeMode) grants.sync(snapshot as runtimeGrants.SyncSnapshot);
  const version = snapshot.packages.find(item => item.manifest.id === id)?.manifest.version ?? '';
  return previewPrivateSecrets.handle(snapshot.safeMode ? 'PermissionDenied' : grants.check(id, version, 'secrets.private'), id, args.caller === 'panel' ? 'panel' : 'service', String(args.method), args.params);
}
// Browser sign-in (R0803): labelled stand-in of the native owner on a simulated clock and simulated ports; service calls come from a test hook only.
const previewSignIn = createSignInPreview();
if (new URLSearchParams(location.search).has('sign-in')) (window as unknown as { __extensionSignIn?: unknown }).__extensionSignIn = { call: (command: string, args?: Record<string, unknown>) => call(command, args) };
function signInGrant(id: string): string {
  const snapshot = read(), grants = runtimeGrants.createRuntimeGrantsPreview();
  if (snapshot.safeMode) return 'PermissionDenied';
  grants.sync(snapshot as runtimeGrants.SyncSnapshot);
  return grants.check(id, snapshot.packages.find(item => item.manifest.id === id)?.manifest.version ?? '', 'auth.signIn');
}
function signInService(args: Record<string, unknown>): unknown {
  const id = String(args.id), port = Number(args.port);
  switch (args.op) {
    case 'start': return previewSignIn.start(signInGrant(id), id, args.caller === 'panel' ? 'panel' : 'service', args.params, args.browser === 'missing' ? 'missing' : 'works');
    case 'browser': return previewSignIn.browser(id, args as { method?: string; target: string });
    case 'advance': previewSignIn.advance(Number(args.ms)); return null;
    case 'occupy': previewSignIn.occupy(port); return null;
    case 'free': previewSignIn.free(port); return null;
    case 'listening': return previewSignIn.listening(port);
    case 'outcome': return previewSignIn.outcome(id);
    default: throw new Error('InvalidArguments');
  }
}
function reconcileSignIns(): void {
  for (const flow of previewSignIn.projection().flows) if (signInGrant(flow.id) !== 'ok') previewSignIn.revoke(flow.id);
}
// Held credentials used without being read, the activity list and account switching (R0805): a labelled stand-in; the
// credentials are seeded by a test, the grant is checked per item on every use and while a request runs.
const previewHeld = createHeldCredentialsPreview();
if (new URLSearchParams(location.search).has('held-credentials')) (window as unknown as { __extensionHeldCredentials?: unknown }).__extensionHeldCredentials = { call: (command: string, args?: Record<string, unknown>) => call(command, args) };
function heldGrants(): ReturnType<typeof runtimeGrants.createRuntimeGrantsPreview> | null {
  const snapshot = read(), grants = runtimeGrants.createRuntimeGrantsPreview();
  if (snapshot.safeMode) return null;
  grants.sync(snapshot as runtimeGrants.SyncSnapshot);
  return grants;
}
function heldService(args: Record<string, unknown>): unknown {
  const id = String(args.id ?? '');
  switch (args.op) {
    case 'seed': previewHeld.seed(String(args.item), args.value === null ? null : String(args.value)); return null;
    case 'switch': {
      const snapshot = read(), grants = heldGrants(), found = snapshot.packages.find(item => item.manifest.id === id), version = found?.manifest.version ?? '';
      const entry = grants?.projection().packages.find(item => item.id === id && item.version === version && item.authorized);
      const holds = !!entry && entry.grants.some(grant => grant.permission === 'credentials.use');
      return previewHeld.switchAccount(holds, item => grants?.check(id, version, 'credentials.use', { item }) ?? 'PermissionDenied', id, version, args.caller === 'panel' ? 'panel' : 'service', args.params);
    }
    case 'accounts': { const harness = typeof args.harness === 'string' ? args.harness : undefined; return { items: previewHeld.accounts(harness), revision: previewHeld.revision(harness) }; }
    case 'active': return previewHeld.active(String(args.harness));
    default: throw new Error('InvalidArguments');
  }
}
// Declared connection requests (R0804): the same rules over a transport the test supplies (a real loopback call from
// the test process); the preview has no network of its own. Package secrets come from the private-secrets stand-in.
const previewConnectionAdapters = createConnectionAdaptersPreview({
  transport: request => { const transport = (window as unknown as { __connectionTransport?: Transport }).__connectionTransport; if (!transport) throw new Error('HostUnavailable'); return transport(request); },
  secret: (id, name) => previewPrivateSecrets.attach(id, name),
  held: previewHeld.adaptersHeld((id, version, item) => heldGrants()?.check(id, version, 'credentials.use', { item }) === 'ok'),
});
if (new URLSearchParams(location.search).has('connection-adapters')) (window as unknown as { __extensionConnectionAdapters?: unknown }).__extensionConnectionAdapters = { call: (command: string, args?: Record<string, unknown>) => call(command, args) };
function connectionAdaptersCall(args: Record<string, unknown>): unknown {
  const snapshot = read(), id = String(args.id), grants = runtimeGrants.createRuntimeGrantsPreview();
  if (!snapshot.safeMode) grants.sync(snapshot as runtimeGrants.SyncSnapshot);
  const found = snapshot.packages.find(item => item.manifest.id === id), version = found?.manifest.version ?? '';
  const check = snapshot.safeMode || !found ? 'PermissionDenied' : grants.check(id, version, 'connections.request');
  if (check !== 'ok') previewConnectionAdapters.revoke(id); // what runs when the grant goes away loses its output
  return previewConnectionAdapters.handle(check, id, version, args.caller === 'panel' ? 'panel' : 'service', (found?.manifest ?? {}) as unknown as Record<string, unknown>, String(args.method), args.params, item => grants.check(id, version, 'credentials.use', { item }));
}
function reconcileServices(): void {
  const snapshot = read(), grants = runtimeGrants.createRuntimeGrantsPreview();
  if (!snapshot.safeMode) grants.sync(snapshot as runtimeGrants.SyncSnapshot);
  previewServiceLifetime.reconcile(snapshot, (id, version) => grants.check(id, version, 'runtime.service') === 'ok');
  previewServiceSupervision.reconcile(previewServiceLifetime.projection());
}
export function previewExtensions(command: string, args: Record<string, unknown>, notify: (name: string, value: unknown) => void = () => undefined): unknown {
  if (command === 'extensions_private_secrets') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return previewPrivateSecrets.projection(); }
  if (command === 'extensions_private_secrets_service') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return privateSecretsCall(args); }
  if (command === 'extensions_sign_in') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return previewSignIn.projection(); }
  if (command === 'extensions_sign_in_service') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return signInService(args); }
  if (command === 'extensions_sign_in_cancel') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return { cancelled: previewSignIn.cancel(String(args.id)) }; }
  if (command === 'extensions_sign_in_paste') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); previewSignIn.paste(String(args.id), String(args.url)); return null; }
  if (command === 'extensions_credential_activity') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return previewHeld.activity(String(args.id)); }
  if (command === 'extensions_held_credentials_service') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return heldService(args); }
  if (command === 'extensions_connection_adapters_service') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); return connectionAdaptersCall(args); }
  if (command === 'extensions_uninstall') { previewPrivateSecrets.removePackage(String(args.id)); previewConnectionAdapters.forget(String(args.id)); previewHeld.removePackage(String(args.id)); }
  if (command === 'extensions_service_lifetime') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); reconcileServices(); return previewServiceSupervision.decorate(previewServiceLifetime.projection()); }
  if (command === 'extensions_service_supervision_preview') { if (windowLabel !== 'main') throw new Error('PermissionDenied'); reconcileServices(); return serviceSupervisionPreview(args); }
  // Enable is the retry of a parked, restarting or never-settled service (native `runtime::retry`).
  if (command === 'extensions_enable' && args.enabled === true) previewServiceSupervision.retry(String(args.id));
  try { return previewExtensionCommand(command, args, notify); } finally { if (windowLabel === 'main') { reconcileServices(); reconcileSignIns(); } }
}
function previewExtensionCommand(command: string, args: Record<string, unknown>, notify: (name: string, value: unknown) => void): unknown {
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
  if (command === 'extensions_native_layout') {
    // Synthetic stand-in for the native broker's main-only presentation update; the OS menu build is native-tested.
    const value = args.layout as { hidden?: unknown; order?: unknown } | undefined;
    const ids = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 128 && list.every(id => typeof id === 'string' && id.length <= 160 && !id.startsWith('panda.') && /^[a-z0-9-]+\.[a-z0-9.-]+\/[a-z0-9-]+$/.test(id));
    if (!value || Object.keys(value).sort().join(',') !== 'hidden,order' || !ids(value.hidden) || !ids(value.order) || new Set(value.order).size !== value.order.length) throw new Error('InvalidLayout');
    (window as unknown as { __previewNativeLayout?: unknown }).__previewNativeLayout = structuredClone(value);
    return null;
  }
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
  if (command === 'extensions_runtime_grants' || command === 'extensions_runtime_grant') return runtimeGrants.createRuntimeGrantsPreview().call(command, args, snapshot);
  if (command === 'extensions_runtime_native_consents') return nativeConsents.createNativeConsentsPreview().call(command, snapshot);
  if (command === 'extensions_family_consents') return previewFamilyConsents.call(args, snapshot);
  if (command === 'extensions_rich_view_open') return { opened: false, reason: 'Rich HTML views are disabled: installed native isolation qualification is pending. Use the host-rendered view instead.' };
  if (safeMode) throw new Error('Safe mode: package loading is bypassed.');
  if (command === 'extensions_runtime') {
    const request = args.request as { op: string; id: string; digest: string; allow: boolean; path?: string };
    if (['stageUpdate', 'reviewUpdate', 'rollbackUpdate'].includes(request.op)) {
      if (request.op === 'stageUpdate') previewUpdates.stage(snapshot.packages, request.id);
      else if (request.op === 'reviewUpdate') previewUpdates.review(snapshot.packages, request.id, request.digest);
      else previewUpdates.rollback(snapshot.packages, request.id);
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return { ok: true, value: read() };
    }
    if (request.op === 'projectScope') {
      // Synthetic stand-in for the native record write; native tests own persistence and admission.
      const checked = validateContract('projectScope', (args.request as { scope?: unknown }).scope);
      if (!checked.ok) return { ok: false, error: checked.error };
      const item = snapshot.packages.find(item => item.manifest.id === request.id);
      if (!item) return { ok: false, error: { schemaVersion: 1, code: 'NotFound', path: '$', ids: [] } };
      const scope = checked.value as { mode: 'all' | 'selected'; projects?: string[] };
      if (scope.mode === 'selected') item.projects = [...scope.projects!]; else delete item.projects;
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return { ok: true, value: read() };
    }
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
    if (new URLSearchParams(location.search).has('machines-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === machinesManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: machinesManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('cloud-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === cloudManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: cloudManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('moodboards-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === moodboardManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: moodboardManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('upstream-tool-images')) {
      if (snapshot.packages.some(item => item.manifest.id === toolImageViewerManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: toolImageViewerManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('owned-dialog-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === ownedDialogsManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: ownedDialogsManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('dialog-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === coreDialogsManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: coreDialogsManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('status-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === statusManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: statusManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('roster-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === rosterManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: rosterManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('window-menus')) {
      if (snapshot.packages.some(item => item.manifest.id === windowMenusManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: windowMenusManifest as unknown as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('bot-conversation')) {
      if (snapshot.packages.some(item => item.manifest.id === botConversationManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: botConversationManifest as unknown as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('task-menus')) {
      if (snapshot.packages.some(item => item.manifest.id === taskMenusManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: taskMenusManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('commands-extras')) {
      if (snapshot.packages.some(item => item.manifest.id === commandsExtrasManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: commandsExtrasManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('upstream-explorer')) {
      if (snapshot.packages.some(item => item.manifest.id === upstreamExplorerManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: upstreamExplorerManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('tiles-picker')) {
      if (snapshot.packages.some(item => item.manifest.id === tilesPickerManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: tilesPickerManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('thread-extras')) {
      if (snapshot.packages.some(item => item.manifest.id === threadExtrasManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: threadExtrasManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('composer-attach')) {
      if (snapshot.packages.some(item => item.manifest.id === composerAttachManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: composerAttachManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('composer-panels')) {
      if (snapshot.packages.some(item => item.manifest.id === composerPanelsManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: composerPanelsManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('composer-controls')) {
      if (snapshot.packages.some(item => item.manifest.id === composerControlsManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: composerControlsManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('upstream-workers')) {
      if (snapshot.packages.some(item => item.manifest.id === upstreamWorkersManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: upstreamWorkersManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('dock-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === dockManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: dockManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('sidebar-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === sidebarManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: sidebarManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('settings-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === settingsCoreManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: settingsCoreManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('worktree-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === worktreeManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: worktreeManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('pull-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === pullManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: pullManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('github-hub-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === githubHubManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: githubHubManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('board-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === boardManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: boardManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('btw-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === btwManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: btwManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('design-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === designManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: designManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('vm-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === vmManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: vmManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
    } else if (new URLSearchParams(location.search).has('simulator-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === simulatorManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: simulatorManifest as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('documents-coverage') || new URLSearchParams(location.search).has('diff-coverage') || new URLSearchParams(location.search).has('search-coverage') || new URLSearchParams(location.search).has('browser-coverage') || new URLSearchParams(location.search).has('terminal-coverage')) {
      const selected = new URLSearchParams(location.search).has('terminal-coverage') ? terminalManifest : new URLSearchParams(location.search).has('browser-coverage') ? browserManifest : new URLSearchParams(location.search).has('search-coverage') ? searchManifest : new URLSearchParams(location.search).has('diff-coverage') ? diffManifest : documentsManifest;
      if (snapshot.packages.some(item => item.manifest.id === selected.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: selected as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
    if (new URLSearchParams(location.search).has('primitives-coverage')) {
      if (snapshot.packages.some(item => item.manifest.id === primitivesManifest.id)) throw new Error('Already installed');
      snapshot.packages.push({ manifest: primitivesManifest as unknown as ExtensionPackage['manifest'], icons: {}, enabled: false });
      localStorage.setItem(key, JSON.stringify(snapshot.packages)); notify('extensions-changed', null); return read();
    }
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
    previewUpdates.uninstall(snapshot.packages, String(args.id));
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
