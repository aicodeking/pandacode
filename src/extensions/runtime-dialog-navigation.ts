// Dialog answers and host navigation for background services (`ui.dynamic`, runtime phase R2, slice R0206).
//
// The native rules live in src-tauri/src/extensions/runtime_dialog_navigation.rs; the first half of this file mirrors them
// with no I/O for the browser preview and the deterministic checks of tests/extensions-runtime-dialog-navigation.spec.ts.
// The second half is what the main window runs: it shows the dialog a service asked for in the host's own extension dialog,
// returns the answer natively, closes it when the service stops or the package changes, and performs a reveal. Everything
// here is for predictability and fault isolation, never for trust (ADR-0005).
import type { Json } from './contracts';
import type { DialogDefinition, DialogValues } from './dialog-state';

export const PERMISSION = 'ui.dynamic';
export const ANSWER_BYTES = 65_536;

export type DialogAnswer = { status: 'confirmed'; values: DialogValues } | { status: 'cancelled' };
export type Pending = { id: string; owner: string; dialog: DialogDefinition };
export type RevealTarget = { view: string } | { taskId: string } | { projectId: string; path: string; line?: number; editor?: string } | { settingsPage: string };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: string; path: '$'; ids: [] } };
const failure = (code: string): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code, path: '$', ids: [] } });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/\p{Cc}/u.test(value);
const owns = (owner: string, id: string) => id.startsWith(`${owner}/`) && id.length > owner.length + 1;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Every owner's open dialog (at most one each) and the promise its service awaits. */
export class DialogSlots {
  private open = new Map<string, { owner: string; dialog: DialogDefinition; settle: (answer: DialogAnswer) => void }>();
  private serial = 0;
  count(owner: string) { return [...this.open.values()].filter(entry => entry.owner === owner).length; }
  pending(): Pending[] { return [...this.open].map(([id, entry]) => ({ id, owner: entry.owner, dialog: entry.dialog })); }

  /** `panda.ui.showDialog`: the id and the promise the service awaits; a second dialog of the owner is `Conflict`. */
  begin(owner: string, dialog: DialogDefinition): Reply<{ id: string; answer: Promise<DialogAnswer> }> {
    if (this.count(owner) > 0) return failure('Conflict');
    const id = `${owner}#dialog-${++this.serial}`;
    let settle!: (answer: DialogAnswer) => void;
    const answer = new Promise<DialogAnswer>(resolve => { settle = resolve; });
    this.open.set(id, { owner, dialog, settle });
    return { ok: true, value: { id, answer } };
  }

  /** The interface answers dialog `id`: values may name only declared fields; a gone dialog is `NotFound`. */
  answer(id: string, answer: unknown): Reply<null> {
    const entry = this.open.get(id);
    if (!entry) return failure('NotFound');
    let reply: DialogAnswer;
    if (record(answer) && answer.status === 'cancelled' && Object.keys(answer).length === 1) reply = { status: 'cancelled' };
    else if (record(answer) && answer.status === 'confirmed' && Object.keys(answer).length === 2 && record(answer.values)) {
      if (bytes(answer) > ANSWER_BYTES) return failure('LimitExceeded');
      const declared = entry.dialog.fields.map(field => field.id);
      if (Object.keys(answer.values).some(key => !declared.includes(key))) return failure('InvalidShape');
      reply = { status: 'confirmed', values: answer.values as DialogValues };
    } else return failure('InvalidShape');
    this.open.delete(id); entry.settle(reply);
    return { ok: true, value: null };
  }

  /** The owner's service stopped: its dialog resolves as cancelled. Answers the ids that closed. */
  cancelOwner(owner: string): string[] {
    const ids = [...this.open].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
    for (const id of ids) { const entry = this.open.get(id)!; this.open.delete(id); entry.settle({ status: 'cancelled' }); }
    return ids;
  }
}

/** What the app answers about the world; the spec gives fixed answers. */
export type World = {
  granted: boolean;
  views: string[]; settingsPages: string[];
  taskExists: (id: string) => boolean;
  /** The folder of a project, `null` when the project does not exist. */
  projectDir: (id: string) => string | null;
  fileExists: (directory: string, path: string) => boolean;
};

