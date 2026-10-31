import { preview } from './bridge';
import { icon } from './dom';
import { appUpdates, describeUpdate, type UpdateMode } from './app-updates';

/** Public project links. Opening one is user-initiated; only the update check runs on its own. */
export const PROJECT_LINKS = {
  repository: 'https://github.com/aicodeking/pandacode',
  issues: 'https://github.com/aicodeking/pandacode/issues',
  releases: 'https://github.com/aicodeking/pandacode/releases',
  license: 'https://github.com/aicodeking/pandacode/blob/main/LICENSE',
} as const;

const link = (label: string, url: string) =>
  `<button type="button" class="secondary-button" data-action="open-url" data-url="${url}">${label}${icon('forward')}</button>`;

/** The About group: app version, license, updates from GitHub Releases, and links. */
export function aboutSettingsHtml(): string {
  return `<div class="settings-group settings-about" aria-labelledby="settings-about-heading">
    <div class="setting-row"><div><strong id="settings-about-heading">About PandaCode</strong><small class="settings-about-version">Version …</small></div></div>
    <div class="setting-row"><div><strong>License</strong><small>Open source (MIT-based). No account, no telemetry.</small></div>${link('PandaCode License', PROJECT_LINKS.license)}</div>
    <div class="setting-row settings-updates"><div><strong>Updates</strong><small class="settings-update-status" aria-live="polite">Checks GitHub Releases automatically.</small></div><div class="settings-row-actions"><button type="button" class="secondary-button settings-update-action" hidden></button>${link('Releases', PROJECT_LINKS.releases)}</div></div>
    <div class="setting-row settings-updates-auto"><div><strong>Update mode</strong><small>Automatic restarts when no agent is working; Notify me asks first.</small></div><select class="settings-select" data-update-mode aria-label="Update mode"><option value="automatic">Automatic</option><option value="notify">Notify me</option><option value="off">Off</option></select></div>
    <div class="setting-row"><div><strong>Source code</strong><small>Report bugs and follow development.</small></div><div class="settings-row-actions">${link('GitHub repository', PROJECT_LINKS.repository)}${link('Issues', PROJECT_LINKS.issues)}</div></div>
  </div>`;
}

/** Reads the bundle version from Tauri; the browser preview has no app bundle. */
async function appVersion(): Promise<string> {
  if (preview) return 'Preview';
  return (await import('@tauri-apps/api/app')).getVersion();
}

export function mountAboutSettings(host: HTMLElement): () => void {
  const version = host.querySelector<HTMLElement>('.settings-about-version');
  let disposed = false;
  const cleanupUpdates = mountUpdates(host);
  if (version) {
    appVersion()
      .then(value => { if (!disposed) version.textContent = `Version ${value}`; })
      .catch(() => { if (!disposed) version.textContent = 'Version unavailable'; });
  }
  return () => { disposed = true; cleanupUpdates(); };
}

/** The Updates rows follow the updater: status, Check now / Install / Restart now, and the mode. */
function mountUpdates(host: HTMLElement): () => void {
  const updates = appUpdates();
  const status = host.querySelector<HTMLElement>('.settings-update-status')!;
  const action = host.querySelector<HTMLButtonElement>('.settings-update-action')!;
  const modeSelect = host.querySelector<HTMLSelectElement>('[data-update-mode]')!;
  if (!updates?.supported) {
    status.textContent = describeUpdate({ kind: 'off' }, 'off');
    host.querySelector<HTMLElement>('.settings-updates-auto')?.remove();
    return () => {};
  }
  const paint = () => {
    const state = updates.state;
    status.textContent = describeUpdate(state, updates.mode, Date.now(), updates.installable);
    modeSelect.value = updates.mode;
    const restartable = updates.installable && (state.kind === 'ready' || state.kind === 'available');
    action.hidden = state.kind === 'downloading' || state.kind === 'installing';
    action.disabled = state.kind === 'checking';
    action.textContent = restartable ? (state.kind === 'ready' ? 'Restart now' : 'Install') : 'Check now';
  };
  const click = () => { void (updates.installable && (updates.state.kind === 'ready' || updates.state.kind === 'available') ? updates.restart() : updates.check()); };
  const change = () => updates.setMode(modeSelect.value as UpdateMode);
  action.addEventListener('click', click);
  modeSelect.addEventListener('change', change);
  const unsubscribe = updates.subscribe(paint);
  paint();
  return () => { unsubscribe(); action.removeEventListener('click', click); modeSelect.removeEventListener('change', change); };
}
