import { escape, icon, isImeKey } from './dom.ts';
import { isMac, isWindows } from './platform.ts';
import { basename, bindToolImages, buttonSession, defaultLoader, hydrateToolImages, isAbsolutePath, isImageDataUrl, isNetworkPath, MISSING_TITLE, missingTitle, toolImageCache, type ToolImageLoader } from './tool-images.ts';

/* The viewer for images agents viewed (tool-images.ts): opens fit to the window with the full image (rows and
 * cards hold downscaled copies); the image toggles actual size when it is larger than the window; previous/next (buttons or ←/→) step through every image in the same container; the header shows
 * the path, the pixel size, Copy path and the platform's reveal (Reveal in Finder, Show in Explorer, Open folder). Also the wiring that gives any container
 * lazily loading thumbnails that open it (`attachToolImages`). */

/** `sessionId` is the fallback for a button not stamped with its thread (see `bindToolImages`). */
/** Where the viewer opens. The launcher window (overlay-thread.ts) may not call `reveal_path`, so its viewer has
 * no Reveal button, and it loads neither motion.css nor design-system.css, so its dialog carries `is-launcher`,
 * under which tool-images.css supplies the tokens and raised button it needs. */
export type ToolImageSurface = { launcher?: boolean };
export type ToolImageViewerOptions = ToolImageSurface & { sessionId?: string; load?: ToolImageLoader; scope?: ParentNode | null };
/** The class a launcher viewer's dialog carries. */
export const LAUNCHER_CLASS = 'is-launcher';
/** `session` is the thread the button was rendered for: a held transcript may mix threads, and each image loads with its own. */
type ViewerItem = { readonly path: string; readonly shown: string | null; readonly session: string };

const COPY_LABEL = 'Copy path';
const COPIED_LABEL = 'Copied';
const COPY_FEEDBACK_MS = 1500;
const FIT_LABEL = 'Show actual size';
const ACTUAL_LABEL = 'Fit to window';
/** The zoom button's name when the image already shows every pixel, so there is nothing to toggle. */
const FITS_LABEL = 'Shown at actual size';
/** The same wording as the file menus' reveal item in main.ts. */
export const REVEAL_LABEL = isMac ? 'Reveal in Finder' : isWindows ? 'Show in Explorer' : 'Open folder';
export const REVEAL_FAILED = 'Couldn’t reveal the file';

/** Every distinct image (thread and path) under `scope` in document order, with the URL a loaded button already
 * shows; a button not stamped with its thread takes `fallback`. */
export function toolImageItems(scope: ParentNode, fallback = ''): ViewerItem[] {
  const items = new Map<string, ViewerItem>();
  for (const button of scope.querySelectorAll<HTMLElement>('[data-tool-image]')) {
    const path = button.dataset.toolImage;
    if (!path) continue;
    const session = buttonSession(button, fallback), key = `${session}\n${path}`;
    const src = button.querySelector('img')?.getAttribute('src');
    const url = isImageDataUrl(src) ? src : null;
    const seen = items.get(key);
    if (!seen || (url && !seen.shown)) items.set(key, { path, shown: url, session });
  }
  return [...items.values()];
}

const nav = (step: 'prev' | 'next', label: string, key: string) =>
  `<button type="button" class="tool-image-viewer-step is-${step}" data-tool-image-action="${step}" aria-label="${label} image" title="${label} (${key})">${icon('chevron')}</button>`;

