/// <reference types="vite/client" />
import type { FileDiff, FileDiffMetadata, FileDiffOptions, VirtualFileMetrics, VirtualizedFileDiff, Virtualizer } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
// A real module URL, not a blob: the app CSP allows no blob: workers.
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { patchKey, splitPatch, type PatchChunk } from './diff-prefetch';
import './diff-viewer.css';
import { t } from './i18n.ts';

export interface DiffViewerInput {
  patch: string;
  path?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
  layout?: 'unified' | 'split';
  wrap?: boolean;
  /**
   * The element that scrolls when the viewer itself does not (a list of inline diffs).
   * Its first element child must hold all of its content: large files are virtualized
   * against it, and the virtualizer watches that child for scroll-height changes.
   */
  scrollRoot?: HTMLElement;
  /** Constant CSS added to every diff's shadow root (never patch content). */
  shadowCSS?: string;
  /** Custom metadata hunk-separator height (px) when `shadowCSS` overrides Pierre's 32 px default. */
  hunkSeparatorHeight?: number;
  /** Custom block gap (px) when host CSS overrides `--diffs-gap-block` (Pierre's 8 px default). */
  blockGap?: number;
}

export interface DiffViewerReaderState {
  top: number;
  left: number;
  code: number[][];
  layout: 'unified' | 'split';
  wrap: boolean;
  anchor?: {
    container: number;
    side: number;
    index: string;
    line: number;
    lineSide: 'additions' | 'deletions';
    offset: number;
  };
}

export interface DiffViewerController {
  /** Resolves after the first render or a safe fallback; never rejects. */
  ready: Promise<void>;
  getReaderState(): DiffViewerReaderState;
  restoreReaderState(state: DiffViewerReaderState, options?: { vertical?: boolean }): void;
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
const sharedVirtualizers = new WeakMap<HTMLElement, { virtualizer: Virtualizer; users: number; overflowAnchor: string }>();
function acquireVirtualizer(lib: Diffs, root: HTMLElement): Virtualizer {
  let shared = sharedVirtualizers.get(root);
  if (!shared) {
    shared = { virtualizer: new lib.Virtualizer({ overscrollSize: OVERSCROLL_PX }), users: 0, overflowAnchor: root.style.overflowAnchor };
    // The virtualizer owns scroll anchoring; browser anchoring would apply the
    // same height correction a second time when restored chunks are laid out.
    root.style.overflowAnchor = 'none';
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
  root.style.overflowAnchor = shared.overflowAnchor;
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
let engineCleanup = Promise.resolve();
let activeViewers = 0, engineIdleTimer = 0;
const ENGINE_IDLE_MS = 15_000;
const HIDDEN_GRACE_MS = 1_000;
const ANCHOR_QUIET_MS = 3_000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function scheduleEngineDispose(delayMs: number): void {
  if (!engine) return;
  const pending = engine;
  clearTimeout(engineIdleTimer);
  engineIdleTimer = window.setTimeout(() => {
    engineIdleTimer = 0;
    void pending.then(async loaded => {
      const workers = await import('@pierre/diffs/worker');
      if (activeViewers || engine !== pending) return;
      workers.terminateWorkerPoolSingleton();
      engineCleanup = loaded.lib.disposeHighlighter().catch(() => {});
      engine = undefined;
    }).catch(() => {});
  }, delayMs);
}

function releaseEngine(): void {
  if (--activeViewers || !engine) return;
  scheduleEngineDispose(typeof document !== 'undefined' && document.hidden ? HIDDEN_GRACE_MS : ENGINE_IDLE_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeViewers === 0 && engine && engineIdleTimer) {
      clearTimeout(engineIdleTimer);
      scheduleEngineDispose(HIDDEN_GRACE_MS);
    }
  });
}

const highlightable = (file: FileDiffMetadata) => Math.max(file.additionLines.length, file.deletionLines.length) <= TOKENIZE_MAX_LINES;

function parseChunk(lib: Diffs, path: string, chunk: PatchChunk): FileDiffMetadata[] {
  return lib.parsePatchFiles(chunk.text, patchKey(path, chunk.text), true).flatMap(patch => patch.files);
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
    return started({ lib, pool, highlighter: 'shiki-wasm', name: 'worker-wasm' });
  } catch {
    for (const worker of spare) worker.terminate();
    (await import('@pierre/diffs/worker').catch(() => undefined))?.terminateWorkerPoolSingleton();
    // Main-thread rendering with the JavaScript engine created above.
    await mainReady.catch(() => {});
    return started({ lib, highlighter: 'shiki-js', name: 'main-js' });
  }
}

