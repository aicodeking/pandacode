// Selectable presentations (`ui.presentation`, runtime phase R10, slice R1002).
//
// A trusted package adds three closed things to the conversation, all additive and all gone when the package is disabled, the
// grant is revoked or the app is in safe mode (the built-in presentation returns, nothing is migrated):
//
// - a conversation-only transcript: a `contributes.components` entry for the slot `panda.transcript` whose presentation is
//   `conversation` (the host hides the tool steps; the text of the turns, the questions and the approvals stay);
// - a working indicator: 2 to 16 text frames of at most 16 characters, 80 to 1,000 ms apart;
// - a backdrop behind the thread: a static image of the package or one of its rich views, with an opacity from 0 to 0.5.
//
// The indicator and the backdrop are `contributes.presentations`; the user chooses one of each from the small "Look" menu
// beside the thread (like a recipe), and the choice is the user's alone: nothing changes until they choose. The native twin is
// src-tauri/src/extensions/runtime_transcript_presentation.rs. This file has two halves: the model (no DOM, importable by the
// deterministic checks of tests/extensions-runtime-transcript-presentation.spec.ts) and `mountPresentations`, which draws it.
//
// No literal accent and no layout animation: the indicator is text swapped on a timer (one still frame with reduced motion),
// the backdrop is a static layer. Everything here is for predictability, legibility and fault isolation, never for trust
// (ADR-0005): a package that holds `ui.presentation` is never asked again per action.
import type { Json } from './contracts';
import type { ExtensionSnapshot } from './manager';
import type { RegisteredView } from './views-state';

export const PERMISSION = 'ui.presentation';
export const KINDS = ['working-indicator', 'backdrop'] as const;
export type Kind = typeof KINDS[number];
export const MIN_FRAMES = 2;
export const MAX_FRAMES = 16;
export const MAX_FRAME_CHARS = 16;
export const MIN_INTERVAL_MS = 80;
export const MAX_INTERVAL_MS = 1000;
/** A backdrop never exceeds this opacity, so the text of the thread stays readable over it. */
export const MAX_OPACITY = 0.5;
export const MAX_PRESENTATIONS = 16;
/** What a `conversation` transcript must declare: what the host keeps running under it. */
export const CONVERSATION_CAPABILITIES = ['streaming', 'stop-resume', 'host-history'] as const;
const ALL_CAPABILITIES = ['streaming', 'tool-output', 'questions', 'approvals', 'team-progress', 'usage', 'stop-resume', 'host-history'];
export const SELECTION_KEY = 'pandacode.extensions.presentation.v1';

type Definition = Record<string, Json>;
export type Offer = { key: string; owner: string; version: string; label: string; kind: Kind; title: string; definition: Definition };
export type Selection = { indicator?: string; backdrop?: string };
export type Granted = (owner: string, version: string) => boolean;

const record = (value: unknown): value is Definition => typeof value === 'object' && value !== null && !Array.isArray(value);
const chars = (text: string) => [...text].length;

/** The frozen failure of one presentation (`null` when valid). `views` are the package's own view ids, `iconAssets` the assets its icons declare. */
export function checkPresentation(presentation: Definition, views: readonly string[], iconAssets: readonly string[]): string | null {
  if (presentation.kind === 'working-indicator') {
    const frames = presentation.frames;
    if (!Array.isArray(frames)) return 'InvalidShape';
    if (frames.length < MIN_FRAMES || frames.length > MAX_FRAMES) return 'LimitExceeded';
    if (!frames.every(frame => typeof frame === 'string' && frame.length > 0 && chars(frame) <= MAX_FRAME_CHARS)) return 'LimitExceeded';
    const interval = presentation.intervalMs;
    if (typeof interval !== 'number' || !Number.isInteger(interval)) return 'InvalidShape';
    return interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS ? null : 'LimitExceeded';
  }
  if (presentation.kind === 'backdrop') {
    const value = presentation.opacity;
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'InvalidShape';
    if (value < 0 || value > MAX_OPACITY) return 'LimitExceeded';
    const image = presentation.image, view = presentation.view;
    if (typeof image === 'string' && view === undefined) return image.startsWith('assets/') && image.endsWith('.svg') && iconAssets.includes(image) ? null : 'InvalidShape';
    if (typeof view === 'string' && image === undefined) return views.includes(view) ? null : 'InvalidShape';
    return 'InvalidShape';
  }
  return 'InvalidShape';
}

/** The failure of a package's whole `presentations` list: the bound, unique ids, then each entry. */
export function checkAll(list: readonly Definition[], views: readonly string[], iconAssets: readonly string[]): string | null {
  if (list.length > MAX_PRESENTATIONS) return 'LimitExceeded';
  const seen = new Set<string>();
  for (const presentation of list) {
    if (typeof presentation.id !== 'string' || seen.has(presentation.id)) return 'InvalidShape';
    seen.add(presentation.id);
    const failure = checkPresentation(presentation, views, iconAssets);
    if (failure) return failure;
  }
  return null;
}

