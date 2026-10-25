import { call, preview, webMode } from './bridge';
import { icon } from './dom';
import { appUpdates, describeUpdate, type UpdateMode } from './app-updates';
import { t } from './i18n.ts';

/** Public project links. Opening one is user-initiated; only the update check runs on its own. */
export const PROJECT_LINKS = {
  repository: 'https://github.com/aicodeking/pandacode',
  issues: 'https://github.com/aicodeking/pandacode/issues',
  releases: 'https://github.com/aicodeking/pandacode/releases',
  license: 'https://github.com/aicodeking/pandacode/blob/main/LICENSE',
  /** The browser preview's fallback; the app opens its bundled copy (tauri.conf.json resources). */
  notices: 'https://github.com/aicodeking/pandacode/blob/main/THIRD_PARTY_NOTICES.md',
} as const;

const link = (label: string, url: string) =>
  `<button type="button" class="secondary-button" data-action="open-url" data-url="${url}">${label}${icon('forward')}</button>`;

/** The About group: app version, license, updates from GitHub Releases, and links. */
export function aboutSettingsHtml(): string {
  return `<div class="settings-group settings-about" aria-labelledby="settings-about-heading">
    <div class="setting-row"><div><strong id="settings-about-heading">${t('About PandaCode')}</strong><small class="settings-about-version">${t('Version …')}</small></div></div>
    <div class="setting-row"><div><strong>${t('License')}</strong><small>${t('Open source (MIT-based). No account, no telemetry.')}</small></div><div class="settings-row-actions">${link(t('PandaCode License'), PROJECT_LINKS.license)}<button type="button" class="secondary-button" data-about-notices>Third-party notices${icon('forward')}</button></div></div>
    <div class="setting-row settings-updates"><div><strong>${t('Updates')}</strong><small class="settings-update-status" aria-live="polite">${t('Checks GitHub Releases automatically.')}</small></div><div class="settings-row-actions"><button type="button" class="secondary-button settings-update-action" hidden></button>${link(t('Releases'), PROJECT_LINKS.releases)}</div></div>
    <div class="setting-row settings-updates-auto"><div><strong>${t('Update mode')}</strong><small>${t('Automatic restarts when no agent is working; Notify me asks first.')}</small></div><select class="settings-select" data-update-mode aria-label="${t('Update mode')}"><option value="automatic">${t('Automatic')}</option><option value="notify">${t('Notify me')}</option><option value="off">${t('Off')}</option></select></div>
    <div class="setting-row"><div><strong>${t('Source code')}</strong><small>${t('Report bugs and follow development.')}</small></div><div class="settings-row-actions">${link(t('GitHub repository'), PROJECT_LINKS.repository)}${link(t('Issues'), PROJECT_LINKS.issues)}</div></div>
  </div>`;
}

/** Reads the bundle version from Tauri; the browser preview has no app bundle. */
async function appVersion(): Promise<string> {
  if (preview) return t('Preview');
