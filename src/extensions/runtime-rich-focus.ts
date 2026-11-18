/**
 * Panel focus, keys, kept-alive hidden panels and minimum size (R0304, contract G3 and "Kept alive").
 *
 * The twin of `runtime_rich_focus.rs` plus the main window's side:
 *
 * - **Keys.** The client script (`rich-view-client.js`) forwards only the key-downs its page left alone that are
 *   Escape or carry the command modifier, never a key of an input-method composition (`richViewChord`). Escape and
 *   `pandaView.releaseFocus()` return focus to the control that had it before the panel; any other chord is pressed
 *   in the app (a key-down on its document body, so the app's global shortcuts run and no control acts on it).
 * - **Entering.** An installed panel is one stop in the app's tab order (its slot); focusing that stop moves the
 *   keyboard into the panel's webview. A preview frame is a tab stop by itself.
 * - **Kept alive.** An installed inspector panel whose view leaves the screen is parked natively (hidden, document
 *   kept); at most four parked panels live in the app, the least recently shown is closed beyond that and comes back
 *   restored from its state. The browser preview cannot keep a removed frame's document, so there every hidden panel
 *   is closed at once and restored from state (the same path as an evicted one).
 * - **Size.** `rich.minSize` is the panel's minimum; a smaller mount scrolls (the host slot in the preview, the shell
 *   inside the webview when installed) and nothing animates layout.
 */
// The bridge reads `window` when it loads, so it is imported on first use (this module is also loaded by Node specs).
const call = async <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => (await import('../bridge')).call<T>(command, args);
const inPreview = () => typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
import { isImeKey } from '../dom';

export const RETAINED_LIMIT = 4;
export const GRACE_MS = 250;
export const FOCUS_EVENT = 'extensions-rich-focus';
export const EVICTED = 'evicted';
export const KEY_LIMIT = 32;
export const MIN_WIDTH = 160, MIN_HEIGHT = 240, MAX_SIDE = 2000;
const MODIFIERS = ['Control', 'Meta', 'Shift', 'Alt'];

export type Chord = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };
export type Forward = { kind: 'release' } | ({ kind: 'key' } & Chord);

const validKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && [...key].length <= KEY_LIMIT && !/\p{Cc}/u.test(key);
const validCode = (code: unknown): code is string => typeof code === 'string' && code.length <= KEY_LIMIT && /^[A-Za-z0-9]*$/.test(code);
/** Escape, or a key with the command modifier that is not itself a modifier. */
export const forwardable = (chord: Chord) => chord.key === 'Escape' || ((chord.ctrlKey || chord.metaKey) && !MODIFIERS.includes(chord.key));
const fromChord = (chord: Chord): Forward => chord.key === 'Escape' ? { kind: 'release' } : { kind: 'key', ...chord };

/** The twin of `runtime_rich_focus::parse_value`: closed shapes bound to the session; throws `InvalidShape`. */
export function parseForward(value: unknown, session: string): Forward {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('InvalidShape');
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== 1 || object.session !== session) throw new Error('InvalidShape');
  const keys = Object.keys(object).sort().join(',');
  if (object.kind === 'release' && keys === 'kind,schemaVersion,session') return { kind: 'release' };
  if (object.kind !== 'key' || keys !== 'altKey,code,ctrlKey,key,kind,metaKey,schemaVersion,session,shiftKey') throw new Error('InvalidShape');
  const flags = ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const;
  if (!validKey(object.key) || !validCode(object.code) || !flags.every(flag => typeof object[flag] === 'boolean')) throw new Error('InvalidShape');
  const chord: Chord = { key: object.key, code: object.code, ctrlKey: object.ctrlKey as boolean, metaKey: object.metaKey as boolean, shiftKey: object.shiftKey as boolean, altKey: object.altKey as boolean };
  if (!forwardable(chord)) throw new Error('InvalidShape');
  return fromChord(chord);
}
/** The twin of `runtime_rich_focus::title_signal` (the inline shell's channel): `[sequence, request]`. */
export function titleSignal(title: string): [number, Forward] | undefined {
  const release = /^panda-view:release:(\d+)$/.exec(title);
  if (release) return [Number(release[1]), { kind: 'release' }];
  const key = /^panda-view:key:(\d+):(\d{1,2}):([^:]*):(.*)$/s.exec(title);
  if (!key || Number(key[2]) >= 16 || !validCode(key[3]) || !validKey(key[4])) return undefined;
  const flags = Number(key[2]);
  const chord: Chord = { key: key[4], code: key[3], ctrlKey: !!(flags & 1), metaKey: !!(flags & 2), shiftKey: !!(flags & 4), altKey: !!(flags & 8) };
  return forwardable(chord) ? [Number(key[1]), fromChord(chord)] : undefined;
}