/** The `conversation` presentation declares the capabilities the host keeps under it and none outside the transcript vocabulary. */
export function checkConversationProvider(provider: Definition): string | null {
  if (provider.slot !== 'panda.transcript' || provider.presentation !== 'conversation') return null;
  const declared = Array.isArray(provider.capabilities) ? provider.capabilities.filter((name): name is string => typeof name === 'string') : [];
  return CONVERSATION_CAPABILITIES.every(name => declared.includes(name)) && declared.every(name => ALL_CAPABILITIES.includes(name)) ? null : 'InvalidShape';
}

const contributesOf = (item: ExtensionSnapshot['packages'][number]) => item.manifest.contributes as unknown as Record<string, Definition[] | undefined>;
const labelOf = (item: ExtensionSnapshot['packages'][number]) => typeof (item.manifest as { name?: unknown }).name === 'string' ? (item.manifest as unknown as { name: string }).name : item.manifest.id;
/** Whether the package may show anything now: enabled, not in safe mode, declaring and holding `ui.presentation`. */
const may = (snapshot: ExtensionSnapshot, item: ExtensionSnapshot['packages'][number], granted: Granted) =>
  !snapshot.safeMode && item.enabled && (item.manifest.permissions ?? []).includes(PERMISSION) && granted(item.manifest.id, item.manifest.version);

/** What the packages offer for a kind, in a fixed order (package, then declaration). Invalid entries are not offered. */
export function offers(snapshot: ExtensionSnapshot, kind: Kind, granted: Granted): Offer[] {
  const out: Offer[] = [];
  for (const item of snapshot.packages) {
    if (!may(snapshot, item, granted)) continue;
    const contributes = contributesOf(item);
    const views = (contributes.views ?? []).map(view => String(view.id)), assets = (contributes.icons ?? []).map(icon => String(icon.asset));
    for (const presentation of contributes.presentations ?? []) {
      if (presentation.kind !== kind || checkPresentation(presentation, views, assets) !== null) continue;
      out.push({ key: String(presentation.id), owner: item.manifest.id, version: item.manifest.version, label: labelOf(item), kind, title: String(presentation.title ?? presentation.id), definition: presentation });
    }
  }
  return out;
}

/** The offer the user's choice resolves to, or `undefined` (the built-in presentation) when it is not offered any more. */
export const resolveOffer = (list: readonly Offer[], chosen: string | undefined): Offer | undefined => chosen === undefined ? undefined : list.find(offer => offer.key === chosen);

export function readSelection(storage: Pick<Storage, 'getItem'>): Selection {
  try {
    const parsed = JSON.parse(storage.getItem(SELECTION_KEY) ?? '{}') as unknown;
    if (!record(parsed)) return {};
    return { ...(typeof parsed.indicator === 'string' ? { indicator: parsed.indicator } : {}), ...(typeof parsed.backdrop === 'string' ? { backdrop: parsed.backdrop } : {}) };
  } catch { return {}; }
}
export function writeSelection(storage: Pick<Storage, 'setItem' | 'removeItem'>, selection: Selection): void {
  if (!selection.indicator && !selection.backdrop) storage.removeItem(SELECTION_KEY);
  else storage.setItem(SELECTION_KEY, JSON.stringify(selection));
}
/** The selection after the user chose `key` (empty: the built-in) for a kind. */
export function choose(selection: Selection, kind: Kind, key: string): Selection {
  const field = kind === 'working-indicator' ? 'indicator' : 'backdrop';
  const next: Selection = { ...selection };
  if (key) next[field] = key; else delete next[field];
  return next;
}

/** The frame to draw: the first one, still, with reduced motion; otherwise the tick modulo the frame count. */
export const frameIndex = (count: number, tick: number, reducedMotion: boolean): number => count <= 0 || reducedMotion ? 0 : tick % count;
/** The opacity actually drawn: the declared one clamped to 0 to `MAX_OPACITY` (anything else draws nothing). */
export const opacity = (declared: unknown): number => typeof declared === 'number' && Number.isFinite(declared) ? Math.min(MAX_OPACITY, Math.max(0, declared)) : 0;

// The native grant check, once the interface half is mounted (it needs the grants store, which the model does not import).
// Until then a declared `ui.presentation` is all the manifest can say, so the conversation transcript waits for the probe.
let probe: Granted | undefined;
export const holdsPresentation: Granted = (owner, version) => probe ? probe(owner, version) : true;

/** The provider the transcript slot resolved to is a `conversation` one, and its package may show it now. */
export function conversationAllowed(snapshot: ExtensionSnapshot, owner: string, granted: Granted): boolean {
  const item = snapshot.packages.find(entry => entry.manifest.id === owner);
  return !!item && may(snapshot, item, granted);
}

