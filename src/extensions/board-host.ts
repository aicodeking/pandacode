/** Host-only adapter. None of these nodes/callbacks cross the package boundary. */
import type { Session } from '../types';
import { taskStage, stageNames } from '../task-board';
import { isImeKey } from '../dom';
import { createBoardPresentation, snapshotBoard, type BoardAction, type BoardPresentation } from './board';
import { componentProviders, componentSelection, applyBoardPresentation } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, applyControlOrder, applyControlVisibility } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
import { BOARD_CONTROLS } from './surfaces';

export type BoardHost = {
  state(): { project: string; task: string; filter: string; visible: boolean; detail: boolean; loading: boolean; importable: boolean; tasks: Session[] };
  running(id: string): boolean;
  busy(id: string): boolean;
  execute(control: BoardAction['controlId'], task: string): Promise<void> | void;
  notify(message: string): void;
};
export function mountBoardPresentation(root: HTMLElement, details: HTMLElement, host: BoardHost) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), versions = new Map<string, { signature: string; revision: number }>();
  const applied = new Set<string>(), grants = new Set<string>(), accessories = new Map<HTMLElement, () => void>();
  const lifetime = new AbortController(); let disposed = false, pending = false, revision = 0, signature = '', activation = 0, activationIdentity = '', closeContext: (() => void) | undefined;
  const handle = (id: string) => { if (!id) return ''; if (!handles.has(id)) handles.set(id, crypto.randomUUID()); return handles.get(id)!; };
  function authority() {
    const provider = componentSelection.resolve('panda.board', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== activationIdentity) { activationIdentity = identity; activation++; grants.clear(); }
    const key = `${activation}:${host.state().project}`;
    return { owner: provider?.id ?? '', active: !disposed && Boolean(owner && provider && root.dataset.boardProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')), taskControl: grants.has(key), key };
  }
  function presentation(): BoardPresentation {
    const state = host.state(), auth = authority();
    const rows = state.tasks.filter(task => !state.filter || task.projectId === state.filter).slice(0, 500).map(task => {
      const value = JSON.stringify([task.updatedAt, task.title, task.taskDescription, taskStage(task), task.archived, host.running(task.id), host.busy(task.id)]);
      const previous = versions.get(task.id);
      if (previous?.signature !== value) versions.set(task.id, { signature: value, revision: (previous?.revision ?? 0) + 1 });
      return { id: handle(`task:${task.id}`), project: handle(`project:${task.projectId}`), revision: versions.get(task.id)!.revision, stage: taskStage(task), title: auth.metadata ? task.title.slice(0, 200) : '', running: host.running(task.id), busy: host.busy(task.id), archived: task.archived };
    });
    const next = { contractVersion: 1 as const, window: 'main' as const, context, project: handle(`project:${state.project}`), task: state.task ? handle(`task:${state.task}`) : '', filter: state.filter ? handle(`project:${state.filter}`) : '', revision: 0, visible: state.visible && !disposed, loading: state.loading, busy: pending, detail: state.detail, importable: state.importable, truncated: state.tasks.filter(task => !state.filter || task.projectId === state.filter).length > 500, rows };
    const key = JSON.stringify([next, auth.owner, auth.active, auth.granted, auth.taskControl, auth.key]);
    if (key !== signature) { signature = key; revision++; }
    return snapshotBoard({ ...next, revision });
  }
  function dispatch(input: unknown) {
    const auth = authority();
    const slot = createBoardPresentation(presentation(), auth.owner, presentation, authority, execute, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  function execute(action: BoardAction): void {
    const task = host.state().tasks.find(task => handle(`task:${task.id}`) === action.row)?.id ?? '';
    pending = true;
    try {
      const operation = host.execute(action.controlId, task);
      Promise.resolve(operation).catch(error => host.notify(error instanceof Error ? error.message : String(error))).finally(() => { pending = false; refresh(); });
    } catch (error) { pending = false; host.notify(error instanceof Error ? error.message : String(error)); refresh(); }
  }
  function actionContext(task = '') { const state = host.state(); return { projectId: state.project, sessionId: task || state.task, revision: presentation().revision, selection: { kind: 'board', ids: task ? [handle(`task:${task}`)] : [] } }; }
  function accessory(parent: HTMLElement, location: 'panda.board.header' | 'panda.board.card' | 'panda.board.detail', task = '') {
    let node = parent.querySelector<HTMLElement>(':scope > [data-board-accessory]');
    if (!node) { node = document.createElement('span'); node.dataset.boardAccessory = ''; parent.append(node); }
    if (!accessories.has(node)) accessories.set(node, mountExtensionActions(node, location, () => actionContext(task), host.notify));
  }
  const controls: Record<string, string> = { 'add-project': 'open-project', 'filter-projects': 'filter', 'board-import': 'import', 'board-add': 'add', 'board-open': 'open', 'board-close': 'close', 'board-edit': 'edit', 'board-complete': 'settle', 'board-reopen': 'reopen' };
  function refresh(): void {
    if (disposed || !root.querySelector('.board-columns')) return;
    closeContext?.(); closeContext = undefined;
    applyBoardPresentation(root);
    for (const [node, dispose] of accessories) if (!node.isConnected) { dispose(); accessories.delete(node); }
    const groups = new Map<string, [string, HTMLElement][]>();
    const bind = (location: string, id: string, node: HTMLElement) => { const bindings = groups.get(location) ?? []; bindings.push([`${location}/${id}`, node]); groups.set(location, bindings); };
    for (const node of [...root.querySelectorAll<HTMLElement>('[data-action]'), ...details.querySelectorAll<HTMLElement>('[data-action]')]) {
      const inDetail = details.contains(node), card = node.closest<HTMLElement>('[data-task-id]');
      let id = controls[node.dataset.action ?? ''];
      if (node.dataset.action === 'board-start') { const task = host.state().tasks.find(task => task.id === (node.dataset.id ?? host.state().task)); id = task && taskStage(task) === 'in_progress' ? 'retry' : 'start'; }
      if (id) bind(inDetail ? 'panda.board.detail' : card ? 'panda.board.cards' : 'panda.board.header', id, node);
    }
    for (const stage of Object.keys(stageNames)) { const column = root.querySelector<HTMLElement>(`.board-column[data-stage="${stage}"]`); if (column) bind('panda.board.columns', stage.replace('_', '-'), column); }
    for (const [location, bindings] of groups) {
      const ids = BOARD_CONTROLS[location as keyof typeof BOARD_CONTROLS].map(([id]) => `${location}/${id}`);
      bindings.sort(([a], [b]) => ids.indexOf(a) - ids.indexOf(b));
      applyControlOrder(location, bindings); applyControlVisibility(bindings, () => document.querySelector('#view-menu'));
    }
    const header = root.querySelector<HTMLElement>('.board-heading-actions'); if (header) accessory(header, 'panda.board.header');
    root.querySelectorAll<HTMLElement>('[data-task-id]').forEach(card => accessory(card, 'panda.board.card', card.dataset.taskId));
    const toolbar = details.querySelector<HTMLElement>('.task-detail-actions'); if (toolbar) accessory(toolbar, 'panda.board.detail');
    const auth = authority();
    let consent = root.querySelector<HTMLButtonElement>('[data-board-consent]');
    if (!consent && header) { consent = document.createElement('button'); consent.type = 'button'; consent.className = 'secondary-button'; consent.dataset.boardConsent = ''; header.append(consent); consent.addEventListener('click', () => { const auth = authority(); if (!auth.active) return; if (grants.has(auth.key)) grants.delete(auth.key); else grants.add(auth.key); refresh(); }, { signal: lifetime.signal }); }
    if (consent) {
      consent.hidden = !auth.active;
      consent.textContent = `${auth.taskControl ? 'Revoke' : 'Allow'} task control`;
      consent.setAttribute('aria-label', `${auth.taskControl ? 'Revoke' : 'Allow'} Board task control for ${auth.owner.split('/')[0]}`);
    }
    presentation();
  }
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (!host.state().visible || extensionsSnapshot().safeMode) return;
    const anchor = (event.target as Element).closest<HTMLElement>('button'); if (!anchor) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const task = anchor.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? '';
    const captured = presentation().revision;
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    closeContext = openContextActions(anchor, 'panda.board.context', actionContext(task), { title: 'Board', items: [], onSelect() {}, notify: host.notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}), isAlive: () => host.state().visible && presentation().revision === captured });
  }
  for (const node of [root, details]) { node.addEventListener('contextmenu', openContext, { signal: lifetime.signal }); node.addEventListener('keydown', openContext, { signal: lifetime.signal }); }
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  window.addEventListener('pandacode-components-change', refresh);
  return { presentation, dispatch, refresh, dispose() { disposed = true; lifetime.abort(); stopExtensions(); stopLayout(); closeContext?.(); accessories.forEach(dispose => dispose()); accessories.clear(); window.removeEventListener('pandacode-components-change', refresh); } };
}
