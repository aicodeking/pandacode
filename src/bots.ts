import './bots.css';
import './bots-settings.css';
import { escape, icon } from './dom';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { Provider, ProviderId, ProviderModel } from './types';
import { modelChoices } from './model-catalog';
import { connectInput, guideToggled } from './bots-connect';
import { avatarPicker, botAvatarHtml, handleAvatarPicker } from './bot-avatars';
import { renderPanel, panelClick, panelSubmit, panelChange, invalidateActivity, type PanelContext, type Tab } from './bots-panels';

export interface Bot {
  id: string; name: string; role: string; instructions: string; goals: string; avatar: string; projectId: string;
  provider: ProviderId; model: string; mode: string; heartbeatMinutes: number; nextHeartbeatAt: number | null;
  paused: boolean; memoryVersion: number; notifyChannelId: string | null; notifyThread: string | null; createdAt: number; updatedAt: number;
  /** The bot's conversation in this app, once it exists. */
  desktopSession?: string | null;
  /** The latest thing said in that conversation, flattened to one line. */
  lastMessage?: { role: 'user' | 'assistant'; text: string; at: number } | null;
}
export interface BotInput { name: string; role: string; instructions: string; goals: string; avatar: string; provider: ProviderId; model: string; mode: string; heartbeatMinutes: number; }
export interface Memory { id: string; content: string; source: 'user' | 'bot'; createdAt: number; }
export interface Schedule { id: string; botId: string; title: string; prompt: string; kind: 'once' | 'interval' | 'daily' | 'weekdays'; intervalMinutes: number | null; timeOfDay: string | null; nextRunAt: number | null; lastRunAt: number | null; enabled: boolean; createdBy: 'user' | 'bot'; createdAt: number; }
export type ChannelKind = 'web' | 'telegram' | 'slack' | 'discord' | 'whatsapp';
export interface Channel { id: string; botId: string; kind: ChannelKind; label: string; config: Record<string, unknown>; enabled: boolean; status: string; secrets: string[]; }
export interface Pairing { channelId: string; senderId: string; senderName: string; status: 'pending' | 'approved' | 'blocked'; code: string; createdAt: number; }
export interface Thread { channelId: string; externalId: string; sessionId: string; updatedAt: number; }
export interface Rule { id: string; pattern: string; decision: 'allow' | 'ask' | 'deny'; createdAt: number; }
export interface Activity { id: number; kind: string; summary: string; detail: Record<string, unknown>; at: number; }
export interface BotDetail { bot: Bot; memories: Memory[]; schedules: Schedule[]; channels: Channel[]; pairings: Pairing[]; threads: Thread[]; rules: Rule[]; serverPort: number; }

export interface BotsOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  providers: Provider[];
  defaultModel(provider: ProviderId): string;
  loadModels(provider: ProviderId): Promise<ProviderModel[]>;
  /** True while a task's agent is working. */
  running(sessionId: string): boolean;
  openTask(sessionId: string): void;
  /** Opens the bot's own conversation in the workspace, like any task. */
  openChat(botId: string): void;
  notify(text: string): void;
  /** Open on this bot, or on the New bot form. */
  initialBot?: string;
  startNew?: boolean;
  /** `settings`: one bot's settings, as a modal; `window`: every bot, with a list. */
  layout?: 'window' | 'settings';
  /** The settings section to open on. */
  initialTab?: Section;
  /** Settings layout: the bot was deleted, so the modal should close. */
  onDeleted?(): void;
}
export interface BotsView { dispose(): void; refresh(): void; agent(sessionId: string, kind: string): void; }
export type Section = Tab | 'profile';

