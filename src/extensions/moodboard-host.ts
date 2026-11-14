/** Host-only moodboard bindings: boards, images, files, forms and the attach destination never cross the package boundary. */
import { isImeKey } from '../dom';
import type { ChoiceItem } from '../choice-menu';
import { createMoodboardPresentation, snapshotMoodboard, MOODBOARD_ENTRY_CONTROLS, type MoodboardAction, type MoodboardControl, type MoodboardPresentation } from './moodboard';
import { applyMoodboardPresentation, componentProviders, componentSelection } from './replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './manager';
import { layout, applyControlOrder, applyControlVisibility } from './layout-host';
import { mountExtensionActions } from './header';
import { openContextActions } from './context-actions';
import { MOODBOARD_CONTROLS } from './surfaces';
/** Raw host state; IDs stay in the host and only opaque handles are published. */
export type MoodboardHostState = { project: string; destination: string; board: string; image: string; boardName: string; boardCount: number; imageCount: number; loading: boolean; busy: boolean; error: boolean; draft: boolean; create: boolean; confirm: boolean; preview: boolean; attach: boolean };
/** Labels for the fresh host choice and the catalog; one source for both. */
export const MOODBOARD_LABELS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(MOODBOARD_CONTROLS).flatMap(controls => controls.map(([id, label]) => [id, label])));
const CONTROLS_LOCATION = 'panda.moodboards.controls';
const LAYOUT_CONTROLS: readonly MoodboardControl[] = MOODBOARD_CONTROLS[CONTROLS_LOCATION].map(([id]) => id);
const ACTIONS: Readonly<Record<string, MoodboardControl>> = { new: 'board-new', add: 'image-add', delete: 'board-delete', 'cancel-delete': 'delete-cancel', 'close-preview': 'preview-close', attach: 'attach' };
const BOUND = '[data-mood-board],[data-mood-expand],[data-mood-remove],[data-mood-caption],.moodboard-title,[data-mood-action]';
const count = (value: number) => Number.isSafeInteger(value) ? Math.min(64, Math.max(0, value)) : 0;
let active: ReturnType<typeof mountMoodboardPresentation> | undefined;
/** The mounted library's adapter, if any (one library dialog at a time). */
export const activeMoodboard = () => active;
export function mountMoodboardPresentation(root: HTMLElement, state: () => MoodboardHostState, notify: (message: string) => void, confirmEntry: (anchor: HTMLElement, label: string, proceed: () => void) => void) {
  const context = crypto.randomUUID(), handles = new Map<string, string>(), nodes = new Map<string, HTMLElement>(), applied = new Set<string>();
  const lifetime = new AbortController(); let disposed = false, identity = '', revision = 0, signature = '', consent = false, closeContext: (() => void) | undefined;
  // Original render order, so built-in recovery can restore a reordered row without remounting.
  const originalOrder = new WeakMap<HTMLElement, number>(); let nextOrder = 0;
  const handle = (key: string) => { if (!key) return ''; if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  function authority() {
    const provider = componentSelection.resolve('panda.moodboards', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.enabled && item.manifest.id === provider?.id.split('/')[0]);
    const next = `${provider?.id ?? ''}:${owner ? extensionIdentity(owner.manifest.id) : ''}`;
    if (identity !== next) { identity = next; consent = false; }
    return { owner: provider?.id ?? '', active: !disposed && Boolean(owner && provider && root.dataset.moodboardProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')), moodboardControl: consent, userChoice: true };
  }
  function control(node: HTMLElement, s: MoodboardHostState): [MoodboardControl, string] | undefined {
    if (node.dataset.moodBoard) return ['board-select', `board:${node.dataset.moodBoard}`];
    if (node.dataset.moodExpand) return ['image-preview', `image:${node.dataset.moodExpand}`];
    if (node.dataset.moodRemove) return ['image-remove', `image:${node.dataset.moodRemove}`];
    if (node.dataset.moodCaption) return ['image-caption', `image:${node.dataset.moodCaption}`];
    if (node.classList.contains('moodboard-title')) return s.board ? ['board-rename', `board:${s.board}`] : undefined;
    const id = ACTIONS[node.dataset.moodAction ?? ''];
    if (!id) return undefined;
    return [id, id === 'board-new' ? `project:${s.project}` : id === 'preview-close' ? `image:${s.image}` : id === 'attach' ? `destination:${s.destination}:${s.board}` : `board:${s.board}`];
  }
  function bindings() {
    const s = state(), counts = new Map<string, number>(); nodes.clear();
    return [...root.querySelectorAll<HTMLElement>(BOUND)].flatMap(node => {
      const bound = control(node, s); if (!bound) return [];
      const [controlId, raw] = bound, base = JSON.stringify([s.board, controlId, raw, node.parentElement?.className ?? '']);
      const index = counts.get(base) ?? 0; counts.set(base, index + 1);
      const key = handle(`${base}:${index}`); nodes.set(key, node);
      if (!originalOrder.has(node)) originalOrder.set(node, nextOrder++);
      const enabled = !(node as HTMLButtonElement).disabled && !node.closest('[hidden],[inert],[data-layout-hidden]');
      return [{ id: key, controlId, resource: handle(raw), enabled, node }];
    });
  }
  function presentation(): MoodboardPresentation {
    const s = state(), auth = authority(), controls = bindings();
    const value = { contractVersion: 1 as const, window: 'main' as const, context, project: handle(`project:${s.project}`), board: s.board ? handle(`board:${s.board}`) : '', image: s.image ? handle(`image:${s.image}`) : '', destination: s.destination ? handle(`destination:${s.destination}`) : '', revision: 0, visible: !disposed && root.isConnected && root.getClientRects().length > 0, loading: s.loading, busy: s.busy, error: s.error, draft: s.draft, create: s.create, confirm: s.confirm, preview: s.preview, attach: s.attach, boardName: auth.metadata ? s.boardName.slice(0, 120) : '', boardCount: count(s.boardCount), imageCount: count(s.imageCount), truncated: controls.length > 256, controls: controls.slice(0, 256).map(({ node: _node, ...item }) => item) };
    const next = JSON.stringify([value, s.boardName, auth.owner, auth.active, auth.moodboardControl, auth.granted, identity]);
    if (next !== signature) { signature = next; revision++; }
    return snapshotMoodboard({ ...value, revision });
  }
  function execute(action: MoodboardAction) {
    const node = nodes.get(action.control); if (!node?.isConnected) return;
    const run = (target: HTMLElement) => {
      if (action.controlId === 'board-rename' || action.controlId === 'image-caption') { target.focus(); if (target instanceof HTMLInputElement) target.select(); return; }
      target.click();
    };
    if (!MOODBOARD_ENTRY_CONTROLS.includes(action.controlId)) { run(node); return; }
    const captured = identity;
    confirmEntry(node, MOODBOARD_LABELS[action.controlId] ?? action.controlId, () => {
      // The fresh choice may come later: the same mount, provider, board, image and destination must still hold.
      const live = presentation(), current = nodes.get(action.control);
      if (!authority().active || captured !== identity || live.loading || live.busy || (['project', 'board', 'image', 'destination'] as const).some(key => live[key] !== action[key])) return;
      if (current?.isConnected && live.controls.some(item => item.id === action.control && item.enabled)) run(current);
    });
  }
  function dispatch(input: unknown) {
    const slot = createMoodboardPresentation(presentation(), authority().owner, presentation, authority, execute, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  const actionContext = () => { const live = presentation(); return { projectId: state().project, revision: live.revision, selection: { kind: 'moodboard', ids: live.board ? [live.board] : [] } }; };
  const accessory = document.createElement('span'); accessory.dataset.moodboardAccessory = '';
  const stopActions = mountExtensionActions(accessory, 'panda.moodboards.actions', actionContext, notify);
  const consentButton = document.createElement('button'); consentButton.type = 'button'; consentButton.className = 'secondary-button'; consentButton.dataset.moodboardConsent = '';
  consentButton.addEventListener('click', () => { if (!authority().active) return; consent = !consent; refresh(); }, { signal: lifetime.signal });
  function refresh() {
    if (disposed) return; closeContext?.(); closeContext = undefined;
    if (!applyMoodboardPresentation(root)) notify('Moodboard presentation failed. The built-in library remains active.');
    const title = root.querySelector('.moodboard-title');
    if (title && accessory.previousElementSibling !== title) title.after(accessory);
    if (consentButton.parentElement !== root) root.querySelector('.moodboard-status')?.before(consentButton);
    // Only the static heading, toolbar and footer rows are customizable; empty-state shortcuts stay built in.
    const group = bindings().filter(binding => LAYOUT_CONTROLS.includes(binding.controlId) && binding.node.closest('.moodboard-library-heading, .moodboard-toolbar, .moodboard-footer'))
      .sort((a, b) => originalOrder.get(a.node)! - originalOrder.get(b.node)!).map(binding => [`${CONTROLS_LOCATION}/${binding.controlId}`, binding.node] as const);
    applyControlOrder(CONTROLS_LOCATION, group); applyControlVisibility(group, () => root.querySelector<HTMLElement>('.moodboard-canvas'));
    const auth = authority(); consentButton.hidden = !auth.active;
    consentButton.textContent = `${auth.moodboardControl ? 'Revoke' : 'Allow'} moodboard control`;
    consentButton.setAttribute('aria-label', `${auth.moodboardControl ? 'Revoke' : 'Allow'} moodboard control for ${auth.owner.split('/')[0]}`);
  }
  const contributes = () => extensionsSnapshot().packages.some(item => item.enabled && (item.manifest.contributes.menus ?? []).some(menu => menu.location === 'panda.moodboards.context'));
  function openContext(event: MouseEvent | KeyboardEvent) {
    if (extensionsSnapshot().safeMode || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && (isImeKey(event) || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey))) return;
    const card = event.target.closest<HTMLElement>('.moodboard-image-card'), owner = card ?? event.target.closest<HTMLElement>('.moodboard-list-item');
    // Anchor on the focused control itself, so Escape returns focus there rather than to the card.
    const control = event.target.closest<HTMLElement>('button, textarea'), anchor = control && owner?.contains(control) ? control : owner;
    if (!anchor || !owner || !root.contains(anchor) || anchor.closest('[inert]') || !authority().active && !contributes()) return;
    const captured = presentation(), image = card?.dataset.moodImage ?? '', board = owner.dataset.moodBoard ?? state().board;
    const items: ChoiceItem[] = card ? [{ id: 'image-preview', label: 'View image', icon: 'images' }, { id: 'image-caption', label: 'Edit caption', icon: 'edit' }, { id: 'image-remove', label: 'Remove image', icon: 'close' }] : [];
    event.preventDefault(); event.stopPropagation(); closeContext?.();
    const target = (selector: string) => card?.querySelector<HTMLElement>(selector);
    closeContext = openContextActions(anchor, 'panda.moodboards.context', { projectId: state().project, revision: captured.revision, selection: { kind: card ? 'moodboard-image' : 'moodboard', ids: [handle(card ? `image:${image}` : `board:${board}`)] } }, {
      title: card ? 'Image' : 'Moodboard', items, notify, ...(event instanceof MouseEvent ? { point: { x: event.clientX, y: event.clientY } } : {}),
      // The user's own pick runs the original control on the same card, never a later one.
      onSelect: id => { if (presentation().board !== captured.board || !anchor.isConnected) return; if (id === 'image-caption') target('[data-mood-caption]')?.focus(); else target(id === 'image-preview' ? '[data-mood-expand]' : '[data-mood-remove]')?.click(); },
      isAlive: () => anchor.isConnected && presentation().board === captured.board,
    });
  }
  root.addEventListener('contextmenu', openContext, { signal: lifetime.signal }); root.addEventListener('keydown', openContext, { signal: lifetime.signal });
  const stopExtensions = onExtensionsChanged(refresh), stopLayout = layout.subscribe(refresh); window.addEventListener('pandacode-components-change', refresh);
  refresh();
  const api = { presentation, dispatch, refresh, dispose() {
    disposed = true; lifetime.abort(); stopExtensions(); stopLayout(); stopActions(); closeContext?.(); consentButton.remove(); accessory.remove();
    window.removeEventListener('pandacode-components-change', refresh); delete root.dataset.moodboardProvider;
    if (active === api) active = undefined;
  } };
  active = api;
  return api;
}
