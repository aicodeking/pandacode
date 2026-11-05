import './thread-tiles.css';
import { escape, icon } from './dom';
import { MAX_TILES, tileAt, tileRects, tilesThatFit, type TileRect } from './tile-layout';

/** Up to six threads tiled in the thread area (`.work-area`). The focused tile is the real thread: the one
 * `.conversation-pane`, placed over its tile, with every composer, approval and streaming path as it always was. The
 * others are live read-only views of the same turn cards; a click focuses one, which is an ordinary thread switch.
 * With fewer than two threads there are no tiles and nothing here touches the layout. */
export interface TileHost {
  area: HTMLElement;
  pane: HTMLElement;
  workspace: HTMLElement;
  title(id: string): string;
  /** The word and tone for the tile's bar: only states that need the reader, plus running. */
  signal(id: string): { status: string; label: string; word: string };
  exists(id: string): boolean;
  running(id: string): boolean;
  /** Opens the thread in the real pane; `scrollTop` keeps the place the reader had in its view. */
  open(id: string, scrollTop?: number): Promise<unknown>;
  focusPrompt(): void;
  /** Draws (or redraws) a thread's read-only rows. */
  draw(id: string, rows: HTMLElement, scroller: HTMLElement): void;
  /** The thread's scene, in its tile. */
  scene(tile: HTMLElement, id: string): { setThread(id: string | null): void; refresh(): void; dispose(): void };
  notify(text: string): void;
}

/** The bar every tile carries; the pane starts below it. */
const BAR_HEIGHT = 38;
const STORE = 'pandacode.tiles';
const MOVE_MS = 220, ARRIVE_MS = 180;
const EASE = 'cubic-bezier(.22,1,.36,1)';
/** A dragged tile's new place shifts what is under the pointer, so a change waits this long after the last one. */
const PREVIEW_SETTLE_MS = 120;
/** Unfocused threads redraw at most this often while they stream. */
const DRAW_MS = 250;

interface Tile {
  el: HTMLElement; bar: HTMLElement; mirror: HTMLElement; scroller: HTMLElement; rows: HTMLElement;
  scene: ReturnType<TileHost['scene']>; stick: boolean; resize: ResizeObserver; timer: number;
}
const still = (): boolean => document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches || !document.documentElement.hasAttribute('data-ready');

