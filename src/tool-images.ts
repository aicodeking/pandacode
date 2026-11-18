import { escape, icon } from './dom.ts';
import { basename } from './tool-text.ts';

/* Images an agent looked at, shown in its tool rows: a chip-sized thumbnail beside the
 * file name (`Viewed [thumb] name.png`), a larger card inside an expanded row, and a
 * viewer (tool-image-viewer.ts) that opens the image fit to the window. The image bytes come from
 * the `tool_image` IPC, which only serves paths that session's tool records mention (relative ones from the
 * task's checkout). Network paths (`\\host\share`, `//host/share`) are never requested. */

/** `maxEdge` asks for the image downscaled to at most that many pixels on its longest side; without it the whole
 * image comes back (the viewer). */
export type ToolImageLoader = (sessionId: string, path: string, maxEdge?: number) => Promise<string>;
export type ToolImageMeta = { caption?: string };
/** Row thumbnails, expanded-row cards, and the viewer's full image. */
export type ToolImageSize = 'thumb' | 'card' | 'full';

/** Longest edge, in pixels, asked of `tool_image` per size (about 2× the shown size, for Retina screens). */
export const IMAGE_EDGES: Readonly<Record<ToolImageSize, number | undefined>> = { thumb: 160, card: 640, full: undefined };
/** Entries kept per size: small thumbnails many, full images (up to 25 MB as data URLs) only a few. */
export const CACHE_LIMITS: Readonly<Record<ToolImageSize, number>> = { thumb: 200, card: 48, full: 8 };
/** Bytes of data URLs kept per size, whatever the count: a full image may be up to 25 MB (about 33 MB as base64),
 * so a few large ones could otherwise hold hundreds of megabytes. */
export const CACHE_BYTES: Readonly<Record<ToolImageSize, number>> = { thumb: 16 * 1024 * 1024, card: 32 * 1024 * 1024, full: 64 * 1024 * 1024 };
const CACHE_LIMIT = CACHE_LIMITS.thumb;
/** The thread a thumbnail was rendered for, stamped when it enters the page so a later thread switch never
 * loads it (or opens it) with another thread's session. */
export const SESSION_ATTR = 'data-tool-image-session';
export const MISSING_TITLE = 'Image no longer available';
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;

export const NETWORK_PATH_ERROR = 'Network image paths are not shown';
/** `tool_image`'s refusal for a remote-mirrored or cloud task: its records name files on that other computer. */
export const ELSEWHERE_ERROR = 'This image is on another machine';
/** Refusals that no retry can change; they are never asked again and their text is the placeholder's title. */
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([ELSEWHERE_ERROR, NETWORK_PATH_ERROR]);

/** The text of a loader rejection: Tauri rejects with the command's error string, other loaders with an Error. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '';
}

/** The title a placeholder shows for a failed load: a permanent refusal's own words, else the generic missing note. */
export const missingTitle = (error: string): string => PERMANENT_ERRORS.has(error) ? error : MISSING_TITLE;

/** UNC and other network spellings (`\\host\share`, `//host/share`, `file://host/…`) and the macOS automount roots
 * (`/net/…`, `/Network/…`), which are never loaded (the backend refuses them too). */
export function isNetworkPath(path: string): boolean {
  const trimmed = path.trim();
  const rest = /^file:\/\//i.test(trimmed) ? trimmed.slice(7) : trimmed;
  if (rest !== trimmed && !rest.startsWith('/')) return true;
  return /^[\\/]{2}/.test(rest) || /^\/(net|network)(\/|$)/i.test(rest);
}

/** The IPC loader for every tool-row image, absolute or relative; imported lazily so this module stays importable
 * outside the webview. */
export const defaultLoader: ToolImageLoader = async (sessionId, path, maxEdge) => {
  if (isNetworkPath(path)) throw new Error(NETWORK_PATH_ERROR);
  const { call } = await import('./bridge.ts');
  return call<string>('tool_image', maxEdge ? { sessionId, path, maxEdge } : { sessionId, path });
};

export { basename };

/** Only an inline raster/vector image URL may become an <img> source. */
export function isImageDataUrl(url: unknown): url is string {
  return typeof url === 'string' && DATA_IMAGE.test(url);
}

export const isAbsolutePath = (path: string): boolean => /^(?:\/|[A-Za-z]:[\\/])/.test(path);

/** Inline thumbnail button plus the file name, for a trace row's title line. */
export function toolImageThumbHtml(path: string): string {
  const name = basename(path);
  return `<button type="button" class="tool-image-thumb" data-tool-image="${escape(path)}" aria-label="Open image ${escape(name)}" title="${escape(path)}">`
    + `${icon('images', 'tool-image-placeholder')}<img alt="" decoding="async" hidden></button>`
    + `<span class="tool-image-name">${escape(name)}</span>`;
}

/** A larger preview for an expanded row card; clicking the image opens the viewer. The row's title
 * already names the file, so the caption carries only meta (size, prompt) and is left out without it. */
