// The checkout search's pure parts (src/app/search.tsx): what the page shows for a mode and query.
// Pure, so tests/search.test.ts covers it in node.

export type FileSearchMode = 'names' | 'text';

/** Characters a Text search (files.grep) needs before it runs: it walks the whole checkout. */
export const TEXT_MIN = 3;

/** `empty`: nothing typed; `short`: a Text query under TEXT_MIN, which never runs (so never a
 * skeleton, and older results are dropped); `search`: run it and show its results. */
export type FileSearchPhase = 'empty' | 'short' | 'search';

export function fileSearchPhase(mode: FileSearchMode, query: string): FileSearchPhase {
  const clean = query.trim();
  if (!clean) return 'empty';
  return mode === 'text' && clean.length < TEXT_MIN ? 'short' : 'search';
}

/** The empty state's title for a Text query too short to run. */
export const textMinTitle = `Type at least ${TEXT_MIN} characters`;

/** Whether the shown results are for an older query: a search is answering, or the results were for
 * another query than the trimmed one now typed. The page keeps them but says it is searching. */
export function searchPending(result: { query: string } | null, query: string, busy: boolean): boolean {
  return busy || (result !== null && result.query !== query.trim());
}

/** The current query again (a reconnect, a retry), or null when it would not run. */
export function rerunQuery(mode: FileSearchMode, query: string): string | null {
  return fileSearchPhase(mode, query) === 'search' ? query : null;
}

/** The "N more" link under a file's first matches, or null when every match is shown. */
export function moreLabel(matches: number, shown: number): string | null {
  return matches > shown ? `${matches - shown} more in this file` : null;
}