export function mountThreadTiles(host: TileHost) {
  const { area, pane, workspace } = host;
  const tiles = new Map<string, Tile>();
  const ring = document.createElement('div');
  ring.className = 'thread-tile-ring'; ring.setAttribute('aria-hidden', 'true'); ring.hidden = true;
  area.append(ring);
  let ids: string[] = [], focused = '';
  let preview: { id: string; list: string[]; at: number } | null = null, dragId = '', dropped = false;
  let restored = false, settling = 0;

  const shown = (): string[] => preview?.list ?? ids;
  const save = (): void => {
    try { if (ids.length > 1) localStorage.setItem(STORE, JSON.stringify(ids)); else localStorage.removeItem(STORE); }
    catch { /* Tiling still works for this session. */ }
  };
  const load = (): string[] => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(STORE) ?? '[]'); return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []; }
    catch { return []; }
  };
  // The rail layout (≤650px) is one column: there the thread is the plain pane.
  const narrow = matchMedia('(max-width: 650px)');
  const available = (): boolean => !narrow.matches && !workspace.matches('.board-view,.github-view,.settings-open');
  const size = (): { width: number; height: number } => ({ width: area.clientWidth, height: area.clientHeight });

  function make(id: string): Tile {
    const el = document.createElement('section');
    el.className = 'thread-tile'; el.dataset.tile = id; el.setAttribute('role', 'group');
    el.innerHTML = `<header class="thread-tile-bar" draggable="true"><button type="button" class="icon-button thread-tile-close" aria-label="Close view">${icon('close')}</button><button type="button" class="thread-tile-title"><span class="thread-tile-mark" aria-hidden="true"></span><span class="thread-tile-name"></span><span class="thread-tile-word"></span></button></header><div class="conversation-pane thread-mirror"><div class="transcript thread-mirror-rows" tabindex="-1"></div><button type="button" class="thread-mirror-composer">Ask for follow-up changes…</button></div>`;
    const bar = el.querySelector<HTMLElement>('.thread-tile-bar')!, mirror = el.querySelector<HTMLElement>('.thread-mirror')!;
    // The rows are the scroller's own children, as in the real transcript, so its CSS applies; each is inert (`quiet`), the scroller is not, so the wheel still scrolls.
    const scroller = el.querySelector<HTMLElement>('.transcript')!, rows = scroller;
    area.append(el);
    const tile: Tile = { el, bar, mirror, scroller, rows, scene: host.scene(el, id), stick: true, timer: 0,
      // Rows grow as Markdown lands; a view at its end stays there.
      resize: new ResizeObserver(() => { if (tile.stick) scroller.scrollTop = scroller.scrollHeight; }) };
    const quiet = new MutationObserver(() => {
      for (const child of scroller.children) if (!child.hasAttribute('inert')) { child.setAttribute('inert', ''); tile.resize.observe(child); }
      if (tile.stick) scroller.scrollTop = scroller.scrollHeight;
    });
    quiet.observe(scroller, { childList: true });
    tile.resize.observe(scroller);
    scroller.addEventListener('scroll', () => { tile.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48; }, { passive: true });
    el.addEventListener('click', event => {
      const target = event.target as Element;
      event.stopPropagation();
      if (target.closest('.thread-tile-close')) { close(id); return; }
      const toPrompt = Boolean(target.closest('.thread-mirror-composer'));
      if (id === focused) { host.focusPrompt(); return; }
      focus(id, toPrompt);
    }, true);
    bar.addEventListener('dragstart', event => {
      if (!event.dataTransfer || ids.length < 2) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-pandacode-thread', id);
    });
    tiles.set(id, tile);
    tile.scene.setThread(id);
    host.draw(id, rows, scroller);
    return tile;
  }
  function drop(id: string): void {
    const tile = tiles.get(id);
    if (!tile) return;
    clearTimeout(tile.timer); tile.resize.disconnect(); tile.scene.dispose(); tile.el.remove(); tiles.delete(id);
  }
  function bars(): void {
    for (const [id, tile] of tiles) {
      const title = host.title(id), signal = host.signal(id), isFocused = id === focused;
      tile.el.setAttribute('aria-label', title);
      tile.el.toggleAttribute('data-focused', isFocused);
      tile.el.toggleAttribute('data-running', host.running(id));
      tile.el.toggleAttribute('data-ghost', preview?.id === id && !ids.includes(id));
      tile.bar.dataset.status = signal.status;
      tile.bar.querySelector('.thread-tile-name')!.textContent = title;
      tile.bar.querySelector('.thread-tile-word')!.textContent = signal.word;
      const button = tile.bar.querySelector<HTMLElement>('.thread-tile-title')!;
      button.setAttribute('aria-label', `${isFocused ? 'Focused' : 'Focus'}: ${title}${signal.label ? `, ${signal.label}` : ''}`);
      button.setAttribute('aria-current', String(isFocused));
      tile.mirror.hidden = isFocused;
    }
  }

  /** Places everything at once; a tile that moved slides from where it was, and its text reflows only the once. */
  function layout(animate: boolean): void {
    const list = shown();
    const { width, height } = size();
    const rects = list.length > 1 && available() ? tileRects(list.length, width, height) : null;
    const before = new Map<string, DOMRect>();
    if (animate && !still()) for (const [id, tile] of tiles) before.set(id, tile.el.getBoundingClientRect());
    for (const id of [...tiles.keys()]) if (!list.includes(id)) drop(id);
    if (!rects) {
      // One thread, the board, or a pane too small for the tiles: the thread is the plain pane. The tiles stay in `ids`.
      for (const id of [...tiles.keys()]) drop(id);
      delete area.dataset.tiles;
      pane.removeAttribute('style'); ring.hidden = true;
      clipWallpaper(null);
      return;
    }
    area.dataset.tiles = String(list.length);
    list.forEach((id, index) => {
      const fresh = !tiles.has(id), tile = tiles.get(id) ?? make(id), rect = rects[index];
      place(tile.el, rect);
      if (id === focused) { place(pane, { ...rect, top: rect.top + BAR_HEIGHT, height: rect.height - BAR_HEIGHT }); place(ring, rect); ring.hidden = false; }
      if (!animate || still()) return;
      const old = before.get(id);
      if (fresh) tile.el.animate([{ opacity: 0, scale: .98 }, { opacity: 1, scale: 1 }], { duration: ARRIVE_MS, easing: EASE });
      else if (old) slide(tile.el, old, id === focused);
    });
    clipWallpaper(rects);
    bars();
  }
  /** A wallpaper is one image behind the whole pane: cut to the tiles, so each has its rounded corners and the frame
   * shows between them. Each tile's sky is its own canvas, clipped by the tile. */
  function clipWallpaper(rects: TileRect[] | null): void {
    const layer = document.querySelector<HTMLElement>('.workspace-wallpaper');
    if (!layer) return;
    if (!rects) { layer.style.removeProperty('clip-path'); return; }
    const from = layer.getBoundingClientRect(), to = area.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(tiles.values().next().value?.el ?? area).borderTopLeftRadius) || 0;
    const paths = rects.map(rect => roundedPath(rect.left + to.left - from.left, rect.top + to.top - from.top, rect.width, rect.height, radius));
    layer.style.clipPath = `path("${paths.join(' ')}")`;
  }
  function roundedPath(x: number, y: number, width: number, height: number, r: number): string {
    return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }
  function place(el: HTMLElement, rect: TileRect): void {
    el.style.left = `${rect.left}px`; el.style.top = `${rect.top}px`; el.style.width = `${rect.width}px`; el.style.height = `${rect.height}px`;
  }
  function slide(el: HTMLElement, old: DOMRect, withPane: boolean): void {
    const now = el.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const frames = [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], timing = { duration: MOVE_MS, easing: EASE };
    el.animate(frames, timing);
    if (withPane) { pane.animate(frames, timing); ring.animate(frames, timing); }
  }
  function redraw(id: string): void {
    const tile = tiles.get(id);
    if (!tile || id === focused || tile.timer) return;
    tile.timer = window.setTimeout(() => { tile.timer = 0; if (tiles.get(id) === tile) host.draw(id, tile.rows, tile.scroller); }, DRAW_MS);
  }
  function focus(id: string, toPrompt = false): void {
    const tile = tiles.get(id);
    const keep = tile && !tile.stick ? tile.scroller.scrollTop : undefined;
    void host.open(id, keep).then(() => { if (toPrompt) host.focusPrompt(); });
  }
  function close(id: string): void {
    const index = ids.indexOf(id);
    if (index < 0) return;
    const next = ids.filter(other => other !== id);
    ids = next.length > 1 ? next : [];
    if (id === focused && next.length) { focused = next[Math.min(index, next.length - 1)]; void host.open(focused); }
    save();
    layout(true);
    if (!ids.length) focused = next[0] ?? '';
  }

  /** Adds a thread beside the others, at `index` or the end; the open thread is the first tile. */
  function open(id: string, index?: number): void {
    if (!host.exists(id)) return;
    const base = ids.length ? ids : focused && focused !== id ? [focused] : [];
    if (base.includes(id)) { focus(id); return; }
    const { width, height } = size();
    if (base.length >= Math.min(MAX_TILES, tilesThatFit(width, height))) { host.notify('No room for another view. Close one or widen the window.'); return; }
    ids = [...base]; ids.splice(index ?? ids.length, 0, id);
    save();
    if (ids.length > 1) layout(true);
    void host.open(id);
  }

  /** The thread that opened in the real pane. It takes its own tile if it has one, else the focused tile's place. */
  function sync(id: string | null): void {
    if (!restored && id) {
      restored = true;
      const saved = load().filter(host.exists);
      if (saved.length > 1 && saved.includes(id)) ids = saved;
    }
    // Nothing open (a new task's page): a later drag has no thread to sit beside.
    if (!id) { if (!ids.length) focused = ''; return; }
    const previous = focused;
    if (ids.length) {
      if (!ids.includes(id)) ids = ids.includes(previous) ? ids.map(other => other === previous ? id : other) : [...ids.slice(0, -1), id];
      const known = ids.filter(host.exists).concat(ids.includes(id) && !host.exists(id) ? [id] : []);
      ids = known.length > 1 ? known : [];
      save();
    }
    focused = id;
    layout(false);
    if (previous && previous !== id) { const tile = tiles.get(previous); if (tile) host.draw(previous, tile.rows, tile.scroller); }
    bars();
  }

  // Drag: a thread from the sidebar, or a tile by its bar. The tiles re-tile as soon as it is over the area, with the
  // real thread in its place, so dropping changes nothing but its ghost look.
  document.addEventListener('dragstart', event => {
    const target = event.target as Element | null;
    dragId = target?.closest?.<HTMLElement>('.thread-tile')?.dataset.tile ?? target?.closest?.<HTMLElement>('.task-item[data-id]')?.dataset.id ?? '';
    if (dragId && !host.exists(dragId)) dragId = '';
    dropped = false;
  }, true);
  const previewAt = (x: number, y: number): string[] | null => {
    const { width, height } = size();
    const base = ids.length ? ids : focused ? [focused] : [];
    const rest = base.filter(id => id !== dragId);
    if (!rest.length) return null;
    const cap = Math.min(MAX_TILES, tilesThatFit(width, height));
    if (cap < 2) return null;
    const list = shown().length > 1 ? shown() : base;
    const rects = list.length > 1 ? tileRects(list.length, width, height) : [{ left: 0, top: 0, width, height }];
    if (!rects) return null;
    const hit = tileAt(rects, x, y);
    if (!hit) return null;
    const over = list[hit.index];
    // Over its own place it stays: moving it would slide another tile under the pointer and back.
    if (over === dragId) return preview?.list ?? (base.includes(dragId) ? base : null);
    // Full: the tile under the pointer gives its place.
    if (!base.includes(dragId) && base.length >= cap) return base.map(id => id === over ? dragId : id);
    const next = [...rest];
    next.splice(rest.indexOf(over) + Number(hit.after), 0, dragId);
    return next;
  };
  /** Moves the preview to this point, or once the last move has settled, so the last point always lands. */
  const previewTo = (x: number, y: number): void => {
    clearTimeout(settling);
    const list = dragId ? previewAt(x, y) : null;
    if (!list || list.join('\0') === shown().join('\0')) return;
    const now = performance.now();
    if (preview && now - preview.at < PREVIEW_SETTLE_MS) { settling = window.setTimeout(() => previewTo(x, y), PREVIEW_SETTLE_MS - (now - preview.at)); return; }
    preview = { id: dragId, list, at: now };
    layout(true); bars();
  };
  const dragOver = (event: DragEvent): void => {
    if (!dragId || !event.dataTransfer?.types.includes('application/x-pandacode-thread')) return;
    const bounds = area.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    // With nothing open (a new task's page) there is nothing to sit beside: the drop just opens the thread.
    const opensAlone = !ids.length && !focused;
    if (!opensAlone && !previewAt(x, y)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (!opensAlone) previewTo(x, y);
  };
  // Entering a new element reports the pointer too, so the preview answers before the next dragover.
  area.addEventListener('dragenter', dragOver);
  area.addEventListener('dragover', dragOver);
  const endPreview = (): void => {
    clearTimeout(settling);
    if (!preview) return;
    preview = null;
    layout(true); bars();
  };
  area.addEventListener('dragleave', event => { if (!area.contains(event.relatedTarget as Node | null)) endPreview(); });
  area.addEventListener('drop', event => {
    if (!dragId) return;
    clearTimeout(settling);
    if (!ids.length && !focused) { event.preventDefault(); event.stopPropagation(); dropped = true; void host.open(dragId); return; }
    const bounds = area.getBoundingClientRect();
    const list = previewAt(event.clientX - bounds.left, event.clientY - bounds.top) ?? preview?.list;
    if (!list) return;
    event.preventDefault(); event.stopPropagation();
    dropped = true;
    ids = list; preview = null;
    save();
    layout(false);
    void host.open(dragId);
  });
  document.addEventListener('dragend', () => { if (!dropped) endPreview(); dragId = ''; dropped = false; });
  // ⌘-click (Ctrl-click elsewhere) on a sidebar row opens it beside the others.
  document.addEventListener('click', event => {
    if (!event.metaKey && !event.ctrlKey) return;
    const row = (event.target as Element | null)?.closest?.<HTMLElement>('#navigation .task-item[data-id]');
    if (!row) return;
    event.preventDefault(); event.stopPropagation();
    open(row.dataset.id!);
  }, true);
  // ⌘⌥←/→ moves focus between tiles.
  document.addEventListener('keydown', event => {
    if (!event.altKey || !(event.metaKey || event.ctrlKey) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !area.dataset.tiles) return;
    const index = ids.indexOf(focused);
    if (index < 0) return;
    event.preventDefault();
    focus(ids[(index + (event.key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length]);
  });
  new ResizeObserver(() => { if (ids.length || preview) layout(false); }).observe(area);
  narrow.addEventListener('change', () => { if (ids.length) layout(false); });
  new MutationObserver(() => { if (ids.length) layout(false); }).observe(workspace, { attributes: true, attributeFilter: ['class'] });

  return {
    open, sync,
    /** Whether this thread has a tile already. */
    has: (id: string): boolean => ids.includes(id),
    /** An agent event: only views that are not the real pane need redrawing. */
    event(id: string): void { if (tiles.has(id)) { redraw(id); bars(); } },
    /** Sidebar data changed (titles, statuses, deletes). */
    refresh(): void {
      if (!ids.length) return;
      const known = ids.filter(host.exists);
      if (known.length !== ids.length) { ids = known.length > 1 ? known : []; save(); layout(true); }
      bars();
    },
    /** The Wallpapers switch changed. */
    refreshScenes(): void { for (const tile of tiles.values()) tile.scene.refresh(); },
    /** For specs and the menu. */
    title: (id: string): string => escape(host.title(id)),
  };
}
