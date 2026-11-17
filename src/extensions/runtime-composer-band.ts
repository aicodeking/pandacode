// A live, task-scoped band above the composer (`ui.presentation`, runtime phase R10, slice R1001).
//
// A trusted package puts one segment in `panda.composer.band`: a status item (`text`, `icon`, `tone`, `progress`, `tooltip`, a
// `command` for the click and up to three buttons in `items`) or a rich view whose `location` is the band (a 24 to 96 px
// panel at the segment's full width). A background service registers or updates its items at run time (`ui.dynamic`), and an
// item registered with `scope: { taskId }` shows only while that task is in view; the run-time layer (runtime-dynamic-items.ts)
// already lays those items over the manifest snapshot, so this file reads `extensionsSnapshot()` as it is.
//
// The native twin is src-tauri/src/extensions/runtime_composer_band.rs. This file has two halves: the model (no I/O, no DOM,
// importable by the deterministic checks of tests/extensions-runtime-composer-band.spec.ts) and `mountComposerBand`, which
// draws it. The band is additive: the built-in composer is never replaced, so revoking the grant, disabling the package or
// entering safe mode only removes the band, and a running task keeps working. Everything here is for predictability and fault
// isolation, never for trust (ADR-0005): a package holding `ui.presentation` is never asked again per action.
import type { Json } from './contracts';
import type { ExtensionSnapshot } from './manager';
import type { RegisteredView } from './views-state';

export const LOCATION = 'panda.composer.band';
export const PERMISSION = 'ui.presentation';
/** Segments drawn in the row; the rest fold into the menu. */
export const MAX_SHOWN = 3;
/** Item buttons of one segment. */
export const MAX_BUTTONS = 3;
/** The rich band height range (px), checked by both validators (C04). */
export const MIN_HEIGHT = 24;
export const MAX_HEIGHT = 96;
const TEXT_CHARS = 120;
const TONES = ['neutral', 'info', 'success', 'warning', 'danger'];

type Definition = Record<string, Json>;
export type Button = { id: string; title: string; command: string; icon?: string };
export type Segment = {
  /** The id of the declaring menu or view: the key hide and order are stored under. */
  key: string;
  owner: string;
  version: string;
  /** The package's name: everything an extension shows is labelled with it. */
  label: string;
  kind: 'status' | 'view';
  text: string;
  icon?: string;
  tone: string;
  progress?: number;
  tooltip: string;
  command?: string;
  args?: Json;
  enabled: boolean;
  buttons: Button[];
  view?: RegisteredView;
  height?: number;
};
export type Arrangement = { shown: Segment[]; overflow: Segment[]; hidden: Segment[] };
export type Rules = { order(ids: string[]): string[]; hidden(id: string): boolean };
export type Placement = { id: string; target: string; side: 'before' | 'after' };

const record = (value: unknown): value is Definition => typeof value === 'object' && value !== null && !Array.isArray(value);
const clip = (text: string) => { const chars = [...text]; return chars.length > TEXT_CHARS ? `${chars.slice(0, TEXT_CHARS - 1).join('')}…` : text; };

/** The frozen failure of a band item: which rule it breaks, or `null` when it is a valid band status item. */
export function checkItem(menu: Definition): string | null {
  if (menu.location !== LOCATION) return null;
  if (menu.presentation !== 'status') return 'InvalidShape';
  const items = menu.items;
  if (items === undefined) return null;
  if (!Array.isArray(items)) return 'InvalidShape';
  if (items.length > MAX_BUTTONS) return 'LimitExceeded';
  return items.every(item => record(item) && item.kind === 'command' && typeof item.command === 'string' && typeof item.title === 'string') ? null : 'InvalidShape';
}

