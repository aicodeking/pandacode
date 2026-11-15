/** Host-only bindings for the composer's Attach menu, Workflow recipes and wake-ups: contributed rows in the Attach
 * menu and a wake-up's ⋯ menu, an action slot on the selected recipe and in "Wake this thread later", the user's order
 * and reversible visibility of their eligible entries, and captured actions that run the original handlers. Draft
 * attachments, recipe steps, deletes and schedule changes never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import { createAttachControls, snapshotAttach, ATTACH_CHOICE_CONTROLS, type AttachControl, type AttachAction, type AttachPresentation } from './composer-attach-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import type { Json } from './contracts';
import { ATTACH_FIXED, ATTACH_MENU_ENTRIES, ATTACH_MENU_LOCATION, ATTACH_PINNED, ATTACH_RECIPES_LOCATION, ATTACH_WAKE_LOCATION, ATTACH_WAKE_MENU_ENTRIES, ATTACH_WAKE_MENU_LOCATION } from './surfaces';
import type { Recipe, RecipesExtension } from '../recipes';
import type { WakeExtension, WakeMenuSurface } from '../schedules-thread';
import type { TaskSchedule } from '../schedules-api';

export type AttachHostState = { project?: string; task?: string; busy: boolean; generation: number; draft: string; attachments: readonly string[]; schedules: readonly Pick<TaskSchedule, 'id' | 'title' | 'enabled' | 'updatedAt'>[] };

const LABELS: Readonly<Partial<Record<AttachControl, string>>> = {
  'attach-file': 'Attach this file to the draft', 'recipe-run': 'Queue this recipe\'s steps as messages', 'wake-run': 'Run this wake-up now', 'wake-enable': 'Pause or resume this wake-up',
};
/** Order-sensitive digest: an edit changes the revision without the text leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };

export function mountComposerAttachAdoption(options: {
  area: HTMLElement;
  state: () => AttachHostState;
  /** The project of a task the quick add opened for (the open thread or a sidebar row). */
  projectOf: (task: string) => string | undefined;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
  /** Draws an open Workflow recipes dialog again with the current layout. */
  relayout: () => void;
}) {
  const { area } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  const mounts = new Map<HTMLElement, { key: string; dispose: () => void }>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined, recipesView: { root: HTMLElement; task: string; selected: Recipe | null } | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: string) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const shown = (element: Element) => element.getClientRects().length > 0;
  const recipeKey = (recipe: Recipe) => `${recipe.scope ?? 'project'}:${recipe.name}`;
  /** The Workflow recipes dialog, while it is open for this task (a closed dialog keeps its last draw). */
  const openRecipes = (task: string) => recipesView && recipesView.task === task && recipesView.root.isConnected && recipesView.root.closest('dialog')?.open ? recipesView : undefined;

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
    const ids = ordered.map(id => `${location}/${id}`).filter(id => !ATTACH_FIXED[id]);
    const order = (safe() ? ids : orderedControls(location, ids)).map(id => id.slice(location.length + 1));
    const hidden = new Set(safe() ? [] : hideable.filter(id => !ATTACH_PINNED[`${location}/${id}`] && layout.isHidden(`${location}/${id}`, layoutProject())));
    return { order, hidden };
  }
  /** A menu becomes an extension surface only when it has something to show: a contribution, or the user's order or
   * hidden entries. Otherwise (and in safe mode) the built-in menu opens exactly as before. */
  function customized(location: string, entries: readonly (readonly [string, string])[], project?: string) {
    if (safe()) return false;
    if (contributes(location)) return true;
    const ids = entries.map(([id]) => `${location}/${id}`).filter(id => !ATTACH_PINNED[id]);
    return ids.some(id => layout.isHidden(id, project)) || orderedControls(location, ids, project).some((id, index) => id !== ids[index]);
  }
  const captured = (kind: 'draft' | 'recipe' | 'task' | 'schedule', id: string, task: string, project: string | undefined, generation: number): Record<string, Json> => ({ ...(project ? { projectId: project } : {}), sessionId: task, revision: generation, selection: { kind, ids: [id] } });
  /** Mounts a slot's contributed actions once per captured target; a slot that left the page is disposed. */
  function ensure(host: HTMLElement, location: 'panda.composer.recipes.actions' | 'panda.composer.wake.actions', key: string, context: () => Record<string, Json>) {
    for (const [node, mounted] of mounts) if (!node.isConnected) { mounted.dispose(); mounts.delete(node); }
    const mounted = mounts.get(host);
    if (mounted?.key === key) return () => undefined;
    mounted?.dispose();
    const dispose = mountExtensionActions(host, location, context, options.notify);
    mounts.set(host, { key, dispose });
    return () => { if (mounts.get(host)?.dispose === dispose) { dispose(); mounts.delete(host); } };
  }

  /** The Attach menu as an extension surface, captured for the task and its draft at open. */
  function attachSurface(task: { projectId?: string; sessionId: string }, generation: number, isAlive: () => boolean) {
    if (disposed || !customized(ATTACH_MENU_LOCATION, ATTACH_MENU_ENTRIES, task.projectId)) return undefined;
    const draft = digest(options.state().draft);
    return { location: ATTACH_MENU_LOCATION, context: captured('draft', task.sessionId, task.sessionId, task.projectId, generation), isAlive: () => isAlive() && digest(options.state().draft) === draft, pinned: ['files'], width: 340 } as const;
  }
  /** Presentation and the paint hook for an open Workflow recipes dialog. */
  function recipesLayout(task: string): RecipesExtension | undefined {
    if (disposed) return undefined;
    return {
      ...arrangement(ATTACH_RECIPES_LOCATION, ['edit', 'run'], ['edit', 'new']), actions: contributes('panda.composer.recipes.actions'),
      painted: (root, selected) => {
        recipesView = { root, task, selected };
        const host = root.querySelector<HTMLElement>('[data-recipe-extension-actions]'), state = options.state();
        if (host && selected && contributes('panda.composer.recipes.actions')) {
          const key = recipeKey(selected), project = options.projectOf(task);
          ensure(host, 'panda.composer.recipes.actions', `${task}:${key}:${digest(JSON.stringify(selected.steps))}:${state.generation}`, () => captured('recipe', key, task, project, state.generation));
        }
      },
    };
  }
  /** Presentation and hooks for "Wake this thread later" and a wake-up's ⋯ menu. */
  function wakeLayout(): WakeExtension | undefined {
    if (disposed) return undefined;
    return {
      ...arrangement(ATTACH_WAKE_LOCATION, ['in-15', 'in-60', 'tonight', 'tomorrow'], ['in-15', 'tonight', 'tomorrow', 'more']), actions: contributes('panda.composer.wake.actions'),
      popover: (slot, task) => {
        if (!contributes('panda.composer.wake.actions')) return () => undefined;
        const generation = options.state().generation, project = options.projectOf(task);
        return ensure(slot, 'panda.composer.wake.actions', `${task}:${generation}`, () => captured('task', task, task, project, generation));
      },
      menu: (schedule, isAlive): WakeMenuSurface | undefined => {
        const project = options.projectOf(schedule.sessionId);
        if (!customized(ATTACH_WAKE_MENU_LOCATION, ATTACH_WAKE_MENU_ENTRIES, project)) return undefined;
        return { location: ATTACH_WAKE_MENU_LOCATION, context: captured('schedule', schedule.id, schedule.sessionId, project, options.state().generation) as WakeMenuSurface['context'], isAlive, pinned: ['remove'], width: 240 };
      },
    };
  }

  function presentation(): AttachPresentation {
    const state = options.state(), auth = authority(), task = state.task ?? '', composer = area.querySelector<HTMLElement>('#composer');
    finders.clear();
    const controls: { id: string; controlId: AttachControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    const add = (key: string, controlId: AttachControl, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(key, find);
      controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement | HTMLInputElement).disabled && element.getAttribute('aria-disabled') !== 'true', hidden: Boolean(element.closest('[data-layout-hidden]')) || !shown(element) });
    };
    const byAction = (selector: string, action: string, path?: string) => () => [...document.querySelectorAll<HTMLElement>(selector)].find(node => node.dataset.action === action && (path === undefined || node.dataset.path === path)) ?? null;
    let recipe = '';
    const schedules = task ? state.schedules.map(item => handle(`schedule:${task}:${item.id}`)) : [];
    if (task) {
      add(handle(`attach:${task}`), 'attach-open', handle(`draft:${task}`), byAction('#composer .composer-actions > button', 'attach'));
      // A Files row's own Attach button: the file is the resource; the draft it joins is the task's.
      for (const node of document.querySelectorAll<HTMLElement>('#inspector .file-row > button.file-attach')) {
        if (node.dataset.action !== 'attach-file' || !node.dataset.path) continue;
        const path = node.dataset.path;
        add(handle(`attach-file:${task}:${path}`), 'attach-file', handle(`file:${task}:${path}`), byAction('#inspector .file-row > button.file-attach', 'attach-file', path));
      }
      const view = openRecipes(task);
      if (view) {
        const root = view.root, within = (selector: string, action: string) => () => root.isConnected ? [...root.querySelectorAll<HTMLElement>(selector)].find(node => node.dataset.action === action) ?? null : null;
        for (const pick of root.querySelectorAll<HTMLElement>('.recipe-list .recipe-pick')) {
          const name = pick.dataset.recipe ?? '';
          add(handle(`recipe-pick:${task}:${name}`), 'recipe-pick', handle(`recipe-name:${task}:${name}`), () => root.isConnected ? [...root.querySelectorAll<HTMLElement>('.recipe-list .recipe-pick')].find(node => node.dataset.recipe === name) ?? null : null);
        }
        add(handle(`recipe-new:${task}`), 'recipe-new', handle(`recipes:${task}`), within('.recipe-list > button', 'recipe-new'));
        if (view.selected) {
          recipe = handle(`recipe:${task}:${recipeKey(view.selected)}:${digest(JSON.stringify(view.selected.steps))}`);
          add(handle(`recipe-edit:${task}`), 'recipe-edit', recipe, within('.recipe-actions > button', 'recipe-edit'));
          add(handle(`recipe-run:${task}`), 'recipe-run', recipe, within('.recipe-actions > button', 'recipe-run'));
        }
      }
      const strip = area.querySelector<HTMLElement>('#composer #wake-strip');
      if (strip && !strip.hidden) {
        const resource = handle(`wake:${task}`);
        add(handle(`wake-expand:${task}`), 'wake-expand', resource, () => area.querySelector<HTMLElement>('#composer #wake-strip .wake-line > .wake-toggle'));
        add(handle(`wake-add:${task}`), 'wake-add', resource, () => area.querySelector<HTMLElement>('#composer #wake-strip .wake-line > .wake-add'));
        for (const item of state.schedules) {
          const row = () => area.querySelector<HTMLElement>(`#composer #wake-strip .wake-row[data-id="${CSS.escape(item.id)}"] > .wake-actions`);
          const target = handle(`schedule:${task}:${item.id}:${item.updatedAt}:${item.enabled}`);
          add(handle(`wake-run:${task}:${item.id}`), 'wake-run', target, () => row()?.querySelector<HTMLElement>(':scope > [data-wake="run"]') ?? null);
          add(handle(`wake-enable:${task}:${item.id}`), 'wake-enable', target, () => row()?.querySelector<HTMLElement>(':scope > .wake-switch') ?? null);
          add(handle(`wake-more:${task}:${item.id}`), 'wake-more', target, () => row()?.querySelector<HTMLElement>(':scope > [data-wake="more"]') ?? null);
        }
      }
    }
    const dialog = document.querySelector('dialog[open]');
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      revision: 0, visible: !disposed && Boolean(composer?.isConnected && shown(composer)),
      // The Workflow recipes dialog is this adapter's own surface; any other dialog, menu or host choice holds input.
      busy: choosing || state.busy || Boolean(dialog && !dialog.querySelector('#recipes-body')) || Boolean(document.querySelector('.model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, draft: Boolean(state.draft.trim()) || state.attachments.length > 0, attachments: Math.min(state.attachments.length, 64),
      recipes: Boolean(task && openRecipes(task)), recipe, wake: Boolean(area.querySelector<HTMLElement>('#composer #wake-strip:not([hidden])')), schedules: schedules.slice(0, 64),
      controls: controls.slice(0, 128), truncated: controls.length > 128 || schedules.length > 64,
    };
    const next = JSON.stringify([value, digest(state.draft), state.attachments, state.schedules.map(item => `${item.id}:${item.updatedAt}:${item.enabled}`), recipesView?.selected ? digest(JSON.stringify(recipesView.selected)) : '', auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotAttach({ ...value, revision });
  }
  /** Runs the original handler by activating the original node; attaching a file, running a recipe and changing a
   * wake-up need a fresh host choice first, bound to the same task, target and revision. */
  function execute(action: AttachAction, alive: () => boolean) {
    const element = finders.get(action.control)?.(); if (!element) return;
    if (!ATTACH_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
    const named = element.getAttribute('aria-label');
    const detail = action.controlId === 'wake-enable' ? `${(element as HTMLInputElement).checked ? 'Pause' : 'Resume'} ${named ?? 'this wake-up'}`
      : action.controlId !== 'recipe-run' && named ? named : LABELS[action.controlId] ?? action.controlId;
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor: element, title: 'Extension requested an attach action', items: [{ id: 'continue', label: `Continue: ${detail}`, icon: action.controlId.startsWith('wake-') ? 'clock' : action.controlId === 'recipe-run' ? 'play' : 'attach' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); target?.click();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createAttachControls(presentation(), owner, presentation, authority, action => {
      const ownerIdentity = identity, task = options.state().task, draft = digest(options.state().draft);
      // The choice acts only on the same task, draft and target it was asked for.
      execute(action, () => { const live = presentation(); return authority().active && ownerIdentity === identity && options.state().task === task && digest(options.state().draft) === draft && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  function refresh() {
    if (disposed) return;
    lastProject = layoutProject(); options.relayout();
  }
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  // After main.ts holds the adoption: an open recipes dialog reads its presentation through it.
  queueMicrotask(refresh);
  return {
    presentation, dispatch, attachSurface, recipesLayout, wakeLayout,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      for (const mounted of mounts.values()) mounted.dispose();
      mounts.clear(); options.relayout();
    },
  };
}
