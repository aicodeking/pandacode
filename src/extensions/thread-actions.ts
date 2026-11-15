import { mountExtensionActions } from './header';
import { THREAD_ACTION_SURFACES, THREAD_EXTRAS_ACTION_SURFACES, type ThreadActionLocation, type ThreadExtrasActionLocation } from './surfaces';
import type { Json } from './contracts';
import { extensionsSnapshot, onExtensionsChanged } from './manager';

type Location = ThreadActionLocation | ThreadExtrasActionLocation | 'panda.workspace.tiles.actions';
/** The tile bars' slot shares these markers: each tile's marker names that tile's own thread. */
const LOCATIONS: readonly string[] = [...THREAD_ACTION_SURFACES, ...THREAD_EXTRAS_ACTION_SURFACES, 'panda.workspace.tiles.actions'];
/** A marker's captured ids: one id, or the bounded list a transcript-extras marker carries. */
function selectionIds(host: HTMLElement): string[] {
  if (host.dataset.extensionSelectionIds === undefined) return [host.dataset.extensionSelectionId!];
  try { const ids = JSON.parse(host.dataset.extensionSelectionIds) as unknown; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 100) : []; } catch { return []; }
}

/** Explicit host markers only. Stream updates retain mounted controls; removed hosts dispose
 * their registrations/transients. No textarea, attachment, queue or business handler is touched. */
export function mountThreadActions(root: HTMLElement, context: (sessionId: string) => Record<string, Json> | undefined, notify: (message: string) => void): () => void {
  const mounted = new Map<HTMLElement, () => void>();
  let locations = new Set<string>();
  const scan = () => {
    for (const [host, dispose] of mounted) if (!root.contains(host) || !locations.has(host.dataset.extensionActionSlot!)) { dispose(); mounted.delete(host); }
    if (!locations.size) return;
    for (const host of root.querySelectorAll<HTMLElement>('[data-extension-action-slot]')) {
      if (mounted.has(host)) continue;
      const location = host.dataset.extensionActionSlot as Location;
      if (!LOCATIONS.includes(location) || !locations.has(location)) continue;
      const sessionId = host.dataset.extensionSession!, captured = context(sessionId);
      if (!captured) continue;
      const selection = { kind: host.dataset.extensionSelectionKind!, ids: selectionIds(host) };
      mounted.set(host, mountExtensionActions(host, location, () => ({ ...captured, selection }), notify));
    }
  };
  const sync = () => {
    const snapshot = extensionsSnapshot();
    locations = new Set(snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled).flatMap(item => item.manifest.contributes.menus?.map(menu => menu.location).filter(location => LOCATIONS.includes(location)) ?? []));
    scan();
  };
  const observer = new MutationObserver(records => {
    // Ignore text/token churn and our own controls, but dispose a removed marker immediately.
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('[data-extension-action-slot]') || node.querySelector('[data-extension-action-slot]'))))) scan();
  });
  observer.observe(root, { childList: true, subtree: true });
  const cleanup = onExtensionsChanged(sync); sync();
  return () => { observer.disconnect(); cleanup(); for (const dispose of mounted.values()) dispose(); mounted.clear(); };
}
