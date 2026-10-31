import type { Bot } from './bots';
import { botAvatarHtml } from './bot-avatars';
import { escape, icon } from './dom';
import { WORKING_LABELS } from './bot-thread';

export interface SharedChannelSummary {
  id: string;
  name: string;
  memberIds: string[];
  leadBotId: string | null;
  archived: boolean;
  updatedAt: number;
}
export interface SharedChannelMessage {
  id: string;
  kind: 'user' | 'reply' | 'assigned';
  authorBotId: string | null;
  text: string;
  status: 'Queued' | 'In progress' | 'Completed' | 'Failed' | 'Stopped' | null;
  createdAt: number;
}
export interface SharedChannelDetail extends SharedChannelSummary {
  messages: SharedChannelMessage[];
  activeBotIds: string[];
  /** Older history exists beyond the latest page returned. */
  hasMore?: boolean;
}
export interface SharedChannelUiOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  bots: Bot[];
  modal(title: string, body: string, cls?: string): HTMLDialogElement;
  closeModal(): void;
  changed(): Promise<void>;
  openChannel(channelId: string): void;
  notify(text: string): void;
}

const channelName = (name: string) => `#${name.replace(/^#+/, '')}`;

function faces(ids: string[], bots: Bot[], cls = ''): string {
  const members = ids.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  if (!members.length) return `<span class="bc-empty-face" aria-hidden="true">${icon('bot')}</span>`;
  const shown = members.length > 4 ? members.slice(0, 3) : members;
  return `<span class="bc-faces ${cls}" aria-label="${escape(members.map(bot => bot.name).join(', '))}">${shown.map(bot => botAvatarHtml(bot.avatar, bot.name, 'bc-face', bot.color)).join('')}${members.length > 4 ? `<span class="bc-face-count">+${members.length - 3}</span>` : ''}</span>`;
}

export function channelFaceCluster(ids: string[], bots: Bot[]): string { return faces(ids, bots, 'bc-cluster'); }

export function createChannelBody(bots: Bot[]): string {
  return `<form class="bc-create-form"><p class="dialog-description">A shared conversation for a small group of bots.</p>
    <label class="field-label" for="bc-new-name">Channel name</label><input id="bc-new-name" name="name" type="text" maxlength="48" autocomplete="off" required placeholder="e.g. launch">
    <fieldset class="bc-member-list"><legend>Bots</legend>${bots.map(bot => `<label><input type="checkbox" name="member" value="${escape(bot.id)}">${botAvatarHtml(bot.avatar, bot.name, 'bc-pick-face', bot.color)}<span>${escape(bot.name)}</span></label>`).join('')}</fieldset>
    <div class="dialog-footer"><button type="button" class="secondary-button" data-shared-action="cancel">Cancel</button><button type="submit" class="primary-button">Create channel</button></div></form>`;
}

export function openCreateChannel(options: SharedChannelUiOptions): void {
  const dialog = options.modal('New channel', createChannelBody(options.bots), 'bot-shared-dialog');
  const form = dialog.querySelector<HTMLFormElement>('.bc-create-form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form), name = String(data.get('name') ?? '').trim().replace(/^#+/, '');
    if (!name) return;
    const memberIds = [...form.querySelectorAll<HTMLInputElement>('input[name=member]:checked')].map(input => input.value);
    void options.call<SharedChannelSummary>('bot_shared_channel_create', { name, memberIds }).then(async channel => {
      await options.changed();
      options.closeModal();
      options.openChannel(channel.id);
    }).catch(error => options.notify(error instanceof Error ? error.message : String(error)));
  });
  dialog.querySelector('[data-shared-action="cancel"]')?.addEventListener('click', options.closeModal);
}