/** C04: a view in the band has a `rich` panel 24 to 96 px high and no `placement`; elsewhere it needs 160 or more. */
export function checkView(view: Definition): string | null {
  const rich = view.rich;
  const inBand = view.location === LOCATION;
  if (view.location !== undefined && view.location !== LOCATION && view.location !== 'panda.inspector.views') return 'InvalidShape';
  if (!record(rich)) return inBand ? 'InvalidShape' : null;
  const size = record(rich.minSize) ? rich.minSize : undefined;
  const height = size && typeof size.height === 'number' ? size.height : undefined;
  if (inBand) {
    if (rich.placement !== undefined) return 'InvalidShape';
    if (height === undefined || height < MIN_HEIGHT || height > MAX_HEIGHT) return 'InvalidShape';
    return null;
  }
  return height !== undefined && height < 160 ? 'InvalidShape' : null;
}

/** The band height of a rich view, clamped to the range both validators enforce. */
export const viewHeight = (view: { rich?: { minSize?: { height: number } } }): number => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, view.rich?.minSize?.height ?? MIN_HEIGHT));

/** Whether the package may put anything in the band now: enabled, not in safe mode, holding `ui.presentation`. */
export type Granted = (owner: string, version: string) => boolean;

/**
 * The segments of the band for a snapshot (already merged with the run-time layer, which drops the items scoped to a task that
 * is not in view). One segment per package: its band view when it declares one (full width), else its first valid status item.
 */
export function bandSegments(snapshot: ExtensionSnapshot, granted: Granted): Segment[] {
  if (snapshot.safeMode) return [];
  const segments: Segment[] = [];
  for (const item of snapshot.packages) {
    const manifest = item.manifest;
    if (!item.enabled || !(manifest.permissions ?? []).includes(PERMISSION) || !granted(manifest.id, manifest.version)) continue;
    const contributes = manifest.contributes as unknown as Record<string, Definition[] | undefined>;
    const label = typeof (manifest as { name?: unknown }).name === 'string' ? (manifest as unknown as { name: string }).name : manifest.id;
    const view = (contributes.views ?? []).find(entry => entry.location === LOCATION && checkView(entry) === null && record(entry.rich));
    if (view) {
      const registered = { owner: manifest.id, version: manifest.version, view } as unknown as RegisteredView;
      segments.push({ key: String(view.id), owner: manifest.id, version: manifest.version, label, kind: 'view', text: clip(String(view.text ?? '')), tone: 'neutral', tooltip: `${label}: ${String(view.title ?? '')}`, enabled: true, buttons: [], view: registered, height: viewHeight(registered.view) });
      continue;
    }
    const menu = (contributes.menus ?? []).find(entry => entry.location === LOCATION && entry.visible !== false && checkItem(entry) === null);
    if (!menu) continue;
    const tone = typeof menu.tone === 'string' && TONES.includes(menu.tone) ? menu.tone : 'neutral';
    const progress = Number.isInteger(menu.progress) && (menu.progress as number) >= 0 && (menu.progress as number) <= 100 ? (menu.progress as number) : undefined;
    const detail = typeof menu.tooltip === 'string' && menu.tooltip ? menu.tooltip : String(menu.text ?? '');
    const buttons = ((menu.items ?? []) as Definition[]).slice(0, MAX_BUTTONS).map(button => ({ id: String(button.id), title: clip(String(button.title)), command: String(button.command), ...(typeof button.icon === 'string' ? { icon: button.icon } : {}) }));
    segments.push({
      key: String(menu.id), owner: manifest.id, version: manifest.version, label, kind: 'status', text: clip(String(menu.text ?? menu.badge ?? '')), tone, tooltip: `${label}: ${detail}`, enabled: menu.enabled !== false,
      ...(typeof menu.icon === 'string' ? { icon: menu.icon } : {}), ...(progress !== undefined ? { progress } : {}), ...(typeof menu.command === 'string' ? { command: menu.command } : {}), ...(menu.args !== undefined ? { args: menu.args } : {}), buttons,
    });
  }
  return segments;
}

