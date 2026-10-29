/* Settings → Agents → Cloud sandboxes: connect Daytona, Cloudflare, AWS and the keyed sandbox
 * providers so agents can create and use cloud machines (and run on them as cloud agents), and
 * Vercel, Railway, Netlify and Google Cloud for deploys. Keys go straight to the OS keychain natively;
 * this view never reads them back. */
import './cloud-settings.css';
import { escape, icon, isImeKey } from './dom';
import { errorText } from './error-text';
import { infoMark } from './tooltip';
import { t } from './i18n.ts';

export type CloudConnection = { provider: 'daytona' | 'cloudflare' | 'aws' | 'vercel' | 'railway' | 'netlify' | 'gcloud' | 'docker' | 'colab' | KeyedProvider; connected: boolean; detail: string | null; sandboxes?: boolean; inheritEnvironment?: boolean };
/** `colab-sign-in` events while Google Colab signs in from Settings. */
export type ColabSignInUpdate = { id: number; state: 'installing' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'; url?: string; message?: string; detail?: string };
/** `cloud_colab_sign_in_status`: the sign-in still running in the background, if any. */
export type ColabSignInStatus = { id: number; state: 'installing' | 'waiting' | 'exchanging'; url?: string; message?: string } | null;
/** `cloud_colab_usage`: compute units, fetched from Google apart from the instant local config. */
export type ColabUsage = { ccuBalance: number | null; ccuRate: number | null };
export type ColabAccelerator = 'NONE' | 'T4' | 'L4' | 'G4' | 'A100' | 'H100' | 'V5E1' | 'V6E1';
/** `cloud_colab_config`: the saved Colab defaults and which local tools it can use. */
export type ColabConfig = {
  connected: boolean; email: string | null; authMode: 'oauth2' | 'adc'; accelerator: ColabAccelerator; highMem: boolean;
  nativeTools: boolean; colabMcp: boolean; colabCliInstalled: boolean; uvxInstalled: boolean; gcloudInstalled: boolean;
  ccuBalance?: number | null; ccuRate?: number | null;
};
type CloudEvents = { 'cloud-setup': { provider: string; label: string }; 'colab-sign-in': ColabSignInUpdate };
export type CloudSettingsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<K extends keyof CloudEvents>(name: K, callback: (event: CloudEvents[K]) => void): Promise<() => void>;
};

