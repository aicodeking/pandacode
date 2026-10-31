/// <reference types="vite/client" />
import type { FileDiff, FileDiffMetadata, FileDiffOptions, VirtualizedFileDiff, Virtualizer } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
// A real module URL, not a blob: the app CSP allows no blob: workers.
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { likelyFileNames, patchKey, splitPatch, type PatchChunk } from './diff-prefetch';
import './diff-viewer.css';

export interface DiffViewerInput {
  patch: string;
  path?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
  layout?: 'unified' | 'split';
  /**
   * The element that scrolls when the viewer itself does not (a list of inline diffs).
   * Its first element child must hold all of its content: large files are virtualized
   * against it, and the virtualizer watches that child for scroll-height changes.
   */
  scrollRoot?: HTMLElement;
  /** Constant CSS added to every diff's shadow root (never patch content). */
  shadowCSS?: string;
}

export interface DiffViewerController {
  /** Resolves after the first render or a safe fallback; never rejects. */
  ready: Promise<void>;
  /** Safe to call during the lazy import, and more than once. */
  dispose(): void;
}

// FileDiff's public, framework-free API: https://diffs.com/docs
// https://github.com/pierrecomputer/pierre/tree/main/packages/diffs
// Shiki (Oniguruma WASM) highlights in a small worker pool: the main thread paints
// plain rows at once and swaps in highlighted ones when the worker answers, or paints
// highlighted rows at once when the pool already holds them (primed on hover, or a
// reopened file). The pool highlights whole files only, so long files are split into
// hunk groups (splitPatch) that parse, mount and highlight first-screen first. If the
// workers cannot start, everything renders on the main thread.
const MAX_PATCH_LENGTH = 2_000_000;
const MAX_PATCH_LINES = 40_000;
// Above this many patch lines, files render virtualized (only rows near the viewport).
const VIRTUALIZE_LINES = 500;
// Rows rendered beyond the viewport, and the batch they are added in. Pierre's defaults
// (1000 px, 50 lines) put more highlighted rows into each scroll frame than WebKit can
// lay out in 34 ms on a 30k-line diff.
const OVERSCROLL_PX = 400;
const RENDER_BATCH_LINES = 20;
const POOL_SIZE = 2;
// A file (hunk group) with more lines than this on one side renders plain: applying a
// highlighted result that large blocks the main thread (30k lines ≈ 250 ms, so 5k ≈ 40 ms).
// Long files are split into hunk groups, so this only leaves single huge hunks uncoloured.
const TOKENIZE_MAX_LINES = 5_000;
// Highlighted ASTs the pool keeps (per hunk group), so memory stays bounded.
const AST_CACHE_ENTRIES = 20;
// Hover priming highlights about one screen and a half.
const PRIME_LINES = 150;
// A virtualized diff primes at most this many hunk groups around the viewport (well
// under AST_CACHE_ENTRIES), nearest first, with at most POOL_SIZE in flight, so a
// newly visible group never waits behind a queue of offscreen ones.
const PRIME_WINDOW = 6;
// Offscreen priming waits until scrolling has paused this long, so no highlighted result
// lands mid-scroll; visible groups request their own highlighting as they render.
const SCROLL_SETTLE_MS = 120;
// Mounting yields to the next frame after this much work, so no task blocks for long.
const FIRST_SLICE_MS = 12;
const SLICE_MS = 8;
// Grammars the pool loads in the background after it starts.
const COMMON_FILES = ['a.ts', 'a.tsx', 'a.js', 'a.json', 'a.css', 'a.html', 'a.md', 'a.rs', 'a.py', 'a.go', 'a.sh', 'a.yaml', 'a.toml'];
const THEMES = { dark: 'pierre-dark', light: 'pierre-light' } as const;
// The pool's options override each viewer's theme and line-diff options, so both use these.
const HIGHLIGHT = { theme: THEMES, lineDiffType: 'word-alt', maxLineDiffLength: 1_000, tokenizeMaxLineLength: 2_000 } as const;
const MAX_FILES = 40;
const RAW_PREVIEW_LENGTH = 100_000;
const RAW_PREVIEW_LINES = 1_200;
const SPLIT_MIN_WIDTH = 680;
const mountedViewers = new WeakMap<HTMLElement, DiffViewerController>();
// One Virtualizer per scroll root, shared by every viewer in it: each Virtualizer keeps
// its own scroll anchor and applies its own scroll fix, so several on one root would
// correct the same scrollTop for different anchors, and each would only notice its own
// content's size changes.
const sharedVirtualizers = new WeakMap<HTMLElement, { virtualizer: Virtualizer; users: number }>();
function acquireVirtualizer(lib: Diffs, root: HTMLElement): Virtualizer {
  let shared = sharedVirtualizers.get(root);
  if (!shared) {
    shared = { virtualizer: new lib.Virtualizer({ overscrollSize: OVERSCROLL_PX }), users: 0 };
    // Without a content container, pierre observes the root's first element child.
    shared.virtualizer.setup(root);
    sharedVirtualizers.set(root, shared);
  }
  shared.users++;
  return shared.virtualizer;
}
function releaseVirtualizer(root: HTMLElement): void {
  const shared = sharedVirtualizers.get(root);
  if (!shared || --shared.users > 0) return;
  shared.virtualizer.cleanUp();
  sharedVirtualizers.delete(root);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function themeType(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function rawPreview(patch: string): { text: string; clipped: boolean } {
  const prefix = patch.slice(0, RAW_PREVIEW_LENGTH);
  let end = prefix.length;
  let lines = 0;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '\n' && ++lines === RAW_PREVIEW_LINES) { end = i; break; }
  }
  return { text: prefix.slice(0, end), clipped: end < patch.length };
}

