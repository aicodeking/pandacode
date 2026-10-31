import './settings.css';
import { mountProviderReadiness } from './provider-readiness';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import { providerLogo } from './provider-logos';
import { uiSizeControls } from './ui-size';
import type { Project, Provider, ProviderId } from './types';
import { mountOverlaySettings } from './overlay-settings';
import { mountSupportDetails } from './support-settings';
import { aboutSettingsHtml, mountAboutSettings } from './about-settings';
import { mountResourceUsage, resourceUsageHtml } from './resource-usage-settings';
import { colorsSummary } from './theme-settings';
import { mountModelRouting } from './model-routing';
import { mountAgentTeams, type AgentTeamsOptions } from './agent-teams';
import { mountCloudSettings, type CloudSettingsHost } from './cloud-settings';
import { mountSkillsLibrary, type SkillsLibraryHost } from './skills-library';
import { call, subscribe } from './bridge';
import { mount as mountCapabilities } from './capabilities-panel';
import { mountRemoteSettings } from './remote-settings';
import { mountSchedulesSettings } from './schedules-settings';
import type { RemoteHost } from './remote-types';
import type { AgentsDockPreferences } from './agents-dock';

/** Panels that live elsewhere and are embedded here: each mounts into a host and returns its cleanup. */
type Embed = (host: HTMLElement) => Promise<() => void>;

export type SettingsSection = 'general' | 'appearance' | 'agents' | 'providers' | 'teams' | 'schedules' | 'tools' | 'skills' | 'cloud' | 'remote' | 'github' | 'about';

interface SettingsOptions {
  providers: Provider[];
  defaultProvider: ProviderId;
  defaultModel: string;
  activityExpanded: boolean;
  compact: boolean;
  wallpapers: boolean;
  theme: 'light' | 'dark';
  preview: boolean;
  /** Runs the checkout's fast check after a clean turn and queues one repair on failure. */
  turnChecks: boolean;
  section?: SettingsSection;
  discover(): Promise<Provider[]>;
  /** Mounts the optional GitHub row; returns its cleanup. */
  github?(host: HTMLElement): () => void;
  /** Projects listed under General; remove() rejects with the native refusal text. */
  projects?: { list(): Project[]; remove(id: string): Promise<void> };
  /** Named agent teams and the classic Team setup switch. */
  teams?: Omit<AgentTeamsOptions, 'providers'>;
  /** Settings → Schedules: an optional editor intent, and how a row opens its thread. */
  schedules?: { intent?: { newForSession?: string; editScheduleId?: string }; openThread(sessionId: string): void };
  /** Cloud sandbox connections (Daytona, Cloudflare, AWS). */
  cloud?: CloudSettingsHost;
  /** Skills library and rules registry. */
  skills?: SkillsLibraryHost;
  /** PandaCode Connect: sign-in, remote control and devices. */
  remote?: RemoteHost;
  embed: { colors: Embed; wallpapers: Embed; providerConnections: Embed; openCodeModels: Embed; harnessPrivacy: Embed };
  /** Leaves Settings for the workspace. */
  close(): void;
}
export interface SettingsView { show(section: SettingsSection): void; dispose(): void }

/** The groups in the left column, in order. Each names what it holds, not a vague umbrella. */
export const SECTIONS: { id: SettingsSection; label: string; icon: string; description: string }[] = [
  { id: 'general', label: 'General', icon: 'settings', description: 'Text size, conversation density and the quick launcher.' },
  { id: 'appearance', label: 'Appearance', icon: 'sun', description: 'Theme, accent colors and wallpapers.' },
  { id: 'agents', label: 'Agents', icon: 'bot', description: 'Your default agent and the agent harnesses installed on this computer.' },
  { id: 'providers', label: 'Providers', icon: 'lock', description: 'Sign-ins, API keys and plans such as GLM Coding Plan and MiMo Token Plan, each for the agent it belongs to.' },
  { id: 'teams', label: 'Agent teams', icon: 'grid', description: 'Named teams of models, and the classic team setup.' },
  { id: 'schedules', label: 'Schedules', icon: 'clock', description: 'Wake-ups and timed messages from you and your agents.' },
  { id: 'tools', label: 'Tools & add-ons', icon: 'terminal', description: 'App tools, MCP servers, skills and Jev.' },
  { id: 'skills', label: 'Skills & rules', icon: 'widget', description: 'Import skills and rules once, turn them on per harness, and check for drift.' },
  { id: 'cloud', label: 'Cloud sandboxes', icon: 'server', description: 'Daytona, Cloudflare and AWS machines for your agents.' },
  { id: 'remote', label: 'Remote access', icon: 'globe', description: 'Reach your other computers with PandaCode Connect, end-to-end encrypted.' },
  { id: 'github', label: 'GitHub', icon: 'github', description: 'Issues, pull requests and repositories through the GitHub CLI.' },
  { id: 'about', label: 'About & updates', icon: 'info', description: 'Version, updates, resource usage, license and support.' },
];