/** Checks a reveal target and answers it normalized (what the window receives), or the failure. */
export function checkReveal(owner: string, world: World, raw: unknown): Reply<RevealTarget> {
  if (!world.granted) return failure('PermissionDenied');
  if (!record(raw)) return failure('InvalidShape');
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === 'view') {
    if (!identifier(raw.view)) return failure('InvalidShape');
    if (!owns(owner, raw.view)) return failure('PermissionDenied');
    return world.views.includes(raw.view) ? { ok: true, value: { view: raw.view } } : failure('NotFound');
  }
  if (keys.length === 1 && keys[0] === 'settingsPage') {
    if (!identifier(raw.settingsPage)) return failure('InvalidShape');
    if (!owns(owner, raw.settingsPage)) return failure('PermissionDenied');
    return world.settingsPages.includes(raw.settingsPage) ? { ok: true, value: { settingsPage: raw.settingsPage } } : failure('NotFound');
  }
  if (keys.length === 1 && keys[0] === 'taskId') {
    if (!identifier(raw.taskId)) return failure('InvalidShape');
    return world.taskExists(raw.taskId) ? { ok: true, value: { taskId: raw.taskId } } : failure('NotFound');
  }
  if ('projectId' in raw && 'path' in raw && keys.every(key => ['projectId', 'path', 'line', 'editor'].includes(key))) {
    if (!identifier(raw.projectId) || !identifier(raw.path)) return failure('InvalidShape');
    // A path is relative to its project and stays inside it.
    if (raw.path.startsWith('/') || /^[A-Za-z]:/.test(raw.path) || raw.path.split(/[\\/]/).some(part => part === '..' || part === '')) return failure('InvalidShape');
    if ('line' in raw && !(Number.isInteger(raw.line) && (raw.line as number) >= 1 && (raw.line as number) <= 10_000_000)) return failure('InvalidShape');
    if ('editor' in raw) { if (!identifier(raw.editor)) return failure('InvalidShape'); if (!owns(owner, raw.editor)) return failure('PermissionDenied'); }
    const directory = world.projectDir(raw.projectId);
    if (directory === null || !world.fileExists(directory, raw.path)) return failure('NotFound');
    const target: Extract<RevealTarget, { projectId: string }> = { projectId: raw.projectId, path: raw.path };
    if ('line' in raw) target.line = raw.line as number;
    if ('editor' in raw) target.editor = raw.editor as string;
    return { ok: true, value: target };
  }
  return failure('InvalidShape');
}

// ---- The main window ---------------------------------------------------------------------------------------------

/** What the host does for a reveal; each returns whether it navigated (the target may have gone since the check). */
export type NavigationHost = {
  selectTask(id: string): Promise<boolean> | boolean;
  openView(id: string): boolean;
  openFile(projectId: string, path: string, options: { line?: number; editor?: string }): Promise<boolean> | boolean;
  openSettingsPage(id: string): Promise<boolean> | boolean;
};

const typingIn = (node: Element | null): node is HTMLElement => node instanceof HTMLElement && (node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'range'].includes(node.type)) || node.isContentEditable);

/** Runs a navigation without taking the keyboard from a text field the user is typing in. */
export async function keepTyping<T>(navigate: () => Promise<T> | T): Promise<T> {
  const field = typingIn(document.activeElement) ? document.activeElement : null;
  const selection = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? [field.selectionStart, field.selectionEnd] as const : null;
  try { return await navigate(); }
  finally {
    if (field?.isConnected && document.activeElement !== field && !document.querySelector('dialog[open]')) {
      field.focus({ preventScroll: true });
      if (selection && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && selection[0] !== null && selection[1] !== null) { try { field.setSelectionRange(selection[0], selection[1]); } catch { /* not selectable */ } }
    }
  }
}

/** Performs a checked target. A host that cannot show it (the task went in the meantime) changes nothing and sends nothing. */
export async function performReveal(host: NavigationHost, target: RevealTarget): Promise<boolean> {
  return keepTyping(async () => {
    if ('view' in target) return host.openView(target.view);
    if ('taskId' in target) return host.selectTask(target.taskId);
    if ('settingsPage' in target) return host.openSettingsPage(target.settingsPage);
    return host.openFile(target.projectId, target.path, { line: target.line, editor: target.editor });
  });
}

