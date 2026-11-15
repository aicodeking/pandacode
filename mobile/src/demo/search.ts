// Demo answers for the `search` feature group (src/connect/api/search.ts): the demo's saved messages
// searched as search.rs searches the desktop's, one row per task with a snippet around its newest hit.
// See ./index.ts.
import { MAX_SEARCH, MIN_SEARCH, SEARCH_LIMIT, type ThreadHit } from '../store/search.ts';
import type { DemoHandlers } from './index.ts';

const MAX_LIMIT = 50;
const SNIPPET_CHARS = 200;

/** At most SNIPPET_CHARS of `text` around the first case-insensitive `query`, whitespace collapsed (search.rs `snippet`). */
export function demoSnippet(text: string, query: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= SNIPPET_CHARS) return chars.join('');
  const needle = [...query.replace(/\s+/g, ' ').trim().toLowerCase()];
  const folded = chars.map(c => c.toLowerCase());
  const at = needle.length ? folded.findIndex((_, i) => needle.every((c, j) => folded[i + j] === c)) : -1;
  const room = SNIPPET_CHARS - 2;
  const start = at < 0 ? 0 : Math.min(Math.max(0, at - Math.floor(Math.max(0, room - needle.length) / 2)), chars.length - room);
  const end = Math.min(start + room, chars.length);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

export const handlers: DemoHandlers = {
  'search.threads': ({ state, deviceId }, p) => {
    const query = typeof p?.query === 'string' ? p.query.trim() : '';
    if ([...query].length < MIN_SEARCH || [...query].length > MAX_SEARCH) throw new Error(`Search for ${MIN_SEARCH} to ${MAX_SEARCH} characters.`);
    const limit = p?.limit == null ? SEARCH_LIMIT : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Limit must be between 1 and ${MAX_LIMIT}.`);
    const needle = query.toLowerCase();
    const hits: ThreadHit[] = (state.tasks[deviceId]?.tasks ?? []).filter(task => !task.botId).flatMap(task => {
      const messages = state.messages[`${deviceId}/${task.sessionId}`] ?? [];
      const hit = [...messages].reverse().find(m => (m.role === 'user' || m.role === 'assistant') && m.content.toLowerCase().includes(needle));
      return hit ? [{ sessionId: task.sessionId, title: task.title, projectName: task.projectName, messageId: hit.id, snippet: demoSnippet(hit.content, query), at: hit.createdAt }] : [];
    });
    hits.sort((a, b) => b.at - a.at);
    return { results: hits.slice(0, limit), truncated: hits.length > limit };
  },
};