// The header keeps one layout whatever the image: the titles take the space left and ellipsize; the file actions
// (Reveal, then Copy) are their own group, and Previous/Next/Close a fixed group pinned to the end. A Reveal that
// does not apply leaves the layout (no gap), and since it sits before Copy, Copy and the end group never move
// under the pointer while stepping.
function viewerHtml(reveal: boolean): string {
  return `<div class="tool-image-viewer-plate">
    <header class="tool-image-viewer-head"><div class="tool-image-viewer-titles"><h2 class="tool-image-viewer-name"></h2>
      <p class="tool-image-viewer-meta"><span class="tool-image-viewer-path"></span><span class="tool-image-viewer-size"></span><span class="tool-image-viewer-notice" role="status" aria-live="polite"></span></p></div>
    <div class="tool-image-viewer-actions">
    ${reveal ? `<button type="button" class="ds-btn tool-image-viewer-action" data-tool-image-action="reveal" aria-label="${REVEAL_LABEL}" title="${REVEAL_LABEL}">${icon('folder')}<span>${REVEAL_LABEL}</span></button>` : ''}
    <button type="button" class="ds-btn tool-image-viewer-action" data-tool-image-action="copy" aria-label="${COPY_LABEL}" title="${COPY_LABEL}">${icon('copy')}<span class="tool-image-viewer-copy-label" data-alt="${COPIED_LABEL}"><span>${COPY_LABEL}</span></span></button></div>
    <div class="tool-image-viewer-controls"><div class="tool-image-viewer-nav" hidden>${nav('prev', 'Previous', '←')}<span class="tool-image-viewer-count" aria-live="polite"></span>${nav('next', 'Next', '→')}</div>
    <button type="button" class="tool-image-viewer-close" data-tool-image-action="close" aria-label="Close image" title="Close (Esc)">${icon('close')}</button></div></header>
    <div class="tool-image-viewer-stage"><button type="button" class="tool-image-viewer-zoom" data-tool-image-action="zoom" aria-pressed="false" aria-label="${FIT_LABEL}" title="${FIT_LABEL}"><img class="tool-image-viewer-image" alt="" hidden></button>
      <p class="tool-image-viewer-missing" hidden>${escape(MISSING_TITLE)}</p></div></div>`;
}

let openViewer: HTMLDialogElement | null = null;

/** One open viewer: its dialog, the images it steps through, and the parts it updates. */
type Viewer = {
  readonly dialog: HTMLDialogElement;
  readonly items: readonly ViewerItem[];
  readonly load: ToolImageLoader;
  readonly returnFocus: HTMLElement | null;
  /** False in the launcher, whose viewer has no Reveal button. */
  readonly canReveal: boolean;
  readonly image: HTMLImageElement;
  readonly zoom: HTMLButtonElement;
  readonly stage: HTMLElement;
  readonly size: HTMLElement;
  readonly copyLabel: HTMLElement;
  /** The shown item, the token of its load (a stale load is dropped) and the Copy feedback timer. */
  index: number;
  shownToken: number;
  copyTimer: number;
};

const part = <T extends HTMLElement>(viewer: Viewer, selector: string) => viewer.dialog.querySelector<T>(selector)!;
const action = (viewer: Viewer, name: string) => part<HTMLButtonElement>(viewer, `[data-tool-image-action="${name}"]`);

const sameItem = (a: ViewerItem, b: ViewerItem) => a.path === b.path && a.session === b.session;

/** The images the viewer steps through: those in `scope` when it lists the clicked one, else just that one. */
function viewerItems(button: HTMLElement, clicked: ViewerItem, scope: ParentNode | null, fallback: string): ViewerItem[] {
  const listed = scope ? toolImageItems(scope, fallback) : [];
  if (listed.some(item => sameItem(item, clicked))) return listed;
  const src = button.querySelector('img')?.getAttribute('src');
  return [{ ...clicked, shown: isImageDataUrl(src) ? src : null }];
}

function createViewer(items: readonly ViewerItem[], clicked: ViewerItem, load: ToolImageLoader, launcher: boolean): Viewer {
  const returnFocus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'tool-image-viewer';
  dialog.classList.toggle(LAUNCHER_CLASS, launcher);
  dialog.innerHTML = viewerHtml(!launcher);
  document.body.append(dialog);
  const find = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  return {
    dialog, items, load, returnFocus, canReveal: !launcher,
    image: find<HTMLImageElement>('.tool-image-viewer-image'),
    zoom: find<HTMLButtonElement>('[data-tool-image-action="zoom"]'),
    stage: find('.tool-image-viewer-stage'),
    size: find('.tool-image-viewer-size'),
    copyLabel: find('.tool-image-viewer-copy-label'),
    index: Math.max(0, items.findIndex(item => sameItem(item, clicked))),
    shownToken: 0,
    copyTimer: 0,
  };
}

