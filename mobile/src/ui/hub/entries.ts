// The computer hub's rows: everything the phone can do on one computer, each shown only when the
// host serves it. Pure (tests/hub.test.ts): the screen passes in what the host supports.
import type { HostCapabilities } from '../../connect/api/hello.ts';
import type { Bot } from '../../connect/types.ts';
import { supports } from '../../connect/api/hello.ts';

export type HubSection = 'work' | 'project' | 'computer';

export interface HubEntry {
  key: string;
  title: string;
  subtitle: string;
  section: HubSection;
  icon: { ios: string; android: string };
  /** The method that must be served (or, as `feature:<group>`, a host.hello feature group). */
  needs: string;
  /** Needs a chosen project (Files, Search, Recipes, Run). */
  project?: boolean;
  pathname: string;
}

export const HUB_ENTRIES: readonly HubEntry[] = [
  { key: 'tasks', title: 'Tasks on this computer', subtitle: 'The inbox, filtered to this computer', section: 'work', icon: { ios: 'tray.full', android: 'inbox' }, needs: 'tasks.list', pathname: '/inbox' },
  { key: 'progress', title: 'Progress', subtitle: 'Snapshots agents posted', section: 'work', icon: { ios: 'photo.on.rectangle', android: 'photo_library' }, needs: 'progress.list', pathname: '/progress' },
  { key: 'checks', title: 'Checks', subtitle: "Run a task's fast check", section: 'work', icon: { ios: 'checkmark.shield', android: 'verified' }, needs: 'checks.plan', pathname: '/checks' },
  { key: 'board', title: 'Board', subtitle: 'Tasks by stage', section: 'work', icon: { ios: 'rectangle.split.3x1', android: 'view_kanban' }, needs: 'thread.setStage', pathname: '/board' },
  { key: 'schedules', title: 'Schedules', subtitle: 'Recurring tasks', section: 'work', icon: { ios: 'calendar.badge.clock', android: 'schedule' }, needs: 'schedules.list', pathname: '/schedules' },
  { key: 'github', title: 'GitHub', subtitle: 'Issues, pull requests and runs', section: 'work', icon: { ios: 'arrow.triangle.pull', android: 'merge' }, needs: 'github.repos', pathname: '/github' },
  { key: 'files', title: 'Files', subtitle: 'Browse the project', section: 'project', icon: { ios: 'folder', android: 'folder' }, needs: 'files.list', project: true, pathname: '/files' },
  { key: 'search', title: 'Search', subtitle: 'File names and text', section: 'project', icon: { ios: 'magnifyingglass', android: 'search' }, needs: 'files.search', project: true, pathname: '/search' },
  { key: 'recipes', title: 'Recipes', subtitle: 'Saved multi-step workflows', section: 'project', icon: { ios: 'list.bullet.rectangle', android: 'checklist' }, needs: 'recipes.list', project: true, pathname: '/recipes' },
  { key: 'designs', title: 'Designs', subtitle: 'Artboards and comments', section: 'project', icon: { ios: 'paintbrush.pointed', android: 'brush' }, needs: 'design.list', project: true, pathname: '/designs' },
  { key: 'moodboards', title: 'Moodboards', subtitle: 'Reference images for agents', section: 'project', icon: { ios: 'square.grid.2x2', android: 'dashboard' }, needs: 'moodboards.list', project: true, pathname: '/moodboards' },
  { key: 'servers', title: 'Run & servers', subtitle: 'Run script and local servers', section: 'project', icon: { ios: 'play.rectangle', android: 'play_circle' }, needs: 'runScript.get', project: true, pathname: '/servers' },
  { key: 'add-project', title: 'Add project', subtitle: 'Clone a GitHub repository', section: 'computer', icon: { ios: 'plus.rectangle.on.folder', android: 'create_new_folder' }, needs: 'projects.clone', pathname: '/add-project' },
  { key: 'skills', title: 'Skills', subtitle: 'Skills and rules per harness', section: 'computer', icon: { ios: 'sparkles', android: 'auto_awesome' }, needs: 'skills.list', pathname: '/skills' },
  { key: 'usage', title: 'Usage', subtitle: 'Tokens and limits', section: 'computer', icon: { ios: 'chart.bar', android: 'bar_chart' }, needs: 'usage.get', pathname: '/usage' },
  { key: 'terminal', title: 'Terminal', subtitle: 'A shell on this computer', section: 'computer', icon: { ios: 'terminal', android: 'terminal' }, needs: 'feature:terminal', pathname: '/terminal' },
  { key: 'machines', title: 'Machines', subtitle: 'Local VMs and cloud sandboxes', section: 'computer', icon: { ios: 'server.rack', android: 'dns' }, needs: 'feature:admin', pathname: '/machines' },
  { key: 'settings', title: 'Settings', subtitle: 'Harnesses, model routing and token saver', section: 'computer', icon: { ios: 'gearshape', android: 'settings' }, needs: 'settings.providers', pathname: '/computer-settings' },
];

export const SECTION_TITLES: Readonly<Record<HubSection, string>> = { work: 'Work', project: 'Project', computer: 'This computer' };

/** Whether the host offers `needs`: like useHostSupports, true while still unknown. */
export function offers(caps: HostCapabilities | undefined, needs: string): boolean {
  if (!caps) return true;
  if (needs.startsWith('feature:')) return caps.kind === 'hello' && caps.features.has(needs.slice('feature:'.length));
  return supports(caps, needs) ?? true;
}

/** The rows to show, by section in order; empty sections are left out. */
export function hubSections(caps: HostCapabilities | undefined): { section: HubSection; title: string; entries: HubEntry[] }[] {
  const shown = HUB_ENTRIES.filter(entry => offers(caps, entry.needs));
  return (['work', 'project', 'computer'] as const)
    .map(section => ({ section, title: SECTION_TITLES[section], entries: shown.filter(entry => entry.section === section) }))
    .filter(group => group.entries.length > 0);
}

/** Route params for an entry: the computer, and the chosen project for project tools. */
export function entryParams(entry: HubEntry, deviceId: string, projectId: string | null): Record<string, string> {
  if (entry.key === 'tasks') return { computer: deviceId };
  return entry.project && projectId ? { device: deviceId, project: projectId } : { device: deviceId };
}

/** The method a Bots row opens (bot-admin.tsx); the group shows only where the host serves it. */
export const BOT_DETAIL = 'bot.detail';

/** The hub's Bots group: this computer's bots (from bots.list) by name, each with its state, linking
 * to its settings (/bot-admin?device=&bot=). */
export function botRows(bots: readonly Bot[] | undefined): { id: string; title: string; subtitle: string; bot: Bot }[] {
  return [...(bots ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(bot => ({ id: bot.id, title: bot.name || 'Bot', subtitle: bot.paused ? 'Paused' : bot.state === 'working' ? 'Working' : 'Ready', bot }));
}

/** The app version line: "PandaCode 0.3.102", "Older PandaCode" or nothing until known. */
export function versionLine(caps: HostCapabilities | undefined): string {
  if (!caps) return '';
  if (caps.kind === 'legacy') return 'An older PandaCode: update it to use more from the phone';
  return caps.appVersion ? `PandaCode ${caps.appVersion}` : 'PandaCode';
}
