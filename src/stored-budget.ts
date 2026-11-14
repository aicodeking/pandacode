/* Local storage shared by what a launch keeps for the next one, one key per item: composer drafts
 * (launch-restore.ts) and unsent line comments (review-comments.ts). Reads and removals that never
 * throw, the keys under a prefix, the age limits, and a write that keeps a feature's entries within
 * its budget. Pure, with no runtime imports, so `node --test` loads it with either user. */

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number };

export function safeRead(store: Pick<Store, 'getItem'>, key: string): string | null {
  try { return store.getItem(key); } catch { return null; }
}
export function safeRemove(store: Pick<Store, 'removeItem'>, key: string): void {
  try { store.removeItem(key); } catch { /* this launch only */ }
}
/** The keys under `prefix` (none when storage cannot be listed). */
export function storedKeys(store: Store, prefix: string): string[] {
  try { return Array.from({ length: store.length }, (_, index) => store.key(index)).filter((key): key is string => key?.startsWith(prefix) ?? false); }
  catch { return []; }
}

/** Saved longer than `maxAge` ago, or more than `slack` ahead of now (the clock ran ahead, so it
 * would otherwise outlive `maxAge`). */
export const expiredAt = (at: number, now: number, maxAge: number, slack: number): boolean => at < now - maxAge || at > now + slack;

/** What a feature has in storage: each item's size and when it was saved, so writes keep to its
 * budget by moving the oldest out first. */
export type StoredSizes = Map<string, { t: number; size: number }>;

export const storedTotal = (sizes: StoredSizes): number => { let total = 0; for (const { size } of sizes.values()) total += size; return total; };

/** Moves the oldest items out of storage (`evict` removes one; it stays in memory) until the total
 * of the others, `except`'s own left out, fits `limit`. */
export function evictOldest(sizes: StoredSizes, limit: number, evict: (id: string) => void, except?: string): void {
  let total = storedTotal(sizes) - (except === undefined ? 0 : sizes.get(except)?.size ?? 0);
  for (const [id, { size }] of [...sizes].filter(([id]) => id !== except).sort((a, b) => a[1].t - b[1].t)) {
    if (total <= limit) return;
    evict(id);
    total -= size;
  }
}

/**
 * Writes `value` under `key` for item `id` (`size` long, saved at `t`), keeping the feature's items
 * within `budget`: older ones move out first, and a full store moves out the older half of what is
 * stored and tries once more. Returns false (and removes `key`) when it still does not fit; then the
 * item is in memory only. `evict` must drop an item from `sizes` and storage.
 */
export function writeWithinBudget(store: Store, sizes: StoredSizes, item: { id: string; key: string; value: string; t: number; size: number }, budget: number, evict: (id: string) => void, warn: (error: unknown) => void): boolean {
  const { id, key, value } = item;
  evictOldest(sizes, budget - item.size, evict, id);
  try { store.setItem(key, value); }
  catch {
    evictOldest(sizes, Math.floor((storedTotal(sizes) - (sizes.get(id)?.size ?? 0)) / 2), evict, id);
    try { store.setItem(key, value); }
    catch (error) { warn(error); sizes.delete(id); safeRemove(store, key); return false; }
  }
  sizes.set(id, { t: item.t, size: item.size });
  return true;
}