export function toolImageCardHtml(path: string, meta: ToolImageMeta = {}): string {
  const name = basename(path);
  const caption = meta.caption ? `<figcaption class="tool-image-card-caption"><span class="tool-image-card-meta">${escape(meta.caption)}</span></figcaption>` : '';
  return `<figure class="tool-image-card">`
    + `<button type="button" class="tool-image-thumb tool-image-card-button" data-tool-image="${escape(path)}" aria-label="Open image ${escape(name)}" title="${escape(path)}">`
    + `${icon('images', 'tool-image-placeholder')}<img alt="" decoding="async" hidden></button>`
    + `${caption}</figure>`;
}

/** A failed load may be tried again this long after it failed. */
export const RETRY_MS = 5_000;
/** Retries after the first failure, timed or forced (a viewer opening, a row rendering again). */
export const MAX_RETRIES = 3;
/** A forced retry (viewer open, row re-render) still waits this long after the last failure. */
const FORCED_RETRY_GAP_MS = 1_000;

/** `maxBytes` bounds the summed length of cached data URLs (the newest entry always stays). */
export type ImageCacheOptions = { now?: () => number; maxEdge?: number; maxBytes?: number };
export type ImageGetOptions = { retry?: boolean };
/** `failedAt` is 0 while the load is pending or after it succeeded; `error` is the last failure's text; `bytes` the
 * length of a loaded data URL (0 until it loads). */
type CacheEntry = { readonly promise: Promise<string | null>; readonly failures: number; readonly failedAt: number; readonly error: string; readonly bytes: number };
type LoadResult = { readonly url: string | null; readonly error: string };

function startLoad(load: ToolImageLoader, sessionId: string, path: string, maxEdge?: number): Promise<LoadResult> {
  const ask = () => maxEdge ? load(sessionId, path, maxEdge) : load(sessionId, path);
  return Promise.resolve().then(ask).then(
    url => isImageDataUrl(url) ? { url, error: '' } : { url: null, error: '' },
    (error: unknown) => ({ url: null, error: errorText(error) }),
  );
}

/** Loads image URLs once per session and path (at `maxEdge`, when given) and keeps the most recent `limit` entries,
 * dropping the oldest while their data URLs sum to more than `maxBytes`. Successes stay cached;
 * a failure is tried again once `RETRY_MS` has passed, or with `{ retry: true }` (the viewer opening, a row rendering
 * again) once a short gap has passed; either way at most `MAX_RETRIES` times. Network paths are never loaded. */
export function createImageCache(load: ToolImageLoader = defaultLoader, limit = CACHE_LIMIT, { now = Date.now, maxEdge, maxBytes = Infinity }: ImageCacheOptions = {}) {
  const entries = new Map<string, CacheEntry>();
  let bytes = 0;
  const put = (key: string, entry: CacheEntry) => { drop(key); entries.set(key, entry); bytes += entry.bytes; };
  const drop = (key: string) => { bytes -= entries.get(key)?.bytes ?? 0; entries.delete(key); };
  /** Evicts the least recently used entries past `limit` or `maxBytes`; `keep` (the newest load) always stays. */
  const trim = (keep: string) => {
    for (const key of entries.keys()) {
      if (entries.size <= limit && bytes <= maxBytes) return;
      if (key !== keep) drop(key);
    }
  };
  const retryable = (entry: CacheEntry, force: boolean): boolean => {
    if (!entry.failedAt) return false;
    const waited = now() - entry.failedAt;
    // Forced retries (viewer open, row re-render) wait a shorter gap but share the cap, so a missing file is not polled forever.
    return entry.failures <= MAX_RETRIES && waited >= (force ? FORCED_RETRY_GAP_MS : RETRY_MS);
  };
  const begin = (key: string, sessionId: string, path: string, failures: number): Promise<string | null> => {
    const promise = startLoad(load, sessionId, path, maxEdge).then(({ url, error }) => {
      const current = entries.get(key);
      // A permanent refusal (another machine, a network path) uses up its retries at once.
      const failed = PERMANENT_ERRORS.has(error) ? MAX_RETRIES + 1 : failures + 1;
      if (current?.promise === promise) {
        put(key, { promise, failures: url ? 0 : failed, failedAt: url ? 0 : now() || 1, error: url ? '' : error, bytes: url?.length ?? 0 });
        trim(key);
      }
      return url;
    });
    put(key, { promise, failures, failedAt: 0, error: '', bytes: 0 });
    trim(key);
    return promise;
  };
  return {
    get(sessionId: string, path: string, { retry = false }: ImageGetOptions = {}): Promise<string | null> {
      if (isNetworkPath(path)) return Promise.resolve(null);
      const key = sessionId + '\0' + path;
      const hit = entries.get(key);
      if (!hit) return begin(key, sessionId, path, 0);
      if (retryable(hit, retry)) return begin(key, sessionId, path, hit.failures);
      put(key, hit);
      return hit.promise;
    },
    /** The last failure's text for a session and path ('' when none, or after a success). */
    failure(sessionId: string, path: string): string {
      if (isNetworkPath(path)) return NETWORK_PATH_ERROR;
      return entries.get(sessionId + '\0' + path)?.error ?? '';
    },
    get size(): number { return entries.size; },
    /** The summed length of the cached data URLs. */
    get bytes(): number { return bytes; },
    clear(): void { entries.clear(); bytes = 0; },
  };
}
export type ToolImageCache = ReturnType<typeof createImageCache>;