function messageHtml(message: SharedChannelMessage, bots: Bot[]): string {
  if (message.kind === 'assigned') {
    const bot = bots.find(item => item.id === message.authorBotId);
    return `<div class="bc-assigned" role="note" data-message-id="${escape(message.id)}"><span>Assigned to ${escape(bot?.name ?? 'bot')}</span>${message.status ? `<small>${escape(message.status)}</small>` : ''}</div>`;
  }
  const bot = message.authorBotId ? bots.find(item => item.id === message.authorBotId) : undefined;
  const name = bot?.name ?? (message.kind === 'user' ? 'You' : 'Bot');
  // Assignment rows and the working row already show progress; a post only flags what needs the user.
  const marker = message.status === 'Failed' || message.status === 'Stopped' ? `<small class="bc-message-status">${escape(message.status)}</small>` : '';
  return `<article class="bc-message ${message.kind === 'user' ? 'from-user' : 'from-bot'}" data-message-id="${escape(message.id)}" ${bot?.color ? `style="--bot-color:${escape(bot.color)}"` : ''}>
    ${bot ? botAvatarHtml(bot.avatar, bot.name, 'bc-message-avatar', bot.color) : ''}<div class="bc-message-main"><header><strong>${escape(name)}</strong>${marker}</header><div class="bc-message-text" data-message-id="${escape(message.id)}"></div></div></article>`;
}

