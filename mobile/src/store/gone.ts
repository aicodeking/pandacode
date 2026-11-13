// Whether a task that dropped out of its host's list is really gone. tasks.list holds only the most
// recent tasks (200 by default), so an old task falls out of it whenever newer ones start; missing
// from the window alone proves nothing. Gone means a delete this phone made (deleteThread), or an
// archive here (the lists hide archived threads until a newer prompt).

/** Keys (taskKey) deleted or archived from this phone. */
export interface GoneMarks {
  deleted: Readonly<Record<string, true>>;
  archived: Readonly<Record<string, number>>;
}

/** Whether the task at `key`, not `listed` now, should close: only on a confirmed delete or archive. */
export const confirmedGone = (key: string, listed: boolean, marks: GoneMarks): boolean =>
  !listed && (marks.deleted[key] === true || marks.archived[key] !== undefined);

/** `deleted` with `keys` added; the same object when there is nothing new. */
export function withDeleted(deleted: Readonly<Record<string, true>>, keys: readonly string[]): Readonly<Record<string, true>> {
  const fresh = keys.filter(key => deleted[key] !== true);
  return fresh.length ? { ...deleted, ...Object.fromEntries(fresh.map(key => [key, true as const])) } : deleted;
}

/** Keys (taskKey form) of the asked tasks a subscribe reply reports `missing`: the host no longer has
 * them, so they were deleted on that computer. Only ids explicitly listed and asked about count. */
export function missingKeys(deviceId: string, missing: unknown, asked: readonly string[]): string[] {
  if (!Array.isArray(missing)) return [];
  const ids = new Set(asked);
  return [...new Set(missing.filter((id): id is string => typeof id === 'string' && ids.has(id)))].map(id => `${deviceId}/${id}`);
}
