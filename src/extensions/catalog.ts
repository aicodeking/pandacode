/** Public JSON-only discovery. Definitions are logical locations, not selectors or DOM handles. */
import { createDeclarativeActivation } from './activation.ts';
import type { ExtensionSnapshot } from './manager';
import { DESIGN_ACTION_SURFACES, DESIGN_CONTROLS, VIEW_ACTION_SURFACES, DOCUMENT_ACTION_SURFACES, THREAD_ACTION_SURFACES, SETTINGS_ACTION_SURFACES, SETTINGS_DATA_SURFACES, CONTEXT_COMMANDS, CHANGES_ACTION_SURFACES, CHANGES_CONTROLS, SEARCH_CONTROLS, BROWSER_ACTION_SURFACES, BROWSER_CONTROLS, TERMINAL_ACTION_SURFACES, TERMINAL_CONTROLS, SIMULATOR_ACTION_SURFACES, SIMULATOR_CONTROLS, VM_ACTION_SURFACES, VM_CONTROLS } from './surfaces.ts';
import { WINDOW_ACTION_SURFACES, surfaceWindow } from './window-surfaces.ts';
import { BTW_ACTION_SURFACES, BTW_CONTROLS } from './surfaces.ts';
import { BOARD_ACTION_SURFACES, BOARD_CONTROLS } from './surfaces.ts';
import { GITHUB_HUB_ACTION_SURFACES, GITHUB_HUB_CONTROLS } from './surfaces.ts';
import { PULL_ACTION_SURFACES, PULL_CONTROLS, PULL_PROTECTED_LOCATION } from './surfaces.ts';
import { WORKTREE_ACTION_SURFACES, WORKTREE_CONTROLS, WORKTREE_PROTECTED_LOCATION } from './surfaces.ts';
import { MOODBOARD_ACTION_SURFACES, MOODBOARD_CONTROLS, MOODBOARD_PROTECTED_LOCATION } from './surfaces.ts';
import { CLOUD_ACTION_SURFACES, CLOUD_CONTROLS, CLOUD_PROTECTED_LOCATION } from './surfaces.ts';
import { MACHINES_ACTION_SURFACES, MACHINES_CONTROLS, MACHINES_PROTECTED_LOCATION } from './surfaces.ts';
import { SETTINGS_CORE_ACTION_SURFACES, SETTINGS_CORE_CONTROLS, SETTINGS_PROTECTED_CONTROLS, SETTINGS_PINNED_SECTIONS, SETTINGS_SECTIONS_LOCATION, SETTINGS_CONTROLS_LOCATION, SETTINGS_PROTECTED_LOCATION } from './surfaces.ts';
import { DIALOG_ACTION_SURFACES, DIALOG_DATA_SURFACES, DIALOG_PROTECTED_LOCATION, MAIN_DIALOG_PROTECTED } from './surfaces.ts';
import { SECTIONS as SETTINGS_SECTIONS } from '../settings-sections.ts';
import { registeredInspectorViews, INSPECTOR_VIEW_LOCATION } from './views-state.ts';
import { INSPECTOR_VIEWS } from '../inspector-tabs.ts';

export const HEADER = 'panda.workspace.header.actions';
export const FOOTER = 'panda.sidebar.footer';
export const INSPECTOR = 'panda.inspector.actions';
export type PublicCommandId = 'panda.ui/toggle-sidebar' | 'panda.ui/open-settings' | 'panda.ui/toggle-theme';
export type CatalogQuery = { windowId?: string; owner?: string; type?: string; location?: string; cursor?: string; limit?: number };
type Availability = { available: boolean; reason?: 'HostUnavailable' };
export type SurfaceMetadata = Availability & { id: string; owner: string; type: 'action-slot' | 'declarative-data-slot'; location: string; label: string; supportedOperations: string[]; supportedItemTypes: string[]; windows: string[]; capabilities?: { inlineSelect: boolean; selectFallback: string; dialogPlacement: string; icons: boolean; limitations: string[]; qualification: 'experimental' } };
export type ItemMetadata = Availability & { id: string; owner: string; version?: string; defaultPosition?: number; type: 'button' | 'menu-trigger' | 'link' | 'status' | 'badge' | 'view'; location: string; label: string; supportedOperations: string[]; command?: { id: string; inputSchema: { type: 'null' }; capability: 'host.ui'; supportedContexts: string[] } };
export type CatalogPage<T> = { schemaVersion: 1; revision: string; items: T[]; nextCursor: string | null };
export class CatalogError extends Error {
  readonly schemaVersion = 1;
  readonly code: 'InvalidQuery' | 'StaleContext' | 'NotFound' | 'HostUnavailable' | 'InvalidArguments';
  constructor(code: CatalogError['code']) { super(code); this.code = code; }
}