/** The twin of `runtime_rich_focus::Retention`: parked panels, least recently shown first. */
export class Retention {
  private items: [label: string, slot: string][] = [];
  /** Answers the mounts to close: an older park of the same slot, then the least recently shown beyond four. */
  park(label: string, slot: string): string[] {
    this.items = this.items.filter(([parked]) => parked !== label);
    const evicted = this.items.filter(([, parkedSlot]) => parkedSlot === slot).map(([parked]) => parked);
    this.items = this.items.filter(([, parkedSlot]) => parkedSlot !== slot);
    this.items.push([label, slot]);
    while (this.items.length > RETAINED_LIMIT) evicted.push(this.items.shift()![0]);
    return evicted;
  }
  resume(label: string): boolean {
    const index = this.items.findIndex(([parked]) => parked === label);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }
  forget(label: string): void { this.items = this.items.filter(([parked]) => parked !== label); }
  isParked(label: string): boolean { return this.items.some(([parked]) => parked === label); }
  get parked(): string[] { return this.items.map(([label]) => label); }
}

/** `rich.minSize` with the inspector defaults (160 by 240) and the schema's bounds; the twin of `min_size`. */
export function minSize(rich: { minSize?: { width?: number; height?: number } } | undefined): { width: number; height: number } {
  const side = (value: number | undefined, fallback: number) => Math.min(MAX_SIDE, Math.max(MIN_WIDTH, Number.isInteger(value) ? value! : fallback));
  return { width: side(rich?.minSize?.width, MIN_WIDTH), height: side(rich?.minSize?.height, MIN_HEIGHT) };
}
export const sized = (url: string, size: { width: number; height: number }) => `${url.split('#')[0]}#panda-min=${size.width}x${size.height}`;

/** The part of `element` its scrolling ancestors and the viewport leave visible (a native webview cannot be clipped). */
export function visibleBox(element: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
  }
  left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// ---- the main window ------------------------------------------------------------------------------------------

const PANEL = '.extension-rich-panel';
let lastControl: WeakRef<HTMLElement> | undefined;
let returning: HTMLElement | undefined;
let installed = false;

/** Remembers the app control that had focus last (never a panel), and hears the installed panels' requests. */
export function installFocusHost(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('focusin', event => {
    const target = event.target;
    if (target instanceof HTMLElement && target !== document.body && !target.closest(PANEL) && !(target instanceof HTMLIFrameElement)) lastControl = new WeakRef(target);
  }, true);
  if (inPreview()) return;
  void import('@tauri-apps/api/event').then(({ listen }) => listen<{ mountId: string } & Forward>(FOCUS_EVENT, event => {
    const { mountId, ...forward } = event.payload;
    if (typeof mountId !== 'string' || !/^extension-(panel|view)-[A-Za-z0-9-]{1,64}$/.test(mountId)) return;
    if (forward.kind === 'release') handleForward(mountId, { kind: 'release' });
    else if (forward.kind === 'key' && validKey(forward.key) && validCode(forward.code)) {
      const chord: Chord = { key: forward.key, code: forward.code, ctrlKey: !!forward.ctrlKey, metaKey: !!forward.metaKey, shiftKey: !!forward.shiftKey, altKey: !!forward.altKey };
      if (forwardable(chord)) handleForward(mountId, fromChord(chord));
    }
  }));
}

/** A request of panel `mountId` (an inspector mount or a separate window). */
export function handleForward(mountId: string, forward: Forward): void {
  if (forward.kind === 'release') restoreFocus(mountId);
  else dispatchChord(forward);
}

const focusable = (element: HTMLElement | undefined): element is HTMLElement =>
  !!element && element.isConnected && !element.closest('[inert],[hidden]') && element.checkVisibility() && !(element as HTMLButtonElement).disabled;

