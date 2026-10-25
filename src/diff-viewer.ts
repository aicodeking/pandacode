/// <reference types="vite/client" />
import type { FileDiff, FileDiffMetadata, FileDiffOptions, VirtualizedFileDiff, Virtualizer } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
// A real module URL, not a blob: the app CSP allows no blob: workers.
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { likelyFileNames, patchKey, splitPatch, type PatchChunk } from './diff-prefetch';
import './diff-viewer.css';
import { t } from './i18n.ts';

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

export async function mountCodeFile(host: HTMLElement, path: string, contents: string, wrap: boolean): Promise<() => void> {
  engine ??= startEngine();
  const { lib, pool, highlighter } = await engine;
  if (!host.isConnected) return () => {};
  const options = () => ({ theme: THEMES, themeType: themeType(), preferredHighlighter: highlighter, disableFileHeader: true, overflow: wrap ? 'wrap' as const : 'scroll' as const, tokenizeMaxLineLength: 2000, unsafeCSS: ':host{--diffs-font-family:var(--mono);--diffs-font-size:var(--mono-size);--diffs-line-height:calc(var(--mono-size) * 1.6);--diffs-bg:var(--bg)}[data-gutter]{user-select:none}' });
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
  const options = () => ({ theme: THEMES, themeType: themeType(), preferredHighlighter: highlighter, disableFileHeader: true, tokenizeMaxLineLength: 2000, unsafeCSS: ':host{--diffs-font-family:var(--mono);--diffs-font-size:var(--mono-size);--diffs-line-height:calc(var(--mono-size) * 1.6);--diffs-bg:var(--ds-card-inner);--diffs-editor-cursor-fg:var(--text);--diffs-editor-selection-bg:var(--accent-tint);--diffs-editor-bracket-match-bg:var(--accent-tint);--diffs-editor-bracket-match-border:var(--accent)}[data-gutter]{user-select:none}' });
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
    const fail = () => showFallback(input.truncated
      ? t('This patch was shortened when recorded. Showing the available plain text patch.')
      : t('Unable to format this diff. Showing the recorded patch.'));