/** The user's order and hiding applied: the first `MAX_SHOWN` are drawn, the rest fold into the menu, hidden ones wait to be restored. */
export function arrange(segments: readonly Segment[], rules: Rules): Arrangement {
  const byKey = new Map(segments.map(segment => [segment.key, segment]));
  const ordered = rules.order([...byKey.keys()]).map(key => byKey.get(key)).filter((segment): segment is Segment => !!segment);
  const hidden = ordered.filter(segment => rules.hidden(segment.key)), visible = ordered.filter(segment => !rules.hidden(segment.key));
  return { shown: visible.slice(0, MAX_SHOWN), overflow: visible.slice(MAX_SHOWN), hidden };
}

/** The relative placement that moves `key` one step earlier or later among the visible segments, or `null` at an end. */
export function stepPlacement(visibleKeys: readonly string[], key: string, direction: 'earlier' | 'later'): Placement | null {
  const at = visibleKeys.indexOf(key);
  if (at < 0) return null;
  const neighbour = visibleKeys[direction === 'earlier' ? at - 1 : at + 1];
  return neighbour === undefined ? null : { id: key, target: neighbour, side: direction === 'earlier' ? 'before' : 'after' };
}

/** The rows of the band menu (keyboard accessible: it is the host's choice menu), in a fixed order. */
export type MenuRow = { id: string; label: string; separator?: boolean };
export function menuRows(arrangement: Arrangement): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const segment of arrangement.overflow) rows.push({ id: `open:${segment.key}`, label: `${segment.label}: ${segment.text || 'open'}` });
  const visible = [...arrangement.shown, ...arrangement.overflow];
  visible.forEach((segment, index) => {
    rows.push({ id: `hide:${segment.key}`, label: `Hide ${segment.label}`, ...(index === 0 ? { separator: true } : {}) });
    if (index > 0) rows.push({ id: `earlier:${segment.key}`, label: `Move ${segment.label} earlier` });
    if (index < visible.length - 1) rows.push({ id: `later:${segment.key}`, label: `Move ${segment.label} later` });
  });
  arrangement.hidden.forEach((segment, index) => rows.push({ id: `show:${segment.key}`, label: `Show ${segment.label}`, ...(index === 0 ? { separator: true } : {}) }));
  if (arrangement.hidden.length > 1) rows.push({ id: 'restore', label: 'Restore all hidden segments' });
  return rows;
}

/** What a click hands to the command: the captured task and project, never the draft. */
export function clickContext(state: { project?: string; task?: string; generation: number }, args?: Json): Record<string, Json> {
  return { schemaVersion: 1, windowId: 'main', surfaceId: LOCATION, revision: state.generation, ...(state.project ? { projectId: state.project } : {}), ...(state.task ? { sessionId: state.task } : {}), ...(args !== undefined ? { args } : {}) };
}

// ---- The interface ----------------------------------------------------------------------------------------------------

export type BandOptions = {
  /** The composer area: the band is drawn right above it, outside it, so a composer redraw never loses it. */
  area: HTMLElement;
  state: () => { project?: string; task?: string; generation: number };
  onContextChanged: (listener: () => void) => () => void;
  notify: (message: string) => void;
};

interface Drawn { node: HTMLElement; signature: string; dispose?: () => void }

