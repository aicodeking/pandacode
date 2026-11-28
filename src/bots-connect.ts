/** Guided channel setup: numbered steps with links, copy buttons, a live credential
 * check, and what to do next once a channel is connected. */
import { escape, icon } from './dom';
import type { BotDetail, Channel, ChannelKind } from './bots';
import type { PanelContext } from './bots-panels';

export interface Identity { name: string; link: string | null; invite: string | null; warnings: string[] }
/** What a bridge adapter needs, returned only by the explicit setup action. */
export interface Setup { url: string; channelId: string; token: string; env: string; remote: boolean }
interface Field { name: string; label: string; secret: boolean; placeholder: string; config?: boolean }
interface Step { title: string; body: string; field?: Field }
/** Everything that differs between channel kinds, in one place.
 *
 * The ids here are the only source of the `ChannelKind` union, so a kind cannot exist in
 * one list and not another. To add a kind: add its entry here, then write its transport
 * on the Rust side (see `KINDS` in src-tauri/src/bots/channels/mod.rs). */
export interface ChannelSpec {
  id: string;
  label: string;
  blurb: string;
  minutes: string;
  /** Secret field names this kind cannot be connected without. */
  secrets: string[];
  /** True when the setup can point at a public address (a tunnel), not just this computer. */
  acceptsPublicUrl: boolean;
  /** The numbered setup guide for this kind. */
  steps(botName: string): Step[];
}

const PORT_DEFAULT = 47321;
const link = (url: string, label: string, primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'secondary-button'} bots-step-button" data-open-url="${escape(url)}">${escape(label)}${icon('forward')}</button>`;
const copy = (value: string, label = 'Copy', caption = '') => `<span class="bots-copy-row">${caption ? `<span class="bots-copy-caption">${escape(caption)}</span>` : ''}<code>${escape(value)}</code><button type="button" class="secondary-button" data-copy="${escape(value)}">${escape(label)}</button></span>`;
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

