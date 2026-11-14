/** Host-only bindings: original nodes/controllers never cross the package boundary. */
import { isImeKey } from '../dom';
import { createGithubHubPresentation, snapshotGithubHub, type GithubHubAction, type GithubHubControl, type GithubHubRow } from './github-hub';
import { applyGithubHubPresentation, componentProviders, componentSelection } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, applyControlOrder, applyControlVisibility } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
type State = { repository: string; project: string; tab: string; visible: boolean; loading: boolean; busy: boolean; error: boolean; query: string; filter: string; filterKey: string; rows: GithubHubRow[] };
export function mountGithubHubPresentation(root: HTMLElement, state: () => State, notify: (message: string) => void, confirmEntry: (anchor: HTMLElement, proceed: () => void) => void) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), nodes = new Map<string, HTMLElement>(), applied = new Set<string>(), grants = new Set<string>();
  const lifetime = new AbortController(); let disposed = false, identity = '', revision = 0, signature = '', closeContext: (() => void) | undefined;
  const originalOrder = new WeakMap<HTMLElement, number>(); let nextOrder = 0;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  function authority() {
    const provider = componentSelection.resolve('panda.githubHub', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; grants.clear(); }
    return { owner: provider?.id ?? '', active: !disposed && Boolean(owner && provider && root.dataset.githubHubProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')), taskControl: grants.has(state().repository), userChoice: true };
  }
  function control(node: HTMLElement): GithubHubControl | undefined {
    const d = node.dataset;
    if (d.ghRepo) return 'repo'; if (d.ghTab) return 'tab'; if (d.ghOpen) return 'open'; if (d.ghTask) return 'task';
    if (d.ghPull) return 'review'; if ('ghPullMenu' in d) return 'pull-menu'; if ('ghPullRuns' in d || d.ghRunPull) return 'runs';
    if (d.ghIssue) return d.ghIssue === 'solve' ? 'solve' : 'issue-thread';
    if ('ghRunFix' in d) return 'fix'; if ('ghRunToggle' in d) return 'details'; if ('ghWorkflowCheck' in d) return 'workflow'; if ('ghRunClear' in d) return 'clear';
    if (d.ghFilter) return d.ghFilter === 'repos' ? 'repo-filter' : 'query';
    if (d.ghRunFilter) return d.ghRunFilter as 'event' | 'pull' | 'latest';
    if (node.matches('.gh-compose-send')) return 'compose';
    if (d.gh && ['refresh', 'other', 'clone'].includes(d.gh)) return d.gh as 'refresh' | 'other' | 'clone';
  }
  function bindings() {
    const s = state(), counts = new Map<string, number>(); nodes.clear();
    return [...root.querySelectorAll<HTMLElement>('button, a[data-gh-open], input[data-gh-filter], [data-gh-run-filter]')].flatMap(node => {
      const id = control(node); if (!id) return [];
      const row = node.closest<HTMLElement>('[data-gh-number], [data-gh-run]');
      const raw = node.dataset.ghRepo ? `repo:${node.dataset.ghRepo}` : node.dataset.ghTask ? `thread:${node.dataset.ghTask}` : row?.dataset.ghRun ? `run:${s.repository}:${row.dataset.ghRun}` : row?.dataset.ghNumber ? `${s.tab === 'pulls' ? 'pull' : 'issue'}:${s.repository}:${row.dataset.ghNumber}` : '';
      const resource = handle(raw), attempt = s.rows.find(item => item.id === raw)?.attempt ?? 0;
      const base = JSON.stringify([s.repository, s.tab, id, raw, node.dataset.ghTab, node.dataset.ghOpen, node.dataset.ghRunPull, node.getAttribute('aria-label')]);
      const count = counts.get(base) ?? 0; counts.set(base, count + 1);
      const key = handle(`${base}:${count}`);
      nodes.set(key, node);
      if (!originalOrder.has(node)) originalOrder.set(node, nextOrder++);
      return [{ id: key, controlId: id, resource, attempt, enabled: !(node as HTMLButtonElement).disabled && !node.hidden, node }];
    });
  }
  function presentation() {
    const s = state(), auth = authority(), controls = bindings();
    const value = { contractVersion: 1 as const, window: 'main' as const, context, repository: handle(`repo:${s.repository}`), project: handle(s.project), tab: s.tab, revision: 0, visible: s.visible && !disposed, loading: s.loading, busy: s.busy, offline: !navigator.onLine, error: s.error, query: auth.metadata ? s.query.slice(0, 200) : '', filter: auth.metadata ? s.filter.slice(0, 200) : '', truncated: s.rows.length > 500 || controls.length > 256, rows: s.rows.slice(0, 500).map(row => ({ ...row, id: handle(row.id), title: auth.metadata ? row.title.slice(0, 200) : '' })), controls: controls.slice(0, 256).map(({ node: _node, ...control }) => control) };
    const next = JSON.stringify([value, s.query, s.filterKey, auth.owner, auth.active, auth.taskControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotGithubHub({ ...value, revision });
  }
  function execute(action: GithubHubAction) {
    const node = nodes.get(action.control); if (!node?.isConnected) return;
    if (['clone', 'open'].includes(action.controlId)) {
      const capturedIdentity = identity;
      confirmEntry(node, () => { const live = presentation(); if (authority().active && capturedIdentity === identity && live.repository === action.repository && live.revision === action.revision && node.isConnected) node.click(); });
      return;
    }
    if (['query', 'repo-filter'].includes(action.controlId)) { (node as HTMLInputElement).value = action.value; node.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (['event', 'pull', 'latest'].includes(action.controlId)) {
      if (action.controlId === 'latest') { if (!['true', 'false'].includes(action.value)) return; (node as HTMLInputElement).checked = action.value === 'true'; }
      else { const field = node as HTMLSelectElement; if (![...field.options].some(option => option.value === action.value)) return; field.value = action.value; }
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else node.click();
  }
  function dispatch(input: unknown) {
    const auth = authority(), slot = createGithubHubPresentation(presentation(), auth.owner, presentation, authority, execute, applied, action => {
      const node = nodes.get(action.control);
      return !['event', 'pull'].includes(action.controlId) || node instanceof HTMLSelectElement && [...node.options].some(option => option.value === action.value);
    });
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  const actionContext = () => ({ projectId: state().project, revision: presentation().revision, selection: { kind: 'github-hub', ids: [handle(`repo:${state().repository}`)] } });
  const accessory = document.createElement('span'); accessory.dataset.githubHubAccessory = ''; root.querySelector('.gh-repos-head')!.append(accessory);
  const stopActions = mountExtensionActions(accessory, 'panda.githubHub.actions', actionContext, notify);
  const consent = document.createElement('button'); consent.type = 'button'; consent.className = 'secondary-button'; consent.dataset.githubHubConsent = ''; root.querySelector('.gh-repos')!.append(consent);
  consent.addEventListener('click', () => { if (!authority().active) return; const key = state().repository; if (grants.has(key)) grants.delete(key); else grants.add(key); refresh(); }, { signal: lifetime.signal });
  function refresh() {
    if (disposed) return; closeContext?.(); closeContext = undefined;
    applyGithubHubPresentation(root);
    const groups = new Map<HTMLElement, [string, HTMLElement][]>();
    for (const binding of bindings()) { const parent = binding.node.parentElement!; const group = groups.get(parent) ?? []; group.push([`panda.githubHub.controls/${binding.controlId}`, binding.node]); groups.set(parent, group); }
    for (const group of groups.values()) {
      group.sort((a, b) => originalOrder.get(a[1])! - originalOrder.get(b[1])!);
      // Repeated row/tab members keep business ordering; only unique sibling controls are compatible.
      if (new Set(group.map(([id]) => id)).size === group.length) applyControlOrder('panda.githubHub.controls', group);
      applyControlVisibility(group, () => root.querySelector('[data-gh="refresh"]'));
    }
    const auth = authority(); consent.hidden = !auth.active; consent.textContent = `${auth.taskControl ? 'Revoke' : 'Allow'} GitHub task control`; consent.setAttribute('aria-label', `${auth.taskControl ? 'Revoke' : 'Allow'} GitHub task control for ${auth.owner.split('/')[0]}`);
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (!state().visible || extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const anchor = event.target.closest<HTMLElement>('button, input, select'); if (!anchor) return;
    const captured = presentation().revision; event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(anchor, 'panda.githubHub.context', actionContext(), { title: 'GitHub', items: [], onSelect() {}, notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => state().visible && presentation().revision === captured });
  }
  root.addEventListener('contextmenu', openContext, { signal: lifetime.signal }); root.addEventListener('keydown', openContext, { signal: lifetime.signal });
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return { presentation, dispatch, refresh, dispose() { disposed = true; lifetime.abort(); stopExtensions(); stopLayout(); stopActions(); closeContext?.(); window.removeEventListener('pandacode-components-change', refresh); } };
}