function setActual(viewer: Viewer, actual: boolean): void {
  const { dialog, zoom, stage } = viewer;
  dialog.classList.toggle('is-actual', actual);
  zoom.setAttribute('aria-pressed', String(actual));
  zoom.setAttribute('aria-label', actual ? ACTUAL_LABEL : FIT_LABEL);
  zoom.title = actual ? ACTUAL_LABEL : FIT_LABEL;
  if (actual) stage.scrollTo({ left: (stage.scrollWidth - stage.clientWidth) / 2, top: (stage.scrollHeight - stage.clientHeight) / 2 });
  else updateZoomable(viewer);
}

/** Fit to the window, a loaded image drawn at its natural size has nothing more to show: the zoom button turns off
 * (no zoom cursor, no "Show actual size") until the image no longer fits, e.g. after the window shrinks. */
function updateZoomable(viewer: Viewer): void {
  const { dialog, image, zoom } = viewer;
  if (dialog.classList.contains('is-actual')) return;
  const loaded = !image.hidden && image.naturalWidth > 0;
  const fits = loaded && image.naturalWidth <= image.clientWidth && image.naturalHeight <= image.clientHeight;
  if (zoom.disabled === fits) return;
  zoom.disabled = fits;
  zoom.classList.toggle('is-fit', fits);
  zoom.setAttribute('aria-label', fits ? FITS_LABEL : FIT_LABEL);
  zoom.title = fits ? '' : FIT_LABEL;
  keepFocus(viewer);
}

/** Name, path, count and step/reveal buttons for the shown item. */
function showHeader(viewer: Viewer, item: ViewerItem): void {
  const { items, index } = viewer, name = basename(item.path);
  viewer.dialog.setAttribute('aria-label', name);
  part(viewer, '.tool-image-viewer-name').textContent = name;
  const pathLine = part(viewer, '.tool-image-viewer-path');
  // Cut in the middle: the folder ellipsizes, the file name at the end always shows.
  const cut = Math.max(item.path.lastIndexOf('/'), item.path.lastIndexOf('\\'));
  const head = document.createElement('span'), tail = document.createElement('span');
  head.className = 'tool-image-viewer-path-head'; tail.className = 'tool-image-viewer-path-tail';
  head.textContent = item.path.slice(0, cut + 1); tail.textContent = item.path.slice(cut + 1);
  pathLine.replaceChildren(head, tail); pathLine.title = item.path;
  part(viewer, '.tool-image-viewer-nav').hidden = items.length < 2;
  part(viewer, '.tool-image-viewer-count').textContent = `${index + 1} of ${items.length}`;
  action(viewer, 'prev').disabled = index === 0;
  action(viewer, 'next').disabled = index === items.length - 1;
  // Reveal leaves the header for relative and network paths; it sits before Copy, so nothing else moves.
  const reveal = viewer.canReveal ? action(viewer, 'reveal') : null, off = !isAbsolutePath(item.path) || isNetworkPath(item.path);
  if (reveal) { reveal.disabled = off; reveal.hidden = off; }
  showNotice(viewer, '');
}

/** Fill the stage with the item's full image (rows only hold downscaled copies), or the missing note; opening the
 * viewer retries a failed load. Without a thread, the copy a button already shows is all there is. */
function loadStage(viewer: Viewer, item: ViewerItem, token: number): void {
  const { dialog, image, zoom, load } = viewer, sessionId = item.session;
  const shown = isImageDataUrl(item.shown) ? item.shown : null;
  const full = toolImageCache(load, 'full');
  const source = sessionId ? full.get(sessionId, item.path, { retry: true }) : Promise.resolve(shown);
  void source.then(url => {
    if (!dialog.isConnected || token !== viewer.shownToken) return;
    if (url) { image.src = url; image.hidden = false; return; }
    zoom.hidden = true;
    const missing = part(viewer, '.tool-image-viewer-missing');
    missing.textContent = missingTitle(sessionId ? full.failure(sessionId, item.path) : '');
    missing.hidden = false;
    keepFocus(viewer);
  });
}

