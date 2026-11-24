import './settings.css';
import { mountSkillManager } from './skill-manager';
import type { SkillManagerHost } from './skill-manager-model';
import { mountProviderReadiness } from './provider-readiness';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import { providerLogo } from './provider-logos';
import { uiSizeControls } from './ui-size';
import type { Project, Provider, ProviderId } from './types';
import { mountOverlaySettings } from './overlay-settings';
import { mountVoiceSettings } from './voice-settings';
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
import { mountCustomTools } from './custom-tools-settings';
import { mountRemoteSettings } from './remote-settings';
import { mountSchedulesSettings } from './schedules-settings';
import { appUpdates } from './app-updates';
import type { RemoteHost } from './remote-types';
import type { AgentsDockPreferences } from './agents-dock';
import { SECTIONS, type SettingsPage, type SettingsSection } from './settings-sections';
import { mountRecommended } from './recommended-settings';
import { enabled as turnChecksEnabled } from './turn-checks';
import { crashRestartSettingsHtml, mountCrashRestartSettings, type KeepDrafts } from './crash-restart-settings';
import { setStillSkyEnabled, stillSkyEnabled } from './sky-window';

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
  /** True while this harness's version is still being probed: installed with no version, it says "Checking…". */
  versionPending?(id: Provider['id']): boolean;
  /** True until the real harness list has answered: rows are the last launch's, so none is called missing yet. */
  listPending?(): boolean;
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
  skills?: SkillsLibraryHost & Pick<SkillManagerHost, 'activeProject'>;
  /** PandaCode Connect: sign-in, remote control and devices. */
  remote?: RemoteHost;
  embed: { colors: Embed; wallpapers: Embed; providerConnections: Embed; openCodeModels: Embed; harnessPrivacy: Embed };
  /** Settings › General › Crash recovery: removes the saved composer drafts. */
  clearDrafts?(): void;
  /** Settings › General › Crash recovery: Keep unsent drafts. */
  keepDrafts?: KeepDrafts;
  /** Leaves Settings for the workspace. */
  close(): void;
}
export interface SettingsView {
  show(section: SettingsSection): void;
  /** Agents rows follow a changed harness list (versions reported later) in place: open rows stay open. */
  providersChanged(providers: Provider[]): void;
  dispose(): void;
}

const sectionOf = (page: SettingsPage) => SECTIONS.find(section => section.pages.some(item => item.id === page))!;

/** Key-based plans that run through Claude Code; they are set up under Providers, not listed as agents. */
const PLANS = new Set<ProviderId>(['glm', 'mimo', 'alibaba']);

/** A row: title, its control, then the info mark named after it (after the control in Tab order); the help's
 * text stays in the DOM for screen readers. */
const settingRow = (title: string, control: string, detail = '', status = false) =>
  `<div class="setting-row"><div><strong>${title}</strong>${detail ? `<span class="sr-only">${detail}</span>` : ''}${status ? '<small class="setting-status" hidden></small>' : ''}</div>${control}${detail ? infoMark(detail, `About ${title}`) : ''}</div>`;
/** \`native\` switches start disabled (until their value is read) and keep a status line for errors. */
const switchRow = (id: string, title: string, detail: string, checked: boolean, native = false) =>
  settingRow(title, `<input type="checkbox" class="settings-switch" id="${id}" aria-label="${title}" ${checked ? 'checked' : ''} ${native ? 'disabled' : ''}>`, detail, native);
/** A closed fold; what it holds mounts the first time it opens. */
const fold = (title: string, body: string) => `<details class="settings-fold"><summary><h3>${title}</h3>${icon('chevron')}</summary>${body}</details>`;

const UNREADABLE = 'Couldn’t read this setting.';
/** Settings → Agents switches read and saved natively, each as `<name>_enabled` /
 * `set_<name>_enabled`; the row's id and default hint. */
