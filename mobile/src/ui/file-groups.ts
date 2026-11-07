// Changed files under their folders, in first-seen order. Pure (tested in node).

export interface FileGroup<T> { folder: string; files: T[] }

export function groupByFolder<T extends { path: string }>(files: readonly T[]): FileGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const folder = file.path.slice(0, Math.max(file.path.lastIndexOf('/'), 0));
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  return [...groups].map(([folder, list]) => ({ folder, files: list }));
}

const TALLY: readonly (readonly [string, string])[] = [['A', 'added'], ['M', 'modified'], ['D', 'deleted'], ['R', 'renamed'], ['C', 'copied'], ['U', 'conflicted']];

/** `1 added · 2 modified`, for the summary above a list of files. */
export function statusTally(letters: readonly (string | undefined)[]): string {
  return TALLY.flatMap(([letter, word]) => {
    const count = letters.filter(l => l === letter).length;
    return count ? [`${count} ${word}`] : [];
  }).join(' · ');
}
