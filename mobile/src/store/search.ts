// The conversation search's pure parts (src/connect/api/search.ts, src/ui/SearchResults.tsx, the demo):
// the host's query bounds, its reply checked, title matches dropped and hits cut out for bolding.
// Pure, so tests/search.test.ts covers it in node.

/** The host's query bounds (search.rs MIN_QUERY/MAX_QUERY), in characters. */
export const MIN_SEARCH = 3;
export const MAX_SEARCH = 200;
/** Tasks one search lists. */
export const SEARCH_LIMIT = 20;

/** One task whose conversation mentions the query: its newest matching message. */
export interface ThreadHit {
  sessionId: string;
  title: string;
  projectName: string;
  messageId: number;
  snippet: string;
  at: number;
}

export interface ThreadSearch { results: ThreadHit[]; truncated: boolean }

/** The query as the host takes it, or null when it is too short or long to search. */
export function searchQuery(query: string): string | null {
  const clean = query.trim();
  const length = [...clean].length;
  return length >= MIN_SEARCH && length <= MAX_SEARCH ? clean : null;
}

const isHit = (value: unknown): value is ThreadHit => {
  const hit = value as Partial<ThreadHit> | null;
  return !!hit && typeof hit.sessionId === 'string' && typeof hit.messageId === 'number' && typeof hit.snippet === 'string';
};

/** The reply's well-formed rows (a title or project may be missing), never throwing on a malformed one. */
export function parseThreadSearch(reply: unknown): ThreadSearch {
  const value = reply as { results?: unknown; truncated?: unknown } | null;
  const rows = Array.isArray(value?.results) ? value.results.filter(isHit) : [];
  const results = rows.map(hit => ({
    sessionId: hit.sessionId,
    title: typeof hit.title === 'string' ? hit.title : '',
    projectName: typeof hit.projectName === 'string' ? hit.projectName : '',
    messageId: hit.messageId,
    snippet: hit.snippet,
    at: typeof hit.at === 'number' ? hit.at : 0,
  }));
  return { results, truncated: value?.truncated === true };
}

/** Hits not already shown as title matches (`shown`: `device/session` keys), per computer in order. */
export function withoutShown<T extends { deviceId: string; hit: ThreadHit }>(hits: readonly T[], shown: ReadonlySet<string>): T[] {
  return hits.filter(({ deviceId, hit }) => !shown.has(`${deviceId}/${hit.sessionId}`));
}

/** The snippet cut around each case-insensitive `query`, for bolding the hits; one plain part when none. */
export function matchParts(snippet: string, query: string): { text: string; hit: boolean }[] {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return [{ text: snippet, hit: false }];
  const lower = snippet.toLowerCase();
  // Lowercasing may change lengths (e.g. 'İ'): then only the whole snippet is safe to show.
  if (lower.length !== snippet.length) return [{ text: snippet, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: snippet.slice(from, at), hit: false });
    parts.push({ text: snippet.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < snippet.length || !parts.length) parts.push({ text: snippet.slice(from), hit: false });
  return parts;
}
