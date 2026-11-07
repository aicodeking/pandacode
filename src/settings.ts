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
import { mountModelRouting } from './model-routing';
import { mountAgentTeams, type AgentTeamsOptions } from './agent-teams';
import { mountCloudSettings, type CloudSettingsHost } from './cloud-settings';
import { mountSkillsLibrary, type SkillsLibraryHost } from './skills-library';
import { call, subscribe } from './bridge';
import { settleIn, trackSegment } from './motion';
import { mount as mountCapabilities } from './capabilities-panel';
import { mountRemoteSettings } from './remote-settings';
import { mountSchedulesSettings } from './schedules-settings';
import { appUpdates } from './app-updates';
import type { RemoteHost } from './remote-types';
import type { AgentsDockPreferences } from './agents-dock';
import { SECTIONS, type SettingsPage, type SettingsSection } from './settings-sections';
import { mountRecommended } from './recommended-settings';
import { enabled as turnChecksEnabled } from './turn-checks';

/** Panels that live elsewhere and are embedded here: each mounts into a host and returns its cleanup. */
type Embed = (host: HTMLElement) => Promise<() => void>;

export type { SettingsSection };

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

const sectionOf = (page: SettingsPage) => SECTIONS.find(section => section.pages.some(item => item.id === page))!;

/** Key-based plans that run through Claude Code; they are set up under Providers, not listed as agents. */
const PLANS = new Set<ProviderId>(['glm', 'mimo']);

/** A row: title, its control, then the info mark named after it (after the control in Tab order); the help's
 * text stays in the DOM for screen readers. */
const settingRow = (title: string, control: string, detail = '') =>
  `<div class="setting-row"><div><strong>${title}</strong>${detail ? `<span class="sr-only">${detail}</span>` : ''}</div>${control}${detail ? infoMark(detail, `About ${title}`) : ''}</div>`;
const switchRow = (id: string, title: string, detail: string, checked: boolean) =>
  settingRow(title, `<input type="checkbox" class="settings-switch" id="${id}" aria-label="${title}" ${checked ? 'checked' : ''}>`, detail);
/** A closed fold; what it holds mounts the first time it opens. */
const fold = (title: string, body: string) => `<details class="settings-fold"><summary><h3>${title}</h3>${icon('chevron')}</summary>${body}</details>`;

