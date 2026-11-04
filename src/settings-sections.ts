import { t } from './i18n.ts';
/** Settings' map, kept apart from settings.ts so the command palette can list pages without loading the page. */

export type SettingsPage = 'recommended' | 'general' | 'appearance' | 'agents' | 'providers' | 'teams' | 'routing' | 'schedules' | 'tools' | 'skills' | 'cloud' | 'remote' | 'github' | 'about';
/** A page id, or a section id that lands on the section's first page. */
export type SettingsSection = SettingsPage | 'connections';

/** The left column. A section with several pages shows them in a segmented control; every page keeps its old
 * id, so `show('providers')` and any older deep link land on it. Schedules stays its own section because it is
 * the one page of live work (runs, history, pause) rather than preferences. */
export const SECTIONS: { id: SettingsSection; label: string; icon: string; pages: { id: SettingsPage; label: string; keywords?: string }[] }[] = [
  { id: 'recommended', label: t('Recommended'), icon: 'spark', pages: [{ id: 'recommended', label: t('Recommended'), keywords: 'suggested suggestions setup checklist get started' }] },
  { id: 'general', label: t('General'), icon: 'settings', pages: [{ id: 'general', label: t('General'), keywords: 'interface size zoom text size font shortcut keyboard launcher density compact' }] },
  { id: 'appearance', label: t('Appearance'), icon: 'sun', pages: [{ id: 'appearance', label: t('Appearance'), keywords: 'wallpaper theme dark light accent color colour vsix vs code theme' }] },
  { id: 'agents', label: t('Agents'), icon: 'bot', pages: [{ id: 'agents', label: t('Harnesses'), keywords: 'install default agent harness cli' }, { id: 'providers', label: t('Providers'), keywords: 'api key key sign in login log in env environment variables connection' }, { id: 'teams', label: t('Agent teams'), keywords: 'team roster workers architect' }, { id: 'routing', label: t('Model routing'), keywords: 'router panda router cheap balanced best quality' }] },
  { id: 'schedules', label: t('Schedules'), icon: 'clock', pages: [{ id: 'schedules', label: t('Schedules'), keywords: 'wake up wake-up timer timed message cron' }] },
  { id: 'tools', label: t('Tools'), icon: 'terminal', pages: [{ id: 'tools', label: t('Add-ons'), keywords: 'mcp integrations capabilities cache tools' }, { id: 'skills', label: t('Skills & rules'), keywords: 'skill rule agents.md claude.md' }] },
  { id: 'connections', label: t('Connections'), icon: 'globe', pages: [{ id: 'cloud', label: t('Cloud sandboxes'), keywords: 'daytona docker podman aws ec2 agentcore cloudflare digitalocean vultr hetzner runpod vps vercel railway gcloud deploy cloud machine' }, { id: 'remote', label: t('Remote access'), keywords: 'connect pandacode connect phone mobile iphone android remote control pair' }, { id: 'github', label: t('GitHub'), keywords: 'gh token pull request issues' }] },
  { id: 'about', label: t('About'), icon: 'info', pages: [{ id: 'about', label: t('About'), keywords: 'updates update version license privacy' }] },
];
