// Unified diffs for the diff view, and Git status codes for the Changes list. Pure (tested in node).

export type DiffKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';
export interface DiffLine { kind: DiffKind; text: string }

const META = /^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode|Binary files)/;

/** Each line of a unified diff with its kind. File headers are meta only before a file's first hunk,
 * so a removed `-- comment` line inside a hunk stays a removal. */
export function diffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  let header = true;
  return diff.replace(/\n$/, '').split('\n').map(text => {
    if (text.startsWith('diff --git ')) header = true;
    else if (text.startsWith('@@')) header = false;
    const kind: DiffKind = text.startsWith('@@') ? 'hunk' : (header && META.test(text)) || text.startsWith('\\ ') ? 'meta'
      : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'context';
    return { kind, text };
  });
}

/** Added and removed lines per file (the `b/` path of each `diff --git` header) of a multi-file diff. */
export function fileCounts(diff: string): Record<string, { additions: number; deletions: number }> {
  const out: Record<string, { additions: number; deletions: number }> = {};
  let path = '';
  for (const line of diffLines(diff)) {
    const file = line.kind === 'meta' ? line.text.match(/^diff --git a\/.* b\/(.*)$/)?.[1] : undefined;
    if (file) out[path = file] = { additions: 0, deletions: 0 };
    else if (path && (line.kind === 'add' || line.kind === 'del')) {
      const { additions, deletions } = out[path];
      out[path] = line.kind === 'add' ? { additions: additions + 1, deletions } : { additions, deletions: deletions + 1 };
    }
  }
  return out;
}

/** One letter for a Git porcelain status (`??`, ` M`, `A `, `R `…): A, M, D, R, U or C. */
export function statusLetter(status: string): string {
  const code = status.trim();
  if (code === '??' || code.includes('A')) return 'A';
  if (code.includes('U')) return 'U';
  if (code.includes('R')) return 'R';
  if (code.includes('C')) return 'C';
  if (code.includes('D')) return 'D';
  return 'M';
}

export interface NumberedLine extends DiffLine { oldLine?: number; newLine?: number }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file|deleted file|old mode|new mode)/;

/** One file's lines for the diff view: Git's file headers go (the screen draws its own), and each line
 * gets its numbers, read from the hunk headers. A removed line has only `oldLine`, an added one only `newLine`. */
export function numberedLines(diff: string): NumberedLine[] {
  let oldAt = 0;
  let newAt = 0;
  return diffLines(diff).filter(l => l.kind !== 'meta' || !FILE_HEADER.test(l.text)).map(line => {
    if (line.kind === 'hunk') {
      const match = line.text.match(HUNK);
      oldAt = Number(match?.[1] ?? 0);
      newAt = Number(match?.[2] ?? 0);
      return line;
    }
    if (line.kind === 'add') return { ...line, newLine: newAt++ };
    if (line.kind === 'del') return { ...line, oldLine: oldAt++ };
    if (line.kind === 'context') return { ...line, oldLine: oldAt++, newLine: newAt++ };
    return line;
  });
}

/** The file header's numbers and status letter. The headers say it when present; a bare patch's first hunk does otherwise. */
export function diffSummary(diff: string): { additions: number; deletions: number; letter: string } {
  const lines = diffLines(diff);
  const additions = lines.filter(l => l.kind === 'add').length;
  const deletions = lines.filter(l => l.kind === 'del').length;
  const has = (prefix: string) => lines.some(l => l.kind === 'meta' && l.text.startsWith(prefix));
  const hunk = lines.find(l => l.kind === 'hunk')?.text ?? '';
  const letter = has('new file') || hunk.startsWith('@@ -0,0 ') ? 'A'
    : has('deleted file') || / \+0,0 @@/.test(hunk) ? 'D'
    : has('rename ') ? 'R' : 'M';
  return { additions, deletions, letter };
}
