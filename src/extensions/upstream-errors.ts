/** Thread errors and the app toast v1 (docs/extensions/upstream-errors.md): a thread's grouped error rows (Details and
 * Dismiss), a box's Dismiss all, a bot's failover notice and the one toast's close button.
 *
 * Two halves in one module. The pure half (registry, captured presentation and action admission) is JSON-only and
 * imports nothing from the DOM. The host half (`mountUpstreamErrorsAdoption`) arranges the original buttons by the
 * user's order and visibility, builds the captured presentation from the rows on screen and runs an admitted action by
 * activating the original node, so every handler (dismissal journal, Undo, bot failover, toast timers) is the upstream
 * one. Error text, saved row ids and the toast text never cross the package boundary.
 *
 * With no package that owns the transcript, in safe mode and with nothing arranged, no row carries a marker, an
 * attribute or an observer: the rows stay as the host drew them. */
import { ERROR_CHOICE_CONTROLS, ERROR_CONTROL_IDS, ERROR_CONTROL_SELECTORS, errorGroupsDigest, type ErrorControlId } from '../thread-errors.ts';
import { toastPresentation, type ToastPresentation } from '../toast-model.ts';

/** Thread errors and the one toast: the grouped error rows of a thread, a bot's failover notice and the app toast. The
 * adapter arranges the Details and Dismiss buttons of an error row; the row's text, the dismissal journal, Undo, the
 * toast's text and its timers stay in main.ts, thread-errors.ts, toast-model.ts, toast-keys.ts and toast-clearance.ts.
 * Contributed actions on an error row or a toast are a named handoff (R0207 live notices, R0404B limit flow), not v1. */
export const THREAD_ERRORS_LOCATION = 'panda.thread.errors.controls';
export const THREAD_ERRORS_PROTECTED_LOCATION = 'panda.thread.errors.protected';
/** An error row's buttons: [id, label]. Details (the disclosure of the full text) hides; Dismiss never hides. */
export const THREAD_ERRORS_CONTROLS = [['details', 'Error details'], ['dismiss', 'Dismiss error']] as const;
export const THREAD_ERRORS_PINNED: Readonly<Record<string, string | undefined>> = {
  [`${THREAD_ERRORS_LOCATION}/dismiss`]: 'Dismiss is the user\'s way out of an error; it never hides.',
};
/** Protected thread-error and toast behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const THREAD_ERRORS_PROTECTED = [
  ['error-text', 'Error text, saved rows and the dismissal journal', 'Error messages, the saved row ids, the journal replayed at launch and the bot failover read stay in the host; packages see opaque row handles and counts only.'],
  ['dismiss-all', 'Dismiss all, the failover notice and Undo', 'Dismiss all, the provider failover notice\'s Dismiss and the toast\'s Undo and action buttons keep their place and their original handlers; a package request for a dismissal is a fresh host choice, never silent.'],
  ['toast-content', 'Toast text, timers and Escape order', 'The toast text, its timer, the Undo window, the F6 and Escape order and the transcript room it keeps clear stay host-owned; a host toast cannot be suppressed by a package.'],
] as const;

export type { ErrorControlId };
export type UpstreamErrorsControl = Readonly<{ id: string; controlId: ErrorControlId; resource: string; enabled: boolean; hidden: boolean }>;
export type UpstreamErrorsPresentation = Readonly<{
  contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number;
  visible: boolean; busy: boolean; safeMode: boolean;
  /** How many grouped error rows the open thread shows, whether a bot failover notice shows and the toast's shape; never
   * an error's or the toast's text. */
  groups: number; failover: boolean; toast: ToastPresentation;
  controls: readonly UpstreamErrorsControl[]; truncated: boolean;
}>;
export type UpstreamErrorsAction = Readonly<{ contractVersion: 1; window: 'main'; context: string; project: string; task: string; revision: number; control: string; controlId: ErrorControlId; resource: string; requestId: string }>;
export type UpstreamErrorsAuthority = { owner: string; active: boolean; granted: boolean; userChoice: boolean };
export type UpstreamErrorsReason = 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy';
export type UpstreamErrorsAdmission = { ok: true } | { ok: false; reason: UpstreamErrorsReason };