function lineCount(patch: string): number {
  let lines = 1;
  for (let i = patch.indexOf('\n'); i !== -1; i = patch.indexOf('\n', i + 1)) lines++;
  return lines;
}

type Diffs = typeof import('@pierre/diffs');
type EngineName = 'worker-wasm' | 'main-wasm' | 'main-js';
interface Engine { lib: Diffs; pool?: WorkerPoolManager; highlighter: 'shiki-wasm' | 'shiki-js'; name: EngineName }
let engine: Promise<Engine> | undefined;

const highlightable = (file: FileDiffMetadata) => Math.max(file.additionLines.length, file.deletionLines.length) <= TOKENIZE_MAX_LINES;

function parseChunk(lib: Diffs, path: string, chunk: PatchChunk): FileDiffMetadata[] {
  return lib.parsePatchFiles(chunk.text, patchKey(path, chunk.text), true).flatMap(patch => patch.files);
}

const idle = () => new Promise<void>(resolve => typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 1_000 }) : setTimeout(resolve, 30));
const poolBusy = (pool: WorkerPoolManager) => { const stats = pool.getStats(); return stats.busyWorkers > 0 || stats.queuedTasks > 0; };

// Code-like lines in no particular language: tokenizing them compiles the grammar's
// common rules (Oniguruma compiles each on first use), not just its entry point.
const WARM_HUNK = '@@ -1,2 +1,2 @@\n-import { a } from "b"; const c = { d: [1, \'e\', true], f: (g) => g?.h ?? null }; // i\n'
  + '-export function j(k: number): string { if (k > 2) return `l${k}`; } /* m */\n'
  + '+def n(o): return [p for p in o if p] # q\n+- r: s\n';

/**
 * Loads grammars into the main thread and a worker, one per idle period while the pool
 * has nothing visible to do: the languages in the current git status first, then common ones.
 */
async function warmLanguages(lib: Diffs, pool: WorkerPoolManager): Promise<void> {
  const warmed = new Set<string>(['text']);
  // The status list's own languages go first and at once: the next click is likely one of them.
  // The first language warms in one worker at once (a click may be coming); the other
  // workers get it with the rest, when idle.
  const queue = likelyFileNames().length ? [{ name: likelyFileNames()[0], copies: 1 }] : [];
  for (let first = queue.length > 0; ; first = false) {
    if (!first) await idle();
    if (!first && poolBusy(pool)) continue;
    let next = queue.shift();
    if (!next) {
      const name = [...likelyFileNames(), ...COMMON_FILES].find(candidate => !warmed.has(lib.getFiletypeFromFileName(candidate)));
      if (!name) return;
      next = { name, copies: POOL_SIZE };
    }
    const { name, copies } = next;
    if (copies < POOL_SIZE) queue.push({ name, copies: POOL_SIZE }); else warmed.add(lib.getFiletypeFromFileName(name));
    try {
      // Copies are sent together so each free worker takes one: any free worker takes the
      // next task, so a grammar warmed in only one would compile again in the other.
      const files = Array.from({ length: copies }, (_, copy) => lib.parsePatchFiles(`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${WARM_HUNK}`, `warm:${copies}:${copy}:${name}`, true)[0].files[0]);
      await Promise.all(files.map(file => pool.primeDiffHighlightCache(file)));
      for (const file of files) pool.evictDiffFromCache(file.cacheKey!);
    } catch { return; }
  }
}