/** Starts on the first requested patch; workers load only that patch’s languages. */
export function preloadDiffViewer(): Promise<unknown> {
  engine ??= engineCleanup.then(startEngine);
  return engine;
}

export async function mountCodeFile(host: HTMLElement, path: string, contents: string, wrap: boolean): Promise<() => void> {
  engine ??= startEngine();
  const { lib, pool, highlighter } = await engine;
  if (!host.isConnected) return () => {};
  const options = () => ({ theme: THEMES, themeType: themeType(), preferredHighlighter: highlighter, disableFileHeader: true, overflow: wrap ? 'wrap' as const : 'scroll' as const, tokenizeMaxLineLength: 2000, unsafeCSS: ':host{--diffs-font-family:var(--mono,monospace);--diffs-font-size:13px;--diffs-line-height:21px;--diffs-bg:var(--bg)}[data-gutter]{user-select:none}' });
  const file = new lib.File(options(), pool);
  host.replaceChildren();
  file.render({ file: { name: path, contents, cacheKey: patchKey(path, contents) }, containerWrapper: host });
  const observer = new MutationObserver(() => { file.setOptions(options()); file.rerender(); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-vsix'] });
  return () => { observer.disconnect(); file.cleanUp(); };
}

export type SelectedCode = { text: string; startLine: number; endLine: number; buffer: string };
export type CodeSelection = SelectedCode & { action: 'ask' | 'fix'; question: string };

export async function mountCodeEditor(host: HTMLElement, path: string, contents: string, stateKey: string, change: (content: string) => void, select: (selection: SelectedCode | undefined) => void) {
  engine ??= startEngine();
  const [{ lib, pool, highlighter }, { Editor }] = await Promise.all([engine, import('@pierre/diffs/edit')]);
  if (!host.isConnected) return;
  const options = () => ({ theme: THEMES, themeType: themeType(), preferredHighlighter: highlighter, disableFileHeader: true, tokenizeMaxLineLength: 2000, unsafeCSS: ':host{--diffs-font-family:var(--mono,monospace);--diffs-font-size:13px;--diffs-line-height:22px;--diffs-bg:var(--ds-card-inner);--diffs-editor-cursor-fg:var(--text);--diffs-editor-selection-bg:var(--accent-tint);--diffs-editor-bracket-match-bg:var(--accent-tint);--diffs-editor-bracket-match-border:var(--accent)}[data-gutter]{user-select:none}' });
  const file = new lib.File({ ...options(), onEditComplete: event => { event.file.cacheKey = crypto.randomUUID(); return 'accept'; } }, pool);
  let selectionFrame = 0;
  const editor = new Editor('file', { ownsVerticalViewport: true, onChange: event => { change(event.file.contents); select(undefined); scheduleSelection(); } }, stateKey);
  host.replaceChildren();
  file.render({ file: { name: path, contents, cacheKey: patchKey(path, contents) }, containerWrapper: host });
  editor.edit(file);
  function captureSelection(clear = false): void {
    if (!host.contains(document.activeElement)) return;
    const range = editor.getViewState().selections?.at(-1), textDocument = editor.getEditState()?.document;
    const text = range && textDocument?.getText(range);
    const selection = range && text ? { text, startLine: range.start.line + 1, endLine: Math.max(range.start.line + 1, range.end.line + (range.end.character ? 1 : 0)), buffer: editor.getText() } : undefined;
    if (selection || clear) select(selection);
  }
  function scheduleSelection(): void {
    if (!selectionFrame) selectionFrame = requestAnimationFrame(() => { selectionFrame = 0; captureSelection(); });
  }
  function selectionEnded(): void { captureSelection(true); scheduleSelection(); }
  function selectionChanged(): void { if (host.contains(document.activeElement)) scheduleSelection(); }
  host.addEventListener('pointerup', selectionEnded);
  host.addEventListener('keyup', selectionEnded);
  document.addEventListener('selectionchange', selectionChanged);
  const observer = new MutationObserver(() => { file.setOptions({ ...file.options, ...options() }); file.rerender(); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-vsix'] });
  return { focus: () => editor.focus(), dispose: () => { observer.disconnect(); cancelAnimationFrame(selectionFrame); host.removeEventListener('pointerup', selectionEnded); host.removeEventListener('keyup', selectionEnded); document.removeEventListener('selectionchange', selectionChanged); editor.cleanUp(); file.cleanUp(); } };
}

/** Read-only, bounded diff rendering. Replacing a viewer cancels its old mount. */
export function mountDiffViewer(host: HTMLElement, input: DiffViewerInput): DiffViewerController {
  mountedViewers.get(host)?.dispose();
  let disposed = false, usesEngine = false, suspended = document.hidden, ready = false;
  let hiddenTimer = 0, anchorQuietTimer = 0, renderGeneration = 0;
  let hiddenReaderState: DiffViewerReaderState | undefined;
  let hiddenReaderVertical = input.scrollRoot == null;
  let pendingCodeScroll = new Map<number, number[]>();
  let pendingScroll: {
    state: DiffViewerReaderState;
    seeds: number;
    aligned: boolean;
    top: number;
    docTop: number;
    scrollHeight: number;
  } | undefined;
  let lastScroll = { top: 0, left: 0 };
  let lastAnchor: { top: number; anchor: NonNullable<DiffViewerReaderState['anchor']> } | undefined;
  let snapshotFrame = 0;
  const codeOffsets = new WeakMap<HTMLElement, number>();
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
  let wrap = input.wrap ?? false;
  const listeners = new AbortController();

  const root = element('section', 'diff-viewer');
  root.setAttribute('aria-label', input.path ? t`Changes to ${input.path}` : t('File changes'));
  root.dataset.diffState = suspended ? 'suspended' : 'loading';
  const toolbar = element('div', 'diff-viewer-toolbar');
  const title = element('span', 'diff-viewer-title', input.path ?? t('Changes'));
  title.title = input.path ?? t('Changes');
  const controls = element('div', 'diff-viewer-controls');
  const layouts = element('div', 'diff-viewer-layout');
  layouts.setAttribute('role', 'group');
  layouts.setAttribute('aria-label', t('Diff layout'));
  const unified = element('button', 'diff-viewer-button', t('Unified'));
  const split = element('button', 'diff-viewer-button', t('Split'));
  const wrapping = element('button', 'diff-viewer-button diff-viewer-wrap', t('Wrap'));
  for (const [button, label] of [[unified, t('Unified diff')], [split, t('Split diff')], [wrapping, t('Wrap lines')]] as const) {
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = true;
  }
  layouts.append(unified, split);
  controls.append(layouts, wrapping);
  toolbar.append(title, controls);
  const status = element('p', 'diff-viewer-status', t('Loading diff…'));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = element('div', 'diff-viewer-content');
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', t('Read-only diff'));
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
    // The content strip is each diff's one Tab stop; Chrome would also stop on the scroller inside the shadow root.
    onPostRender: (node, _view, phase) => {
      if (phase !== 'unmount') {
        const reset: Array<{ code: HTMLElement; left: number }> = [];
        node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]').forEach(code => {
          code.tabIndex = -1;
          if (codeOffsets.has(code)) {
            const left = codeOffsets.get(code) ?? 0;
            if (left > 0 && code.clientWidth && !code.scrollLeft && code.querySelector('[data-line]')) {
              reset.push({ code, left });
            }
            return;
          }
          codeOffsets.set(code, code.scrollLeft);
          // Hidden panels and unmounted placeholders report zero; the node owns its listener so cleanup can collect it.
          code.addEventListener('scroll', () => {
            if (code.clientWidth && (code.scrollLeft > 0 || code.querySelector('[data-line]'))) {
              codeOffsets.set(code, code.scrollLeft);
            }
          }, { passive: true });
        });
        reset.sort((a, b) => b.left - a.left).forEach(({ code, left }) => {
          code.scrollLeft = left;
          codeOffsets.set(code, code.scrollLeft);
        });
      }
      if (pendingCodeScroll.size || pendingScroll) scheduleLayout(true);
    },
    enableLineSelection: false,
    // This CSS is constant; no patch content is ever interpolated into it.
    // Pierre adds it to every container it creates, including hunk groups mounted later.
    unsafeCSS: ':host { --diffs-font-family: var(--mono, monospace); --diffs-font-size: 0.86rem; --diffs-line-height: 1.45rem; }' + (input.shadowCSS ?? ''),
  });

  function clearPendingScroll(): void {
    clearTimeout(anchorQuietTimer);
    anchorQuietTimer = 0;
    pendingScroll = undefined;
  }

  function armAnchorQuietTimer(): void {
    clearTimeout(anchorQuietTimer);
    anchorQuietTimer = window.setTimeout(() => {
      anchorQuietTimer = 0;
      pendingScroll = undefined;
    }, ANCHOR_QUIET_MS);
  }

  function measureVirtualMetrics(): Partial<VirtualFileMetrics> {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const raw = getComputedStyle(root).getPropertyValue('--diff-line-height').trim();
    const parsed = raw.endsWith('rem') ? parseFloat(raw) * rem : raw.endsWith('px') ? parseFloat(raw) : 0;
    return {
      hunkLineCount: RENDER_BATCH_LINES,
      lineHeight: parsed > 0 ? parsed : 1.45 * rem,
      ...(input.hunkSeparatorHeight !== undefined ? { hunkSeparatorHeight: input.hunkSeparatorHeight } : {}),
      ...(input.blockGap !== undefined ? { spacing: input.blockGap } : {}),
    };
  }

  function restoreCodeScroll(node: Element): void {
    if (!pendingCodeScroll.size) return;
    const index = Array.from(content.querySelectorAll('diffs-container')).indexOf(node);
    const offsets = pendingCodeScroll.get(index);
    const codes = node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]');
    if (!offsets || !codes?.length) return;
    // Virtualized placeholders can have a width but no lines yet. Do not consume
    // positive offsets until real code is laid out; shorter split sides still clamp.
    if (Array.from(codes).some((code, side) =>
      !code.clientWidth || ((offsets[side] ?? 0) > 0 && !code.querySelector('[data-line]')))) return;
    // Restore the farther side first so split-scroll sync cannot clamp it to the shorter side.
    Array.from(codes, (code, side) => ({ code, left: offsets[side] ?? 0 }))
      .sort((a, b) => b.left - a.left).forEach(({ code, left }) => { code.scrollLeft = left; codeOffsets.set(code, code.scrollLeft); });
    pendingCodeScroll.delete(index);
  }

  function measureAnchor(): DiffViewerReaderState['anchor'] {
    if (!scroller.clientHeight || !scroller.clientWidth) return undefined;
    const viewport = scroller.getBoundingClientRect();
    if (viewport.height <= 0 || viewport.width <= 0) return undefined;
    let best: NonNullable<DiffViewerReaderState['anchor']> | undefined;
    content.querySelectorAll('diffs-container').forEach((node, container) => {
      const box = node.getBoundingClientRect();
      if (box.bottom <= viewport.top || box.top >= viewport.bottom) return;
      node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]').forEach((code, side) => {
        const deletionsSide = code.hasAttribute('data-deletions');
        code.querySelectorAll<HTMLElement>('[data-line][data-line-index]').forEach(line => {
          const rect = line.getBoundingClientRect();
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
          const candidate: NonNullable<DiffViewerReaderState['anchor']> = {
            container,
            side,
            index: line.dataset.lineIndex!,
            line: Number(line.dataset.line),
            lineSide: deletionsSide || line.dataset.lineType === 'change-deletion' ? 'deletions' : 'additions',
            offset: rect.top - viewport.top,
          };
          if (!best
            || candidate.offset < best.offset
            || (candidate.offset === best.offset && (candidate.container < best.container || (candidate.container === best.container && candidate.side < best.side)))) {
            best = candidate;
          }
        });
      });
    });
    return best;
  }

  function snapshotVisibleReader(): DiffViewerReaderState['anchor'] {
    if (!scroller.clientHeight || !scroller.clientWidth) return undefined;
    lastScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
    content.querySelectorAll('diffs-container').forEach(node => {
      node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]').forEach(code => {
        if (code.clientWidth && (code.scrollLeft > 0 || code.querySelector('[data-line]'))) {
          codeOffsets.set(code, code.scrollLeft);
        }
      });
    });
    const anchor = measureAnchor();
    if (anchor) lastAnchor = { top: lastScroll.top, anchor };
    return anchor;
  }

  function scheduleSnapshot(): void {
    if (disposed || suspended || snapshotFrame) return;
    snapshotFrame = requestAnimationFrame(() => {
      snapshotFrame = 0;
      if (!disposed && !suspended && !pendingScroll) snapshotVisibleReader();
    });
  }

  function findAnchorLine(anchor: NonNullable<DiffViewerReaderState['anchor']>): HTMLElement | null {
    const node = content.querySelectorAll('diffs-container')[anchor.container];
    if (!node?.shadowRoot) return null;
    const codes = node.shadowRoot.querySelectorAll<HTMLElement>('[data-code]');
    const selector = `[data-line][data-line-index="${CSS.escape(anchor.index)}"]`;
    return (codes[anchor.side] ?? codes[0])?.querySelector<HTMLElement>(selector)
      ?? node.shadowRoot.querySelector<HTMLElement>(selector);
  }

  function scrollVertical(top: number): void {
    const rounded = Math.round(top);
    if (virtualizer) {
      virtualizer.markDOMDirty();
      virtualizer.scrollTo({ top: rounded, behavior: 'instant' });
    } else {
      scroller.scrollTop = rounded;
    }
    if (pendingScroll) {
      pendingScroll.top = scroller.scrollTop;
      pendingScroll.scrollHeight = scroller.scrollHeight;
    }
    if (scroller.clientHeight && scroller.clientWidth) {
      lastScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
    }
  }

  function readCodeScrolls(): number[][] {
    const containers = Array.from(content.querySelectorAll('diffs-container'));
    const count = Math.max(containers.length, pendingCodeScroll.size ? Math.max(...pendingCodeScroll.keys()) + 1 : 0);
    return Array.from({ length: count }, (_, index) =>
      pendingCodeScroll.get(index)
      ?? Array.from(containers[index]?.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? [], code =>
        code.clientWidth && (code.scrollLeft > 0 || code.querySelector('[data-line]')) ? code.scrollLeft : codeOffsets.get(code) ?? 0));
  }

  function getReaderState(): DiffViewerReaderState {
    if (suspended && hiddenReaderState) return hiddenReaderState;
    if (pendingScroll && !pendingScroll.aligned) {
      return { ...pendingScroll.state, layout: requestedLayout, wrap, code: readCodeScrolls() };
    }
    const visible = scroller.clientHeight > 0 && scroller.clientWidth > 0;
    const liveAnchor = visible ? snapshotVisibleReader() : undefined;
    const top = visible ? scroller.scrollTop : lastScroll.top;
    const left = visible ? scroller.scrollLeft : lastScroll.left;
    const anchor = visible
      ? liveAnchor
      : (lastAnchor && Math.abs(lastAnchor.top - top) <= 1 ? lastAnchor.anchor : undefined);
    return { top, left, layout: requestedLayout, wrap, anchor, code: readCodeScrolls() };
  }

  function restoreReaderState(state: DiffViewerReaderState, options: { vertical?: boolean } = {}): void {
    const vertical = options.vertical ?? input.scrollRoot == null;
    const optionsChanged = requestedLayout !== state.layout || wrap !== state.wrap;
    requestedLayout = state.layout;
    wrap = state.wrap;
    if (suspended || !ready) { hiddenReaderState = state; hiddenReaderVertical = vertical; return; }
    clearPendingScroll();
    if (optionsChanged) rerender();
    pendingCodeScroll = new Map(state.code.map((offsets, index) => [index, offsets]));
    if (vertical) {
      pendingScroll = {
        state,
        seeds: 0,
        aligned: false,
        top: state.top,
        docTop: state.top + (state.anchor?.offset ?? 0),
        scrollHeight: scroller.scrollHeight,
      };
      scrollVertical(state.top);
      scroller.scrollLeft = state.left;
      if (scroller.clientHeight && scroller.clientWidth) {
        lastScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
        if (state.anchor) lastAnchor = { top: scroller.scrollTop, anchor: state.anchor };
      }
    }
    scheduleLayout(true);
  }

  function restoreVerticalAnchor(): void {
    if (!pendingScroll || !scroller.clientHeight || !scroller.clientWidth) return;
    const pending = pendingScroll;
    const { state } = pending;
    const anchor = state.anchor;
    if (!anchor) {
      scrollVertical(state.top);
      scroller.scrollLeft = state.left;
      if (Math.abs(scroller.scrollTop - state.top) <= 1) clearPendingScroll();
      return;
    }
    const viewportTop = scroller.getBoundingClientRect().top;
    const line = findAnchorLine(anchor);
    if (line) {
      const offset = line.getBoundingClientRect().top - viewportTop;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const targetTop = Math.round(Math.max(0, Math.min(maxTop, scroller.scrollTop + offset - anchor.offset)));
      if (Math.abs(offset - anchor.offset) > 0.5 && Math.abs(targetTop - scroller.scrollTop) > 0.5) {
        scrollVertical(targetTop);
        const nextOffset = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        pending.docTop = scroller.scrollTop + nextOffset;
      } else {
        pending.top = scroller.scrollTop;
        pending.docTop = scroller.scrollTop + offset;
        pending.scrollHeight = scroller.scrollHeight;
      }
      pending.aligned = true;
      lastScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
      lastAnchor = { top: scroller.scrollTop, anchor };
      armAnchorQuietTimer();
      return;
    }
    if (pending.seeds >= 8 || !virtualizer) return;
    const node = content.querySelectorAll('diffs-container')[anchor.container];
    const view = renderers[anchor.container]?.view as VirtualizedFileDiff | undefined;
    const position = view?.getLinePosition(anchor.line, anchor.lineSide);
    if (!node || !position) return;
    const containerTop = scroller.scrollTop + (node.getBoundingClientRect().top - viewportTop);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const targetTop = Math.round(Math.max(0, Math.min(maxTop, containerTop + position.top - anchor.offset)));
    pending.seeds++;
    if (Math.abs(targetTop - scroller.scrollTop) > 0.5) scrollVertical(targetTop);
  }

  // Restore after the virtualizer's render and height reconciliation. Each render
  // restarts this bounded handoff; offscreen chunks never cause a polling loop.
  function scheduleLayout(afterRender = false): void {
    if (disposed || suspended) return;
    if (afterRender) { cancelAnimationFrame(resizeFrame); resizeFrame = 0; }
    if (resizeFrame) return;
    const apply = () => {
      resizeFrame = 0;
      if (disposed || suspended) return;
      const previousLayout = layout;
      updateControls();
      if (layout !== previousLayout) rerender();
      content.querySelectorAll('diffs-container').forEach(restoreCodeScroll);
      restoreVerticalAnchor();
      if (!pendingScroll) snapshotVisibleReader();
    };
    resizeFrame = requestAnimationFrame(afterRender ? () => { resizeFrame = requestAnimationFrame(apply); } : apply);
  }

  // Distance in pixels from the viewport to a virtualized renderer (0 when visible).
  function distance(entry: { view: FileDiff }, top: number, bottom: number): number {
    const view = entry.view as VirtualizedFileDiff, start = view.top ?? 0, end = start + view.height;
    return start > bottom ? start - bottom : end < top ? top - end : 0;
  }

  /** Primes the hunk groups nearest the viewport; reruns as primes finish and on scroll. */
  function primeNearby(): void {
    primeFrame = 0;
    if (disposed || suspended || !pool || !virtualizer) return;
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
    if (!disposed && !suspended && pool && virtualizer && !primeFrame) primeFrame = requestAnimationFrame(primeNearby);
  }
  scroller.addEventListener('scroll', () => {
    if (scroller.clientHeight && scroller.clientWidth) {
      lastScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
    }
    if (pendingScroll) {
      if (Math.abs(scroller.scrollTop - pendingScroll.top) > 1) {
        const anchor = pendingScroll.state.anchor;
        let external = false;
        if (pendingScroll.aligned && Math.abs(scroller.scrollHeight - pendingScroll.scrollHeight) <= 1) {
          if (!anchor) external = true;
          else {
            const line = findAnchorLine(anchor);
            if (line) {
              const offset = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
              const docTop = scroller.scrollTop + offset;
              if (Math.abs(docTop - pendingScroll.docTop) <= 1 && Math.abs(offset - anchor.offset) > 1) external = true;
            }
          }
        }
        if (external) clearPendingScroll();
        else scheduleLayout(true);
      }
    }
    if (!pendingScroll) scheduleSnapshot();
    if (!virtualizer) return;
    scrolling = true;
    clearTimeout(settleTimer);
    schedulePrime();
    settleTimer = window.setTimeout(() => {
      scrolling = false;
      if (!pendingScroll) snapshotVisibleReader();
      schedulePrime();
    }, SCROLL_SETTLE_MS);
  }, { passive: true, signal: listeners.signal });
  scroller.addEventListener('wheel', clearPendingScroll, { passive: true, signal: listeners.signal });
  scroller.addEventListener('touchstart', clearPendingScroll, { passive: true, signal: listeners.signal });
  scroller.addEventListener('pointerdown', event => {
    if (!(event.target as Element | null)?.closest?.('button, input, textarea, [data-cv-action]')) clearPendingScroll();
  }, { passive: true, signal: listeners.signal });
  scroller.addEventListener('keydown', event => {
    if (SCROLL_KEYS.has(event.key) && !(event.target as Element | null)?.closest?.('button, input, textarea, [data-cv-action]')) clearPendingScroll();
  }, { signal: listeners.signal });

  function cleanRenderers(): void {
    cancelAnimationFrame(mountFrame);
    cancelAnimationFrame(rerenderFrame);
    cancelAnimationFrame(primeFrame);
    cancelAnimationFrame(resizeFrame);
    cancelAnimationFrame(snapshotFrame);
    clearTimeout(settleTimer);
    mountFrame = rerenderFrame = primeFrame = resizeFrame = snapshotFrame = settleTimer = 0;
    scrolling = false;
    pendingCodeScroll.clear();
    clearPendingScroll();
    for (const { view } of renderers) view.cleanUp();
    renderers = [];
    if (virtualizer) releaseVirtualizer(scroller);
    virtualizer = undefined;
  }

  function showFallback(message: string, showPatch = true): void {
    if (disposed) return;
    cleanRenderers();
    if (usesEngine) { usesEngine = false; releaseEngine(); }
    pool = undefined;
    resizeObserver?.disconnect(); resizeObserver = undefined;
    themeObserver?.disconnect(); themeObserver = undefined;
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    root.dataset.diffState = 'fallback';
    controls.hidden = true;
    status.hidden = false;
    status.textContent = message;
    if (showPatch && input.patch) {
      const preview = rawPreview(input.patch);
      const pre = element('pre', 'diff-viewer-raw', preview.text);
      pre.setAttribute('aria-label', t('Plain text patch'));
      content.append(pre);
      if (preview.clipped) content.append(element('p', 'diff-viewer-note', t('Preview shortened to keep the app responsive.')));
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
    split.title = narrow ? t('Widen the panel to use a split diff') : t('Split diff');
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

  unified.addEventListener('click', () => { clearPendingScroll(); requestedLayout = 'unified'; rerender(); }, { signal: listeners.signal });
  split.addEventListener('click', () => { clearPendingScroll(); requestedLayout = 'split'; rerender(); }, { signal: listeners.signal });
  wrapping.addEventListener('click', () => { clearPendingScroll(); wrap = !wrap; rerender(); }, { signal: listeners.signal });
  layouts.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || split.disabled) return;
    event.preventDefault();
    const button = event.key === 'ArrowLeft' || event.key === 'Home' ? unified : split;
    button.focus();
    button.click();
  }, { signal: listeners.signal });

  async function initialize(): Promise<void> {
    if (disposed || suspended) return;
    const generation = ++renderGeneration;
    const cancelled = () => disposed || suspended || generation !== renderGeneration;
    if (input.error) { showFallback(input.error); return; }
    if (input.binary || /^(?:GIT binary patch|Binary files .+ differ)$/m.test(input.patch)) {
      showFallback(t('Binary file changed. A text diff is not available.'), false); return;
    }
    if (!input.patch.trim()) { showFallback(t('No text changes to display.'), false); return; }
    const lines = input.patch.length > MAX_PATCH_LENGTH ? Infinity : lineCount(input.patch);
    if (lines > MAX_PATCH_LINES) {
      showFallback(t('Large diff — showing a limited plain text preview.')); return;
    }
    const chunks = splitPatch(input.patch);
    const sections = chunks.filter(chunk => !chunk.continued).length;
    if (sections > MAX_FILES) { showFallback('Large diff — showing a limited plain text preview.'); return; }
<<<<<<< HEAD
    const fail = () => {
      if (cancelled()) return;
      showFallback(input.truncated
        ? 'This patch was shortened when recorded. Showing the available plain text patch.'
        : 'Unable to format this diff. Showing the recorded patch.');
    };
=======
    const fail = () => showFallback(input.truncated
      ? t('This patch was shortened when recorded. Showing the available plain text patch.')
      : t('Unable to format this diff. Showing the recorded patch.'));
>>>>>>> 4e17e56e (feat: localize the desktop interface with a language setting)
    try {
      clearTimeout(engineIdleTimer);
      engineIdleTimer = 0;
      activeViewers++;
      usesEngine = true;
      const loaded = await preloadDiffViewer() as Engine;
      if (cancelled()) return;
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
        if (cancelled()) return;
      }
      updateControls();
      let list: HTMLElement = content;
      let virtualMetrics: Partial<VirtualFileMetrics> | undefined;
      if (lines > VIRTUALIZE_LINES) {
        list = element('div', 'diff-viewer-list');
        content.append(list);
        virtualizer = acquireVirtualizer(lib, scroller);
        virtualMetrics = measureVirtualMetrics();
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
          const view = virtualizer ? new lib.VirtualizedFileDiff(options(header), virtualizer, virtualMetrics, pool) : new lib.FileDiff(options(header), pool);
          renderers.push({ view, header, file });
          mounted.push(file);
          view.render({ fileDiff: file, containerWrapper: target });
          if (!file.hunks.length) {
            const message = file.type === 'rename-pure'
              ? t`Renamed ${file.prevName ?? t('file')} to ${file.name}. Contents unchanged.`
              : file.mode !== file.prevMode && file.prevMode
                ? t`File mode changed from ${file.prevMode} to ${file.mode ?? t('unknown')}.`
                : t('File metadata changed. No line changes.');
            target.append(element('p', 'diff-viewer-note', message));
          }
        });
      };
      const finish = (): void => {
        content.setAttribute('aria-busy', 'false');
        if (!mounted.length) { showFallback(t('No line changes in this patch.')); return; }
        schedulePrime();
      };
      // Mount (and parse) the first screen now and the rest in frame-sized slices.
      const pump = (budget: number): void => {
        const start = performance.now();
        do mountChunk(); while (next < chunks.length && performance.now() - start < budget);
        if (pendingCodeScroll.size || pendingScroll) scheduleLayout(true);
        if (next < chunks.length) {
          mountFrame = requestAnimationFrame(() => {
            if (cancelled()) return;
            try { pump(SLICE_MS); } catch { fail(); }
          });
        } else finish();
      };
      pump(FIRST_SLICE_MS);
      if (root.dataset.diffState === 'fallback') return;
      schedulePrime();
      root.dataset.diffState = 'ready';
      status.hidden = !input.truncated;
      status.textContent = input.truncated ? t('This patch was shortened when recorded. Only available changes are shown.') : '';
      themeObserver = new MutationObserver(() => {
        if (!disposed) for (const { view } of renderers) view.setThemeType(themeType());
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === scroller) viewHeight = entry.contentRect.height;
          else if (entry.target === root) width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        }
        scheduleLayout();
      });
      resizeObserver.observe(root);
      resizeObserver.observe(scroller);
      if (scroller.firstElementChild) resizeObserver.observe(scroller.firstElementChild);
      content.style.minHeight = '';
      ready = true;
      if (hiddenReaderState) {
        const state = hiddenReaderState, vertical = hiddenReaderVertical;
        hiddenReaderState = undefined;
        restoreReaderState(state, { vertical });
      } else {
        scheduleSnapshot();
      }
    } catch {
      fail();
    }
  }

  // Keep geometry and reader options, but give up renderers and their engine lease while hidden.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) {
      hiddenTimer = window.setTimeout(() => {
        if (disposed || suspended || !document.hidden || root.dataset.diffState === 'fallback') return;
        hiddenReaderState = getReaderState();
        hiddenReaderVertical = input.scrollRoot == null;
        suspended = true;
        ready = false;
        renderGeneration++;
        content.style.minHeight = `${content.getBoundingClientRect().height}px`;
        resizeObserver?.disconnect(); resizeObserver = undefined;
        themeObserver?.disconnect(); themeObserver = undefined;
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        cleanRenderers();
        content.replaceChildren();
        if (usesEngine) { usesEngine = false; releaseEngine(); }
        pool = undefined;
        root.dataset.diffState = 'suspended';
      }, HIDDEN_GRACE_MS);
    } else if (suspended && !disposed) {
      suspended = false;
      void initialize();
    }
  }, { signal: listeners.signal });

  const controller: DiffViewerController = {
    ready: initialize(),
    getReaderState,
    restoreReaderState,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      clearTimeout(hiddenTimer);
      resizeObserver?.disconnect(); resizeObserver = undefined;
      themeObserver?.disconnect(); themeObserver = undefined;
      cancelAnimationFrame(resizeFrame);
      if (virtualizer) keepFirstScreen(true);
      cleanRenderers();
      if (usesEngine) { usesEngine = false; releaseEngine(); }
      pool = undefined;
      root.remove();
      if (mountedViewers.get(host) === controller) mountedViewers.delete(host);
    },
  };
  mountedViewers.set(host, controller);
  return controller;
}