const caches = new WeakMap<ToolImageLoader, Map<ToolImageSize, ToolImageCache>>();
/** The shared cache for a loader and size, so rows, cards and the viewer each load an image once at their size;
 * thumbnails and full images are cached apart, the full ones far fewer. */
export function toolImageCache(load: ToolImageLoader = defaultLoader, size: ToolImageSize = 'thumb'): ToolImageCache {
  let sizes = caches.get(load);
  if (!sizes) { sizes = new Map(); caches.set(load, sizes); }
  let cache = sizes.get(size);
  if (!cache) { cache = createImageCache(load, CACHE_LIMITS[size], { maxEdge: IMAGE_EDGES[size], maxBytes: CACHE_BYTES[size] }); sizes.set(size, cache); }
  return cache;
}

/** The size a `[data-tool-image]` button shows: a card's preview or a row's thumbnail. */
export const buttonSize = (button: Element): ToolImageSize => button.classList.contains('tool-image-card-button') ? 'card' : 'thumb';

/** Stamp every `[data-tool-image]` under `root` that has no thread yet with `sessionId`; call it as the buttons
 * enter the page. Returns how many were stamped. */
export function bindToolImages(root: ParentNode, sessionId: string): number {
  if (!sessionId) return 0;
  let bound = 0;
  for (const button of root.querySelectorAll<HTMLElement>(`[data-tool-image]:not([${SESSION_ATTR}])`)) {
    button.setAttribute(SESSION_ATTR, sessionId);
    bound++;
  }
  return bound;
}

/** The thread a button belongs to: its stamp, else `fallback`. */
export const buttonSession = (button: Element, fallback = ''): string => button.getAttribute(SESSION_ATTR) || fallback;

function fill(button: HTMLElement, url: string | null, error = ''): void {
  const img = button.querySelector<HTMLImageElement>('img');
  if (!img || !button.isConnected) return;
  if (!url) { button.classList.add('is-missing'); button.title = missingTitle(error); return; }
  img.src = url; img.hidden = false;
  button.classList.remove('is-missing');
  button.classList.add('is-loaded');
  button.title = button.dataset.toolImage ?? '';
}

/** Run `attempt` again after `RETRY_MS` while `element` stays in the page, at most `MAX_RETRIES` times per element. */
export function retryLater(element: HTMLElement, attempt: () => void): void {
  const tries = Number(element.dataset.toolImageRetries ?? 0);
  if (tries >= MAX_RETRIES) return;
  element.dataset.toolImageRetries = String(tries + 1);
  setTimeout(() => { if (element.isConnected) attempt(); }, RETRY_MS);
}

/** Load (or retry) one button's image, at its size and with the thread it was stamped with; a failure is tried
 * again a few times while the button stays. A button rendered afresh asks with `retry`, so a row that re-renders
 * retries a failed image. */
function loadButton(button: HTMLElement, load: ToolImageLoader): void {
  const path = button.dataset.toolImage, sessionId = buttonSession(button);
  const state = button.dataset.toolImageState;
  if (!path || !sessionId || (state && state !== 'missing')) return;
  button.dataset.toolImageState = 'loading';
  const cache = toolImageCache(load, buttonSize(button));
  void cache.get(sessionId, path, { retry: !state }).then(url => {
    const error = url ? '' : cache.failure(sessionId, path);
    button.dataset.toolImageState = url ? 'loaded' : 'missing';
    fill(button, url, error);
    if (!url && !PERMANENT_ERRORS.has(error)) retryLater(button, () => loadButton(button, load));
  });
}

const observers = new WeakMap<ParentNode, IntersectionObserver>();

/** Fill every unloaded `[data-tool-image]` under `root`, lazily once near the viewport when possible. Buttons
 * not yet stamped with a thread take `sessionId`; stamped ones always load with their own. */
export function hydrateToolImages(root: ParentNode, sessionId: string, load: ToolImageLoader = defaultLoader): void {
  bindToolImages(root, sessionId);
  const buttons = [...root.querySelectorAll<HTMLElement>('[data-tool-image]')].filter(button => !button.dataset.toolImageState && !button.querySelector('img')?.getAttribute('src'));
  if (!buttons.length) return;
  if (typeof IntersectionObserver !== 'function') { buttons.forEach(button => loadButton(button, load)); return; }
  let observer = observers.get(root);
  if (!observer) {
    const created = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        created.unobserve(entry.target);
        loadButton(entry.target as HTMLElement, load);
      }
    }, { rootMargin: '200px 0px' });
    observers.set(root, created);
    observer = created;
  }
  for (const button of buttons) observer.observe(button);
}
