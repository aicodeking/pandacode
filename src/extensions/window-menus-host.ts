/** Host-only bindings for the Workspace view menu, the sidebar Sort and view menu and the Filter projects menu: each menu
 * passes an extension surface with its captured window and revision (contributed items, the user's order and reversible
 * visibility of the eligible entries), and captured actions run the menus' original handlers in main.ts. The open view,
 * the sort, the tasks per section and the project filter stay host settings: a package changes one only through a fresh
 * host choice, and project names, paths and search text never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createWindowMenusControls, snapshotWindowMenus, WINDOW_MENUS_CHOICE_CONTROLS, type WindowMenusAction, type WindowMenusControl, type WindowMenusOpen, type WindowMenusPresentation } from './window-menus-core';
import { componentSelection, componentProviders } from './replacement';
import { extensionsSnapshot, extensionIdentity } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { WINDOW_MENUS_ENTRIES, type WindowMenusActionLocation } from './surfaces';

/** What the host's menus show right now. `views` are the views the Workspace view menu lists; `projects` are the user's
 * projects in the Filter projects menu. Names are the host's own words for the fresh choice and never reach a package. */
export type WindowMenusHostState = {
  view: string; views: readonly { id: string; label: string }[];
  tasks: string; perProject: number; counts: readonly number[];
  filter: string; projects: readonly { id: string; name: string }[];
  project?: string;
  /** The host menu that is open. */
  menu: WindowMenusOpen; busy: boolean; generation: number;
};
/** One host request: the original handler resolves `key` (`view:<id>`, `sort:<id>`, `scope:<count>` or `filter:<id>`). */
export type WindowMenusHostRequest = { controlId: WindowMenusControl; key: string };
type Anchor = 'view' | 'sort' | 'filter';
type Control = { id: string; controlId: WindowMenusControl; resource: string; enabled: boolean; hidden: boolean };

const shown = (element: Element | null | undefined): element is Element => Boolean(element && element.isConnected && element.getClientRects().length > 0);
const SORT_LABELS: Readonly<Record<string, string>> = { manual: 'Manual', ...Object.fromEntries(WINDOW_MENUS_ENTRIES['panda.sidebar.sort.menu'].map(([id, label]) => [id, label])) };
export const WINDOW_MENUS_LABELS = { sort: SORT_LABELS } as const;

