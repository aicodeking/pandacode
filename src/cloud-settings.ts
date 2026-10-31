/* Settings → Agents → Cloud sandboxes: connect Daytona, Cloudflare, AWS and the keyed sandbox
 * providers so agents can create and use cloud machines (and run on them as cloud agents), and
 * Vercel, Railway, Netlify and Google Cloud for deploys. Keys go straight to the OS keychain natively;
 * this view never reads them back. */
import './cloud-settings.css';
import { escape } from './dom';
import { infoMark } from './tooltip';

export type CloudConnection = { provider: 'daytona' | 'cloudflare' | 'aws' | 'vercel' | 'railway' | 'netlify' | 'gcloud' | 'docker' | KeyedProvider; connected: boolean; detail: string | null; sandboxes?: boolean; inheritEnvironment?: boolean };
export type CloudSettingsHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: 'cloud-setup', callback: (event: { provider: string; label: string }) => void): Promise<() => void>;
};

/** `sparse` options are sent only when filled (the cloud agent fields added to deploy providers). */
type Field = { name: string; label: string; placeholder: string; secret?: boolean; optional?: boolean; sparse?: boolean };
/* Sandbox providers that connect with one API key (docs/cloud-agents.md → Provider settings). */
const KEYED = {
  digitalocean: { name: 'DigitalOcean', key: 'API token', docs: 'cloud.digitalocean.com/account/api/tokens', fields: [{ name: 'region', label: 'Region', placeholder: 'Optional, e.g. nyc1', optional: true }] },
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
  ...Object.fromEntries(Object.entries(KEYED).map(([id, provider]) => [id, {
    name: provider.name, summary: 'Cloud machines for agents.',
    key: { name: 'key', label: provider.key, placeholder: provider.docs, secret: true }, fields: provider.fields,
    note: `Create a key at ${provider.docs}. Cloud agents run on machines in your own account.`, connect: 'Connect',
  }])) as Record<KeyedProvider, { name: string; summary: string; key?: Field; fields: Field[]; note: string; connect: string }>,
};
/** `cloud_instabox_images`: what new InstaBox machines can start from, and the saved choice. */
type InstaboxImages = { images: { value: string; label: string }[]; selected: string };
const IMAGE_HELP = 'New InstaBox machines start from this image. Snapshots are listed once they are ready; to run agents without the desktop tool agent-browser includes, make a snapshot as docs/cloud-agents.md describes.';
const CLAUDE_TOKEN_HELP = 'Run `claude setup-token` and paste the long-lived token it prints. Without one, PandaCode copies this computer’s Claude Code login to the machine before each run.';
const INHERIT_HELP = 'When on, cloud agents this provider runs also get the environment variables saved for the harness in Settings → Providers — a proxy the cloud machine can reach, for example. Off by default: nothing is sent to this cloud. Variables that point at this computer (a localhost HTTP_PROXY) are refused when a task starts, because a cloud machine cannot reach them.';

