/** Host-only execution target and machine coordination bindings: devices, link requests, threads, dialogs
 * and remote starts never cross the package boundary; only opaque handles are published. */
import { escape, isImeKey } from '../dom';
import { createMachinesPresentation, snapshotMachines, type MachinesControl, type MachinesPending, type MachinesPresentation } from './machines';
import { applyMachinesPresentation, machinesPresentationProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { MACHINES_CONTROLS } from './surfaces';
/** Raw host state; device, request and thread IDs stay in the host. */
export type MachinesHostState = {
  project: string; task: string; mode: 'none' | 'choice' | 'task';
  /** The chosen (choice) or fixed (task) computer, '' for this computer or a cloud provider. */
  host: string; label: string; pending: MachinesPending; behind: boolean; hostOffline: boolean; missing: boolean; signedIn: boolean;
  /** Other computers offered in Run on, and whether Run on offers Connect setup (choice mode). */
  devices: readonly { id: string; online: boolean }[]; setup: boolean;
  /** Whether the start strip shows a failure with Retry and Dismiss. */
  failed: boolean;
};
/** One host request: the original handler resolves `key` (a device, link request or thread) against the captured task. */
export type MachinesHostRequest = { controlId: MachinesControl; key: string; task: string };
/** Labels for the fresh host choice and the catalog; one source for both. */
export const MACHINES_LABELS: Readonly<Record<string, string>> = { ...Object.fromEntries(Object.values(MACHINES_CONTROLS).flatMap(controls => controls.map(([id, label]) => [id, label]))), 'target-local': 'Run the next message on this computer', 'target-device': 'Run the next message on the chosen computer', 'start-retry': 'Retry the start on the other computer' };
export const MACHINES_CONSENT_ITEM = 'extension-machine-control';
const CONTROLS_LOCATION = 'panda.machines.controls', TARGETS_LOCATION = 'panda.machines.targets', CONTEXT_LOCATION = 'panda.machines.context';
export function mountMachinesPresentation(options: {
  state: () => MachinesHostState | undefined;
  /** Link requests, launched threads, the switch and the open Link dialog, from machine-orchestration.ts. */
  coordination: (task: string) => { enabled: boolean; requests: readonly string[]; threads: readonly { id: string; live: boolean }[]; linking: boolean };
  slot: () => HTMLElement | null;
  /** Runs the original handler; `alive` re-checks the captured identity after any host choice. */
  execute: (request: MachinesHostRequest, alive: () => boolean) => void;
  /** Opens the context menu for a lineage thread (`thread`), the waiting line or the fixed remote chip. */
  openContext: (anchor: HTMLElement, source: { thread?: string; chip?: boolean }, point?: { x: number; y: number }) => void;
  notify: (message: string) => void;
  rerender: () => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>(), keys = new Map<string, string>();
  let disposed = false, identity = '', revision = 0, signature = '', consent = false;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const hidden = (id: string) => !extensionsSnapshot().safeMode && layout.isHidden(id, layoutProject());
  function authority() {
    const provider = machinesPresentationProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; consent = false; }
    return { owner: provider?.id ?? '', active: !disposed && !extensionsSnapshot().safeMode && Boolean(owner && provider), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('connections.summary')), machineControl: consent, userChoice: true };
  }
  function controls(s: MachinesHostState, c: ReturnType<typeof options.coordination>): { controlId: MachinesControl; key: string; enabled: boolean }[] {
    const list: { controlId: MachinesControl; key: string; enabled: boolean }[] = [];
    if (s.mode === 'choice') {
      const computer = document.querySelector<HTMLElement>('#composer-area #composer-computer');
      list.push({ controlId: 'computer-menu', key: 'menu', enabled: Boolean(computer?.isConnected && !computer.closest('[data-layout-hidden],[inert]')) });
      list.push({ controlId: 'target-local', key: 'local', enabled: !hidden(`${TARGETS_LOCATION}/target-local`) });
      for (const device of s.devices) list.push({ controlId: 'target-device', key: `device:${device.id}`, enabled: device.online && !hidden(`${TARGETS_LOCATION}/target-device`) });
      if (s.setup) list.push({ controlId: 'target-setup', key: 'setup', enabled: !hidden(`${TARGETS_LOCATION}/target-setup`) });
    }
    if (s.mode === 'task' && s.hostOffline) list.push({ controlId: 'reconnect', key: 'reconnect', enabled: s.pending !== 'reconnecting' && !hidden(`${CONTEXT_LOCATION}/reconnect`) });
    if (s.failed) list.push({ controlId: 'start-retry', key: 'start', enabled: true }, { controlId: 'start-dismiss', key: 'start', enabled: true });
    if (s.behind) list.push({ controlId: 'behind-cancel', key: 'behind', enabled: true });
    for (const request of c.requests.slice(0, 16)) list.push(
      { controlId: 'link-decline', key: `request:${request}`, enabled: !hidden(`${CONTROLS_LOCATION}/link-decline`) },
      { controlId: 'link-open', key: `request:${request}`, enabled: !hidden(`${CONTROLS_LOCATION}/link-open`) },
    );
    if (c.linking) list.push({ controlId: 'link-cancel', key: 'linking', enabled: true });
    for (const thread of c.threads) {
      list.push({ controlId: 'lineage-open', key: `thread:${thread.id}`, enabled: !hidden(`${CONTEXT_LOCATION}/lineage-open`) });
      if (thread.live) list.push({ controlId: 'lineage-stop', key: `thread:${thread.id}`, enabled: !hidden(`${CONTEXT_LOCATION}/lineage-stop`) });
    }
    if (c.threads.some(thread => thread.live)) list.push({ controlId: 'stop-all', key: 'threads', enabled: !hidden(`${CONTEXT_LOCATION}/stop-all`) });
    return list;
  }
  function presentation(): MachinesPresentation {
    const s = options.state(), auth = authority();
    const live: MachinesHostState = s ?? { project: '', task: '', mode: 'none', host: '', label: '', pending: 'none', behind: false, hostOffline: false, missing: false, signedIn: false, devices: [], setup: false, failed: false };
    const c = s ? options.coordination(live.task) : { enabled: false, requests: [], threads: [], linking: false };
    const host = live.host ? handle(`host:${live.host}`) : '';
    const all = controls(live, c); keys.clear();
    const list = all.slice(0, 64).map(control => {
      const id = handle(`control:${live.task}:${control.controlId}:${control.key}:${host}`); keys.set(id, control.key);
      return { id, controlId: control.controlId, resource: handle(`resource:${live.task}:${control.key}`), enabled: control.enabled };
    });
    const composer = document.querySelector<HTMLElement>('#composer-area #composer');
    const busy = live.pending === 'checking' || live.pending === 'starting' || live.pending === 'reconnecting' || live.behind || c.linking || Boolean(document.querySelector('dialog[open]'));
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: s ? handle(`project:${live.project}`) : '', task: s ? handle(`task:${live.task}`) : '', host, revision: 0, mode: live.mode, visible: Boolean(s && composer?.isConnected && composer.getClientRects().length && !disposed), busy, pending: live.pending, behind: live.behind, linking: c.linking, offline: !navigator.onLine, hostOffline: live.hostOffline, missing: live.missing, signedIn: live.signedIn, orchestration: c.enabled, requests: Math.min(16, c.requests.length), threads: Math.min(64, c.threads.length), running: Math.min(64, c.threads.filter(thread => thread.live).length), label: auth.metadata ? live.label.slice(0, 80) : '', truncated: all.length > 64 || c.requests.length > 16, controls: list };
    const next = JSON.stringify([value, live.label, live.devices, auth.owner, auth.active, auth.machineControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotMachines({ ...value, revision });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner, task = options.state()?.task ?? '';
    const slot = createMachinesPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity, key = keys.get(action.control) ?? '';
      options.execute({ controlId: action.controlId, key, task }, () => {
        const live = presentation();
        return authority().active && captured === identity && live.task === action.task && live.host === action.host && live.controls.some(control => control.id === action.control && control.enabled);
      });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility for a link card's buttons, rendered into the host markup itself. */
  function decorate(items: readonly (readonly [string, string])[]): string {
    const safe = extensionsSnapshot().safeMode, markup = new Map(items.map(([id, html]) => [`${CONTROLS_LOCATION}/${id}`, html]));
    const ids = safe ? [...markup.keys()] : orderedControls(CONTROLS_LOCATION, [...markup.keys()]);
    return ids.map(id => hidden(id) ? markup.get(id)!.replace(/^<(\w+)/, '<$1 data-layout-hidden="" inert=""') : markup.get(id)!).join('');
  }
  /** The Run on menu's own rows: this computer, other computers and Connect setup, ahead of any cloud rows. */
  function decorateTargets<T extends { id: string }>(items: readonly T[], kind: (item: T) => 'target-local' | 'target-device' | 'target-setup' | undefined): T[] {
    const groups = new Map<string, T[]>([[`${TARGETS_LOCATION}/target-local`, []], [`${TARGETS_LOCATION}/target-device`, []], [`${TARGETS_LOCATION}/target-setup`, []]]), rest: T[] = [];
    for (const item of items) { const group = kind(item); if (group) groups.get(`${TARGETS_LOCATION}/${group}`)!.push(item); else rest.push(item); }
    const ids = extensionsSnapshot().safeMode ? [...groups.keys()] : orderedControls(TARGETS_LOCATION, [...groups.keys()]);
    return [...ids.flatMap(id => hidden(id) ? [] : groups.get(id)!), ...rest];
  }
  /** The host consent row inside the original menus; only while a provider is active. */
  function consentItem() {
    const auth = authority(); if (!auth.active) return undefined;
    return { id: MACHINES_CONSENT_ITEM, label: `${auth.machineControl ? 'Revoke' : 'Allow'} machine control for ${auth.owner.split('/')[0]}`, icon: auth.machineControl ? 'close' : 'check' };
  }
  function toggleConsent() { if (authority().active) { consent = !consent; refresh(); } }
  /** Applies the selected recipe to the orchestration slot (which outlives composer redraws) and reports a new fault once. */
  function apply() {
    const slot = options.slot();
    if (slot && !applyMachinesPresentation(slot)) { options.notify('Machine presentation failed. Built-in controls remain active.'); return false; }
    return true;
  }
  function refresh() {
    if (disposed) return;
    apply(); options.rerender(); presentation();
  }
  const contributes = () => extensionsSnapshot().packages.some(item => item.enabled && (item.manifest.contributes.menus ?? []).some(menu => menu.location === CONTEXT_LOCATION));
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const row = event.target.closest<HTMLElement>('.lineage-row[data-thread]'), wait = event.target.closest<HTMLElement>('#machine-orchestration .lineage-wait');
    const chip = event.target.closest<HTMLElement>('#composer-area .composer-computer-fixed:not([data-remote="cloud"])');
    const owner = row ?? wait ?? chip; if (!owner || !authority().active && !contributes()) return;
    // Anchor on the focused control itself, so Escape returns focus there.
    const focused = event.target.closest<HTMLElement>('button, [tabindex]'), anchor = focused && owner.contains(focused) ? focused : owner;
    event.preventDefault(); event.stopPropagation();
    options.openContext(anchor, row ? { thread: row.dataset.thread } : chip ? { chip: true } : {}, event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined);
  }
  document.addEventListener('contextmenu', openContext); document.addEventListener('keydown', openContext);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  return {
    presentation, dispatch, decorate, decorateTargets, consentItem, toggleConsent, refresh, apply,
    /** Records a host state change (choice, presence, pending start, dialog) so the revision moves even when no package is reading. */
    observe: () => { if (machinesPresentationProvider()) presentation(); },
    /** Provider attribute for a freshly drawn orchestration slot. */
    providerAttribute: () => { const provider = machinesPresentationProvider(); return provider ? ` data-machines-provider="${escape(provider.id)}"` : ''; },
    dispose() {
      disposed = true; stopExtensions(); stopLayout(); document.removeEventListener('contextmenu', openContext); document.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh);
    },
  };
}
