import { escape, icon } from './dom';
import { t } from './i18n.ts';
import { infoMark } from './tooltip';
import type { Activity, BotDetail, Channel, Schedule } from './bots';
import { channelGuide, connectChange, connectClick, connectSection, connectSubmit, kindLabel } from './bots-connect';

export type Tab = 'skills' | 'conversations' | 'memory' | 'schedules' | 'channels' | 'rules' | 'activity';
export interface PanelContext {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(text: string): void;
  openTask(sessionId: string): void;
  running(sessionId: string): boolean;
  detail(): BotDetail | null;
  reload(): Promise<void>;
  rerender(): void;
  work(action: () => Promise<void>): Promise<void>;
  confirm(title: string, text: string, button: string, action: () => Promise<void>): void;
}

const ACTIVITY_ICONS: Record<string, string> = { inbound: 'chat', reply: 'arrow', notify: 'spark', scheduled: 'refresh', approval: 'unlock', memory: 'leaf', schedule: 'refresh', channel: 'globe', pairing: 'check', rule: 'select', error: 'alert', stopped: 'stop', created: 'plus', updated: 'edit', reset: 'reset' };

/** "5 min. ago", "in 2 hr.": short relative times for lists. */
export function age(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.round((at - now) / 60000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 1) return at > now ? 'in a moment' : 'just now';
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}

let scheduleKind: Schedule['kind'] = 'daily';

let activity: { botId: string; items: Activity[]; done: boolean; loading: boolean } = { botId: '', items: [], done: false, loading: false };

function threadLabel(detail: BotDetail, channelId: string, externalId: string): string {
  if (channelId === 'desktop') return t('This app');
  if (channelId === 'schedule') return t('Scheduled work');
  const channel = detail.channels.find(item => item.id === channelId);
  const kind = channel ? kindLabel(channel.kind) : t('Removed channel');
  return channel?.kind === 'web' ? kind : `${kind} · ${externalId.length > 14 ? `…${externalId.slice(-8)}` : externalId}`;
}

/** Every conversation the bot has: this app, each channel thread, and its scheduled work. Each opens as a task. */
function conversationsPanel(detail: BotDetail, context: PanelContext): string {
  const threads = [...detail.threads].sort((a, b) => Number(b.channelId === 'desktop') - Number(a.channelId === 'desktop') || b.updatedAt - a.updatedAt);
  const web = detail.channels.find(item => item.kind === 'web' && item.enabled);
  const row = (thread: BotDetail['threads'][number]) => `<li><span class="bots-item-main"><b>${escape(threadLabel(detail, thread.channelId, thread.externalId))}</b><small>${context.running(thread.sessionId) ? t('Working…') : escape(age(thread.updatedAt))}</small></span><button type="button" class="secondary-button" data-open-task="${escape(thread.sessionId)}">${t('Open')}</button></li>`;
  return `${threads.length ? `<ul class="bots-items">${threads.map(row).join('')}</ul>` : `<p class="bots-empty-note">${t('No conversations yet. Open chat to start one.')}</p>`}
    ${web ? `<div class="bots-callout">${icon('globe')}<span>${t('Also chat from any browser on this computer.')}</span><button type="button" class="secondary-button" data-web-open="${escape(web.id)}">${t('Open web chat')}</button></div>` : ''}`;
}

function memoryPanel(detail: BotDetail): string {
  const items = [...detail.memories].reverse();
  return `<form class="bots-inline-form bots-memory"><input name="content" maxlength="2000" placeholder="${t('Add a memory')}" aria-label="${t('New memory')}" autocomplete="off"><button type="submit" class="secondary-button">${t('Remember')}</button></form>
    ${items.length ? `<ul class="bots-items">${items.map(memory => `<li><span class="bots-item-main"><span>${escape(memory.content)}</span><small>${memory.source === 'bot' ? t('Learned') : t('Added by you')} · ${escape(age(memory.createdAt))}</small></span><button type="button" class="icon-button" data-forget="${escape(memory.id)}" aria-label="${t('Forget this memory')}" title="${t('Forget')}">${icon('trash')}</button></li>`).join('')}</ul>` : `<p class="bots-empty-note">${t('No memories yet.')}</p>`}`;
}

