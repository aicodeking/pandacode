/** The left-side thread scroll indicator: a slim floating rail of turn ticks beside the transcript.
 * One click jumps to a turn, a vertical drag scrubs across ticks with a live preview, and the chevrons
 * load earlier history or jump to the latest reply. The model lives in thread-scroll-model.ts; this file
 * mounts the rail and its shared preview as siblings of #transcript in the conversation pane, places them
 * between the top band and the composer, and keeps nodes (and so focus and hover) stable while the
 * thread scrolls or streams. */
import './thread-scroll-indicator.css';
import { buildScrollIndicatorModel, findActiveTurnIndex, type ScrollIndicatorState, type ScrollMarker, type ScrollTurnSummary } from './thread-scroll-model';

export type ThreadScrollSnapshot = {
  hidden: boolean;
  turns: readonly ScrollTurnSummary[];
  hasOlder: boolean;
  atBottom: boolean;
  /** The line a reader is at, in the same coordinates as `drawnTops()`. */
  readingLine: number;
  /** Tops of the turns currently drawn (a windowed transcript draws only some), sorted by top. */
  drawnTops: () => { index: number; top: number }[];
};

export interface ThreadScrollIndicatorHost {
  pane: HTMLElement;
  scroller: HTMLElement;
  composer: HTMLElement;
  workspace: HTMLElement;
  getSnapshot(): ThreadScrollSnapshot;
  jumpToTurn(targetId: string, options: { viaKeyboard: boolean }): void;
  jumpToLatest(options: { viaKeyboard: boolean }): void;
  loadEarlier(): void;
}

export type ThreadScrollIndicator = {
  element: HTMLElement;
  previewElement: HTMLElement;
  sync(): void;
  syncScroll(): void;
  dispose(): void;
};

/** Clearance from the top band and the composer. */
const GAP = 12;
/** The smallest top band: the header's height when nothing else sits above the transcript. */
const MIN_TOP_BAND = 52;
const MIN_PANE_WIDTH = 540;
const MIN_HEIGHT = 100;
/** Rail geometry the slot count is derived from: vertical padding, a chevron button, a tick. */
const RAIL_PAD = 12, STEP_ROOM = 24, TICK_ROOM = 16, SLOT_CAP = 16;
const PIP_CLEAR = 8, PIP_EDGE = 80;
const SCRUB_THRESHOLD = 4;
const HOVER_DELAY = 90, LEAVE_GRACE = 120;
const PREVIEW_GAP = 8;
/** Pixels per wheel line, for a wheel that reports lines (matches action-dock.ts). */
const WHEEL_LINE = 16;
const HIDDEN_VIEWS = ['board-view', 'github-view'];
const HIDDEN_PANES = ['new-task-page', 'channel-thread'];
const SVG_NS = 'http://www.w3.org/2000/svg';

type Band = { start: number; end: number };

function chevron(direction: 'up' | 'down'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', direction === 'up' ? 'M3 7.5 6 4.5l3 3' : 'M3 4.5 6 7.5l3-3');
  for (const [name, value] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) path.setAttribute(name, value);
  svg.append(path);
  return svg;
}

function stepButton(action: 'earlier' | 'latest', label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'thread-scroll-step'; button.dataset.scrollAction = action;
  button.setAttribute('aria-label', label); button.dataset.previewTitle = label; button.hidden = true; button.tabIndex = -1;
  button.append(chevron(action === 'earlier' ? 'up' : 'down'));
  return button;
}

function createTick(key: string): HTMLButtonElement {
  const tick = document.createElement('button');
  tick.type = 'button'; tick.className = 'thread-scroll-tick'; tick.dataset.scrollKey = key; tick.tabIndex = -1;
  const bar = document.createElement('span');
  bar.className = 'thread-scroll-tick-bar'; bar.setAttribute('aria-hidden', 'true');
  tick.append(bar);
  return tick;
}

const setFlag = (element: HTMLElement, name: string, on: boolean) => { if (on !== element.hasAttribute(name)) element.toggleAttribute(name, on); };
const setAttr = (element: HTMLElement, name: string, value: string) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };

