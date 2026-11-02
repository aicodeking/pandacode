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
import { CHECK_EVERY, bannerPrompt, downloadsOnItsOwn, parseUpdateMode, restartNow, updatePrompt, type UpdateMode, type UpdateState } from './app-updates-policy';
import { PROJECT_LINKS } from './about-settings';
import { icon } from './dom';
import { enterView } from './motion';
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

/** Browser preview and specs: ?update=available|downloading|ready seeds the updater, since
 * the preview never checks on its own and nothing else would ever show. */
function previewState(): UpdateState {
  const kind = new URLSearchParams(location.search).get('update');
  if (kind === 'available') return { kind: 'available', version: '0.4.0' };
  if (kind === 'downloading') return { kind: 'downloading', version: '0.4.0', percent: 42 };
  if (kind === 'ready') return { kind: 'ready', version: '0.4.0' };
  return { kind: 'off' };
}

export function startAppUpdates(host: UpdatesHost): AppUpdates {
  const listeners = new Set<() => void>();
  let state: UpdateState = preview ? previewState() : { kind: 'idle' };
  let mode: UpdateMode = (() => { try { return parseUpdateMode(localStorage.getItem(KEY)); } catch { return 'automatic' as const; } })();
  // Until the native answer arrives nothing has been checked, so nothing can install.
  let installable = preview && state.kind !== 'off', approved = false;
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

/** The sidebar banner: the pill's prompt where the eye lands first. Pressing it opens
 * Settings → About and does what the update button there would: install and restart for a
 * downloadable or downloaded update, GitHub Releases on a copy that cannot install in place.
 * Its own dismiss (Later) is separate from the pill's. */
export function mountUpdateBanner(banner: HTMLDivElement, updates: AppUpdates, openAbout: () => void): void {
  banner.innerHTML = `<button type="button" class="sidebar-update-banner-body"><span class="sidebar-update-banner-icon"></span><span class="sidebar-update-banner-copy"><strong></strong><small></small></span></button><button type="button" class="sidebar-update-banner-dismiss" aria-label="Dismiss update notice">${icon('close')}</button>`;
  const iconSpan = banner.querySelector<HTMLElement>('.sidebar-update-banner-icon')!;
  const title = banner.querySelector<HTMLElement>('strong')!;
  const detail = banner.querySelector<HTMLElement>('small')!;
  const body = banner.querySelector<HTMLButtonElement>('.sidebar-update-banner-body')!;
  const dismiss = banner.querySelector<HTMLButtonElement>('.sidebar-update-banner-dismiss')!;
  let dismissed: string | null = null;
  const paint = () => {
    const prompt = bannerPrompt(updates.state, updates.installable, dismissed);
    const wasHidden = banner.hidden;
    banner.hidden = !prompt;
    if (!prompt) return;
    iconSpan.innerHTML = icon(updates.state.kind === 'available' || updates.state.kind === 'downloading' ? 'download' : 'refresh', 'icon-sm');
    title.textContent = prompt.title;
    detail.textContent = prompt.detail;
    dismiss.hidden = !prompt.dismissible;
    if (wasHidden) enterView(banner);
  };
  updates.subscribe(paint);
  body.addEventListener('click', () => {
    const kind = updates.state.kind;
    openAbout();
    if (!updates.installable && kind === 'available') void call('open_external_url', { url: PROJECT_LINKS.releases });
    else if (kind === 'available' || kind === 'ready') void updates.restart();
  });
  dismiss.addEventListener('click', () => { if (updates.state.kind === 'available') { dismissed = updates.state.version; paint(); } });
  paint();
}
