/* Line comments' anchoring and patch reading (docs/line-comments.md § Anchoring): what a comment
 * remembers about its lines, finding them again after the file changes, and the lines a unified
 * patch shows. Pure, with no runtime imports, so `node --test` loads it directly; the inline UI
 * (review-comments-ui.ts, review-comments-diff.ts) is its only runtime user. */
import type { Draft, ReviewAnchor, ReviewComment, ReviewUpdate } from './review-comments.ts';

/** A document's lines, 1-based by index + 1. A diff knows only some lines; the others are `undefined`. */
export type SparseLines = readonly (string | undefined)[];

export const CONTEXT_LINES = 3;

const norm = (line: string | undefined): string | undefined => line?.replace(/\s+$/, '');

/** In a diff's anchor, a covered line the patch did not show: it matches any line. Selections are
 * kept to one hunk (clampToHunk), so this is a safeguard: an empty string there would read as a
 * blank line and mark the comment outdated at once. */
export const UNSHOWN = '\u0000';

/** What a new comment remembers about the lines it covers, so it can be found again after edits.
 * Context lines are kept as arrays, so a blank line counts as context. In a whole file (`sparse`
 * false) it also notes whether the covered text is the only copy in the file (`unique`). */
export function makeAnchor(lines: SparseLines, startLine: number, endLine: number, sparse = false): ReviewAnchor {
  // Context stops where the content stops or, in a diff, where its known lines stop.
  const before: string[] = [], after: string[] = [];
  for (let line = startLine - 1; line >= 1 && before.length < CONTEXT_LINES && lines[line - 1] !== undefined; line--) before.unshift(lines[line - 1]!);
  for (let line = endLine + 1; line <= lines.length && after.length < CONTEXT_LINES && lines[line - 1] !== undefined; line++) after.push(lines[line - 1]!);
  const covered = Array.from({ length: Math.max(1, endLine - startLine + 1) }, (_, k) => lines[startLine - 1 + k] ?? UNSHOWN);
  const anchor: ReviewAnchor = { text: covered.join('\n'), before, after };
  if (!sparse) anchor.unique = copiesOf(lines, covered.map(norm)) === 1;
  return anchor;
}

/** How many positions hold `want` (normalized lines; `null` matches any line), stopping at two. */
function copiesOf(lines: SparseLines, want: readonly (string | null | undefined)[]): number {
  let copies = 0;
  for (let start = 1; start + want.length - 1 <= lines.length && copies < 2; start++) {
    if (want.every((text, k) => { const line = lines[start - 1 + k]; return text === null || (line !== undefined && norm(line) === text); })) copies++;
  }
  return copies;
}

export type AnchorLocation = {
  /** `same`: still at its lines; `moved`: found elsewhere; `outdated`: gone; `unknown`: these lines are not shown here. */
  state: 'same' | 'moved' | 'outdated' | 'unknown';
  startLine: number; endLine: number;
};

/** Text with a letter or digit in it: a line that says something, unlike `}` or a blank line. */
const distinctive = (want: readonly (string | null | undefined)[]) => want.some(text => text && /[\p{L}\p{N}]/u.test(text));

/** How many context lines next to a candidate position agree with the anchor's, nearest first, and
 * whether any of those that agree says something (`telling`): a `}` or blank line agreeing is weak
 * evidence, since such lines sit next to copies of a line all over a file. */
function contextMatch(lines: SparseLines, start: number, length: number, anchor: ReviewAnchor): { score: number; telling: boolean } {
  let score = 0, telling = false;
  const { before, after } = anchor;
  for (let k = 1; k <= before.length; k++) {
    if (norm(lines[start - 1 - k]) !== norm(before[before.length - k])) break;
    score++; telling ||= distinctive([before[before.length - k]]);
  }
  for (let k = 0; k < after.length; k++) {
    if (norm(lines[start - 1 + length + k]) !== norm(after[k])) break;
    score++; telling ||= distinctive([after[k]]);
  }
  return { score, telling };
}

