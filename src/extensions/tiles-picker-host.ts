/** Host-only bindings for thread tiles and the draft project picker: the user's order and reversible visibility of a
 * tile bar's controls and the picker's entries, host markers for each tile's action slot (mounted by thread-actions.ts
 * with that tile's own thread), the picker footer's contributed actions with the captured draft, and captured actions
 * that run the original handlers. Tile layout, mirrors' rows, drafts and moving a draft never cross the package
 * boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Project } from '../types';
import type { TileExtension, TileParts } from '../thread-tiles';
import type { ProjectPickerExtension } from '../project-picker';
import { createPickerControls, createTilesControls, snapshotPicker, snapshotTiles, TILES_PICKER_CHOICE_CONTROLS, type PickerAction, type PickerControl, type PickerPresentation, type TilesAction, type TilesControl, type TilesPickerAuthority, type TilesPresentation } from './tiles-picker-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { tileSlot } from './thread-slots';
import { PICKER_ENTRIES, PICKER_LOCATION, TILES_CONTROLS, TILES_LOCATION, TILES_PICKER_FIXED, TILES_PICKER_PINNED, type TilesPickerActionLocation } from './surfaces';

/** `task` is the draft the picker would move (set only while the new-task page shows it); `project` its current project
 * (the no-project id for a chat). The draft text never leaves this module: only its digest enters the revision. */
export type PickerHostState = { task?: string; project?: string; projectId?: string; draft: string; pending: boolean; busy: boolean; generation: number };
type TilesHost = { extensionState(): { ids: readonly string[]; focused: string; dragging: boolean }; relayout(): void };
type Control<T> = { id: string; controlId: T; resource: string; enabled: boolean; hidden: boolean };

