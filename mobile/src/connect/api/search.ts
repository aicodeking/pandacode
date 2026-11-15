// Host calls for the `search` feature group (src-tauri/src/remote/methods/search.rs): a phrase in
// the conversations of every task on a computer, as the desktop searches stored messages. The inbox
// shows the hits under its title matches (src/ui/SearchResults.tsx). See docs/remote-access.md,
// "Adding a method".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { parseThreadSearch, SEARCH_LIMIT, type ThreadSearch } from '../../store/search.ts';

export const SEARCH_METHODS = registerMethods(['search.threads'] as const);

export { matchParts, MAX_SEARCH, MIN_SEARCH, parseThreadSearch, SEARCH_LIMIT, searchQuery, withoutShown, type ThreadHit, type ThreadSearch } from '../../store/search.ts';

/** Tasks on `deviceId` whose conversation mentions `query` (already checked by `searchQuery`), newest first. */
export async function searchThreads(deviceId: string, query: string, limit = SEARCH_LIMIT): Promise<ThreadSearch> {
  return parseThreadSearch(await hostCall<unknown>(deviceId, 'search.threads', { query, limit }));
}