/** The settings nav, like the app's own Settings. Activity also holds conversations and rules. */
type Nav = 'profile' | 'channels' | 'schedules' | 'memory' | 'activity';
const SECTIONS: { id: Nav; label: string; icon: string; text: string }[] = [
  { id: 'profile', label: 'Profile', icon: 'bot', text: 'Who the bot is, how it works and what runs it.' },
  { id: 'channels', label: 'Channels', icon: 'globe', text: 'Talk to it from a browser, Telegram, Slack, Discord or WhatsApp.' },
  { id: 'schedules', label: 'Schedules', icon: 'refresh', text: 'Recurring or one-off work the bot starts on its own.' },
  { id: 'memory', label: 'Memory', icon: 'leaf', text: 'Kept across conversations. The bot adds its own as it learns.' },
  { id: 'activity', label: 'Activity', icon: 'activity', text: 'Conversations, approval rules and everything the bot did.' },
];
const navFor = (section: Section): Nav => section === 'conversations' || section === 'rules' ? 'activity' : section;
/** One labelled row, like a Settings row: title and hint on the left, the control on the right. */
const row = (title: string, hint: string, control: string, stacked = false) => `<label class="bs-row ${stacked ? 'stacked' : ''}"><span class="bs-row-text"><strong>${title}</strong>${hint ? `<small>${escape(hint)}</small>` : ''}</span>${control}</label>`;
const heading = (title: string, more = '') => `<h3 class="bs-heading">${escape(title)}${more}</h3>`;
const MODES = [{ id: 'ask', label: 'Ask before acting' }, { id: 'auto', label: 'Auto-approve edits' }, { id: 'plan', label: 'Plan only' }, { id: 'full', label: 'Full access' }];
const providerModes = (provider: ProviderId) => provider === 'github-copilot' ? MODES.filter(mode => mode.id !== 'auto') : MODES;
const CHECK_INS = [{ minutes: 0, label: 'Off' }, { minutes: 30, label: 'Every 30 minutes' }, { minutes: 60, label: 'Every hour' }, { minutes: 180, label: 'Every 3 hours' }, { minutes: 360, label: 'Every 6 hours' }, { minutes: 1440, label: 'Once a day' }];

/** Starting points, in the spirit of the named bots this feature follows. */
export const TEMPLATES: { id: string; avatar: string; name: string; role: string; instructions: string; goals: string; heartbeatMinutes: number }[] = [
  { id: 'chief', avatar: 'panda:1', name: 'Chief of Staff', role: 'Keeps my week on track', instructions: 'Track my commitments and follow-ups. Summarize what changed since we last talked. Ask before sending anything on my behalf.', goals: 'Nothing I promised slips.\nI start each day knowing my top three priorities.', heartbeatMinutes: 360 },
  { id: 'research', avatar: 'panda:2', name: 'Researcher', role: 'Digs into questions and reports back', instructions: 'Research thoroughly using the web and local files. Cite sources with links. Lead with the answer, then the evidence.', goals: '', heartbeatMinutes: 0 },
  { id: 'oncall', avatar: 'panda:3', name: 'Dev On-call', role: 'Watches my projects and fixes small things', instructions: 'Work in this workspace. Before changing code, explain the plan. Run tests before saying something works.', goals: 'Keep the build green.\nTell me about failing tests or broken dependencies early.', heartbeatMinutes: 180 },
  { id: 'inbox', avatar: 'panda:4', name: 'Inbox Triage', role: 'Sorts what needs me from what does not', instructions: 'When I forward messages or notifications, sort them into: needs me today, can wait, ignore. Draft short replies for the first group but never send them yourself.', goals: 'I only look at what actually needs me.', heartbeatMinutes: 0 },
  { id: 'watch', avatar: 'panda:5', name: 'Watcher', role: 'Keeps an eye on things and tells me when they change', instructions: 'Check the sources I give you. Only message me when something meaningfully changed, with the before and after and a link.', goals: '', heartbeatMinutes: 60 },
  { id: 'blank', avatar: 'panda:0', name: '', role: '', instructions: '', goals: '', heartbeatMinutes: 0 },
];

export function age(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.round((at - now) / 60000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 1) return at > now ? 'in a moment' : 'just now';
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}
export function avatar(bot: Pick<Bot, 'avatar' | 'name'>, cls = ''): string { return botAvatarHtml(bot.avatar, bot.name, cls); }

