/** Host-only branch/worktree bindings: chips, menus, forms and cleanup dialogs never cross the package boundary. */
import { escape, isImeKey } from '../dom';
import { createWorktreePresentation, snapshotWorktree, type WorktreeAction, type WorktreeControl, type WorktreePending, type WorktreePresentation } from './worktree';
import { applyWorktreePresentation, worktreeProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { openContextActions } from './context-actions';
import { WORKTREE_CONTROLS } from './surfaces';
export type WorktreeHostControl = { controlId: WorktreeControl; key: string; enabled: boolean };
export type WorktreeHostState = { project: string; task: string; repository: string; branchName: string; base: string; worktree: string; checkout: WorktreePresentation['checkout']; loading: boolean; running: boolean; error: boolean; detached: boolean; pending: WorktreePending; form: WorktreePresentation['form']; cleanup: WorktreePresentation['cleanup']; linked: { issue: boolean; pull: boolean }; controls: WorktreeHostControl[] };
/** Labels for the fresh host choice and the catalog; one source for both. */
export const WORKTREE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(WORKTREE_CONTROLS).flatMap(controls => controls.map(([id, label]) => [id, label])));
const CONTROLS_LOCATION = 'panda.worktree.controls';
export function mountWorktreePresentation(options: {
  state: () => WorktreeHostState | undefined;
  bar: () => HTMLElement | null;
  /** Runs the original handler; `alive` re-checks the captured identity after any host choice. */
  execute: (action: WorktreeAction, alive: () => boolean) => void;
  notify: (message: string) => void;
  rerender: () => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', consent = false, closeContext: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  function authority() {
    const provider = worktreeProvider(), bar = options.bar();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; consent = false; }
    return { owner: provider?.id ?? '', active: !disposed && Boolean(owner && provider && bar?.dataset.worktreeProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')), branchControl: consent, userChoice: true };
  }
  function presentation(): WorktreePresentation {
    const s = options.state(), auth = authority(), bar = options.bar();
    const empty: WorktreeHostState = { project: '', task: '', repository: '', branchName: '', base: '', worktree: '', checkout: 'none', loading: false, running: false, error: false, detached: false, pending: 'none', form: 'none', cleanup: 'none', linked: { issue: false, pull: false }, controls: [] };
    const live = s ?? empty, repo = `repo:${live.repository}`;
    const branch = live.checkout === 'none' ? '' : handle(`branch:${live.repository}:${live.branchName}`);
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));
    const controls = live.controls.slice(0, 64).map(control => ({ id: handle(`control:${live.task}:${control.controlId}:${control.key}:${branch}:${live.worktree}`), controlId: control.controlId, resource: handle(`resource:${live.task}:${control.key}`), enabled: control.enabled }));
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: s ? handle(`project:${live.project}`) : '', task: s ? handle(`task:${live.task}`) : '', repository: s ? handle(repo) : '', branch, base: live.base ? handle(`base:${live.repository}:${live.base}`) : '', worktree: live.worktree ? handle(`worktree:${live.worktree}`) : '', revision: 0, checkout: live.checkout, visible: Boolean(s && bar?.isConnected && [...bar.children].some(child => child.getClientRects().length) && !disposed), loading: live.loading, busy: live.pending !== 'none' || dialogOpen, running: live.running, offline: !navigator.onLine, error: live.error, detached: live.detached, branchName: auth.metadata ? live.branchName.slice(0, 120) : '', pending: live.pending, form: live.form, cleanup: live.cleanup, linked: { ...live.linked }, truncated: live.controls.length > 64, controls };
    const next = JSON.stringify([value, live.branchName, auth.owner, auth.active, auth.branchControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotWorktree({ ...value, revision });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createWorktreePresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      options.execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.task === action.task && live.branch === action.branch && live.worktree === action.worktree && live.controls.some(control => control.id === action.control && control.enabled); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility for the context-bar chips, rendered into the host markup itself. */
  function decorate(items: readonly (readonly [string, string])[]): string {
    const safe = extensionsSnapshot().safeMode, markup = new Map(items.map(([id, html]) => [`${CONTROLS_LOCATION}/${id}`, html]));
    const ids = safe ? [...markup.keys()] : orderedControls(CONTROLS_LOCATION, [...markup.keys()]);
    return ids.map(id => !safe && layout.isHidden(id, layoutProject()) ? markup.get(id)!.replace(/^<(\w+)/, '<$1 data-layout-hidden inert') : markup.get(id)!).join('');
  }
  /** The host consent row inside the original branch menu; only while a provider is active. */
  function consentItem() {
    const auth = authority(); if (!auth.active) return undefined;
    return { id: 'extension-branch-control', label: `${auth.branchControl ? 'Revoke' : 'Allow'} branch and worktree control for ${auth.owner.split('/')[0]}`, icon: auth.branchControl ? 'close' : 'check' };
  }
  function toggleConsent() { if (authority().active) { consent = !consent; options.rerender(); } }
  function refresh() {
    if (disposed) return; closeContext?.(); closeContext = undefined;
    options.rerender();
    const bar = options.bar();
    if (bar && !applyWorktreePresentation(bar)) { options.notify('Branch and worktree presentation failed. Built-in controls remain active.'); options.rerender(); }
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLElement>('#composer-context #branch-chip'); if (!anchor) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const s = options.state(); if (!s) return;
    const captured = presentation(); event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(anchor, 'panda.worktree.context', { projectId: s.project, revision: captured.revision, selection: { kind: 'task', ids: [captured.task] } }, { title: 'Branch and worktree', items: [], onSelect() {}, notify: options.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => { const live = presentation(); return live.task === captured.task && live.branch === captured.branch; } });
  }
  document.addEventListener('contextmenu', openContext); document.addEventListener('keydown', openContext);
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  return {
    presentation, dispatch, decorate, consentItem, toggleConsent, refresh,
    /** Provider attribute for the host markup: a redraw keeps the selected recipe without remounting. */
    providerAttribute: () => { const provider = worktreeProvider(); return provider ? ` data-worktree-provider="${escape(provider.id)}"` : ''; },
    dispose() { disposed = true; closeContext?.(); stopExtensions(); stopLayout(); document.removeEventListener('contextmenu', openContext); document.removeEventListener('keydown', openContext); window.removeEventListener('pandacode-components-change', refresh); },
  };
}