export async function mountComposerBand(options: BandOptions) {
  const [manager, hosts, commands, choice, rich, grantsModule, dom] = await Promise.all([
    import('./manager'), import('./layout-host'), import('./commands'), import('../choice-menu'), import('./runtime-rich-mount'), import('./runtime-grants'), import('../dom'),
  ]);
  const { area } = options;
  const band = document.createElement('div');
  band.className = 'composer-band'; band.dataset.composerBand = ''; band.hidden = true;
  band.setAttribute('role', 'group'); band.setAttribute('aria-label', 'Extension status');
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'composer-band-more'; more.textContent = '⋯'; more.hidden = true;
  more.setAttribute('aria-label', 'More extension status'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
  area.before(band);
  const drawn = new Map<string, Drawn>();
  let disposed = false, arrangement: Arrangement = { shown: [], overflow: [], hidden: [] }, closeMenu: (() => void) | undefined;

  const granted: Granted = (owner, version) => {
    const grants = grantsModule.createRuntimeGrantsPreview();
    grants.sync(manager.extensionsManagementSnapshot() as unknown as Parameters<typeof grants.sync>[0]);
    return grants.check(owner, version, PERMISSION) === 'ok';
  };
  const run = (command: string, args?: Json) => { if (!commands.invokeExtensionCommand(command, clickContext(options.state(), args), options.notify)) options.notify('That extension action is not available right now.'); };

  function statusNode(segment: Segment): HTMLElement {
    const node = document.createElement('div');
    node.className = 'composer-band-segment'; node.dataset.bandSegment = segment.key; node.dataset.owner = segment.owner; node.dataset.tone = segment.tone;
    node.setAttribute('role', 'group'); node.setAttribute('aria-label', segment.label); node.title = segment.tooltip;
    const main = document.createElement(segment.command ? 'button' : 'span');
    main.className = 'composer-band-main';
    if (main instanceof HTMLButtonElement) { main.type = 'button'; main.disabled = !segment.enabled; main.addEventListener('click', () => run(segment.command!, segment.args)); }
    if (segment.icon) { const mark = document.createElement('span'); mark.className = 'composer-band-icon'; mark.innerHTML = dom.icon(segment.icon); main.append(mark); }
    const text = document.createElement('span'); text.className = 'composer-band-text'; text.textContent = segment.text || segment.label; main.append(text);
    node.append(main);
    if (segment.progress !== undefined) {
      const bar = document.createElement('span'); bar.className = 'composer-band-progress';
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(segment.progress)); bar.setAttribute('aria-label', `${segment.label} progress`);
      const fill = document.createElement('span'); fill.className = 'composer-band-progress-fill'; fill.style.setProperty('--band-progress', String(segment.progress / 100)); bar.append(fill); node.append(bar);
    }
    for (const button of segment.buttons) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'composer-band-button ds-btn'; action.dataset.bandButton = button.id; action.textContent = button.title;
      action.setAttribute('aria-label', `${button.title} (${segment.label})`); action.addEventListener('click', () => run(button.command)); node.append(action);
    }
    return node;
  }
  function viewNode(segment: Segment): Drawn {
    const node = document.createElement('div');
    node.className = 'composer-band-segment composer-band-view'; node.dataset.bandSegment = segment.key; node.dataset.owner = segment.owner; node.style.setProperty('--band-height', `${segment.height}px`);
    const dispose = rich.mountRichPanel(node, segment.view!);
    return { node, signature: '', dispose };
  }

  function sync() {
    if (disposed) return;
    const snapshot = manager.extensionsSnapshot();
    const project = hosts.layoutProject();
    const segments = bandSegments(snapshot, granted);
    arrangement = arrange(segments, { order: ids => hosts.orderedControls(LOCATION, ids, project), hidden: id => !manager.extensionsSafeMode() && hosts.layout.isHidden(id, project) });
    // The band shows only where a composer is: a settled task, a channel or no task has none.
    const present = Boolean(area.querySelector('#composer'));
    const wanted = present ? arrangement.shown : [];
    const keep = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const segment of wanted) {
      const signature = JSON.stringify(segment.kind === 'view' ? [segment.key, segment.owner, segment.version, segment.height, segment.view?.view.rich] : segment);
      const existing = drawn.get(segment.key);
      keep.add(segment.key);
      if (existing && existing.signature === signature) { nodes.push(existing.node); continue; }
      // A rich view keeps its live panel (and its channel) while its declaration is the same.
      const focused = existing && document.activeElement instanceof HTMLElement && existing.node.contains(document.activeElement) ? document.activeElement : null;
      const focusButton = focused?.dataset.bandButton;
      existing?.dispose?.(); existing?.node.remove();
      const entry: Drawn = segment.kind === 'view' ? viewNode(segment) : { node: statusNode(segment), signature };
      entry.signature = signature;
      drawn.set(segment.key, entry); nodes.push(entry.node);
      // A live update never takes the keyboard away: focus returns to the same control of the redrawn segment.
      if (focused) queueMicrotask(() => (entry.node.querySelector<HTMLElement>(focusButton ? `[data-band-button="${CSS.escape(focusButton)}"]` : '.composer-band-main') ?? entry.node).focus({ preventScroll: true }));
    }
    for (const [key, entry] of [...drawn]) if (!keep.has(key)) { entry.dispose?.(); entry.node.remove(); drawn.delete(key); }
    const wantedChildren = [...nodes, more];
    wantedChildren.forEach((node, index) => { if (band.children[index] !== node) band.insertBefore(node, band.children[index] ?? null); });
    more.hidden = !present || (arrangement.overflow.length === 0 && arrangement.hidden.length === 0);
    more.setAttribute('aria-label', arrangement.overflow.length ? `${arrangement.overflow.length} more extension status` : 'Manage extension status');
    band.hidden = !present || (nodes.length === 0 && more.hidden);
    band.dataset.bandCount = String(nodes.length);
    if (band.hidden) closeMenu?.();
  }

  function applyRow(id: string) {
    const [verb, ...rest] = id.split(':'), key = rest.join(':'), project = hosts.layoutProject();
    try {
      if (verb === 'open') { const segment = arrangement.overflow.find(item => item.key === key); if (segment?.command) run(segment.command, segment.args); else if (segment) options.notify(`${segment.label}: ${segment.text}`); return; }
      if (verb === 'hide') hosts.layout.setVisible(key, false, project);
      else if (verb === 'show') hosts.layout.setVisible(key, true, project);
      else if (id === 'restore') for (const segment of arrangement.hidden) hosts.layout.setVisible(segment.key, true, project);
      else if (verb === 'earlier' || verb === 'later') {
        const visible = [...arrangement.shown, ...arrangement.overflow].map(segment => segment.key), placement = stepPlacement(visible, key, verb);
        if (placement) hosts.layout.move(LOCATION, visible, placement, project);
      }
    } catch (error) { options.notify(error instanceof Error ? error.message : 'The band layout could not be saved.'); }
    sync();
  }
  more.addEventListener('click', () => {
    if (more.getAttribute('aria-expanded') === 'true') { closeMenu?.(); return; }
    const rows = menuRows(arrangement);
    if (!rows.length) return;
    more.setAttribute('aria-expanded', 'true');
    closeMenu = choice.openChoiceMenu({ anchor: more, title: 'Extension status', items: rows.map(row => ({ id: row.id, label: row.label, ...(row.separator ? { separator: true } : {}) })), onSelect: applyRow, onClose: () => { more.setAttribute('aria-expanded', 'false'); closeMenu = undefined; } });
  });

  const stops = [manager.onExtensionsChanged(sync), hosts.layout.subscribe(sync), options.onContextChanged(sync)];
  window.addEventListener(rich.GRANTS_CHANGED, sync);
  window.addEventListener('pandacode-components-change', sync);
  // The composer area is redrawn by innerHTML: the band follows whether a composer is there.
  const watcher = new MutationObserver(sync);
  watcher.observe(area, { childList: true });
  sync();
  return {
    sync,
    segments: () => structuredClone(arrangement),
    dispose() {
      if (disposed) return;
      disposed = true; closeMenu?.(); watcher.disconnect(); stops.forEach(stop => stop());
      window.removeEventListener(rich.GRANTS_CHANGED, sync); window.removeEventListener('pandacode-components-change', sync);
      for (const entry of drawn.values()) entry.dispose?.();
      drawn.clear(); band.remove();
    },
  };
}