const NATIVE_SWITCHES = [
  { id: 'warm-spares', name: 'warm_spares', title: 'Warm Claude spares', hint: 'Skips Claude Code’s cold start between turns (~0.17–1.71 s; Turn off agent telemetry already removes ~1.5 s without idle processes). Keeps idle Claude Code processes ready (~195–255 MiB each on short sessions, sampled after 2–3.5 s idle; more with long histories or extra MCP servers; up to 4); each starts your MCP servers, runs SessionStart hooks early (unused spares are killed with SIGKILL, so SessionEnd hooks do not run) and makes Claude Code’s startup requests. Pauses automatically after repeated unused expiries, misses or evictions. Lead spares serve only teams whose workers are all read-only, such as Council reviews. Branch switches and commits start fresh; an ordinary spare’s uncommitted git status can be up to 10 min old.' },
  { id: 'worker-skills', name: 'worker_skills', title: 'Workers can use skills', hint: 'Applies to Claude Code, GLM, MiMo and Alibaba Token Plan team workers; off removes Skill next run.' },
  { id: 'worker-trim', name: 'worker_trim', title: 'Trim worker tools', hint: 'Fewer tools for team workers; no measured saving yet.' },
  { id: 'explore-tool', name: 'explore', title: 'Local code explorer (pandacode_explore)', hint: 'Next run. On for Claude Code unless Claude read rules withhold it; opt-in harnesses below don’t parse harness deny rules.' },
] as const;
/** The explorer's harnesses (`providers::explore_name`): Claude Code is on by default, each other
 * one opts in with its own switch, stored natively as an `explore-on-<provider>` marker. */
const EXPLORE_HARNESSES: { id: ProviderId; name: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'glm', name: 'GLM' }, { id: 'mimo', name: 'MiMo' }, { id: 'alibaba', name: 'Alibaba Token Plan' }, { id: 'codex', name: 'Codex' },
  { id: 'kimi', name: 'Kimi Code' }, { id: 'opencode', name: 'OpenCode' }, { id: 'pi', name: 'Pi' }, { id: 'omp', name: 'Oh My Pi' }, { id: 'grok', name: 'Grok Build' },
];
const exploreHarnessRow = ({ id, name }: { id: ProviderId; name: string }) => {
  const hint = id === 'claude' ? 'On by default while the switch above is on.' : 'Off by default: not measured. Takes effect while the switch above is on.';
  return settingRow(`Explorer · ${name}`, `<input type="checkbox" class="settings-switch" id="explore-${id}" aria-label="Local code explorer for ${name}" disabled>`, hint, true);
};
/** Settings → Tools & add-ons → Agent-made tools: opt-in, off by default. */
const CUSTOM_TOOLS_SWITCH = { id: 'custom-tools-enabled', name: 'custom_tools', title: 'Agent-made tools', hint: 'Agents save and run project scripts. Off by default: no measured gain.' } as const;

/** One warm pool's totals since launch (`warm_spare_stats`, `providers/warm/stats.rs`). */
type WarmPoolStats = {
  started: number; adopted: number; missed: number; expired: number; evicted: number;
  replaced: number; discarded: number; coldWithoutSpare: number; churnSkipped: number;
};
type WarmStatsSnapshot = { ordinary: WarmPoolStats; lead: WarmPoolStats };

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** This launch's spare adoption: the ordinary pool first, then the lead pool on its own, so a lead
 * miss is never counted as an ordinary one. Adoption shows against spares started, and unused
 * expiries, evictions, replacements, discards and churn pauses are named, so waste never reads as zero.
 * Dock and Finder launches keep no stderr. */
