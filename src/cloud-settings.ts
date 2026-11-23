/* Settings → Agents → Cloud sandboxes: connect Daytona, Cloudflare, AWS and the keyed sandbox
 * providers so agents can create and use cloud machines (and run on them as cloud agents), and
 * Vercel, Railway, Netlify and Google Cloud for deploys. Keys go straight to the OS keychain natively;
 * this view never reads them back. */
import './cloud-settings.css';
import { escape, icon, isImeKey } from './dom';
import { errorText } from './error-text';
import { infoMark } from './tooltip';

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
  digitalocean: { name: 'DigitalOcean', key: 'API token', docs: 'cloud.digitalocean.com/account/api/tokens', fields: [] },
  vultr: { name: 'Vultr', key: 'API key', docs: 'my.vultr.com/settings → API', fields: [{ name: 'region', label: 'Region', placeholder: 'Optional, e.g. ewr', optional: true }] },
  hetzner: { name: 'Hetzner', key: 'API token', docs: 'console.hetzner.cloud → Security → API tokens', fields: [{ name: 'location', label: 'Location', placeholder: 'Optional, e.g. fsn1', optional: true }] },
  runpod: { name: 'RunPod', key: 'API key', docs: 'runpod.io → Settings → API Keys', fields: [{ name: 'gpu', label: 'GPU type', placeholder: 'Optional, e.g. NVIDIA RTX 3090', optional: true }, { name: 'image', label: 'Image', placeholder: 'Optional, an image with SSH built in', optional: true }] },
  e2b: { name: 'E2B', key: 'API key', docs: 'e2b.dev/dashboard → API keys', fields: [] },
  modal: { name: 'Modal', key: 'Token secret', docs: 'modal.com/settings/tokens', fields: [{ name: 'tokenId', label: 'Token ID', placeholder: 'ak-…' }, { name: 'environment', label: 'Environment', placeholder: 'Optional', optional: true }] },
  codesandbox: { name: 'CodeSandbox', key: 'API key', docs: 'codesandbox.io/t/api', fields: [] },
  runloop: { name: 'Runloop', key: 'API key', docs: 'platform.runloop.ai → Settings', fields: [] },
  blaxel: { name: 'Blaxel', key: 'API key', docs: 'app.blaxel.ai → Workspace settings → API keys', fields: [{ name: 'workspace', label: 'Workspace', placeholder: 'Workspace name' }] },
  tensorlake: { name: 'Tensorlake', key: 'API key', docs: 'cloud.tensorlake.ai → API keys', fields: [] },
  freestyle: { name: 'Freestyle', key: 'API key', docs: 'admin.freestyle.sh → API keys', fields: [] },
  boat: { name: 'boat', key: 'API key', docs: 'your boat dashboard', fields: [{ name: 'apiUrl', label: 'API URL', placeholder: 'Optional', optional: true }] },
  instabox: { name: 'InstaBox', key: 'API key', docs: 'instabox.sh → API keys', fields: [] },
} satisfies Record<string, { name: string; key: string; docs: string; fields: Field[] }>;
type KeyedProvider = keyof typeof KEYED;
const PROVIDERS: Record<CloudConnection['provider'], { name: string; summary: string; key?: Field; fields: Field[]; note: string; connect: string }> = {
  daytona: {
    name: 'Daytona', summary: 'Linux desktops agents can see and control.',
    key: { name: 'key', label: 'API key', placeholder: 'dtn_…', secret: true },
    fields: [{ name: 'organization', label: 'Organization ID', placeholder: 'Optional', optional: true }, { name: 'apiUrl', label: 'API URL', placeholder: 'https://app.daytona.io/api', optional: true }],
    note: 'Create a key at app.daytona.io → Keys. Sandboxes stop after 15 idle minutes.', connect: 'Connect',
  },
  cloudflare: {
    name: 'Cloudflare', summary: 'Deploys to Workers and Pages, and container sandboxes.',
    key: { name: 'key', label: 'API token', placeholder: 'Workers Scripts, Pages and Containers: Edit', secret: true },
    fields: [{ name: 'account', label: 'Account ID', placeholder: '32 hexadecimal characters' }],
    note: 'Agents deploy with Wrangler using this token. Container sandboxes are a separate one-time setup that deploys a small PandaCode Worker; it needs Docker running and a Workers Paid plan.', connect: 'Connect',
  },
  aws: {
    name: 'AWS', summary: 'EC2 Linux and Windows desktops, and AgentCore.',
    fields: [{ name: 'region', label: 'Region', placeholder: 'us-east-1' }, { name: 'profile', label: 'CLI profile', placeholder: 'Optional', optional: true }],
    note: 'Uses your AWS CLI sign-in (run `aws login` first). Desktops have no open ports; PandaCode reaches them through Systems Manager, which needs the Session Manager plugin for screens.', connect: 'Connect',
  },
  vercel: {
    name: 'Vercel', summary: 'Deploys by agents, preview and production.',
    key: { name: 'key', label: 'Access token', placeholder: 'vercel.com/account/tokens', secret: true },
    fields: [{ name: 'team', label: 'Team slug', placeholder: 'Optional', optional: true }, { name: 'projectId', label: 'Sandbox project ID', placeholder: 'Optional; for cloud agents', optional: true, sparse: true }, { name: 'teamId', label: 'Sandbox team ID', placeholder: 'Optional; for cloud agents', optional: true, sparse: true }],
    note: 'Agents run the Vercel CLI with this token; it never enters their prompts. Cloud agents on Vercel Sandbox also need the project ID, and the team ID for a team project.', connect: 'Connect',
  },
  railway: {
    name: 'Railway', summary: 'Deploys by agents: servers, containers and databases.',
    key: { name: 'key', label: 'API token', placeholder: 'railway.com/account/tokens', secret: true },
    fields: [{ name: 'workspace', label: 'Workspace ID', placeholder: 'Optional; needed for a workspace token', optional: true }],
    note: 'Use an account token, or a workspace token with its workspace ID. Agents run the Railway CLI with it (fetched on first use if it is not installed); it never enters their prompts.', connect: 'Connect',
  },
  netlify: {
    name: 'Netlify', summary: 'Deploys by agents, draft and production.',
    key: { name: 'key', label: 'Personal access token', placeholder: 'Netlify user settings / Applications', secret: true },
    fields: [{ name: 'siteId', label: 'Project ID', placeholder: 'Optional; from Project configuration', optional: true }],
    note: 'Create a personal access token in Netlify user settings. The optional project ID selects an existing project; otherwise the CLI uses this checkout. Tokens never enter agent prompts.', connect: 'Connect',
  },
  gcloud: {
    name: 'Google Cloud', summary: 'Deploys by agents: Cloud Run and Cloud Storage.',
    fields: [{ name: 'project', label: 'Project ID', placeholder: 'my-app-123456' }, { name: 'region', label: 'Region', placeholder: 'Optional, such as us-central1', optional: true }, { name: 'zone', label: 'Zone', placeholder: 'Optional; for cloud agent VMs, such as us-central1-a', optional: true, sparse: true }],
    note: 'Uses your installed gcloud CLI and its sign-in (run `gcloud auth login` first); PandaCode downloads nothing and stores only the project, region and zone.', connect: 'Connect',
  },
  docker: {
    name: 'Docker', summary: 'Containers on this machine or any Docker host.',
    fields: [{ name: 'engine', label: 'Engine', placeholder: 'Optional; docker (default), podman, apple or lxc', optional: true }, { name: 'endpoint', label: 'Docker host', placeholder: 'Optional; empty for this machine, ssh://user@host or tcp://host:2376', optional: true }, { name: 'image', label: 'Image', placeholder: 'Optional, e.g. ubuntu:24.04', optional: true }, { name: 'tlsCa', label: 'TLS CA path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }, { name: 'tlsCert', label: 'TLS cert path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }, { name: 'tlsKey', label: 'TLS key path', placeholder: 'Optional; for tcp:// Docker hosts', optional: true, sparse: true }],
    note: 'Runs each task in its own container (label or name prefix pandacode) — Docker, Podman, Apple Containers, or the lxc client (LXD/Incus, which uses its own configured remotes; Podman remote hosts take ssh://). For ssh:// and tcp:// hosts, that daemon is root-equivalent — only point at machines you trust. Containers keep their disk until deleted and use this machine’s or the host’s resources; nothing is billed.', connect: 'Connect',
  },
  colab: {
    name: 'Google Colab', summary: 'Cloud GPU/TPU runtimes for cloud agents, native Python execution, and browser notebooks.',
    fields: [{ name: 'oauthConfigPath', label: 'OAuth client file', placeholder: 'Optional; path to a client_secret JSON', optional: true }],
    note: 'Sign in with Google opens your browser through the Colab CLI (installed on first use). Google’s sign-in prompt names the Colab CLI, not PandaCode. To use your own OAuth client, give its file here. Use gcloud ADC signs in with `gcloud auth application-default login` instead, which replaces your application-default credentials in ~/.config/gcloud. PandaCode keeps the Google tokens in its secret store.', connect: 'Sign in',
  },
  ...Object.fromEntries(Object.entries(KEYED).map(([id, provider]) => [id, {
    name: provider.name, summary: 'Cloud machines for agents.',
    key: { name: 'key', label: provider.key, placeholder: provider.docs, secret: true }, fields: provider.fields,
    note: `Create a key at ${provider.docs}. Cloud agents run on machines in your own account.`, connect: 'Connect',
  }])) as Record<KeyedProvider, { name: string; summary: string; key?: Field; fields: Field[]; note: string; connect: string }>,
};
/** `cloud_instabox_images`: what new InstaBox machines can start from, and the saved choice. */
type InstaboxImages = { images: { value: string; label: string }[]; selected: string };
/** `cloud_digitalocean_catalog`: the account's droplet regions and sizes, and the saved pair. */
type DoCatalog = { regions: { value: string; label: string }[]; sizes: { value: string; label: string; regions: string[] }[]; region: string; size: string };
const IMAGE_HELP = 'New InstaBox machines start from this image. Snapshots are listed once they are ready; to run agents without the desktop tool agent-browser includes, make a snapshot as docs/cloud-agents.md describes.';
const CLAUDE_TOKEN_HELP = 'Run `claude setup-token` and paste the long-lived token it prints. Without one, PandaCode copies this computer’s Claude Code login to the machine before each run.';
const ACCELERATORS: [ColabAccelerator, string][] = [['NONE', 'CPU (Standard)'], ['T4', 'T4 GPU'], ['L4', 'L4 GPU'], ['G4', 'G4 GPU'], ['A100', 'A100 GPU'], ['H100', 'H100 GPU'], ['V5E1', 'v5e-1 TPU'], ['V6E1', 'v6e-1 TPU']];
/** Hardware Colab offers in one memory shape only, so High-RAM does not apply. */
const SINGLE_SHAPE: ReadonlySet<ColabAccelerator> = new Set(['L4', 'V5E1', 'V6E1']);
const COLAB_SIGN_IN_STEPS: Record<'installing' | 'waiting' | 'exchanging', string> = { installing: 'Installing the Colab CLI…', waiting: 'Finish signing in with Google in your browser…', exchanging: 'Finishing sign-in…' };
const COLAB_NATIVE_HELP = 'Gives agents pandacode_colab_* and pandacode_vm_* tools: a persistent Jupyter Python kernel on a Colab runtime, shell commands and files. Runtimes use your Colab compute units while they run.';
const COLAB_MCP_HELP = 'Attaches Google’s official colab-mcp server (run with uvx) to local agent runs, so models can edit and run cells in the Colab notebook open in your browser.';
const COLAB_CONFIG_LABELS = { highMem: 'High-RAM', nativeTools: 'native Colab tools', colabMcp: 'colab-mcp' } as const;
const INHERIT_HELP = 'When on, cloud agents this provider runs also get the environment variables saved for the harness in Settings → Agents → Providers — a proxy the cloud machine can reach, for example. Off by default: nothing is sent to this cloud. Variables that point at this computer (a localhost HTTP_PROXY) are refused when a task starts, because a cloud machine cannot reach them.';

