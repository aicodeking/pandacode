import './file-explorer.css';
import { webMode } from './bridge';
import { escape, isImeKey } from './dom';
import type { openChoiceMenu } from './choice-menu';
import { onWindowFocus, windowFocused } from './window-focus';

type Context = { projectId: string; sessionId?: string };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  menu(options: Omit<Parameters<typeof openChoiceMenu>[0], 'onClose'>): void;
  modal(title: string, body: string): HTMLDialogElement;
  closeModal(): void;
  open(path: string, context: Context): Promise<void>;
  changed(context: Context, path: string, next?: string): void;
  hasChanges(context: Context, path: string): boolean;
  created(context: Context, parent: string): void;
  /** Re-reads the tree and the open file; true when the tree changed. */
  refresh(): Promise<boolean>;
  /** Whether the open thread's agent is working: its edits land without any input, so the poll keeps the quick rate. */
  busy(): boolean;
  notify(text: string): void;
  report(error: unknown): void;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** How often the open tree and the file on screen are re-read while someone can see them: every 2 s while the window is
 * focused and in use or the open thread's agent is working; every 3 s once it settles (three unchanged reads in a row, or
 * 30 s without input) or while it is shown but another app has focus, so PandaCode beside an editor shows its saves
 * within 3 s, even after a long idle. */
const POLL_MS = 2000, SETTLED_POLL_MS = 3000;
/** An agent's tool or file event is followed by one read this soon (ms), batching a burst of events into one. */
const ACTIVITY_READ_MS = 400;
/** Unchanged reads in a row, and ms without input, after which a focused window polls at SETTLED_POLL_MS. */
const SETTLE_READS = 3, SETTLE_IDLE_MS = 30_000;
/** What the poll keeps fresh: the Files tree in the inspector, and the open-file panel (tabs or a floating window). */
const WATCHED = '#inspector-content .file-explorer, #file-panel';
/** Input that brings a focused, settled poll back to POLL_MS. */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/** Whether a watched surface is on screen. One query and a visibility check per tick, every POLL_MS at most. */
function watchedVisible(): boolean {
  for (const element of document.querySelectorAll<HTMLElement>(WATCHED)) {
    const shown = typeof element.checkVisibility === 'function' ? element.checkVisibility() : element.getClientRects().length > 0;
    if (shown) return true;
  }
  return false;
}

/** One refresh: true when it changed what is shown, false when it read the same, undefined when it did not run. */
type PollRefresh = () => Promise<boolean | undefined>;
type Poll = { watch(mounted: boolean): void; changed(): void; activity(): void };
let poll: Poll | undefined;
/** Whether a Files tree or an open file tab exists; the interval runs only while one does. Safe before the explorer exists. */
let pollMounted = false;
export function setFilePollMounted(mounted: boolean): void { pollMounted = mounted; poll?.watch(mounted); }
/** Something on a watched surface changed outside the poll (an open file reloaded): back to the quick rate. */
export function noteFilePollChange(): void { poll?.changed(); }
/** The open thread's agent used a tool or changed files: back to the quick rate, and one read shortly after. */
export function noteFilePollActivity(): void { poll?.activity(); }

/** The poll (`list_files` for the tree, `workspace_file_stamp` for the file on screen): every POLL_MS while the window is
 * focused and in use, every SETTLED_POLL_MS once it settles or while it is shown without focus, and none while it is
 * hidden or no tree or file tab is mounted. Each scheduled read skips the refresh unless
 * the Files tree or an open file is visible. Coming back (focus, or the document shown again) refreshes at once; focus,
 * input and a change restart the quick rate. */
function startPolling(refresh: PollRefresh, busy: () => boolean): Poll {
  // Read, never assumed: a window launched in the background starts unfocused, and focus that leaves the app from inside
  // one of its frames fires no blur here (the window blurred when the frame took focus), so each tick reads it again too.
  // The window's focus, not the page's: the in-app browser (a native child webview) takes the page's focus, not the window's.
  let timer = 0, period = 0, focused = windowFocused(), mounted = pollMounted, unchanged = 0, active = Date.now(), soon = 0, nextPoll = 0;
  const settled = (): boolean => unchanged >= SETTLE_READS || Date.now() - active >= SETTLE_IDLE_MS;
  const rate = (): number => {
    if (document.hidden || !mounted) return 0;
    if (busy() || focused && !settled()) return POLL_MS;
    return SETTLED_POLL_MS;
  };
  const sync = (): void => {
    const next = rate();
    if (next === period) return;
    if (timer) { window.clearInterval(timer); timer = 0; }
    period = next;
    nextPoll = Date.now() + period;
    if (period) timer = window.setInterval(filePollTick, period);
  };
  const wake = (): void => { unchanged = 0; active = Date.now(); sync(); };
  const run = (): void => {
    window.clearTimeout(soon); soon = 0;
    if (document.hidden || !mounted || !watchedVisible()) return;
    void refresh().then(changed => {
      if (changed === undefined) return;
      if (changed) wake(); else { unchanged++; sync(); }
    });
  };
  // Named so a test can tell this interval from the app's others.
  function filePollTick(): void {
    nextPoll = Date.now() + period;
    focused = windowFocused();
    sync();
    run();
  }
  // Only a focused, settled poll has a rate to restore, so input costs a timestamp otherwise.
  const input = (): void => {
    active = Date.now();
    if (unchanged || period === SETTLED_POLL_MS && focused) wake();
  };
  for (const type of INPUT_EVENTS) window.addEventListener(type, input, { capture: true, passive: true });
  const focusedAgain = (): void => { focused = true; wake(); run(); };
  window.addEventListener('focus', focusedAgain);
  // A blur also fires when focus moves into one of the app's own frames or its in-app browser; the window still has
  // focus then, so read it once the move has landed rather than trusting the event. Leaving the app is reported too.
  window.addEventListener('blur', () => { window.setTimeout(() => { focused = windowFocused(); sync(); }, 0); });
  onWindowFocus(now => { if (now === focused) return; if (now) focusedAgain(); else { focused = false; sync(); } });
  document.addEventListener('visibilitychange', () => {
    focused = windowFocused();
    if (document.hidden) sync(); else { wake(); run(); }
  });
  sync();
  return {
    watch(next) { if (next === mounted) return; mounted = next; if (next) wake(); else sync(); },
    changed: wake,
    activity() {
      wake();
      if (soon || !period || nextPoll - Date.now() <= ACTIVITY_READ_MS) return;
      soon = window.setTimeout(run, ACTIVITY_READ_MS);
    },
  };
}