/** Returns focus to the control that had it before the panel; else to the panel's own tab stop (not re-entering). */
export function restoreFocus(mountId: string): HTMLElement | undefined {
  const before = lastControl?.deref();
  if (focusable(before)) { before.focus({ preventScroll: true }); return before; }
  const slot = [...document.querySelectorAll<HTMLElement>(PANEL)].find(item => item.dataset.mountId === mountId);
  if (slot && focusable(slot)) {
    if (!slot.hasAttribute('tabindex')) slot.tabIndex = -1;
    returning = slot; slot.focus({ preventScroll: true }); returning = undefined;
    return slot;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  return undefined;
}

/** Presses `chord` in the app: a key-down on the document body, so global shortcuts run (IME keys never come here). */
export function dispatchChord(chord: Chord): boolean {
  const event = new KeyboardEvent('keydown', { key: chord.key, code: chord.code, ctrlKey: chord.ctrlKey, metaKey: chord.metaKey, shiftKey: chord.shiftKey, altKey: chord.altKey, bubbles: true, cancelable: true, composed: true });
  if (isImeKey(event)) return false;
  return document.body.dispatchEvent(event);
}

/**
 * The panel's tab stop. Installed: the slot is one stop in the app's tab order and focusing it moves the keyboard
 * into the panel's webview (`enter`). Preview: the frame is a tab stop already, so the slot stays out of the order.
 * The preview's frames report their keys and `releaseFocus` through the host page (`fromFrame`).
 */
export function bindPanelFocus(slot: HTMLElement, enter: () => void, signal: AbortSignal): void {
  installFocusHost();
  if (inPreview()) return;
  slot.tabIndex = 0;
  slot.addEventListener('focus', () => { if (returning !== slot) enter(); }, { signal });
}
/** Native `enter` for mount `mountId`. */
export const enterNative = (mountId: string) => call('extensions_rich_focus', { request: { mountId, op: 'enter' } }).catch(() => {});

/** A preview shell's message to the host page (`kind: 'key' | 'release'`); `true` when it was one. */
export function fromFrame(mountId: string, data: Record<string, unknown>): boolean {
  if (data.kind === 'release') { handleForward(mountId, { kind: 'release' }); return true; }
  if (data.kind !== 'key') return false;
  const chord = data.chord as Partial<Chord> | undefined;
  if (!chord || !validKey(chord.key) || !validCode(chord.code)) return true;
  const value: Chord = { key: chord.key, code: chord.code, ctrlKey: chord.ctrlKey === true, metaKey: chord.metaKey === true, shiftKey: chord.shiftKey === true, altKey: chord.altKey === true };
  if (forwardable(value)) handleForward(mountId, fromChord(value));
  return true;
}

// ---- parked installed panels ------------------------------------------------------------------------------------

/** An installed inspector panel that can be parked and shown again. */
export type Parkable = { readonly mountId: string; close(): void };
const parkedPanels = new Map<string, Parkable>();

/** Parks `panel` of view `viewId` natively (hidden, document kept). The native side closes what it evicts. */
export async function parkNative(viewId: string, panel: Parkable): Promise<void> {
  const previous = parkedPanels.get(viewId);
  parkedPanels.set(viewId, panel);
  if (previous && previous !== panel) previous.close();
  try {
    const reply = await call<{ parked: boolean; evicted: string[] }>('extensions_rich_focus', { request: { mountId: panel.mountId, op: 'park' } });
    for (const [view, item] of parkedPanels) if (reply.evicted.includes(item.mountId)) parkedPanels.delete(view);
  } catch {
    if (parkedPanels.get(viewId) === panel) parkedPanels.delete(viewId);
    panel.close();
  }
}
/** Takes the parked panel of `viewId` back, or `undefined` when there is none (or it was closed meanwhile). */
export async function resumeNative<T extends Parkable>(viewId: string): Promise<T | undefined> {
  const panel = parkedPanels.get(viewId) as T | undefined;
  if (!panel) return undefined;
  parkedPanels.delete(viewId);
  try { await call('extensions_rich_focus', { request: { mountId: panel.mountId, op: 'resume' } }); return panel; }
  catch { panel.close(); return undefined; }
}
/** A parked panel that ended (evicted, failed, or a lifecycle end). */
export function forgetParked(mountId: string): void { for (const [view, item] of parkedPanels) if (item.mountId === mountId) parkedPanels.delete(view); }
export const parkedCount = () => parkedPanels.size;