export function mountWindowMenusAdoption(options: {
  state: () => WindowMenusHostState;
  /** The control that opens each menu, for the fresh host choice's anchor and for visibility. */
  anchor: (menu: Anchor) => HTMLElement | null;
  /** Runs the original handler; `alive` re-checks the captured state after any host choice. */
  execute: (request: WindowMenusHostRequest, alive: () => boolean) => void;
}) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), keys = new Map<string, string>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false;
  let closeChoice: (() => void) | undefined;
  const handle = (key: string) => { if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const safe = () => disposed || extensionsSnapshot().safeMode;
  /** The entries a menu keeps in place: the open view, the selected sort and count. */
  const held = (location: WindowMenusActionLocation): string[] => {
    const state = options.state();
    return location === 'panda.workspace.view.menu' ? [state.view] : location === 'panda.sidebar.sort.menu' ? ['manual', state.tasks, `per-${state.perProject}`] : [];
  };
  const hidden = (location: WindowMenusActionLocation, id: string) => !safe() && !held(location).includes(id) && layout.isHidden(`${location}/${id}`, layoutProject());
  const contributes = (location: WindowMenusActionLocation) => !safe() && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.contributes.menus?.some(menu => menu.location === location));

  function authority() {
    const provider = componentSelection.resolve('panda.composer', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    const composer = document.querySelector<HTMLElement>('#composer');
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && composer?.dataset.componentProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }

  function presentation(): WindowMenusPresentation {
    const state = options.state(), auth = authority();
    keys.clear();
    const controls: Control[] = [];
    const add = (controlId: WindowMenusControl, key: string, enabled: boolean, location?: WindowMenusActionLocation, id?: string) => {
      const control = handle(`control:${key}`);
      keys.set(control, key);
      controls.push({ id: control, controlId, resource: handle(`resource:${key}`), enabled, hidden: Boolean(location && id && hidden(location, id)) });
    };
    const canView = shown(options.anchor('view')), canSort = shown(options.anchor('sort')), canFilter = shown(options.anchor('filter'));
    for (const view of state.views) add('view-open', `view:${view.id}`, view.id !== state.view && canView, 'panda.workspace.view.menu', view.id);
    for (const [id] of WINDOW_MENUS_ENTRIES['panda.sidebar.sort.menu'].filter(([entry]) => !entry.startsWith('per-'))) add('sort-set', `sort:${id}`, id !== state.tasks && canSort, 'panda.sidebar.sort.menu', id);
    add('sort-set', 'sort:manual', state.tasks !== 'manual' && canSort);
    for (const count of state.counts) add('scope-set', `scope:${count}`, count !== state.perProject && canSort, 'panda.sidebar.sort.menu', `per-${count}`);
    add('filter-set', 'filter:all', state.filter !== '' && canFilter);
    for (const project of state.projects) add('filter-set', `filter:${project.id}`, project.id !== state.filter && canFilter);
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context, view: handle(`view:${state.view}`), sort: handle(`sort:${state.tasks}:${state.perProject}`), filter: handle(`filter:${state.filter}`),
      revision: 0, visible: !disposed && (canView || canSort || canFilter),
      // An open menu, another dialog or a pending host choice holds input.
      busy: choosing || state.busy || state.menu !== 'none' || Boolean(document.querySelector('dialog[open], .model-menu, .choice-menu')),
      safeMode: extensionsSnapshot().safeMode, menu: state.menu,
      controls: controls.slice(0, 64), truncated: controls.length > 64,
    };
    const next = JSON.stringify([value, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotWindowMenus({ ...value, revision });
  }

  /** A fresh host choice bound to the same window state; Escape declines and nothing runs. */
  function ask(anchor: HTMLElement, label: string, icon: string, run: () => void, alive: () => boolean) {
    choosing = true; closeChoice?.();
    closeChoice = openChoiceMenu({ anchor, title: 'Extension requested a window menu action', items: [{ id: 'continue', label: `Continue: ${label}`, icon }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      closeChoice?.(); run();
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createWindowMenusControls(presentation(), owner, presentation, authority, (action: WindowMenusAction) => {
      const key = keys.get(action.control) ?? '', state = options.state(), held = identity;
      const alive = () => {
        const live = presentation();
        return authority().active && held === identity && live.view === action.view && live.sort === action.sort && live.filter === action.filter && live.controls.some(item => item.id === action.control && item.resource === action.resource && item.enabled && !item.hidden);
      };
      const request = { controlId: action.controlId, key };
      if (!WINDOW_MENUS_CHOICE_CONTROLS.includes(action.controlId)) { options.execute(request, alive); return; }
      const kind = key.split(':')[0], id = key.slice(key.indexOf(':') + 1);
      const menu: Anchor = kind === 'view' ? 'view' : kind === 'filter' ? 'filter' : 'sort';
      const label = kind === 'view' ? `Open the ${state.views.find(view => view.id === id)?.label ?? 'other'} view`
        : kind === 'sort' ? `Sort tasks by ${SORT_LABELS[id] ?? 'another order'}`
        : kind === 'scope' ? `Show ${id} tasks per section`
        : id === 'all' ? 'Show all projects' : `Show only ${state.projects.find(project => project.id === id)?.name ?? 'another project'}`;
      const anchor = options.anchor(menu) ?? document.body;
      // The choice runs the same handler for the same view, sort, count and filter it was asked for.
      ask(anchor, label, kind === 'view' ? 'thread' : kind === 'filter' ? 'folder' : 'sort', () => options.execute(request, alive), alive);
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }

  const arranged = (location: WindowMenusActionLocation, pinned: readonly string[]) => {
    const ids = WINDOW_MENUS_ENTRIES[location].map(([id]) => `${location}/${id}`);
    return ids.some(id => !pinned.includes(id.slice(location.length + 1)) && layout.isHidden(id, layoutProject())) || orderedControls(location, ids).some((id, index) => id !== ids[index]);
  };
  /** The extension surface of a host menu: undefined in safe mode and while nothing is contributed or arranged, so the
   * zero-extension menu keeps its own rows and roles. The captured context is built once at open; `alive` ends it when
   * the window state it was opened for changes. `pinned` are the host rows that never hide: with `rows` they are all of
   * them (Filter projects), otherwise the held ones plus any the caller adds. */
  function surface(location: WindowMenusActionLocation, selection: { kind: 'workspace-view' | 'sidebar-sort' | 'project-filter'; ids: readonly string[] }, alive: () => boolean, pinned: readonly string[]) {
    const stay = [...held(location), ...pinned];
    if (safe() || !contributes(location) && !arranged(location, stay)) return undefined;
    const state = options.state();
    const captured: Record<string, Json> = { revision: state.generation, ...(state.project ? { projectId: state.project } : {}), selection: { kind: selection.kind, ids: [...selection.ids] } };
    return { location, context: captured, isAlive: alive, pinned: stay };
  }

  return {
    surface, presentation, dispatch,
    dispose() { if (disposed) return; closeChoice?.(); disposed = true; },
  };
}
