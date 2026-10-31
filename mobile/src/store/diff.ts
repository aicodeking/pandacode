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
