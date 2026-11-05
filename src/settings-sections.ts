/** Settings' map, kept apart from settings.ts so the command palette can list pages without loading the page. */

export type SettingsPage = 'recommended' | 'general' | 'appearance' | 'agents' | 'providers' | 'teams' | 'routing' | 'schedules' | 'tools' | 'skills' | 'cloud' | 'remote' | 'github' | 'about';
/** A page id, or a section id that lands on the section's first page. */
export type SettingsSection = SettingsPage | 'connections';

/** The left column. A section with several pages shows them in a segmented control; every page keeps its old
 * id, so `show('providers')` and any older deep link land on it. Schedules stays its own section because it is
 * the one page of live work (runs, history, pause) rather than preferences. */
export const SECTIONS: { id: SettingsSection; label: string; icon: string; pages: { id: SettingsPage; label: string; keywords?: string }[] }[] = [
  { id: 'recommended', label: 'Recommended', icon: 'spark', pages: [{ id: 'recommended', label: 'Recommended', keywords: 'suggested suggestions setup checklist get started' }] },
  { id: 'general', label: 'General', icon: 'settings', pages: [{ id: 'general', label: 'General', keywords: 'interface size zoom text size font shortcut keyboard launcher density compact' }] },
  { id: 'appearance', label: 'Appearance', icon: 'sun', pages: [{ id: 'appearance', label: 'Appearance', keywords: 'wallpaper theme dark light accent color colour vsix vs code theme' }] },
  { id: 'agents', label: 'Agents', icon: 'bot', pages: [{ id: 'agents', label: 'Harnesses', keywords: 'install default agent harness cli' }, { id: 'providers', label: 'Providers', keywords: 'api key key sign in login log in env environment variables connection' }, { id: 'teams', label: 'Agent teams', keywords: 'team roster workers architect' }, { id: 'routing', label: 'Model routing', keywords: 'router panda router cheap balanced best quality' }] },
  { id: 'schedules', label: 'Schedules', icon: 'clock', pages: [{ id: 'schedules', label: 'Schedules', keywords: 'wake up wake-up timer timed message cron' }] },
  { id: 'tools', label: 'Tools', icon: 'terminal', pages: [{ id: 'tools', label: 'Add-ons', keywords: 'mcp integrations capabilities cache tools' }, { id: 'skills', label: 'Skills & rules', keywords: 'skill rule agents.md claude.md' }] },
  { id: 'connections', label: 'Connections', icon: 'globe', pages: [{ id: 'cloud', label: 'Cloud sandboxes', keywords: 'daytona docker podman aws ec2 agentcore cloudflare digitalocean vultr hetzner runpod vps vercel railway gcloud deploy cloud machine' }, { id: 'remote', label: 'Remote access', keywords: 'connect pandacode connect phone mobile iphone android remote control pair' }, { id: 'github', label: 'GitHub', keywords: 'gh token pull request issues' }] },
  { id: 'about', label: 'About', icon: 'info', pages: [{ id: 'about', label: 'About', keywords: 'updates update version license privacy' }] },
];