export const KINDS: ChannelSpec[] = [
  { id: 'web', label: 'Web chat', blurb: 'A private chat page on this computer', minutes: 'Instant', secrets: [], acceptsPublicUrl: true, steps: () => [] },
  {
    id: 'telegram', label: 'Telegram', blurb: 'Message it from your phone', minutes: '2 min', secrets: ['token'], acceptsPublicUrl: false,
    steps: botName => [
      { title: 'Open BotFather in Telegram', body: `BotFather is Telegram’s official bot for creating bots. ${link('https://t.me/BotFather', 'Open BotFather', true)}` },
      { title: 'Create the bot', body: `Send this to BotFather, then answer its two questions: a display name (for example “${escape(botName)}”) and a username ending in “bot”.${copy('/newbot', 'Copy', 'Send')}${copy(`${handle(botName)}_pandacode_bot`, 'Copy', 'Username idea')}` },
      { title: 'Paste the token BotFather sends back', body: 'It looks like <code>123456789:AAE…</code>. Anyone with it can control the bot, so keep it private.', field: { name: 'token', label: 'Bot token', secret: true, placeholder: '123456789:AAE…' } },
    ],
  },
  {
    id: 'slack', label: 'Slack', blurb: 'DM it or @mention it in channels', minutes: '4 min', secrets: ['token', 'app_token'], acceptsPublicUrl: false,
    steps: botName => [
      { title: 'Create the Slack app in one click', body: `This opens Slack with the name, permissions, events and Socket Mode filled in. Pick your workspace, review, then press <b>Create</b>. ${link(slackCreateUrl(botName), 'Create Slack app', true)} <button type="button" class="bots-text-button" data-copy="${escape(JSON.stringify(slackManifest(botName), null, 2))}">Copy manifest instead</button>` },
      { title: 'Install it and copy the bot token', body: 'In the app’s page, open <b>Install App</b> → <b>Install to Workspace</b> → <b>Allow</b>. Copy the <b>Bot User OAuth Token</b>.', field: { name: 'token', label: 'Bot token', secret: true, placeholder: 'xoxb-…' } },
      { title: 'Create an app-level token', body: 'Open <b>Basic Information</b> → <b>App-Level Tokens</b> → <b>Generate Token and Scopes</b>. Name it anything, add the scope <code>connections:write</code>, generate, and copy it.', field: { name: 'app_token', label: 'App-level token', secret: true, placeholder: 'xapp-…' } },
    ],
  },
  {
    id: 'discord', label: 'Discord', blurb: 'DM it or @mention it in a server', minutes: '4 min', secrets: ['token'], acceptsPublicUrl: false,
    steps: botName => [
      { title: 'Create an application', body: `Press <b>New Application</b>, name it “${escape(botName)}”, and accept the terms. ${link('https://discord.com/developers/applications', 'Open Developer Portal', true)}` },
      { title: 'Let it read messages', body: 'Open the <b>Bot</b> tab, turn on <b>Message Content Intent</b> under Privileged Gateway Intents, and press <b>Save Changes</b>.' },
      { title: 'Copy the bot token', body: 'Still on the Bot tab, press <b>Reset Token</b>, confirm, and copy it. (The Client Secret and Public Key are different values.)', field: { name: 'token', label: 'Bot token', secret: true, placeholder: 'MTA…' } },
      { title: 'Add it to your server', body: 'After you connect, an <b>Add to server</b> button appears here with the right permissions already chosen.' },
    ],
  },
  {
    id: 'whatsapp', label: 'WhatsApp', blurb: 'Via Meta’s Cloud API and a tunnel', minutes: '15 min', secrets: ['access_token', 'signing_secret'], acceptsPublicUrl: true,
    steps: () => [
      { title: 'Create a Meta app with WhatsApp', body: `Choose <b>Other</b> → <b>Business</b>, then add the <b>WhatsApp</b> product. Meta gives you a free test number. ${link('https://developers.facebook.com/apps/creation/', 'Open Meta for Developers', true)}` },
      { title: 'Copy the phone number ID', body: 'In <b>WhatsApp</b> → <b>API Setup</b>, copy the <b>Phone number ID</b> (a long number, not the phone number itself). Add your own phone under <b>To</b> so the test number may message you.', field: { name: 'phoneNumberId', label: 'Phone number ID', secret: false, placeholder: '123456789012345', config: true } },
      { title: 'Copy an access token', body: `The temporary token on API Setup works for 24 hours. For one that lasts, create a system user with WhatsApp permissions and generate its token. ${link('https://business.facebook.com/settings/system-users', 'System users')}`, field: { name: 'access_token', label: 'Access token', secret: true, placeholder: 'EAAG…' } },
      { title: 'Copy the app secret', body: 'Open <b>App settings</b> → <b>Basic</b> → <b>App secret</b> → <b>Show</b>. PandaCode uses it to check that messages really come from Meta.', field: { name: 'signing_secret', label: 'App secret', secret: true, placeholder: '32 characters' } },
      { title: 'Connect, then point Meta at this computer', body: 'After you connect, the steps for the webhook (with everything to copy) appear on the channel.' },
    ],
  },
  {
    id: 'bridge', label: 'Bridge', blurb: 'Signal, Mattermost, Matrix, ntfy and more through a tool you run', minutes: '3 min', secrets: [], acceptsPublicUrl: true,
    steps: () => [
      { title: 'Connect it to get a token', body: 'A bridge is one connector for every chat platform PandaCode does not speak natively. It gives you a private token and an endpoint; a small adapter you run — <code>signal-cli</code>, a Mattermost bot, an ntfy subscriber, or a shell script — carries messages across. Nothing on that platform is exposed unless you put this behind a tunnel.' },
      { title: 'Run the helper', body: 'The setup on the channel gives you three exports and a copy of <code>pandacode-bridge.sh</code>. Its <code>send</code> command posts one message in, and <code>listen</code> prints replies as JSON, one per line, ready to post to your platform.' },
      { title: 'Pair the sender', body: 'The first message from anyone other than you shows a four-digit code under <b>People</b>; approve it and they can talk to the bot. If your bridge token ever leaks, rotate it on the channel and old adapters stop working.' },
    ],
  },
];
export const kindLabel = (kind: string | undefined) => KINDS.find(item => item.id === kind)?.label ?? 'Channel';
const spec = (kind: string): ChannelSpec | undefined => KINDS.find(item => item.id === kind);