async function startEngine(): Promise<Engine> {
  // Spawn the workers first: their scripts load while the main thread imports the library.
  let spare: Worker[] = [];
  try { spare = Array.from({ length: POOL_SIZE }, () => new DiffWorker()); } catch { /* the pool reports it */ }
  const lib = await import('@pierre/diffs');
  const started = (result: Engine): Engine => {
    // One line per app run, so a WKWebView that refuses the worker is visible in logs.
    console.info(`PandaCode diff engine: ${result.name}`);
    return result;
  };
  // The main thread only builds plain rows (Shiki's `text`), so its shared highlighter
  // uses the JavaScript engine and skips compiling Oniguruma's WASM; it is a singleton,
  // so creating it first decides that. The workers tokenize with WASM.
  const mainReady = lib.preloadHighlighter({ themes: [THEMES.dark, THEMES.light], langs: ['text'], preferredHighlighter: 'shiki-js' });
  try {
    const { getOrCreateWorkerPoolSingleton } = await import('@pierre/diffs/worker');
    await mainReady;
    const pool = getOrCreateWorkerPoolSingleton({
      poolOptions: { workerFactory: () => spare.pop() ?? new DiffWorker(), poolSize: POOL_SIZE, totalASTLRUCacheSize: AST_CACHE_ENTRIES },
      highlighterOptions: { ...HIGHLIGHT, preferredHighlighter: 'shiki-wasm' },
    });
    await pool.initialize();
    void warmLanguages(lib, pool);
    return started({ lib, pool, highlighter: 'shiki-wasm', name: 'worker-wasm' });
  } catch {
    for (const worker of spare) worker.terminate();
    (await import('@pierre/diffs/worker').catch(() => undefined))?.terminateWorkerPoolSingleton();
    // Main-thread rendering with the JavaScript engine created above.
    await mainReady.catch(() => {});
    return started({ lib, highlighter: 'shiki-js', name: 'main-js' });
  }
}

/** Starts the renderer, worker pool and themes ahead of the first diff. Safe to call often. */
export function preloadDiffViewer(): Promise<unknown> {
  engine ??= startEngine();
  return engine;
}