/** Host-only operations a package may name but never run: refused as PermissionDenied before any other check. */
export const UPSTREAM_ERRORS_PROTECTED_CONTROLS = ['error-read', 'error-journal', 'error-restore', 'toast-read', 'toast-undo', 'toast-suppress', 'toast-action'] as const;
/** Most controls one presentation lists, and most requests one admission remembers. */
const MAX_CONTROLS = 256, MAX_APPLIED = 4096;

/** One explicit entry per ledger member this adapter owns, with its public locations, what it supports and why not the
 * rest. `contributed` lists what a package cannot add yet and who owns it (a named handoff, never a refusal). */
export type UpstreamErrorsRegistryEntry = Readonly<{ member: string; source: string; locations: readonly string[]; controls: readonly string[]; order: boolean; hide: boolean; actions: boolean; reason: string; handoff: string }>;
const pinned = THREAD_ERRORS_PINNED;
export const UPSTREAM_ERRORS_REGISTRY: readonly UpstreamErrorsRegistryEntry[] = Object.freeze([
  { member: 'panda.thread.errors', source: 'src/thread-errors.ts', locations: [THREAD_ERRORS_LOCATION, THREAD_ERRORS_PROTECTED_LOCATION], controls: THREAD_ERRORS_CONTROLS.map(([id]) => id), order: true, hide: true, actions: true, reason: `Details and Dismiss reorder inside the row's own head; Details hides. ${Object.values(pinned).join(' ')} ${THREAD_ERRORS_PROTECTED.filter(([id]) => id !== 'toast-content').map(([, , why]) => why).join(' ')} Dismiss, Dismiss all and the failover notice's Dismiss run the original handler after a fresh host choice, so the Undo window still covers them.`, handoff: 'A contributed action slot on an error row (a package button beside Details and Dismiss) is not part of v1: it needs the notices contract of R0207; recorded for S07C and R1212.' },
  { member: 'panda.status.toast', source: 'src/toast-model.ts', locations: [THREAD_ERRORS_PROTECTED_LOCATION], controls: ['toast-close'], order: false, hide: false, actions: true, reason: `${THREAD_ERRORS_PROTECTED.find(([id]) => id === 'toast-content')?.[2]} A package may close the toast like the user's own close button; it cannot read its text, press Undo or an action, or keep it from showing.`, handoff: 'Package notices and the limit flow (R0207, R0404B) arrive through their own contracts; this adapter adds no way to raise a toast.' },
].map(entry => Object.freeze(entry)));

const CAPTURED = ['window', 'context', 'project', 'task', 'revision'] as const;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length <= max;
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => key in value);
const controlId = (value: unknown): value is ErrorControlId => (ERROR_CONTROL_IDS as readonly unknown[]).includes(value);

/** Shape check of a presentation and an action (strict keys, bounded strings, known control ids); the same rules as the
 * hub contracts, kept here because this adapter adds no new schema. */
