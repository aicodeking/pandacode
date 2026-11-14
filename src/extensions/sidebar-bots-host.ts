/** Host-only Bots panel bindings: bot and channel rows, the panel head and its menus never cross the package boundary. */
import { openChoiceMenu } from '../choice-menu';
import type { Json } from './contracts';
import { createSidebarBotsPresentation, snapshotSidebarBots, SIDEBAR_BOTS_ENTRY_CONTROLS, SIDEBAR_BOTS_ROW_CONTROLS, type SidebarBotsAction, type SidebarBotsControl, type SidebarBotsPresentation, type SidebarBotsStatus } from './sidebar-core';
import { sidebarProvider } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, layoutProject, applyControlOrder, applyControlVisibility, orderedControls } from './layout-host';
import { mountExtensionActions } from './header';
import { SIDEBAR_BOTS_CONTROLS, SIDEBAR_BOTS_GROUPS, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_PINNED_GROUPS, SIDEBAR_BOTS_ROW_PARTS, SIDEBAR_BOTS_ROWS_LOCATION, type SidebarBotsGroupId } from './surfaces';
import type { BotsArrangement } from '../sidebar-bots';

/** What main.ts knows about the Bots panel: the open bot or channel (raw ids, mapped to opaque handles here), the
 * view, the search, the Hidden group preference and how many bots or channels each group lists. */
export type BotsHostState = { view: 'tasks' | 'bots'; project?: string; bot?: string; channel?: string; searching: boolean; hiddenOpen: boolean; loaded: boolean; busy: boolean; groups: readonly { id: SidebarBotsGroupId; count: number }[] };

/** The original node of each panel-head control (references inside the panel, not new actions). */
const HEAD_NODES: Readonly<Record<typeof SIDEBAR_BOTS_CONTROLS[number][0], string>> = { search: '.bots-panel-search', 'mark-read': '.bots-mark-read', create: '.bots-panel-head > [data-action=new-bot-menu]' };
const LABELS: Readonly<Partial<Record<SidebarBotsControl, string>>> = { 'toggle-view': 'Switch the sidebar view', 'mark-read': 'Mark all bots read', 'new-bot': 'New bot', 'new-channel': 'New channel', 'toggle-hidden': 'Show or hide paused bots' };
const GROUP_IDS = SIDEBAR_BOTS_GROUPS.map(([id]) => id);
const STATUSES: readonly SidebarBotsStatus[] = ['waiting', 'failed', 'limited', 'working', 'unread', 'responded'];