/**
 * Finds a comment's lines in the current content. They are still where they were only when the
 * anchor text and all of its context are: a repeated line (`}`, a blank line) at the old start line
 * can be another copy, with lines inserted above. Otherwise every position holding the anchor text
 * (the old one included) is scored by its context: the best match wins, then the position nearest
 * the old one. A copy elsewhere that matches none of the context is not taken (the comment is
 * outdated, in a diff unknown, rather than moved onto an unrelated `}` or blank line), unless it is
 * the only copy in a whole file of text with a letter or digit in it: that line moved with all its
 * surroundings rewritten. The old position stands without any of its context only for such text: a
 * `}` or blank line now there is another copy (the code around it was deleted), so the comment is
 * outdated (in a diff, unknown unless the diff shows its context). Lines whose text changed while
 * all of their context stayed put were edited in place: the comment is outdated, never moved onto a
 * copy of its old text elsewhere. The only-copy rule needs the text to have been the only copy when
 * the comment was made (`anchor.unique`; anchors stored before it was recorded never use it), so a
 * comment on one of two `return foo;` lines does not jump to the other once its own is rewritten.
 * A copy away from the old position is taken on its context only when the context that agrees says
 * something (a line with a letter or digit) or is all of it: one `}` or blank line beside another
 * `return null;` is no evidence, so a comment whose function was deleted is outdated rather than
 * moved onto a similar line elsewhere. While the old position still holds the text, any agreeing
 * context (a blank line included) may pick between copies, since the comment stays on its text
 * either way. Trailing whitespace is ignored. A diff (`sparse`) shows only some lines, so the text may have
 * moved to lines it does not show: there a comment is `outdated` only when the diff shows all of its
 * lines and they differ; otherwise it is `unknown`.
 */
export function locateAnchor(lines: SparseLines, comment: Pick<ReviewComment, 'startLine' | 'endLine' | 'anchor'>, sparse = false): AnchorLocation {
  const { anchor } = comment;
  const want = anchor.text.split('\n').map(text => text === UNSHOWN ? null : norm(text));
  const length = want.length;
  const matches = (start: number) => want.every((text, k) => { const line = lines[start - 1 + k]; return text === null || (line !== undefined && norm(line) === text); });
  const span = (start: number) => ({ startLine: start, endLine: start + length - 1 });
  const where = (state: AnchorLocation['state']): AnchorLocation => ({ state, startLine: comment.startLine, endLine: comment.endLine });
  /** Whether every covered line at `start` is shown (a diff shows only some). */
  const shownAt = (start: number) => want.every((text, k) => text === null || lines[start - 1 + k] !== undefined);
  if (want.every(text => text === null)) return where('unknown');
  const old = comment.startLine >= 1 && matches(comment.startLine);
  const contextCount = anchor.before.length + anchor.after.length;
  const oldScore = comment.startLine >= 1 ? contextMatch(lines, comment.startLine, length, anchor).score : 0;
  if (old && oldScore === contextCount) return { state: 'same', ...span(comment.startLine) };
  // Everything around its old lines is still there and they say something else: they were edited
  // in place. Another copy of the old text elsewhere is not this comment's line.
  if (!old && contextCount > 0 && oldScore === contextCount && shownAt(comment.startLine)) return where('outdated');
  // With context to go on, a copy elsewhere whose context matches none of it is not this comment's
  // line: a blank line, `}` or `return null;` has copies all over a file. Only the old position
  // (the same text on the same line) may stand without it, and only for text that says something.
  const needsContext = contextCount > 0, telling = distinctive(want);
  let best = 0, bestScore = -1, bestDistance = Infinity, copies = 0, only = 0;
  for (let start = 1; start + length - 1 <= lines.length; start++) {
    if (!matches(start)) continue;
    copies++; only = start;
    const { score, telling: evidence } = contextMatch(lines, start, length, anchor), distance = Math.abs(start - comment.startLine);
    if (needsContext && score === 0 && (start !== comment.startLine || !telling)) continue;
    // Elsewhere, only `}` or blank lines agreeing is not enough once its own lines are gone.
    if (needsContext && start !== comment.startLine && !old && !evidence && score < contextCount) continue;
    if (score > bestScore || (score === bestScore && distance < bestDistance)) { best = start; bestScore = score; bestDistance = distance; }
  }
  // The one copy of a distinctive line in a whole file is that line, whatever now surrounds it. A
  // diff shows only part of the file, so there one copy says nothing.
  if (!best && !sparse && copies === 1 && telling && anchor.unique === true) best = only;
  if (best) return { state: best === comment.startLine ? 'same' : 'moved', ...span(best) };
  if (!sparse) return where('outdated');
  // Its text at its old lines, with none of its context: when the diff shows that context (which
  // differs), another copy is there; when it does not, the diff cannot tell.
  if (old && needsContext) {
    const shownContext = (anchor.before.length > 0 && lines[comment.startLine - 2] !== undefined) || (anchor.after.length > 0 && lines[comment.startLine - 1 + length] !== undefined);
    return where(shownContext ? 'outdated' : 'unknown');
  }
  // All of its lines shown, and not its text: it is not here (it may have moved out of view).
  return where(shownAt(comment.startLine) ? 'outdated' : 'unknown');
}

/** Whether a diff shows any of a comment's lines with other text than it was written on: then it is
 * not on them, even where the diff cannot tell where it went. */
