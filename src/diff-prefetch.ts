// Warm paths for the inspector's Changes view: the viewer module, its worker pool and
// themes start once a diff is likely (preloadDiffsWhenWanted), and the pool warms the grammars of the
// files in the current git status first. The patch splitting here is shared with
// mounting, so every viewer derives the same pool cache keys.

let preloaded: Promise<unknown> | undefined;
/** Imports the diff viewer and starts @pierre/diffs, its worker pool and themes, once. */
export function preloadDiffs(): Promise<unknown> {
  preloaded ??= import('./diff-viewer').then(viewer => viewer.preloadDiffViewer()).catch(() => { preloaded = undefined; });
  return preloaded;
}

let afterPaint = false;
/** preloadDiffs() right after the next paint, so it never delays the list it belongs to. */
export function preloadDiffsAfterPaint(): void {
  disarm();
  if (preloaded || afterPaint) return;
  afterPaint = true;
  requestAnimationFrame(() => setTimeout(() => { afterPaint = false; void preloadDiffs(); }, 0));
}

/** With no diff asked for, the engine starts this long after boot, at the next idle moment, if the inspector is open
 *  (diffSurfaceOpen) and the current project's git status has changes (noteChangedPaths). Otherwise it waits for intent,
 *  for the inspector to open or for a change to appear: a closed inspector never loads the workers and Shiki on its own. */
export const DIFF_IDLE_AFTER = 15_000;
/** Pointing at or focusing one of these is a diff about to be opened: change rows, Open diff, the Changes tab. */
export const DIFF_INTENT = '.turn-changes, [data-action="open-turn-diff"], [data-action="tab-changes"], .cv-file, .change-review-files';
let disarm: () => void = () => {};
/** Set once the idle moment passed without a reason to load (no changes, or the inspector closed): noted changes or the
 *  inspector opening run it again. */
let idleWaiting: (() => void) | undefined;

/** The inspector, where Changes, the file tree and open files live, is shown and not on its way out. */
export function diffSurfaceOpen(doc: Pick<Document, 'getElementById'> = document): boolean {
  const inspector = doc.getElementById('inspector');
  return Boolean(inspector && !inspector.hidden && !inspector.hasAttribute('data-leaving') && !inspector.closest('.inspector-closed'));
}

/** Calls `opened` when #inspector's hidden or data-leaving attribute changes; returns the stop function. */
function watchInspector(doc: Pick<Document, 'getElementById'>, opened: () => void): () => void {
  const inspector = doc.getElementById('inspector');
  if (!inspector || typeof MutationObserver !== 'function') return () => {};
  const observer = new MutationObserver(opened);
  observer.observe(inspector, { attributes: true, attributeFilter: ['hidden', 'data-leaving'] });
  return () => observer.disconnect();
}

/**
 * Starts the engine only when a diff is likely: something matching DIFF_INTENT is hovered or
 * focused (keyboard focus counts), `preloadDiffsAfterPaint()` is called (the Changes tab or a file
 * or diff view opened), or DIFF_IDLE_AFTER has passed, the page is idle, the inspector is open and the
 * current project's git status has changes. A diff opened before any of these still renders: mounting
 * starts the engine itself.
 */