export function mountSidebarBotsAdoption(options: {
  root: HTMLElement;
  bar: HTMLElement;
  panel: HTMLElement;
  state: () => BotsHostState;
  /** Context for the panel head accessory (the same one the sidebar header uses). */
  context: () => Record<string, Json>;
  onContextChanged: (listener: () => void) => () => void;
  /** Redraws the Bots panel through the original renderer. */
  rerender: () => void;
  notify: (message: string) => void;
}) {
  const { root, bar, panel } = options, context = crypto.randomUUID(), handles = new Map<string, string>(), finders = new Map<string, () => HTMLElement | null>(), applied = new Set<string>();
  let disposed = false, identity = '', revision = 0, signature = '', choosing = false;
  let closeChoice: (() => void) | undefined, cached: { key: string; value: BotsArrangement } | undefined;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const list = () => panel.querySelector<HTMLElement>('.bots-panel-list');
  const headBindings = () => SIDEBAR_BOTS_CONTROLS.map(([id]) => [`${SIDEBAR_BOTS_LOCATION}/${id}`, panel.querySelector<HTMLElement>(HEAD_NODES[id])] as const);
  const safe = () => disposed || extensionsSnapshot().safeMode;

  /** Group order and reversible visibility for the next draw. Needs you never hides, nothing hides while searching
   * (botsListHtml also keeps the group holding the open bot or channel) and safe mode is built-in. */
  function arrange(searching: boolean): BotsArrangement {
    const builtIn = safe(), project = layoutProject(), key = JSON.stringify([searching, project, builtIn]);
    if (cached?.key === key) return cached.value;
    const order = builtIn ? GROUP_IDS : orderedControls(SIDEBAR_BOTS_GROUPS_LOCATION, GROUP_IDS.map(id => `${SIDEBAR_BOTS_GROUPS_LOCATION}/${id}`), project).map(id => id.slice(SIDEBAR_BOTS_GROUPS_LOCATION.length + 1) as SidebarBotsGroupId);
    const hidden = new Set(builtIn || searching ? [] : GROUP_IDS.filter(id => !SIDEBAR_BOTS_PINNED_GROUPS[id] && layout.isHidden(`${SIDEBAR_BOTS_GROUPS_LOCATION}/${id}`, project)));
    cached = { key, value: { order, hidden } };
    return cached.value;
  }

  function authority() {
    const provider = sidebarProvider();
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    identity = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    return { owner: provider?.id ?? '', active: !safe() && Boolean(owner && provider && root.dataset.sidebarProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), userChoice: true };
  }
  function presentation(): SidebarBotsPresentation {
    const state = options.state(), auth = authority(), rows = list(), rowHidden = new Set((rows?.dataset.rowHidden ?? '').split(' ').filter(Boolean)), open = state.view === 'bots';
    finders.clear();
    const controls: { id: string; controlId: SidebarBotsControl; resource: string; enabled: boolean; hidden: boolean }[] = [];
    const add = (controlId: SidebarBotsControl, key: string, resource: string, find: () => HTMLElement | null, enabled = open, hidden = false) => {
      const node = find(); if (!node) return;
      const id = handle(`control:${controlId}:${key}`); finders.set(id, find);
      controls.push({ id, controlId, resource, enabled: enabled && !(node as HTMLButtonElement).disabled && !node.hidden, hidden: hidden || Boolean(node.closest('[data-layout-hidden]')) });
    };
    add('toggle-view', 'bar', '', () => bar.querySelector<HTMLElement>('[data-action=toggle-bots-view]'), true);
    add('search', 'search', '', () => panel.querySelector<HTMLElement>('[data-bots-search]'));
    add('mark-read', 'mark-read', '', () => panel.querySelector<HTMLElement>('.bots-mark-read'));
    add('create-menu', 'create', '', () => panel.querySelector<HTMLElement>(HEAD_NODES.create));
    add('new-bot', 'new-bot', '', () => panel.querySelector<HTMLElement>('#bot-create-menu [data-action=new-bot]'));
    add('new-channel', 'new-channel', '', () => panel.querySelector<HTMLElement>('#bot-create-menu [data-action=new-channel]'));
    add('toggle-hidden', 'hidden', handle('group:hidden'), () => rows?.querySelector<HTMLElement>('.bots-group-toggle') ?? null);
    const drawn: { id: string; kind: 'bot' | 'channel'; group: SidebarBotsGroupId; selected: boolean; pinned: boolean; status: SidebarBotsStatus }[] = [];
    let truncated = false;
    for (const row of rows?.querySelectorAll<HTMLElement>('[data-bot-row], .channel-row[data-channel]') ?? []) {
      const group = row.closest<HTMLElement>('[data-bots-group]')?.dataset.botsGroup as SidebarBotsGroupId | undefined;
      if (!group || !GROUP_IDS.includes(group)) continue;
      if (drawn.length >= 256) { truncated = true; break; }
      const bot = row.dataset.botRow, key = bot ? `bot:${bot}` : `channel:${row.dataset.channel}`, resource = handle(key);
      const badge = row.querySelector<HTMLElement>('.bot-badge'), status = STATUSES.find(kind => badge?.classList.contains(kind)) ?? 'none';
      drawn.push({ id: resource, kind: bot ? 'bot' : 'channel', group, selected: row.classList.contains('selected'), pinned: row.classList.contains('pinned'), status });
      if (bot) {
        const within = (selector: string) => () => list()?.querySelector<HTMLElement>(`[data-bot-row="${CSS.escape(bot)}"] > ${selector}`) ?? null;
        add('open-bot', key, resource, within('.bot-row-open'));
        add('bot-settings', key, resource, within('.bot-row-settings'), open, rowHidden.has('settings'));
        add('bot-menu', key, resource, within('.bot-row-open'));
      } else {
        const channel = row.dataset.channel!, find = () => list()?.querySelector<HTMLElement>(`.channel-row[data-channel="${CSS.escape(channel)}"]`) ?? null;
        add('open-channel', key, resource, find); add('channel-menu', key, resource, find);
      }
    }
    const value = {
      contractVersion: 1 as const, window: 'main' as const, context,
      project: state.project ? handle(`project:${state.project}`) : '', bot: state.bot ? handle(`bot:${state.bot}`) : '', channel: state.channel ? handle(`channel:${state.channel}`) : '',
      revision: 0, visible: !disposed && root.isConnected && !root.hidden, focused: root.contains(document.activeElement) && (bar.contains(document.activeElement) || panel.contains(document.activeElement)),
      busy: choosing || state.busy || Boolean(document.querySelector('dialog[open]')), view: state.view, searching: state.searching, loaded: state.loaded, safeMode: extensionsSnapshot().safeMode,
      groups: state.groups.map(group => ({ id: group.id, pinned: Boolean(SIDEBAR_BOTS_PINNED_GROUPS[group.id]), hidden: group.count > 0 && state.loaded && !rows?.querySelector(`[data-bots-group="${group.id}"]`), open: group.id === 'hidden' ? state.hiddenOpen || Boolean(rows?.querySelector('.bots-group-toggle[aria-expanded="true"]')) : true, count: Math.min(group.count, 100000) })),
      rows: drawn, controls: controls.slice(0, 1024), truncated: truncated || controls.length > 1024,
    };
    const next = JSON.stringify([{ ...value, focused: false }, auth.owner, auth.active, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotSidebarBots({ ...value, revision });
  }
  /** Runs the original handler through the original node; view switches, Mark all read, the Hidden-group preference
   * and creation dialogs need a fresh host choice. A row menu opens through the row's own context-menu listener. */
  function execute(action: SidebarBotsAction, alive: () => boolean) {
    const node = finders.get(action.control)?.(); if (!node) return;
    const run = (target: HTMLElement) => {
      if (action.controlId === 'search') target.focus({ preventScroll: true });
      else if (action.controlId === 'bot-menu' || action.controlId === 'channel-menu') target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      else target.click();
    };
    if (!SIDEBAR_BOTS_ENTRY_CONTROLS.includes(action.controlId)) { run(node); return; }
    choosing = true; closeChoice?.();
    // The create menu's items sit in a closed menu; the choice anchors on its visible create button instead.
    const anchor = node.checkVisibility() ? node : panel.querySelector<HTMLElement>(HEAD_NODES.create) ?? bar;
    closeChoice = openChoiceMenu({ anchor, title: 'Extension requested a sidebar action', items: [{ id: 'continue', label: `Continue: ${LABELS[action.controlId] ?? action.controlId}`, icon: 'sidebar' }], onSelect: id => {
      if (id !== 'continue' || !alive()) return;
      const target = finders.get(action.control)?.(); closeChoice?.(); if (target) run(target);
    }, onClose: () => { choosing = false; closeChoice = undefined; } });
  }
  function dispatch(input: unknown) {
    const owner = authority().owner;
    const slot = createSidebarBotsPresentation(presentation(), owner, presentation, authority, action => {
      const captured = identity;
      execute(action, () => { const live = presentation(); return authority().active && captured === identity && live.controls.some(item => item.id === action.control && item.enabled && !item.hidden); });
    }, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  /** Order and reversible visibility on the original head nodes and row parts through one list attribute: nodes,
   * listeners, the search text and focus stay. The search field is never bound for hiding. Safe mode is built-in. */
  function applyLayout() {
    const builtIn = safe(), head = headBindings(), hideable = head.filter(([id]) => SIDEBAR_BOTS_CONTROLS.some(([control, , canHide]) => canHide && id.endsWith(`/${control}`)));
    applyControlOrder(SIDEBAR_BOTS_LOCATION, head, builtIn);
    if (builtIn) for (const [, node] of head) { if (node?.hasAttribute('data-layout-hidden')) { node.removeAttribute('data-layout-hidden'); node.inert = false; } }
    else applyControlVisibility(hideable, () => panel.querySelector<HTMLElement>('[data-bots-search]'));
    const rows = list(); if (!rows) return;
    const focused = rows.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const parts = builtIn ? '' : SIDEBAR_BOTS_ROW_PARTS.filter(([id]) => layout.isHidden(`${SIDEBAR_BOTS_ROWS_LOCATION}/${id}`, layoutProject())).map(([id]) => id).join(' ');
    if ((rows.dataset.rowHidden ?? '') !== parts) { if (parts) rows.dataset.rowHidden = parts; else delete rows.dataset.rowHidden; }
    // A row part that hid under focus hands focus to its row.
    if (focused && !focused.checkVisibility()) focused.closest('[data-bot-row]')?.querySelector<HTMLElement>('.bot-row-open')?.focus({ preventScroll: true });
  }
  function refresh() {
    if (disposed) return;
    closeChoice?.(); cached = undefined;
    applyLayout();
    const focused = panel.contains(document.activeElement);
    options.rerender();
    // A group that hid under focus hands focus to the open row, or to the search field.
    if (focused && !panel.contains(document.activeElement)) (panel.querySelector<HTMLElement>('.bot-row.selected .bot-row-open, .channel-row.selected') ?? panel.querySelector<HTMLElement>('[data-bots-search]'))?.focus({ preventScroll: true });
  }
  const head = panel.querySelector<HTMLElement>('.bots-panel-head');
  const stopActions = head ? mountExtensionActions(head, 'panda.sidebar.bots.actions', options.context, options.notify, options.onContextChanged) : () => {};
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh);
  window.addEventListener('pandacode-components-change', refresh);
  refresh();
  return {
    presentation, dispatch, arrange, applyLayout, refresh,
    dispose() {
      if (disposed) return;
      disposed = true; closeChoice?.(); stopActions(); stopExtensions(); stopLayout(); window.removeEventListener('pandacode-components-change', refresh);
      cached = undefined; applyLayout(); options.rerender();
    },
  };
}
