// File mentions in the composer, as on the desktop (src/file-mentions.ts, docs/file-mentions.md):
// `@` after a space, an opening bracket or at the start opens a picker over the task's files, and
// picking one puts the same reference text in the draft the desktop would, so the agent receives
// it identically. References stay plain editable text; nothing is read or attached.
// Pure: no React, no network. The menu and its search live in ../ui/MentionMenu.tsx.

/** One picker row (files.search's entries). */
export interface MentionEntry { name: string; path: string; dir: boolean }

/** The `@…` being typed at the caret: its range in the draft and the query (unquoted). */
export interface MentionToken { start: number; end: number; query: string }

/** As the desktop: longer queries are not searched. */
export const MAX_MENTION_QUERY = 256;
/** Rows the picker shows (the desktop's composer shows 40). */
export const MAX_MENTIONS = 40;

// `@` then either a quoted path (straight or smart quotes, escapes allowed) or a bare one. An email
// address or package@version is ordinary text: the `@` must follow the start, a space or a bracket.
const TOKEN = /(?:^|[\s([{])(@(?:["“](?:[^"“”\\\r\n]|\\.)*|[^\s"“”@()[\]{},;]*))$/;
const BARE_TAIL = /^[^\s"“”@()[\]{},;]*/;
const PLAIN_PATH = /^[\p{L}\p{N}_./-]+$/u;

/** The reference for a path, as `fileMention` on the desktop: quoted and escaped when it has spaces or punctuation. Folders end in `/`. */
export function fileMention(path: string, dir = false): string {
  const target = dir ? path.replace(/\/?$/, '/') : path;
  return '@' + (PLAIN_PATH.test(target) ? target : JSON.stringify(target));
}

/** The mention under the caret, or null. A selection (`selectionEnd` past the caret) is never a mention. */
export function mentionToken(text: string, caret: number, selectionEnd = caret): MentionToken | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null;
  const match = TOKEN.exec(text.slice(0, caret));
  if (!match) return null;
  const raw = match[1];
  const start = caret - raw.length;
  let end = caret;
  let query = raw.slice(1);
  if (/^@["“]/.test(raw)) {
    query = raw.slice(2);
    try { query = JSON.parse(`"${query}"`) as string; } catch { /* A partly typed escape is still searchable. */ }
    // The rest of a quoted reference, through its closing quote, is replaced too.
    let escaped = false;
    while (end < text.length && !/[\r\n]/.test(text[end])) {
      const next = text[end++];
      if (!escaped && (next === '"' || next === '”')) break;
      escaped = !escaped && next === '\\';
    }
  } else {
    end += BARE_TAIL.exec(text.slice(caret))![0].length;
  }
  return query.length <= MAX_MENTION_QUERY ? { start, end, query } : null;
}

/** The draft with `entry`'s reference in place of `token`, followed by one space, and the caret after that space. */
export function insertMention(text: string, token: MentionToken, entry: Pick<MentionEntry, 'path' | 'dir'>): { text: string; caret: number } {
  const reference = fileMention(entry.path, entry.dir);
  const suffix = text.slice(token.end);
  const next = /^\s/.test(suffix) ? `${text.slice(0, token.start)}${reference}${suffix}` : `${text.slice(0, token.start)}${reference} ${suffix}`;
  return { text: next, caret: token.start + reference.length + 1 };
}

/** files.search's rows for the picker: valid, without repeats, at most MAX_MENTIONS. */
export function mentionRows(entries: readonly unknown[]): MentionEntry[] {
  const seen = new Set<string>();
  const rows: MentionEntry[] = [];
  for (const entry of entries) {
    const row = entry as Partial<MentionEntry> | null;
    if (!row || typeof row.path !== 'string' || !row.path || seen.has(row.path)) continue;
    seen.add(row.path);
    rows.push({ name: typeof row.name === 'string' && row.name ? row.name : row.path.split('/').pop() ?? row.path, path: row.path, dir: row.dir === true });
    if (rows.length === MAX_MENTIONS) break;
  }
  return rows;
}

/** Recent query results (the desktop keeps 12 for five seconds), so backspacing doesn't search again. */
export interface MentionCache { get(query: string, now: number): MentionEntry[] | undefined; set(query: string, rows: MentionEntry[], now: number): MentionCache }

export const MENTION_CACHE_SIZE = 12;
export const MENTION_CACHE_MS = 5_000;

/** An immutable cache: `set` returns a new one. */
export function mentionCache(entries: readonly (readonly [string, { rows: MentionEntry[]; at: number }])[] = []): MentionCache {
  const map = new Map(entries);
  return {
    get: (query, now) => {
      const hit = map.get(query);
      return hit && now - hit.at < MENTION_CACHE_MS ? hit.rows : undefined;
    },
    set: (query, rows, now) => mentionCache([...[...map].filter(([key]) => key !== query), [query, { rows, at: now }] as const].slice(-MENTION_CACHE_SIZE)),
  };
}
