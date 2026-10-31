// Project icons in memory (zustand) and in a small cache file (expo-file-system), so tiles draw
// at once on the next launch. client.ts fetches them (`connect.projectIcons`); see icon-cache.ts.
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { iconKey, parseIcons, type IconCache } from './icon-cache.ts';
import { useConnect } from './index.ts';

export const useIcons = create<{ cache: IconCache }>(() => ({ cache: {} }));

const file = () => new File(Paths.cache, 'project-icons.json');

/** Demo mode keeps its seeded icons out of the cache file. */
const demo = () => useConnect.getState().demo;

let loaded: Promise<void> | null = null;
/** Reads the cache file once; entries fetched meanwhile win. */
export function loadIcons(): Promise<void> {
  if (demo()) return Promise.resolve();
  loaded ??= (async () => {
    try {
      const f = file();
      if (!f.exists) return;
      const stored = parseIcons(await f.text());
      useIcons.setState(s => ({ cache: { ...stored, ...s.cache } }));
    } catch { /* unreadable: start empty */ }
  })();
  return loaded;
}

export async function saveIcons(): Promise<void> {
  if (demo()) return;
  try {
    const f = file();
    if (!f.exists) f.create();
    await f.write(JSON.stringify(useIcons.getState().cache));
  } catch { /* a cache: the next fetch fills it again */ }
}

/** Forgets the icons in memory (leaving demo mode); the next load reads the file again. */
export function resetIcons() {
  loaded = null;
  useIcons.setState({ cache: {} });
}

/** Account deletion: memory and the cache file. */
export async function clearIcons(): Promise<void> {
  resetIcons();
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch { /* nothing to delete */ }
}

/** The project's icon as a data: URL, or null for the coloured initial. */
export const useProjectIcon = (deviceId: string | undefined, projectId: string | undefined) =>
  useIcons(s => (deviceId && projectId ? s.cache[iconKey(deviceId, projectId)]?.url ?? null : null));