/** `sparse` options are sent only when filled (the cloud agent fields added to deploy providers). */
type Field = { name: string; label: string; placeholder: string; secret?: boolean; optional?: boolean; sparse?: boolean };
/* Sandbox providers that connect with one API key (docs/cloud-agents.md → Provider settings). */
const KEYED = {
  digitalocean: { name: 'DigitalOcean', key: t('API token'), docs: 'cloud.digitalocean.com/account/api/tokens', fields: [{ name: 'region', label: t('Region'), placeholder: 'Optional, e.g. nyc1', optional: true }] },
  vultr: { name: 'Vultr', key: t('API key'), docs: 'my.vultr.com/settings → API', fields: [{ name: 'region', label: t('Region'), placeholder: 'Optional, e.g. ewr', optional: true }] },
  hetzner: { name: 'Hetzner', key: t('API token'), docs: 'console.hetzner.cloud → Security → API tokens', fields: [{ name: 'location', label: t('Location'), placeholder: 'Optional, e.g. fsn1', optional: true }] },
  runpod: { name: 'RunPod', key: t('API key'), docs: 'runpod.io → Settings → API Keys', fields: [{ name: 'gpu', label: t('GPU type'), placeholder: 'Optional, e.g. NVIDIA RTX 3090', optional: true }, { name: 'image', label: t('Image'), placeholder: 'Optional, an image with SSH built in', optional: true }] },
  e2b: { name: 'E2B', key: t('API key'), docs: 'e2b.dev/dashboard → API keys', fields: [] },
  modal: { name: 'Modal', key: t('Token secret'), docs: 'modal.com/settings/tokens', fields: [{ name: 'tokenId', label: t('Token ID'), placeholder: 'ak-…' }, { name: 'environment', label: t('Environment'), placeholder: t('Optional'), optional: true }] },
  codesandbox: { name: 'CodeSandbox', key: t('API key'), docs: 'codesandbox.io/t/api', fields: [] },
  runloop: { name: 'Runloop', key: t('API key'), docs: 'platform.runloop.ai → Settings', fields: [] },
  blaxel: { name: 'Blaxel', key: t('API key'), docs: 'app.blaxel.ai → Workspace settings → API keys', fields: [{ name: 'workspace', label: t('Workspace'), placeholder: t('Workspace name') }] },
  tensorlake: { name: 'Tensorlake', key: t('API key'), docs: 'cloud.tensorlake.ai → API keys', fields: [] },
  freestyle: { name: 'Freestyle', key: t('API key'), docs: 'admin.freestyle.sh → API keys', fields: [] },
  boat: { name: 'boat', key: t('API key'), docs: 'your boat dashboard', fields: [{ name: 'apiUrl', label: t('API URL'), placeholder: t('Optional'), optional: true }] },
  instabox: { name: 'InstaBox', key: t('API key'), docs: 'instabox.sh → API keys', fields: [] },
} satisfies Record<string, { name: string; key: string; docs: string; fields: Field[] }>;
type KeyedProvider = keyof typeof KEYED;
const PROVIDERS: Record<CloudConnection['provider'], { name: string; summary: string; key?: Field; fields: Field[]; note: string; connect: string }> = {
  daytona: {
    name: 'Daytona', summary: t('Linux desktops agents can see and control.'),
    key: { name: 'key', label: t('API key'), placeholder: 'dtn_…', secret: true },
    fields: [{ name: 'organization', label: t('Organization ID'), placeholder: t('Optional'), optional: true }, { name: 'apiUrl', label: t('API URL'), placeholder: 'https://app.daytona.io/api', optional: true }],
    note: t('Create a key at app.daytona.io → Keys. Sandboxes stop after 15 idle minutes.'), connect: t('Connect'),
  },
  cloudflare: {
    name: 'Cloudflare', summary: t('Deploys to Workers and Pages, and container sandboxes.'),
    key: { name: 'key', label: t('API token'), placeholder: t('Workers Scripts, Pages and Containers: Edit'), secret: true },
    fields: [{ name: 'account', label: t('Account ID'), placeholder: t('32 hexadecimal characters') }],
    note: t('Agents deploy with Wrangler using this token. Container sandboxes are a separate one-time setup that deploys a small PandaCode Worker; it needs Docker running and a Workers Paid plan.'), connect: t('Connect'),
  },
  aws: {
    name: 'AWS', summary: t('EC2 Linux and Windows desktops, and AgentCore.'),
    fields: [{ name: 'region', label: t('Region'), placeholder: 'us-east-1' }, { name: 'profile', label: t('CLI profile'), placeholder: t('Optional'), optional: true }],
    note: t('Uses your AWS CLI sign-in (run `aws login` first). Desktops have no open ports; PandaCode reaches them through Systems Manager, which needs the Session Manager plugin for screens.'), connect: t('Connect'),
  },
  vercel: {
    name: 'Vercel', summary: t('Deploys by agents, preview and production.'),
    key: { name: 'key', label: t('Access token'), placeholder: 'vercel.com/account/tokens', secret: true },
    fields: [{ name: 'team', label: t('Team slug'), placeholder: t('Optional'), optional: true }, { name: 'projectId', label: t('Sandbox project ID'), placeholder: t('Optional; for cloud agents'), optional: true, sparse: true }, { name: 'teamId', label: t('Sandbox team ID'), placeholder: t('Optional; for cloud agents'), optional: true, sparse: true }],
    note: t('Agents run the Vercel CLI with this token; it never enters their prompts. Cloud agents on Vercel Sandbox also need the project ID, and the team ID for a team project.'), connect: t('Connect'),
  },
  railway: {
    name: 'Railway', summary: t('Deploys by agents: servers, containers and databases.'),
    key: { name: 'key', label: t('API token'), placeholder: 'railway.com/account/tokens', secret: true },
    fields: [{ name: 'workspace', label: t('Workspace ID'), placeholder: t('Optional; needed for a workspace token'), optional: true }],
    note: t('Use an account token, or a workspace token with its workspace ID. Agents run the Railway CLI with it (fetched on first use if it is not installed); it never enters their prompts.'), connect: t('Connect'),
  },
  netlify: {
    name: 'Netlify', summary: 'Deploys by agents, draft and production.',
    key: { name: 'key', label: 'Personal access token', placeholder: 'Netlify user settings / Applications', secret: true },
    fields: [{ name: 'siteId', label: 'Project ID', placeholder: 'Optional; from Project configuration', optional: true }],
    note: 'Create a personal access token in Netlify user settings. The optional project ID selects an existing project; otherwise the CLI uses this checkout. Tokens never enter agent prompts.', connect: 'Connect',
  },
  gcloud: {
    name: 'Google Cloud', summary: t('Deploys by agents: Cloud Run and Cloud Storage.'),
    fields: [{ name: 'project', label: t('Project ID'), placeholder: 'my-app-123456' }, { name: 'region', label: t('Region'), placeholder: t('Optional, such as us-central1'), optional: true }, { name: 'zone', label: t('Zone'), placeholder: t('Optional; for cloud agent VMs, such as us-central1-a'), optional: true, sparse: true }],
    note: t('Uses your installed gcloud CLI and its sign-in (run `gcloud auth login` first); PandaCode downloads nothing and stores only the project, region and zone.'), connect: t('Connect'),
  },
  docker: {
    name: 'Docker', summary: 'Containers on this machine or any Docker host.',
    fields: [{ name: 'engine', label: 'Engine', placeholder: 'Optional; docker (default), podman, apple or lxc', optional: true }, { name: 'endpoint', label: 'Docker host', placeholder: 'Optional; empty for this machine, ssh://user@host or tcp://host:2376', optional: true }, { name: 'image', label: 'Image', placeholder: 'Optional, e.g. ubuntu:24.04', optional: true }, { name: 'tlsCa', label: 'TLS CA path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }, { name: 'tlsCert', label: 'TLS cert path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }, { name: 'tlsKey', label: 'TLS key path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }],
    note: 'Runs each task in its own container (label or name prefix pandacode) — Docker, Podman, Apple Containers, or the lxc client (LXD/Incus, which uses its own configured remotes; Podman remote hosts take ssh://). For ssh:// and tcp:// hosts, that daemon is root-equivalent — only point at machines you trust. Containers keep their disk until deleted and use this machine’s or the host’s resources; nothing is billed.', connect: 'Connect',
  },
  ...Object.fromEntries(Object.entries(KEYED).map(([id, provider]) => [id, {
    name: provider.name, summary: t('Cloud machines for agents.'),
    key: { name: 'key', label: provider.key, placeholder: provider.docs, secret: true }, fields: provider.fields,
    note: t`Create a key at ${provider.docs}. Cloud agents run on machines in your own account.`, connect: t('Connect'),
  }])) as Record<KeyedProvider, { name: string; summary: string; key?: Field; fields: Field[]; note: string; connect: string }>,
};
/** `cloud_instabox_images`: what new InstaBox machines can start from, and the saved choice. */
type InstaboxImages = { images: { value: string; label: string }[]; selected: string };
const IMAGE_HELP = t('New InstaBox machines start from this image. Snapshots are listed once they are ready; to run agents without the desktop tool agent-browser includes, make a snapshot as docs/cloud-agents.md describes.');
const CLAUDE_TOKEN_HELP = t('Run `claude setup-token` and paste the long-lived token it prints. Without one, PandaCode copies this computer’s Claude Code login to the machine before each run.');
const INHERIT_HELP = 'When on, cloud agents this provider runs also get the environment variables saved for the harness in Settings → Providers — a proxy the cloud machine can reach, for example. Off by default: nothing is sent to this cloud. Variables that point at this computer (a localhost HTTP_PROXY) are refused when a task starts, because a cloud machine cannot reach them.';

const failure = (error: unknown) => errorText(error, 'The request failed. Try again.');

export function mountCloudSettings(host: HTMLElement, options: CloudSettingsHost): () => void {
  host.innerHTML = `<div class="settings-group cloud-settings" aria-label="${t('Cloud sandboxes')}"><div class="cloud-provider cloud-claude">
      <div class="setting-row"><div><strong>${t('Claude login for cloud agents')}</strong>${infoMark(CLAUDE_TOKEN_HELP, t('About the Claude login'))}<small class="cloud-detail">${t('Optional long-lived token')}</small></div></div>
      <form class="cloud-form cloud-claude-form" novalidate aria-label="${t('Claude login for cloud agents')}">
        <label><span>${t('Token')}</span><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="${t('From claude setup-token')}" aria-label="${t('Claude token for cloud agents')}" required></label>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="submit" class="primary-button">${t('Save token')}</button></div>
      </form>
    </div>${(Object.keys(PROVIDERS) as CloudConnection['provider'][]).map(id => {
    const provider = PROVIDERS[id];
    const fields = [...(provider.key ? [provider.key] : []), ...provider.fields];
    return `<div class="cloud-provider" data-provider="${id}">
      <div class="setting-row"><div><strong>${escape(provider.name)}</strong><small class="cloud-detail">${escape(provider.summary)}</small></div><div class="cloud-buttons">${id === 'cloudflare' ? `<button type="button" class="secondary-button" data-cloud="sandboxes" hidden>${t('Set up sandboxes')}</button>` : ''}<button type="button" class="secondary-button" data-cloud="toggle">${t('Connect')}</button></div></div>
      <p class="cloud-progress cloud-row-status" role="status" hidden></p>
      <div class="cloud-inherit" data-inherit-row hidden><label><input type="checkbox" data-cloud-inherit> Include provider environment variables</label>${infoMark(INHERIT_HELP, 'About inheriting environment variables')}</div>${id === 'instabox' ? `
      <div class="cloud-image" hidden>
        <div class="cloud-image-row"><label><span>${t('Machine image')}</span><select aria-label="${t('InstaBox machine image')}" disabled></select></label>${infoMark(IMAGE_HELP, t('About machine images'))}</div>
        <p class="cloud-image-status" role="status" hidden></p>
        <p class="cloud-image-error" role="alert" hidden></p>
        <div class="cloud-actions" hidden><button type="button" class="secondary-button" data-cloud="images">${t('Try again')}</button></div>
      </div>` : ''}
      <form class="cloud-form" hidden novalidate aria-label="${escape(t`Connect ${provider.name}`)}">
        ${fields.map(field => `<label><span>${escape(field.label)}</span><input name="${field.name}" type="${field.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${escape(field.placeholder)}" aria-label="${escape(`${provider.name} ${field.label}`)}" ${field.optional ? '' : 'required'}></label>`).join('')}
        <p class="cloud-note">${escape(provider.note)}</p>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="button" class="secondary-button" data-cloud="cancel">${t('Cancel')}</button><button type="submit" class="primary-button">${escape(provider.connect)}</button></div>
      </form>
    </div>`;
  };
  // The keyed long tail folds away; the fold opens by itself once one of them is connected.
  host.innerHTML = `<div class="settings-group cloud-settings" aria-label="Cloud providers">${ids.filter(id => !(id in KEYED)).map(providerRow).join('')}</div>
    <details class="settings-fold cloud-more"><summary><h3>More cloud machines</h3>${icon('chevron')}</summary><div class="settings-group cloud-settings" aria-label="More cloud machines">${ids.filter(id => id in KEYED).map(providerRow).join('')}</div></details>
    <details class="settings-fold"><summary><h3>Advanced</h3>${icon('chevron')}</summary><div class="settings-group cloud-settings" aria-label="Cloud sandboxes"><div class="cloud-provider cloud-claude">
      <div class="setting-row"><div><strong>Claude login for cloud agents</strong>${infoMark(CLAUDE_TOKEN_HELP, 'About the Claude login')}</div></div>
      <form class="cloud-form cloud-claude-form" novalidate aria-label="Claude login for cloud agents">
        <label><span>Token</span><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="From claude setup-token" aria-label="Claude token for cloud agents" required></label>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="submit" class="primary-button">Save token</button></div>
      </form>
    </div></div></details>`;
  let connections: CloudConnection[] = [], disposed = false, busy = '';
  let stopListening: (() => void) | undefined;
  const section = (id: string) => host.querySelector<HTMLElement>(`.cloud-provider[data-provider="${id}"]`)!;

  /* Connected providers first, then the rest, each alphabetical by name. Connected ones are never behind the
   * fold, which holds only the unconnected one-key providers. The Claude login card is never a provider card. */
  function arrange(): void {
    const [grid, more] = host.querySelectorAll<HTMLElement>('.cloud-settings');
    const name = (id: CloudConnection['provider']) => PROVIDERS[id].name.toLowerCase();
    const on = (id: CloudConnection['provider']) => connections.some(c => c.provider === id && c.connected);
    const ids = (Object.keys(PROVIDERS) as CloudConnection['provider'][]).sort((a, b) => Number(on(b)) - Number(on(a)) || name(a).localeCompare(name(b)));
    const home = (id: CloudConnection['provider']) => on(id) || !(id in KEYED) ? grid : more;
    if (ids.every(id => section(id).parentElement === home(id)) && [grid, more].every(group => {
      const shown = [...group.querySelectorAll<HTMLElement>(':scope > .cloud-provider[data-provider]')].map(card => card.dataset.provider);
      return ids.filter(id => home(id) === group).every((id, index) => shown[index] === id);
    })) return;
    // Moving a card blurs whatever inside it had focus (the Disconnect button), so put focus back, opening the fold it landed behind.
    const active = document.activeElement;
    for (const id of ids) home(id).append(section(id));
    if (active instanceof HTMLElement && host.contains(active) && document.activeElement !== active) {
      if (more.contains(active)) host.querySelector<HTMLDetailsElement>('.cloud-more')!.open = true;
      active.focus({ preventScroll: true });
    }
  }

  function render(): void {
    for (const id of Object.keys(PROVIDERS) as CloudConnection['provider'][]) {
      const connection = connections.find(c => c.provider === id), root = section(id);
      const toggle = root.querySelector<HTMLButtonElement>('[data-cloud="toggle"]')!;
      const form = root.querySelector<HTMLFormElement>('form')!;
      const sandboxes = id === 'cloudflare' && connection?.connected ? (connection.sandboxes ? ` · ${t('sandboxes ready')}` : ` · ${t('sandboxes not set up')}`) : '';
      root.querySelector('.cloud-detail')!.textContent = connection?.connected ? `${t('Connected')}${connection.detail ? ` · ${connection.detail}` : ''}${sandboxes}` : PROVIDERS[id].summary;
      const setup = root.querySelector<HTMLButtonElement>('[data-cloud="sandboxes"]');
      if (setup) { setup.hidden = !connection?.connected || Boolean(connection.sandboxes); setup.disabled = Boolean(busy); }