export function validatePresentation(value: unknown): boolean {
  const p = record(value), toast = record(p.toast);
  return keysAre(p, ['contractVersion', 'window', 'context', 'project', 'task', 'revision', 'visible', 'busy', 'safeMode', 'groups', 'failover', 'toast', 'controls', 'truncated'])
    && p.contractVersion === 1 && p.window === 'main' && text(p.context) && text(p.project) && text(p.task) && Number.isSafeInteger(p.revision) && (p.revision as number) >= 0
    && [p.visible, p.busy, p.safeMode, p.failover, p.truncated].every(item => typeof item === 'boolean') && Number.isSafeInteger(p.groups) && (p.groups as number) >= 0 && (p.groups as number) <= 4096
    && keysAre(toast, ['showing', 'tone', 'urgent', 'undo', 'actions', 'closable']) && typeof toast.showing === 'boolean' && (toast.tone === 'danger' || toast.tone === 'neutral') && typeof toast.urgent === 'boolean' && typeof toast.undo === 'boolean' && typeof toast.closable === 'boolean' && Number.isSafeInteger(toast.actions) && (toast.actions as number) >= 0 && (toast.actions as number) <= 8
    && Array.isArray(p.controls) && p.controls.length <= MAX_CONTROLS && p.controls.every(item => { const c = record(item); return keysAre(c, ['id', 'controlId', 'resource', 'enabled', 'hidden']) && text(c.id) && controlId(c.controlId) && text(c.resource) && typeof c.enabled === 'boolean' && typeof c.hidden === 'boolean'; });
}
export function validateAction(value: unknown): boolean {
  const a = record(value);
  return keysAre(a, ['contractVersion', 'window', 'context', 'project', 'task', 'revision', 'control', 'controlId', 'resource', 'requestId'])
    && a.contractVersion === 1 && a.window === 'main' && text(a.context) && text(a.project) && text(a.task) && Number.isSafeInteger(a.revision) && (a.revision as number) >= 0
    && text(a.control) && controlId(a.controlId) && text(a.resource) && text(a.requestId) && (a.requestId as string).length > 0;
}
export function snapshotUpstreamErrors(props: UpstreamErrorsPresentation): UpstreamErrorsPresentation {
  if (!validatePresentation(props)) throw Error('Invalid upstream errors presentation');
  if (new Set(props.controls.map(control => control.id)).size !== props.controls.length) throw Error('Duplicate upstream errors handle');
  return freeze(structuredClone(props));
}

/** Captured admission: the presentation a package was handed pins window, context, project, task and revision; an
 * action built for anything else (another thread, a new, merged or dismissed group, a toast that changed) is stale. */