function warmStatsCaption(snapshot: WarmStatsSnapshot): string {
  const pool = (stats: WarmPoolStats | undefined) => ({
    started: count(stats?.started), adopted: count(stats?.adopted), missed: count(stats?.missed),
    expired: count(stats?.expired), evicted: count(stats?.evicted), replaced: count(stats?.replaced),
    discarded: count(stats?.discarded),
    cold: count(stats?.coldWithoutSpare), churnSkipped: count(stats?.churnSkipped),
  });
  const ordinary = pool(snapshot?.ordinary), lead = pool(snapshot?.lead);
  if (ordinary.started === 0 && ordinary.cold === 0 && lead.started === 0 && lead.cold === 0) return 'This launch: no spares started yet.';
  const formatPool = (p: ReturnType<typeof pool>, prefix = '') => {
    const parts = [
      p.started > 0 ? `${p.adopted}/${p.started} adopted` : '',
      p.missed > 0 ? `${p.missed} not used` : '',
      p.expired > 0 ? `${p.expired} expired` : '',
      p.evicted > 0 ? `${p.evicted} evicted` : '',
      p.replaced > 0 ? `${p.replaced} replaced` : '',
      p.discarded > 0 ? `${p.discarded} discarded` : '',
      p.cold > 0 ? `${p.cold} cold` : '',
      p.churnSkipped > 0 ? `${p.churnSkipped} paused` : '',
    ].filter(Boolean);
    if (!parts.length) return '';
    return prefix ? `${prefix} ${parts.join(', ')}` : parts.join(', ');
  };
  return `This launch: ${[formatPool(ordinary), formatPool(lead, 'lead')].filter(Boolean).join(' · ')}`;
}

const warmStatsLine = async () => warmStatsCaption(await call<WarmStatsSnapshot>('warm_spare_stats'));

// IDs distinguish harnesses and keep a reopened Settings view behind any unfinished save.
const nativeSwitchSaves = new Map<string, Promise<void>>();

/** One native switch: disabled until read, so an unreadable value is never shown; read at each
 * run, so it needs nothing from the window; a refused save puts the switch back and says why.
 * An optional \`caption\` fills the status line while no error shows, read at mount and after
 * each save; failing, it shows nothing. */
