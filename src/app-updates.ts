/* Automatic updates from GitHub Releases. The app checks the latest release's
 * latest.json (tauri.conf.json `plugins.updater`) shortly after launch and every six
 * hours, downloads a newer version in the background, and installs it with a restart
 * once no agent is working and the window has been idle for a while, so a restart never
 * cuts a run short. Every download is verified against the public key built into the
 * app before it installs. Settings → About → Updates picks Automatic, Notify me (checks,
 * then asks with Install and restart / Later in the header) or Off (no checks of its own).
 * A Linux copy not started from an AppImage (unpacked, or a distro package) is never
 * installed over in place: it only reports the update. The request carries no personal
 * data. The browser preview never checks. */
import { call, preview } from './bridge';
import { CHECK_EVERY, downloadsOnItsOwn, parseUpdateMode, restartNow, updatePrompt, type UpdateMode, type UpdateState } from './app-updates-policy';
import { PROJECT_LINKS } from './about-settings';
import config from '../src-tauri/tauri.conf.json';
export { describeUpdate, type UpdateMode, type UpdateState } from './app-updates-policy';

export interface UpdatesHost {
  /** True while any agent is working; installing waits for it to finish. */
  busy(): boolean;
  notify(text: string): void;
}
export interface AppUpdates {
  readonly state: UpdateState;
  readonly mode: UpdateMode;
  readonly supported: boolean;
  /** False for a Linux run outside an AppImage: updates are reported, never installed. */
  readonly installable: boolean;
  subscribe(listener: () => void): () => void;
  setMode(mode: UpdateMode): void;
  check(): Promise<void>;
  /** Installs a downloaded update and restarts; refuses while an agent is working. */
  restart(): Promise<void>;
}

const KEY = 'pandacode.autoUpdate';
const FIRST_CHECK = 30_000;

type Pending = { version: string; download(onEvent: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>; install(): Promise<void> };

let instance: AppUpdates | undefined;
export const appUpdates = (): AppUpdates | undefined => instance;

export function startAppUpdates(host: UpdatesHost): AppUpdates {
  // A fork without an update feed must ignore saved modes and explicit update requests.
  if (!config.plugins.updater.endpoints.length) {
    return instance = {
      state: { kind: 'off' }, mode: 'off', supported: false, installable: false,
      subscribe: () => () => {}, setMode: () => {}, check: async () => {}, restart: async () => {},
    };
  }
  const listeners = new Set<() => void>();
  let state: UpdateState = preview ? { kind: 'off' } : { kind: 'idle' };
  let mode: UpdateMode = (() => { try { return parseUpdateMode(localStorage.getItem(KEY)); } catch { return 'automatic' as const; } })();
  // Until the native answer arrives nothing has been checked, so nothing can install.
  let installable = false, approved = false;
  const known = preview ? Promise.resolve() : call<boolean>('app_update_install_supported')
    .then(value => { installable = value; }, cause => { console.warn('Could not tell how PandaCode was installed:', cause); });
  let pending: Pending | null = null, lastCheck = 0, lastInput = Date.now(), checking: Promise<void> | null = null;
  const set = (next: UpdateState) => { state = next; listeners.forEach(listener => listener()); };
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

  async function download(update: Pending): Promise<void> {
    let total = 0, received = 0;
    set({ kind: 'downloading', version: update.version, percent: null });
    await update.download(event => {
      if (event.event === 'Started') total = event.data?.contentLength ?? 0;
      if (event.event === 'Progress') { received += event.data?.chunkLength ?? 0; if (total) set({ kind: 'downloading', version: update.version, percent: Math.min(100, Math.round(received / total * 100)) }); }
    });
    set({ kind: 'ready', version: update.version });
  }

  async function run(): Promise<void> {
    if (preview || state.kind === 'downloading' || state.kind === 'ready' || state.kind === 'installing') return;
    lastCheck = Date.now();
    set({ kind: 'checking' });
    await known;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check() as Pending | null;
      if (!update) { set({ kind: 'current', checkedAt: Date.now() }); return; }
      pending = update;
      if (downloadsOnItsOwn(mode, installable)) await download(update); else set({ kind: 'available', version: update.version });
    } catch (cause) {
      // Offline, rate-limited or a release without a manifest: say so in About, never interrupt.
      set({ kind: 'error', message: message(cause) });
    }
  }
  const check = () => (checking ??= run().finally(() => { checking = null; }));

  /** Re-signs the bundle with the stable local identity (macOS); never blocks an update. */
  async function localSign(): Promise<void> {
    try { await call('local_sign_app'); } catch (cause) { console.warn('Local signing failed:', cause); }
  }

  async function restart(): Promise<void> {
    if (!pending || !installable) return;
    // The user asked for it: restart as soon as no agent is working, idle or not.
    approved = true;
    const busy = host.busy();
    if (busy) host.notify('PandaCode will restart to update when your agents finish.');
    if (state.kind === 'available') { try { await download(pending); } catch (cause) { set({ kind: 'error', message: message(cause) }); return; } }
    if (busy || host.busy()) return;
    const version = pending.version;
    set({ kind: 'installing', version });
    try {
      // Waits out the startup signing pass so it never touches a bundle mid-install.
      await localSign();
      await pending.install();
      await localSign();
      await (await import('@tauri-apps/plugin-process')).relaunch();
    } catch (cause) { set({ kind: 'error', message: message(cause) }); }
  }

  if (!preview) {
    const input = () => { lastInput = Date.now(); };
    for (const name of ['pointerdown', 'keydown', 'wheel']) addEventListener(name, input, { passive: true, capture: true });
    window.setTimeout(() => { if (mode !== 'off') void check(); }, FIRST_CHECK);
    window.setInterval(() => {
      if (mode !== 'off' && Date.now() - lastCheck >= CHECK_EVERY) void check();
      if (state.kind === 'ready' && restartNow(mode, approved, host.busy(), lastInput)) void restart();
    }, 30_000);
  }

  instance = {
    get state() { return state; },
    get mode() { return mode; },
    get installable() { return installable; },
    supported: !preview,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    setMode(next) {
      mode = next;
      try { localStorage.setItem(KEY, next); } catch { /* A per-device preference only. */ }
      if (next !== 'off' && state.kind !== 'ready') void check();
      listeners.forEach(listener => listener());
    },
    check,
    restart,
  };
  return instance;
}

/** The header prompt (`#update-status`): Install and restart / Later for a found update,
 * Restart to update once downloaded. Later hides it until a newer version turns up. */
export function mountUpdatePill(pill: HTMLButtonElement, updates: AppUpdates): void {
  const label = pill.querySelector('span')!;
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'update-status update-later';
  later.textContent = 'Later';
  later.hidden = true;
  pill.after(later);
  let dismissed: string | null = null;
  const paint = () => {
    const state = updates.state;
    const prompt = updatePrompt(state, updates.installable, dismissed);
    pill.hidden = !prompt;
    later.hidden = !prompt?.later;
    if (!prompt) return;
    label.textContent = prompt.label;
    pill.title = prompt.title;
    pill.disabled = state.kind === 'installing';
  };
  updates.subscribe(paint);
  pill.addEventListener('click', () => {
    if (updates.state.kind === 'available' && !updates.installable) void call('open_external_url', { url: PROJECT_LINKS.releases });
    else void updates.restart();
  });
  later.addEventListener('click', () => { if (updates.state.kind === 'available') dismissed = updates.state.version; paint(); });
  paint();
}