function differsWhereShown(lines: SparseLines, comment: Pick<ReviewComment, 'startLine' | 'anchor'>): boolean {
  return comment.anchor.text.split('\n').some((text, k) => {
    const line = lines[comment.startLine - 1 + k];
    return text !== UNSHOWN && line !== undefined && norm(line) !== norm(text);
  });
}

/** The anchor to remember for lines found at `start`–`end`, when it differs from `anchor`: their
 * surroundings changed, so the next search goes by the code as it is now (a line whose context was
 * rewritten would otherwise match nothing once it moves); in a file, also when another copy of their
 * text appeared or went (`unique`). In a diff only when the patch shows the
 * lines and at least as much context as the anchor had, so a refetch showing less never shrinks it. */
function freshAnchor(lines: SparseLines, start: number, end: number, anchor: ReviewAnchor, sparse: boolean): ReviewAnchor | undefined {
  const next = makeAnchor(lines, start, end, sparse);
  if (sparse && (next.text.includes(UNSHOWN) || next.before.length < anchor.before.length || next.after.length < anchor.after.length)) return undefined;
  // A diff's anchor keeps what the file view recorded about copies (a diff cannot count them).
  if (sparse && anchor.unique !== undefined) next.unique = anchor.unique;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, k) => line === b[k]);
  return next.text === anchor.text && same(next.before, anchor.before) && same(next.after, anchor.after) && next.unique === anchor.unique ? undefined : next;
}

/** `away`: a diff cannot tell where the comment is now, and does not show the lines it was on. */
export type PlacedComment = { comment: ReviewComment; startLine: number; endLine: number; outdated: boolean; away?: boolean };

/**
 * Places comments against current content and lists what to remember: new lines for moved comments,
 * a fresh anchor for found ones whose surroundings changed, `outdated` for open ones whose lines are
 * gone, and `open` again for outdated ones that reappeared. A comment a diff cannot place (`unknown`)
 * keeps its lines and status: it is shown on them when the diff shows its last line and none of its
 * lines with other text, and otherwise as `away`.
 */
export function reconcileComments(comments: readonly ReviewComment[], lines: SparseLines, sparse = false): { placed: PlacedComment[]; updates: ReviewUpdate[] } {
  const placed: PlacedComment[] = [], updates: ReviewUpdate[] = [];
  const last = Math.max(1, lines.length);
  for (const comment of comments) {
    const where = locateAnchor(lines, comment, sparse);
    if (where.state === 'unknown') {
      placed.push({ comment, startLine: comment.startLine, endLine: comment.endLine, outdated: comment.status === 'outdated', away: lines[comment.endLine - 1] === undefined || differsWhereShown(lines, comment) });
      continue;
    }
    const found = where.state === 'same' || where.state === 'moved';
    const update: ReviewUpdate = { id: comment.id };
    if (where.state === 'moved') Object.assign(update, { startLine: where.startLine, endLine: where.endLine });
    if (comment.status === 'open' && where.state === 'outdated') update.status = 'outdated';
    if (comment.status === 'outdated' && found) update.status = 'open';
    const anchor = found ? freshAnchor(lines, where.startLine, where.endLine, comment.anchor, sparse) : undefined;
    if (anchor) update.anchor = anchor;
    if (Object.keys(update).length > 1) updates.push(update);
    // An outdated comment stays near where it was, inside the document.
    const endLine = found ? where.endLine : Math.min(comment.endLine, last), startLine = found ? where.startLine : Math.min(comment.startLine, endLine);
    placed.push({ comment, startLine, endLine, outdated: !found });
  }
  return { placed, updates };
}

/** Where a draft's lines are now (the agent may edit the file while the user writes): it follows its
 * text like a saved comment; when the text is gone it stays where it was, `lost` saying why. */
export function placeDraft(draft: Draft, lines: SparseLines, sparse = false): void {
  const where = locateAnchor(lines, draft, sparse);
  if (where.state === 'moved' || where.state === 'same') { draft.startLine = where.startLine; draft.endLine = where.endLine; }
  draft.lost = where.state === 'outdated' ? 'changed' : where.state === 'unknown' && (lines[draft.endLine - 1] === undefined || differsWhereShown(lines, draft)) ? 'away' : undefined;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One row of a unified patch, in patch order: a context line has both numbers, a deleted line only
 * `old`, an added one only `new`. */
export type PatchRow = { old?: number; new?: number; text: string };

/**
 * The rows of a unified patch, in order. Each hunk takes exactly the lines its `@@ -a,n +b,m @@`
 * header counts, so the empty string after a patch's final newline is not read as a blank context
 * line, and lines between hunks (another file's header) are not read at all.
 */
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let a = 0, b = 0, oldLeft = 0, newLeft = 0;
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      a = Number(hunk[1]); oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      b = Number(hunk[3]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const mark = line[0], text = line.slice(1);
    // An empty line inside a hunk is a blank context line whose leading space was stripped.
    if (mark === ' ' || line === '') { rows.push({ old: a++, new: b++, text }); oldLeft--; newLeft--; }
    else if (mark === '-') { rows.push({ old: a++, text }); oldLeft--; }
    else if (mark === '+') { rows.push({ new: b++, text }); newLeft--; }
    else if (mark !== '\\') { oldLeft = 0; newLeft = 0; }
  }
  return rows;
}

