/** Host-only bindings for the composer's queue, token saver and council panels: the user's order and reversible
 * visibility of their eligible controls, an action slot in each queue row, the open token saver panel and the council
 * strip, and captured actions that run the original handlers. Queued text, queue order and delivery, token saver packs
 * and the council's team decisions never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import { createPanelControls, snapshotPanels, PANEL_CHOICE_CONTROLS, type PanelControl, type PanelsAction, type PanelsPresentation } from './composer-panels-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import type { Json } from './contracts';
import { PANEL_COUNCIL_LOCATION, PANEL_FIXED, PANEL_PINNED, PANEL_QUEUE_LOCATION, PANEL_SAVER_LOCATION, type ActionLocation } from './surfaces';
import type { QueueExtension, QueuedMessage } from '../message-queue';
import type { TokenSaverExtension } from '../token-saver-panel';
import type { CouncilExtension } from '../council-panel';

export type PanelsHostState = { project?: string; task?: string; running: boolean; held: boolean; busy: boolean; generation: number; queue: readonly QueuedMessage[]; councilSince?: number };

const LABELS: Readonly<Partial<Record<PanelControl, string>>> = {
  'queue-steer': 'Steer this queued message into the running turn', 'queue-send-now': 'Send this queued message now', 'queue-resume': 'Resume the held queue',
  'saver-tighten': 'Tighten the token saver', 'saver-default': 'Change how new threads start the token saver', 'saver-off': 'Turn every token saver pack off',
};
/** Queue entry controls by their markup id (`data-queue-control`). */
const QUEUE_ENTRY: readonly (readonly [string, PanelControl])[] = [['steer', 'queue-steer'], ['send-now', 'queue-send-now'], ['edit', 'queue-edit']];
/** Order-sensitive digest of the queue (ids, positions and edits): a change bumps the revision without the text. */
const digest = (entries: readonly QueuedMessage[]) => entries.map(entry => `${entry.id}:${entry.position}:${entry.updatedAt}`).join('|');