export function preloadDiffsWhenWanted(doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'getElementById'> = document, win: Pick<Window, 'setTimeout' | 'clearTimeout'> & { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number } = window): void {
  if (preloaded || afterPaint) return;
  disarm();
  const near = (event: Event) => { if ((event.target as Element | null)?.closest?.(DIFF_INTENT)) preloadDiffsAfterPaint(); };
  let armed = true, unwatch = () => {};
  const wanted = () => armed && changedNames.length > 0 && diffSurfaceOpen(doc);
  // The changes may be gone or the inspector closed by the idle moment: then it waits for the next chance again.
  const idle = () => {
    if (!armed) return;
    unwatch(); unwatch = () => {};
    if (wanted()) { whenIdle(); return; }
    idleWaiting = idle;
    unwatch = watchInspector(doc, () => { if (wanted()) idle(); });
  };
  const whenIdle = () => { idleWaiting = undefined; if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(() => { if (wanted()) preloadDiffsAfterPaint(); else idle(); }, { timeout: 2_000 }); else preloadDiffsAfterPaint(); };
  const timer = win.setTimeout(idle, DIFF_IDLE_AFTER);
  doc.addEventListener('pointerover', near, { passive: true });
  doc.addEventListener('focusin', near);
  disarm = () => {
    disarm = () => {};
    armed = false;
    idleWaiting = undefined;
    unwatch();
    win.clearTimeout(timer);
    doc.removeEventListener('pointerover', near);
    doc.removeEventListener('focusin', near);
  };
}

let changedNames: string[] = [];
/** File names in the current git status, so the pool warms their grammars first. */
export function noteChangedPaths(paths: string[]): void {
  changedNames = paths.slice(0, 50).map(path => path.slice(path.lastIndexOf('/') + 1));
  const waiting = idleWaiting;
  if (waiting && changedNames.length) waiting();
}
export function likelyFileNames(): string[] { return changedNames; }

/** cyrb53 (53 bits) plus the length: a reopened, unchanged patch reuses its highlighted rows. */
export function patchKey(path: string, text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${path}:${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

export interface PatchChunk { text: string; lines: number; continued: boolean }
// Files longer than SPLIT_FROM lines become groups of whole hunks: a short first group
// so the first screen is highlighted (and parsed) first, then larger ones.
const SPLIT_FROM = 300;
const FIRST_CHUNK_LINES = 60;
const CHUNK_LINES = 500;

/**
 * Splits a patch at `diff --git` sections and, inside long sections, between hunks.
 * A continued chunk repeats its section's header so it parses on its own. Joining the
 * chunks' bodies gives back the patch; patches without hunks stay whole.
 */
export function splitPatch(patch: string): PatchChunk[] {
  const files: number[] = [], hunks: { at: number; line: number }[] = [];
  const lineAt = new Map<number, number>();
  let line = 0;
  for (let i = 0; ; line++) {
    if (patch.startsWith('diff --git ', i)) { files.push(i); lineAt.set(i, line); } else if (patch.startsWith('@@ ', i)) hunks.push({ at: i, line });
    const next = patch.indexOf('\n', i);
    if (next === -1 || next + 1 >= patch.length) { line++; break; }
    i = next + 1;
  }
  if (!files.length) { files.push(0); lineAt.set(0, 0); }
  const chunks: PatchChunk[] = [];
  let h = 0;
  files.forEach((headerAt, index) => {
    // Text before the first section (a commit message, say) stays with it, outside the repeated header.
    const start = index ? headerAt : 0;
    const end = files[index + 1] ?? patch.length, endLine = files[index + 1] !== undefined ? lineAt.get(end)! : line;
    const startLine = index ? lineAt.get(start)! : 0;
    const own: { at: number; line: number }[] = [];
    while (h < hunks.length && hunks[h].at < end) own.push(hunks[h++]);
    if (endLine - startLine <= SPLIT_FROM || own.length < 2 || !patch.startsWith('diff --git ', headerAt)) { chunks.push({ text: patch.slice(start, end), lines: endLine - startLine, continued: false }); return; }
    const header = patch.slice(headerAt, own[0].at);
    let groupAt = start, groupLine = startLine, target = FIRST_CHUNK_LINES;
    for (let k = 1; k <= own.length; k++) {
      const next = own[k] ?? { at: end, line: endLine };
      if (k < own.length && next.line - groupLine < target) continue;
      const continued = groupAt !== start;
      chunks.push({ text: (continued ? header : '') + patch.slice(groupAt, next.at), lines: next.line - groupLine, continued });
      groupAt = next.at; groupLine = next.line; target = CHUNK_LINES;
    }
  });
  return chunks;
}