/** The rows of the "Look" menu, in a fixed order: the indicator choices, then the backdrop choices. */
export type MenuRow = { id: string; label: string; selected: boolean; separator?: boolean };
export function menuRows(indicators: readonly Offer[], backdrops: readonly Offer[], selection: Selection): MenuRow[] {
  const rows: MenuRow[] = [];
  const section = (kind: Kind, name: string, list: readonly Offer[], chosen: string | undefined) => {
    if (!list.length) return;
    const active = resolveOffer(list, chosen)?.key ?? '';
    rows.push({ id: `${kind}:`, label: `${name}: Built-in`, selected: active === '', ...(rows.length ? { separator: true } : {}) });
    for (const offer of list) rows.push({ id: `${kind}:${offer.key}`, label: `${name}: ${offer.title} (${offer.label})`, selected: active === offer.key });
  };
  section('working-indicator', 'Working indicator', indicators, selection.indicator);
  section('backdrop', 'Backdrop', backdrops, selection.backdrop);
  return rows;
}

// ---- The interface ----------------------------------------------------------------------------------------------------

export type PresentationOptions = {
  /** The conversation pane: the backdrop is its first child, behind everything. */
  pane: HTMLElement;
  /** The thread: the strip with the indicator and the menu is drawn right after it. */
  transcript: HTMLElement;
  state: () => { task?: string; running: boolean; generation: number };
  onContextChanged: (listener: () => void) => () => void;
  /** Re-applies the transcript presentation (the grant or the selection changed). */
  resync: () => void;
  notify: (message: string) => void;
};

interface Backdrop { key: string; signature: string; node: HTMLElement; dispose?: () => void }