const failure = (error: unknown) => errorText(error, 'The request failed. Try again.');

/** While Google Colab signs in: the browser link (if the CLI printed one) and Cancel. */
const colabSignInRow = () => `<div class="cloud-colab-signin" hidden><a class="cloud-colab-link" href="#" target="_blank" rel="noopener noreferrer" hidden>Open sign-in link</a><button type="button" class="secondary-button" data-cloud="colab-cancel" aria-label="Cancel Google Colab sign-in">Cancel</button></div>`;
const colabCheck = (key: keyof typeof COLAB_CONFIG_LABELS, label: string, help = '') =>
  `<div class="cloud-colab-check"><label><input type="checkbox" data-colab="${key}"> ${label}</label>${help}</div>`;
/** Google Colab's defaults once connected: hardware, High-RAM, the native tools, colab-mcp and the CLI. */
const colabConfigBlock = () => `<div class="cloud-colab-config" hidden>
        <div class="cloud-image-row"><label><span>Default hardware</span><select aria-label="Google Colab default hardware" data-colab="accelerator">${ACCELERATORS.map(([value, label]) => `<option value="${value}">${escape(label)}</option>`).join('')}</select></label></div>
        ${colabCheck('highMem', 'High-RAM')}
        <p class="cloud-colab-meta" data-colab-shape hidden>This hardware comes in one memory shape, so High-RAM does not apply.</p>
        ${colabCheck('nativeTools', 'Let models run code on Colab natively', infoMark(COLAB_NATIVE_HELP, 'About native Colab tools'))}
        ${colabCheck('colabMcp', 'Colab browser notebook MCP (colab-mcp)', infoMark(COLAB_MCP_HELP, 'About colab-mcp'))}
        <p class="cloud-colab-meta" data-colab-uvx hidden>colab-mcp runs with uvx, which is not installed. Install uv to use it.</p>
        <div class="cloud-colab-cli"><span class="cloud-colab-meta" data-colab-cli-ready hidden>Colab CLI ready</span><button type="button" class="secondary-button" data-cloud="colab-install" hidden>Install Colab CLI</button></div>
        <p class="cloud-colab-meta" data-colab-ccu hidden></p>
        <p class="cloud-image-status" data-colab-status role="status" hidden></p>
      </div>`;