function show(viewer: Viewer, next: number): void {
  viewer.index = next;
  const item = viewer.items[next], token = ++viewer.shownToken;
  const { image, zoom, size } = viewer;
  showHeader(viewer, item);
  // A new image may need zooming again; its load decides (`updateZoomable`).
  zoom.disabled = false; zoom.classList.remove('is-fit');
  setActual(viewer, false);
  size.textContent = '';
  // The zoom button stays while the next image loads, so focus on it survives the step.
  zoom.hidden = false; image.hidden = true; image.removeAttribute('src'); image.alt = basename(item.path);
  part(viewer, '.tool-image-viewer-missing').hidden = true;
  keepFocus(viewer);
  loadStage(viewer, item, token);
}

// A step button turns disabled at either end (and the zoom button hides on a missing image); focus then moves
// to a live control in the dialog, so ←/→ and Esc keep working.
function keepFocus(viewer: Viewer): void {
  const { dialog } = viewer;
  const active = document.activeElement as HTMLButtonElement | null;
  if (active && dialog.contains(active) && !active.disabled && !active.closest('[hidden]')) return;
  if (!dialog.open) return;
  const prev = action(viewer, 'prev'), next = action(viewer, 'next');
  const other = active === prev ? next : active === next ? prev : null;
  (other && !other.disabled ? other : action(viewer, 'close')).focus();
}

function step(viewer: Viewer, delta: number): void {
  const next = viewer.index + delta;
  if (next >= 0 && next < viewer.items.length) show(viewer, next);
}

function copyPath(viewer: Viewer): void {
  // The slot stacks the shown label over a hidden copy of the other (`data-alt`), so it is as wide as the wider.
  // The name follows the label: at phone width the button is icon-only and the aria-label is all a reader hears.
  const label = (text: string, alt: string) => {
    viewer.copyLabel.firstElementChild!.textContent = text; viewer.copyLabel.dataset.alt = alt;
    viewer.copyLabel.parentElement!.setAttribute('aria-label', text);
  };
  const flash = (text: string) => {
    label(text, COPY_LABEL);
    clearTimeout(viewer.copyTimer);
    viewer.copyTimer = window.setTimeout(() => label(COPY_LABEL, COPIED_LABEL), COPY_FEEDBACK_MS);
  };
  const target = viewer.items[viewer.index].path;
  Promise.resolve().then(() => navigator.clipboard.writeText(target))
    .then(() => flash(COPIED_LABEL), error => { console.error('Copy path failed', error); flash('Couldn’t copy'); });
}

/** The inline status line in the header (a failed reveal); the live region stays in the page so it announces. */
function showNotice(viewer: Viewer, text: string): void {
  part(viewer, '.tool-image-viewer-notice').textContent = text;
}

function revealPath(viewer: Viewer): void {
  if (!viewer.canReveal) return;
  const target = viewer.items[viewer.index].path, index = viewer.index;
  showNotice(viewer, '');
  void import('./bridge.ts').then(({ call }) => call('reveal_path', { path: target })).catch(error => {
    console.error('reveal_path failed', error);
    if (viewer.dialog.isConnected && viewer.index === index) showNotice(viewer, REVEAL_FAILED);
  });
}

function closeViewer(viewer: Viewer): void {
  const { dialog, returnFocus } = viewer;
  if (!dialog.isConnected) return;
  clearTimeout(viewer.copyTimer);
  if (dialog.open) dialog.close();
  dialog.remove();
  if (openViewer === dialog) openViewer = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function onViewerKey(viewer: Viewer, event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isImeKey(event)) return;
  // Escape closes the viewer here rather than through `cancel`: a page-level Escape handler (the launcher's goes
  // back to its task list) would otherwise act too, and its preventDefault would keep `cancel` from firing.
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeViewer(viewer); return; }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  step(viewer, event.key === 'ArrowLeft' ? -1 : 1);
}