export function mountCloudSettings(host: HTMLElement, options: CloudSettingsHost): () => void {
  host.innerHTML = `<div class="settings-group cloud-settings" aria-label="Cloud sandboxes"><div class="cloud-provider cloud-claude">
      <div class="setting-row"><div><strong>Claude login for cloud agents</strong>${infoMark(CLAUDE_TOKEN_HELP, 'About the Claude login')}<small class="cloud-detail">Optional long-lived token</small></div></div>
      <form class="cloud-form cloud-claude-form" novalidate aria-label="Claude login for cloud agents">
        <label><span>Token</span><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="From claude setup-token" aria-label="Claude token for cloud agents" required></label>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="submit" class="primary-button">Save token</button></div>
      </form>
    </div>${(Object.keys(PROVIDERS) as CloudConnection['provider'][]).map(id => {
    const provider = PROVIDERS[id];
    const fields = [...(provider.key ? [provider.key] : []), ...provider.fields];
    return `<div class="cloud-provider" data-provider="${id}">
      <div class="setting-row"><div><strong>${escape(provider.name)}</strong><small class="cloud-detail">${escape(provider.summary)}</small></div><div class="cloud-buttons">${id === 'cloudflare' ? '<button type="button" class="secondary-button" data-cloud="sandboxes" hidden>Set up sandboxes</button>' : ''}<button type="button" class="secondary-button" data-cloud="toggle">Connect</button></div></div>
      <p class="cloud-progress cloud-row-status" role="status" hidden></p>
      <label class="cloud-inherit" data-inherit-row hidden><input type="checkbox" data-cloud-inherit> Include provider environment variables${infoMark(INHERIT_HELP, 'About inheriting environment variables')}</label>${id === 'instabox' ? `
      <div class="cloud-image" hidden>
        <div class="cloud-image-row"><label><span>Machine image</span><select aria-label="InstaBox machine image" disabled></select></label>${infoMark(IMAGE_HELP, 'About machine images')}</div>
        <p class="cloud-image-status" role="status" hidden></p>
        <p class="cloud-image-error" role="alert" hidden></p>
        <div class="cloud-actions" hidden><button type="button" class="secondary-button" data-cloud="images">Try again</button></div>
      </div>` : ''}
      <form class="cloud-form" hidden novalidate aria-label="${escape(`Connect ${provider.name}`)}">
        ${fields.map(field => `<label><span>${escape(field.label)}</span><input name="${field.name}" type="${field.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${escape(field.placeholder)}" aria-label="${escape(`${provider.name} ${field.label}`)}" ${field.optional ? '' : 'required'}></label>`).join('')}
        <p class="cloud-note">${escape(provider.note)}</p>
        <p class="cloud-progress" role="status" hidden></p>
        <p class="cloud-error" role="alert" hidden></p>
        <div class="cloud-actions"><button type="button" class="secondary-button" data-cloud="cancel">Cancel</button><button type="submit" class="primary-button">${escape(provider.connect)}</button></div>
      </form>
    </div>`;
  }).join('')}</div>`;
  let connections: CloudConnection[] = [], disposed = false, busy = '';
  let stopListening: (() => void) | undefined;
  const section = (id: string) => host.querySelector<HTMLElement>(`.cloud-provider[data-provider="${id}"]`)!;

  function render(): void {
    for (const id of Object.keys(PROVIDERS) as CloudConnection['provider'][]) {
      const connection = connections.find(c => c.provider === id), root = section(id);
      const toggle = root.querySelector<HTMLButtonElement>('[data-cloud="toggle"]')!;
      const form = root.querySelector<HTMLFormElement>('form')!;
      const sandboxes = id === 'cloudflare' && connection?.connected ? (connection.sandboxes ? ' · sandboxes ready' : ' · sandboxes not set up') : '';
      root.querySelector('.cloud-detail')!.textContent = connection?.connected ? `Connected${connection.detail ? ` · ${connection.detail}` : ''}${sandboxes}` : PROVIDERS[id].summary;
      const setup = root.querySelector<HTMLButtonElement>('[data-cloud="sandboxes"]');
      if (setup) { setup.hidden = !connection?.connected || Boolean(connection.sandboxes); setup.disabled = Boolean(busy); }
      toggle.textContent = connection?.connected ? 'Disconnect' : form.hidden ? 'Connect' : 'Close';
      toggle.disabled = Boolean(busy);
      toggle.setAttribute('aria-label', `${toggle.textContent} ${PROVIDERS[id].name}`);
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
  }
  async function load(): Promise<void> {
    try { connections = await options.call<CloudConnection[]>('cloud_connections'); } catch { connections = []; }
    if (!disposed) { render(); syncImages(); }
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
    catch (error) { images = null; imagesError = `Could not load machine images: ${error instanceof Error ? error.message : String(error)}`; }
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
      imagesError = error instanceof Error ? error.message : String(error);
    } finally { imageSaving = false; if (!disposed) renderImages(); }
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
      if (!disposed) { say(root, 'progress', ''); say(root, 'error', error instanceof Error ? error.message : String(error)); }
    } finally { busy = ''; if (!disposed) { render(); syncImages(); } }
  }
  async function setupSandboxes(root: HTMLElement): Promise<void> {
    const line = root.querySelector<HTMLElement>('.cloud-row-status')!;
    busy = 'cloudflare'; line.hidden = false; line.textContent = 'Preparing the sandbox Worker…'; render();
    try { connections = await options.call<CloudConnection[]>('cloud_setup_sandboxes'); line.textContent = 'Sandboxes are ready.'; }
    catch (error) { line.textContent = error instanceof Error ? error.message : String(error); line.classList.add('cloud-error'); }
    finally { busy = ''; if (!disposed) render(); }
  }
  async function saveClaudeToken(form: HTMLFormElement): Promise<void> {
    const root = form.closest<HTMLElement>('.cloud-provider')!, input = form.querySelector<HTMLInputElement>('input')!, token = input.value.trim();
    say(root, 'progress', ''); say(root, 'error', '');
    if (!token) { say(root, 'error', 'Paste the token from claude setup-token.'); return; }
    try { await options.call('cloud_agent_set_claude_token', { token }); if (!disposed) { form.reset(); say(root, 'progress', 'Saved. Cloud agents sign in to Claude with this token.'); } }
    catch (error) { if (!disposed) say(root, 'error', error instanceof Error ? error.message : String(error)); }
  }
  async function disconnect(id: CloudConnection['provider']): Promise<void> {
    busy = id; render();
    try { connections = await options.call<CloudConnection[]>('cloud_disconnect', { provider: id }); }
    catch (error) { say(section(id), 'error', error instanceof Error ? error.message : String(error)); }
    finally { busy = ''; if (!disposed) { render(); syncImages(); } }
  }

  host.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-cloud]') : null;
    if (!target || target.disabled) return;
    const root = target.closest<HTMLElement>('.cloud-provider[data-provider]')!, id = root.dataset.provider as CloudConnection['provider'];
    const form = root.querySelector<HTMLFormElement>('form')!;
    if (target.dataset.cloud === 'cancel') { form.hidden = true; say(root, 'error', ''); render(); return; }
    if (target.dataset.cloud === 'sandboxes') { void setupSandboxes(root); return; }
    if (target.dataset.cloud === 'images') { void loadImages(); return; }
    if (connections.find(c => c.provider === id)?.connected) { void disconnect(id); return; }
    form.hidden = !form.hidden;
    render();
    if (!form.hidden) form.querySelector<HTMLInputElement>('input')!.focus();
  });
  host.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (form.classList.contains('cloud-claude-form')) { void saveClaudeToken(form); return; }
    const id = form.closest<HTMLElement>('.cloud-provider')!.dataset.provider as CloudConnection['provider'];
    void connect(id, form);
  });
  host.addEventListener('change', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('[data-cloud-inherit]')) {
      const root = target.closest<HTMLElement>('.cloud-provider[data-provider]')!;
      const id = root.dataset.provider as CloudConnection['provider'];
      if (busy) { target.checked = !target.checked; return; }
      const inherit = target.checked;
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
        const line = root.querySelector<HTMLElement>('.cloud-row-status')!;
        line.hidden = false; line.classList.add('cloud-error');
        line.textContent = error instanceof Error ? error.message : String(error);
      }).finally(() => { busy = ''; if (!disposed) render(); });
      return;
    }
    if (target instanceof HTMLSelectElement && target.closest('.cloud-image')) void saveImage(target);
  });
  host.addEventListener('keydown', event => {
    const form = (event.target as Element).closest?.('.cloud-provider[data-provider] form.cloud-form') as HTMLFormElement | null;
    // Escape closes the form, not the Settings dialog around it.
    if (form && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); form.hidden = true; render(); }
  });
  void options.listen('cloud-setup', event => {
    if (event.provider !== busy) return;
    const line = section(busy).querySelector<HTMLElement>('.cloud-row-status')!;
    line.hidden = false; line.classList.remove('cloud-error'); line.textContent = event.label;
  }).then(stop => { if (disposed) stop(); else stopListening = stop; });
  void load();
  return () => { disposed = true; stopListening?.(); host.replaceChildren(); };
}