export function mountCloudSettings(host: HTMLElement, options: CloudSettingsHost): () => void {
  const ids = Object.keys(PROVIDERS) as CloudConnection['provider'][];
  const providerRow = (id: CloudConnection['provider']) => {
    const provider = PROVIDERS[id];
    const fields = [...(provider.key ? [provider.key] : []), ...provider.fields];
    return `<div class="cloud-provider" data-provider="${id}">
      <div class="setting-row"><div><strong>${escape(provider.name)}${id in KEYED ? '' : ` <span class="sr-only">${escape(provider.summary)}</span>`}</strong><small class="cloud-detail ds-success"></small></div><div class="cloud-buttons">${id === 'cloudflare' ? '<button type="button" class="secondary-button" data-cloud="sandboxes" hidden>Set up sandboxes</button>' : ''}${id === 'colab' ? '<button type="button" class="secondary-button" data-cloud="toggle-form" aria-expanded="false">More options</button>' : ''}<button type="button" class="secondary-button" data-cloud="toggle">Connect</button></div>${id in KEYED ? '' : infoMark(provider.summary, `About ${provider.name}`)}</div>
      <p class="cloud-progress cloud-row-status" role="status" hidden></p>
      ${id === 'colab' ? colabSignInRow() : ''}<div class="cloud-inherit" data-inherit-row hidden><label><input type="checkbox" data-cloud-inherit> Include provider environment variables</label>${infoMark(INHERIT_HELP, 'About inheriting environment variables')}</div>${id === 'colab' ? colabConfigBlock() : ''}${id === 'instabox' ? `
      <div class="cloud-image" hidden>
        <div class="cloud-image-row"><label><span>Machine image</span><select aria-label="InstaBox machine image" disabled></select></label>${infoMark(IMAGE_HELP, 'About machine images')}</div>
        <p class="cloud-image-status" role="status" hidden></p>
        <p class="cloud-image-error" role="alert" hidden></p>
        <div class="cloud-actions" hidden><button type="button" class="secondary-button" data-cloud="images">Try again</button></div>
      </div>` : ''}${id === 'digitalocean' ? `
      <div class="cloud-image" data-do-options hidden>
        <div class="cloud-image-row"><label><span>Region</span><select data-do="region" aria-label="DigitalOcean region" disabled></select></label></div>
        <div class="cloud-image-row"><label><span>Machine size</span><select data-do="size" aria-label="DigitalOcean machine size" disabled></select></label></div>
        <div class="cloud-image-row" data-do-custom hidden><label><span data-do-custom-label>Region</span><input data-do="custom" type="text" autocomplete="off" spellcheck="false" aria-label="Custom DigitalOcean region"></label><button type="button" class="secondary-button" data-cloud="do-apply">Apply</button><button type="button" class="secondary-button" data-cloud="do-cancel">Cancel</button></div>
        <p class="cloud-image-status" role="status" hidden></p>
        <p class="cloud-image-error" role="alert" hidden></p>
        <div class="cloud-actions" hidden><button type="button" class="secondary-button" data-cloud="do-retry">Try again</button></div>
      </div>` : ''}
      <form class="cloud-form" hidden novalidate aria-label="${escape(`Connect ${provider.name}`)}">
        ${fields.map(field => `<label><span>${escape(field.label)}</span><input name="${field.name}" type="${field.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${escape(field.placeholder)}" aria-label="${escape(`${provider.name} ${field.label}`)}" ${field.optional ? '' : 'required'}></label>`).join('')}
        <p class="cloud-note">${escape(provider.note)}</p>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="button" class="secondary-button" data-cloud="cancel">Cancel</button>${id === 'colab' ? '<button type="button" class="secondary-button" data-cloud="colab-adc">Use gcloud ADC</button>' : ''}<button type="submit" class="primary-button">${escape(provider.connect)}</button></div>
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
      const sandboxes = id === 'cloudflare' && connection?.connected ? (connection.sandboxes ? ' · sandboxes ready' : ' · sandboxes not set up') : '';
      root.querySelector('.cloud-detail')!.textContent = connection?.connected ? `Connected${connection.detail ? ` · ${connection.detail}` : ''}${sandboxes}` : '';
      const setup = root.querySelector<HTMLButtonElement>('[data-cloud="sandboxes"]');
      if (setup) { setup.hidden = !connection?.connected || Boolean(connection.sandboxes); setup.disabled = Boolean(busy); }
      if (id === 'colab') {
        toggle.textContent = connection?.connected ? 'Disconnect' : 'Sign in with Google';
        // The name contains the visible text (WCAG 2.5.3, label in name).
        toggle.setAttribute('aria-label', connection?.connected ? 'Disconnect Google Colab' : 'Sign in with Google for Google Colab');
      } else {
        toggle.textContent = connection?.connected ? 'Disconnect' : form.hidden ? 'Connect' : 'Close';
        toggle.disabled = Boolean(busy);
        toggle.setAttribute('aria-label', `${toggle.textContent} ${PROVIDERS[id].name}`);
      }
      form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = Boolean(busy);
      const inheritRow = root.querySelector<HTMLElement>('[data-inherit-row]')!;
      const supported = connection?.inheritEnvironment !== undefined;
      inheritRow.hidden = !supported || !connection?.connected;
      if (supported) {
        const box = inheritRow.querySelector<HTMLInputElement>('[data-cloud-inherit]')!;
        box.checked = Boolean(connection?.inheritEnvironment);
        box.disabled = Boolean(busy);
      }
    }
    renderColab();
    arrange();
  }
  async function load(): Promise<void> {
    try { connections = await options.call<CloudConnection[]>('cloud_connections'); } catch { connections = []; }
    if (!disposed) { render(); syncImages(); syncCatalog(); syncColab(); }
    if (!disposed && !colabConnected()) await restoreColabSignIn();
  }

  /* InstaBox's machine image select, filled from the API once InstaBox is connected. */
  let images: InstaboxImages | null = null, imagesError = '', imagesLoading = false, imageSaving = false;
  function renderImages(): void {
    const root = section('instabox'), box = root.querySelector<HTMLElement>('.cloud-image')!;
    const select = box.querySelector('select')!, status = box.querySelector<HTMLElement>('.cloud-image-status')!;
    const error = box.querySelector<HTMLElement>('.cloud-image-error')!, retry = box.querySelector<HTMLElement>('.cloud-actions')!;
    box.hidden = !connections.find(c => c.provider === 'instabox')?.connected;
    select.innerHTML = images ? images.images.map(image => `<option value="${escape(image.value)}">${escape(image.label)}</option>`).join('') : `<option>${imagesLoading ? 'Loading images…' : 'Not available'}</option>`;
    if (images) select.value = images.selected;
    select.disabled = !images || imageSaving;
    error.textContent = imagesError; error.hidden = !imagesError;
    retry.hidden = Boolean(images) || imagesLoading || !imagesError;
    if (!images || imagesError) status.hidden = true;
  }
  async function loadImages(): Promise<void> {
    imagesLoading = true; imagesError = ''; renderImages();
    try { images = await options.call<InstaboxImages>('cloud_instabox_images'); }
    catch (error) { images = null; imagesError = `Could not load machine images: ${failure(error)}`; }
    finally { imagesLoading = false; if (!disposed) renderImages(); }
  }
  function syncImages(): void {
    if (!connections.find(c => c.provider === 'instabox')?.connected) { images = null; imagesError = ''; renderImages(); return; }
    if (!images && !imagesLoading) void loadImages();
  }
  async function saveImage(select: HTMLSelectElement): Promise<void> {
    if (!images) return;
    const status = section('instabox').querySelector<HTMLElement>('.cloud-image-status')!, value = select.value;
    imageSaving = true; imagesError = ''; status.hidden = false; status.textContent = 'Checking…'; renderImages();
    select.value = value;
    try {
      images = await options.call<InstaboxImages>('cloud_instabox_set_image', { image: value });
      status.textContent = `Saved. New machines start from ${images.images.find(image => image.value === images!.selected)?.label ?? images.selected}.`;
    } catch (error) {
      status.hidden = true;
      imagesError = failure(error);
    } finally { imageSaving = false; if (!disposed) renderImages(); }
  }
  /* Google Colab: one-click sign-in (progress arrives as `colab-sign-in` events, each tagged with its attempt's
   * id) and its defaults once connected. `colabSignInId` is the attempt this view follows; while a start is still
   * in flight (`colabPending`) events wait in `colabEarly`, since the backend may report before it returns the id. */
  let colabSigning: ColabSignInUpdate | null = null, colabSignInId: number | null = null, colabPending = false;
  let colabEarly: ColabSignInUpdate[] = [];
  let colab: ColabConfig | null = null, colabUsage: ColabUsage | null = null, colabUsageRun = 0;
  let colabLoading = false, colabSaving = false;
  const colabConnected = () => Boolean(connections.find(c => c.provider === 'colab')?.connected);
  const colabNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  function renderColab(): void {
    const root = section('colab'), form = root.querySelector<HTMLFormElement>('form')!;
    const signing = Boolean(colabSigning) || colabPending;
    // Disconnect waits for a save or install to finish, so it never races a write to the account it removes.
    root.querySelector<HTMLButtonElement>('[data-cloud="toggle"]')!.disabled = Boolean(busy) || signing || colabSaving;
    const more = root.querySelector<HTMLButtonElement>('[data-cloud="toggle-form"]')!;
    more.hidden = colabConnected(); more.disabled = Boolean(busy) || signing;
    more.setAttribute('aria-expanded', String(!form.hidden));
    form.querySelectorAll<HTMLButtonElement>('[data-cloud="colab-adc"], [type="submit"]').forEach(button => { button.disabled = Boolean(busy) || signing; });
    const signin = root.querySelector<HTMLElement>('.cloud-colab-signin')!, link = signin.querySelector<HTMLAnchorElement>('a')!;
    signin.hidden = !colabSigning;
    link.hidden = !colabSigning?.url;
    if (colabSigning?.url) link.href = colabSigning.url;
    const box = root.querySelector<HTMLElement>('.cloud-colab-config')!;
    box.hidden = !colabConnected() || !colab;
    if (!colab) return;
    const locked = colabSaving || Boolean(busy);
    const select = box.querySelector<HTMLSelectElement>('[data-colab="accelerator"]')!;
    select.value = colab.accelerator; select.disabled = locked;
    const single = SINGLE_SHAPE.has(colab.accelerator);
    for (const key of Object.keys(COLAB_CONFIG_LABELS) as (keyof typeof COLAB_CONFIG_LABELS)[]) {
      const input = box.querySelector<HTMLInputElement>(`[data-colab="${key}"]`)!;
      // One-shape hardware ignores High-RAM, so it reads off like the runtime it makes.
      input.checked = key === 'highMem' ? colab.highMem && !single : colab[key];
      input.disabled = locked || (key === 'highMem' && single);
    }
    box.querySelector<HTMLInputElement>('[data-colab="highMem"]')!.closest('label')!.title = single ? 'This hardware comes in one memory shape.' : '';
    box.querySelector<HTMLElement>('[data-colab-shape]')!.hidden = !single;
    box.querySelector<HTMLElement>('[data-colab-uvx]')!.hidden = colab.uvxInstalled;
    box.querySelector<HTMLElement>('[data-colab-cli-ready]')!.hidden = !colab.colabCliInstalled;
    const install = box.querySelector<HTMLButtonElement>('[data-cloud="colab-install"]')!;
    install.hidden = colab.colabCliInstalled || !colab.uvxInstalled; install.disabled = locked;
    const ccu = box.querySelector<HTMLElement>('[data-colab-ccu]')!, balance = colabUsage?.ccuBalance ?? colab.ccuBalance ?? null;
    const rate = colabUsage ? colabUsage.ccuRate : colab.ccuRate ?? null;
    ccu.hidden = balance == null;
    ccu.textContent = balance == null ? '' : `Compute units: ${colabNumber.format(balance)}${rate ? ` · ${colabNumber.format(rate)} per hour at this setting` : ''}`;
  }
  function colabStatus(text: string, failed = false): void {
    const line = section('colab').querySelector<HTMLElement>('[data-colab-status]')!;
    line.hidden = !text; line.textContent = text; line.classList.toggle('cloud-error', failed);
  }
  async function loadColab(): Promise<void> {
    colabLoading = true;
    try { colab = await options.call<ColabConfig>('cloud_colab_config'); }
    catch (error) { colab = null; if (!disposed) rowStatus(section('colab'), `Could not load the Colab settings: ${failure(error)}`, true); }
    finally { colabLoading = false; if (!disposed) renderColab(); }
    if (colab && !disposed) void loadColabUsage();
  }
  /** Compute units come from Google over the network, so they fill in after the settings are already usable. */
  async function loadColabUsage(): Promise<void> {
    const run = ++colabUsageRun;
    try {
      const usage = await options.call<ColabUsage>('cloud_colab_usage');
      if (!disposed && run === colabUsageRun && colabConnected()) { colabUsage = usage; renderColab(); }
    } catch {
      // Compute units are informational; without them the line stays hidden and the settings still work.
      if (!disposed && run === colabUsageRun) { colabUsage = null; renderColab(); }
    }
  }
  function syncColab(): void {
    if (!colabConnected()) { colab = null; colabUsage = null; colabUsageRun++; colabStatus(''); renderColab(); return; }
    if (!colab && !colabLoading) void loadColab();
  }
  /** Reopened Settings while a sign-in still runs in the background: show its progress, link and Cancel again. */
  async function restoreColabSignIn(): Promise<void> {
    let running: ColabSignInStatus = null;
    try { running = await options.call<ColabSignInStatus>('cloud_colab_sign_in_status'); }
    catch { return; } // No running sign-in to restore; the Sign in button stays ready.
    if (disposed || !running || colabConnected() || colabPending || colabSigning) return;
    colabSignInId = running.id; colabSigning = { ...running };
    rowStatus(section('colab'), running.message || COLAB_SIGN_IN_STEPS[running.state]);
    render();
  }
  async function colabSignIn(authMode: 'oauth2' | 'adc', oauthConfigPath = ''): Promise<void> {
    const root = section('colab');
    colabPending = true; colabEarly = []; colabSignInId = null; colabSigning = null;
    rowStatus(root, authMode === 'adc' ? 'Signing in with gcloud application-default credentials…' : 'Starting Google sign-in…');
    say(root, 'error', ''); render();
    let started: { id: number };
    try {
      started = await options.call<{ id: number }>('cloud_colab_sign_in_start', { authMode, ...(oauthConfigPath ? { oauthConfigPath } : {}) });
    } catch (error) {
      colabPending = false; colabEarly = [];
      if (!disposed) { rowStatus(root, failure(error), true); render(); }
      return;
    }
    const early = colabEarly;
    colabPending = false; colabEarly = []; colabSignInId = started.id;
    colabSigning = { id: started.id, state: authMode === 'adc' ? 'exchanging' : 'installing' };
    if (disposed) return;
    render();
    // Reports that came before the id, from this attempt only; an earlier run's `cancelled` is dropped here.
    for (const update of early) if (update.id === started.id) await onColabSignIn(update);
  }
  async function onColabSignIn(update: ColabSignInUpdate): Promise<void> {
    if (colabPending) { colabEarly = [...colabEarly, update]; return; }
    // Another attempt's events (an earlier, cancelled run) never touch the one this view follows.
    if (colabSignInId != null && update.id !== colabSignInId) return;
    const root = section('colab');
    if (update.state === 'done') {
      colabSigning = null; colabSignInId = null; rowStatus(root, '');
      const form = root.querySelector<HTMLFormElement>('form')!; form.reset(); form.hidden = true;
      await load();
      return;
    }
    // A failure after Cancel was the cancelled run ending; Cancel already said so.
    if (!colabSigning) return;
    if (update.state === 'failed') { colabSigning = null; colabSignInId = null; rowStatus(root, update.message || 'Google sign-in did not finish. Try again.', true); render(); return; }
    if (update.state === 'cancelled') { colabSigning = null; colabSignInId = null; rowStatus(root, 'Sign-in cancelled.'); render(); return; }
    colabSigning = update;
    rowStatus(root, update.message || COLAB_SIGN_IN_STEPS[update.state]);
    render();
  }
  async function cancelColabSignIn(): Promise<void> {
    const root = section('colab');
    colabSigning = null; colabSignInId = null; rowStatus(root, 'Sign-in cancelled.'); render();
    try { await options.call('cloud_colab_sign_in_cancel', {}); }
    catch (error) { if (!disposed) rowStatus(root, failure(error), true); }
  }
  async function saveColab(patch: Partial<Pick<ColabConfig, 'accelerator' | 'highMem' | 'nativeTools' | 'colabMcp'>>, saved: string): Promise<void> {
    if (!colab || colabSaving) { renderColab(); return; }
    const previous = colab;
    // Optimistic, so renderColab() keeps the new choice on screen while it saves.
    colab = { ...colab, ...patch }; colabSaving = true; colabStatus(''); renderColab();
    let ok = false;
    try {
      const next = await options.call<ColabConfig>('cloud_colab_set_config', patch);
      if (!disposed && colabConnected()) { colab = next; colabStatus(saved); ok = true; }
    } catch (error) {
      // Disconnected meanwhile: the result belongs to an account that is gone.
      if (!disposed && colabConnected()) { colab = previous; colabStatus(failure(error), true); }
    } finally { colabSaving = false; if (!disposed) render(); }
    // The card's `Connected · …` line names the hardware, and the hourly rate follows it.
    if (ok && ('accelerator' in patch || 'highMem' in patch)) { void loadColabUsage(); await refreshConnections(); }
  }
  async function refreshConnections(): Promise<void> {
    try { const fresh = await options.call<CloudConnection[]>('cloud_connections'); if (!disposed) { connections = fresh; render(); } }
    catch (error) { if (!disposed) colabStatus(`Could not refresh the connection: ${failure(error)}`, true); }
  }
  /** Opens the Colab sign-in link in the system browser; plain navigation when that is unavailable. */
  function openColabLink(event: MouseEvent, link: HTMLAnchorElement): void {
    if (event.defaultPrevented || !/^https?:$/.test(new URL(link.href, document.baseURI).protocol)) return;
    event.preventDefault();
    options.call('open_external_url', { url: link.href }).catch(() => { window.open(link.href, '_blank', 'noopener,noreferrer'); });
  }
  async function installColabCli(): Promise<void> {
    if (!colab) return;
    colabSaving = true; colabStatus('Installing the Colab CLI…'); render();
    try {
      const next = await options.call<ColabConfig>('cloud_colab_install_cli', {});
      if (!disposed && colabConnected()) { colab = next; colabStatus(next.colabCliInstalled ? 'Colab CLI installed.' : ''); }
    } catch (error) { if (!disposed && colabConnected()) colabStatus(`Could not install the Colab CLI: ${failure(error)}`, true); }
    finally { colabSaving = false; if (!disposed) render(); }
  }
  function changeColab(target: HTMLInputElement | HTMLSelectElement): void {
    if (target instanceof HTMLSelectElement) {
      const accelerator = target.value as ColabAccelerator;
      void saveColab({ accelerator }, `Saved. New Colab runtimes use ${ACCELERATORS.find(([value]) => value === accelerator)?.[1] ?? accelerator}.`);
      return;
    }
    const key = target.dataset.colab as keyof typeof COLAB_CONFIG_LABELS, on = (target as HTMLInputElement).checked;
    void saveColab({ [key]: on }, `Saved. ${COLAB_CONFIG_LABELS[key]} ${on ? 'on' : 'off'}.`);
  }

  /** The row status line under a provider card; a failure is drawn in the error colour until the next status replaces it. */
  function rowStatus(root: HTMLElement, text: string, failed = false): void {
    const line = root.querySelector<HTMLElement>('.cloud-row-status')!;
    line.hidden = !text; line.textContent = text; line.classList.toggle('cloud-error', failed);
  }

  /* DigitalOcean's droplet region and machine size, filled from the account's catalog. */
  let catalog: DoCatalog | null = null, catalogError = '', catalogLoading = false, optionSaving = false, customFor: 'region' | 'size' | null = null, catalogRun = 0;
  function renderCatalog(): void {
    const root = section('digitalocean'), box = root.querySelector<HTMLElement>('[data-do-options]')!;
    const region = box.querySelector<HTMLSelectElement>('[data-do="region"]')!, size = box.querySelector<HTMLSelectElement>('[data-do="size"]')!;
    const status = box.querySelector<HTMLElement>('.cloud-image-status')!, error = box.querySelector<HTMLElement>('.cloud-image-error')!;
    const retry = box.querySelector<HTMLElement>('.cloud-actions')!, custom = box.querySelector<HTMLElement>('[data-do-custom]')!;
    box.hidden = !connections.find(c => c.provider === 'digitalocean')?.connected;
    custom.hidden = !customFor;
    const label = customFor === 'size' ? 'Machine size' : 'Region';
    custom.querySelector<HTMLElement>('[data-do-custom-label]')!.textContent = label;
    custom.querySelector<HTMLInputElement>('input')!.setAttribute('aria-label', `Custom DigitalOcean ${label.toLowerCase()}`);
    error.textContent = catalogError; error.hidden = !catalogError;
    retry.hidden = Boolean(catalog) || catalogLoading || !catalogError;
    if (!catalog) {
      const loading = catalogLoading ? 'Loading…' : 'Not available';
      region.innerHTML = `<option value="">${loading}</option>`;
      size.innerHTML = `<option value="">${loading}</option>`;
      status.hidden = true;
      return;
    }
    /* Two-way availability: a size with known regions narrows the regions, a chosen region narrows
     * the sizes (a size without a region list works everywhere); the saved pair always stays. */
    const known = catalog;
    const regionBefore = region.value, sizeBefore = size.value;
    const sized = sizeBefore === 'custom' ? undefined : known.sizes.find(item => item.value === sizeBefore);
    const regionItems = sized?.regions.length ? known.regions.filter(item => sized.regions.includes(item.value) || item.value === known.region) : known.regions;
    const sizeItems = regionBefore && regionBefore !== 'custom' ? known.sizes.filter(item => !item.regions.length || item.regions.includes(regionBefore) || item.value === known.size) : known.sizes;
    const options = (items: { value: string; label: string }[], lead: string, saved: string): string =>
      `<option value="">${lead}</option>${items.map(item => `<option value="${escape(item.value)}">${escape(item.label)}</option>`).join('')}${saved && !items.some(item => item.value === saved) ? `<option value="${escape(saved)}">${escape(saved)}</option>` : ''}<option value="custom">Custom…</option>`;
    region.innerHTML = options(regionItems, 'Default (nyc1)', known.region);
    size.innerHTML = options(sizeItems, 'Standard (s-2vcpu-4gb)', known.size);
    const settle = (select: HTMLSelectElement, saved: string, editing: boolean, before: string): void => {
      const wanted = editing ? 'custom' : before === 'custom' ? saved : before || saved;
      select.value = [...select.options].some(option => option.value === wanted) ? wanted : select.options[0]?.value ?? '';
    };
    settle(region, known.region, customFor === 'region', regionBefore);
    settle(size, known.size, customFor === 'size', sizeBefore);
    region.disabled = optionSaving;
    size.disabled = optionSaving;
    if (catalogError) status.hidden = true;
  }
  async function loadCatalog(): Promise<void> {
    const run = ++catalogRun;
    catalogLoading = true; catalogError = ''; renderCatalog();
    try {
      const loaded = await options.call<DoCatalog>('cloud_digitalocean_catalog');
      // A fetch that outlived a disconnect (or its reconnect) must not revive stale state.
      if (run !== catalogRun) return;
      catalog = loaded;
    } catch (error) {
      if (run !== catalogRun) return;
      catalog = null;
      catalogError = `Could not load regions and sizes: ${error instanceof Error ? error.message : String(error)}`;
    } finally { catalogLoading = false; if (!disposed && run === catalogRun) renderCatalog(); }
  }
  function syncCatalog(): void {
    if (!connections.find(c => c.provider === 'digitalocean')?.connected) { catalogRun++; catalog = null; catalogError = ''; catalogLoading = false; customFor = null; renderCatalog(); return; }
    if (!catalog && !catalogLoading) void loadCatalog();
  }
  async function saveOptions(): Promise<void> {
    if (!catalog) return;
    const box = section('digitalocean').querySelector<HTMLElement>('[data-do-options]')!;
    const region = box.querySelector<HTMLSelectElement>('[data-do="region"]')!, size = box.querySelector<HTMLSelectElement>('[data-do="size"]')!;
    const status = box.querySelector<HTMLElement>('.cloud-image-status')!;
    // An open Custom row contributes its saved value: it is not a choice until applied.
    const saved = { region: region.value === 'custom' ? catalog.region : region.value, size: size.value === 'custom' ? catalog.size : size.value };
    optionSaving = true; catalogError = ''; status.hidden = false; status.textContent = 'Saving…'; renderCatalog();
    try {
      connections = await options.call<CloudConnection[]>('cloud_digitalocean_set_options', { region: saved.region, size: saved.size });
      if (disposed) return;
      catalog.region = saved.region; catalog.size = saved.size; customFor = null;
      // The selects must show the saved pair before the next render reads them back.
      region.value = saved.region; size.value = saved.size;
      status.textContent = 'Saved.';
    } catch (error) {
      status.hidden = true;
      catalogError = error instanceof Error ? error.message : String(error);
    } finally { optionSaving = false; if (!disposed) { render(); renderCatalog(); } }
  }
  async function applyCustom(): Promise<void> {
    if (!catalog || !customFor) return;
    const box = section('digitalocean').querySelector<HTMLElement>('[data-do-options]')!;
    const region = box.querySelector<HTMLSelectElement>('[data-do="region"]')!, size = box.querySelector<HTMLSelectElement>('[data-do="size"]')!;
    const input = box.querySelector<HTMLInputElement>('[data-do="custom"]')!, status = box.querySelector<HTMLElement>('.cloud-image-status')!;
    const value = input.value.trim(), field = customFor;
    if (!value) { catalogError = `Enter the ${field === 'size' ? 'machine size' : 'region'} slug.`; renderCatalog(); return; }
    const saved = { region: field === 'region' ? value : region.value === 'custom' ? catalog.region : region.value, size: field === 'size' ? value : size.value === 'custom' ? catalog.size : size.value };
    optionSaving = true; catalogError = ''; status.hidden = false; status.textContent = 'Saving…'; renderCatalog();
    try {
      connections = await options.call<CloudConnection[]>('cloud_digitalocean_set_options', { region: saved.region, size: saved.size });
      if (disposed) return;
      catalog.region = saved.region; catalog.size = saved.size;
      customFor = null; input.value = '';
      region.value = saved.region; size.value = saved.size;
      status.textContent = 'Saved.';
    } catch (error) {
      status.hidden = true;
      catalogError = error instanceof Error ? error.message : String(error);
    } finally { optionSaving = false; if (!disposed) { render(); renderCatalog(); } }
  }
  function say(root: HTMLElement, kind: 'progress' | 'error', text: string): void {
    const line = root.querySelector<HTMLElement>(`.cloud-${kind}`)!;
    line.textContent = text; line.hidden = !text;
  }
  async function connect(id: CloudConnection['provider'], form: HTMLFormElement): Promise<void> {
    const root = section(id), data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const missing = [...(PROVIDERS[id].key ? [PROVIDERS[id].key!] : []), ...PROVIDERS[id].fields].find(field => !field.optional && !value(field.name));
    if (missing) { say(root, 'error', `Enter the ${missing.label.toLowerCase()}.`); return; }
    busy = id; say(root, 'error', ''); say(root, 'progress', id === 'cloudflare' ? 'Preparing the deploy…' : 'Checking…'); render();
    try {
      const fields = Object.fromEntries(PROVIDERS[id].fields.filter(field => !field.sparse || value(field.name)).map(field => [field.name, value(field.name)]));
      connections = await options.call<CloudConnection[]>('cloud_connect', { provider: id, key: value('key'), options: fields });
      if (disposed) return;
      form.reset(); form.hidden = true;
      say(root, 'progress', '');
    } catch (error) {
      if (!disposed) { say(root, 'progress', ''); say(root, 'error', failure(error)); }
    } finally { busy = ''; if (!disposed) { render(); syncImages(); syncCatalog(); syncColab(); } }
  }
  async function setupSandboxes(root: HTMLElement): Promise<void> {
    busy = 'cloudflare'; rowStatus(root, 'Preparing the sandbox Worker…'); render();
    try { connections = await options.call<CloudConnection[]>('cloud_setup_sandboxes'); rowStatus(root, 'Sandboxes are ready.'); }
    catch (error) { rowStatus(root, failure(error), true); }
    finally { busy = ''; if (!disposed) render(); }
  }
  async function saveClaudeToken(form: HTMLFormElement): Promise<void> {
    const root = form.closest<HTMLElement>('.cloud-provider')!, input = form.querySelector<HTMLInputElement>('input')!, token = input.value.trim();
    say(root, 'progress', ''); say(root, 'error', '');
    if (!token) { say(root, 'error', 'Paste the token from claude setup-token.'); return; }
    try { await options.call('cloud_agent_set_claude_token', { token }); if (!disposed) { form.reset(); say(root, 'progress', 'Saved. Cloud agents sign in to Claude with this token.'); } }
    catch (error) { if (!disposed) say(root, 'error', failure(error)); }
  }
  async function disconnect(id: CloudConnection['provider']): Promise<void> {
    busy = id; render();
    try { connections = await options.call<CloudConnection[]>('cloud_disconnect', { provider: id }); }
    catch (error) { say(section(id), 'error', failure(error)); }
    finally { busy = ''; if (!disposed) { render(); syncImages(); syncCatalog(); syncColab(); } }
  }

  host.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.cloud-colab-link') : null;
    if (link) { openColabLink(event, link); return; }
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-cloud]') : null;
    if (!target || target.disabled) return;
    const root = target.closest<HTMLElement>('.cloud-provider[data-provider]')!, id = root.dataset.provider as CloudConnection['provider'];
    const form = root.querySelector<HTMLFormElement>('form')!;
    if (target.dataset.cloud === 'cancel') { form.hidden = true; say(root, 'error', ''); render(); return; }
    if (target.dataset.cloud === 'sandboxes') { void setupSandboxes(root); return; }
    if (target.dataset.cloud === 'images') { void loadImages(); return; }
    if (target.dataset.cloud === 'do-retry') { void loadCatalog(); return; }
    if (target.dataset.cloud === 'do-apply') { void applyCustom(); return; }
    if (target.dataset.cloud === 'do-cancel') { customFor = null; renderCatalog(); return; }
    if (target.dataset.cloud === 'colab-cancel') { void cancelColabSignIn(); return; }
    if (target.dataset.cloud === 'colab-install') { void installColabCli(); return; }
    if (target.dataset.cloud === 'colab-adc') { if (!colabSigning && !colabPending) void colabSignIn('adc'); return; }
    if (target.dataset.cloud === 'toggle' && connections.find(c => c.provider === id)?.connected) { void disconnect(id); return; }
    // Google Colab signs in with one click; its form only holds the other ways to sign in.
    if (id === 'colab' && target.dataset.cloud === 'toggle') { if (!colabSigning && !colabPending) void colabSignIn('oauth2'); return; }
    form.hidden = !form.hidden;
    render();
    if (!form.hidden) form.querySelector<HTMLInputElement>('input')!.focus();
  });
  host.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (form.classList.contains('cloud-claude-form')) { void saveClaudeToken(form); return; }
    const id = form.closest<HTMLElement>('.cloud-provider')!.dataset.provider as CloudConnection['provider'];
    if (id === 'colab') { if (!colabSigning && !colabPending) void colabSignIn('oauth2', String(new FormData(form).get('oauthConfigPath') ?? '').trim()); return; }
    void connect(id, form);
  });
  host.addEventListener('change', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('[data-cloud-inherit]')) {
      const root = target.closest<HTMLElement>('.cloud-provider[data-provider]')!;
      const id = root.dataset.provider as CloudConnection['provider'];
      if (busy) { target.checked = !target.checked; return; }
      const inherit = target.checked;
      // A failure from an earlier toggle must not outlive the next attempt.
      rowStatus(root, '');
      // Optimistic: render() must not read the checkbox back to the old state mid-save.
      const previous = connections;
      connections = connections.map(connection => connection.provider === id ? { ...connection, inheritEnvironment: inherit } : connection);
      busy = id; render();
      void options.call<CloudConnection[]>('cloud_set_inherit_environment', { provider: id, inherit }).then(next => {
        connections = next;
        say(root, 'progress', inherit ? 'Saved. Cloud agents on this provider include the saved environment variables.' : 'Saved. Nothing from the provider environment is sent to this cloud.');
      }).catch(error => {
        connections = previous; target.checked = !inherit;
        // The connect form's own error line is hidden while connected, so the
        // visible row status carries the failure.
        rowStatus(root, failure(error), true);
      }).finally(() => { busy = ''; if (!disposed) render(); });
      return;
    }
    if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement) && target.matches('[data-colab]')) { changeColab(target); return; }
    if (target instanceof HTMLSelectElement && target.closest('[data-do-options]')) {
      if (target.value === 'custom') {
        customFor = target.dataset.do === 'size' ? 'size' : 'region';
        renderCatalog();
        section('digitalocean').querySelector<HTMLInputElement>('[data-do="custom"]')!.focus();
        return;
      }
      void saveOptions();
      return;
    }
    if (target instanceof HTMLSelectElement && target.closest('.cloud-image')) void saveImage(target);
  });
  host.addEventListener('keydown', event => {
    const form = (event.target as Element).closest?.('.cloud-provider[data-provider] form.cloud-form') as HTMLFormElement | null;
    // Escape closes the form, not the Settings dialog around it.
    if (form && event.key === 'Escape' && !isImeKey(event)) {
      event.preventDefault(); event.stopPropagation(); form.hidden = true; render();
      // Focus goes back to the button that opened the form, not to the top of Settings.
      const root = form.closest<HTMLElement>('.cloud-provider[data-provider]')!;
      root.querySelector<HTMLButtonElement>(root.dataset.provider === 'colab' ? '[data-cloud="toggle-form"]' : '[data-cloud="toggle"]')?.focus();
    }
  });
  void options.listen('cloud-setup', event => {
    if (event.provider !== busy) return;
    const line = section(busy).querySelector<HTMLElement>('.cloud-row-status')!;
    line.hidden = false; line.classList.remove('cloud-error'); line.textContent = event.label;
  }).then(stop => { if (disposed) stop(); else stopListening = stop; });
  let stopColab: (() => void) | undefined;
  void options.listen('colab-sign-in', update => { if (!disposed) void onColabSignIn(update); })
    .then(stop => { if (disposed) stop(); else stopColab = stop; });
  void load();
  return () => { disposed = true; stopListening?.(); stopColab?.(); host.replaceChildren(); };
}