/** Order-sensitive digest: an edit changes the revision without the text leaving the host. */
const digest = (text: string) => { let hash = 0; for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0; return `${text.length}:${hash}`; };
const shown = (element: Element) => element.getClientRects().length > 0;
/** Moves each node into one of the nodes' own places, in the desired order; focus stays. */
function place(current: readonly HTMLElement[], desired: readonly HTMLElement[]): void {
  if (current.length !== desired.length || current.every((node, index) => node === desired[index])) return;
  const focused = document.activeElement as HTMLElement | null;
  const marks = current.map(node => { const mark = document.createComment(''); node.before(mark); return mark; });
  marks.forEach((mark, index) => mark.replaceWith(desired[index]));
  if (focused && desired.some(node => node.contains(focused)) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
/** Hidden controls keep their node, out of view and inert; focus inside one moves to `fallback`. */
function setHidden(element: HTMLElement | null | undefined, hidden: boolean, fallback?: () => HTMLElement | null | undefined): void {
  if (!element || element.hasAttribute('data-layout-hidden') === hidden) return;
  const focused = hidden && element.contains(document.activeElement);
  element.toggleAttribute('data-layout-hidden', hidden); element.inert = hidden;
  if (focused) fallback?.()?.focus({ preventScroll: true });
}

export function mountTilesPickerAdoption(options: {
  /** The workspace: the tiles' area and the transcript. */
  root: HTMLElement;
  tiles: TilesHost;
  /** The tiled thread's project (its own, not the focused thread's). */
  projectOf: (task: string) => string | undefined;
  picker: () => PickerHostState;
  /** Ids the picker lists (the no-project id first), for a fresh choice's liveness check. */
  projects: () => readonly string[];
  /** The picker's own choice (main.ts `chooseTaskProject`), run after a fresh host choice. */
  choose: (task: string, projectId: string) => void;
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
}) {
  const { root, tiles } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, tilesIdentity = '', pickerIdentity = '', tilesRevision = 0, pickerRevision = 0, tilesSignature = '', pickerSignature = '', choosing = false, engagedNow = false, lastProject = layoutProject();
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  const contributes = (location: TilesPickerActionLocation) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));
  const tileNode = (id: string) => [...root.querySelectorAll<HTMLElement>('.work-area > .thread-tile')].find(tile => tile.dataset.tile === id) ?? null;
  const panel = () => document.querySelector<HTMLElement>('.project-menu');
  const trigger = () => document.querySelector<HTMLElement>('#welcome-project');

  function authority(slot: 'panda.transcript' | 'panda.composer', host: HTMLElement | null): TilesPickerAuthority & { identity: string } {
    const provider = componentSelection.resolve(slot, componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    return { owner: provider?.id ?? '', identity: `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`, active: !safe() && Boolean(owner && provider && host?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  const tilesAuthority = () => { const auth = authority('panda.transcript', root.querySelector('#transcript')); tilesIdentity = auth.identity; return auth; };
  const pickerAuthority = () => { const auth = authority('panda.composer', document.querySelector('#composer')); pickerIdentity = auth.identity; return auth; };

  const arranged = (location: string, local: readonly (readonly [string, string])[]) => {
    const ids = local.map(([id]) => `${location}/${id}`);
    return ids.some(id => !TILES_PICKER_PINNED[id] && layout.isHidden(id, layoutProject())) || orderedControls(location, ids.filter(id => !TILES_PICKER_FIXED[id])).some((id, index) => id !== ids.filter(item => !TILES_PICKER_FIXED[item])[index]);
  };
  /** The adapter only touches a tile bar when it has something to show: a contribution, or the user's order or hidden
   * controls. Otherwise (and in safe mode) every bar stays exactly as thread-tiles.ts drew it. */
  const tilesEngaged = () => !safe() && (contributes('panda.workspace.tiles.actions') || arranged(TILES_LOCATION, TILES_CONTROLS));
  /** The same for the picker: without a contribution or an arrangement it gets no extension at all. */
  const pickerEngaged = () => !safe() && (contributes('panda.workspace.project-picker.actions') || arranged(PICKER_LOCATION, PICKER_ENTRIES));
  const hiddenBy = (builtIn: boolean, id: string) => !builtIn && !TILES_PICKER_PINNED[id] && layout.isHidden(id, layoutProject());

  /** A tile bar after every update: Close and the title in the user's order, Close and a mirror's follow-up button
   * hidden in place, and the tile's marker at the bar's end. Built-in when not engaged. */
  function painted(parts: TileParts): void {
    const builtIn = !engagedNow, nodes: Record<string, HTMLElement> = { close: parts.close, title: parts.title };
    const ids = ['close', 'title'].map(id => `${TILES_LOCATION}/${id}`), order = (builtIn ? ids : orderedControls(TILES_LOCATION, ids)).map(id => nodes[id.slice(TILES_LOCATION.length + 1)]);
    place([parts.close, parts.title].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1), order);
    setHidden(parts.close, hiddenBy(builtIn, `${TILES_LOCATION}/close`), () => parts.title);
    setHidden(parts.composer, hiddenBy(builtIn, `${TILES_LOCATION}/composer`), () => parts.title);
    const existing = parts.bar.querySelector<HTMLElement>(':scope > [data-tiles-picker]');
    const wanted = !builtIn && contributes('panda.workspace.tiles.actions');
    if (!wanted) { existing?.remove(); return; }
    if (existing?.dataset.extensionSession === parts.id) { if (parts.bar.lastElementChild !== existing) parts.bar.append(existing); return; }
    existing?.remove(); parts.bar.append(tileSlot(parts.id));
  }
  const tileLayout = (): TileExtension | undefined => disposed ? undefined : { painted };

  function refresh() {
    if (disposed) return;
    lastProject = layoutProject();
    const was = engagedNow; engagedNow = tilesEngaged();
    if (engagedNow || was) tiles.relayout();
  }

  function tilesPresentation(): TilesPresentation {
    const { ids, focused, dragging } = tiles.extensionState(), auth = tilesAuthority(), picker = options.picker();
    for (const key of [...finders.keys()]) if (key.startsWith('tile:')) finders.delete(key);
    const controls: Control<TilesControl>[] = [];
    const add = (key: string, controlId: TilesControl, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(`tile:${key}`, find);
      controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement).disabled, hidden: Boolean(element.closest('[data-layout-hidden], [hidden]')) || !shown(element) });
    };
    for (const id of ids) {
      const resource = handle(`tile:${id}`);
      add(handle(`tile-focus:${id}`), 'tile-focus', resource, () => tileNode(id)?.querySelector<HTMLElement>('.thread-tile-title') ?? null);
      add(handle(`tile-close:${id}`), 'tile-close', resource, () => tileNode(id)?.querySelector<HTMLElement>('.thread-tile-close') ?? null);
      add(handle(`tile-composer:${id}`), 'tile-composer', resource, () => tileNode(id)?.querySelector<HTMLElement>('.thread-mirror-composer') ?? null);
    }
    const area = root.querySelector<HTMLElement>('.work-area'), project = focused ? options.projectOf(focused) : undefined;
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: project ? handle(`project:${project}`) : '', task: focused ? handle(`task:${focused}`) : '',
      revision: 0, visible: !disposed && ids.length > 1 && Boolean(area && shown(area)),
      // A dialog, menu, drag, pending project change or host choice holds input.
      busy: choosing || dragging || picker.pending || picker.busy || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu, .project-menu')),
      safeMode: extensionsSnapshot().safeMode, tiles: ids.slice(0, 6).map(id => handle(`tile:${id}`)),
      controls: controls.slice(0, 32), truncated: controls.length > 32 || ids.length > 6,
    };
    const next = JSON.stringify([value, auth.owner, auth.active, auth.granted, tilesIdentity]);
    if (next !== tilesSignature) { tilesSignature = next; tilesRevision++; }
    return snapshotTiles({ ...value, revision: tilesRevision });
  }

  function pickerPresentation(): PickerPresentation {
    const state = options.picker(), auth = pickerAuthority(), task = state.task ?? '', open = Boolean(task && panel());
    for (const key of [...finders.keys()]) if (key.startsWith('picker:')) finders.delete(key);
    const controls: Control<PickerControl>[] = [];
    const add = (key: string, controlId: PickerControl, resource: string, find: () => HTMLElement | null) => {
      const element = find(); if (!element) return;
      finders.set(`picker:${key}`, find);
      controls.push({ id: key, controlId, resource, enabled: !(element as HTMLButtonElement).disabled, hidden: Boolean(element.closest('[data-layout-hidden], [hidden]')) || !shown(element) });
    };
    let entries = 0;
    if (task) {
      const draft = handle(`draft:${task}`);
      add(handle(`picker-toggle:${task}`), 'picker-toggle', draft, trigger);
      if (open) {
        for (const option of panel()!.querySelectorAll<HTMLElement>('.project-menu-option')) {
          const project = option.dataset.projectId ?? '';
          entries++;
          add(handle(`picker-select:${task}:${project}`), 'picker-select', handle(`project:${project}`), () => [...panel()?.querySelectorAll<HTMLElement>('.project-menu-option') ?? []].find(item => item.dataset.projectId === project) ?? null);
        }
        add(handle(`picker-open:${task}`), 'picker-open', draft, () => panel()?.querySelector<HTMLElement>('.project-menu-open') ?? null);
      }
    }
    const search = panel()?.querySelector<HTMLInputElement>('input')?.value ?? '', button = trigger();
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, project: task && state.project ? handle(`project:${state.project}`) : '', task: task ? handle(`task:${task}`) : '',
      revision: 0, visible: !disposed && Boolean(task && button && shown(button)),
      // A dialog, another menu, a pending project change, a picker still choosing or a host choice holds input.
      busy: choosing || state.pending || state.busy || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu, .project-menu-list[aria-busy="true"]')),
      safeMode: extensionsSnapshot().safeMode, open, draft: Boolean(state.draft.trim()), entries: Math.min(entries, 128),
      controls: controls.slice(0, 128), truncated: controls.length > 128,
    };
    const next = JSON.stringify([value, digest(state.draft), open ? digest(search) : '', auth.owner, auth.active, auth.granted, pickerIdentity]);
    if (next !== pickerSignature) { pickerSignature = next; pickerRevision++; }
    return snapshotPicker({ ...value, revision: pickerRevision });
  }

  /** A fresh host choice bound to the same target; Escape declines and nothing runs. */
  function ask(anchor: HTMLElement, title: string, label: string, icon: string, run: () => void, alive: () => boolean) {
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor, title, items: [{ id: 'continue', label: `Continue: ${label}`, icon }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      closeChoice?.(); run();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatchTiles(input: unknown) {
    const owner = tilesAuthority().owner;
    const slot = createTilesControls(tilesPresentation(), owner, tilesPresentation, tilesAuthority, (action: TilesAction) => {
      const element = finders.get(`tile:${action.control}`)?.(); if (!element) return;
      if (!TILES_PICKER_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
      const identity = tilesIdentity, focused = tiles.extensionState().focused;
      // The choice closes the same tile it was asked for, while the same thread is focused.
      ask(element, 'Extension requested a tile action', 'Close this view', 'close', () => finders.get(`tile:${action.control}`)?.()?.click(), () => {
        const live = tilesPresentation();
        return tilesAuthority().active && identity === tilesIdentity && tiles.extensionState().focused === focused && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden);
      });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  function dispatchPicker(input: unknown) {
    const owner = pickerAuthority().owner;
    const slot = createPickerControls(pickerPresentation(), owner, pickerPresentation, pickerAuthority, (action: PickerAction) => {
      const element = finders.get(`picker:${action.control}`)?.(); if (!element) return;
      if (!TILES_PICKER_CHOICE_CONTROLS.includes(action.controlId)) { element.click(); return; }
      const state = options.picker(), task = state.task!, project = element.dataset.projectId ?? '', identity = pickerIdentity, name = element.querySelector('.project-menu-name')?.textContent?.trim() || 'another project';
      // The picker closes as the choice takes focus; Continue runs the picker's own choice for the same draft and target.
      ask(trigger() ?? element, 'Extension requested a project change', `Move this draft to ${name}`, 'folder', () => options.choose(task, project), () => {
        const live = options.picker();
        return pickerAuthority().active && identity === pickerIdentity && live.task === task && live.project === state.project && !live.pending && options.projects().includes(project);
      });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  /** The picker's extension: undefined unless a package contributes to its footer or the user arranged its entries, so
   * the zero-extension picker keeps its list and markup. */
  function pickerExtension(current: string, noProject: string): ProjectPickerExtension | undefined {
    if (!pickerEngaged()) return undefined;
    const state = options.picker();
    const ids = ['no-project', 'projects'].map(id => `${PICKER_LOCATION}/${id}`);
    return {
      arrange: projects => {
        if (safe()) return undefined;
        const none = projects.filter(project => project.id === noProject), rest = projects.filter(project => project.id !== noProject);
        const hideNone = current !== noProject && hiddenBy(false, `${PICKER_LOCATION}/no-project`);
        return orderedControls(PICKER_LOCATION, ids).flatMap(id => id.endsWith('/projects') ? rest : hideNone ? [] : none) as Project[];
      },
      hideOpen: () => hiddenBy(safe(), `${PICKER_LOCATION}/open`),
      mountActions: host => {
        if (!contributes('panda.workspace.project-picker.actions') || !state.task) return undefined;
        const captured = { ...(state.projectId ? { projectId: state.projectId } : {}), sessionId: state.task, revision: state.generation, selection: { kind: 'draft-project', ids: [state.task] } };
        const dispose = mountExtensionActions(host, 'panda.workspace.project-picker.actions', () => captured, options.notify);
        // The picker closes as a contributed action's dialog takes focus; that dialog keeps its captured draft until it
        // closes, then the actions end.
        return () => { const dialog = document.querySelector<HTMLDialogElement>('dialog[open]'); if (dialog) dialog.addEventListener('close', dispose, { once: true }); else dispose(); };
      },
    };
  }

  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  const stopContext = options.onContextChanged(() => { if (layoutProject() !== lastProject) refresh(); });
  window.addEventListener('pandacode-components-change', refresh);
  // After main.ts holds the adoption: the tiles read their layout through it.
  queueMicrotask(refresh);
  return {
    tileLayout, pickerExtension, tilesPresentation, pickerPresentation, dispatchTiles, dispatchPicker,
    dispose() {
      if (disposed) return;
      closeChoice?.(); stopExtensions(); stopLayout(); stopContext();
      window.removeEventListener('pandacode-components-change', refresh);
      // Every bar goes back to the host's own order, visibility and no slot.
      const was = engagedNow; engagedNow = false; if (was) tiles.relayout(); disposed = true;
    },
  };
}