/** Key-based plans that run through Claude Code; they are set up under Providers, not listed as agents. */
const PLANS = new Set<ProviderId>(['glm', 'mimo']);

const LONG_DETAIL = 80;
const switchRow = (id: string, title: string, detail: string, checked: boolean) =>
  `<div class="setting-row"><div><strong>${title}${detail.length > LONG_DETAIL ? ` ${infoMark(detail)}` : ''}</strong>${detail.length > LONG_DETAIL ? '' : `<small>${detail}</small>`}</div><input type="checkbox" class="settings-switch" id="${id}" aria-label="${title}" ${checked ? 'checked' : ''}></div>`;

function mountAgentsDockSettings(host: HTMLElement): () => void {
  let disposed = false;
  let preferences: AgentsDockPreferences = { enabled: true, keepOnScreen: true, pinned: false };
  let error = '';
  let unsubscribe: (() => void) | undefined;
  // Disabling a focused switch while saving blurs it, so the change handler remembers it.
  let refocus = '';
  const draw = () => {
    if (disposed) return;
    const active = document.activeElement;
    const focused = refocus || (active instanceof HTMLElement && host.contains(active) ? active.id : '');
    refocus = '';
    host.innerHTML = `<div class="settings-group">${switchRow('agents-dock-enabled', 'Running agents widget', 'Show the live header widget. Turning this off also closes the pinned window.', preferences.enabled)}${switchRow('agents-dock-keep-on-screen', 'Keep pinned widget on screen', 'Keep the floating widget inside the current display when it expands.', preferences.keepOnScreen)}${error ? `<small class="settings-embed-error" role="alert">${escape(error)}</small>` : ''}</div>`;
    if (focused) host.querySelector<HTMLElement>(`#${focused}`)?.focus({ preventScroll: true });
  };
  const change = async (event: Event) => {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    if (!target || !['agents-dock-enabled', 'agents-dock-keep-on-screen'].includes(target.id)) return;
    const next = {
      enabled: target.id === 'agents-dock-enabled' ? target.checked : preferences.enabled,
      keepOnScreen: target.id === 'agents-dock-keep-on-screen' ? target.checked : preferences.keepOnScreen,
    };
    refocus = target.id;
    host.querySelectorAll<HTMLInputElement>('.settings-switch').forEach(input => { input.disabled = true; });
    try {
      preferences = { ...preferences, ...await call<AgentsDockPreferences>('agents_dock_save_preferences', next) };
      error = '';
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    draw();
  };
  host.addEventListener('change', change);
  void call<AgentsDockPreferences>('agents_dock_preferences').then(value => {
    if (!disposed) { preferences = { ...preferences, ...value }; draw(); }
  }).catch(() => undefined);
  const subscribeDockEvent = subscribe as unknown as <T>(name: string, callback: (event: T) => void) => Promise<() => void>;
  void subscribeDockEvent<Partial<AgentsDockPreferences>>('agents-dock-preferences-changed', value => {
    if (!disposed) { preferences = { ...preferences, ...value }; draw(); }
  }).then(cleanup => { if (disposed) cleanup(); else unsubscribe = cleanup; }).catch(() => undefined);
  draw();
  return () => {
    disposed = true;
    unsubscribe?.();
    host.removeEventListener('change', change);
    host.replaceChildren();
  };
}

function sectionHtml(id: SettingsSection, options: SettingsOptions): string {
  const defaultName = options.providers.find(provider => provider.id === options.defaultProvider)?.name ?? options.defaultProvider;
  switch (id) {
    case 'general': return `<div class="settings-group">${uiSizeControls()}${switchRow('compact-mode', 'Compact conversation', 'Less space between messages.', options.compact)}${switchRow('expand-tool-activity', 'Expand tool activity', 'Show grouped activity expanded by default.', options.activityExpanded)}</div>
      <h3 class="settings-heading">Quick launcher</h3><div id="launcher-settings"></div><h3 class="settings-heading">Running agents widget</h3><div id="agents-dock-settings"></div>${options.projects ? '<h3 class="settings-heading">Projects</h3><div id="projects-settings" class="settings-group"></div>' : ''}`;
    case 'appearance': return `<div class="settings-group">
        <div class="setting-row"><div><strong>Theme</strong><small>${options.theme === 'dark' ? 'Dark' : 'Light'}. Imported VS Code themes keep their own.</small></div><button type="button" class="secondary-button" data-action="toggle-theme">${icon(options.theme === 'dark' ? 'sun' : 'moon')}Use ${options.theme === 'dark' ? 'light' : 'dark'}</button></div>
        <div class="setting-row"><div><strong>Daily wallpapers</strong><small>A new scene for each part of the day.</small></div><input type="checkbox" class="settings-switch" id="daily-wallpapers" aria-label="Daily wallpapers" ${options.wallpapers ? 'checked' : ''}></div>
      </div>
      <h3 class="settings-heading">Colors <small class="settings-colors-summary">${escape(colorsSummary())}</small></h3><div class="settings-embed" data-embed="colors"></div>
      <h3 class="settings-heading">Wallpapers</h3><div class="settings-embed" data-embed="wallpapers"></div>`;
    case 'agents': return `<div class="settings-group">
        <div class="setting-row settings-default-row"><div><strong>Default agent</strong><small>Used for new tasks.</small></div><button type="button" id="default-provider" class="settings-select" data-action="default-provider" aria-label="Default agent for new tasks" aria-haspopup="dialog" aria-expanded="false">${providerLogo(options.defaultProvider)}<span>${escape(defaultName)}</span>${icon('down')}</button></div>
        <div class="setting-row settings-default-row"><div><strong>Default model</strong><small>Used for new tasks.</small></div><button type="button" id="default-model" class="settings-select" data-action="default-model" aria-label="Default model for new tasks" aria-haspopup="dialog" aria-expanded="false"><span>${escape(options.defaultModel)}</span>${icon('down')}</button></div>
        <div class="setting-row"><div><strong>Agent updates</strong><small>Keep installed agents up to date.</small></div><button type="button" class="secondary-button" data-action="agent-updates" aria-haspopup="dialog">Check updates</button></div>
        ${switchRow('turn-checks', 'Project checks after turns', 'When a turn ends, runs the project’s own test or check command with your environment (your shell, PATH and credentials); a failure queues one fix.', options.turnChecks)}
      </div>
      <div class="settings-heading settings-agents-heading"><h3>Installed agents</h3><button type="button" class="settings-refresh">${icon('refresh')}Refresh agents</button></div>
      <div class="settings-provider-status" role="status" hidden></div>
      <div class="provider-diagnostics settings-group"></div>
      ${options.preview ? '<p class="settings-preview-note">Browser preview · sample agent availability.</p>' : ''}
      <h3 class="settings-heading">Privacy</h3><div class="settings-embed" data-embed="harnessPrivacy"></div>
      <h3 class="settings-heading">OpenCode models</h3><div class="settings-embed" data-embed="openCodeModels"></div>`;
    case 'providers': return '<div class="settings-embed" data-embed="providerConnections"></div>';
    case 'teams': return '<div id="agent-teams-settings"></div><div id="model-routing-settings"></div>';
    case 'tools': return `<div class="settings-group">
        <div class="setting-row"><div><strong>Tools & integrations</strong><small>App tools, MCP servers, and skills.</small></div><button type="button" class="secondary-button" data-action="agent-integrations">Manage</button></div>
        <div class="setting-row"><div><strong>Android emulator flags</strong><small>Extra launch flags for Android emulators: renderer, snapshots and networking.</small></div><button type="button" class="secondary-button" data-action="emulator-flags">Set flags</button></div>
        <div class="setting-row"><div><strong>Jev · Optional add-on</strong><small>Browser tests and decision assistance. Your agents work without it.</small></div><button type="button" class="secondary-button" data-action="jev-settings">Set up Jev</button></div>
      </div>
      <div id="capabilities-settings"></div>`;
    case 'schedules': return '<div id="schedules-settings"></div>';
    case 'skills': return '<div id="skills-library"></div>';
    case 'cloud': return '<div id="cloud-settings"></div>';
    case 'remote': return '<div id="remote-settings"></div>';
    case 'github': return '<div id="github-settings"></div>';
    case 'about': return `${aboutSettingsHtml()}${resourceUsageHtml()}
      <div class="settings-group settings-support"><div class="setting-row"><div><strong>Help & support</strong><small>Open an issue on GitHub.</small></div><button type="button" class="secondary-button" data-action="support">Open issues${icon('forward')}</button></div><details class="support-details"><summary>App details for support</summary><p>Only the app version, platform, and architecture. Nothing is sent automatically.</p><textarea aria-label="App details for support" rows="3" readonly spellcheck="false"></textarea><div class="support-details-actions"><button type="button" class="secondary-button support-copy" disabled>${icon('copy')}Copy app details</button><button type="button" class="secondary-button support-retry" hidden>Try again</button></div><p role="status" aria-live="polite"></p></details></div>`;
  }
}

/** Settings as a full page: groups on the left, the chosen group's settings on the right. */
export function mountSettings(host: HTMLElement, options: SettingsOptions): SettingsView {
  host.classList.add('settings-page-root');
  host.innerHTML = `<nav class="settings-nav" aria-label="Settings sections">
      <div class="settings-nav-head" data-tauri-drag-region><button type="button" class="settings-back" data-settings-close aria-label="Back to the workspace" title="Back (Esc)">${icon('back')}<span>Back</span></button></div>
      <h1 class="settings-nav-title" data-tauri-drag-region>Settings</h1>
      <div class="settings-nav-list" role="tablist" aria-orientation="vertical" aria-label="Settings">${SECTIONS.map(section => `<button type="button" role="tab" id="settings-tab-${section.id}" data-section="${section.id}" title="${section.label}" aria-controls="settings-panel-${section.id}" aria-selected="false" tabindex="-1">${icon(section.icon)}<span>${section.label}</span></button>`).join('')}</div>
    </nav>
    <div class="settings-content">${SECTIONS.map(section => `<section class="settings-panel" id="settings-panel-${section.id}" role="tabpanel" aria-labelledby="settings-tab-${section.id}" hidden><header class="settings-panel-head" data-tauri-drag-region><h2>${section.label}</h2><p>${section.description}</p></header><div class="settings-panel-body">${sectionHtml(section.id, options)}</div></section>`).join('')}</div>`;
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = new Map(SECTIONS.map(section => [section.id, host.querySelector<HTMLElement>(`#settings-panel-${section.id}`)!]));
  const cleanups: (() => void)[] = [];
  const mounted = new Set<SettingsSection>();
  let disposed = false;

  const list = host.querySelector<HTMLElement>('.provider-diagnostics')!;
  const refreshButton = host.querySelector<HTMLButtonElement>('.settings-refresh')!;
  const status = host.querySelector<HTMLElement>('.settings-provider-status')!;
  let pending = false, discovered = false;
  const readinessCleanup: (() => void)[] = [];
  const live = () => !disposed && host.isConnected && !host.hidden;

  function updateProviders(all: Provider[]): void {
    const providers = all.filter(provider => !PLANS.has(provider.id));
    const rows = new Map(Array.from(list.querySelectorAll<HTMLDetailsElement>('details')).map(row => [row.dataset.provider!, row]));
    for (const [index, provider] of providers.entries()) {
      let row = rows.get(provider.id);
      if (!row) {
        row = document.createElement('details');
        row.className = 'provider-diagnostic'; row.dataset.provider = provider.id;
        row.innerHTML = `<summary aria-label="${escape(provider.name)} details"><span class="provider-avatar ${provider.id}">${providerLogo(provider.id)}</span><strong></strong><span class="provider-availability"><span class="status-dot"></span><span class="settings-installed"></span></span>${icon('chevron')}</summary><div class="settings-provider-details"><span>Version</span><span class="settings-provider-version"></span><span>Location</span><code></code></div>`;
      }
      if (provider.id === 'antigravity' && !row.querySelector('.provider-readiness')) {
        const check = document.createElement('div');
        row.append(check); readinessCleanup.push(mountProviderReadiness(check));
      }
      row.querySelector('strong')!.textContent = provider.name;
      row.querySelector('summary')!.setAttribute('aria-label', `${provider.name} details, ${provider.installed ? 'Installed' : 'Not installed'}`);
      row.querySelector('.provider-availability')!.classList.toggle('available', provider.installed);
      row.querySelector('.settings-installed')!.textContent = provider.installed ? (provider.id === 'antigravity' ? 'ACP installed' : 'Installed') : 'Not installed';
      row.querySelector('.settings-provider-version')!.textContent = provider.version || 'Not reported';
      row.querySelector('code')!.textContent = provider.path || 'Install the agent, then refresh.';
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      rows.delete(provider.id);
    }
    rows.forEach(row => row.remove());
  }
  async function refresh(): Promise<void> {
    if (!live() || pending) return;
    pending = true; refreshButton.disabled = true;
    status.hidden = false; status.textContent = 'Checking agents…';
    try {
      const providers = await options.discover();
      if (!live()) return;
      updateProviders(providers); discovered = true;
      status.textContent = ''; status.hidden = true;
    } catch {
      if (!live()) return;
      status.textContent = 'Couldn’t check agents. Try refreshing again.';
    } finally { pending = false; if (live()) refreshButton.disabled = false; }
  }

  /** Projects: each row removes its project after an inline confirmation; the folder stays on disk. */
  function mountProjects(slot: HTMLElement, projects: NonNullable<SettingsOptions['projects']>): () => void {
    let confirming = '', error = '';
    const draw = () => {
      const rows = projects.list();
      slot.innerHTML = rows.length ? rows.map(project => confirming === project.id
        ? `<div class="setting-row project-row" data-project="${escape(project.id)}"><div><strong>Remove ${escape(project.name)}?</strong><small>Its tasks are removed from PandaCode. The folder stays on disk.</small>${error ? `<small class="settings-embed-error" role="alert">${escape(error)}</small>` : ''}</div><div class="project-row-actions"><button type="button" class="secondary-button" data-project-cancel>Cancel</button><button type="button" class="secondary-button" data-project-confirm>Remove project</button></div></div>`
        : `<div class="setting-row project-row" data-project="${escape(project.id)}"><div><strong>${escape(project.name)}</strong><small class="project-path">${escape(project.path)}</small></div><button type="button" class="secondary-button" data-project-remove aria-label="Remove ${escape(project.name)}">Remove</button></div>`).join('')
        : '<div class="setting-row"><div><small>No projects yet.</small></div></div>';
    };
    const onClick = async (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const id = target?.closest<HTMLElement>('[data-project]')?.dataset.project;
      if (!target || !id) return;
      if (target.closest('[data-project-remove]')) { confirming = id; error = ''; draw(); }
      else if (target.closest('[data-project-cancel]')) { confirming = ''; error = ''; draw(); }
      else if (target.closest('[data-project-confirm]')) {
        const button = target.closest<HTMLButtonElement>('button')!;
        button.disabled = true;
        try { await projects.remove(id); confirming = ''; error = ''; }
        catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        if (live()) draw();
      }
    };
    slot.addEventListener('click', onClick); draw();
    return () => slot.removeEventListener('click', onClick);
  }

  /** A group's live parts mount the first time it opens, and stay mounted while Settings is open. */
  function mountSection(id: SettingsSection): void {
    if (mounted.has(id)) return;
    mounted.add(id);
    const panel = panels.get(id)!;
    if (id === 'general') {
      cleanups.push(mountOverlaySettings(panel.querySelector<HTMLElement>('#launcher-settings')!));
      cleanups.push(mountAgentsDockSettings(panel.querySelector<HTMLElement>('#agents-dock-settings')!));
    }
    if (id === 'remote' && options.remote) cleanups.push(mountRemoteSettings(panel.querySelector<HTMLElement>('#remote-settings')!, options.remote));
    if (id === 'general' && options.projects) cleanups.push(mountProjects(panel.querySelector<HTMLElement>('#projects-settings')!, options.projects));
    if (id === 'github' && options.github) cleanups.push(options.github(panel.querySelector<HTMLElement>('#github-settings')!));
    if (id === 'teams' && options.teams) cleanups.push(mountModelRouting(panel.querySelector<HTMLElement>('#model-routing-settings')!, { ...options.teams, providers: options.providers }));
    if (id === 'teams' && options.teams) cleanups.push(mountAgentTeams(panel.querySelector<HTMLElement>('#agent-teams-settings')!, { ...options.teams, providers: options.providers }));
    if (id === 'schedules') cleanups.push(mountSchedulesSettings(panel.querySelector<HTMLElement>('#schedules-settings')!, options.schedules ?? { openThread: () => {} }));
    if (id === 'tools') cleanups.push(mountCapabilities(panel.querySelector<HTMLElement>('#capabilities-settings')!, call));
    if (id === 'skills' && options.skills) cleanups.push(mountSkillsLibrary(panel.querySelector<HTMLElement>('#skills-library')!, options.skills));
    if (id === 'cloud' && options.cloud) cleanups.push(mountCloudSettings(panel.querySelector<HTMLElement>('#cloud-settings')!, options.cloud));
    if (id === 'about') {
      cleanups.push(mountSupportDetails(panel.querySelector<HTMLDetailsElement>('.support-details')!));
      cleanups.push(mountAboutSettings(panel.querySelector<HTMLElement>('.settings-about')!));
      cleanups.push(mountResourceUsage(panel.querySelector<HTMLElement>('.settings-resources')!));
    }
    if (id === 'agents' && !discovered) void refresh();
    for (const slot of panel.querySelectorAll<HTMLElement>('[data-embed]')) {
      const embed = options.embed[slot.dataset.embed as keyof SettingsOptions['embed']];
      slot.innerHTML = '<p class="dialog-loading">Loading…</p>';
      embed(slot).then(cleanup => { if (disposed) cleanup(); else cleanups.push(cleanup); })
        .catch(() => { if (!disposed) slot.innerHTML = '<p class="settings-embed-error" role="alert">This section couldn’t load. Close Settings and try again.</p>'; });
    }
  }

  function show(id: SettingsSection, focus = false): void {
    if (disposed) return;
    tabs.forEach(tab => { const on = tab.dataset.section === id; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
    panels.forEach((panel, key) => { panel.hidden = key !== id; });
    mountSection(id);
    host.querySelector<HTMLElement>('.settings-content')!.scrollTop = 0;
    if (focus) tabs.find(tab => tab.dataset.section === id)?.focus({ preventScroll: true });
  }

  const click = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-section], [data-settings-close]') : null;
    if (!target || !host.contains(target)) return;
    if ('settingsClose' in target.dataset) { options.close(); return; }
    show(target.dataset.section as SettingsSection);
  };
  /** The group list moves like a native sidebar: arrow keys, Home and End. */
  const keydown = (event: KeyboardEvent) => {
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    show(tabs[next].dataset.section as SettingsSection, true);
  };
  updateProviders(options.providers);
  host.addEventListener('click', click);
  host.addEventListener('keydown', keydown);
  refreshButton.addEventListener('click', refresh);
  show(options.section ?? 'general', true);
  return {
    show: id => show(id, true),
    dispose: () => {
      if (disposed) return;
      disposed = true; readinessCleanup.forEach(cleanup => cleanup());
      cleanups.forEach(cleanup => cleanup());
      host.removeEventListener('click', click); host.removeEventListener('keydown', keydown);
      refreshButton.removeEventListener('click', refresh);
      host.replaceChildren(); host.classList.remove('settings-page-root');
    },
  };
}