type Shown = { id: string; owner: string; close: () => void; hostClosed: boolean };
const queue: Pending[] = [];
let active: Shown | undefined, retry: ReturnType<typeof setTimeout> | undefined;
let started = false;
const CONTEXT = { schemaVersion: 1 as const, windowId: 'main', surfaceId: 'panda.runtime.dialog', revision: 0 };

async function send(id: string, answer: DialogAnswer): Promise<void> {
  try { const { call } = await import('../bridge'); await call('extensions_runtime_dialog_answer', { id, answer }); } catch { /* the dialog is gone natively: nothing waits for it */ }
}

/** Shows the next waiting dialog when the shared modal is free; a dialog waits while another one is open. */
function pump(): void {
  if (retry) { clearTimeout(retry); retry = undefined; }
  if (active || !queue.length) return;
  if (document.querySelector<HTMLDialogElement>('#dialog')?.open || document.querySelector('#extension-nested-dialog[open]')) { retry = setTimeout(pump, 150); return; }
  const next = queue.shift()!;
  void open(next);
}

async function open(item: Pending): Promise<void> {
  const [{ openExtensionDialog }, { extensionIdentity, onExtensionsChanged }] = await Promise.all([import('./dialogs'), import('./manager')]);
  if (active) { queue.unshift(item); return; }
  // The focus goes back to what had it, unless that lived inside another dialog.
  const focused = document.activeElement;
  const anchor = focused instanceof HTMLElement && !focused.closest('dialog') ? focused : document.body;
  let shown: Shown;
  try {
    const transient = openExtensionDialog(item.dialog, { ...CONTEXT }, item.owner, anchor);
    shown = { id: item.id, owner: item.owner, close: transient.close, hostClosed: false };
    active = shown;
    const identity = extensionIdentity(item.owner);
    // Disable, revoke, uninstall and safe mode change the package: its dialog goes at once, answered as cancelled.
    const unsubscribe = onExtensionsChanged(() => { if (extensionIdentity(item.owner) !== identity) transient.close(); });
    void transient.result.then(result => {
      unsubscribe(); if (active === shown) active = undefined;
      if (result.kind === 'cancelled' && result.reason === 'busy') { queue.unshift(item); pump(); return; }
      if (!shown.hostClosed) void send(item.id, result.kind === 'confirmed' ? { status: 'confirmed', values: result.values } : { status: 'cancelled' });
      pump();
    });
  } catch { void send(item.id, { status: 'cancelled' }); pump(); }
}

/** The service ended: its dialog leaves the window, shown or waiting. */
export function closeDialog(id: string): void {
  const waiting = queue.findIndex(item => item.id === id);
  if (waiting >= 0) queue.splice(waiting, 1);
  if (active?.id === id) { active.hostClosed = true; active.close(); }
}

/** Takes a dialog the host announced (or read at start); a known id is not shown twice. */
export function receiveDialog(item: Pending): void {
  if (active?.id === item.id || queue.some(entry => entry.id === item.id)) return;
  queue.push(item); pump();
}

/** Starts listening in the main window: dialogs to show, dialogs to close, reveals to perform. */
export async function startRuntimeDialogNavigation(host: NavigationHost): Promise<void> {
  if (started) return;
  started = true;
  const { call, subscribe, preview } = await import('../bridge');
  // The browser preview has no service: the spec delivers dialogs and reveals through this seam (and reads the answers
  // the preview mock of `extensions_runtime_dialog_answer` recorded).
  if (preview) (window as unknown as Record<string, unknown>).__runtimeDialogs = { receive: receiveDialog, close: closeDialog, reveal: (target: RevealTarget) => performReveal(host, target) };
  try { await subscribe('extensions-runtime-dialog', event => receiveDialog(event)); } catch { /* no events: the read below still shows the pending ones */ }
  try { await subscribe('extensions-runtime-dialog-close', event => closeDialog(event.id)); } catch { /* idem */ }
  try { await subscribe('extensions-runtime-reveal', event => { void performReveal(host, event.target); }); } catch { /* idem */ }
  try { for (const item of await call<Pending[]>('extensions_runtime_dialogs')) receiveDialog(item); } catch { /* none pending */ }
}

/** Test seam: forget every queued and shown dialog (the spec starts each case from nothing). */
export function resetRuntimeDialogs(): void { queue.length = 0; active = undefined; if (retry) { clearTimeout(retry); retry = undefined; } started = false; }
