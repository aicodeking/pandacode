/** JSON-only ordering. Both input methods submit the same relative-placement operation. */
import { VIEW_ACTION_SURFACES, DOCUMENT_ACTION_SURFACES, CHANGES_ACTION_SURFACES, CHANGES_CONTROLS, SEARCH_CONTROLS, BROWSER_ACTION_SURFACES, BROWSER_CONTROLS, TERMINAL_ACTION_SURFACES, TERMINAL_CONTROLS, SIMULATOR_ACTION_SURFACES, SIMULATOR_CONTROLS, VM_ACTION_SURFACES, VM_CONTROLS } from './surfaces.ts';
export type Placement = { id: string; target: string; side: 'before' | 'after' };
import { BTW_ACTION_SURFACES, BTW_CONTROLS, DESIGN_ACTION_SURFACES, DESIGN_CONTROLS, BOARD_ACTION_SURFACES, BOARD_CONTROLS } from './surfaces.ts';
import { GITHUB_HUB_ACTION_SURFACES, GITHUB_HUB_CONTROLS } from './surfaces.ts';
import { PULL_ACTION_SURFACES } from './surfaces.ts';
import { WORKTREE_ACTION_SURFACES, MOODBOARD_ACTION_SURFACES, CLOUD_ACTION_SURFACES, MACHINES_ACTION_SURFACES } from './surfaces.ts';
import { SETTINGS_CORE_ACTION_SURFACES, SETTINGS_SECTIONS_LOCATION, SETTINGS_CONTROLS_LOCATION } from './surfaces.ts';
import { DOCK_ACTION_SURFACES, DOCK_CONTROLS_LOCATION, TEAM_CONTROLS_LOCATION, ROSTER_ACTION_SURFACES, ROSTER_CONTROLS_LOCATION, STATUS_ACTION_SURFACES, STATUS_CONTROLS_LOCATION } from './surfaces.ts';
import { SIDEBAR_ACTION_SURFACES, SIDEBAR_HEADER_LOCATION, SIDEBAR_PROJECTS_LOCATION, SIDEBAR_SECTIONS_LOCATION, SIDEBAR_ROWS_LOCATION, SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_ROWS_LOCATION } from './surfaces.ts';
import { COMPOSER_ACTION_SURFACES, COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION, PANEL_ACTION_SURFACES, PANEL_QUEUE_LOCATION, PANEL_SAVER_LOCATION, PANEL_COUNCIL_LOCATION, ATTACH_ACTION_SURFACES, ATTACH_RECIPES_LOCATION, ATTACH_WAKE_LOCATION, THREAD_EXTRAS_ACTION_SURFACES, THREAD_ATTACHMENTS_LOCATION, THREAD_FIND_LOCATION, THREAD_CHANGES_LOCATION, THREAD_LIMIT_LOCATION } from './surfaces.ts';
import { WINDOW_ACTION_SURFACES } from './window-surfaces.ts';
import { TILES_PICKER_ACTION_SURFACES, TILES_LOCATION, PICKER_LOCATION } from './surfaces.ts';
export type LayoutProposal = { id: string; title: string; location: string; rules: Placement[] };
export const actionLocations: readonly string[] = [...TILES_PICKER_ACTION_SURFACES, TILES_LOCATION, PICKER_LOCATION, ...THREAD_EXTRAS_ACTION_SURFACES, THREAD_ATTACHMENTS_LOCATION, THREAD_FIND_LOCATION, THREAD_CHANGES_LOCATION, THREAD_LIMIT_LOCATION, ...ATTACH_ACTION_SURFACES, ATTACH_RECIPES_LOCATION, ATTACH_WAKE_LOCATION, ...PANEL_ACTION_SURFACES, PANEL_QUEUE_LOCATION, PANEL_SAVER_LOCATION, PANEL_COUNCIL_LOCATION, ...COMPOSER_ACTION_SURFACES, COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION, ...Object.keys(WINDOW_ACTION_SURFACES), ...STATUS_ACTION_SURFACES, STATUS_CONTROLS_LOCATION, ...ROSTER_ACTION_SURFACES, ROSTER_CONTROLS_LOCATION, ...DOCK_ACTION_SURFACES, DOCK_CONTROLS_LOCATION, TEAM_CONTROLS_LOCATION, ...SIDEBAR_ACTION_SURFACES, SIDEBAR_HEADER_LOCATION, SIDEBAR_PROJECTS_LOCATION, SIDEBAR_SECTIONS_LOCATION, SIDEBAR_ROWS_LOCATION, SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_ROWS_LOCATION, ...SETTINGS_CORE_ACTION_SURFACES, SETTINGS_SECTIONS_LOCATION, SETTINGS_CONTROLS_LOCATION, ...MACHINES_ACTION_SURFACES, 'panda.machines.controls', 'panda.machines.targets', ...CLOUD_ACTION_SURFACES, 'panda.cloud.controls', 'panda.cloud.targets', ...MOODBOARD_ACTION_SURFACES, 'panda.moodboards.controls', ...WORKTREE_ACTION_SURFACES, 'panda.worktree.controls', ...PULL_ACTION_SURFACES, 'panda.pull.controls', ...GITHUB_HUB_ACTION_SURFACES, ...Object.keys(GITHUB_HUB_CONTROLS), ...BOARD_ACTION_SURFACES, ...Object.keys(BOARD_CONTROLS), ...BTW_ACTION_SURFACES, ...Object.keys(BTW_CONTROLS), ...DESIGN_ACTION_SURFACES, ...Object.keys(DESIGN_CONTROLS), 'panda.workspace.header.actions', 'panda.sidebar.footer', 'panda.inspector.actions', ...VIEW_ACTION_SURFACES, ...DOCUMENT_ACTION_SURFACES, ...CHANGES_ACTION_SURFACES, ...BROWSER_ACTION_SURFACES, ...TERMINAL_ACTION_SURFACES, ...SIMULATOR_ACTION_SURFACES, ...VM_ACTION_SURFACES, 'panda.documents.navigation', 'panda.documents.tabs', 'panda.documents.viewer', ...Object.keys(CHANGES_CONTROLS), ...Object.keys(SEARCH_CONTROLS), ...Object.keys(BROWSER_CONTROLS), ...Object.keys(TERMINAL_CONTROLS), ...Object.keys(SIMULATOR_CONTROLS), ...Object.keys(VM_CONTROLS)];
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