/** The lines a unified patch shows for each side, by line number (context lines are on both). */
export function patchSideLines(patch: string | readonly PatchRow[]): { old: (string | undefined)[]; new: (string | undefined)[] } {
  const old: (string | undefined)[] = [], next: (string | undefined)[] = [];
  for (const row of typeof patch === 'string' ? patchRows(patch) : patch) {
    if (row.old !== undefined) old[row.old - 1] = row.text;
    if (row.new !== undefined) next[row.new - 1] = row.text;
  }
  return { old, new: next };
}

export type PatchHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };
/** The hunks of a unified patch, from their `@@ -a,n +b,m @@` headers. */
export function patchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const match of patch.matchAll(new RegExp(HUNK.source, 'gm'))) {
    hunks.push({ oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]) });
  }
  return hunks;
}

export type DiffSide = 'deletions' | 'additions';
export type DiffSelection = { start: number; side?: DiffSide; end: number; endSide?: DiffSide };
/**
 * A diff selection kept to the hunk it starts in: the lines in the collapsed gap between hunks are
 * not shown, so a comment cannot cover them. A range that runs into another hunk ends at its own
 * hunk's edge, on the side it started on.
 */
export function clampToHunk(hunks: readonly PatchHunk[], range: DiffSelection): DiffSelection {
  const side = range.side ?? 'additions', endSide = range.endSide ?? side;
  const hunkOf = (on: DiffSide, line: number) => hunks.findIndex(h => on === 'deletions' ? line >= h.oldStart && line < h.oldStart + h.oldCount : line >= h.newStart && line < h.newStart + h.newCount);
  const own = hunkOf(side, range.start), other = hunkOf(endSide, range.end);
  if (own < 0 || other === own) return range;
  const h = hunks[own];
  const [first, last] = side === 'deletions' ? [h.oldStart, h.oldStart + h.oldCount - 1] : [h.newStart, h.newStart + h.newCount - 1];
  const forward = other < 0 ? range.end >= range.start : other > own;
  return { start: range.start, side, end: forward ? last : first, endSide: side };
}

/**
 * The lines a diff selection comments on. A range on one side keeps its lines on that side. A range
 * between a deleted line and an added or context one covers the rows between them in the unified
 * diff: it takes the new-side span of those rows (from the first to the last added or context
 * line), or, when they have none, their old-side span. `dropped`: the deleted lines among those rows
 * that a new-side span leaves out, so the comment can say so.
 */
export function selectionSpan(rows: readonly PatchRow[], range: DiffSelection): { side: 'old' | 'new'; startLine: number; endLine: number; dropped?: number[] } {
  const side = range.side ?? 'additions', endSide = range.endSide ?? side;
  if (side === endSide) {
    return { side: side === 'deletions' ? 'old' : 'new', startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) };
  }
  const rowOf = (on: DiffSide, line: number) => on === 'deletions'
    ? rows.findIndex(row => row.old === line && row.new === undefined)
    : rows.findIndex(row => row.new === line);
  const a = rowOf(side, range.start), b = rowOf(endSide, range.end);
  // Rows the patch does not have (it should): the line on the new side, as a point.
  if (a < 0 || b < 0) { const point = side === 'additions' ? range.start : range.end; return { side: 'new', startLine: point, endLine: point }; }
  const covered = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  const newLines = covered.flatMap(row => row.new === undefined ? [] : [row.new]);
  const dropped = covered.flatMap(row => row.new === undefined && row.old !== undefined ? [row.old] : []);
  if (newLines.length) return { side: 'new', startLine: Math.min(...newLines), endLine: Math.max(...newLines), ...dropped.length ? { dropped } : {} };
  const oldLines = covered.flatMap(row => row.old === undefined ? [] : [row.old]);
  return { side: 'old', startLine: Math.min(...oldLines), endLine: Math.max(...oldLines) };
}

/** The selection a diff shows for lines a comment covers (`selectionSpan`): one side, so the rows it
 * highlights are the ones the comment will be on. */
export const spanSelection = (span: { side: 'old' | 'new'; startLine: number; endLine: number }): DiffSelection => {
  const side: DiffSide = span.side === 'old' ? 'deletions' : 'additions';
  return { start: span.startLine, side, end: span.endLine, endSide: side };
};
