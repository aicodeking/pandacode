/** Host-only cloud machine bindings: targets, machines, menus, dialogs and credentials never cross the package boundary. */
import { escape, isImeKey } from '../dom';
import { createCloudPresentation, snapshotCloud, type CloudAction, type CloudControl, type CloudPending, type CloudPresentation, type CloudPresentationStage } from './cloud';
import { applyCloudPresentation, cloudPresentationProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { CLOUD_CONTROLS } from './surfaces';
/** Raw host state; IDs stay in the host and only opaque handles are published. */
export type CloudHostState = {
  project: string; task: string; mode: 'none' | 'choice' | 'task';
  /** The task's provider, or the provider chosen in Run on for a New task ('' for this computer). */
  provider: string; machine: string; stage: CloudPresentationStage; label: string;
  pending: CloudPending; confirm: boolean; supported: boolean;
  /** Ready providers offered in Run on (choice mode). */
  targets: readonly string[];
  /** The original machine menu rows (task mode). */
  items: readonly { id: string; disabled?: boolean }[];
};
/** One host request: the original handler resolves `key` against the captured task. */
export type CloudHostRequest = { controlId: CloudControl; key: string; task: string };
/** Labels for the fresh host choice and the catalog; one source for both. */
export const CLOUD_LABELS: Readonly<Record<string, string>> = { ...Object.fromEntries(Object.values(CLOUD_CONTROLS).flatMap(controls => controls.map(([id, label]) => [id, label]))), 'target-cloud': 'Run the next message on this cloud provider' };
export const CLOUD_CONSENT_ITEM = 'extension-cloud-control';
const CONTROLS_LOCATION = 'panda.cloud.controls', TARGETS_LOCATION = 'panda.cloud.targets';
const MACHINE_CONTROLS: readonly string[] = ['sync', 'retry', 'open', 'stop', 'delete'];
export function mountCloudPresentation(options: {
  state: () => CloudHostState | undefined;
  strip: () => HTMLElement | null;
  /** The Run on control of a New task (choice mode). */
  computer: () => HTMLElement | null;
  /** Runs the original handler; `alive` re-checks the captured identity after any host choice. */
  execute: (request: CloudHostRequest, alive: () => boolean) => void;
  openContext: (anchor: HTMLElement, point?: { x: number; y: number }) => void;
  notify: (message: string) => void;
  rerender: () => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>(), keys = new Map<string, string>();
  let disposed = false, identity = '', revision = 0, signature = '', consent = false;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const hidden = (id: string) => !extensionsSnapshot().safeMode && layout.isHidden(id, layoutProject());
  function authority() {
    const provider = cloudPresentationProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; consent = false; }
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('connections.summary')), cloudControl: consent, userChoice: true };
  }
  function controls(s: CloudHostState): { controlId: CloudControl; key: string; enabled: boolean }[] {
    if (s.mode === 'choice') return [
      ...s.targets.map(provider => ({ controlId: 'target-cloud' as const, key: `target:${provider}`, enabled: !hidden(`${TARGETS_LOCATION}/target-cloud`) })),
      { controlId: 'target-setup', key: 'setup', enabled: !hidden(`${TARGETS_LOCATION}/target-setup`) },
    ];
    if (s.mode !== 'task') return [];
    const menu = options.strip()?.querySelector<HTMLElement>('#cloud-menu');
    return [
      { controlId: 'machine-menu', key: 'menu', enabled: Boolean(menu?.isConnected && !menu.closest('[data-layout-hidden],[inert]')) },
      ...s.items.filter(item => MACHINE_CONTROLS.includes(item.id)).map(item => ({ controlId: item.id as CloudControl, key: `machine:${item.id}`, enabled: !item.disabled && s.pending === 'none' && !hidden(`panda.cloud.actions/${item.id}`) })),
      ...(s.confirm ? [{ controlId: 'delete-cancel' as const, key: 'confirm', enabled: true }] : []),
    ];
  }
  function presentation(): CloudPresentation {
    const s = options.state(), auth = authority();
    const live: CloudHostState = s ?? { project: '', task: '', mode: 'none', provider: '', machine: '', stage: 'none', label: '', pending: 'none', confirm: false, supported: false, targets: [], items: [] };
    const provider = live.provider ? handle(`provider:${live.provider}`) : '', machine = live.machine ? handle(`machine:${live.task}:${live.machine}`) : '';
    const all = controls(live); keys.clear();
    const list = all.slice(0, 64).map(control => {
      const id = handle(`control:${live.task}:${control.controlId}:${control.key}:${provider}:${machine}`); keys.set(id, control.key);
      return { id, controlId: control.controlId, resource: handle(`resource:${live.task}:${control.key}`), enabled: control.enabled };
    });
    const node = live.mode === 'task' ? options.strip() : live.mode === 'choice' ? options.computer() : null;
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: s ? handle(`project:${live.project}`) : '', task: s ? handle(`task:${live.task}`) : '', provider, machine, revision: 0, mode: live.mode, stage: live.stage, visible: Boolean(s && node?.isConnected && node.getClientRects().length && !disposed), busy: live.pending !== 'none' || Boolean(document.querySelector('dialog[open]')), pending: live.pending, confirm: live.confirm, offline: !navigator.onLine, error: live.stage === 'error', supported: live.supported, targets: Math.min(32, live.targets.length), label: auth.metadata ? live.label.slice(0, 80) : '', truncated: all.length > 64, controls: list };
    const next = JSON.stringify([value, live.label, auth.owner, auth.active, auth.cloudControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotCloud({ ...value, revision });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner, task = options.state()?.task ?? '';
    const slot = createCloudPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity, key = keys.get(action.control) ?? '';
      options.execute({ controlId: action.controlId, key, task }, () => {
        const live = presentation();
        return authority().active && captured === identity && live.task === action.task && live.provider === action.provider && live.machine === action.machine && live.controls.some(control => control.id === action.control && control.enabled);
      });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility for the strip's status and menu, rendered into the host markup itself. */
  function decorate(items: readonly (readonly [string, string])[]): string {
    const safe = extensionsSnapshot().safeMode, markup = new Map(items.map(([id, html]) => [`${CONTROLS_LOCATION}/${id}`, html]));
    const ids = safe ? [...markup.keys()] : orderedControls(CONTROLS_LOCATION, [...markup.keys()]);
    return ids.map(id => hidden(id) ? markup.get(id)!.replace(/^<(\w+)/, '<$1 data-layout-hidden="" inert=""') : markup.get(id)!).join('');
  }
  /** The Run on menu's cloud rows: providers and setup keep their place after the other computers. */
  function decorateTargets<T extends { id: string }>(items: readonly T[], kind: (item: T) => 'target-cloud' | 'target-setup' | undefined): T[] {
    const groups = new Map<string, T[]>([[`${TARGETS_LOCATION}/target-cloud`, []], [`${TARGETS_LOCATION}/target-setup`, []]]), rest: T[] = [];
    for (const item of items) { const group = kind(item); if (group) groups.get(`${TARGETS_LOCATION}/${group}`)!.push(item); else rest.push(item); }
    const ids = extensionsSnapshot().safeMode ? [...groups.keys()] : orderedControls(TARGETS_LOCATION, [...groups.keys()]);
    return [...rest, ...ids.flatMap(id => hidden(id) ? [] : groups.get(id)!)];
  }
  /** The host consent row inside the original menus; only while a provider is active. */
  function consentItem() {
    const auth = authority(); if (!auth.active) return undefined;
    return { id: CLOUD_CONSENT_ITEM, label: `${auth.cloudControl ? 'Revoke' : 'Allow'} cloud machine control for ${auth.owner.split('/')[0]}`, icon: auth.cloudControl ? 'close' : 'check' };
  }
  function toggleConsent() { if (authority().active) { consent = !consent; options.rerender(); } }
  function refresh() {
    if (disposed) return;
    options.rerender();
    const strip = options.strip();
    if (strip && !applyCloudPresentation(strip)) { options.notify('Cloud machine presentation failed. Built-in controls remain active.'); options.rerender(); }
  }
  const contributes = () => extensionsSnapshot().packages.some(item => item.enabled && (item.manifest.contributes.menus ?? []).some(menu => menu.location === 'panda.cloud.context'));
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const strip = event.target.closest<HTMLElement>('#composer-area .cloud-strip'), chip = event.target.closest<HTMLElement>('#composer-area .composer-computer-fixed[data-remote="cloud"]');
    const owner = strip ?? chip; if (!owner || options.state()?.mode !== 'task' || !authority().active && !contributes()) return;
    // Anchor on the focused control itself, so Escape returns focus there.
    const focused = event.target.closest<HTMLElement>('button, [tabindex]'), anchor = focused && owner.contains(focused) ? focused : owner;
    event.preventDefault(); event.stopPropagation();
    options.openContext(anchor, event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined);
  }
  document.addEventListener('contextmenu', openContext); document.addEventListener('keydown', openContext);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  return {
    presentation, dispatch, decorate, decorateTargets, consentItem, toggleConsent, refresh,
    /** Records a host state change (progress, pending, confirmation) so the revision moves even when no package is reading. */
    observe: () => { if (cloudPresentationProvider()) presentation(); },
    /** Provider attribute for the host strip markup: a progress redraw keeps the selected recipe without remounting. */
    providerAttribute: () => { const provider = cloudPresentationProvider(); return provider ? ` data-cloud-provider="${escape(provider.id)}"` : ''; },
    dispose() {
      disposed = true; stopExtensions(); stopLayout(); document.removeEventListener('contextmenu', openContext); document.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh);
    },
  };
}