export async function mountPresentations(options: PresentationOptions) {
  const [manager, rich, grantsModule, choice] = await Promise.all([import('./manager'), import('./runtime-rich-mount'), import('./runtime-grants'), import('../choice-menu')]);
  const { pane, transcript } = options;
  const strip = document.createElement('div');
  strip.className = 'presentation-strip'; strip.dataset.presentationStrip = ''; strip.hidden = true;
  const indicatorNode = document.createElement('span');
  indicatorNode.className = 'presentation-indicator'; indicatorNode.dataset.presentationIndicator = ''; indicatorNode.hidden = true;
  indicatorNode.setAttribute('role', 'status');
  const frameNode = document.createElement('span'); frameNode.setAttribute('aria-hidden', 'true'); indicatorNode.append(frameNode);
  const picker = document.createElement('button');
  picker.type = 'button'; picker.className = 'presentation-picker'; picker.dataset.presentationPicker = ''; picker.textContent = 'Look'; picker.hidden = true;
  picker.setAttribute('aria-haspopup', 'menu'); picker.setAttribute('aria-expanded', 'false'); picker.setAttribute('aria-label', 'Conversation look from extensions');
  strip.append(indicatorNode, picker);
  transcript.after(strip);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, timer: ReturnType<typeof setInterval> | undefined, tick = 0, closeMenu: (() => void) | undefined, backdrop: Backdrop | undefined, frameKey = '';
  let indicators: Offer[] = [], backdrops: Offer[] = [];

  const granted: Granted = (owner, version) => {
    const grants = grantsModule.createRuntimeGrantsPreview();
    grants.sync(manager.extensionsManagementSnapshot() as unknown as Parameters<typeof grants.sync>[0]);
    return grants.check(owner, version, PERMISSION) === 'ok';
  };
  probe = granted;
  const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };

  function drawIndicator(offer: Offer | undefined, running: boolean) {
    const frames = offer ? (offer.definition.frames as string[]) : [];
    const show = !!offer && running;
    indicatorNode.hidden = !show;
    if (!show) { stopTimer(); frameKey = ''; frameNode.textContent = ''; indicatorNode.removeAttribute('aria-label'); return; }
    indicatorNode.dataset.owner = offer.owner;
    indicatorNode.setAttribute('aria-label', `${offer.label} is working`);
    indicatorNode.title = `${offer.label}: ${offer.title}`;
    const reduced = motion.matches, interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number(offer.definition.intervalMs)));
    const next = `${offer.key}:${frames.join('\u0000')}:${interval}:${reduced}`;
    if (next !== frameKey) {
      frameKey = next; tick = 0; stopTimer();
      frameNode.textContent = frames[frameIndex(frames.length, tick, reduced)];
      // Reduced motion holds the first frame still: no timer at all.
      if (!reduced) timer = setInterval(() => { tick += 1; frameNode.textContent = frames[frameIndex(frames.length, tick, false)]; }, interval);
    }
  }

  function removeBackdrop() { backdrop?.dispose?.(); backdrop?.node.remove(); backdrop = undefined; }
  function drawBackdrop(offer: Offer | undefined, snapshot: ExtensionSnapshot) {
    if (!offer) { removeBackdrop(); pane.removeAttribute('data-presentation-backdrop'); return; }
    const item = snapshot.packages.find(entry => entry.manifest.id === offer.owner)!;
    const view = typeof offer.definition.view === 'string' ? (contributesOf(item).views ?? []).find(entry => entry.id === offer.definition.view) : undefined;
    const image = typeof offer.definition.image === 'string' ? (contributesOf(item).icons ?? []).find(icon => icon.asset === offer.definition.image) : undefined;
    const svg = image ? item.icons[String(image.id)] : undefined;
    const signature = JSON.stringify([offer.key, offer.owner, offer.version, offer.definition, svg?.length ?? 0]);
    if (backdrop && backdrop.key === offer.key && backdrop.signature === signature) return;
    removeBackdrop();
    const node = document.createElement('div');
    node.className = 'presentation-backdrop'; node.dataset.presentationBackdrop = offer.key; node.dataset.owner = offer.owner; node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--presentation-opacity', String(opacity(offer.definition.opacity)));
    let dispose: (() => void) | undefined;
    if (svg) {
      const picture = document.createElement('img'); picture.alt = ''; picture.decoding = 'async'; picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; node.append(picture);
    } else if (view) {
      // A native panel is a child webview placed over its element: it cannot sit behind the thread. Only the preview technique can.
      if (rich.mountTechnique() !== 'browser-iframe') { options.notify(`${offer.label}: a panel backdrop is not available in this build. The built-in background stays.`); pane.removeAttribute('data-presentation-backdrop'); return; }
      try { dispose = rich.mountRichPanel(node, { owner: offer.owner, version: offer.version, view } as unknown as RegisteredView); }
      catch { options.notify(`${offer.label}: the backdrop panel failed. The built-in background stays.`); return; }
    } else { return; }
    pane.prepend(node);
    pane.dataset.presentationBackdrop = '';
    backdrop = { key: offer.key, signature, node, dispose };
  }

  function sync() {
    if (disposed) return;
    const snapshot = manager.extensionsSnapshot();
    indicators = offers(snapshot, 'working-indicator', granted);
    backdrops = offers(snapshot, 'backdrop', granted);
    const selection = readSelection(localStorage);
    const state = options.state();
    drawIndicator(resolveOffer(indicators, selection.indicator), state.running);
    drawBackdrop(resolveOffer(backdrops, selection.backdrop), snapshot);
    picker.hidden = indicators.length === 0 && backdrops.length === 0;
    strip.hidden = picker.hidden && indicatorNode.hidden;
    if (picker.hidden) closeMenu?.();
  }

  picker.addEventListener('click', () => {
    if (picker.getAttribute('aria-expanded') === 'true') { closeMenu?.(); return; }
    const rows = menuRows(indicators, backdrops, readSelection(localStorage));
    if (!rows.length) return;
    picker.setAttribute('aria-expanded', 'true');
    closeMenu = choice.openChoiceMenu({
      anchor: picker, title: 'Conversation look', items: rows.map(row => ({ id: row.id, label: row.label, selected: row.selected, ...(row.separator ? { separator: true } : {}) })),
      onSelect: id => {
        const at = id.indexOf(':'), kind = id.slice(0, at) as Kind, key = id.slice(at + 1);
        if (KINDS.includes(kind)) writeSelection(localStorage, choose(readSelection(localStorage), kind, key));
        sync();
      },
      onClose: () => { picker.setAttribute('aria-expanded', 'false'); closeMenu = undefined; },
    });
  });

  const resyncAll = () => { sync(); options.resync(); };
  const stops = [manager.onExtensionsChanged(resyncAll), options.onContextChanged(sync)];
  window.addEventListener(rich.GRANTS_CHANGED, resyncAll);
  window.addEventListener('pandacode-components-change', sync);
  motion.addEventListener('change', sync);
  // The grant probe is live now: the conversation transcript is re-qualified against the real grant, not just the manifest.
  resyncAll();
  return {
    sync,
    /** What is drawn now (for the deterministic checks). */
    state: () => ({ indicator: indicatorNode.hidden ? null : frameNode.textContent, backdrop: backdrop?.key ?? null, picker: !picker.hidden, ticking: timer !== undefined }),
    dispose() {
      if (disposed) return;
      disposed = true; probe = undefined; closeMenu?.(); stopTimer(); removeBackdrop(); stops.forEach(stop => stop());
      window.removeEventListener(rich.GRANTS_CHANGED, resyncAll); window.removeEventListener('pandacode-components-change', sync); motion.removeEventListener('change', sync);
      pane.removeAttribute('data-presentation-backdrop'); strip.remove();
    },
  };
}