/** Read-only, bounded diff rendering. Replacing a viewer cancels its old mount. */
export function mountDiffViewer(host: HTMLElement, input: DiffViewerInput): DiffViewerController {
  mountedViewers.get(host)?.dispose();
  let disposed = false;
  let renderers: { view: FileDiff; header: boolean; file: FileDiffMetadata }[] = [];
  let pool: WorkerPoolManager | undefined;
  let rerenderFrame = 0, primeFrame = 0, settleTimer = 0, scrolling = false, viewHeight = 0;
  const priming = new Set<string>();
  let virtualizer: Virtualizer | undefined;
  let width = 0;
  let highlighter: Engine['highlighter'] = 'shiki-wasm';
  let resizeObserver: ResizeObserver | undefined;
  let themeObserver: MutationObserver | undefined;
  let resizeFrame = 0;
  let mountFrame = 0;
  let requestedLayout = input.layout ?? 'unified';
  let layout: 'unified' | 'split' = 'unified';
  let wrap = false;
  const listeners = new AbortController();

  const root = element('section', 'diff-viewer');
  root.setAttribute('aria-label', input.path ? `Changes to ${input.path}` : 'File changes');
  root.dataset.diffState = 'loading';
  const toolbar = element('div', 'diff-viewer-toolbar');
  const title = element('span', 'diff-viewer-title', input.path ?? 'Changes');
  title.title = input.path ?? 'Changes';
  const controls = element('div', 'diff-viewer-controls');
  const layouts = element('div', 'diff-viewer-layout');
  layouts.setAttribute('role', 'group');
  layouts.setAttribute('aria-label', 'Diff layout');
  const unified = element('button', 'diff-viewer-button', 'Unified');
  const split = element('button', 'diff-viewer-button', 'Split');
  const wrapping = element('button', 'diff-viewer-button diff-viewer-wrap', 'Wrap');
  for (const [button, label] of [[unified, 'Unified diff'], [split, 'Split diff'], [wrapping, 'Wrap lines']] as const) {
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = true;
  }
  layouts.append(unified, split);
  controls.append(layouts, wrapping);
  toolbar.append(title, controls);
  const status = element('p', 'diff-viewer-status', 'Loading diff…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = element('div', 'diff-viewer-content');
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', 'Read-only diff');
  content.setAttribute('aria-busy', 'true');
  root.append(toolbar, status, content);
  host.replaceChildren(root);
  // The element that actually scrolls: this viewer's content, or an ancestor list.
  const scroller = input.scrollRoot ?? content;

  const options = (header: boolean): FileDiffOptions<undefined, undefined> => ({
    themeType: themeType(),
    preferredHighlighter: highlighter,
    diffStyle: layout,
    overflow: wrap ? 'wrap' : 'scroll',
    diffIndicators: 'classic',
    disableLineNumbers: false,
    disableFileHeader: !header,
    stickyHeader: false,
    // Patches contain only recorded context. Never fetch current files to fill
    // historical gaps, or offer expand buttons for lines we do not possess.
    hunkSeparators: 'metadata',
    ...HIGHLIGHT,
    tokenizeMaxLength: TOKENIZE_MAX_LINES,
    disableErrorHandling: true,
    enableLineSelection: false,
    // This CSS is constant; no patch content is ever interpolated into it.
    // Pierre adds it to every container it creates, including hunk groups mounted later.
    unsafeCSS: ':host { --diffs-font-family: var(--mono, monospace); --diffs-font-size: 0.86rem; --diffs-line-height: 1.45rem; }' + (input.shadowCSS ?? ''),
  });

  // Distance in pixels from the viewport to a virtualized renderer (0 when visible).
  function distance(entry: { view: FileDiff }, top: number, bottom: number): number {
    const view = entry.view as VirtualizedFileDiff, start = view.top ?? 0, end = start + view.height;
    return start > bottom ? start - bottom : end < top ? top - end : 0;
  }

  /** Primes the hunk groups nearest the viewport; reruns as primes finish and on scroll. */
  function primeNearby(): void {
    primeFrame = 0;
    if (disposed || !pool || !virtualizer) return;
    // Cached positions only: no layout reads while the virtualizer is writing.
    const top = virtualizer.getScrollTop(), height = viewHeight || scroller.clientHeight, bottom = top + height;
    // While scrolling only visible groups prime; offscreen ones wait for the scroll to settle.
    if (!scrolling) keepFirstScreen(false);
    const reach = scrolling ? 0 : height;
    const near = renderers.map(entry => ({ entry, away: distance(entry, top, bottom) }))
      .filter(({ entry, away }) => away <= reach && highlightable(entry.file))
      .sort((a, b) => a.away - b.away).slice(0, PRIME_WINDOW);
    for (const { entry: { file } } of near) {
      if (priming.size >= POOL_SIZE) break;
      const key = file.cacheKey!;
      if (priming.has(key) || pool.getDiffResultCache(file)) continue;
      priming.add(key);
      void pool.primeDiffHighlightCache(file).catch(() => {}).finally(() => { priming.delete(key); schedulePrime(); });
    }
  }
  /** Keeps the first screen recent in the pool's LRU (re-highlighting it if it was evicted), so a reopen paints highlighted. */
  function keepFirstScreen(rehighlight: boolean): void {
    for (let i = 0, lines = 0; pool && i < renderers.length && lines < PRIME_LINES; lines += Math.max(renderers[i].file.additionLines.length, renderers[i++].file.deletionLines.length)) {
      const { file } = renderers[i];
      if (rehighlight && highlightable(file)) void pool.primeDiffHighlightCache(file).catch(() => {}); else pool.getDiffResultCache(file);
    }
  }
  function schedulePrime(): void {
    if (!disposed && pool && virtualizer && !primeFrame) primeFrame = requestAnimationFrame(primeNearby);
  }
  scroller.addEventListener('scroll', () => {
    if (!virtualizer) return;
    scrolling = true;
    clearTimeout(settleTimer);
    schedulePrime();
    settleTimer = window.setTimeout(() => { scrolling = false; schedulePrime(); }, SCROLL_SETTLE_MS);
  }, { passive: true, signal: listeners.signal });

  function cleanRenderers(): void {
    cancelAnimationFrame(mountFrame);
    cancelAnimationFrame(rerenderFrame);
    cancelAnimationFrame(primeFrame);
    clearTimeout(settleTimer);
    for (const { view } of renderers) view.cleanUp();
    renderers = [];
    if (virtualizer) releaseVirtualizer(scroller);
    virtualizer = undefined;
  }

  function showFallback(message: string, showPatch = true): void {
    if (disposed) return;
    cleanRenderers();
    resizeObserver?.disconnect();
    themeObserver?.disconnect();
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    root.dataset.diffState = 'fallback';
    controls.hidden = true;
    status.hidden = false;
    status.textContent = message;
    if (showPatch && input.patch) {
      const preview = rawPreview(input.patch);
      const pre = element('pre', 'diff-viewer-raw', preview.text);
      pre.setAttribute('aria-label', 'Plain text patch');
      content.append(pre);
      if (preview.clipped) content.append(element('p', 'diff-viewer-note', 'Preview shortened to keep the app responsive.'));
    }
  }

  function updateControls(): void {
    // The width comes from the ResizeObserver; measure here only before it has reported.
    if (!width) width = root.getBoundingClientRect().width;
    const narrow = width < SPLIT_MIN_WIDTH;
    layout = requestedLayout === 'split' && !narrow ? 'split' : 'unified';
    root.dataset.diffLayout = layout;
    unified.disabled = false;
    split.disabled = narrow;
    split.title = narrow ? 'Widen the panel to use a split diff' : 'Split diff';
    wrapping.disabled = false;
    unified.setAttribute('aria-pressed', String(layout === 'unified'));
    split.setAttribute('aria-pressed', String(layout === 'split'));
    wrapping.setAttribute('aria-pressed', String(wrap));
  }

  /** Applies the current options: visible renderers now, the rest in frame-sized slices. */
  function rerender(): void {
    if (disposed || !renderers.length) return;
    cancelAnimationFrame(rerenderFrame);
    const scrollTop = scroller.scrollTop;
    const failed = () => showFallback('Unable to format this diff. Showing the recorded patch.');
    const apply = ({ view, header }: { view: FileDiff; header: boolean }) => { view.setOptions(options(header)); view.rerender(); };
    try {
      updateControls();
      let order = renderers, now = renderers.length;
      if (virtualizer) {
        const bottom = scrollTop + scroller.clientHeight;
        const ranked = renderers.map(entry => ({ entry, away: distance(entry, scrollTop, bottom) })).sort((a, b) => a.away - b.away);
        order = ranked.map(({ entry }) => entry);
        now = Math.max(1, ranked.filter(({ away }) => !away).length);
      }
      order.slice(0, now).forEach(apply);
      scroller.scrollTop = scrollTop;
      let next = now;
      const slice = () => {
        rerenderFrame = 0;
        if (disposed) return;
        try {
          const start = performance.now();
          while (next < order.length && performance.now() - start < SLICE_MS) apply(order[next++]);
          if (next < order.length) rerenderFrame = requestAnimationFrame(slice);
        } catch { failed(); }
      };
      if (next < order.length) rerenderFrame = requestAnimationFrame(slice);
    } catch {
      failed();
    }
  }

  unified.addEventListener('click', () => { requestedLayout = 'unified'; rerender(); }, { signal: listeners.signal });
  split.addEventListener('click', () => { requestedLayout = 'split'; rerender(); }, { signal: listeners.signal });
  wrapping.addEventListener('click', () => { wrap = !wrap; rerender(); }, { signal: listeners.signal });
  layouts.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || split.disabled) return;
    event.preventDefault();
    const button = event.key === 'ArrowLeft' || event.key === 'Home' ? unified : split;
    button.focus();
    button.click();
  }, { signal: listeners.signal });

  async function initialize(): Promise<void> {
    if (input.error) { showFallback(input.error); return; }
    if (input.binary || /^(?:GIT binary patch|Binary files .+ differ)$/m.test(input.patch)) {
      showFallback('Binary file changed. A text diff is not available.', false); return;
    }
    if (!input.patch.trim()) { showFallback('No text changes to display.', false); return; }
    const lines = input.patch.length > MAX_PATCH_LENGTH ? Infinity : lineCount(input.patch);
    if (lines > MAX_PATCH_LINES) {
      showFallback('Large diff — showing a limited plain text preview.'); return;
    }
    const chunks = splitPatch(input.patch);
    const sections = chunks.filter(chunk => !chunk.continued).length;
    if (sections > MAX_FILES) { showFallback('Large diff — showing a limited plain text preview.'); return; }
    const fail = () => showFallback(input.truncated
      ? 'This patch was shortened when recorded. Showing the available plain text patch.'
      : 'Unable to format this diff. Showing the recorded patch.');
    try {
      const loaded = await preloadDiffViewer() as Engine;
      if (disposed) return;
      const { lib } = loaded;
      pool = loaded.pool;
      highlighter = loaded.highlighter;
      root.dataset.diffEngine = loaded.name;
      if (!pool) {
        // Main thread: load the languages in this patch before the first render.
        const names = chunks.flatMap(chunk => chunk.continued ? [] : parseChunk(lib, '', chunk).map(file => file.name));
        await lib.preloadHighlighter({
          themes: [THEMES.dark, THEMES.light],
          langs: [...new Set(names.map(name => lib.getFiletypeFromFileName(name)))],
          preferredHighlighter: highlighter,
        });
        if (disposed) return;
      }
      updateControls();
      let list: HTMLElement = content;
      if (lines > VIRTUALIZE_LINES) {
        list = element('div', 'diff-viewer-list');
        content.append(list);
        virtualizer = acquireVirtualizer(lib, scroller);
      }
      // Every chunk gets a frame now, sized from its line count until it mounts, so the
      // scroll height is right from the first frame. CSS resolves the row height, which
      // the host may set (--diff-line-height), so no layout is read here.
      const frames = chunks.map(chunk => {
        const frame = element('div', chunk.continued ? 'diff-viewer-file diff-viewer-continued' : 'diff-viewer-file');
        if (chunks.length > 1) frame.style.minHeight = `calc(${chunk.lines} * var(--diff-line-height))`;
        list.append(frame);
        return frame;
      });
      const mounted: FileDiffMetadata[] = [];
      let next = 0;
      const mountChunk = (): void => {
        const chunk = chunks[next], frame = frames[next++];
        const files = parseChunk(lib, input.path ?? '', chunk);
        frame.style.minHeight = '';
        let target = frame;
        files.forEach((file, index) => {
          if (index) { const extra = element('div', 'diff-viewer-file'); target.after(extra); target = extra; }
          target.setAttribute('aria-label', file.name);
          const header = !chunk.continued && (sections > 1 || files.length > 1);
          const view = virtualizer ? new lib.VirtualizedFileDiff(options(header), virtualizer, { hunkLineCount: RENDER_BATCH_LINES }, pool) : new lib.FileDiff(options(header), pool);
          renderers.push({ view, header, file });
          mounted.push(file);
          view.render({ fileDiff: file, containerWrapper: target });
          if (!file.hunks.length) {
            const message = file.type === 'rename-pure'
              ? `Renamed ${file.prevName ?? 'file'} to ${file.name}. Contents unchanged.`
              : file.mode !== file.prevMode && file.prevMode
                ? `File mode changed from ${file.prevMode} to ${file.mode ?? 'unknown'}.`
                : 'File metadata changed. No line changes.';
            target.append(element('p', 'diff-viewer-note', message));
          }
        });
      };
      const finish = (): void => {
        content.setAttribute('aria-busy', 'false');
        if (!mounted.length) { showFallback('No line changes in this patch.'); return; }
        schedulePrime();
      };
      // Mount (and parse) the first screen now and the rest in frame-sized slices.
      const pump = (budget: number): void => {
        const start = performance.now();
        do mountChunk(); while (next < chunks.length && performance.now() - start < budget);
        if (next < chunks.length) {
          mountFrame = requestAnimationFrame(() => {
            if (disposed) return;
            try { pump(SLICE_MS); } catch { fail(); }
          });
        } else finish();
      };
      pump(FIRST_SLICE_MS);
      if (root.dataset.diffState === 'fallback') return;
      schedulePrime();
      root.dataset.diffState = 'ready';
      status.hidden = !input.truncated;
      status.textContent = input.truncated ? 'This patch was shortened when recorded. Only available changes are shown.' : '';
      themeObserver = new MutationObserver(() => {
        if (!disposed) for (const { view } of renderers) view.setThemeType(themeType());
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === scroller) { viewHeight = entry.contentRect.height; continue; }
          width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        }
        if (disposed || resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          if (disposed) return;
          const previousLayout = layout;
          updateControls();
          if (layout !== previousLayout) rerender();
        });
      });
      resizeObserver.observe(root);
      resizeObserver.observe(scroller);
    } catch {
      fail();
    }
  }

  const controller: DiffViewerController = {
    ready: initialize(),
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      cancelAnimationFrame(resizeFrame);
      if (virtualizer) keepFirstScreen(true);
      cleanRenderers();
      root.remove();
      if (mountedViewers.get(host) === controller) mountedViewers.delete(host);
    },
  };
  mountedViewers.set(host, controller);
  return controller;
}