export function mountBots(host: HTMLElement, options: BotsOptions): BotsView {
  let bots: Bot[] = [];
  let detail: BotDetail | null = null;
  let selected = options.initialBot ?? '';
  let section: Nav = navFor(options.initialTab ?? 'profile');
  let editing: 'new' | null = options.startNew ? 'new' : null;
  let template = TEMPLATES[0];
  let confirming: { title: string; text: string; button: string; action: () => Promise<void> } | null = null;
  let loading = true, busy = false, disposed = false, request = 0, moreOpen = false;
  let formModelGeneration = 0;
  const modelCatalogs = new Map<ProviderId, ProviderModel[]>();
  const modelCatalogRequests = new Map<ProviderId, Promise<ProviderModel[]>>();
  for (const provider of options.providers) if (provider.models.length) modelCatalogs.set(provider.id, provider.models);
  let error = '';
  const single = options.layout === 'settings';
  const installed = () => options.providers.filter(provider => provider.installed);
  host.classList.add('bots');
  host.classList.toggle('bots-single', single);
  host.innerHTML = single
    ? '<section class="bots-detail" aria-live="polite"></section>'
    : '<aside class="bots-list" aria-label="Bots"></aside><section class="bots-detail" aria-live="polite"></section>';
  const list = host.querySelector<HTMLElement>('.bots-list');
  const pane = host.querySelector<HTMLElement>('.bots-detail')!;

  const context: PanelContext = {
    call: options.call, notify: options.notify, openTask: id => options.openTask(id), running: options.running,
    detail: () => detail, reload: () => load(), rerender: () => render(),
    work: action => work(action),
    confirm: (title, text, button, action) => { confirming = { title, text, button, action }; render(); pane.querySelector<HTMLButtonElement>('.bots-confirm .secondary-button')?.focus(); },
  };

  async function load(): Promise<void> {
    const id = ++request;
    invalidateActivity();
    try {
      const next = await options.call<Bot[]>('bots_list');
      if (disposed || id !== request) return;
      bots = next;
      if (!bots.some(bot => bot.id === selected)) selected = single ? '' : bots[0]?.id ?? '';
      detail = selected ? await options.call<BotDetail>('bot_detail', { botId: selected }) : null;
      if (disposed || id !== request) return;
      if (!bots.length && !single) editing ??= 'new';
      // A background refresh keeps a message the user has not acted on yet; the next action clears it.
    } catch (cause) { error = message(cause); }
    loading = false;
    render();
  }
  async function work(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    busy = true; error = ''; host.setAttribute('aria-busy', 'true');
    try { await action(); } catch (cause) { error = message(cause); render(); } finally { busy = false; host.removeAttribute('aria-busy'); }
  }
  function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
  function working(bot: Bot): boolean { return bot.id === detail?.bot.id && detail.threads.some(thread => options.running(thread.sessionId)); }

  function botModelChoices(provider: ProviderId, catalog: ProviderModel[], selected: string): ProviderModel[] {
    const choices = modelChoices(provider, catalog, selected);
    return provider === 'github-copilot'
      ? choices.filter(model => model.id === 'default' || catalog.some(advertised => advertised.id === model.id))
      : choices;
  }
  function modelOptions(provider: ProviderId, catalog: ProviderModel[], selected: string): string {
    const choices = botModelChoices(provider, catalog, selected);
    const chosen = choices.some(model => model.id === selected) ? selected : 'default';
    return choices.map(model => `<option value="${escape(model.id)}" ${model.id === chosen ? 'selected' : ''}>${escape(model.name)}</option>`).join('');
  }
  function loadFormModels(providerId: ProviderId, select: HTMLSelectElement, preferred: string): void {
    const generation = ++formModelGeneration;
    const provider = options.providers.find(item => item.id === providerId);
    if (!provider) return;
    const apply = (catalog: ProviderModel[]) => {
      if (disposed || generation !== formModelGeneration || !select.isConnected
        || pane.querySelector<HTMLSelectElement>('.bots-form select[name=provider]')?.value !== providerId) return;
      const desired = providerId === 'github-copilot' && preferred !== 'default'
        && !catalog.some(model => model.id === preferred) ? 'default' : preferred;
      select.innerHTML = modelOptions(providerId, catalog, desired);
      select.value = botModelChoices(providerId, catalog, desired).some(model => model.id === desired) ? desired : 'default';
    };
    apply(modelCatalogs.get(providerId) ?? provider.models);
    if (modelCatalogs.has(providerId)) return;
    let pending = modelCatalogRequests.get(providerId);
    if (!pending) {
      pending = options.loadModels(providerId).then(catalog => {
        const models = Array.isArray(catalog) ? catalog : [];
        provider.models = models;
        modelCatalogs.set(providerId, models);
        return models;
      }).finally(() => modelCatalogRequests.delete(providerId));
      modelCatalogRequests.set(providerId, pending);
    }
    void pending.then(apply).catch(() => undefined);
  }
  function hydrateFormModels(): void {
    const form = pane.querySelector<HTMLFormElement>('.bots-form');
    if (!form) return;
    const provider = form.querySelector<HTMLSelectElement>('select[name=provider]')!;
    const model = form.querySelector<HTMLSelectElement>('select[name=model]')!;
    void loadFormModels(provider.value as ProviderId, model, model.dataset.preferredModel || model.value);
  }

  function renderList(): void {
    if (!list) return;
    const rows = bots.map(bot => `<button type="button" class="bots-row" data-bot="${escape(bot.id)}" aria-current="${bot.id === selected && editing !== 'new'}">${avatar(bot)}<span class="bots-row-text"><b>${escape(bot.name)}</b><small>${escape(bot.paused ? 'Paused' : working(bot) ? 'Working…' : bot.role || 'Ready')}</small></span>${bot.paused ? `<span class="bots-dot paused" title="Paused"></span>` : working(bot) ? '<span class="bots-dot working" title="Working"></span>' : ''}</button>`).join('');
    list.innerHTML = `<div class="bots-list-head"><span>Bots</span><button type="button" class="icon-button" data-bots-action="new" aria-label="New bot" title="New bot">${icon('plus')}</button></div><div class="bots-rows">${rows || '<p class="bots-empty-note">No bots yet.</p>'}</div>`;
  }

  function renderForm(bot: Bot | null): string {
    const source = bot ?? { ...template, provider: (installed()[0]?.id ?? 'claude') as ProviderId, model: '', mode: 'ask' };
    const providers = options.providers;
    const hasInstalledProvider = providers.some(item => item.installed);
    const provider = providers.find(item => item.id === source.provider) ?? providers.find(item => item.installed) ?? providers[0];
    const model = source.model || (provider ? options.defaultModel(provider.id) : '');
    const models = provider ? modelCatalogs.get(provider.id) ?? provider.models : [];
    const visibleModes = provider ? providerModes(provider.id) : MODES;
    const mode = visibleModes.some(item => item.id === source.mode) ? source.mode : 'ask';
    const templates = bot ? '' : `<div class="bots-templates" role="group" aria-label="Start from">${TEMPLATES.map(item => `<button type="button" data-template="${item.id}" aria-pressed="${item.id === template.id}">${botAvatarHtml(item.avatar, item.name, 'bots-template-avatar')}${escape(item.name || 'Blank')}</button>`).join('')}</div>`;
    const checkIns = `<select name="heartbeatMinutes" aria-label="Check-ins">${CHECK_INS.map(item => `<option value="${item.minutes}" ${item.minutes === source.heartbeatMinutes ? 'selected' : ''}>${item.label}</option>`).join('')}</select>`;
    return `<form class="bots-form" novalidate>
      ${bot ? '' : '<h3>New bot</h3><p class="bots-lede">A bot is an agent that lives on this computer. It remembers, works on a schedule, and answers you here, in a browser, or in Telegram, Slack, Discord and WhatsApp.</p>'}
      ${templates}
      <div class="bs-group">
        <div class="bs-row stacked"><span class="bs-row-text"><strong>Icon</strong></span>${avatarPicker(source.avatar)}</div>
        ${row('Name', '', `<input name="name" maxlength="60" required value="${escape(source.name)}" placeholder="Scout" aria-label="Name" autocomplete="off">`)}
        ${row('Job', '', `<input name="role" maxlength="200" value="${escape(source.role)}" placeholder="What it's for, in a few words" aria-label="Job" autocomplete="off">`)}
        ${row('Instructions', 'How it should work, what to always or never do', `<textarea name="instructions" rows="4" maxlength="16000" aria-label="Instructions">${escape(source.instructions)}</textarea>`, true)}
      </div>
      ${heading('Agent')}
      <div class="bs-group">
        ${row('Harness', '', `<select name="provider" aria-label="Harness">${providers.map(item => `<option value="${item.id}" ${item.id === provider?.id ? 'selected' : ''} ${!item.installed && hasInstalledProvider ? 'disabled' : ''}>${escape(item.name)}${!item.installed ? ' · Not installed' : ''}</option>`).join('')}</select>`)}
        ${row('Model', '', `<select name="model" aria-label="Model" data-preferred-model="${escape(model)}">${provider ? modelOptions(provider.id, models, provider.id === 'github-copilot' && model !== 'default' && !models.some(item => item.id === model) ? 'default' : model) : `<option value="default">Default</option>`}</select>`)}
        ${row('Permissions', '', `<select name="mode" aria-label="Permissions">${visibleModes.map(item => `<option value="${item.id}" ${item.id === mode ? 'selected' : ''}>${item.label}</option>`).join('')}</select>`)}
      </div>
      ${heading('Check-ins', infoMark('On each check-in the bot reviews its goals and memory using read-only steps, and messages you only when something needs attention.', 'About check-ins'))}
      <div class="bs-group">
        ${row('Check in', '', checkIns)}
        ${row('Standing goals', 'One per line. Check-ins work toward these.', `<textarea name="goals" rows="2" maxlength="16000" aria-label="Standing goals">${escape(source.goals)}</textarea>`, true)}
      </div>
      <div class="dialog-footer">${!bot && bots.length ? '<button type="button" class="secondary-button" data-bots-action="cancel-edit">Cancel</button>' : ''}<button type="submit" class="primary-button">${bot ? 'Save' : 'Create bot'}</button></div>
    </form>`;
  }

  function readForm(form: HTMLFormElement): BotInput {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    return { name: text('name'), role: text('role'), instructions: text('instructions'), goals: text('goals'), avatar: text('avatar'), provider: text('provider') as ProviderId, model: text('model'), mode: text('mode'), heartbeatMinutes: Number(text('heartbeatMinutes')) || 0 };
  }

  /** Identity and live state on the left; the conversation, pause, and the rare destructive actions on the right. */
  function renderHeader(bot: Bot): string {
    const harness = options.providers.find(item => item.id === bot.provider);
    const live = working(bot);
    const state = bot.paused ? 'Paused' : live ? 'Working' : 'Ready';
    const next = bot.heartbeatMinutes && bot.nextHeartbeatAt && !bot.paused ? `check-in ${age(bot.nextHeartbeatAt)}` : '';
    const meta = [bot.role, harness?.name, next].filter(Boolean).map(item => escape(item!)).join('<i aria-hidden="true">·</i>');
    return `<header class="bp-bar ${live ? 'is-working' : ''} ${bot.paused ? 'is-paused' : ''}"><span class="bots-ring bp-ring">${avatar(bot)}</span>
      <div class="bp-id"><div class="bp-name-row"><h3 class="bp-name">${escape(bot.name)}</h3><span class="bp-state" data-state="${state.toLowerCase()}">${state}</span></div><p class="bp-meta">${meta}</p></div>
      <div class="bp-actions">
        <button type="button" class="secondary-button bp-open" data-bots-action="open-chat">${icon('chat')}<span>Open chat</span></button>
        <button type="button" class="icon-button" data-bots-action="pause" aria-label="${bot.paused ? 'Resume' : 'Pause'}" title="${bot.paused ? 'Resume: schedules, check-ins and channels continue' : 'Pause: stop work and hold schedules and messages'}" aria-pressed="${bot.paused}">${icon(bot.paused ? 'play' : 'pause')}</button>
        <span class="bp-more"><button type="button" class="icon-button" data-bots-action="more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="${moreOpen}">${icon('more')}</button>
        ${moreOpen ? `<span class="bp-menu" role="menu"><button type="button" role="menuitem" data-bots-action="reset" aria-label="Reset bot">${icon('reset')}Reset…<small>Forget conversations, memories and schedules</small></button><button type="button" role="menuitem" class="danger" data-bots-action="delete" aria-label="Delete bot">${icon('trash')}Delete…<small>Remove the bot and its channels</small></button></span>` : ''}</span>
      </div></header>
      ${bot.paused ? '<p class="bots-banner">Paused. Schedules, check-ins and channel messages wait until you resume.</p>' : ''}`;
  }

  function badge(id: Nav): string {
    const pending = id === 'channels' ? detail?.pairings.filter(item => item.status === 'pending').length ?? 0 : 0;
    if (pending) return `<span class="bots-badge" aria-label="${pending} waiting">${pending}</span>`;
    const counts: Partial<Record<Nav, number>> = detail ? { memory: detail.memories.length, schedules: detail.schedules.filter(item => item.enabled).length, channels: detail.channels.filter(item => item.enabled).length } : {};
    return counts[id] ? `<span class="bots-count">${counts[id]}</span>` : '';
  }

  function render(): void {
    if (disposed) return;
    renderList();
    const confirm = confirming ? `<div class="bots-confirm" role="alertdialog" aria-label="${escape(confirming.title)}"><b>${escape(confirming.title)}</b><p>${escape(confirming.text)}</p><div class="dialog-footer"><button type="button" class="secondary-button" data-bots-action="confirm-cancel">Cancel</button><button type="button" class="primary-button danger" data-bots-action="confirm-run">${escape(confirming.button)}</button></div></div>` : '';
    const alert = error ? `<p class="bots-error" role="alert">${escape(error)}</p>` : '';
    if (loading) { pane.innerHTML = '<p class="dialog-loading" role="status">Loading bots…</p>'; return; }
    if (editing === 'new' || !detail) {
      pane.innerHTML = alert + (single && !detail ? '<p class="bots-empty-note">This bot no longer exists.</p>' : renderForm(null));
      hydrateFormModels();
      return;
    }
    // Keep a half-typed setting (a new memory, a schedule prompt) through background refreshes.
    const typing = pane.contains(document.activeElement) ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
    const kept = typing && 'value' in typing && typing.type !== 'checkbox' ? { name: typing.name || typing.getAttribute('aria-label') || '', value: typing.value } : null;
    const nav = `<div class="bs-nav" role="tablist" aria-orientation="vertical" aria-label="Bot settings">${SECTIONS.map(item => `<button type="button" role="tab" id="bs-tab-${item.id}" data-section="${item.id}" aria-controls="bs-panel" aria-selected="${item.id === section}" tabindex="${item.id === section ? 0 : -1}">${icon(item.icon)}<span>${item.label}</span>${badge(item.id)}</button>`).join('')}</div>`;
    const current = SECTIONS.find(item => item.id === section)!;
    const body = section === 'profile' ? renderForm(detail.bot)
      : section === 'activity' ? `${heading('Conversations')}${renderPanel('conversations', detail, context)}${heading('Rules', infoMark('Answer the bot\'s requests for you. Deny wins over allow, and * matches anything, as in npm test*. Risky actions such as sudo, force pushes, deleting files or anything about passwords always ask, whatever the rules say.', 'About rules'))}${renderPanel('rules', detail, context)}${heading('Activity log')}${renderPanel('activity', detail, context)}`
      : renderPanel(section, detail, context);
    pane.innerHTML = `${renderHeader(detail.bot)}${confirm}${alert}<div class="bs-body">${nav}<div class="bots-panel" id="bs-panel" role="tabpanel" aria-labelledby="bs-tab-${section}"><div class="bs-panel-head"><h2>${current.label}</h2><p>${escape(current.text)}</p></div>${body}</div></div>`;
    hydrateFormModels();
    if (kept?.name) {
      const again = [...pane.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].find(field => (field.name || field.getAttribute('aria-label')) === kept.name);
      if (again) { again.value = kept.value; again.focus(); }
    }
  }

  const click = (event: MouseEvent) => {
    if (handleAvatarPicker(event)) return;
    // A click anywhere outside the More menu closes it, like any menu.
    if (moreOpen && !(event.target instanceof Element && event.target.closest('.bp-more'))) { moreOpen = false; render(); }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,[data-bot]') : null;
    if (!target || !host.contains(target) || (target as HTMLButtonElement).disabled) return;
    if (target.dataset.bot) { selected = target.dataset.bot; editing = null; confirming = null; void load(); return; }
    if (target.dataset.section) { section = target.dataset.section as Nav; confirming = null; render(); return; }
    if (target.dataset.template) {
      template = TEMPLATES.find(item => item.id === target.dataset.template) ?? TEMPLATES[0];
      render(); pane.querySelector<HTMLInputElement>('input[name=name]')?.focus(); return;
    }
    const action = target.dataset.botsAction;
    const bot = detail?.bot;
    if (moreOpen && action !== 'more') moreOpen = false;
    if (action === 'new') { editing = 'new'; template = TEMPLATES[0]; confirming = null; render(); pane.querySelector<HTMLInputElement>('input[name=name]')?.focus(); }
    else if (action === 'cancel-edit') { editing = null; render(); }
    else if (action === 'more') { moreOpen = !moreOpen; render(); if (moreOpen) pane.querySelector<HTMLElement>('.bp-menu [role=menuitem]')?.focus(); }
    else if (action === 'open-chat' && bot) options.openChat(bot.id);
    else if (action === 'pause' && bot) void work(async () => { await options.call('bot_set_paused', { botId: bot.id, paused: !bot.paused }); options.notify(bot.paused ? `${bot.name} resumed` : `${bot.name} paused`); await load(); });
    else if (action === 'reset' && bot) context.confirm(`Reset ${bot.name}?`, 'This deletes its conversations, memories, schedules and activity. Its instructions, channels and rules stay.', 'Reset', async () => { await options.call('bot_reset', { botId: bot.id }); options.notify(`${bot.name} was reset`); await load(); });
    else if (action === 'delete' && bot) context.confirm(`Delete ${bot.name}?`, 'This removes the bot, its conversations and its channel connections. Its workspace folder stays on disk.', 'Delete', async () => { await options.call('bot_delete', { botId: bot.id }); selected = ''; options.notify(`${bot.name} was deleted`); if (single) { options.onDeleted?.(); return; } await load(); });
    else if (action === 'confirm-cancel') { confirming = null; render(); }
    else if (action === 'confirm-run' && confirming) { const run = confirming.action; confirming = null; render(); void work(run); }
    else if (section !== 'profile') panelClick(target, section, context);
  };
  const submit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (!host.contains(form)) return;
    event.preventDefault();
    if (!form.matches('.bots-form')) { if (section !== 'profile') panelSubmit(form, section, context); return; }
    const input = readForm(form);
    if (!input.name) { error = 'Give the bot a name.'; render(); return; }
    void work(async () => {
      if (editing !== 'new' && detail) { await options.call('bot_update', { botId: detail.bot.id, input }); options.notify('Bot saved'); await load(); return; }
      // A new bot opens straight into its conversation, like a new task.
      const bot = await options.call<Bot>('bot_create', { input });
      selected = bot.id; editing = null; section = 'profile';
      options.notify(`${bot.name} is ready`);
      await load();
      options.openChat(bot.id);
    });
  };
  const change = (event: Event) => {
    if (handleAvatarPicker(event)) return;
    const target = event.target as HTMLElement;
    if (target.matches('.bots-form select[name=provider]')) {
      const provider = options.providers.find(item => item.id === (target as HTMLSelectElement).value);
      const select = pane.querySelector<HTMLSelectElement>('.bots-form select[name=model]');
      const mode = pane.querySelector<HTMLSelectElement>('.bots-form select[name=mode]');
      if (provider && select) {
        const preferred = options.defaultModel(provider.id) || 'default';
        select.dataset.preferredModel = preferred;
        void loadFormModels(provider.id, select, preferred);
      }
      if (provider && mode) {
        const choices = providerModes(provider.id);
        const current = mode.value;
        const selected = choices.some(item => item.id === current) ? current : 'ask';
        mode.innerHTML = choices.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${item.label}</option>`).join('');
      }
      return;
    }
    if (section !== 'profile') panelChange(target, section, context);
  };
  host.addEventListener('click', click);
  host.addEventListener('submit', submit);
  host.addEventListener('change', change);
  const typed = (event: Event) => connectInput(event.target as HTMLElement);
  host.addEventListener('input', typed);
  // `toggle` does not bubble, so listen while capturing.
  const toggled = (event: Event) => { if (event.target instanceof HTMLDetailsElement) guideToggled(event.target); };
  host.addEventListener('toggle', toggled, true);
  /** The section list moves like the app's Settings sidebar: arrow keys, Home and End. */
  const navKeys = (event: KeyboardEvent): boolean => {
    const tabs = [...pane.querySelectorAll<HTMLButtonElement>('.bs-nav [role=tab]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    const step = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    if (index < 0 || (!step && event.key !== 'Home' && event.key !== 'End')) return false;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
    section = tabs[next].dataset.section as Nav; confirming = null; render();
    pane.querySelector<HTMLElement>(`#bs-tab-${section}`)?.focus();
    return true;
  };
  const keys = (event: KeyboardEvent) => { if (navKeys(event)) return; if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); moreOpen = false; render(); pane.querySelector<HTMLElement>('[data-bots-action="more"]')?.focus(); } };
  host.addEventListener('keydown', keys);
  render();
  void load();
  return {
    refresh: () => { if (!busy) void load(); },
    agent: (sessionId, kind) => {
      if (!detail?.threads.some(thread => thread.sessionId === sessionId)) return;
      if (kind === 'done') { void load(); return; }
      if (kind === 'turn_start' || kind === 'status') renderList();
    },
    dispose: () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('submit', submit); host.removeEventListener('change', change); host.removeEventListener('input', typed); host.removeEventListener('toggle', toggled, true); host.removeEventListener('keydown', keys); },
  };
}
