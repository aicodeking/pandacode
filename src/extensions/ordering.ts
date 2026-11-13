/** JSON-only ordering. Both input methods submit the same relative-placement operation. */
import { VIEW_ACTION_SURFACES, DOCUMENT_ACTION_SURFACES, CHANGES_ACTION_SURFACES, CHANGES_CONTROLS, SEARCH_CONTROLS, BROWSER_ACTION_SURFACES, BROWSER_CONTROLS } from './surfaces.ts';
export type Placement = { id: string; target: string; side: 'before' | 'after' };
export type LayoutProposal = { id: string; title: string; location: string; rules: Placement[] };
export const actionLocations: readonly string[] = ['panda.workspace.header.actions', 'panda.sidebar.footer', 'panda.inspector.actions', ...VIEW_ACTION_SURFACES, ...DOCUMENT_ACTION_SURFACES, ...CHANGES_ACTION_SURFACES, ...BROWSER_ACTION_SURFACES, 'panda.documents.navigation', 'panda.documents.tabs', 'panda.documents.viewer', ...Object.keys(CHANGES_CONTROLS), ...Object.keys(SEARCH_CONTROLS), ...Object.keys(BROWSER_CONTROLS)];
export class OrderingCycle extends Error {
  readonly ids: string[];
  constructor(ids: string[]) { super(`OrderingCycle: ${ids.join(', ')}`); this.ids = ids; }
}
export function reorder(ids: readonly string[], operation: Placement): string[] {
  if (!['before', 'after'].includes(operation.side) || operation.id === operation.target || !ids.includes(operation.id) || !ids.includes(operation.target)) throw new Error('Invalid ordering target');
  const result = ids.filter(id => id !== operation.id);
  result.splice(result.indexOf(operation.target) + (operation.side === 'after' ? 1 : 0), 0, operation.id);
  return result;
}
export function proposalOrder(ids: readonly string[], rules: readonly Placement[]): string[] {
  const nodes = [...new Set([...ids, ...rules.flatMap(rule => [rule.id, rule.target])])];
  const edges = rules.map(rule => rule.side === 'before' ? [rule.id, rule.target] : [rule.target, rule.id]);
  const remaining = new Set(nodes), result: string[] = [];
  while (remaining.size) {
    const ready = nodes.find(id => remaining.has(id) && !edges.some(([from, to]) => to === id && remaining.has(from)));
    if (!ready) throw new OrderingCycle([...remaining].sort());
    remaining.delete(ready); if (ids.includes(ready)) result.push(ready);
  }
  return result;
}