export function mountComposerPanelsAdoption(options: {
  area: HTMLElement;
  state: () => PanelsHostState;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
  /** Draws the queue, the council strip and an open token saver panel again with the current layout. */
  relayout: () => void;
}) {
  const { area } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  const mounts = new Map<HTMLElement, { key: string; dispose: () => void }>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, saverPanel: { panel: HTMLElement; sessionId: string } | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: string) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (element: Element) => element.getClientRects().length > 0;

  function authority() {
    const provider = componentSelection.resolve('panda.composer', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const composer = area.querySelector<HTMLElement>('#composer');
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && composer?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }

  /** The user's order of a location's orderable controls and its hidden ones; built-in in safe mode. Pinned controls
   * never hide and fixed ones never reorder, even through a forged overlay. */
  function arrangement(location: string, ordered: readonly string[], hideable: readonly string[]) {
    const ids = ordered.map(id => `${location}/${id}`).filter(id => !PANEL_FIXED[id]);
    const order = (safe() ? ids : orderedControls(location, ids)).map(id => id.slice(location.length + 1));
    const hidden = new Set(safe() ? [] : hideable.filter(id => !PANEL_PINNED[`${location}/${id}`] && layout.isHidden(`${location}/${id}`, layoutProject())));
    return { order, hidden };
  }
  /** Mounts a slot's contributed actions once per captured target; a new target (another entry edit, cycle or task)
   * remounts, a slot that left the page or lost its contributions is disposed. */
  function ensure(host: HTMLElement | null, location: ActionLocation, key: string, captured: () => Record<string, Json>) {
    if (!host) return;
    const mounted = mounts.get(host);
    if (mounted?.key === key) return;
    mounted?.dispose();
    mounts.set(host, { key, dispose: mountExtensionActions(host, location, captured, options.notify) });
  }
  function sweep() {
    for (const [host, mounted] of mounts) {
      const location = host.matches('[data-queue-extension-actions]') ? 'panda.composer.queue.actions' : host.matches('[data-saver-extension-actions]') ? 'panda.composer.saver.actions' : 'panda.composer.council.actions';
      if (!host.isConnected || !contributes(location)) { mounted.dispose(); mounts.delete(host); }
    }
  }
  const captured = (kind: 'queue-entry' | 'token-saver' | 'council-cycle', id: string, state: PanelsHostState, task: string): Record<string, Json> => ({ ...(state.project ? { projectId: state.project } : {}), sessionId: task, revision: state.generation, selection: { kind, ids: [id] } });

  /** Queue rows and the council strip drawn by the composer: mounts their slots (main.ts calls this after each draw). */
  function apply() {
    sweep();
    if (safe()) return;
    const state = options.state(), task = state.task; if (!task) return;
    if (contributes('panda.composer.queue.actions')) for (const entry of state.queue) {
      const host = area.querySelector<HTMLElement>(`#composer .queue-list > .queue-row[data-queue-id="${CSS.escape(entry.id)}"] [data-queue-extension-actions]`);
      ensure(host, 'panda.composer.queue.actions', `${task}:${entry.id}:${entry.updatedAt}:${state.generation}`, () => captured('queue-entry', entry.id, state, task));
    }
    const strip = area.querySelector<HTMLElement>(`#composer .council-strip[data-session-id="${CSS.escape(task)}"] [data-council-extension-actions]`);
    if (strip && contributes('panda.composer.council.actions')) {
      const cycle = `${task}:${state.councilSince ?? 0}`;
      ensure(strip, 'panda.composer.council.actions', `${cycle}:${state.generation}`, () => captured('council-cycle', cycle, state, task));
    }
  }

  function presentation(): PanelsPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '', composer = area.querySelector<HTMLElement>('#composer');
    finders.clear();
    const controls: { id: string; controlId: PanelControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    const add = (key: string, controlId: PanelControl, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(key, find);
      controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement | HTMLInputElement).disabled && element.getAttribute('aria-disabled') !== 'true', hidden: Boolean(element.closest('[data-layout-hidden]')) || !shown(element) });
    };
    const entries = task ? state.queue.map(entry => handle(`entry:${task}:${entry.id}:${entry.updatedAt}`)) : [];
    if (task) {
      for (const [index, entry] of state.queue.entries()) for (const [markup, controlId] of QUEUE_ENTRY) {
        add(handle(`queue:${task}:${entry.id}:${markup}`), controlId, entries[index], () => area.querySelector<HTMLElement>(`#composer .queue-list > .queue-row[data-queue-id="${CSS.escape(entry.id)}"] > .queue-actions > [data-queue-control="${markup}"]`));
      }
      add(handle(`queue:${task}:resume`), 'queue-resume', handle(`queue:${task}`), () => area.querySelector<HTMLElement>('#composer .queue-panel .queue-heading > [data-queue-control="resume"]'));
    }
    const saver = Boolean(task && saverPanel?.sessionId === task && saverPanel.panel.isConnected);
    if (saver) {
      const panel = saverPanel!.panel, resource = handle(`saver:${task}`);
      add(handle(`saver:${task}:tighten`), 'saver-tighten', resource, () => panel.isConnected ? panel.querySelector<HTMLElement>('.saver-hint > .saver-tighten') : null);
      add(handle(`saver:${task}:default`), 'saver-default', resource, () => panel.isConnected ? panel.querySelector<HTMLElement>('.saver-foot > .saver-default > input') : null);
      add(handle(`saver:${task}:off`), 'saver-off', resource, () => panel.isConnected ? panel.querySelector<HTMLElement>('.saver-foot > .saver-off') : null);
    }
    const strip = task ? area.querySelector<HTMLElement>(`#composer .council-strip[data-session-id="${CSS.escape(task)}"]`) : null;
    const cycle = strip && !strip.dataset.leaving ? handle(`cycle:${task}:${state.councilSince ?? 0}`) : '';
    if (cycle) {
      const within = (selector: string) => () => area.querySelector<HTMLElement>(`#composer .council-strip[data-session-id="${CSS.escape(task)}"] ${selector}`);
      add(handle(`council:${task}:toggle`), 'council-strip-toggle', cycle, within('.council-strip-head > .council-strip-toggle'));
      for (const row of strip!.querySelectorAll<HTMLElement>('.council-rows > .council-row')) {
        const seat = row.dataset.id ?? '';
        add(handle(`council:${task}:row:${seat}`), 'council-open-worker', cycle, within(`.council-rows > .council-row[data-id="${CSS.escape(seat)}"]`));
      }
      add(handle(`council:${task}:lower`), 'council-lower-target', cycle, within('.council-strip-actions > [data-council-focus="target"]'));
      add(handle(`council:${task}:raise`), 'council-raise-rounds', cycle, within('.council-strip-actions > [data-council-focus="maxRounds"]'));
    }
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      revision: 0, visible: !disposed && Boolean(composer?.isConnected && shown(composer)),
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, running: state.running, held: state.held, entries: entries.slice(0, 64), saver, council: Boolean(cycle), cycle,
      controls: controls.slice(0, 128), truncated: controls.length > 128 || entries.length > 64,
    };
    const next = JSON.stringify([value, digest(state.queue), auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotPanels({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; sending, resuming and saver changes need a fresh host
   * choice first, bound to the same task, target and revision. */
  function execute(action: PanelsAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!PANEL_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
    const detail = action.controlId === 'queue-send-now' && element.title ? element.title : LABELS[action.controlId] ?? action.controlId;
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: element, title: 'Extension requested a composer panel action', items: [{ id: 'continue', label: `Continue: ${detail}`, icon: action.controlId.startsWith('queue-') ? 'arrow' : 'leaf' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createPanelControls(presentation(), owner, presentation, authority, action => {
      const ownerIdentity = identity, task = options.state().task;
      // The choice acts only on the same task and the same entry, saver or cycle it was asked for.
      execute(action, () => { const live = presentation(); return authority().active && ownerIdentity === identity && options.state().task === task && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  /** Presentation for the main queue (`queuePanel`'s `extension`). */
  function queueLayout(): QueueExtension | undefined {
    if (disposed) return undefined;
    return { ...arrangement(PANEL_QUEUE_LOCATION, ['steer', 'send-now', 'edit'], ['steer', 'send-now', 'edit', 'resume']), actions: contributes('panda.composer.queue.actions') };
  }
  /** Presentation and hooks for the open token saver panel. */
  function saverLayout(sessionId: string): TokenSaverExtension | undefined {
    if (disposed) return undefined;
    return {
      ...arrangement(PANEL_SAVER_LOCATION, ['default', 'off'], ['tighten', 'default', 'off']), actions: contributes('panda.composer.saver.actions'),
      painted: (panel, painted) => {
        saverPanel = { panel, sessionId: painted }; sweep();
        const host = panel.querySelector<HTMLElement>('[data-saver-extension-actions]'), state = options.state();
        if (host && contributes('panda.composer.saver.actions')) ensure(host, 'panda.composer.saver.actions', `${painted}:${state.generation}`, () => captured('token-saver', painted, state, painted));
      },
      closed: () => { saverPanel = undefined; for (const [host, mounted] of mounts) if (host.matches('[data-saver-extension-actions]')) { mounted.dispose(); mounts.delete(host); } },
    };
  }
  /** Presentation and the paint hook for the council strip and panel. */
  function councilLayout(): CouncilExtension | undefined {
    if (disposed) return undefined;
    return { ...arrangement(PANEL_COUNCIL_LOCATION, ['target', 'max-rounds', 'reviewers'], ['strip-toggle', 'open-worker', 'max-rounds', 'reviewers']), actions: contributes('panda.composer.council.actions'), painted: apply };
  }
  function refresh() {
    if (disposed) return;
    lastProject = layoutProject(); options.relayout(); apply();
  }
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  // After main.ts holds the adoption: the panels it draws read their presentation through it.
  queueMicrotask(refresh);
  return {
    presentation, dispatch, apply, queueLayout, saverLayout, councilLayout,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      for (const mounted of mounts.values()) mounted.dispose();
      mounts.clear(); options.relayout();
    },
  };
}