function mountNativeSwitch(panel: HTMLElement, { id, name, args = {}, locked = false, caption: readCaption }: { id: string; name: string; hint?: string; args?: Record<string, unknown>; locked?: boolean; caption?: () => Promise<string> }): () => void {
  const input = panel.querySelector<HTMLInputElement>(`#${id}`)!;
  let disposed = false;
  // The hint sits behind the title's mark; the row's status line shows an error, else the caption.
  const status = input.closest('.setting-row')!.querySelector<HTMLElement>('.setting-status')!;
  let caption = '';
  let error: { message: string; alert: boolean } | null = null;
  const render = () => {
    const message = error?.message || caption;
    status.textContent = message;
    status.hidden = !message;
    if (error?.alert) status.setAttribute('role', 'alert'); else status.removeAttribute('role');
  };
  const say = (message: string, alert = false) => { error = message ? { message, alert } : null; render(); };
  // Read at mount and again after every save (turning spares off changes the totals); only the
  // newest read lands, and an error on the line always outranks it.
  let captionReads = 0;
  const refreshCaption = () => {
    if (!readCaption) return;
    const read = ++captionReads;
    void readCaption().then(text => { if (!disposed && read === captionReads) { caption = text; render(); } }, () => {});
  };
  refreshCaption();
  input.setAttribute('aria-busy', 'true');
  void (async () => {
    try {
      await nativeSwitchSaves.get(id);
      const on = await call<boolean>(`${name}_enabled`, args);
      if (!disposed) { input.checked = on === true; input.disabled = locked; }
    } catch {
      if (!disposed) say(UNREADABLE);
    } finally {
      if (!disposed) input.removeAttribute('aria-busy');
    }
  })();
  const change = (event: Event) => {
    if (event.target !== input || input.disabled || nativeSwitchSaves.has(id)) return;
    const on = input.checked;
    const focused = document.activeElement === input;
    input.disabled = true;
    input.setAttribute('aria-busy', 'true');
    say('');
    const save = call<void>(`set_${name}_enabled`, { ...args, enabled: on }).catch(error => {
      if (!disposed) { input.checked = !on; say(error instanceof Error ? error.message : String(error), true); }
    }).finally(() => {
      nativeSwitchSaves.delete(id);
      if (disposed) return;
      refreshCaption();
      input.disabled = locked;
      input.removeAttribute('aria-busy');
      if (focused && (document.activeElement === document.body || document.activeElement === input)) input.focus({ preventScroll: true });
    });
    nativeSwitchSaves.set(id, save);
  };
  panel.addEventListener('change', change);
  return () => { disposed = true; panel.removeEventListener('change', change); };
}

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
    case 'voice': return '<div id="voice-settings"></div>';
    case 'general': return `<div class="settings-group">${uiSizeControls()}${switchRow('compact-mode', 'Compact conversation', '', options.compact)}${switchRow('expand-tool-activity', 'Expand tool activity', '', options.activityExpanded)}</div>
      <h3 class="settings-heading">Quick launcher</h3><div id="launcher-settings"></div><h3 class="settings-heading">Running agents widget</h3><div id="agents-dock-settings"></div><h3 class="settings-heading">Crash recovery</h3>${crashRestartSettingsHtml()}${options.projects ? '<h3 class="settings-heading">Projects</h3><div id="projects-settings" class="settings-group"></div>' : ''}`;
    case 'appearance': return `<div class="settings-group">
        ${settingRow('Theme', `<button type="button" class="secondary-button" data-action="toggle-theme">${icon(options.theme === 'dark' ? 'sun' : 'moon')}Use ${options.theme === 'dark' ? 'light' : 'dark'}</button>`, 'Imported VS Code themes keep their own.')}
        ${switchRow('daily-wallpapers', 'Wallpapers', 'Off, the thread shows a live sky that follows the time of day.', options.wallpapers)}
        ${switchRow('still-sky', 'Still sky', 'Keep the live sky as a still frame without animating clouds or pointer motion.', stillSkyEnabled())}
      </div>
      <h3 class="settings-heading">Colors</h3><div class="settings-embed settings-colors" data-embed="colors"></div>
      <div class="settings-wallpapers" ${options.wallpapers ? '' : 'hidden'}><h3 class="settings-heading">Wallpapers</h3><div class="settings-embed" data-embed="wallpapers"></div></div>`;
    case 'agents': return `<div class="settings-group">
        <div class="setting-row settings-default-row"><div><strong>Default agent</strong></div><button type="button" id="default-provider" class="settings-select" data-action="default-provider" aria-label="Default agent for new tasks" aria-haspopup="dialog" aria-expanded="false">${providerLogo(options.defaultProvider)}<span>${escape(defaultName)}</span>${icon('down')}</button></div>
        <div class="setting-row settings-default-row"><div><strong>Default model</strong></div><button type="button" id="default-model" class="settings-select" data-action="default-model" aria-label="Default model for new tasks" aria-haspopup="dialog" aria-expanded="false"><span>${escape(options.defaultModel)}</span>${icon('down')}</button></div>
        <div class="setting-row"><div><strong>Agent updates</strong></div><button type="button" class="secondary-button" data-action="agent-updates" aria-haspopup="dialog">Check updates</button></div>
        ${switchRow('turn-checks', 'Project checks after turns', 'When a turn ends, runs the project’s own test or check command with your environment (your shell, PATH and credentials); a failure queues one fix.', options.turnChecks)}
        ${NATIVE_SWITCHES.map(row => switchRow(row.id, row.title, row.hint, false, true)).join('')}
        ${EXPLORE_HARNESSES.map(exploreHarnessRow).join('')}
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
        ${switchRow(CUSTOM_TOOLS_SWITCH.id, CUSTOM_TOOLS_SWITCH.title, CUSTOM_TOOLS_SWITCH.hint, false, true)}
      </div>
      <div id="custom-tools-settings"></div>
      ${fold('Capabilities and cache', '<div id="capabilities-settings"></div>')}`;
    case 'schedules': return '<div id="schedules-settings"></div>';
    case 'skills': return '<div id="skill-manager"></div>';
    case 'rules': return '<div id="skills-library"></div>';
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
      // `providers.rs` reports "ACP" only for the standalone server binary; an `agy` CLI that
      // answers no version reports "", so it reads as any other installed agent.
      const antigravityAcpOnly = provider.id === 'antigravity' && provider.version.trim() === 'ACP';
      row.querySelector('.settings-installed')!.textContent = provider.installed ? (antigravityAcpOnly ? 'ACP installed' : 'Installed') : 'Not installed';
      // The last launch's installed harness, before the real list answers: pending, never "Install the agent".
      const listing = provider.installed && !provider.path && Boolean(options.listPending?.());
      const version = row.querySelector('.settings-provider-version')!;
      const versionText = provider.version || (provider.installed && (listing || options.versionPending?.(provider.id)) ? 'Checking…' : 'Not reported');
      if (version.textContent !== versionText) version.textContent = versionText;
      const location = row.querySelector('code')!, locationText = provider.path || (listing ? 'Checking…' : 'Install the agent, then refresh.');
      if (location.textContent !== locationText) location.textContent = locationText;
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
  let routingCleanup: (() => void) | undefined;
  let routingKey = '';
  let teamsCleanup: (() => void) | undefined;
  let teamsKey = '';
  const providerRosterKey = (all: Provider[]) => options.listPending?.()
    ? 'pending'
    : `ready:${all.map(p => `${p.id}:${p.installed ? 1 : 0}:${p.name}`).join('\n')}`;

  function mountRouting(): void {
    if (!options.teams || !mounted.has('routing')) return;
    const slot = panels.get('routing')!.querySelector<HTMLElement>('#model-routing-settings')!;
    const key = providerRosterKey(providersNow);
    if (key === 'pending') {
      if (!routingCleanup) slot.innerHTML = '<p class="dialog-loading">Loading…</p>';
      return;
    }
    if (routingCleanup && routingKey === key) return;
    routingCleanup?.();
    routingCleanup = mountModelRouting(slot, { ...options.teams, providers: providersNow });
    routingKey = key;
  }

  function mountTeams(): void {
    if (!options.teams || !mounted.has('teams')) return;
    const slot = panels.get('teams')!.querySelector<HTMLElement>('#agent-teams-settings')!;
    const key = providerRosterKey(providersNow);
    if (key === 'pending') {
      if (!teamsCleanup) slot.innerHTML = '<p class="dialog-loading">Loading…</p>';
      return;
    }
    if (teamsCleanup && teamsKey === key) return;
    // Keep an open team edit form intact until the editor closes or the tab is revisited.
    if (teamsCleanup && slot.querySelector('.agent-team-editor:not([hidden])')) return;
    teamsCleanup?.();
    teamsCleanup = mountAgentTeams(slot, { ...options.teams, providers: providersNow });
    teamsKey = key;
  }

  /** A group's live parts mount the first time it opens, and stay mounted while Settings is open. */
  function mountSection(id: SettingsPage): void {
    if (mounted.has(id)) return;
    mounted.add(id);
    const panel = panels.get(id)!;
    if (id === 'recommended') {
      recommended = mountRecommended(panel.querySelector<HTMLElement>('#recommended-settings')!, knownRecommended, askRecommended);
      cleanups.push(() => recommended?.dispose());
    }
    if (id === 'voice') cleanups.push(mountVoiceSettings(panel.querySelector<HTMLElement>('#voice-settings')!));
    if (id === 'appearance') {
      const stillSky = panel.querySelector<HTMLInputElement>('#still-sky')!;
      const row = stillSky.closest<HTMLElement>('.setting-row')!;
      const wallpapers = panel.querySelector<HTMLElement>('.settings-wallpapers')!;
      const syncVisibility = () => { row.hidden = !wallpapers.hidden; };
      const observer = new MutationObserver(syncVisibility);
      observer.observe(wallpapers, { attributes: true, attributeFilter: ['hidden'] });
      syncVisibility();
      cleanups.push(() => observer.disconnect());
      stillSky.addEventListener('change', () => setStillSkyEnabled(stillSky.checked));
    }
    if (id === 'general') {
      cleanups.push(mountOverlaySettings(panel.querySelector<HTMLElement>('#launcher-settings')!));
      cleanups.push(mountAgentsDockSettings(panel.querySelector<HTMLElement>('#agents-dock-settings')!));
      cleanups.push(mountCrashRestartSettings(panel.querySelector<HTMLElement>('#crash-restart-settings')!, options.clearDrafts, options.keepDrafts));
    }
    if (id === 'remote' && options.remote) cleanups.push(mountRemoteSettings(panel.querySelector<HTMLElement>('#remote-settings')!, options.remote));
    if (id === 'general' && options.projects) cleanups.push(mountProjects(panel.querySelector<HTMLElement>('#projects-settings')!, options.projects));
    if (id === 'github' && options.github) cleanups.push(options.github(panel.querySelector<HTMLElement>('#github-settings')!));
    if (id === 'routing' && options.teams) mountRouting();
    if (id === 'teams' && options.teams) mountTeams();
    if (id === 'schedules') cleanups.push(mountSchedulesSettings(panel.querySelector<HTMLElement>('#schedules-settings')!, options.schedules ?? { openThread: () => {} }));
    if (id === 'tools') cleanups.push(mountNativeSwitch(panel, CUSTOM_TOOLS_SWITCH));
    if (id === 'tools') cleanups.push(mountCustomTools(panel.querySelector<HTMLElement>('#custom-tools-settings')!, call, subscribe as (name: string, callback: () => void) => Promise<() => void>));
    if (id === 'tools') {
      const slot = panel.querySelector<HTMLElement>('#capabilities-settings')!;
      slot.closest('details')!.addEventListener('toggle', () => cleanups.push(mountCapabilities(slot, call)), { once: true });
    }
    if (id === 'skills' && options.skills) cleanups.push(mountSkillManager(panel.querySelector<HTMLElement>('#skill-manager')!, options.skills));
    if (id === 'rules' && options.skills) cleanups.push(mountSkillsLibrary(panel.querySelector<HTMLElement>('#skills-library')!, options.skills));
    if (id === 'cloud' && options.cloud) cleanups.push(mountCloudSettings(panel.querySelector<HTMLElement>('#cloud-settings')!, options.cloud));
    if (id === 'about') {
      cleanups.push(mountSupportDetails(panel.querySelector<HTMLDetailsElement>('.support-details')!));
      cleanups.push(mountAboutSettings(panel.querySelector<HTMLElement>('.settings-about')!));
      cleanups.push(mountResourceUsage(panel.querySelector<HTMLElement>('.settings-resources')!));
    }
    if (id === 'agents') cleanups.push(...NATIVE_SWITCHES.map(row => mountNativeSwitch(panel, row.id === 'warm-spares' ? { ...row, caption: warmStatsLine } : row)));
    if (id === 'agents') cleanups.push(...EXPLORE_HARNESSES.map(({ id: provider }) => mountNativeSwitch(panel, { id: `explore-${provider}`, name: 'explore_harness', hint: '', args: { provider }, locked: provider === 'claude' })));
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
    if (page === 'teams' && mounted.has(page)) mountTeams();
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
    providersChanged: providers => {
      if (disposed) return;
      updateProviders(providers);
      recommended?.refresh();
      mountRouting();
      mountTeams();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true; readinessCleanup.forEach(cleanup => cleanup());
      routingCleanup?.(); routingCleanup = undefined;
      teamsCleanup?.(); teamsCleanup = undefined;
      cleanups.forEach(cleanup => cleanup());
      host.removeEventListener('click', click); host.removeEventListener('keydown', keydown);
      refreshButton.removeEventListener('click', refresh);
      host.replaceChildren(); host.classList.remove('settings-page-root'); delete host.dataset.updateTone;
    },
  };
}
