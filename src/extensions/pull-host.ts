/** Host-only Pull request bindings: original nodes, handlers and merge confirmation never cross the package boundary. */
import { isImeKey } from '../dom';
import { createPullPresentation, snapshotPull, PULL_ENTRY_CONTROLS, type PullAction, type PullControl, type PullPresentation, type PullSection } from './pull';
import { applyPullPresentation, componentProviders, componentSelection } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, applyControlOrder, applyControlVisibility } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
export type PullHostFile = { path: string; additions: number; deletions: number; expanded: boolean; loading: boolean; error: boolean };
export type PullHostState = { project: string; task: string; repository: string; pull: string; base: string; head: string; section: PullSection; visible: boolean; loading: boolean; busy: boolean; error: boolean; state: string; merge: PullPresentation['merge']; method: PullPresentation['method']; checks: boolean; title: string; files: PullHostFile[] };
const SIMPLE: readonly PullControl[] = ['checks', 'file', 'refresh', 'unlink', 'merge-start', 'merge-method', 'merge-cancel'];
/** Protected merge controls are offered as actions but never reordered or hidden; Confirm merge has no public control at all. */
const MERGE: readonly PullControl[] = ['merge-start', 'merge-method', 'merge-cancel'];
const STATES = ['open', 'draft', 'merged', 'closed'] as const;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function mountPullPresentation(root: HTMLElement, state: () => PullHostState, notify: (message: string) => void, confirmEntry: (anchor: HTMLElement, proceed: () => void) => void) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), nodes = new Map<string, HTMLElement>(), applied = new Set<string>();
  const lifetime = new AbortController(); let disposed = false, identity = '', revision = 0, signature = '', consent = false, closeContext: (() => void) | undefined;
  // Original render order, so built-in recovery can restore a reordered group without remounting.
  const originalOrder = new WeakMap<HTMLElement, number>(); let nextOrder = 0;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  function authority() {
    const provider = componentSelection.resolve('panda.pull', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; consent = false; }
    return { owner: provider?.id ?? '', active: !disposed && Boolean(owner && provider && root.dataset.pullProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')), pullControl: consent, userChoice: true };
  }
  function control(node: HTMLElement): PullControl | undefined {
    const action = node.dataset.pullAction as PullControl | 'section' | 'open' | 'merge-confirm' | undefined;
    if (action === 'section') return node.closest('.pull-tabs') ? (['overview', 'commits', 'files'] as const).find(section => section === node.dataset.section) : 'conflicts';
    if (action === 'open') return node.closest('.pull-checks') ? 'check' : [...node.classList].some(name => name.startsWith('pull-review-')) ? 'review' : 'link';
    if (action && SIMPLE.includes(action as PullControl)) return action as PullControl;
  }
  function bindings() {
    const s = state(), counts = new Map<string, number>(); nodes.clear();
    return [...root.querySelectorAll<HTMLElement>('[data-pull-action]')].flatMap(node => {
      const controlId = control(node); if (!controlId) return [];
      const raw = controlId === 'file' ? `file:${s.pull}:${node.dataset.path}` : controlId === 'check' ? `check:${s.pull}:${node.dataset.url}` : `pull:${s.pull}`;
      const base = JSON.stringify([s.pull, controlId, raw, node.dataset.section, node.getAttribute('aria-label')]);
      const index = counts.get(base) ?? 0; counts.set(base, index + 1);
      const key = handle(`${base}:${index}`); nodes.set(key, node);
      if (!originalOrder.has(node)) originalOrder.set(node, nextOrder++);
      return [{ id: key, controlId, resource: handle(raw), enabled: !(node as HTMLButtonElement).disabled && !node.closest('[hidden]'), node }];
    });
  }
  function presentation(): PullPresentation {
    const s = state(), auth = authority(), controls = bindings();
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: handle(`project:${s.project}`), task: handle(`task:${s.task}`), repository: handle(`repo:${s.repository}`), pull: handle(`pull:${s.pull}`), base: s.base ? handle(`ref:${s.repository}:${s.base}`) : '', head: s.head ? handle(`ref:${s.repository}:${s.head}`) : '', section: s.section, revision: 0, visible: s.visible && !disposed, loading: s.loading, busy: s.busy, offline: !navigator.onLine, error: s.error, state: STATES.find(item => item === s.state) ?? 'unknown' as const, merge: s.merge, method: s.method, checks: s.checks, title: auth.metadata ? s.title.slice(0, 200) : '', truncated: s.files.length > 500 || controls.length > 256, files: s.files.slice(0, 500).map(file => ({ id: handle(`file:${s.pull}:${file.path}`), path: auth.metadata ? file.path.slice(0, 300) : '', additions: count(file.additions), deletions: count(file.deletions), expanded: file.expanded, loading: file.loading, error: file.error })), controls: controls.slice(0, 256).map(({ node: _node, ...item }) => item) };
    const next = JSON.stringify([value, s.title, s.files.map(file => file.path), auth.owner, auth.active, auth.pullControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotPull({ ...value, revision });
  }
  function execute(action: PullAction) {
    const node = nodes.get(action.control); if (!node?.isConnected) return;
    if (PULL_ENTRY_CONTROLS.includes(action.controlId)) {
      const captured = identity;
      confirmEntry(node, () => { const live = presentation(), current = nodes.get(action.control); if (authority().active && captured === identity && live.pull === action.pull && live.revision === action.revision && current?.isConnected) current.click(); });
      return;
    }
    node.click();
  }
  function dispatch(input: unknown) {
    const slot = createPullPresentation(presentation(), authority().owner, presentation, authority, execute, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  const actionContext = () => ({ projectId: state().project, revision: presentation().revision, selection: { kind: 'pull', ids: [handle(`pull:${state().pull}`)] } });
  const accessory = document.createElement('span'); accessory.dataset.pullAccessory = '';
  const stopActions = mountExtensionActions(accessory, 'panda.pull.actions', actionContext, notify);
  const consentButton = document.createElement('button'); consentButton.type = 'button'; consentButton.className = 'secondary-button'; consentButton.dataset.pullConsent = '';
  consentButton.addEventListener('click', () => { if (!authority().active) return; consent = !consent; refresh(); }, { signal: lifetime.signal });
  function refresh() {
    if (disposed) return; closeContext?.(); closeContext = undefined;
    // Loading/error states have no sections to move; they keep the selection without qualifying a partial host.
    applyPullPresentation(root, root.querySelector('.pull-header') ? undefined : () => {});
    const actions = root.querySelector('.pull-actions');
    if (actions && accessory.parentElement !== actions) actions.prepend(accessory);
    if (consentButton.parentElement !== root) root.append(consentButton);
    const groups = new Map<HTMLElement, [string, HTMLElement][]>();
    for (const binding of bindings()) {
      if (MERGE.includes(binding.controlId)) continue;
      const parent = binding.node.parentElement!, group = groups.get(parent) ?? [];
      group.push([`panda.pull.controls/${binding.controlId}`, binding.node]); groups.set(parent, group);
    }
    for (const [parent, group] of groups) {
      group.sort((a, b) => originalOrder.get(a[1])! - originalOrder.get(b[1])!);
      // Tabs keep the segment thumb geometry, and repeated rows keep business order.
      if (!parent.matches('.pull-tabs') && new Set(group.map(([id]) => id)).size === group.length) applyControlOrder('panda.pull.controls', group);
      applyControlVisibility(group, () => [...root.querySelectorAll<HTMLElement>('[data-pull-action]')].find(node => node.dataset.pullAction === 'refresh') ?? null);
    }
    const auth = authority(); consentButton.hidden = !auth.active;
    consentButton.textContent = `${auth.pullControl ? 'Revoke' : 'Allow'} Pull request control`;
    consentButton.setAttribute('aria-label', `${auth.pullControl ? 'Revoke' : 'Allow'} Pull request control for ${auth.owner.split('/')[0]}`);
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (!state().visible || extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const anchor = event.target.closest<HTMLElement>('button, select'); if (!anchor) return;
    const captured = presentation().revision; event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(anchor, 'panda.pull.context', actionContext(), { title: 'Pull request', items: [], onSelect() {}, notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => state().visible && presentation().revision === captured });
  }
  root.addEventListener('contextmenu', openContext, { signal: lifetime.signal }); root.addEventListener('keydown', openContext, { signal: lifetime.signal });
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return { presentation, dispatch, refresh, dispose() { disposed = true; lifetime.abort(); stopExtensions(); stopLayout(); stopActions(); closeContext?.(); window.removeEventListener('pandacode-components-change', refresh); } };
}