export function describeSchedule(schedule: Pick<Schedule, 'kind' | 'intervalMinutes' | 'timeOfDay' | 'nextRunAt'>): string {
  switch (schedule.kind) {
    case 'interval': { const minutes = schedule.intervalMinutes ?? 0; return minutes % 60 === 0 ? t`Every ${minutes / 60 === 1 ? t('hour') : t`${minutes / 60} hours`}` : t`Every ${minutes} minutes`; }
    case 'daily': return t`Daily at ${schedule.timeOfDay}`;
    case 'weekdays': return t`Weekdays at ${schedule.timeOfDay}`;
    default: return schedule.nextRunAt ? t`Once, ${new Date(schedule.nextRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : t('Once');
  }
}

function schedulesPanel(detail: BotDetail): string {
  const field = (kinds: Schedule['kind'][], html: string) => `<div class="bots-when" data-kinds="${kinds.join(' ')}" ${kinds.includes(scheduleKind) ? '' : 'hidden'}>${html}</div>`;
  const soon = new Date(Date.now() + 3600000);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return `<form class="bots-schedule">
      <label class="bots-field"><span>${t('What should it do?')}</span><textarea name="prompt" rows="2" maxlength="8000" placeholder="${t('Check my GitHub notifications and summarize anything that needs me')}"></textarea></label>
      <div class="bots-grid three"><label class="bots-field"><span>${t('Name')}</span><input name="title" maxlength="120" placeholder="${t('Morning digest')}" autocomplete="off"></label>
      <label class="bots-field"><span>${t('Repeat')}</span><select name="kind">${[['daily', t('Every day')], ['weekdays', t('Weekdays')], ['interval', t('Every few minutes or hours')], ['once', t('Once')]].map(([id, label]) => `<option value="${id}" ${id === scheduleKind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${field(['daily', 'weekdays'], `<label class="bots-field"><span>${t('Time')}</span><input type="time" name="timeOfDay" value="09:00"></label>`)}
      ${field(['interval'], `<label class="bots-field"><span>${t('Every (minutes)')}</span><input type="number" name="intervalMinutes" min="5" max="10080" step="5" value="60"></label>`)}
      ${field(['once'], `<label class="bots-field"><span>${t('At')}</span><input type="datetime-local" name="runAt" value="${local}"></label>`)}</div>
      <div class="dialog-footer"><button type="submit" class="secondary-button">${icon('plus')}${t('Add schedule')}</button></div></form>
    ${detail.schedules.length ? `<ul class="bots-items">${detail.schedules.map(schedule => `<li class="${schedule.enabled ? '' : 'off'}"><span class="bots-item-main"><b>${escape(schedule.title)}${schedule.createdBy === 'bot' ? ` <span class="bots-chip">${t('Set by bot')}</span>` : ''}</b><small>${escape(describeSchedule(schedule))}${schedule.enabled && schedule.nextRunAt ? t` · next ${escape(age(schedule.nextRunAt))}` : schedule.enabled ? '' : t(' · off')}</small></span>
      <input type="checkbox" class="bots-switch" data-schedule-toggle="${escape(schedule.id)}" ${schedule.enabled ? 'checked' : ''} aria-label="${t`${escape(schedule.title)} on`}">
      <button type="button" class="icon-button" data-run-schedule="${escape(schedule.id)}" aria-label="${t`Run ${escape(schedule.title)} now`}" title="${t('Run now')}">${icon('play')}</button>
      <button type="button" class="icon-button" data-delete-schedule="${escape(schedule.id)}" aria-label="${t`Delete ${escape(schedule.title)}`}" title="${t('Delete')}">${icon('trash')}</button></li>`).join('')}</ul>` : `<p class="bots-empty-note">${t('No schedules yet. The bot can also schedule work for itself.')}</p>`}`;
}

function channelCard(detail: BotDetail, channel: Channel): string {
  const label = kindLabel(channel.kind);
  const actions = channel.kind === 'web' ? `<button type="button" class="secondary-button" data-web-copy="${escape(channel.id)}">${t('Copy link')}</button><button type="button" class="icon-button" data-web-rotate="${escape(channel.id)}" aria-label="${t('New link')}" title="${t('New link: pages opened with the old link stop working')}">${icon('refresh')}</button>` : '';
  const identity = (channel.config.identity as { name?: string } | undefined)?.name;
  return `<li class="bots-channel ${channel.enabled ? '' : 'off'}" data-kind="${channel.kind}"><div class="bots-channel-row"><span class="bots-kind" data-kind="${channel.kind}" aria-hidden="true">${escape(label.slice(0, 1))}</span><span class="bots-item-main"><b>${escape(channel.label || label)}${identity && channel.kind !== 'web' ? ` <small class="bots-identity">${escape(identity)}</small>` : ''}</b><small>${escape(channel.enabled ? channel.status || t('Starting…') : t('Off'))}</small></span>${actions}
    <input type="checkbox" class="bots-switch" data-channel-toggle="${escape(channel.id)}" ${channel.enabled ? 'checked' : ''} aria-label="${t`${escape(channel.label || label)} on`}">
    <button type="button" class="icon-button" data-remove-channel="${escape(channel.id)}" aria-label="${t`Remove ${escape(channel.label || label)}`}" title="${t('Remove')}">${icon('trash')}</button></div>${channel.enabled ? channelGuide(detail, channel) : ''}</li>`;
}

function pairingsList(detail: BotDetail): string {
  if (!detail.pairings.length) return '';
  const label = (channelId: string) => kindLabel(detail.channels.find(channel => channel.id === channelId)?.kind);
  return `<h4>${t('People')} ${infoMark(t('Unknown senders get a four-digit code. Approve it here to let them talk to the bot. Blocked senders are ignored.'), t('About pairing'))}</h4><ul class="bots-items">${detail.pairings.map(pairing => {
    const id = `data-channel="${escape(pairing.channelId)}" data-sender="${escape(pairing.senderId)}"`;
    const actions = pairing.status === 'pending' ? `<button type="button" class="primary-button" data-pairing="approved" ${id}>${t('Approve')}</button><button type="button" class="secondary-button" data-pairing="blocked" ${id}>${t('Block')}</button>`
      : `<button type="button" class="secondary-button" data-pairing="removed" ${id}>${pairing.status === 'blocked' ? t('Unblock') : t('Remove')}</button>`;
    return `<li class="bots-pairing ${pairing.status}"><span class="bots-item-main"><b>${escape(pairing.senderName || pairing.senderId)}</b><small>${escape(label(pairing.channelId))} · ${pairing.status === 'pending' ? `code <code>${escape(pairing.code)}</code>` : pairing.status}</small></span>${actions}</li>`;
  }).join('')}</ul>`;
}

function channelsPanel(detail: BotDetail): string {
  return `${detail.channels.length ? `<ul class="bots-items">${detail.channels.map(channel => channelCard(detail, channel)).join('')}</ul>` : ''}
    ${pairingsList(detail)}<h4>${detail.channels.length ? t('Add another channel') : t('Add a channel')}</h4>${connectSection(detail)}`;
}

function rulesPanel(detail: BotDetail): string {
  return `<form class="bots-inline-form bots-rule"><input name="pattern" maxlength="200" placeholder="${t('git status*')}" aria-label="${t('Pattern')}" autocomplete="off"><select name="decision" aria-label="${t('Decision')}"><option value="allow">${t('Allow')}</option><option value="ask">${t('Ask')}</option><option value="deny">${t('Deny')}</option></select><button type="submit" class="secondary-button">${t('Add rule')}</button></form>
    ${detail.rules.length ? `<ul class="bots-items">${detail.rules.map(rule => `<li><span class="bots-chip ${rule.decision}">${rule.decision}</span><span class="bots-item-main"><code>${escape(rule.pattern)}</code></span><button type="button" class="icon-button" data-delete-rule="${escape(rule.id)}" aria-label="${t`Delete rule ${escape(rule.pattern)}`}" title="${t('Delete')}">${icon('trash')}</button></li>`).join('')}</ul>` : `<p class="bots-empty-note">${t('No rules. Reply "always" to an approval request to add one.')}</p>`}`;
}

function activityPanel(detail: BotDetail, context: PanelContext): string {
  if (activity.botId !== detail.bot.id) { activity = { botId: detail.bot.id, items: [], done: false, loading: false }; void loadActivity(context, false); }
  if (!activity.items.length) return (activity.loading || !activity.done ? `<p class="dialog-loading" role="status">${t('Loading activity…')}</p>` : `<p class="bots-empty-note">${t('Nothing yet.')}</p>`);
  return `<ul class="bots-activity">${activity.items.map(item => `<li data-kind="${escape(item.kind)}">${icon(ACTIVITY_ICONS[item.kind] ?? 'info')}<span>${escape(item.summary)}</span><time datetime="${new Date(item.at).toISOString()}">${escape(age(item.at))}</time></li>`).join('')}</ul>
    ${activity.done ? '' : `<div class="dialog-footer"><button type="button" class="secondary-button" data-more-activity>${t('Show older')}</button></div>`}`;
}

async function loadActivity(context: PanelContext, older: boolean): Promise<void> {
  const botId = activity.botId;
  activity.loading = true;
  try {
    const before = older ? activity.items.at(-1)?.id : undefined;
    const items = await context.call<Activity[]>('bot_activity', { botId, before: before ?? null });
    if (activity.botId !== botId) return;
    activity = { botId, items: older ? [...activity.items, ...items] : items, done: items.length < 100, loading: false };
  } catch (cause) {
    activity = { ...activity, done: true, loading: false };
    context.notify(cause instanceof Error ? cause.message : String(cause));
  }
  context.rerender();
}

/** Library skills and configured MCP servers, read once per settings visit. Names only, never definitions. */
let capabilities: { skills: { id: string; name: string; description: string }[]; mcp: { harness: string; name: string; source: string }[] } | null = null;
let capabilitiesLoad: Promise<void> | null = null;
/** Harnesses that read skill folders; the rest get skills in the bot's brief. */
const SKILL_FOLDERS = ['claude', 'codex'];

function loadCapabilities(context: PanelContext): void {
  capabilitiesLoad ??= (async () => {
    const [items, inventory] = await Promise.all([
      context.call<{ id: string; name: string; kind: string; description: string }[]>('skills_list').catch(() => []),
      context.call<{ entries: { harness: string; kind: string; name: string; source: string }[] }>('capabilities_inventory', { taskId: null }).catch(() => ({ entries: [] })),
    ]);
    capabilities = { skills: items.filter(item => item.kind === 'skill'), mcp: inventory.entries.filter(entry => entry.kind === 'mcp server') };
    context.rerender();
  })();
}

function skillsPanel(detail: BotDetail, context: PanelContext): string {
  if (!capabilities) { loadCapabilities(context); return `<p class="dialog-loading" role="status">${t('Loading skills…')}</p>`; }
  const bot = detail.bot;
  const delivery = SKILL_FOLDERS.includes(bot.provider) ? t("Files in the bot's workspace") : t("In the bot's brief");
  const known = new Set(capabilities.skills.map(skill => skill.id));
  const skills = [...capabilities.skills, ...bot.skills.filter(id => !known.has(id)).map(id => ({ id, name: id, description: '' }))];
  const skillRow = (skill: { id: string; name: string; description: string }) => {
    const on = bot.skills.includes(skill.id), missing = !known.has(skill.id);
    return `<li><span class="bots-item-main"><b>${escape(skill.name)}</b><small>${missing ? t('Not in the library') : on ? escape(delivery) : escape(skill.description)}</small></span><input type="checkbox" class="bots-switch" data-bot-skill="${escape(skill.id)}" ${on ? 'checked' : ''} aria-label="${t`Use ${escape(skill.name)}`}"></li>`;
  };
  const names = [...new Set([...capabilities.mcp.map(entry => entry.name), ...bot.mcp])];
  const mcpRow = (name: string) => {
    const own = capabilities!.mcp.find(entry => entry.name === name && entry.harness === bot.provider);
    const status = own ? t`From ${own.source}` : t("Unsupported for this bot's harness");
    return `<li class="${own ? '' : 'off'}"><span class="bots-item-main"><b>${escape(name)}</b><small data-mcp-status>${escape(status)}</small></span><input type="checkbox" class="bots-switch" data-bot-mcp="${escape(name)}" ${bot.mcp.includes(name) ? 'checked' : ''} aria-label="${t`Use MCP server ${escape(name)}`}"></li>`;
  };
  return `<h4>${t('Skills')} ${infoMark(t("Chosen skills are turned on only in this bot's workspace, or for a project task started with this bot, where they ride in its brief. Harness-wide and project settings in Skills & rules are unchanged."), t('About bot skills'))}</h4>
    ${skills.length ? `<ul class="bots-items bots-skills">${skills.map(skillRow).join('')}</ul>` : `<p class="bots-empty-note">${t('The skills library is empty. Import skills in Settings → Skills & rules.')}</p>`}
    <h4>${t('MCP servers')} ${infoMark(t("Servers come from each harness's own configuration and keep their credentials there. PandaCode passes no server definitions per run, so a server is usable only when the bot's harness already has it; others show as unsupported."), t('About MCP servers'))}</h4>
    ${names.length ? `<ul class="bots-items bots-mcp">${names.map(mcpRow).join('')}</ul>` : `<p class="bots-empty-note">${t('No MCP servers are configured in your harnesses.')}</p>`}`;
}

/** Saves the checked skills and MCP servers. */
function saveCapabilities(target: HTMLElement, context: PanelContext): void {
  const detail = context.detail(); if (!detail) return;
  const panel = target.closest('.bots-panel')!;
  const checked = (key: string) => [...panel.querySelectorAll<HTMLInputElement>(`input[data-${key}]`)].filter(input => input.checked).map(input => input.getAttribute(`data-${key}`)!);
  void context.work(async () => { await context.call('bot_set_capabilities', { botId: detail.bot.id, skills: checked('bot-skill'), mcp: checked('bot-mcp') }); invalidateActivity(); context.notify(t('Saved')); await context.reload(); });
}

export function renderPanel(tab: Tab, detail: BotDetail, context: PanelContext): string {
  switch (tab) {
    case 'skills': return skillsPanel(detail, context);
    case 'conversations': return conversationsPanel(detail, context);
    case 'memory': return memoryPanel(detail);
    case 'schedules': return schedulesPanel(detail);
    case 'channels': return channelsPanel(detail);
    case 'rules': return rulesPanel(detail);
    case 'activity': return activityPanel(detail, context);
  }
}

/** Fresh activity after any change, so the Activity tab never shows a stale page. */
export function invalidateActivity(): void { activity = { botId: '', items: [], done: false, loading: false }; }
/** Re-read the skills library and MCP inventory next time the Skills section opens. */
export function invalidateCapabilities(): void { capabilities = null; capabilitiesLoad = null; }

export function panelClick(target: HTMLElement, _tab: Tab, context: PanelContext): void {
  const detail = context.detail(); if (!detail) return;
  const bot = detail.bot;
  const data = target.dataset;
  const done = async (text: string) => { invalidateActivity(); context.notify(text); await context.reload(); };
  if (connectClick(target, context)) return;
  if (data.openTask) context.openTask(data.openTask);
  else if (data.forget) void context.work(async () => { await context.call('bot_forget', { botId: bot.id, memoryId: data.forget }); await done(t('Forgotten')); });
  else if (data.runSchedule) void context.work(async () => { await context.call('bot_run_schedule_now', { scheduleId: data.runSchedule }); await done(t('Started')); });
  else if (data.deleteSchedule) void context.work(async () => { await context.call('bot_schedule_delete', { botId: bot.id, scheduleId: data.deleteSchedule }); await done(t('Schedule deleted')); });
  else if (data.deleteRule) void context.work(async () => { await context.call('bot_rule_delete', { botId: bot.id, ruleId: data.deleteRule }); await done(t('Rule deleted')); });
  else if (data.removeChannel) {
    const channel = detail.channels.find(item => item.id === data.removeChannel);
    context.confirm(t('Remove this channel?'), t`${bot.name} stops listening on ${channel?.label || kindLabel(channel?.kind)}, and its saved tokens are deleted.`, t('Remove'), async () => { await context.call('bot_channel_remove', { channelId: data.removeChannel }); await done(t('Channel removed')); });
  }
  else if (data.pairing) void context.work(async () => { await context.call('bot_pairing_decide', { channelId: data.channel, senderId: data.sender, decision: data.pairing }); await done(data.pairing === 'approved' ? t('Paired') : data.pairing === 'blocked' ? t('Blocked') : t('Removed')); });
  else if (target.hasAttribute('data-more-activity')) void loadActivity(context, true);
}

export function panelChange(target: HTMLElement, _tab: Tab, context: PanelContext): void {
  const detail = context.detail(); if (!detail) return;
  const input = target as HTMLInputElement;
  if (connectChange(target, context)) return;
  if (input.dataset.botSkill !== undefined || input.dataset.botMcp !== undefined) saveCapabilities(target, context);
  else if (target.matches('.bots-schedule select[name=kind]')) {
    scheduleKind = (target as HTMLSelectElement).value as Schedule['kind'];
    target.closest('form')?.querySelectorAll<HTMLElement>('.bots-when').forEach(element => { element.hidden = !element.dataset.kinds!.split(' ').includes(scheduleKind); });
  } else if (input.dataset.scheduleToggle) void context.work(async () => { await context.call('bot_schedule_set_enabled', { scheduleId: input.dataset.scheduleToggle, enabled: input.checked }); invalidateActivity(); await context.reload(); });
  else if (input.dataset.channelToggle) void context.work(async () => { await context.call('bot_channel_set_enabled', { channelId: input.dataset.channelToggle, enabled: input.checked }); invalidateActivity(); await context.reload(); });
}

export function panelSubmit(form: HTMLFormElement, _tab: Tab, context: PanelContext): void {
  const detail = context.detail(); if (!detail) return;
  const bot = detail.bot;
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? '').trim();
  const done = async (message: string) => { invalidateActivity(); context.notify(message); await context.reload(); };
  if (form.matches('.bots-memory')) {
    const content = text('content'); if (!content) return;
    void context.work(async () => { await context.call('bot_remember', { botId: bot.id, content }); await done(t('Remembered')); });
  } else if (form.matches('.bots-rule')) {
    const pattern = text('pattern'); if (!pattern) return;
    void context.work(async () => { await context.call('bot_rule_add', { botId: bot.id, pattern, decision: text('decision') }); await done(t('Rule added')); });
  } else if (form.matches('.bots-schedule')) {
    const kind = text('kind') as Schedule['kind'];
    const runAt = kind === 'once' ? new Date(text('runAt')).getTime() : null;
    if (kind === 'once' && !Number.isFinite(runAt)) { context.notify(t('Choose when it should run.')); return; }
    const input = { title: text('title'), prompt: text('prompt'), kind, intervalMinutes: kind === 'interval' ? Number(text('intervalMinutes')) : null, timeOfDay: kind === 'daily' || kind === 'weekdays' ? text('timeOfDay') : null, runAt };
    void context.work(async () => { await context.call('bot_schedule_create', { botId: bot.id, input }); await done(t('Schedule added')); });
  } else connectSubmit(form, context);
}