function steps(kind: ChannelKind, botName: string): Step[] {
  return spec(kind)?.steps(botName) ?? [];
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
  return `<div class="bots-check ok" role="status">${icon('check')}<span>Works — connects as <b>${escape(identity.name)}</b>${identity.warnings.map(warning => `<small>${escape(warning)}</small>`).join('')}</span></div>`;
}

export function connectSection(detail: BotDetail): string {
  const chooser = `<div class="bots-kind-grid" role="group" aria-label="Add a channel">${KINDS.map(kind => `<button type="button" data-add-kind="${kind.id}" aria-pressed="${kind.id === adding}"><span class="bots-kind" data-kind="${kind.id}" aria-hidden="true">${kind.label.slice(0, 1)}</span><b>${escape(kind.label)}</b><small>${escape(kind.blurb)}</small><em>${escape(kind.minutes)}</em></button>`).join('')}</div>`;
  if (!adding) return chooser;
  if (adding === 'web') {
    return `${chooser}<form class="bots-connect" data-kind="web"><p class="bots-lede">A chat page served by this computer. Only people with the private link can use it, and only while PandaCode is running.</p>
      <div class="dialog-footer"><button type="button" class="secondary-button" data-add-kind="">Cancel</button><button type="submit" class="primary-button">Turn on web chat</button></div></form>`;
  }
  const kind = adding;
  const list = steps(kind, detail.bot.name).map((step, index) => `<li><span class="bots-step-number" aria-hidden="true">${index + 1}</span><div><b>${escape(step.title)}</b><p>${step.body}</p>${step.field ? `<label class="bots-field"><span>${escape(step.field.label)}</span><input name="${step.field.name}" ${step.field.secret ? 'type="password" spellcheck="false"' : 'inputmode="numeric"'} autocomplete="off" placeholder="${escape(step.field.placeholder)}" value="${escape(values.get(`${kind}:${step.field.name}`) ?? '')}"></label>` : ''}</div></li>`).join('');
  return `${chooser}<form class="bots-connect" data-kind="${kind}"><ol class="bots-steps">${list}</ol>
    ${result()}
    <small class="bots-hint">${icon('unlock')}Tokens go straight to your system keychain. The agent never sees them.</small>
    <div class="dialog-footer"><button type="button" class="secondary-button" data-add-kind="">Cancel</button><button type="button" class="secondary-button" data-test-channel>Test</button><button type="submit" class="primary-button">Connect ${escape(kindLabel(kind))}</button></div></form>`;
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
      body = `<ol>${identity?.link ? `<li>${link(identity.link, `Open ${identity.name} in Telegram`, true)}</li>` : ''}${pairStep}<li>In groups, add the bot and mention it or reply to it.</li></ol>`; break;
    case 'slack':
      body = `<ol>${identity?.link ? `<li>${link(identity.link, 'Open Slack', true)}</li>` : ''}<li>Find the bot under <b>Apps</b> in the sidebar and message it, or <code>/invite</code> it to a channel and @mention it.</li>${pairStep}</ol>`; break;
    case 'discord':
      body = `<ol>${identity?.invite ? `<li>${link(identity.invite, 'Add to a server', true)} Choose a server you manage and press <b>Authorize</b>.</li>` : ''}<li>Mention it in a channel, or open its profile and send a direct message.</li>${pairStep}</ol>`; break;
    case 'whatsapp': {
      const callback = publicUrl ? `${publicUrl}/whatsapp/${channel.id}` : '';
      body = `<ol>
        <li><b>Give Meta a way in.</b> Meta delivers messages over HTTPS, so this computer needs a public address. The quickest is a free Cloudflare tunnel; run these in Terminal and keep the second one open:${copy('brew install cloudflared', 'Copy', 'Install')}${copy(`cloudflared tunnel --url http://127.0.0.1:${port}`, 'Copy', 'Start')}It prints an address ending in <code>trycloudflare.com</code>. That address changes each time the tunnel starts; for a fixed one, use Tailscale Funnel instead:${copy(`tailscale funnel --bg ${port}`, 'Copy', 'Or')}</li>
        <li><label class="bots-field"><span>Paste that https address</span><span class="bots-inline-form"><input data-public-url="${escape(channel.id)}" placeholder="https://….trycloudflare.com" value="${escape(typedUrl)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-save-public="${escape(channel.id)}">Save</button></span></label></li>
        <li><b>In Meta</b>, open WhatsApp → <b>Configuration</b> → Webhook → <b>Edit</b> and paste:${callback ? `${copy(callback, 'Copy', 'Callback URL')}` : ' <i>(the callback URL appears here after you save the address)</i>'}${copy(String(channel.config.verifyToken ?? ''), 'Copy', 'Verify token')}Press <b>Verify and save</b>, then under Webhook fields press <b>Manage</b> and subscribe to <b>messages</b>. The status above turns to “Webhook verified”.</li>
        <li>${identity?.link ? link(identity.link, 'Message your WhatsApp number') : 'Message your WhatsApp business number from your phone.'}</li>${pairStep}</ol>`; break;
    }
    case 'bridge': {
      // The endpoint and token are fetched on demand, never in the listing, so they are
      // revealed by an explicit action rather than being rendered with the panel.
      const endpoint = publicUrl || `http://127.0.0.1:${port}`;
      body = `<ol>
        <li><button type="button" class="primary-button bots-step-button" data-bridge-setup="${escape(channel.id)}">Show setup and copy exports</button> Copies the three variables the helper reads, including this channel’s token.</li>
        <li><b>Run your adapter</b> next to the platform you are bridging. The endpoint is <code>${escape(endpoint)}/api/bridge/${escape(channel.id)}</code>: <code>POST …/messages</code> carries a message in and <code>GET …/events</code> long-polls replies. The helper script in <code>examples/pandacode-bridge.sh</code> is a plain <code>curl</code> client with no dependency.</li>
        <li><b>Where does it land?</b> A bridge can run entirely on this computer (a local <code>signal-cli</code>, a Tunnel-free Mattermost bot on your LAN). A platform that must call you from the internet needs a tunnel first.${copy(`tailscale serve --bg ${port}`, 'Copy', 'Or run')}</li>
        <li><label class="bots-switch-row"><input type="checkbox" class="bots-switch" data-remote="${escape(channel.id)}" ${channel.config.remote ? 'checked' : ''}><span><b>Accept calls through a tunnel</b><small>Otherwise only this computer may post. The token is still required either way.</small></span></label></li>
        ${channel.config.remote ? `<li><label class="bots-field"><span>Paste the public https address</span><span class="bots-inline-form"><input data-public-url="${escape(channel.id)}" placeholder="https://….trycloudflare.com" value="${escape(typedUrl)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-save-public="${escape(channel.id)}">Save</button></span></label></li>` : ''}
        <li><button type="button" class="secondary-button bots-step-button" data-bridge-rotate="${escape(channel.id)}">New token</button> Replaces the token and stops any adapter still using the old one.</li>
        ${pairStep}</ol>`; break;
    }
    case 'web':
      body = `<ol><li><button type="button" class="primary-button bots-step-button" data-web-open="${escape(channel.id)}">Open web chat</button> On this computer, that’s it.</li>
        <li><label class="bots-switch-row"><input type="checkbox" class="bots-switch" data-remote="${escape(channel.id)}" ${channel.config.remote ? 'checked' : ''}><span><b>Use from my phone and other devices</b><small>Allows the page through a private tunnel. The link still works only with its token.</small></span></label></li>
        ${channel.config.remote ? `<li>Install Tailscale on this computer and your phone and sign in to both. Then run this in Terminal:${copy(`tailscale serve --bg ${port}`, 'Copy', 'Run')}It shows an address like <code>https://your-mac.tailnet.ts.net</code>.</li>
        <li><label class="bots-field"><span>Paste that https address</span><span class="bots-inline-form"><input data-public-url="${escape(channel.id)}" placeholder="https://your-mac.tailnet.ts.net" value="${escape(typedUrl)}" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" data-save-public="${escape(channel.id)}">Save</button></span></label></li>
        ${publicUrl ? `<li><button type="button" class="primary-button bots-step-button" data-phone-link="${escape(channel.id)}">Copy link for my phone</button> Open it on your phone; add it to your home screen to use it like an app.</li>` : ''}` : ''}</ol>`; break;
  }
  const fallback = channel.kind === 'web' || channel.kind === 'bridge' ? Boolean(channel.config.remote) : !paired;
  const open = guides.get(channel.id) ?? fallback;
  return `${warnings}<details class="bots-guide" data-guide="${escape(channel.id)}" data-default="${fallback ? 'open' : 'closed'}" ${open ? 'open' : ''}><summary>${channel.kind === 'web' ? 'How to use' : paired ? 'How to use' : 'Finish setting up'}</summary>${body}</details>`;
}

async function webLink(context: PanelContext, channelId: string): Promise<string> { return context.call<string>('bot_web_link', { channelId }); }

export async function bridgeSetup(context: PanelContext, channelId: string): Promise<Setup> { return context.call<Setup>('bot_bridge_setup', { channelId }); }

/** Returns true when the click was a setup action. */
export function connectClick(target: HTMLElement, context: PanelContext): boolean {
  const data = target.dataset;
  const detail = context.detail(); if (!detail) return false;
  const done = async (text: string) => { context.notify(text); await context.reload(); };
  if (data.addKind !== undefined) { adding = (data.addKind || null) as ChannelKind | null; tested = null; context.rerender(); target.closest('.bots-panel')?.querySelector<HTMLInputElement>('.bots-connect input')?.focus(); return true; }
  if (data.openUrl) { void context.work(async () => { await context.call('open_external_url', { url: data.openUrl }); }); return true; }
  if (data.copy) { void context.work(async () => { await navigator.clipboard.writeText(data.copy!); context.notify('Copied'); }); return true; }
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
  if (data.bridgeSetup) {
    void context.work(async () => { await navigator.clipboard.writeText((await bridgeSetup(context, data.bridgeSetup!)).env); context.notify('Setup copied. Paste it where your adapter runs.'); });
    return true;
  }
  if (data.bridgeRotate) {
    context.confirm('Create a new bridge token?', 'Any adapter still using the current token stops working right away. Use this if it was shared by mistake.', 'New token', async () => {
      await navigator.clipboard.writeText((await context.call<Setup>('bot_bridge_new_token', { channelId: data.bridgeRotate })).env);
      await done('New token copied');
    });
    return true;
  }
  if (data.webCopy) { void context.work(async () => { await navigator.clipboard.writeText(await webLink(context, data.webCopy!)); context.notify('Private link copied. Anyone with it can talk to this bot.'); }); return true; }
  if (data.webRotate) { context.confirm('Create a new web chat link?', 'Pages opened with the current link stop working right away. Use this if the link was shared by mistake.', 'New link', async () => { await navigator.clipboard.writeText(await context.call<string>('bot_web_new_link', { channelId: data.webRotate })); await done('New link copied'); }); return true; }
  if (data.phoneLink) {
    const channel = detail.channels.find(item => item.id === data.phoneLink);
    void context.work(async () => {
      const local = new URL(await webLink(context, data.phoneLink!));
      await navigator.clipboard.writeText(`${String(channel?.config.publicUrl ?? '')}${local.pathname}${local.hash}`);
      context.notify('Phone link copied. Send it to yourself and open it on your phone.');
    });
    return true;
  }
  if (data.savePublic) {
    const field = target.closest('li')?.querySelector<HTMLInputElement>(`[data-public-url="${CSS.escape(data.savePublic)}"]`);
    void context.work(async () => { await context.call('bot_channel_configure', { channelId: data.savePublic, config: { publicUrl: field?.value ?? '' } }); values.delete(`public:${data.savePublic}`); await done('Address saved'); });
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
    context.notify(`${kindLabel(kind)} connected`);
    await context.reload();
  });
  return true;
}