function workingHtml(channel: SharedChannelDetail, bots: Bot[]): string {
  const ids = channel.activeBotIds;
  if (!ids.length) return '';
  const names = ids.map(id => bots.find(bot => bot.id === id)?.name).filter(Boolean) as string[];
  const label = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are working` : `${names[0] ?? 'A bot'} is working`;
  return `<div class="bc-working bot-working" data-shimmer><span class="bc-working-faces">${faces(ids, bots)}</span><span class="bot-working-label">${escape(WORKING_LABELS[0])}</span><span class="bc-working-status sr-only" role="status">${escape(label)}</span></div>`;
}

export function sharedChannelThreadHtml(channel: SharedChannelDetail, bots: Bot[]): string {
  const members = channel.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const empty = channel.messages.length === 0;
  const messages = channel.messages.map(message => messageHtml(message, bots)).join('');
  return `<section class="bc-channel" data-channel-id="${escape(channel.id)}">
    <header class="bc-header"><span class="bc-title">${channelFaceCluster(channel.memberIds, bots)}<span class="bc-member-names">${escape(members.map(bot => bot.name).join(', ') || 'No members')}</span></span>${channel.archived ? '' : `<button type="button" class="icon-button bc-settings" data-action="shared-channel-settings" aria-label="Channel settings">${icon('settings')}</button>`}</header>
    ${channel.archived ? '<div class="bc-archived" role="status">Deleted channel. Preview only.</div>' : ''}
    <div class="bc-history" aria-label="Channel messages">${channel.hasMore ? '<button type="button" class="secondary-button bc-earlier" data-shared-action="earlier">Show earlier messages</button>' : ''}${empty ? `<div class="bc-empty">${channelFaceCluster([], bots)}<p>${members.length ? 'No messages yet. @mention a bot or write to the lead.' : 'Add bots in channel settings to start work.'}</p></div>` : messages}${workingHtml(channel, bots)}</div>
  </section>`;
}

export function sharedChannelActionsHtml(channel: SharedChannelDetail, bots: Bot[]): string {
  if (channel.archived) return '<div class="bc-channel-actions"><span role="status">Deleted channel · preview only</span></div>';
  // A stopped or failed post can run again; the thread above already says who is working.
  const stopped = [...channel.messages].reverse().find(message => (message.status === 'Stopped' || message.status === 'Failed') && message.kind === 'user');
  const members = channel.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const queued = channel.messages.filter(message => message.kind === 'assigned' && message.status === 'Queued').map(message => message.authorBotId ?? '');
  const busy = [...new Set([...channel.activeBotIds, ...queued])].map(id => bots.find(bot => bot.id === id)?.name ?? 'bot');
  const stop = busy.length ? `<button type="button" class="secondary-button" data-shared-action="stop">${escape(`Stop ${busy.length > 1 ? `${busy.slice(0, -1).join(', ')} and ${busy.at(-1)}` : busy[0]}`)}</button>` : '';
  const stoppedRow = stopped && members.length ? `<span>${stopped.status === 'Failed' ? 'This message failed.' : 'This message stopped.'}</span><button type="button" class="secondary-button" data-shared-action="continue" data-message="${escape(stopped.id)}">Continue</button><button type="button" class="secondary-button" data-shared-action="reassign-toggle" aria-expanded="false">Reassign ${icon('down')}</button><div class="bc-reassign-menu" hidden>${members.map(bot => `<button type="button" data-shared-action="reassign" data-message="${escape(stopped.id)}" data-bot="${escape(bot.id)}">${botAvatarHtml(bot.avatar, bot.name, 'bc-pick-face', bot.color)}${escape(bot.name)}</button>`).join('')}</div>` : '';
  return stop || stoppedRow ? `<div class="bc-channel-actions" role="group" aria-label="Channel activity">${stop}${stoppedRow}</div>` : '';
}

export function sharedChannelComposerHtml(channel: SharedChannelDetail): string {
  if (channel.archived || !channel.memberIds.length) return '';
  return `<form id="shared-channel-composer" class="composer bc-composer"><textarea id="shared-channel-prompt" name="text" aria-label="Message channel" aria-description="Enter to send. Shift Enter for a new line." rows="2" placeholder="Message ${escape(channelName(channel.name))}… @mention up to two bots"></textarea><div class="composer-toolbar"><span></span><button type="submit" class="send-button" title="Send message" aria-label="Send message">${icon('arrow')}</button></div></form>`;
}

async function editChannel(options: SharedChannelUiOptions, channel: SharedChannelDetail): Promise<void> {
  const selected = new Set(channel.memberIds);
  const fields = options.bots.map(bot => `<label><input type="checkbox" name="member" value="${escape(bot.id)}" ${selected.has(bot.id) ? 'checked' : ''}>${botAvatarHtml(bot.avatar, bot.name, 'bc-pick-face', bot.color)}<span>${escape(bot.name)}</span></label>`).join('');
  const dialog = options.modal('Channel settings', `<form class="bc-settings-form"><label class="field-label" for="bc-edit-name">Name</label><input id="bc-edit-name" name="name" value="${escape(channel.name)}" maxlength="48" required>
    <fieldset class="bc-member-list"><legend>Members</legend>${fields || '<p>No bots are available.</p>'}</fieldset><label class="field-label" for="bc-lead">Lead</label><select id="bc-lead" name="lead">${channel.memberIds.map(id => options.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)).map((bot, index) => `<option value="${escape(bot.id)}" ${bot.id === channel.leadBotId || (!channel.leadBotId && index === 0) ? 'selected' : ''}>${escape(bot.name)}</option>`).join('')}</select>
    <div class="dialog-footer"><button type="button" class="secondary-button" data-shared-action="settings-cancel">Cancel</button><button type="submit" class="primary-button">Save</button></div></form>`, 'bot-shared-dialog');
  const form = dialog.querySelector<HTMLFormElement>('.bc-settings-form')!;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form), memberIds = [...form.querySelectorAll<HTMLInputElement>('input[name=member]:checked')].map(input => input.value);
    const requestedLead = String(data.get('lead') ?? '');
    const leadBotId = memberIds.includes(requestedLead) ? requestedLead : memberIds[0] ?? null;
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]'); if (save) save.disabled = true;
    void options.call('bot_shared_channel_update', { channelId: channel.id, name: String(data.get('name') ?? ''), memberIds, leadBotId }).then(async () => {
      options.closeModal();
      await options.changed();
    }).catch(error => options.notify(error instanceof Error ? error.message : String(error))).finally(() => { if (save?.isConnected) save.disabled = false; });
  });
  dialog.querySelector('[data-shared-action="settings-cancel"]')?.addEventListener('click', options.closeModal);
}

export async function openSharedChannel(channelId: string, options: SharedChannelUiOptions): Promise<void> {
  options.openChannel(channelId);
}

export async function openSharedChannelSettings(channelId: string, options: SharedChannelUiOptions): Promise<void> {
  try { await editChannel(options, await options.call<SharedChannelDetail>('bot_shared_channel_detail', { channelId })); }
  catch (error) { options.notify(error instanceof Error ? error.message : String(error)); }
}