function onViewerClick(viewer: Viewer, event: MouseEvent): void {
  const name = (event.target as Element).closest<HTMLElement>('[data-tool-image-action]')?.dataset.toolImageAction;
  if (event.target === viewer.dialog || name === 'close') { closeViewer(viewer); return; }
  if (name === 'prev' || name === 'next') step(viewer, name === 'prev' ? -1 : 1);
  else if (name === 'zoom') setActual(viewer, !viewer.dialog.classList.contains('is-actual'));
  else if (name === 'copy') copyPath(viewer);
  else if (name === 'reveal') revealPath(viewer);
}

function wireViewer(viewer: Viewer): void {
  const { dialog, image, size } = viewer;
  image.addEventListener('load', () => {
    size.textContent = image.naturalWidth ? `${image.naturalWidth} × ${image.naturalHeight}` : '';
    updateZoomable(viewer);
  });
  const resized = () => updateZoomable(viewer);
  window.addEventListener('resize', resized);
  dialog.addEventListener('close', () => window.removeEventListener('resize', resized), { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(viewer); });
  dialog.addEventListener('close', () => closeViewer(viewer));
  dialog.addEventListener('keydown', event => onViewerKey(viewer, event));
  dialog.addEventListener('click', event => onViewerClick(viewer, event));
}

/** Open the image a `[data-tool-image]` button points at, fit to the window, among the images in `scope`. */
export function openToolImage(button: HTMLElement, options: ToolImageViewerOptions = {}): HTMLDialogElement | null {
  const path = button.dataset.toolImage;
  if (!path) return null;
  const { load = defaultLoader, scope = null } = options;
  const fallback = options.sessionId ?? '';
  const clicked: ViewerItem = { path, shown: null, session: buttonSession(button, fallback) };
  const items = viewerItems(button, clicked, scope, fallback);
  openViewer?.close();
  const viewer = createViewer(items, clicked, load, options.launcher === true);
  wireViewer(viewer);
  show(viewer, viewer.index);
  openViewer = viewer.dialog;
  viewer.dialog.showModal();
  action(viewer, 'close').focus();
  return viewer.dialog;
}

/** Delegate clicks and Enter/Space on `[data-tool-image]` under `root`; the parent <details> never toggles. */
export function installToolImageClicks(root: HTMLElement, sessionId: () => string, load: ToolImageLoader = defaultLoader, { launcher = false }: ToolImageSurface = {}): () => void {
  const target = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>('[data-tool-image]') ?? null;
  const open = (event: Event) => {
    const button = target(event);
    if (!button || !root.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    openToolImage(button, { sessionId: sessionId(), load, scope: root, launcher });
  };
  const onKey = (event: KeyboardEvent) => {
    if ((event.key === 'Enter' || event.key === ' ') && !isImeKey(event)) open(event);
  };
  root.addEventListener('click', open, true);
  root.addEventListener('keydown', onKey, true);
  return () => { root.removeEventListener('click', open, true); root.removeEventListener('keydown', onKey, true); };
}

/** Give any container working image thumbnails: they load once near the viewport, whichever render inserted
 * them (one pass per frame), and open the viewer without toggling the row around them. Returns a detach. */
export function attachToolImages(container: HTMLElement, sessionId: () => string, load: ToolImageLoader = defaultLoader, surface: ToolImageSurface = {}): () => void {
  let frame = 0;
  // Buttons take the thread that rendered them in the mutation's microtask, before any thread switch can run, so
  // rows a held transcript still shows after a switch keep loading and opening with their own thread.
  const bind = () => bindToolImages(container, sessionId());
  const hydrate = () => {
    bind();
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; const id = sessionId(); if (id) hydrateToolImages(container, id, load); });
  };
  const mutations = new MutationObserver(hydrate);
  mutations.observe(container, { childList: true, subtree: true });
  const releaseClicks = installToolImageClicks(container, sessionId, load, surface);
  hydrate();
  return () => { mutations.disconnect(); cancelAnimationFrame(frame); frame = 0; releaseClicks(); };
}