function paintTick(tick: HTMLButtonElement, marker: ScrollMarker): void {
  tick.dataset.targetId = marker.targetId;
  tick.dataset.previewTitle = marker.title;
  tick.dataset.previewText = marker.preview;
  setAttr(tick, 'aria-label', marker.preview ? `${marker.title}: ${marker.preview}` : marker.title);
  setFlag(tick, 'data-live', marker.isLive);
  setFlag(tick, 'data-error', marker.hasError);
  setActive(tick, marker.active);
}

function setActive(tick: HTMLElement, active: boolean): void {
  setFlag(tick, 'data-active', active);
  if (active) setAttr(tick, 'aria-current', 'location'); else if (tick.hasAttribute('aria-current')) tick.removeAttribute('aria-current');
}

/** Whether the pane's current view has a thread to navigate. */
function contextAllows(host: ThreadScrollIndicatorHost): boolean {
  if (HIDDEN_VIEWS.some(name => host.workspace.classList.contains(name))) return false;
  if (HIDDEN_PANES.some(name => host.pane.classList.contains(name))) return false;
  return host.pane.clientWidth >= MIN_PANE_WIDTH;
}

const shown = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && !element.hidden && element.getClientRects().length > 0;

/** The free band, in pane coordinates: below whatever sits above the transcript, above the composer,
 * and clear of a visible progress or Colab pip at the left edge. */
function freeBand(host: ThreadScrollIndicatorHost): Band {
  const frame = host.pane.getBoundingClientRect();
  let top = MIN_TOP_BAND;
  for (const child of host.pane.children) {
    if (child === host.scroller) break;
    if (!shown(child) || getComputedStyle(child).position === 'absolute') continue;
    top = Math.max(top, child.getBoundingClientRect().bottom - frame.top);
  }
  const bottom = shown(host.composer) ? host.composer.getBoundingClientRect().top - frame.top : frame.height;
  return avoidPips(host.pane, { start: top + GAP, end: bottom - GAP }, frame);
}

/** The pips that float over the pane's edge: the progress pip, and the Colab pip when it docks on the left. */
const PIPS = [':scope > #progress-pip', ':scope > #colab-pip'];

function avoidPips(pane: HTMLElement, band: Band, frame: DOMRect): Band {
  return PIPS.reduce((free, selector) => avoidPip(pane.querySelector<HTMLElement>(selector), free, frame), band);
}

function avoidPip(pip: HTMLElement | null, band: Band, frame: DOMRect): Band {
  if (!shown(pip)) return band;
  const box = pip.getBoundingClientRect();
  const top = box.top - frame.top, bottom = box.bottom - frame.top;
  if (box.left - frame.left > PIP_EDGE || bottom <= band.start || top >= band.end) return band;
  const above = top - PIP_CLEAR - band.start, below = band.end - (bottom + PIP_CLEAR);
  return below >= above ? { start: bottom + PIP_CLEAR, end: band.end } : { start: band.start, end: top - PIP_CLEAR };
}

const slotsFor = (height: number): number => Math.min(SLOT_CAP, Math.floor((height - RAIL_PAD - 2 * STEP_ROOM) / TICK_ROOM));

const scrollableOf = (scroller: HTMLElement): boolean => scroller.scrollHeight > scroller.clientHeight + 1;

/** The turn index at the reading line, from the turns the transcript has drawn. */
function activeTurnOf(snapshot: ThreadScrollSnapshot): number {
  if (!snapshot.turns.length) return -1;
  if (snapshot.atBottom) return snapshot.turns.length - 1;
  const drawn = snapshot.drawnTops();
  const found = findActiveTurnIndex(drawn.map(entry => entry.top), snapshot.readingLine, false);
  return found < 0 ? 0 : drawn[found].index;
}

