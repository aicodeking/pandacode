/** Guided channel setup: numbered steps with links, copy buttons, a live credential
 * check, and what to do next once a channel is connected. */
import { escape, icon } from './dom';
import { t } from './i18n.ts';
import type { BotDetail, Channel, ChannelKind } from './bots';
import type { PanelContext } from './bots-panels';

export interface Identity { name: string; link: string | null; invite: string | null; warnings: string[] }
interface Field { name: string; label: string; secret: boolean; placeholder: string; config?: boolean }
interface Step { title: string; body: string; field?: Field }
interface Kind { id: ChannelKind; label: string; blurb: string; minutes: string }

export const KINDS: Kind[] = [
  { id: 'web', label: t('Web chat'), blurb: t('A private chat page on this computer'), minutes: t('Instant') },
  { id: 'telegram', label: t('Telegram'), blurb: t('Message it from your phone'), minutes: t('2 min') },
  { id: 'slack', label: t('Slack'), blurb: t('DM it or @mention it in channels'), minutes: t('4 min') },
  { id: 'discord', label: t('Discord'), blurb: t('DM it or @mention it in a server'), minutes: t('4 min') },
  { id: 'whatsapp', label: t('WhatsApp'), blurb: t('Via Meta’s Cloud API and a tunnel'), minutes: t('15 min') },
];
export const kindLabel = (kind: string | undefined) => KINDS.find(item => item.id === kind)?.label ?? t('Channel');