function mountAgentsDockSettings(host: HTMLElement): () => void {
  let disposed = false;
  let preferences: AgentsDockPreferences = { enabled: false, keepOnScreen: true, pinned: false };
  let error = '';
  let unsubscribe: (() => void) | undefined;
  // Disabling a focused switch while saving blurs it, so the change handler remembers it.
  let refocus = '';
  // The rows last drawn: a preferences load that changes nothing keeps them, so they are never
  // swapped out from under a reader (or a test measuring them) right after the tab opens.
  let drawn = '';
  const draw = () => {
    if (disposed) return;
    const active = document.activeElement;
    const focused = refocus || (active instanceof HTMLElement && host.contains(active) ? active.id : '');
    refocus = '';
    const markup = `<div class="settings-group">${switchRow('agents-dock-enabled', 'Running agents widget', 'Show every running agent from a button at the top right of the window. Turning this off also closes the pinned window.', preferences.enabled)}${preferences.enabled ? switchRow('agents-dock-keep-on-screen', 'Keep pinned widget on screen', 'Keep the floating widget inside the current display when it expands.', preferences.keepOnScreen) : ''}${error ? `<small class="settings-embed-error" role="alert">${escape(error)}</small>` : ''}</div>`;
    if (markup === drawn) return;
    drawn = markup;
    host.innerHTML = markup;
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
    // The switches are disabled in place while saving, so the next draw must replace them.
    drawn = '';
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

function sectionHtml(id: SettingsPage, options: SettingsOptions): string {
  const defaultName = options.providers.find(provider => provider.id === options.defaultProvider)?.name ?? options.defaultProvider;
  switch (id) {
    case 'recommended': return '<div id="recommended-settings"></div>';
    case 'general': return `<div class="settings-group">${uiSizeControls()}${switchRow('compact-mode', 'Compact conversation', '', options.compact)}${switchRow('expand-tool-activity', 'Expand tool activity', '', options.activityExpanded)}</div>
      <h3 class="settings-heading">Quick launcher</h3><div id="launcher-settings"></div><h3 class="settings-heading">Running agents widget</h3><div id="agents-dock-settings"></div>${options.projects ? '<h3 class="settings-heading">Projects</h3><div id="projects-settings" class="settings-group"></div>' : ''}`;
    case 'appearance': return `<div class="settings-group">
        ${settingRow('Theme', `<button type="button" class="secondary-button" data-action="toggle-theme">${icon(options.theme === 'dark' ? 'sun' : 'moon')}Use ${options.theme === 'dark' ? 'light' : 'dark'}</button>`, 'Imported VS Code themes keep their own.')}
        ${switchRow('daily-wallpapers', 'Wallpapers', 'Off, the thread shows a live sky that follows the time of day.', options.wallpapers)}
      </div>
      <h3 class="settings-heading">Colors</h3><div class="settings-embed settings-colors" data-embed="colors"></div>
      <div class="settings-wallpapers" ${options.wallpapers ? '' : 'hidden'}><h3 class="settings-heading">Wallpapers</h3><div class="settings-embed" data-embed="wallpapers"></div></div>`;
    case 'agents': return `<div class="settings-group">
        <div class="setting-row settings-default-row"><div><strong>Default agent</strong></div><button type="button" id="default-provider" class="settings-select" data-action="default-provider" aria-label="Default agent for new tasks" aria-haspopup="dialog" aria-expanded="false">${providerLogo(options.defaultProvider)}<span>${escape(defaultName)}</span>${icon('down')}</button></div>
        <div class="setting-row settings-default-row"><div><strong>Default model</strong></div><button type="button" id="default-model" class="settings-select" data-action="default-model" aria-label="Default model for new tasks" aria-haspopup="dialog" aria-expanded="false"><span>${escape(options.defaultModel)}</span>${icon('down')}</button></div>
        <div class="setting-row"><div><strong>Agent updates</strong></div><button type="button" class="secondary-button" data-action="agent-updates" aria-haspopup="dialog">Check updates</button></div>
        ${switchRow('turn-checks', 'Project checks after turns', 'When a turn ends, runs the project’s own test or check command with your environment (your shell, PATH and credentials); a failure queues one fix.', options.turnChecks)}
      </div>
      <div class="settings-heading settings-agents-heading"><h3>Installed agents</h3><button type="button" class="settings-refresh" aria-label="Refresh agents" title="Refresh agents">${icon('refresh')}</button></div>
      <div class="settings-provider-status" role="status" hidden></div>
      <div class="provider-diagnostics settings-group"></div>
      ${options.preview ? '<p class="settings-preview-note">Browser preview · sample agent availability.</p>' : ''}
      ${fold('Advanced', '<h3 class="settings-heading">Privacy</h3><div class="settings-embed" data-embed="harnessPrivacy"></div><h3 class="settings-heading">OpenCode models</h3><div class="settings-embed" data-embed="openCodeModels"></div>')}`;
    case 'providers': return '<div class="settings-embed" data-embed="providerConnections"></div>';
    case 'teams': return '<div id="agent-teams-settings"></div>';
    case 'routing': return '<div id="model-routing-settings"></div>';
    case 'tools': return `<div class="settings-group">
        <div class="setting-row"><div><strong>Tools & integrations</strong></div><button type="button" class="secondary-button" data-action="agent-integrations">Manage</button></div>
        ${settingRow('Jev', '<button type="button" class="secondary-button" data-action="jev-settings">Set up Jev</button>', 'Optional add-on for browser tests and decision assistance. Your agents work without it.')}
      </div>
      ${fold('Capabilities and cache', '<div id="capabilities-settings"></div>')}`;
    case 'schedules': return '<div id="schedules-settings"></div>';
    case 'skills': return '<div id="skills-library"></div>';
    case 'cloud': return '<div id="cloud-settings"></div>';
    case 'remote': return '<div id="remote-settings"></div>';
    case 'github': return '<div id="github-settings"></div>';
    case 'about': return `${aboutSettingsHtml()}${resourceUsageHtml()}
      <div class="settings-group settings-support"><div class="setting-row"><div><strong>Help & support</strong></div><button type="button" class="secondary-button" data-action="support">Open issues${icon('forward')}</button></div><details class="support-details"><summary>App details for support${icon('chevron')}</summary><p>Only the app version, platform, and architecture. Nothing is sent automatically.</p><textarea aria-label="App details for support" rows="3" readonly spellcheck="false"></textarea><div class="support-details-actions"><button type="button" class="secondary-button support-copy" disabled>${icon('copy')}Copy app details</button><button type="button" class="secondary-button support-retry" hidden>Try again</button></div><p role="status" aria-live="polite"></p></details></div>`;
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
    <div class="settings-content">${SECTIONS.filter(section => section.pages.length > 1).map(section => `<div class="settings-subnav" data-section-pages="${section.id}" data-tauri-drag-region hidden><div class="ds-seg" role="tablist" aria-label="${section.label}">${section.pages.map(page => `<button type="button" role="tab" id="settings-subtab-${page.id}" data-section="${page.id}" aria-controls="settings-panel-${page.id}" aria-selected="false" tabindex="-1">${page.label}</button>`).join('')}</div></div>`).join('')}${SECTIONS.flatMap(section => section.pages.map(page => {
      const paged = section.pages.length > 1;
      return `<section class="settings-panel${paged ? ' settings-panel-paged' : ''}" id="settings-panel-${page.id}" role="tabpanel" aria-labelledby="${paged ? `settings-subtab-${page.id}` : `settings-tab-${section.id}`}" hidden><header class="settings-panel-head" data-tauri-drag-region><h2${paged ? ' class="sr-only"' : ''}>${page.label}</h2></header><div class="settings-panel-body">${sectionHtml(page.id, options)}</div></section>`;
    })).join('')}</div>`;
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('.settings-nav-list>[role="tab"]')];
  const subnavs = [...host.querySelectorAll<HTMLElement>('.settings-subnav')];
  const pageTabs = subnavs.flatMap(subnav => [...subnav.querySelectorAll<HTMLButtonElement>('[role="tab"]')]);
  const panels = new Map(SECTIONS.flatMap(section => section.pages).map(page => [page.id, host.querySelector<HTMLElement>(`#settings-panel-${page.id}`)!]));
  const cleanups: (() => void)[] = [];
  const mounted = new Set<SettingsPage>();
  let disposed = false;

  const list = host.querySelector<HTMLElement>('.provider-diagnostics')!;
  const refreshButton = host.querySelector<HTMLButtonElement>('.settings-refresh')!;
  const status = host.querySelector<HTMLElement>('.settings-provider-status')!;
  let pending = false, discovered = false;
  const readinessCleanup: (() => void)[] = [];
  const live = () => !disposed && host.isConnected && !host.hidden;

  let providersNow = options.providers;
  function updateProviders(all: Provider[]): void {
    providersNow = all;
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

  /** Each answer is local, and one that fails leaves its row without a status. */
  const askRecommended = async () => {
    const read = <T>(command: string, pick: (value: T) => boolean | undefined): Promise<boolean | null> => call<T>(command).then(value => pick(value) ?? null, () => null);
    const [telemetryOff, routingOn, connectSignedIn] = await Promise.all([
      read<{ off: boolean }>('harness_privacy', value => value.off),
      read<{ enabled: boolean }>('model_routing_status', value => value.enabled),
      read<{ signedIn: boolean }>('remote_status', value => value.signedIn),
    ]);
    return { telemetryOff, routingOn, connectSignedIn };
  };
  const knownRecommended = () => {
    const updates = appUpdates();
    return {
      agentInstalled: providersNow.some(provider => provider.installed && !PLANS.has(provider.id)),
      updateMode: updates?.supported ? updates.mode : null,
      telemetryOff: null, routingOn: null, connectSignedIn: null,
      turnChecks: turnChecksEnabled(),
    };
  };
  let recommended: ReturnType<typeof mountRecommended> | undefined;

  /** A group's live parts mount the first time it opens, and stay mounted while Settings is open. */
  function mountSection(id: SettingsPage): void {
    if (mounted.has(id)) return;
    mounted.add(id);
    const panel = panels.get(id)!;
    if (id === 'recommended') {
      recommended = mountRecommended(panel.querySelector<HTMLElement>('#recommended-settings')!, knownRecommended, askRecommended);
      cleanups.push(() => recommended?.dispose());
    }
    if (id === 'general') {
      cleanups.push(mountOverlaySettings(panel.querySelector<HTMLElement>('#launcher-settings')!));
      cleanups.push(mountAgentsDockSettings(panel.querySelector<HTMLElement>('#agents-dock-settings')!));
    }
    if (id === 'remote' && options.remote) cleanups.push(mountRemoteSettings(panel.querySelector<HTMLElement>('#remote-settings')!, options.remote));
    if (id === 'general' && options.projects) cleanups.push(mountProjects(panel.querySelector<HTMLElement>('#projects-settings')!, options.projects));
    if (id === 'github' && options.github) cleanups.push(options.github(panel.querySelector<HTMLElement>('#github-settings')!));
    if (id === 'routing' && options.teams) cleanups.push(mountModelRouting(panel.querySelector<HTMLElement>('#model-routing-settings')!, { ...options.teams, providers: options.providers }));
    if (id === 'teams' && options.teams) cleanups.push(mountAgentTeams(panel.querySelector<HTMLElement>('#agent-teams-settings')!, { ...options.teams, providers: options.providers }));
    if (id === 'schedules') cleanups.push(mountSchedulesSettings(panel.querySelector<HTMLElement>('#schedules-settings')!, options.schedules ?? { openThread: () => {} }));
    if (id === 'tools') {
      const slot = panel.querySelector<HTMLElement>('#capabilities-settings')!;
      slot.closest('details')!.addEventListener('toggle', () => cleanups.push(mountCapabilities(slot, call)), { once: true });
    }
    if (id === 'skills' && options.skills) cleanups.push(mountSkillsLibrary(panel.querySelector<HTMLElement>('#skills-library')!, options.skills));
    if (id === 'cloud' && options.cloud) cleanups.push(mountCloudSettings(panel.querySelector<HTMLElement>('#cloud-settings')!, options.cloud));
    if (id === 'about') {
      cleanups.push(mountSupportDetails(panel.querySelector<HTMLDetailsElement>('.support-details')!));
      cleanups.push(mountAboutSettings(panel.querySelector<HTMLElement>('.settings-about')!));
      cleanups.push(mountResourceUsage(panel.querySelector<HTMLElement>('.settings-resources')!));
    }
    if (id === 'agents' && !discovered) void refresh();
    for (const slot of panel.querySelectorAll<HTMLElement>('[data-embed]')) {
      const mount = () => {
        const embed = options.embed[slot.dataset.embed as keyof SettingsOptions['embed']];
        slot.innerHTML = '<p class="dialog-loading">Loading…</p>';
        embed(slot).then(cleanup => { if (disposed) cleanup(); else cleanups.push(cleanup); })
          .catch(() => { if (!disposed) slot.innerHTML = '<p class="settings-embed-error" role="alert">This section couldn’t load. Close Settings and try again.</p>'; });
      };
      const closed = slot.closest<HTMLDetailsElement>('details.settings-fold');
      if (closed) closed.addEventListener('toggle', mount, { once: true }); else mount();
    }
  }

  let shown: SettingsPage | undefined;
  function show(id: SettingsSection, focus = false): void {
    if (disposed) return;
    const page = id === 'connections' ? 'cloud' : id, section = sectionOf(page);
    tabs.forEach(tab => {
      const on = tab.dataset.section === section.id;
      tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
      if (on) tab.setAttribute('aria-controls', `settings-panel-${page}`);
    });
    pageTabs.forEach(tab => { const on = tab.dataset.section === page; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
    subnavs.forEach(subnav => { subnav.hidden = subnav.dataset.sectionPages !== section.id; });
    panels.forEach((panel, key) => { panel.hidden = key !== page; });
    if (page === 'recommended' && mounted.has(page)) recommended?.refresh();
    mountSection(page);
    const selected = pageTabs.find(tab => tab.dataset.section === page);
    if (selected) trackSegment(selected.parentElement!, selected);
    const content = host.querySelector<HTMLElement>('.settings-content')!;
    content.scrollTop = 0;
    // The first section settles with the page (main.ts); a change settles here, opacity only.
    if (shown && shown !== page) settleIn(content, 0);
    shown = page;
    if (focus) (selected && section.pages[0].id !== page ? selected : tabs.find(tab => tab.dataset.section === section.id))?.focus({ preventScroll: true });
  }

  const click = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-section], [data-settings-close]') : null;
    if (!target || !host.contains(target)) return;
    if ('settingsClose' in target.dataset) { options.close(); return; }
    // A recommendation's button goes away with its page, so focus moves to the page it opened.
    show(target.dataset.section as SettingsSection, Boolean(target.closest('#recommended-settings')));
    if (target.dataset.fold) {
      const fold = [...panels.get(target.dataset.section as SettingsPage)!.querySelectorAll<HTMLDetailsElement>('details.settings-fold')].find(item => item.querySelector('summary')?.textContent?.trim() === target.dataset.fold);
      if (fold) { fold.open = true; fold.scrollIntoView({ block: 'nearest' }); }
    }
  };
  /** The section list moves like a native sidebar and a section's pages like a segmented control: arrows, Home and End. */
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLButtonElement;
    const vertical = tabs.includes(target), group = vertical ? tabs : pageTabs.includes(target) ? pageTabs.filter(tab => tab.parentElement === target.parentElement) : [];
    const [back, forward] = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (!group.length || ![back, forward, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = group.indexOf(target);
    const next = group[event.key === 'Home' ? 0 : event.key === 'End' ? group.length - 1 : (index + (event.key === forward ? 1 : -1) + group.length) % group.length];
    show(next.dataset.section as SettingsSection);
    next.focus({ preventScroll: true });
  };
  /** An update waiting shows on the About row and its status line. */
  const updates = appUpdates();
  if (updates?.supported) {
    const about = tabs.find(tab => tab.dataset.section === 'about')!;
    const paint = () => {
      const kind = updates.state.kind;
      const tone = kind === 'available' || kind === 'ready' ? 'info' : kind === 'error' ? 'danger' : '';
      if (tone) host.dataset.updateTone = tone; else delete host.dataset.updateTone;
      about.title = tone === 'info' ? 'About · update available' : 'About';
    };
    cleanups.push(updates.subscribe(paint)); paint();
  }
  updateProviders(options.providers);
  host.addEventListener('click', click);
  host.addEventListener('keydown', keydown);
  refreshButton.addEventListener('click', refresh);
  show(options.section ?? 'recommended', true);
  return {
    show: id => show(id, true),
    dispose: () => {
      if (disposed) return;
      disposed = true; readinessCleanup.forEach(cleanup => cleanup());
      cleanups.forEach(cleanup => cleanup());
      host.removeEventListener('click', click); host.removeEventListener('keydown', keydown);
      refreshButton.removeEventListener('click', refresh);
      host.replaceChildren(); host.classList.remove('settings-page-root'); delete host.dataset.updateTone;
    },
  };
}