export function createFileExplorer(deps: Deps) {
  let refreshing = false;
  async function refresh(): Promise<boolean | undefined> {
    if (refreshing) return undefined;
    refreshing = true;
    try { return await deps.refresh(); } finally { refreshing = false; }
  }
  function edit(context: Context, action: string, path: string, directory: boolean): void {
    const name = path.split('/').pop() ?? '';
    const deleting = action === 'delete', renaming = action === 'rename';
    const title = deleting ? `Delete ${name}?` : renaming ? 'Rename' : action === 'new-folder' ? 'New folder' : 'New file';
    const dialog = deps.modal(title, `<form class="explorer-form">${deleting ? `<p class="dialog-description">This permanently deletes ${escape(path)}${directory ? ' and all its contents' : ''}.</p>` : `<label class="field-label" for="explorer-name">Name</label><input id="explorer-name" name="name" value="${renaming ? escape(name) : ''}" required autocomplete="off" spellcheck="false" maxlength="255">`}<p role="alert" class="ds-danger" hidden></p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="primary-button${deleting ? ' danger' : ''}">${deleting ? 'Delete permanently' : renaming ? 'Rename' : 'Create'}</button></div></form>`);
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector<HTMLInputElement>('input');
    input?.select();
    form.addEventListener('keydown', event => { if (event.key === 'Enter' && isImeKey(event)) { event.preventDefault(); event.stopPropagation(); } });
    form.addEventListener('submit', event => {
      event.preventDefault(); event.stopPropagation();
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      if (submit.disabled) return;
      void (async () => {
        submit.disabled = true;
        try {
          if ((deleting || renaming) && deps.hasChanges(context, path)) throw new Error('Save or discard unsaved edits in this file or folder first.');
          const value = (input?.value ?? '').trim();
          if (!deleting && (!value || /[/\\:\0]/.test(value) || value === '.' || value === '..' || value.toLowerCase() === '.git')) throw new Error('Enter a single file or folder name.');
          const parent = renaming || deleting ? path : directory ? path : path.split('/').slice(0, -1).join('/');
          const target = renaming || deleting ? path : [parent, value].filter(Boolean).join('/');
          const next = await deps.call<string>('manage_workspace_entry', { ...context, action, path: target, ...(renaming ? { name: value } : {}) });
          if (deleting || renaming) deps.changed(context, path, deleting ? undefined : next);
          if (!deleting && !renaming) deps.created(context, parent);
          if (form.isConnected && dialog.open) deps.closeModal();
          await refresh();
          if (action === 'new-file') await deps.open(target, context);
          deps.notify(deleting ? 'Deleted' : renaming ? 'Renamed' : 'Created');
        } catch (error) {
          const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
          alert.textContent = message(error); alert.hidden = false;
        } finally { submit.disabled = false; }
      })();
    });
  }
  function menu(anchor: HTMLElement, context: Context, path: string, directory: boolean, point?: { x: number; y: number }): void {
    deps.menu({ anchor, point, title: path.split('/').pop() || 'Project files', actions: true, items: [
      { id: 'new-file', label: 'New File', icon: 'file' },
      { id: 'new-folder', label: 'New Folder', icon: 'folder' },
      ...(path ? [{ id: 'rename', label: 'Rename', icon: 'edit', separator: true }, { id: 'delete', label: 'Delete', icon: 'trash', danger: true }] : []),
      { id: 'copy-path', label: 'Copy Path', icon: 'copy', separator: true },
      // Revealing or opening in a default app happens on the PandaCode machine, never from a browser tab.
      ...(webMode ? [] : [{ id: 'reveal', label: 'Reveal in OS', icon: 'folder' }]),
      ...(!directory && !webMode ? [{ id: 'open-external', label: 'Open in Default App', icon: 'external' }] : []),
    ], onSelect: async action => {
      if (['copy-path', 'reveal', 'open-external'].includes(action)) {
        if (action === 'open-external') { await deps.call('open_workspace_file', { ...context, path }); return; }
        const absolute = await deps.call<string>('manage_workspace_entry', { ...context, action: 'path', path });
        if (action === 'reveal') await deps.call('reveal_path', { path: absolute });
        else { await navigator.clipboard.writeText(absolute); deps.notify('Path copied'); }
      } else edit(context, action, path, directory);
    } });
  }
  poll = startPolling(() => refresh().catch(error => { deps.report(error); return undefined; }), deps.busy);
  return { menu, edit };
}