const coreItems: ItemMetadata[] = [
  // Settings sections reorder; only sections without a protected control hide. Protected rows carry their reason.
  ...SETTINGS_SECTIONS.map(({ id, label }): ItemMetadata => ({ id: `${SETTINGS_SECTIONS_LOCATION}/${id}`, owner: 'panda.core', type: 'button', location: SETTINGS_SECTIONS_LOCATION, label, supportedOperations: Object.hasOwn(SETTINGS_PINNED_SECTIONS, id) ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder'], available: true })),
  ...SETTINGS_CORE_CONTROLS.map(([id, label]): ItemMetadata => ({ id: `${SETTINGS_CONTROLS_LOCATION}/${id}`, owner: 'panda.core', type: 'button', location: SETTINGS_CONTROLS_LOCATION, label, supportedOperations: ['inspect'], available: true })),
  // Protected main dialogs never mount an extension band; each carries its reason.
  ...MAIN_DIALOG_PROTECTED.map(([id, label, reason]): ItemMetadata => ({ id: `${DIALOG_PROTECTED_LOCATION}/${id}`, owner: 'panda.core', type: 'button', location: DIALOG_PROTECTED_LOCATION, label: `${label} — ${reason}`, supportedOperations: ['inspect'], available: true })),
  ...SETTINGS_PROTECTED_CONTROLS.map(([id, label, , reason]): ItemMetadata => ({ id: `${SETTINGS_PROTECTED_LOCATION}/${id}`, owner: 'panda.core', type: 'button', location: SETTINGS_PROTECTED_LOCATION, label: `${label} — ${reason}`, supportedOperations: ['inspect'], available: true })),
  ...Object.entries(MACHINES_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(CLOUD_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(MOODBOARD_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(WORKTREE_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(PULL_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(GITHUB_HUB_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(BOARD_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(BTW_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: id === 'stop' || id === 'focus' ? ['inspect'] : ['inspect', 'hide', 'show', 'reorder'], available: true }))),
  ...Object.entries(VM_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(DESIGN_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(SIMULATOR_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(TERMINAL_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(BROWSER_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(SEARCH_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...Object.entries(CHANGES_CONTROLS).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...([['open-files', 'Open files'], ['close-open-files', 'Close open files']] as const).map(([id, label]): ItemMetadata => ({ id: `panda.documents.navigation/${id}`, owner: 'panda.core', type: 'button', location: 'panda.documents.navigation', label, supportedOperations: ['inspect'], available: true })),
  ...Object.entries({ 'panda.documents.tabs': [['select', 'Select document'], ['close', 'Close document']], 'panda.documents.actions': [['attach', 'Attach'], ['copy', 'Copy file'], ['preview', 'Preview in browser']], 'panda.documents.viewer': [['rendered', 'Rendered'], ['raw', 'Raw'], ['wrap', 'Wrap'], ['sheet', 'Sheet selection'], ['zoom', 'Actual size']] }).flatMap(([location, controls]) => controls.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  { id: 'panda.workspace.header.actions/sidebar-toggle', owner: 'panda.core', type: 'button', location: HEADER, label: 'Toggle sidebar', supportedOperations: ['inspect', 'invoke'], command: command('panda.ui/toggle-sidebar'), available: true },
  { id: 'panda.workspace.header.actions/view-menu', owner: 'panda.core', type: 'menu-trigger', location: HEADER, label: 'Workspace view', supportedOperations: ['inspect'], available: true },
  ...([
    ['support', 'Help & support', 'button'], ['usage', 'Agent usage', 'button'],
    ['settings', 'Settings', 'button'], ['star', 'Star PandaCode on GitHub', 'button'], ['theme', 'Toggle theme', 'button'],
  ] as const).map(([id, label, type]): ItemMetadata => ({ id: `${FOOTER}/${id}`, owner: 'panda.core', type, location: FOOTER, label, supportedOperations: id === 'settings' || id === 'theme' ? ['inspect', 'invoke'] : ['inspect'], ...(id === 'settings' ? { command: command('panda.ui/open-settings') } : id === 'theme' ? { command: command('panda.ui/toggle-theme') } : {}), available: true })),
  ...Object.entries(CONTEXT_COMMANDS).flatMap(([location, commands]) => commands.map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
  ...VIEW_ACTION_SURFACES.filter(location => location.endsWith('.toolbar')).flatMap(location => ([['refresh', 'Refresh project'], ['hide', 'Hide inspector']] as const).map(([id, label]): ItemMetadata => ({ id: `${location}/${id}`, owner: 'panda.core', type: 'button', location, label, supportedOperations: ['inspect'], available: true }))),
];
function command(id: PublicCommandId): NonNullable<ItemMetadata['command']> { return { id, inputSchema: { type: 'null' }, capability: 'host.ui', supportedContexts: ['main'] }; }
function availability(windowId: string, location: string): Availability { return windowId === surfaceWindow(location) ? { available: true } : { available: false, reason: 'HostUnavailable' }; }
function queryChecked(query: CatalogQuery): Required<Pick<CatalogQuery, 'windowId' | 'limit'>> & CatalogQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['windowId', 'owner', 'type', 'location', 'cursor', 'limit'].includes(key))) throw new CatalogError('InvalidQuery');
  for (const [key, value] of Object.entries(query)) if (key !== 'limit' && (typeof value !== 'string' || value.length > (key === 'cursor' ? 4096 : 512))) throw new CatalogError('InvalidQuery');
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CatalogError('InvalidQuery');
  return { ...query, windowId: query.windowId ?? 'main', limit };
}

/** One immutable snapshot per call; cursors are bound to the exact catalog and filters. */
export function createUiCatalog(snapshot: () => ExtensionSnapshot) {
  const instance = crypto.randomUUID();
  let previous = '', sequence = 0;
  const list = <T extends SurfaceMetadata | ItemMetadata>(kind: 'surfaces' | 'items', query: CatalogQuery = {}): CatalogPage<T> => {
    const q = queryChecked(query), state = snapshot();
    const surfaces: SurfaceMetadata[] = [
      { id: 'panda.settings', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.settings', label: 'Host core Settings presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['actions-first'], windows: ['main'], available: true },
      ...([SETTINGS_SECTIONS_LOCATION, SETTINGS_CONTROLS_LOCATION] as const).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      { id: SETTINGS_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: SETTINGS_PROTECTED_LOCATION, label: 'Protected Settings credentials, grants, pairing, privacy and recovery', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...SETTINGS_CORE_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.machines', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.machines', label: 'Host execution target and machine coordination presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-below'], windows: ['main'], available: true },
      ...(['panda.machines.controls', 'panda.machines.targets'] as const).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      { id: MACHINES_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: MACHINES_PROTECTED_LOCATION, label: 'Protected execution host, pairing, link and access consent', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...MACHINES_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.cloud', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.cloud', label: 'Host cloud machine presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-below'], windows: ['main'], available: true },
      ...(['panda.cloud.controls', 'panda.cloud.targets'] as const).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      { id: CLOUD_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: CLOUD_PROTECTED_LOCATION, label: 'Protected cloud machine confirmations, provisioning and credentials', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...CLOUD_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.moodboards', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.moodboards', label: 'Host moodboard presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['viewer-first'], windows: ['main'], available: true },
      { id: 'panda.moodboards.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.moodboards.controls', label: 'panda.moodboards.controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      { id: MOODBOARD_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: MOODBOARD_PROTECTED_LOCATION, label: 'Protected moodboard confirmations and file access', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...MOODBOARD_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.worktree', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.worktree', label: 'Host branch and worktree presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-first'], windows: ['main'], available: true },
      { id: 'panda.worktree.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.worktree.controls', label: 'panda.worktree.controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      { id: WORKTREE_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: WORKTREE_PROTECTED_LOCATION, label: 'Protected branch and worktree confirmations', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...WORKTREE_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.pull', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.pull', label: 'Host Pull request presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['tabs-first'], windows: ['main'], available: true },
      { id: 'panda.pull.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.pull.controls', label: 'panda.pull.controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      { id: PULL_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: PULL_PROTECTED_LOCATION, label: 'Protected merge confirmation', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...PULL_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.githubHub', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.githubHub', label: 'Host GitHub hub presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['tabs-first'], windows: ['main'], available: true },
      ...Object.keys(GITHUB_HUB_CONTROLS).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      ...GITHUB_HUB_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.board', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.board', label: 'Host Board presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['review-first'], windows: ['main'], available: true },
      ...Object.keys(BOARD_CONTROLS).filter(location => !BOARD_ACTION_SURFACES.includes(location as typeof BOARD_ACTION_SURFACES[number])).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      ...BOARD_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.btw', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.btw', label: 'Host BTW presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['composer-first'], windows: ['main'], available: true },
      ...Object.keys(BTW_CONTROLS).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: location === 'panda.btw.header' ? 'action-slot' : 'declarative-data-slot', location, label: location, supportedOperations: location === 'panda.btw.header' ? ['inspect', 'contribute', 'hide', 'show', 'reorder'] : ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      ...BTW_ACTION_SURFACES.filter(location => location !== 'panda.btw.header').map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.design', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.design', label: 'Host Design presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['comments-first'], windows: ['main'], available: true },
      { id: 'panda.design.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.design.controls', label: 'Design controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...DESIGN_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.vm', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.vm', label: 'Host VM presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-first'], windows: ['main'], available: true },
      { id: 'panda.vm.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.vm.controls', label: 'VM controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...VM_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.simulator', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.simulator', label: 'Host Simulator presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-first'], windows: ['main'], available: true },
      { id: 'panda.simulator.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.simulator.controls', label: 'Simulator controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...SIMULATOR_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.terminal', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.terminal', label: 'Host Terminal presentation v1', supportedOperations: ['inspect', 'replace', 'move', 'hide', 'show'], supportedItemTypes: ['tabs-below'], windows: ['main'], available: true },
      { id: 'panda.terminal.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.terminal.controls', label: 'Terminal controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...TERMINAL_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location, supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      { id: 'panda.browser.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.browser.controls', label: 'Browser controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'input'], windows: ['main'], available: true },
      { id: 'panda.browser', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.browser', label: 'Host Browser presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['controls-below'], windows: ['main'], available: true },
      { id: 'panda.search.controls', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.search.controls', label: 'Search controls', supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      { id: 'panda.search', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.search', label: 'Host Search presentation v1', supportedOperations: ['inspect', 'replace', 'move'], supportedItemTypes: ['results-first'], windows: ['main'], available: true },
      ...Object.keys(CHANGES_CONTROLS).map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      { id: 'panda.changes', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.changes', label: 'Host Changes presentation v1', supportedOperations: ['inspect', 'replace'], supportedItemTypes: ['commit-first'], windows: ['main'], available: true },
      ...['panda.documents.navigation', 'panda.documents.tabs', 'panda.documents.viewer'].map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], supportedItemTypes: ['button'], windows: ['main'], available: true })),
      { id: 'panda.documents', owner: 'panda.core', type: 'declarative-data-slot', location: 'panda.documents', label: 'Host document presentation v1', supportedOperations: ['inspect', 'replace', 'move', 'hide', 'show'], supportedItemTypes: ['viewer-first'], windows: ['main'], available: true },
      { id: INSPECTOR_VIEW_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: INSPECTOR_VIEW_LOCATION, label: 'Inspector views', supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['view', 'list', 'tree', 'table', 'tabs', 'progress'], windows: ['main'], available: true },
      { id: HEADER, owner: 'panda.core', type: 'action-slot', location: HEADER, label: 'Workspace header actions', supportedOperations: ['inspect', 'contribute'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true },
      { id: FOOTER, owner: 'panda.core', type: 'action-slot', location: FOOTER, label: 'Sidebar footer', supportedOperations: ['inspect', 'contribute'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true },
      { id: INSPECTOR, owner: 'panda.core', type: 'action-slot', location: INSPECTOR, label: 'Inspector actions (when open)', supportedOperations: ['inspect', 'contribute'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true },
      ...[...VIEW_ACTION_SURFACES, ...DOCUMENT_ACTION_SURFACES, ...CHANGES_ACTION_SURFACES, ...BROWSER_ACTION_SURFACES].map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger'], windows: ['main'], available: true })),
      ...THREAD_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger', 'status', 'badge'], windows: ['main'], available: true })),
      ...SETTINGS_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger', 'status', 'badge'], windows: ['main'], available: true })),
      ...SETTINGS_DATA_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute'], supportedItemTypes: location === 'panda.settings.pages' ? ['settings-page'] : location === 'panda.commands' ? ['command'] : ['keybinding'], windows: ['main'], available: true })),
      ...DIALOG_ACTION_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: ['button', 'menu-trigger', 'status', 'badge'], windows: ['main'], available: true })),
      ...DIALOG_DATA_SURFACES.map((location): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'declarative-data-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: ['inspect', 'contribute'], supportedItemTypes: ['text'], windows: ['main'], available: true })),
      { id: DIALOG_PROTECTED_LOCATION, owner: 'panda.core', type: 'declarative-data-slot', location: DIALOG_PROTECTED_LOCATION, label: 'Protected destructive, credential and recovery dialogs', supportedOperations: ['inspect'], supportedItemTypes: ['button'], windows: ['main'], available: true },
      ...Object.entries(WINDOW_ACTION_SURFACES).map(([location, window]): SurfaceMetadata => ({ id: location, owner: 'panda.core', type: 'action-slot', location, label: location.replace('panda.', '').replaceAll('.', ' '), supportedOperations: location === 'panda.tray.menu' ? ['inspect', 'contribute'] : ['inspect', 'contribute', 'hide', 'show', 'reorder'], supportedItemTypes: location === 'panda.tray.menu' ? ['button', 'menu-trigger'] : ['button', 'menu-trigger', 'status', 'badge'], windows: [window], available: true,
        capabilities: { inlineSelect: false, selectFallback: 'host-quick-pick', dialogPlacement: 'main', icons: location !== 'panda.tray.menu', qualification: 'experimental', limitations: location === 'panda.tray.menu' ? ['Native menus cannot embed selects or render package SVG icons; forms/selects open in the main host.', 'Native check/radio items are command actions without inline checked state.', 'Visibility/order overlays and passive status/badges are not supported in native menus.', 'Native menu budget is 128 items including reserved Open/Recovery/Quit and a visible overflow diagnostic; oversized groups are omitted atomically.'] : ['Compact windows forward forms/selects to the main host.', 'Registrations are window-local; no main-window native grants are inherited.'] },
      })),
    ];
    const activation = createDeclarativeActivation(state, 0);
    const items: ItemMetadata[] = [...coreItems.map((item, defaultPosition) => ({ ...item, defaultPosition, supportedOperations: item.location.startsWith('panda.btw.') || item.location === SETTINGS_SECTIONS_LOCATION || item.location === SETTINGS_PROTECTED_LOCATION || item.location === DIALOG_PROTECTED_LOCATION || item.location === PULL_PROTECTED_LOCATION || item.location === WORKTREE_PROTECTED_LOCATION || item.location === MOODBOARD_PROTECTED_LOCATION || item.location === CLOUD_PROTECTED_LOCATION || item.location === MACHINES_PROTECTED_LOCATION ? item.supportedOperations : [...item.supportedOperations, 'hide', 'show', 'reorder'] })), ...activation.entries.map(({ owner, menu, command }, index): ItemMetadata => ({ id: menu.id, owner: owner.extensionId, version: owner.version, defaultPosition: coreItems.length + index, type: menu.presentation === 'status' || menu.presentation === 'badge' ? menu.presentation : menu.items ? 'menu-trigger' : 'button', location: menu.location, label: command.title, supportedOperations: menu.location === 'panda.tray.menu' ? ['inspect'] : ['inspect', 'hide', 'show', 'reorder'], available: true }))];
    activation.dispose();
    items.push(...INSPECTOR_VIEWS.map((view, defaultPosition): ItemMetadata => ({ id: `${INSPECTOR_VIEW_LOCATION}/${view}`, owner: 'panda.core', type: 'view', location: INSPECTOR_VIEW_LOCATION, label: view, defaultPosition, supportedOperations: ['inspect'], available: true })));
    items.push(...registeredInspectorViews(state).map(({ owner, version, view }, defaultPosition): ItemMetadata => ({ id: view.id, owner, version, type: 'view', location: INSPECTOR_VIEW_LOCATION, label: view.title, defaultPosition, supportedOperations: ['inspect', 'hide', 'show', 'reorder'], available: true })));
    const all = { surfaces, items };
    // Compare the full signature internally; only a bounded opaque revision leaves the host.
    const contents = JSON.stringify(all);
    if (contents !== previous) { previous = contents; sequence++; }
    const revision = `${instance}:${sequence}`;
    const signature = JSON.stringify([kind, q.windowId, q.owner ?? null, q.type ?? null, q.location ?? null, q.limit]);
    let offset = 0;
    if (q.cursor !== undefined) {
      let decoded: unknown;
      try { decoded = JSON.parse(q.cursor); } catch { throw new CatalogError('InvalidQuery'); }
      if (!Array.isArray(decoded) || decoded.length !== 3 || !Number.isSafeInteger(decoded[2]) || decoded[2] < 0) throw new CatalogError('InvalidQuery');
      if (decoded[0] !== revision || decoded[1] !== signature) throw new CatalogError('StaleContext');
      offset = decoded[2];
    }
    const filtered = all[kind].filter(item => (!q.owner || item.owner === q.owner) && (!q.type || item.type === q.type) && (!q.location || item.location === q.location)).sort((a, b) => {
      // Keep the original recovery/control pages ahead of newly adopted families.
      const legacy = (item: SurfaceMetadata | ItemMetadata) => kind === 'items' && (item.location === HEADER || item.location === FOOTER) ? 0 : 1;
      return legacy(a) - legacy(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    if (offset > filtered.length) throw new CatalogError('InvalidQuery');
    const result = filtered.slice(offset, offset + q.limit).map(item => ({ ...item, ...availability(q.windowId, item.location) }));
    return structuredClone({ schemaVersion: 1, revision, items: result as T[], nextCursor: offset + q.limit < filtered.length ? JSON.stringify([revision, signature, offset + q.limit]) : null });
  };
  return Object.freeze({
    listSurfaces: (query?: CatalogQuery) => list<SurfaceMetadata>('surfaces', query),
    listItems: (query?: CatalogQuery) => list<ItemMetadata>('items', query),
  });
}

/** Host-only invocation adapter; metadata does not grant extensions command authority. */
export function createCoreCommands(handlers: Record<PublicCommandId, () => void | Promise<void>>) {
  return Object.freeze({ async invoke(id: string, args: unknown, windowId = 'main'): Promise<void> {
    if (!Object.hasOwn(handlers, id)) throw new CatalogError('NotFound');
    if (args !== null) throw new CatalogError('InvalidArguments');
    if (windowId !== 'main') throw new CatalogError('HostUnavailable');
    await handlers[id as PublicCommandId]();
  } });
}