export function createUpstreamErrorsControls(props: UpstreamErrorsPresentation, owner: string, current: () => UpstreamErrorsPresentation, authority: () => UpstreamErrorsAuthority, dispatch: (action: UpstreamErrorsAction) => void, applied = new Set<string>()) {
  const captured = snapshotUpstreamErrors(props); let disposed = false;
  return { props: captured, dispatch(input: unknown): UpstreamErrorsAdmission {
    const auth = authority();
    if (disposed || !auth.active) return { ok: false, reason: 'Revoked' };
    if (auth.owner !== owner) return { ok: false, reason: 'WrongOwner' };
    if (!auth.granted) return { ok: false, reason: 'PermissionDenied' };
    const field = (key: string) => input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
    if (input && typeof input === 'object' && field('contractVersion') !== 1) return { ok: false, reason: 'UnsupportedCapability' };
    if ((UPSTREAM_ERRORS_PROTECTED_CONTROLS as readonly unknown[]).includes(field('controlId'))) return { ok: false, reason: 'PermissionDenied' };
    if (!validateAction(input)) return { ok: false, reason: 'InvalidArguments' };
    const action = input as UpstreamErrorsAction, live = current();
    if (CAPTURED.some(key => action[key] !== captured[key] || live[key] !== captured[key]) || !captured.visible || !live.visible) return { ok: false, reason: 'StaleContext' };
    if (applied.has(action.requestId)) return { ok: false, reason: 'AlreadyApplied' };
    // An open dialog, menu or a pending host choice keeps its input.
    if (live.busy) return { ok: false, reason: 'Busy' };
    const control = captured.controls.find(item => item.id === action.control), now = live.controls.find(item => item.id === action.control);
    if (!control || !now || [control, now].some(item => item.controlId !== action.controlId || item.resource !== action.resource)) return { ok: false, reason: 'StaleContext' };
    if (!control.enabled || !now.enabled || now.hidden) return { ok: false, reason: 'UnsupportedCapability' };
    if (ERROR_CHOICE_CONTROLS.includes(action.controlId) && !auth.userChoice) return { ok: false, reason: 'PermissionDenied' };
    if (applied.size >= MAX_APPLIED) return { ok: false, reason: 'Revoked' };
    applied.add(action.requestId); dispatch(freeze(structuredClone(action))); return { ok: true };
  }, dispose() { disposed = true; } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Host half. Everything below touches the document and the layout store, and is imported lazily by main.ts.

type Collaborators = {
  openChoiceMenu: typeof import('../choice-menu').openChoiceMenu;
  layout: typeof import('./layout-host').layout; layoutProject: typeof import('./layout-host').layoutProject; orderedControls: typeof import('./layout-host').orderedControls;
  extensionsSnapshot: typeof import('./manager').extensionsSnapshot; extensionIdentity: typeof import('./manager').extensionIdentity; onExtensionsChanged: typeof import('./manager').onExtensionsChanged;
  componentSelection: typeof import('./replacement').componentSelection; componentProviders: typeof import('./replacement').componentProviders;
};
export type UpstreamErrorsHostState = { project?: string; task?: string; busy: boolean; toastShownAt: number };
const ROW = '.message-error[data-error-key]', HEAD = ':scope > .error-row-head';
const shown = (element: Element) => element.getClientRects().length > 0;

/** Moves each node into one of the nodes' own places, in the desired order; focus stays on its node. */
function place(current: readonly HTMLElement[], desired: readonly HTMLElement[]): void {
  if (current.length !== desired.length || current.every((node, index) => node === desired[index])) return;
  const focused = document.activeElement as HTMLElement | null;
  const marks = current.map(node => { const mark = document.createComment(''); node.before(mark); return mark; });
  marks.forEach((mark, index) => mark.replaceWith(desired[index]));
  if (focused && desired.some(node => node.contains(focused)) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
/** A hidden control keeps its node, out of view and inert; focus inside it moves to `fallback`. */
function setHidden(element: HTMLElement | null | undefined, hidden: boolean, fallback?: () => HTMLElement | null | undefined): void {
  if (!element || element.hasAttribute('data-layout-hidden') === hidden) return;
  const focused = hidden && element.contains(document.activeElement);
  element.toggleAttribute('data-layout-hidden', hidden); element.inert = hidden;
  if (focused) fallback?.()?.focus({ preventScroll: true });
}

export async function mountUpstreamErrorsAdoption(options: {
  /** The workspace: the transcript with its error rows, the composer area with a bot's failover notice. */
  root: HTMLElement;
  state: () => UpstreamErrorsHostState;
  onContextChanged: (listener: () => void) => () => void;
}) {
  const [{ openChoiceMenu }, host, manager, replacement] = await Promise.all([import('../choice-menu'), import('./layout-host'), import('./manager'), import('./replacement')]);
  const c: Collaborators = { openChoiceMenu, layout: host.layout, layoutProject: host.layoutProject, orderedControls: host.orderedControls, extensionsSnapshot: manager.extensionsSnapshot, extensionIdentity: manager.extensionIdentity, onExtensionsChanged: manager.onExtensionsChanged, componentSelection: replacement.componentSelection, componentProviders: replacement.componentProviders };
  const { root } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, engagedNow = false, lastProject = c.layoutProject();
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || c.extensionsSnapshot().safeMode;
  const transcript = () => root.querySelector<HTMLElement>('#transcript');
  const toastNode = () => document.querySelector<HTMLElement>('#toast');
  const ids = THREAD_ERRORS_CONTROLS.map(([id]) => `${THREAD_ERRORS_LOCATION}/${id}`);

  function authority(): UpstreamErrorsAuthority {
    const provider = c.componentSelection.resolve('panda.transcript', c.componentProviders());
    const owner = c.extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? c.extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && transcript()?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }

  /** The adapter only touches the rows when the user arranged them: a hidden control or another order. Otherwise (and in
   * safe mode) every row stays exactly as the host drew it. */
  function engaged(): boolean {
    if (safe()) return false;
    const project = c.layoutProject();
    return ids.some(id => !THREAD_ERRORS_PINNED[id] && c.layout.isHidden(id, project)) || c.orderedControls(THREAD_ERRORS_LOCATION, ids).some((id, index) => id !== ids[index]);
  }
  const hiddenBy = (builtIn: boolean, id: string) => !builtIn && !THREAD_ERRORS_PINNED[id] && c.layout.isHidden(id, c.layoutProject());
  /** Arranges one error row's head, or puts it back as the host drew it (details first, then Dismiss). */
  function arrangeRow(row: HTMLElement, builtIn: boolean): void {
    const head = row.querySelector<HTMLElement>(HEAD); if (!head) return;
    const nodes: Record<string, HTMLElement | null> = {
      details: head.querySelector<HTMLElement>(':scope > [data-action="toggle-error"]'),
      dismiss: head.querySelector<HTMLElement>(':scope > [data-action="dismiss-error"], :scope > [data-action="dismiss-failover-error"]'),
    };
    const present = (order: readonly string[]) => order.map(id => nodes[id]).filter((node): node is HTMLElement => Boolean(node));
    const drawn = ['details', 'dismiss'], wanted = builtIn ? drawn : c.orderedControls(THREAD_ERRORS_LOCATION, drawn.map(id => `${THREAD_ERRORS_LOCATION}/${id}`)).map(id => id.slice(THREAD_ERRORS_LOCATION.length + 1));
    place(present(drawn), present(wanted));
    setHidden(nodes.details, hiddenBy(builtIn, `${THREAD_ERRORS_LOCATION}/details`), () => nodes.dismiss);
  }
  function arrange(scope: ParentNode = document): void {
    const builtIn = !engagedNow;
    const within = (selector: string) => [...(scope instanceof Element && scope.matches(selector) ? [scope as HTMLElement] : []), ...scope.querySelectorAll<HTMLElement>(selector)];
    for (const row of within('.message-error')) arrangeRow(row, builtIn);
  }
  // Only while engaged: rows the transcript draws again are arranged before they paint.
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && (node.matches('.message-error') || node.querySelector('.message-error'))) arrange(node);
  });
  function refresh() {
    if (disposed) return;
    lastProject = c.layoutProject();
    const was = engagedNow; engagedNow = engaged();
    if (engagedNow && !was) observer.observe(document.body, { childList: true, subtree: true });
    if (!engagedNow && was) observer.disconnect();
    if (engagedNow || was) arrange();
  }

  const rows = () => [...(transcript()?.querySelectorAll<HTMLElement>(ROW) ?? [])];
  const rowKey = (row: HTMLElement) => `${row.dataset.session ?? ''}|${row.dataset.errorScope ?? ''}|${row.dataset.errorKey ?? ''}`;
  const rowFor = (key: string) => rows().find(row => rowKey(row) === key) ?? null;
  const failoverNode = () => root.querySelector<HTMLElement>('.bot-failover-error');

  function presentation(): UpstreamErrorsPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '';
    finders.clear();
    const controls: UpstreamErrorsControl[] = [], boxes = new Set<HTMLElement>();
    const add = (key: string, id: ErrorControlId, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(key, find);
      controls.push({ id: key, controlId: id, resource, enabled: !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true', hidden: Boolean(element.closest('[data-layout-hidden], [hidden]')) || !shown(element) });
    };
    const groups = task ? rows() : [];
    for (const row of groups) {
      const key = rowKey(row), resource = handle(`error:${key}`), find = (id: ErrorControlId) => () => rowFor(key)?.querySelector<HTMLElement>(ERROR_CONTROL_SELECTORS[id]) ?? null;
      add(handle(`error-details:${key}`), 'error-details', resource, find('error-details'));
      add(handle(`error-dismiss:${key}`), 'error-dismiss', resource, find('error-dismiss'));
      const box = row.closest<HTMLElement>('.thread-errors');
      if (box && !boxes.has(box) && box.querySelector('[data-action="dismiss-errors"]')) {
        boxes.add(box);
        add(handle(`errors-dismiss-all:${key}`), 'errors-dismiss-all', handle(`box:${key}`), () => rowFor(key)?.closest<HTMLElement>('.thread-errors')?.querySelector<HTMLElement>(ERROR_CONTROL_SELECTORS['errors-dismiss-all']) ?? null);
      }
    }
    const failover = task ? failoverNode() : null;
    if (failover) add(handle(`failover-dismiss:${task}`), 'failover-dismiss', handle(`failover:${task}`), () => failoverNode()?.querySelector<HTMLElement>(ERROR_CONTROL_SELECTORS['failover-dismiss']) ?? null);
    const toast = toastNode(), visible = Boolean(toast && !toast.hidden);
    const toastState = toastPresentation({
      visible, tone: toast?.hasAttribute('data-danger') ? 'danger' : undefined, undo: Boolean(toast?.querySelector('.toast-undo')),
      actions: toast?.querySelectorAll('.toast-action, .toast-secondary').length ?? 0, closable: Boolean(toast?.querySelector(':scope > .toast-close')), shownAt: state.toastShownAt, now: Date.now(),
    });
    if (visible && toastState.closable) add(handle('toast-close'), 'toast-close', handle('toast'), () => { const found = toastNode(); return found && !found.hidden ? found.querySelector<HTMLElement>(ERROR_CONTROL_SELECTORS['toast-close']) : null; });
    const view = transcript();
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      revision: 0, visible: !disposed && Boolean(view?.isConnected && shown(view)),
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open]')) || Boolean(document.querySelector('.model-menu, .choice-menu')),
      safeMode: c.extensionsSnapshot().safeMode, groups: Math.min(groups.length, 4096), failover: Boolean(failover), toast: { ...toastState, urgent: false },
      controls: controls.slice(0, MAX_CONTROLS), truncated: controls.length > MAX_CONTROLS,
    };
    // The digest names every group and whether its details are open, so each redraw, merge, dismissal or disclosure is a
    // new revision; the toast's shape (never its text) and the owner do too. `urgent` is a clock, not a state.
    const digest = errorGroupsDigest(groups.map(row => ({ key: `${rowKey(row)}|${row.querySelector('[data-action="toggle-error"]')?.getAttribute('aria-expanded') ?? ''}`, count: Number(row.dataset.errorCount ?? 1) })));
    const next = JSON.stringify([value, digest, toastState.tone, toastState.undo, toastState.actions, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotUpstreamErrors({ ...value, revision, toast: toastState });
  }
  const DETAILS: Readonly<Partial<Record<ErrorControlId, string>>> = { 'error-dismiss': 'Dismiss this error', 'errors-dismiss-all': 'Dismiss all errors', 'failover-dismiss': 'Dismiss the failover notice' };
  /** Runs the original handler by activating the original node; every dismissal needs a fresh host choice first, bound to
   * the same thread, target and revision. */
  function execute(action: UpstreamErrorsAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!ERROR_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
    choosing = true; closeChoice?.();
    closeChoice = c.openChoiceMenu({ anchor: element, title: 'Extension requested to dismiss errors', items: [{ id: 'continue', label: `Continue: ${DETAILS[action.controlId] ?? action.controlId}`, icon: 'alert' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown): UpstreamErrorsAdmission {
    const owner = authority().owner;
    const slot = createUpstreamErrorsControls(presentation(), owner, presentation, authority, action => {
      const ownerIdentity = identity, task = options.state().task;
      // The choice acts only on the same thread and target it was asked for, and only while the revision still holds.
      execute(action, () => { const live = presentation(); return authority().active && ownerIdentity === identity && options.state().task === task && live.revision === action.revision && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  const stopExtensions = c.onExtensionsChanged(refresh), stopLayout = c.layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (c.layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  queueMicrotask(refresh);
  return {
    presentation, dispatch,
    dispose() {
      if (disposed) return;
      closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      // Every row goes back to the host's own order and visibility.
      observer.disconnect(); engagedNow = false; arrange(); disposed = true;
    },
  };
}
