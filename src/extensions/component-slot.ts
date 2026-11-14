/** ComponentSlot v1: JSON-only presentation; core objects and operations stay in the host. */
export type SlotId = 'panda.sidebar' | 'panda.settings' | 'panda.machines' | 'panda.cloud' | 'panda.moodboards' | 'panda.worktree' | 'panda.pull' | 'panda.githubHub' | 'panda.board' | 'panda.btw' | 'panda.projects' | 'panda.files' | 'panda.composer' | 'panda.transcript' | 'panda.documents' | 'panda.changes' | 'panda.search' | 'panda.browser' | 'panda.terminal' | 'panda.simulator' | 'panda.vm' | 'panda.design';
export type ComponentProvider = { id: string; title: string; slot: SlotId; contractVersion: number; presentation: 'tabs-first' | 'review-first' | 'composer-first' | 'cards' | 'list' | 'toolbar-first' | 'timeline' | 'viewer-first' | 'commit-first' | 'results-first' | 'controls-below' | 'tabs-below' | 'controls-first' | 'comments-first' | 'actions-first' | 'filter-first'; capabilities?: string[] };
export const SIDEBAR_CAPABILITIES = ['host-sections', 'host-rows', 'original-actions'] as const;
export const SETTINGS_CAPABILITIES = ['host-sections', 'host-controls', 'original-actions'] as const;
export const MACHINES_CAPABILITIES = ['host-targets', 'host-lineage', 'original-actions'] as const;
export const CLOUD_CAPABILITIES = ['host-machine', 'host-targets', 'original-actions'] as const;
export const MOODBOARD_CAPABILITIES = ['host-boards', 'host-images', 'original-actions'] as const;
export const WORKTREE_CAPABILITIES = ['host-branch', 'host-worktree', 'original-actions'] as const;
export const PULL_CAPABILITIES = ['host-pull', 'host-diffs', 'original-actions'] as const;
export const GITHUB_HUB_CAPABILITIES = ['host-repositories', 'host-runs', 'original-actions'] as const;
export const BOARD_CAPABILITIES = ['host-tasks', 'host-details', 'original-actions'] as const;
export const BTW_CAPABILITIES = ['host-input', 'host-history', 'main-side-isolation', 'original-actions'] as const;
export const DESIGN_CAPABILITIES = ['host-artboards', 'host-comments', 'original-actions'] as const;
export const SIMULATOR_CAPABILITIES = ['host-device', 'host-input', 'host-frames', 'original-actions'] as const;
export const VM_CAPABILITIES = ['host-machine', 'host-input', 'host-frames', 'original-actions'] as const;
export const TERMINAL_CAPABILITIES = ['host-pty', 'host-tabs', 'original-actions'] as const;
export const BROWSER_CAPABILITIES = ['host-guest', 'host-bounds', 'original-actions'] as const;
export const SEARCH_CAPABILITIES = ['host-query', 'host-results', 'original-actions'] as const;
export const CHANGES_CAPABILITIES = ['host-diff', 'host-commit', 'original-actions'] as const;
export const DOCUMENT_CAPABILITIES = ['host-tabs', 'host-viewer', 'original-actions'] as const;
export const COMPOSER_CAPABILITIES = ['host-input', 'attachments', 'model-mode', 'queue-steer', 'send-stop', 'approvals'] as const;
export const TRANSCRIPT_CAPABILITIES = ['streaming', 'tool-output', 'questions', 'approvals', 'team-progress', 'usage', 'stop-resume', 'host-history'] as const;
export function componentIncompatibility(provider: ComponentProvider): string | undefined {
  if (provider.contractVersion !== 1) return 'Incompatible slot version';
  if (provider.slot === 'panda.sidebar') {
    if (provider.presentation !== 'filter-first') return 'Unsupported sidebar presentation';
    if (SIDEBAR_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required sidebar capabilities';
    if (provider.capabilities?.some(capability => !SIDEBAR_CAPABILITIES.includes(capability as typeof SIDEBAR_CAPABILITIES[number]))) return 'Unsupported sidebar capability';
  } else if (provider.slot === 'panda.settings') {
    if (provider.presentation !== 'actions-first') return 'Unsupported Settings presentation';
    if (SETTINGS_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Settings capabilities';
    if (provider.capabilities?.some(capability => !SETTINGS_CAPABILITIES.includes(capability as typeof SETTINGS_CAPABILITIES[number]))) return 'Unsupported Settings capability';
  } else if (provider.slot === 'panda.machines') {
    if (provider.presentation !== 'controls-below') return 'Unsupported machine presentation';
    if (MACHINES_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required machine capabilities';
    if (provider.capabilities?.some(capability => !MACHINES_CAPABILITIES.includes(capability as typeof MACHINES_CAPABILITIES[number]))) return 'Unsupported machine capability';
  } else if (provider.slot === 'panda.cloud') {
    if (provider.presentation !== 'controls-below') return 'Unsupported cloud machine presentation';
    if (CLOUD_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required cloud machine capabilities';
    if (provider.capabilities?.some(capability => !CLOUD_CAPABILITIES.includes(capability as typeof CLOUD_CAPABILITIES[number]))) return 'Unsupported cloud machine capability';
  } else if (provider.slot === 'panda.moodboards') {
    if (provider.presentation !== 'viewer-first') return 'Unsupported moodboard presentation';
    if (MOODBOARD_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required moodboard capabilities';
    if (provider.capabilities?.some(capability => !MOODBOARD_CAPABILITIES.includes(capability as typeof MOODBOARD_CAPABILITIES[number]))) return 'Unsupported moodboard capability';
  } else if (provider.slot === 'panda.worktree') {
    if (provider.presentation !== 'controls-first') return 'Unsupported branch and worktree presentation';
    if (WORKTREE_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required branch and worktree capabilities';
    if (provider.capabilities?.some(capability => !WORKTREE_CAPABILITIES.includes(capability as typeof WORKTREE_CAPABILITIES[number]))) return 'Unsupported branch and worktree capability';
  } else if (provider.slot === 'panda.pull') {
    if (provider.presentation !== 'tabs-first') return 'Unsupported Pull request presentation';
    if (PULL_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Pull request capabilities';
    if (provider.capabilities?.some(capability => !PULL_CAPABILITIES.includes(capability as typeof PULL_CAPABILITIES[number]))) return 'Unsupported Pull request capability';
  } else if (provider.slot === 'panda.githubHub') {
    if (provider.presentation !== 'tabs-first') return 'Unsupported GitHub hub presentation';
    if (GITHUB_HUB_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required GitHub hub capabilities';
    if (provider.capabilities?.some(capability => !GITHUB_HUB_CAPABILITIES.includes(capability as typeof GITHUB_HUB_CAPABILITIES[number]))) return 'Unsupported GitHub hub capability';
  } else if (provider.slot === 'panda.board') {
    if (provider.presentation !== 'review-first') return 'Unsupported Board presentation';
    if (BOARD_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Board capabilities';
    if (provider.capabilities?.some(capability => !BOARD_CAPABILITIES.includes(capability as typeof BOARD_CAPABILITIES[number]))) return 'Unsupported Board capability';
  } else if (provider.slot === 'panda.btw') {
    if (provider.presentation !== 'composer-first') return 'Unsupported BTW presentation';
    if (BTW_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required BTW capabilities';
    if (provider.capabilities?.some(capability => !BTW_CAPABILITIES.includes(capability as typeof BTW_CAPABILITIES[number]))) return 'Unsupported BTW capability';
  } else if (provider.slot === 'panda.design') {
    if (provider.presentation !== 'comments-first') return 'Unsupported Design presentation';
    if (DESIGN_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Design capabilities';
    if (provider.capabilities?.some(capability => !DESIGN_CAPABILITIES.includes(capability as typeof DESIGN_CAPABILITIES[number]))) return 'Unsupported Design capability';
  } else if (provider.slot === 'panda.vm') {
    if (provider.presentation !== 'controls-first') return 'Unsupported VM presentation';
    if (VM_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required VM capabilities';
    if (provider.capabilities?.some(capability => !VM_CAPABILITIES.includes(capability as typeof VM_CAPABILITIES[number]))) return 'Unsupported VM capability';
  } else if (provider.slot === 'panda.simulator') {
    if (provider.presentation !== 'controls-first') return 'Unsupported Simulator presentation';
    if (SIMULATOR_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Simulator capabilities';
    if (provider.capabilities?.some(capability => !SIMULATOR_CAPABILITIES.includes(capability as typeof SIMULATOR_CAPABILITIES[number]))) return 'Unsupported Simulator capability';
  } else if (provider.slot === 'panda.terminal') {
    if (provider.presentation !== 'tabs-below') return 'Unsupported Terminal presentation';
    if (TERMINAL_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Terminal capabilities';
    if (provider.capabilities?.some(capability => !TERMINAL_CAPABILITIES.includes(capability as typeof TERMINAL_CAPABILITIES[number]))) return 'Unsupported Terminal capability';
  } else if (provider.slot === 'panda.browser') {
    if (provider.presentation !== 'controls-below') return 'Unsupported Browser presentation';
    if (BROWSER_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Browser capabilities';
    if (provider.capabilities?.some(capability => !BROWSER_CAPABILITIES.includes(capability as typeof BROWSER_CAPABILITIES[number]))) return 'Unsupported Browser capability';
  } else if (provider.slot === 'panda.search') {
    if (provider.presentation !== 'results-first') return 'Unsupported Search presentation';
    if (SEARCH_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Search capabilities';
    if (provider.capabilities?.some(capability => !SEARCH_CAPABILITIES.includes(capability as typeof SEARCH_CAPABILITIES[number]))) return 'Unsupported Search capability';
  } else if (provider.slot === 'panda.changes') {
    if (provider.presentation !== 'commit-first') return 'Unsupported Changes presentation';
    if (CHANGES_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required Changes capabilities';
    if (provider.capabilities?.some(capability => !CHANGES_CAPABILITIES.includes(capability as typeof CHANGES_CAPABILITIES[number]))) return 'Unsupported Changes capability';
  } else if (provider.slot === 'panda.documents') {
    if (provider.presentation !== 'viewer-first') return 'Unsupported document presentation';
    if (DOCUMENT_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required document capabilities';
    if (provider.capabilities?.some(capability => !DOCUMENT_CAPABILITIES.includes(capability as typeof DOCUMENT_CAPABILITIES[number]))) return 'Unsupported document capability';
  } else if (provider.slot === 'panda.composer') {
    if (provider.presentation !== 'toolbar-first') return 'Unsupported composer presentation';
    if (COMPOSER_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required composer capabilities';
    if (provider.capabilities?.some(capability => !COMPOSER_CAPABILITIES.includes(capability as typeof COMPOSER_CAPABILITIES[number]))) return 'Unsupported composer capability';
  } else if (provider.slot === 'panda.transcript') {
    if (provider.presentation !== 'timeline') return 'Unsupported transcript presentation';
    if (TRANSCRIPT_CAPABILITIES.some(capability => !provider.capabilities?.includes(capability))) return 'Missing required transcript capabilities';
    if (provider.capabilities?.some(capability => !TRANSCRIPT_CAPABILITIES.includes(capability as typeof TRANSCRIPT_CAPABILITIES[number]))) return 'Unsupported transcript capability';
  } else if (!['cards', 'list'].includes(provider.presentation)) return 'Unsupported list presentation';
}
export type SlotObject = { id: string; label: string; revision: number; directory?: boolean; expanded?: boolean; depth?: number };
export type SlotProps = { contractVersion: 1; slot: SlotId; context: string; revision: number; objects: readonly SlotObject[]; state: { selected: string; focused: string; loading: boolean; offline: boolean; visible: boolean } };
export type SlotAction = { contractVersion: 1; kind: 'select' | 'open' | 'toggle'; id: string; objectRevision: number; revision: number; context: string };
export type ComponentSlot<TProps, TActions, TState> = { props: TProps; dispatch(action: TActions): boolean; state: TState; dispose(): void };
export const REPLACEMENT_KEY = 'pandacode.components.v1';
const slots: SlotId[] = ['panda.sidebar', 'panda.settings', 'panda.machines', 'panda.cloud', 'panda.moodboards', 'panda.worktree', 'panda.pull', 'panda.githubHub', 'panda.board', 'panda.btw', 'panda.projects', 'panda.files', 'panda.composer', 'panda.transcript', 'panda.documents', 'panda.changes', 'panda.search', 'panda.browser', 'panda.terminal', 'panda.simulator', 'panda.vm', 'panda.design'];
export function createComponentSelection(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const read = (): Partial<Record<SlotId, string>> => {
    try { const raw = storage.getItem(REPLACEMENT_KEY); if (!raw || raw.length > 8192) return {}; const value = JSON.parse(raw); if (value.schemaVersion !== 1 || !value.selected || Array.isArray(value.selected)) return {}; return Object.fromEntries(slots.filter(slot => typeof value.selected[slot] === 'string' && value.selected[slot].length < 256).map(slot => [slot, value.selected[slot]])); } catch { return {}; }
  };
  return {
    selected: (slot: SlotId) => read()[slot],
    select(slot: SlotId, id: string | undefined, providers: ComponentProvider[]) {
      const provider = providers.find(provider => provider.id === id && provider.slot === slot);
      if (!slots.includes(slot) || id !== undefined && (!provider || componentIncompatibility(provider))) throw new Error(provider ? componentIncompatibility(provider) : 'Unsupported component provider');
      const selected = read(); if (id) selected[slot] = id; else delete selected[slot];
      storage.setItem(REPLACEMENT_KEY, JSON.stringify({ schemaVersion: 1, selected }));
    },
    resolve(slot: SlotId, providers: ComponentProvider[]) { return providers.find(provider => provider.slot === slot && provider.id === read()[slot] && !componentIncompatibility(provider)); },
  };
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => !field.get && !field.set));
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;
const revision = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
export function validSlotProps(value: unknown): value is SlotProps {
  if (record(value) && (value.slot === 'panda.sidebar' || value.slot === 'panda.settings' || value.slot === 'panda.machines' || value.slot === 'panda.cloud' || value.slot === 'panda.moodboards' || value.slot === 'panda.worktree' || value.slot === 'panda.pull' || value.slot === 'panda.githubHub' || value.slot === 'panda.btw' || value.slot === 'panda.board')) return false;
  // Composer/transcript use closed host recipes, never the list-object protocol.
  if (record(value) && (value.slot === 'panda.design' || value.slot === 'panda.vm' || value.slot === 'panda.simulator' || value.slot === 'panda.composer' || value.slot === 'panda.transcript' || value.slot === 'panda.documents' || value.slot === 'panda.changes' || value.slot === 'panda.search' || value.slot === 'panda.browser' || value.slot === 'panda.terminal')) return false;
  if (!record(value) || Object.keys(value).sort().join(',') !== 'context,contractVersion,objects,revision,slot,state' || value.contractVersion !== 1 || !slots.includes(value.slot as SlotId) || !text(value.context) || !revision(value.revision) || !Array.isArray(value.objects) || value.objects.length > 10000 || !record(value.state)) return false;
  const state = value.state;
  if (Object.keys(state).sort().join(',') !== 'focused,loading,offline,selected,visible' || !text(state.selected) || !text(state.focused) || ['loading', 'offline', 'visible'].some(key => typeof state[key] !== 'boolean')) return false;
  const ids = new Set<string>();
  return value.objects.every(object => {
    if (!record(object) || Object.keys(object).some(key => !['id', 'label', 'revision', 'directory', 'expanded', 'depth'].includes(key)) || !text(object.id) || !object.id || ids.has(object.id) || !text(object.label) || !revision(object.revision) || object.directory !== undefined && typeof object.directory !== 'boolean' || object.expanded !== undefined && typeof object.expanded !== 'boolean' || object.depth !== undefined && (!revision(object.depth) || Number(object.depth) > 128)) return false;
    ids.add(object.id); return true;
  });
}
/** An instance is invalid after dispose or after its captured object/context revision changes. */
export function createComponentSlot(props: SlotProps, current: () => SlotProps, dispatch: (action: SlotAction) => void): ComponentSlot<SlotProps, SlotAction, SlotProps['state']> {
  if (!validSlotProps(props)) throw new Error('Invalid component slot props');
  const captured = freeze(structuredClone(props)); let disposed = false;
  return {
    props: captured, state: captured.state,
    dispatch(input: unknown): boolean {
      if (disposed || !input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.values(Object.getOwnPropertyDescriptors(input)).some(value => value.get || value.set)) return false;
      if (Object.keys(input).sort().join(',') !== 'context,contractVersion,id,kind,objectRevision,revision') return false;
      const action = input as SlotAction, latest = current();
      if (latest.contractVersion !== 1 || latest.slot !== captured.slot || action.contractVersion !== 1 || action.context !== captured.context || action.context !== latest.context || action.revision !== captured.revision || action.revision !== latest.revision || !captured.state.visible || captured.state.loading || captured.state.offline || !latest.state.visible || latest.state.loading || latest.state.offline) return false;
      const object = captured.objects.find(object => object.id === action.id), live = latest.objects.find(object => object.id === action.id);
      if (!object || !live || object.revision !== action.objectRevision || live.revision !== action.objectRevision) return false;
      if (!(captured.slot === 'panda.projects' ? action.kind === 'select' : object.directory ? action.kind === 'toggle' : action.kind === 'open')) return false;
      dispatch(freeze(structuredClone(action))); return true;
    },
    dispose() { disposed = true; },
  };
}