const PORT_DEFAULT = 47321;
const link = (url: string, label: string, primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'} bots-step-button" data-open-url="${escape(url)}">${escape(label)}${icon('forward')}</button>`;
const copy = (value: string, label = t('Copy'), caption = '') => `<span class="bots-copy-row">${caption ? `<span class="bots-copy-caption">${escape(caption)}</span>` : ''}<code>${escape(value)}</code><button type="button" class="secondary-button" data-copy="${escape(value)}">${escape(label)}</button></span>`;
const handle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'my';

/** A Slack app manifest with every scope, event and Socket Mode already set. */
export function slackManifest(botName: string): Record<string, unknown> {
  const name = botName.trim().slice(0, 35) || 'PandaCode bot';
  return {
    display_information: { name, description: 'An always-on assistant running on my computer through PandaCode.' },
    features: { bot_user: { display_name: name, always_online: true }, app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'users:read'] } },
    settings: { event_subscriptions: { bot_events: ['app_mention', 'message.im'] }, interactivity: { is_enabled: false }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
  };
}
export const slackCreateUrl = (botName: string) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(botName)))}`;

function steps(kind: ChannelKind, botName: string): Step[] {
  switch (kind) {
    case 'telegram': return [
      { title: t('Open BotFather in Telegram'), body: t`BotFather is Telegram’s official bot for creating bots. ${link('https://t.me/BotFather', t('Open BotFather'), true)}` },
      { title: t('Create the bot'), body: t`Send this to BotFather, then answer its two questions: a display name (for example “${escape(botName)}”) and a username ending in “bot”.${copy('/newbot', t('Copy'), t('Send'))}${copy(`${handle(botName)}_pandacode_bot`, t('Copy'), t('Username idea'))}` },
      { title: t('Paste the token BotFather sends back'), body: 'It looks like <code>123456789:AAE…</code>. Anyone with it can control the bot, so keep it private.', field: { name: 'token', label: t('Bot token'), secret: true, placeholder: '123456789:AAE…' } },
    ];
    case 'slack': return [
      { title: t('Create the Slack app in one click'), body: `${t('This opens Slack with the name, permissions, events and Socket Mode filled in. Pick your workspace, review, then press ')}<b>${t('Create')}</b>. ${link(slackCreateUrl(botName), t('Create Slack app'), true)} <button type="button" class="bots-text-button" data-copy="${escape(JSON.stringify(slackManifest(botName), null, 2))}">${t('Copy manifest instead')}</button>` },
      { title: t('Install it and copy the bot token'), body: 'In the app’s page, open <b>Install App</b> → <b>Install to Workspace</b> → <b>Allow</b>. Copy the <b>Bot User OAuth Token</b>.', field: { name: 'token', label: t('Bot token'), secret: true, placeholder: 'xoxb-…' } },
      { title: t('Create an app-level token'), body: 'Open <b>Basic Information</b> → <b>App-Level Tokens</b> → <b>Generate Token and Scopes</b>. Name it anything, add the scope <code>connections:write</code>, generate, and copy it.', field: { name: 'app_token', label: t('App-level token'), secret: true, placeholder: 'xapp-…' } },
    ];
    case 'discord': return [
      { title: t('Create an application'), body: `Press <b>New Application</b>, name it “${escape(botName)}”, and accept the terms. ${link('https://discord.com/developers/applications', t('Open Developer Portal'), true)}` },
      { title: t('Let it read messages'), body: 'Open the <b>Bot</b> tab, turn on <b>Message Content Intent</b> under Privileged Gateway Intents, and press <b>Save Changes</b>.' },
      { title: t('Copy the bot token'), body: 'Still on the Bot tab, press <b>Reset Token</b>, confirm, and copy it. (The Client Secret and Public Key are different values.)', field: { name: 'token', label: t('Bot token'), secret: true, placeholder: 'MTA…' } },
      { title: t('Add it to your server'), body: 'After you connect, an <b>Add to server</b> button appears here with the right permissions already chosen.' },
    ];
    case 'whatsapp': return [
      { title: t('Create a Meta app with WhatsApp'), body: `Choose <b>Other</b> → <b>Business</b>, then add the <b>WhatsApp</b> product. ${t('Meta gives you a free test number.')} ${link('https://developers.facebook.com/apps/creation/', t('Open Meta for Developers'), true)}` },
      { title: t('Copy the phone number ID'), body: 'In <b>WhatsApp</b> → <b>API Setup</b>, copy the <b>Phone number ID</b> (a long number, not the phone number itself). Add your own phone under <b>To</b> so the test number may message you.', field: { name: 'phoneNumberId', label: t('Phone number ID'), secret: false, placeholder: '123456789012345', config: true } },
      { title: t('Copy an access token'), body: `${t('The temporary token on API Setup works for 24 hours. For one that lasts, create a system user with WhatsApp permissions and generate its token.')} ${link('https://business.facebook.com/settings/system-users', t('System users'))}`, field: { name: 'access_token', label: t('Access token'), secret: true, placeholder: 'EAAG…' } },
      { title: t('Copy the app secret'), body: `Open <b>App settings</b> → <b>Basic</b> → <b>App secret</b> → <b>Show</b>. ${t('PandaCode uses it to check that messages really come from Meta.')}`, field: { name: 'signing_secret', label: t('App secret'), secret: true, placeholder: t('32 characters') } },
      { title: t('Connect, then point Meta at this computer'), body: t('After you connect, the steps for the webhook (with everything to copy) appear on the channel.') },
    ];
    default: return [];
  }
}

// Typed values survive re-renders (bots-changed refreshes the panel while you paste).
let adding: ChannelKind | null = null;
const values = new Map<string, string>();
let tested: { kind: ChannelKind; identity?: Identity; error?: string } | null = null;
// Guides the user opened or closed keep that state across re-renders.
const guides = new Map<string, boolean>();
export function guideToggled(details: HTMLDetailsElement): void {
  // Browsers also fire `toggle` when a guide renders open; only a change from the default is a choice.
  const id = details.dataset.guide;
  if (!id) return;
  if (details.open === (details.dataset.default === 'open')) guides.delete(id); else guides.set(id, details.open);
}

function input(kind: ChannelKind, form: HTMLFormElement | null): { kind: ChannelKind; label: string; config: Record<string, string>; secrets: Record<string, string> } {
  const all = steps(kind, '').flatMap(step => step.field ? [step.field] : []);
  const read = (name: string) => (form?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? values.get(`${kind}:${name}`) ?? '').trim();
  return { kind, label: read('label'), config: Object.fromEntries(all.filter(field => field.config).map(field => [field.name, read(field.name)])), secrets: Object.fromEntries(all.filter(field => !field.config).map(field => [field.name, read(field.name)])) };
}

function result(): string {
  if (!tested || tested.kind !== adding) return '';
  if (tested.error) return `<div class="bots-check fail" role="alert">${icon('alert')}<span>${escape(tested.error)}</span></div>`;
  const identity = tested.identity!;
  return `<div class="bots-check ok" role="status">${icon('check')}<span>${t('Works — connects as ')}<b>${escape(identity.name)}</b>${identity.warnings.map(warning => `<small>${escape(warning)}</small>`).join('')}</span></div>`;
}

export function connectSection(detail: BotDetail): string {
  const chooser = `<div class="bots-kind-grid" role="group" aria-label="${t('Add a channel')}">${KINDS.map(kind => `<button type="button" data-add-kind="${kind.id}" aria-pressed="${kind.id === adding}"><span class="bots-kind" data-kind="${kind.id}" aria-hidden="true">${kind.label.slice(0, 1)}</span><b>${escape(kind.label)}</b><small>${escape(kind.blurb)}</small><em>${escape(kind.minutes)}</em></button>`).join('')}</div>`;
  if (!adding) return chooser;
  if (adding === 'web') {
    return `${chooser}<form class="bots-connect" data-kind="web"><p class="bots-lede">${t('A chat page served by this computer. Only people with the private link can use it, and only while PandaCode is running.')}</p>
      <div class="dialog-footer"><button type="button" class="secondary-button" data-add-kind="">${t('Cancel')}</button><button type="submit" class="primary-button">${t('Turn on web chat')}</button></div></form>`;
  }
  const kind = adding;
  const list = steps(kind, detail.bot.name).map((step, index) => `<li><span class="bots-step-number" aria-hidden="true">${index + 1}</span><div><b>${escape(step.title)}</b><p>${step.body}</p>${step.field ? `<label class="bots-field"><span>${escape(step.field.label)}</span><input name="${step.field.name}" ${step.field.secret ? 'type="password" spellcheck="false"' : 'inputmode="numeric"'} autocomplete="off" placeholder="${escape(step.field.placeholder)}" value="${escape(values.get(`${kind}:${step.field.name}`) ?? '')}"></label>` : ''}</div></li>`).join('');
  return `${chooser}<form class="bots-connect" data-kind="${kind}"><ol class="bots-steps">${list}</ol>
    ${result()}
    <small class="bots-hint">${icon('unlock')}${t('Tokens go straight to your system keychain. The agent never sees them.')}</small>
    <div class="dialog-footer"><button type="button" class="secondary-button" data-add-kind="">${t('Cancel')}</button><button type="button" class="secondary-button" data-test-channel>${t('Test')}</button><button type="submit" class="primary-button">${t`Connect ${escape(kindLabel(kind))}`}</button></div></form>`;
}

/** What to do next, shown on each connected channel. */
export function channelGuide(detail: BotDetail, channel: Channel): string {
  const identity = channel.config.identity as Identity | undefined;
  const port = detail.serverPort || PORT_DEFAULT;
  const warnings = (identity?.warnings ?? []).map(warning => `<p class="bots-warning">${icon('alert')}${escape(warning)}</p>`).join('');
  const paired = detail.pairings.some(pairing => pairing.channelId === channel.id && pairing.status === 'approved');
  const pairStep = paired ? '' : '<li>Send it any message. It replies with a four-digit code, which also appears under <b>People</b> below. Press <b>Approve</b> and you’re talking.</li>';
  const publicUrl = String(channel.config.publicUrl ?? '');
  // What the user is typing into the address field survives a background refresh.
  const typedUrl = values.get(`public:${channel.id}`) ?? publicUrl;
  let body = '';
  switch (channel.kind) {
    case 'telegram':
      body = `<ol>${identity?.link ? `<li>${link(identity.link, t`Open ${identity.name} in Telegram`, true)}</li>` : ''}${pairStep}<li>${t('In groups, add the bot and mention it or reply to it.')}</li></ol>`; break;
    case 'slack':
      body = `<ol>${identity?.link ? `<li>${link(identity.link, t('Open Slack'), true)}</li>` : ''}<li>Find the bot under <b>Apps</b> in the sidebar and message it, or <code>/invite</code> it to a channel and @mention it.</li>${pairStep}</ol>`; break;
    case 'discord':
      body = `<ol>${identity?.invite ? `<li>${link(identity.invite, t('Add to a server'), true)} Choose a server you manage and press <b>Authorize</b>.</li>` : ''}<li>${t('Mention it in a channel, or open its profile and send a direct message.')}</li>${pairStep}</ol>`; break;
    case 'whatsapp': {
      const callback = publicUrl ? `${publicUrl}/whatsapp/${channel.id}` : '';
      body = `<ol>
        <li><b>Give Meta a way in.</b> ${t('Meta delivers messages over HTTPS, so this computer needs a public address. The quickest is a free Cloudflare tunnel; run these in Terminal and keep the second one open:')}${copy('brew install cloudflared', t('Copy'), t('Install'))}${copy(`cloudflared tunnel --url http://127.0.0.1:${port}`, t('Copy'), t('Start'))}It prints an address ending in <code>trycloudflare.com</code>. That address changes each time the tunnel starts; for a fixed one, use Tailscale Funnel instead:${copy(`tailscale funnel --bg ${port}`, t('Copy'), t('Or'))}</li>
        <li><label class="bots-field"><span>${t('Paste that https address')}</span><span class="bots-inline-form"><input data-public-url="${escape(channel.id)}" placeholder="https://….trycloudflare.com" value="${escape(typedUrl)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-save-public="${escape(channel.id)}">${t('Save')}</button></span></label></li>
        <li><b>In Meta</b>, open WhatsApp → <b>Configuration</b> → Webhook → <b>Edit</b> and paste:${callback ? `${copy(callback, t('Copy'), t('Callback URL'))}` : ` <i>(${t('the callback URL appears here after you save the address')})</i>`}${copy(String(channel.config.verifyToken ?? ''), t('Copy'), t('Verify token'))}Press <b>Verify and save</b>, then under Webhook fields press <b>Manage</b> and subscribe to <b>messages</b>. The status above turns to “Webhook verified”.</li>
        <li>${identity?.link ? link(identity.link, t('Message your WhatsApp number')) : t('Message your WhatsApp business number from your phone.')}</li>${pairStep}</ol>`; break;
    }
    case 'web':
      body = `<ol><li><button type="button" class="primary-button bots-step-button" data-web-open="${escape(channel.id)}">${t('Open web chat')}</button> ${t('On this computer, that’s it.')}</li>
        <li><label class="bots-switch-row"><input type="checkbox" class="bots-switch" data-remote="${escape(channel.id)}" ${channel.config.remote ? 'checked' : ''}><span><b>${t('Use from my phone and other devices')}</b><small>${t('Allows the page through a private tunnel. The link still works only with its token.')}</small></span></label></li>
        ${channel.config.remote ? `<li>${t('Install Tailscale on this computer and your phone and sign in to both. Then run this in Terminal:')}${copy(`tailscale serve --bg ${port}`, t('Copy'), t('Run'))}It shows an address like <code>https://your-mac.tailnet.ts.net</code>.</li>
        <li><label class="bots-field"><span>${t('Paste that https address')}</span><span class="bots-inline-form"><input data-public-url="${escape(channel.id)}" placeholder="https://your-mac.tailnet.ts.net" value="${escape(typedUrl)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-save-public="${escape(channel.id)}">${t('Save')}</button></span></label></li>
        ${publicUrl ? `<li><button type="button" class="primary-button bots-step-button" data-phone-link="${escape(channel.id)}">${t('Copy link for my phone')}</button> ${t('Open it on your phone; add it to your home screen to use it like an app.')}</li>` : ''}` : ''}</ol>`; break;
  }
  const fallback = channel.kind === 'web' ? Boolean(channel.config.remote) : !paired;
  const open = guides.get(channel.id) ?? fallback;
  return `${warnings}<details class="bots-guide" data-guide="${escape(channel.id)}" data-default="${fallback ? 'open' : 'closed'}" ${open ? 'open' : ''}><summary>${channel.kind === 'web' ? t('How to use') : paired ? t('How to use') : t('Finish setting up')}</summary>${body}</details>`;
}

async function webLink(context: PanelContext, channelId: string): Promise<string> { return context.call<string>('bot_web_link', { channelId }); }

/** Returns true when the click was a setup action. */
export function connectClick(target: HTMLElement, context: PanelContext): boolean {
  const data = target.dataset;
  const detail = context.detail(); if (!detail) return false;
  const done = async (text: string) => { context.notify(text); await context.reload(); };
  if (data.addKind !== undefined) { adding = (data.addKind || null) as ChannelKind | null; tested = null; context.rerender(); target.closest('.bots-panel')?.querySelector<HTMLInputElement>('.bots-connect input')?.focus(); return true; }
  if (data.openUrl) { void context.work(async () => { await context.call('open_external_url', { url: data.openUrl }); }); return true; }
  if (data.copy) { void context.work(async () => { await navigator.clipboard.writeText(data.copy!); context.notify(t('Copied')); }); return true; }
  if (target.hasAttribute('data-test-channel') && adding) {
    const kind = adding, form = target.closest<HTMLFormElement>('form');
    void context.work(async () => {
      try { tested = { kind, identity: await context.call<Identity>('bot_channel_test', { input: input(kind, form) }) }; }
      catch (cause) { tested = { kind, error: cause instanceof Error ? cause.message : String(cause) }; }
      context.rerender();
    });
    return true;
  }
  if (data.webOpen) { void context.work(async () => { await context.call('open_external_url', { url: await webLink(context, data.webOpen!) }); }); return true; }
  if (data.webCopy) { void context.work(async () => { await navigator.clipboard.writeText(await webLink(context, data.webCopy!)); context.notify(t('Private link copied. Anyone with it can talk to this bot.')); }); return true; }
  if (data.webRotate) { context.confirm(t('Create a new web chat link?'), t('Pages opened with the current link stop working right away. Use this if the link was shared by mistake.'), t('New link'), async () => { await navigator.clipboard.writeText(await context.call<string>('bot_web_new_link', { channelId: data.webRotate })); await done(t('New link copied')); }); return true; }
  if (data.phoneLink) {
    const channel = detail.channels.find(item => item.id === data.phoneLink);
    void context.work(async () => {
      const local = new URL(await webLink(context, data.phoneLink!));
      await navigator.clipboard.writeText(`${String(channel?.config.publicUrl ?? '')}${local.pathname}${local.hash}`);
      context.notify(t('Phone link copied. Send it to yourself and open it on your phone.'));
    });
    return true;
  }
  if (data.savePublic) {
    const field = target.closest('li')?.querySelector<HTMLInputElement>(`[data-public-url="${CSS.escape(data.savePublic)}"]`);
    void context.work(async () => { await context.call('bot_channel_configure', { channelId: data.savePublic, config: { publicUrl: field?.value ?? '' } }); values.delete(`public:${data.savePublic}`); await done(t('Address saved')); });
    return true;
  }
  return false;
}

export function connectChange(target: HTMLElement, context: PanelContext): boolean {
  const input = target as HTMLInputElement;
  if (input.dataset.remote) { void context.work(async () => { await context.call('bot_channel_configure', { channelId: input.dataset.remote, config: { remote: input.checked } }); await context.reload(); }); return true; }
  return false;
}

/** Remembers typed setup values, so a refresh while pasting keeps them. */
export function connectInput(target: HTMLElement): void {
  const form = target.closest<HTMLFormElement>('.bots-connect');
  const field = target as HTMLInputElement;
  if (field.dataset.publicUrl) { values.set(`public:${field.dataset.publicUrl}`, field.value); return; }
  if (form?.dataset.kind && field.name) { values.set(`${form.dataset.kind}:${field.name}`, field.value); if (tested?.kind === form.dataset.kind) tested = null; }
}

export function connectSubmit(form: HTMLFormElement, context: PanelContext): boolean {
  if (!form.matches('.bots-connect')) return false;
  const detail = context.detail(); const kind = form.dataset.kind as ChannelKind;
  if (!detail || !kind) return true;
  void context.work(async () => {
    await context.call('bot_channel_add', { botId: detail.bot.id, input: kind === 'web' ? { kind, label: '', config: {}, secrets: {} } : input(kind, form) });
    for (const key of [...values.keys()]) if (key.startsWith(`${kind}:`)) values.delete(key);
    adding = null; tested = null;
    context.notify(t`${kindLabel(kind)} connected`);
    await context.reload();
  });
  return true;
}