export function mountThreadScrollIndicator(host: ThreadScrollIndicatorHost): ThreadScrollIndicator {
  const element = document.createElement('nav');
  element.id = 'thread-scroll-indicator'; element.className = 'thread-scroll-indicator';
  element.setAttribute('aria-label', 'Thread navigation'); element.setAttribute('aria-orientation', 'vertical'); element.hidden = true;
  const earlier = stepButton('earlier', 'Load earlier messages');
  const latest = stepButton('latest', 'Jump to latest');
  const track = document.createElement('div');
  track.className = 'thread-scroll-track';
  element.append(earlier, track, latest);

  const previewElement = document.createElement('div');
  previewElement.id = 'thread-scroll-preview'; previewElement.className = 'thread-scroll-preview';
  previewElement.setAttribute('role', 'tooltip'); previewElement.hidden = true;
  const previewTitle = document.createElement('span'); previewTitle.className = 'thread-scroll-preview-title';
  const previewText = document.createElement('span'); previewText.className = 'thread-scroll-preview-text';
  previewElement.append(previewTitle, previewText);
  host.pane.append(element, previewElement);

  let state: ScrollIndicatorState | undefined, band: Band = { start: 0, end: 0 }, slots = SLOT_CAP;
  let scrollFrame = 0, layoutFrame = 0, disposed = false;

  const ticks = () => [...track.children] as HTMLButtonElement[];
  const items = () => [...element.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.hidden);
  const focusedItem = () => { const active = document.activeElement; return active instanceof HTMLButtonElement && element.contains(active) && !active.hidden ? active : undefined; };

  /** One Tab stop: the focused button, else the current tick, else the first shown button. */
  const rove = (target?: HTMLButtonElement) => {
    const list = items();
    const current = target && list.includes(target) ? target : focusedItem() ?? track.querySelector<HTMLButtonElement>('[data-active]') ?? list[0];
    for (const button of element.querySelectorAll<HTMLButtonElement>('button')) { const index = button === current ? 0 : -1; if (button.tabIndex !== index) button.tabIndex = index; }
  };

  // ---- Preview bubble ----
  let anchor: HTMLButtonElement | undefined, openTimer = 0, closeTimer = 0;
  const clearTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer); openTimer = closeTimer = 0; };
  const hidePreview = () => {
    clearTimers();
    anchor?.removeAttribute('data-hover'); anchor = undefined;
    previewElement.hidden = true;
  };
  const placePreview = () => {
    if (!anchor || previewElement.hidden) return;
    const frame = host.pane.getBoundingClientRect(), box = anchor.getBoundingClientRect(), height = previewElement.offsetHeight;
    const centre = box.top - frame.top + box.height / 2;
    const top = Math.max(band.start, Math.min(centre - height / 2, band.end - height));
    previewElement.style.left = `${Math.round(element.offsetLeft + element.offsetWidth + PREVIEW_GAP)}px`;
    previewElement.style.top = `${Math.round(top)}px`;
  };
  const fillPreview = (button: HTMLButtonElement) => {
    const title = button.dataset.previewTitle ?? '', text = button.dataset.previewText ?? '';
    if (previewTitle.textContent !== title) previewTitle.textContent = title;
    if (previewText.textContent !== text) previewText.textContent = text;
  };
  const openPreview = (button: HTMLButtonElement) => {
    clearTimers();
    if (anchor !== button) { anchor?.removeAttribute('data-hover'); anchor = button; }
    fillPreview(button);
    previewElement.hidden = false;
    placePreview();
  };
  /** After a re-render: new text for the same anchor, leaving any pending open or close alone. */
  const refreshPreview = () => {
    if (!anchor) return;
    if (anchor.hidden || !anchor.isConnected) { hidePreview(); return; }
    fillPreview(anchor); placePreview();
  };
  /** Opens at once when the bubble is already up (moving between items), else after a short hover. */
  const hoverPreview = (button: HTMLButtonElement) => {
    clearTimeout(closeTimer); closeTimer = 0;
    if (!previewElement.hidden) { openPreview(button); return; }
    clearTimeout(openTimer);
    openTimer = window.setTimeout(() => openPreview(button), HOVER_DELAY);
  };
  const leavePreview = () => {
    clearTimeout(openTimer); openTimer = 0;
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hidePreview, LEAVE_GRACE);
  };

  // ---- Rendering ----
  const renderTicks = (markers: readonly ScrollMarker[]) => {
    const existing = new Map(ticks().map(tick => [tick.dataset.scrollKey ?? '', tick]));
    const next = markers.map(marker => {
      const tick = existing.get(marker.key) ?? createTick(marker.key);
      existing.delete(marker.key);
      paintTick(tick, marker);
      return tick;
    });
    const hadFocus = [...existing.values()].some(tick => tick === document.activeElement);
    for (const stale of existing.values()) { if (stale === anchor) hidePreview(); stale.remove(); }
    next.forEach((tick, index) => { if (track.children[index] !== tick) track.insertBefore(tick, track.children[index] ?? null); });
    if (hadFocus) track.querySelector<HTMLButtonElement>('[data-active]')?.focus({ preventScroll: true });
  };

  const modelOf = (snapshot: ThreadScrollSnapshot) => buildScrollIndicatorModel({
    turns: snapshot.turns, activeTurnIndex: activeTurnOf(snapshot), hasOlder: snapshot.hasOlder,
    atBottom: snapshot.atBottom, scrollable: scrollableOf(host.scroller), maxSlots: slots,
  });

  const hide = () => {
    if (!element.hidden) element.hidden = true;
    hidePreview(); endScrub();
  };

  const place = () => {
    if (element.hidden) return;
    const height = element.offsetHeight;
    const top = Math.round(Math.max(band.start, band.start + (band.end - band.start - height) / 2));
    const next = `${top}px`;
    if (element.style.top !== next) element.style.top = next;
    placePreview();
  };

  const sync = () => {
    if (disposed) return;
    const snapshot = host.getSnapshot();
    if (snapshot.hidden || !contextAllows(host)) { state = undefined; hide(); return; }
    band = freeBand(host);
    const height = band.end - band.start;
    if (height < MIN_HEIGHT) { state = undefined; hide(); return; }
    slots = slotsFor(height);
    const model = modelOf(snapshot);
    state = model;
    if (!model.visible) { hide(); return; }
    earlier.hidden = !model.showEarlier;
    latest.hidden = !model.showLatest;
    renderTicks(model.markers);
    if (element.hidden) element.hidden = false;
    rove();
    place();
    refreshPreview();
  };

  /** The scroll-time update: moves the current tick and toggles the latest button, keeping every node. */
  const trackScroll = () => {
    scrollFrame = 0;
    if (disposed || element.hidden || !state) return;
    const snapshot = host.getSnapshot();
    const total = state.markers[0]?.totalTurns ?? 0;
    if (snapshot.hidden || snapshot.turns.length !== total || snapshot.hasOlder !== state.showEarlier) { sync(); return; }
    const model = modelOf(snapshot);
    if (model.markers.length !== state.markers.length) { sync(); return; }
    state = { ...state, showLatest: model.showLatest, activeMarkerIndex: model.activeMarkerIndex, markers: state.markers.map((marker, index) => ({ ...marker, active: index === model.activeMarkerIndex })) };
    ticks().forEach((tick, index) => setActive(tick, index === model.activeMarkerIndex));
    if (latest.hidden === model.showLatest) {
      if (!model.showLatest && document.activeElement === latest) track.querySelector<HTMLButtonElement>('[data-active]')?.focus({ preventScroll: true });
      if (anchor === latest && !model.showLatest) hidePreview();
      latest.hidden = !model.showLatest;
    }
    rove();
  };
  const syncScroll = () => { if (!scrollFrame && !disposed && !element.hidden) scrollFrame = requestAnimationFrame(trackScroll); };

  // A pane or composer resize changes the room (and so the slot count); the rail's own resize only re-centres.
  const observer = new ResizeObserver(entries => {
    if (disposed || layoutFrame) return;
    const roomChanged = entries.some(entry => entry.target !== element);
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; if (roomChanged) sync(); else place(); });
  });
  for (const target of [host.pane, host.composer, element]) observer.observe(target);

  // ---- Activation ----
  let scrub: { pointerId: number; startY: number; active: boolean; target?: HTMLButtonElement } | undefined;
  let swallowClick = false;
  const tickAt = (clientY: number): HTMLButtonElement | undefined => {
    let best: HTMLButtonElement | undefined, distance = Infinity;
    for (const tick of ticks()) {
      const box = tick.getBoundingClientRect(), gap = Math.abs(box.top + box.height / 2 - clientY);
      if (gap < distance) { distance = gap; best = tick; }
    }
    return best;
  };
  const jumpTo = (tick: HTMLButtonElement, viaKeyboard: boolean) => { const id = tick.dataset.targetId; if (id) host.jumpToTurn(id, { viaKeyboard }); };
  function endScrub(): void {
    if (!scrub) return;
    if (track.hasPointerCapture?.(scrub.pointerId)) track.releasePointerCapture(scrub.pointerId);
    scrub = undefined; element.removeAttribute('data-scrubbing');
  }

  element.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || !element.contains(button)) return;
    if (swallowClick) { swallowClick = false; return; }
    const viaKeyboard = event.detail === 0;
    rove(button);
    if (button === earlier) host.loadEarlier();
    else if (button === latest) host.jumpToLatest({ viaKeyboard });
    else jumpTo(button, viaKeyboard);
  });

  track.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    swallowClick = false;
    scrub = { pointerId: event.pointerId, startY: event.clientY, active: false };
  });
  track.addEventListener('pointermove', event => {
    if (!scrub || event.pointerId !== scrub.pointerId) return;
    if (!scrub.active) {
      if (Math.abs(event.clientY - scrub.startY) <= SCRUB_THRESHOLD) return;
      scrub.active = true; element.setAttribute('data-scrubbing', '');
      track.setPointerCapture?.(event.pointerId);
    }
    const tick = tickAt(event.clientY);
    if (tick && tick !== scrub.target) { scrub.target = tick; tick.setAttribute('data-hover', ''); openPreview(tick); }
  });
  track.addEventListener('pointerup', event => {
    if (!scrub || event.pointerId !== scrub.pointerId) return;
    const { active } = scrub;
    const tick = active ? tickAt(event.clientY) : undefined;
    endScrub();
    if (!tick) return;
    // The click that follows a drag would land on whichever tick the drag began on.
    swallowClick = true; window.setTimeout(() => { swallowClick = false; }, 0);
    rove(tick); jumpTo(tick, false);
  });
  track.addEventListener('pointercancel', () => { endScrub(); leavePreview(); });
  track.addEventListener('lostpointercapture', () => { if (scrub?.active) endScrub(); });

  // ---- Hover and focus preview ----
  element.addEventListener('pointerover', event => {
    if (scrub?.active) return;
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button && element.contains(button)) hoverPreview(button);
  });
  element.addEventListener('pointerleave', () => { if (!scrub?.active) leavePreview(); });
  element.addEventListener('focusin', event => { const button = event.target; if (button instanceof HTMLButtonElement) { rove(button); openPreview(button); } });
  element.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) hidePreview(); });

  // ---- Keyboard ----
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (previewElement.hidden) return;
      event.preventDefault(); event.stopPropagation(); hidePreview(); return;
    }
    const list = items();
    if (!list.length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const at = Math.max(0, list.indexOf(focusedItem() ?? list[0]));
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    rove(list[index]); list[index].focus();
  });

  // ---- Wheel pass-through ----
  // The rail sits outside the transcript, so the browser would not chain a wheel to it. The event is re-sent
  // too, because the transcript's own wheel listener releases the bottom pin and fetches older history.
  element.addEventListener('wheel', event => {
    const scroller = host.scroller;
    if (event.ctrlKey || scroller.closest('[inert]')) return;
    scroller.dispatchEvent(new WheelEvent('wheel', event));
    const unit = [1, WHEEL_LINE, scroller.clientHeight][event.deltaMode] ?? 1;
    scroller.scrollTop += event.deltaY * unit;
  }, { passive: true });

  host.scroller.addEventListener('scroll', syncScroll, { passive: true });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(scrollFrame); cancelAnimationFrame(layoutFrame);
    clearTimers(); endScrub();
    host.scroller.removeEventListener('scroll', syncScroll);
    element.remove(); previewElement.remove();
  };

  return { element, previewElement, sync, syncScroll, dispose };
}
