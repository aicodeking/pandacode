/** Host-only composer controls bindings: the tray's tools, the model picker's rail and action row, the Permissions
 * menu's contributed rows and the steer bar. The draft, the selected model, the approval mode, Send, Stop and approvals
 * never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import { createComposerControls, snapshotComposer, COMPOSER_ENTRY_CONTROLS, type ComposerAction, type ComposerControl, type ComposerMode, type ComposerPresentation } from './composer-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import type { Json } from './contracts';
import { COMPOSER_MODEL_ENTRIES, COMPOSER_MODEL_LOCATION, COMPOSER_PERMISSION_MODES, COMPOSER_PERMISSIONS_LOCATION, COMPOSER_STEER_LOCATION, COMPOSER_STEER_PARTS, COMPOSER_STEER_PINNED, COMPOSER_TRAY_CONTROLS, COMPOSER_TRAY_FIXED, COMPOSER_TRAY_LOCATION, COMPOSER_TRAY_PINNED } from './surfaces';

export type ComposerHostState = { project?: string; task?: string; running: boolean; mode: ComposerMode; busy: boolean; generation: number };

/** The original node of each control (references inside the composer, not new actions). */
const NODES: Readonly<Record<ComposerControl, string>> = {
  model: '.composer-tools > .model-picker', mode: '.composer-tools > .mode-picker', team: '.composer-tools > .composer-team-button',
  saver: '.composer-tools > .composer-saver-button', council: '.composer-tools > .composer-council-button', 'run-target': '.composer-tray .composer-computer',
  'steer-edit': '.composer-steer-bar > .composer-steer-edit', steer: '.composer-steer-bar > .steer-button', 'steer-clear': '.composer-steer-bar > .composer-steer-clear',
};
const LABELS: Readonly<Partial<Record<ComposerControl, string>>> = { steer: 'Steer the running turn', 'steer-clear': 'Clear the draft' };
const STEER_PARTS: readonly ComposerControl[] = ['steer-edit', 'steer', 'steer-clear'];
const MODEL_ENTRY_IDS = new Set(COMPOSER_MODEL_ENTRIES.map(([id]) => id));
/** Order-sensitive digest of the draft: an edit changes the revision without the text leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };

export function mountComposerAdoption(options: {
  area: HTMLElement;
  state: () => ComposerHostState;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
}) {
  const { area } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, steerMount: { host: HTMLElement; dispose: () => void } | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const node = (id: ComposerControl) => area.querySelector<HTMLElement>(`#composer ${NODES[id]}`);
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: string) => !extensionsSnapshot().safeMode && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (element: Element) => element.getClientRects().length > 0;
  const prompt = () => area.querySelector<HTMLTextAreaElement>('#prompt');

  function authority() {
    const provider = componentSelection.resolve('panda.composer', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const composer = area.querySelector<HTMLElement>('#composer');
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && composer?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  function presentation(): ComposerPresentation {
    const state = options.state(), auth = authority(), composer = area.querySelector<HTMLElement>('#composer'), draft = prompt()?.value ?? '';
    finders.clear();
    const controls: { id: string; controlId: ComposerControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    for (const [id] of [...COMPOSER_TRAY_CONTROLS, ...COMPOSER_STEER_PARTS] as const) {
      const element = node(id); if (!element) continue;
      const key = handle(`control:${state.task ?? ''}:${id}`); finders.set(key, () => node(id));
      controls.push({ id: key, controlId: id, resource: STEER_PARTS.includes(id) && state.task ? handle(`draft:${state.task}`) : '', enabled: !(element as HTMLButtonElement).disabled && !element.hidden && element.matches('button'), hidden: Boolean(element.closest('[data-layout-hidden]')) || !shown(element) });
    }
    const steering = Boolean(area.querySelector('#composer .composer-steer-bar > .steer-button'));
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: state.task ? handle(`task:${state.task}`) : '',
      revision: 0, visible: !disposed && Boolean(composer?.isConnected && shown(composer)),
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open], .model-menu, .floating-menu')),
      safeMode: extensionsSnapshot().safeMode, running: state.running, steering, draft: Boolean(draft.trim()), mode: state.mode,
      controls: controls.slice(0, 64), truncated: controls.length > 64,
    };
    const next = JSON.stringify([value, digest(draft), auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotComposer({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; Steer and Clear need a fresh host choice first. */
  function execute(action: ComposerAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!COMPOSER_ENTRY_CONTROLS.includes(action.controlId)) { element.click(); return; }
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: element, title: 'Extension requested a composer action', items: [{ id: 'continue', label: `Continue: ${LABELS[action.controlId] ?? action.controlId}`, icon: action.controlId === 'steer' ? 'arrow' : 'close' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createComposerControls(presentation(), owner, presentation, authority, action => {
      const captured = identity, task = options.state().task, draft = digest(prompt()?.value ?? '');
      // The choice acts only on the same task and the same draft it was asked for.
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && options.state().task === task && digest(prompt()?.value ?? '') === draft && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility on the original tray tools and steer bar parts: nodes, listeners, the draft and
   * focus stay. Pinned controls never hide, even through a forged overlay; safe mode is built-in. */
  function apply() {
    if (disposed && !area.isConnected) return;
    mountSteer();
    const off = safe();
    for (const [location, ids, pinned] of [[COMPOSER_TRAY_LOCATION, COMPOSER_TRAY_CONTROLS.map(([id]) => id), COMPOSER_TRAY_PINNED], [COMPOSER_STEER_LOCATION, COMPOSER_STEER_PARTS.map(([id]) => id), COMPOSER_STEER_PINNED]] as const) {
      const bindings = (ids as readonly ComposerControl[]).map(id => [`${location}/${id}`, node(id)] as const);
      applyControlOrder(location, bindings.filter(([id]) => !Object.hasOwn(COMPOSER_TRAY_FIXED, id.slice(location.length + 1))), off);
      const hideable = bindings.filter(([id]) => !(pinned as Readonly<Record<string, string | undefined>>)[id.slice(location.length + 1)]);
      if (off) { for (const [, element] of bindings) if (element?.hasAttribute('data-layout-hidden')) { element.removeAttribute('data-layout-hidden'); element.inert = false; } continue; }
      for (const [id, element] of bindings) if (element && !hideable.some(([other]) => other === id) && element.hasAttribute('data-layout-hidden')) { element.removeAttribute('data-layout-hidden'); element.inert = false; }
      applyControlVisibility(hideable, () => prompt() ?? null);
    }
  }
  /** The steer bar's contributed actions, captured for the task and its draft (never the text) at this draw. */
  function mountSteer() {
    const host = area.querySelector<HTMLElement>('#composer .composer-steer-bar > [data-composer-steer-actions]');
    if (steerMount && (steerMount.host !== host || !host?.isConnected || safe() || !contributes('panda.composer.steering.actions'))) { steerMount.dispose(); steerMount = undefined; }
    if (!host || steerMount || safe() || !contributes('panda.composer.steering.actions')) return;
    const { project, task, generation } = options.state(); if (!task) return;
    steerMount = { host, dispose: mountExtensionActions(host, 'panda.composer.steering.actions', () => captured('draft', task, { projectId: project, sessionId: task }, generation), options.notify) };
  }
  /** The model picker's rail: built-in harnesses, Recent and Teams follow the user's order in their own slots, hidden
   * ones leave the rail. The task's harness and a selected team always show; package harnesses keep their entry. */
  function modelEntries(keys: readonly string[], current: { provider: string; team: boolean }) {
    const known = keys.filter(key => MODEL_ENTRY_IDS.has(key)), ids = known.map(key => `${COMPOSER_MODEL_LOCATION}/${key}`);
    const ordered = (safe() ? ids : orderedControls(COMPOSER_MODEL_LOCATION, ids)).map(id => id.slice(COMPOSER_MODEL_LOCATION.length + 1));
    const order = keys.map(key => MODEL_ENTRY_IDS.has(key) ? ordered.shift()! : key);
    const hidden = new Set(safe() ? [] : known.filter(key => key !== current.provider && !(key === 'teams' && current.team) && layout.isHidden(`${COMPOSER_MODEL_LOCATION}/${key}`, layoutProject())));
    return { order, hidden };
  }
  /** Captured context for the model picker's action row, the Permissions menu and the steer bar slot. */
  const captured = (kind: 'draft' | 'model' | 'approval-mode', id: string, task: { projectId?: string; sessionId: string }, generation: number): Record<string, Json> => ({ ...(task.projectId ? { projectId: task.projectId } : {}), sessionId: task.sessionId, revision: generation, selection: { kind, ids: [id] } });
  /** Mounts the model picker's contributed action row; nothing when no enabled package contributes there. */
  function modelActions(host: HTMLElement, task: { projectId?: string; sessionId: string }, model: string, generation: number) {
    if (disposed || !contributes('panda.composer.model.actions')) return undefined;
    return mountExtensionActions(host, 'panda.composer.model.actions', () => captured('model', model, task, generation), options.notify);
  }
  /** The Permissions menu's extension surface: every approval mode pinned, contributed rows after them. Undefined
   * with nothing contributed, so the zero-extension menu keeps its radio rows. */
  function permissionsSurface(task: { projectId?: string; sessionId: string }, mode: string, generation: number, isAlive: () => boolean) {
    if (disposed || !contributes(COMPOSER_PERMISSIONS_LOCATION)) return undefined;
    return { location: COMPOSER_PERMISSIONS_LOCATION, context: captured('approval-mode', mode, task, generation), isAlive, pinned: COMPOSER_PERMISSION_MODES.map(([id]) => id), width: 320 } as const;
  }
  function refresh() {
    if (disposed) return;
    lastProject = layoutProject(); apply();
  }
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, apply, modelEntries, modelActions, permissionsSurface,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); steerMount?.dispose(); steerMount = undefined; stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      apply();
    },
  };
}
