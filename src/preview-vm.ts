/* Browser-preview stand-ins for the native VM commands: Tart setup, a catalog of images,
 * VMs that start and stop, a drawn 1024×768 desktop for frames, and recorded input. */
import type { Vm, VmImage, VmStatus } from './vm-panel';

const IMAGES: VmImage[] = [
  { id: 'ubuntu', name: 'Ubuntu 24.04', os: 'linux', source: 'ghcr.io/cirruslabs/ubuntu:latest', downloadGb: 5, memoryMb: 2048, cpus: 2 },
  { id: 'debian', name: 'Debian', os: 'linux', source: 'ghcr.io/cirruslabs/debian:latest', downloadGb: 4, memoryMb: 2048, cpus: 2 },
  { id: 'fedora', name: 'Fedora', os: 'linux', source: 'ghcr.io/cirruslabs/fedora:latest', downloadGb: 5, memoryMb: 2048, cpus: 2 },
  { id: 'macos-tahoe', name: 'macOS Tahoe', os: 'darwin', source: 'ghcr.io/cirruslabs/macos-tahoe-base:latest', downloadGb: 30, memoryMb: 4096, cpus: 4 },
  { id: 'macos-sequoia', name: 'macOS Sequoia', os: 'darwin', source: 'ghcr.io/cirruslabs/macos-sequoia-base:latest', downloadGb: 28, memoryMb: 4096, cpus: 4 },
];

export function createPreviewVm() {
  let installed = false, shown: string | null = null;
  const vms: Vm[] = [];
  const desktops = new Set<string>();
  /** Like the native install: running for a couple of status checks, then done. */
  let installing: string | null = null, checks = 0;
  const inputs: { name: string; input: Record<string, unknown> }[] = [];
  const starts: { name: string; share: string | null }[] = [];
  let mark: { x: number; y: number } | null = null, typed = '';
  const status = (): VmStatus => {
    if (installing && ++checks > 2) { const vm = vms.find(v => v.name === installing); if (vm) vm.desktop = null; desktops.add(installing); installing = null; }
    return { supported: true, installed, vms: structuredClone(vms), shown, images: structuredClone(IMAGES) };
  };
  const startVm = (vm: Vm) => {
    vm.running = vm.attached = true;
    if (vm.os === 'linux' && !desktops.has(vm.name)) { vm.desktop = 'installing'; installing = vm.name; checks = 0; }
  };
  const find = (name: unknown) => { const vm = vms.find(candidate => candidate.name === name); if (!vm) throw new Error('No VM with that name.'); return vm; };

  async function frame(): Promise<ArrayBuffer> {
    const canvas = new OffscreenCanvas(1024, 768), g = canvas.getContext('2d')!;
    g.fillStyle = '#16213a'; g.fillRect(0, 0, 1024, 768);
    g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 1024, 26);
    g.fillStyle = '#222'; g.font = '13px sans-serif'; g.fillText('Applications', 20, 17);
    g.fillStyle = '#0d1117'; g.fillRect(120, 90, 700, 420);
    g.fillStyle = '#7ee787'; g.font = '15px monospace'; g.fillText(`admin@ubuntu:~$ ${typed}`, 136, 124);
    if (mark) { g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(mark.x, mark.y, 14, 0, Math.PI * 2); g.fill(); }
    return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer();
  }
  return {
    inputs, starts, status,
    setup() { installed = true; return '/Users/you/Applications/tart.app/Contents/MacOS/tart'; },
    show(name: unknown) { if (name != null && !String(name).includes(':')) find(name); shown = name == null ? null : String(name); return status(); },
    create(image: unknown, name: unknown) {
      const found = IMAGES.find(candidate => candidate.id === image);
      if (!found) throw new Error('Unknown VM image.');
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('VM names use lowercase letters, digits and dashes.');
      if (vms.some(vm => vm.name === name)) throw new Error(`A VM named ${name} already exists.`);
      const vm: Vm = { name, running: false, attached: false, os: found.os, memoryMb: found.memoryMb, cpus: found.cpus, sizeGb: found.downloadGb, desktop: null };
      vms.push(vm); startVm(vm); starts.push({ name, share: null });
      shown = name; return status();
    },
    power(name: unknown, action: unknown, share: unknown) {
      const vm = find(name);
      if (action === 'start') { startVm(vm); starts.push({ name: vm.name, share: typeof share === 'string' ? share : null }); }
      else if (action === 'stop') { vm.running = vm.attached = false; }
      else if (action === 'suspend') { if (vm.os !== 'darwin') throw new Error('Only macOS VMs can be suspended.'); vm.running = vm.attached = false; }
      else if (action === 'delete') { vms.splice(vms.indexOf(vm), 1); if (shown === vm.name) shown = null; }
      else throw new Error('Unknown VM action.');
      return status();
    },
    async frame(name: unknown) {
      const vm = find(name);
      if (!vm.attached) throw new Error(`${vm.name} is not running in PandaCode. Start it with vm_manage first.`);
      return frame();
    },
    input(name: unknown, input: Record<string, unknown>) {
      const vm = find(name);
      if (!vm.attached) throw new Error(`${vm.name} is not running in PandaCode.`);
      inputs.push({ name: vm.name, input: structuredClone(input) });
      if (typeof input.x === 'number' && typeof input.y === 'number') mark = { x: input.x, y: input.y };
      if (input.action === 'type') typed += String(input.text);
      return `${input.action} done`;
    },
    desktop(name: unknown) { const vm = find(name); if (vm.os !== 'linux') throw new Error('macOS VMs already have a desktop.'); return `${vm.name} now has an Xfce desktop.`; },
  };
}

/* Cloud sandboxes in the preview: connections that accept any key (except "bad"),
 * machines per provider, a drawn desktop for providers with screens, and recorded input. */
const BASE = ['daytona', 'cloudflare', 'aws', 'vercel', 'railway', 'netlify', 'gcloud', 'docker', 'colab'];
const KEYED = ['digitalocean', 'vultr', 'hetzner', 'runpod', 'e2b', 'modal', 'codesandbox', 'runloop', 'blaxel', 'tensorlake', 'freestyle', 'boat', 'instabox'];
const AGENT_TARGETS = [['e2b', 'E2B'], ['daytona', 'Daytona'], ['docker', 'Docker'], ['digitalocean', 'DigitalOcean'], ['vultr', 'Vultr'], ['hetzner', 'Hetzner'], ['runpod', 'RunPod'], ['modal', 'Modal'], ['vercel', 'Vercel Sandbox'], ['codesandbox', 'CodeSandbox'], ['runloop', 'Runloop'], ['blaxel', 'Blaxel'], ['tensorlake', 'Tensorlake'], ['freestyle', 'Freestyle'], ['boat', 'boat'], ['instabox', 'InstaBox'], ['cloudflare', 'Cloudflare'], ['aws', 'AWS EC2'], ['gcloud', 'Google Cloud'], ['colab', 'Google Colab']] as const;
type PreviewCloudMachine = { id: string; provider: string; name: string; state: string; os: string; desktop: boolean; detail: string };
const COLAB_ACCELERATORS = ['NONE', 'T4', 'L4', 'G4', 'A100', 'H100', 'V5E1', 'V6E1'];
const COLAB_EMAIL = 'alex@example.com';
/** Each preview Colab sign-in step takes this long, so tests can see the waiting state and Cancel. */
const COLAB_STEP_MS = 500;
const COLAB_TPUS = ['V5E1', 'V6E1'];
/** Hardware Colab offers in one memory shape, where High-RAM does not apply. */
const COLAB_SINGLE_SHAPE = ['L4', 'V5E1', 'V6E1'];
/** The Colab card's detail, as `colab::detail` formats it: the email, then the hardware unless it is plain CPU. */
const colabDetail = (accelerator: string, highMem: boolean) => {
  const bigger = highMem && !COLAB_SINGLE_SHAPE.includes(accelerator);
  return [
    COLAB_EMAIL,
    ...(accelerator !== 'NONE' || bigger ? [accelerator === 'NONE' ? 'CPU' : `${accelerator} ${COLAB_TPUS.includes(accelerator) ? 'TPU' : 'GPU'}`] : []),
    ...(bigger ? ['High-RAM'] : []),
  ].join(' · ');
};
type PreviewEmit = (name: string, event: unknown) => void;
export function createPreviewCloud(emit: PreviewEmit = () => {}) {
  const connected = new Map<string, string | null>();
  /* Clouds whose agents inherit the harness's saved environment (Settings → Providers). */
  const inheritEnvironment = new Set<string>();
  const machines: PreviewCloudMachine[] = [];
  const inputs: { id: string; input: Record<string, unknown> }[] = [];
  const kinds: Record<string, { provider: string; os: string; desktop: boolean; detail: string; needs: string }> = {
    daytona: { provider: 'daytona', os: 'linux', desktop: true, detail: 'Daytona · 1 CPU · 1 GB', needs: 'daytona' },
    cloudflare: { provider: 'cloudflare', os: 'linux', desktop: false, detail: 'Cloudflare container · commands only', needs: 'cloudflare' },
    'aws-linux': { provider: 'aws', os: 'linux', desktop: true, detail: 'AWS EC2 · Ubuntu · t4g.medium', needs: 'aws' },
    'aws-windows': { provider: 'aws', os: 'windows', desktop: true, detail: 'AWS EC2 · Windows Server · t3.large', needs: 'aws' },
    agentcore: { provider: 'agentcore', os: 'linux', desktop: false, detail: 'AWS AgentCore code interpreter · commands only · ends after an hour', needs: 'aws' },
    colab: { provider: 'colab', os: 'linux', desktop: false, detail: 'Google Colab · CPU · Standard', needs: 'colab' },
  };
  /* Google Colab: a browser sign-in that finishes on a timer (`window.__colabSignInFail` makes it fail,
   * `window.__colabSignInCancelled` makes the sign-in end cancelled as if the backend stopped it,
   * `window.__colabSignInHold` keeps it waiting until `window.__colabSignInComplete()`), saved defaults
   * (`window.__colabSetConfigFail` makes saving fail), and a
   * CLI the preview pretends to install. `signIn` is the running attempt; each attempt has its own id, and a new
   * start cancels the running one, as natively. Compute units come separately from `cloud_colab_usage`. */
  const COLAB_DEFAULTS = { authMode: 'oauth2' as 'oauth2' | 'adc', accelerator: 'NONE', highMem: false, nativeTools: true, colabMcp: false };
  type ColabAttempt = { id: number; mode: 'oauth2' | 'adc'; update: { state: 'waiting' | 'exchanging'; url?: string; message?: string } };
  let colab = { ...COLAB_DEFAULTS }, colabCli = false, signIn: ColabAttempt | null = null, signInIds = 0;
  const colabConfig = () => ({ connected: connected.has('colab'), email: connected.has('colab') ? COLAB_EMAIL : null, ...colab, colabCliInstalled: colabCli, uvxInstalled: true, gcloudInstalled: true, ccuBalance: null, ccuRate: null });
  /** Ends the running attempt (if it is still `attempt`) the way the test hooks ask. */
  const finishSignIn = (attempt: ColabAttempt) => {
    if (signIn !== attempt) return;
    signIn = null;
    if ((globalThis as any).__colabSignInFail) { emit('colab-sign-in', { id: attempt.id, state: 'failed', message: 'Google sign-in was denied (access_denied).' }); return; }
    if ((globalThis as any).__colabSignInCancelled) { emit('colab-sign-in', { id: attempt.id, state: 'cancelled' }); return; }
    colab = { ...colab, authMode: attempt.mode }; connected.set('colab', colabDetail(colab.accelerator, colab.highMem));
    emit('colab-sign-in', { id: attempt.id, state: 'done', detail: connected.get('colab') });
    emit('vm-changed', {});
  };
  (globalThis as any).__colabSignInComplete = () => { if (signIn) finishSignIn(signIn); };
  const requireColab = () => { if (!connected.has('colab')) throw new Error('Sign in to Google Colab in Settings → Cloud first.'); };
  /* A thread's Colab runtimes (colab-pip.ts), as `ColabThreadRuntime` rows. Tests seed them with
   * `window.__previewColabRuntime(sessionId, runtimes)`, read every command from `window.__previewColabCalls`,
   * and make the next ones fail with `window.__colabRuntimeFail`. Restart and Stop send their in-between state
   * at once and answer with the final list COLAB_STEP_MS later (`window.__colabRuntimeStepMs` to hold it
   * longer), as the real commands do: the call stays open while the runtime works. `window.__colabRuntimeGate` (a
   * promise) holds every action's answer until it settles, to see what lands while one is in flight. */
  type PreviewRuntime = Record<string, unknown> & { id: string; endpoint: string };
  const threadRuntimes = new Map<string, PreviewRuntime[]>();
  const runtimesOf = (sessionId: string): PreviewRuntime[] => structuredClone(threadRuntimes.get(sessionId) ?? []);
  const setRuntimes = (sessionId: string, runtimes: PreviewRuntime[]): PreviewRuntime[] => {
    if (runtimes.length) threadRuntimes.set(sessionId, structuredClone(runtimes)); else threadRuntimes.delete(sessionId);
    emit('colab-runtime', { sessionId, runtimes: runtimesOf(sessionId) });
    return runtimesOf(sessionId);
  };
  const runtimeStepMs = (): number => Number((globalThis as any).__colabRuntimeStepMs ?? COLAB_STEP_MS);
  const recordRuntimeCall = (command: string, args: Record<string, unknown>) => {
    ((globalThis as any).__previewColabCalls ??= []).push({ command, ...args });
    if ((globalThis as any).__colabRuntimeFail) throw new Error('Colab did not answer. Try again.');
  };
  const runtimeAction = (thread: string, endpoint: unknown, action: unknown): PreviewRuntime[] | Promise<PreviewRuntime[]> => {
    const target = (threadRuntimes.get(thread) ?? []).find(runtime => runtime.endpoint === endpoint || (action === 'dismiss' && runtime.id === endpoint));
    if (!target) throw new Error('That Colab runtime is no longer there.');
    // As the backend checks: only a stopped or failed runtime (or one never allocated) is dismissed, and only a live one is acted on.
    const live = target.state !== 'error' && target.state !== 'stopped' && Boolean(target.endpoint);
    if (action === 'dismiss' && live) throw new Error('Only a stopped or failed runtime can be dismissed; stop it instead.');
    if (action !== 'dismiss' && (target.state === 'stopped' || !target.endpoint)) throw new Error('That Colab runtime has stopped.');
    // `null` removes the runtime; a runtime already gone stays gone.
    const patch = (change: Record<string, unknown> | null) => setRuntimes(thread, (threadRuntimes.get(thread) ?? []).flatMap(runtime => runtime.id !== target.id ? [runtime] : change ? [{ ...runtime, ...change }] : []));
    if (action === 'open_browser') return runtimesOf(thread);
    if (action === 'dismiss') return patch(null);
    const later = (change: Record<string, unknown> | null) => new Promise<PreviewRuntime[]>(resolve => setTimeout(() => resolve(patch(change)), runtimeStepMs()));
    if (action === 'restart_kernel') {
      patch({ state: 'restarting', activity: 'Restarting kernel…', busySince: Date.now(), error: null });
      return later({ state: 'ready', activity: null, busySince: null, error: null });
    }
    if (action === 'stop') {
      // The backend's own word for the step; the pip says "Stopping…" whatever it is called.
      patch({ state: 'stopping', activity: 'Releasing runtime…', busySince: Date.now() });
      return later(null);
    }
    throw new Error('Unknown Colab runtime action.');
  };
  let sandboxes = false;
  /* InstaBox machine images: agent-browser and one ready snapshot (the free plan offers no
   * other templates). `window.__instaboxImagesFail` makes listing fail. */
  const INSTABOX_DEFAULT = 'template:agent-browser';
  let instaboxImage = INSTABOX_DEFAULT;
  const instaboxImages = () => {
    if (!connected.has('instabox')) throw new Error('Connect InstaBox in Settings → Cloud first.');
    if ((globalThis as any).__instaboxImagesFail) throw new Error('InstaBox did not answer in time.');
    return { images: [{ value: INSTABOX_DEFAULT, label: 'agent-browser (default, includes the open-computer-use desktop tool)' }, { value: 'snapshot:sn_preview1', label: 'clean-agents · sn_preview1' }], selected: instaboxImage };
  };
  const connections = () => [...BASE, ...KEYED].map(provider => ({ provider, connected: connected.has(provider), detail: connected.get(provider) ?? null, ...(provider === 'cloudflare' ? { sandboxes: connected.has(provider) && sandboxes } : {}), ...(provider !== 'railway' ? { inheritEnvironment: inheritEnvironment.has(provider) } : {}) }));
  /* DigitalOcean's droplet options: three regions, a size pinned to New York only, one that works
   * everywhere, and the saved pair (nothing at first; create falls back to nyc1 and s-2vcpu-4gb).
   * `__digitalOceanCatalogFail` makes listing fail; picks are recorded in `__doOptionSaves`. */
  let doRegion = '', doSize = '';
  const digitalOceanCatalog = () => {
    if (!connected.has('digitalocean')) throw new Error('Connect DigitalOcean in Settings → Cloud first.');
    if ((globalThis as any).__digitalOceanCatalogFail) throw new Error('DigitalOcean did not answer in time.');
    return {
      regions: [{ value: 'nyc1', label: 'New York 1 (nyc1)' }, { value: 'fra1', label: 'Frankfurt 1 (fra1)' }, { value: 'sgp1', label: 'Singapore 1 (sgp1)' }],
      sizes: [
        { value: 's-2vcpu-4gb', label: '2 vCPU · 4 GB · $24/mo (s-2vcpu-4gb)', regions: ['nyc1', 'fra1', 'sgp1'] },
        { value: 's-4vcpu-8gb', label: '4 vCPU · 8 GB · $48/mo (s-4vcpu-8gb)', regions: ['nyc1'] },
        { value: 'c-2', label: '2 vCPU · 4 GB · $15.75/mo (c-2)', regions: [] },
      ],
      region: doRegion, size: doSize,
    };
  };
  const slug = (value: unknown, what: string, example: string) => {
    const text = String(value ?? '').trim();
    if (text && (text.length > 32 || !/^[a-z0-9_-]+$/.test(text))) throw new Error(`That does not look like a DigitalOcean ${what} (for example ${example}).`);
    return text;
  };
  const find = (id: unknown) => { const machine = machines.find(m => m.id === id); if (!machine) throw new Error('Unknown cloud machine.'); return machine; };
  return {
    inputs,
    connections,
    connect(provider: unknown, key: unknown, options: Record<string, unknown>) {
      if (typeof provider !== 'string' || ![...BASE, ...KEYED].includes(provider)) throw new Error('Unknown cloud provider.');
      if (provider === 'colab') throw new Error('Google Colab connects with Sign in with Google.');
      if (provider === 'modal' && !options.tokenId) throw new Error('Enter the Modal token ID.');
      if (provider === 'blaxel' && !options.workspace) throw new Error('Enter the Blaxel workspace.');
      if (provider !== 'aws' && provider !== 'gcloud' && provider !== 'docker' && (typeof key !== 'string' || !key.trim())) throw new Error('Enter the key.');
      if (key === 'bad') throw new Error(`${provider === 'netlify' ? 'Netlify' : provider === 'daytona' ? 'Daytona' : 'Cloudflare'} refused the credentials (HTTP 401). Check them in Settings → Cloud.`);
      connected.set(provider, provider === 'aws' ? `${options.profile || 'default profile'} · ${options.region}` : provider === 'cloudflare' ? String(options.account) : provider === 'vercel' ? (String(options.team ?? '') || null) : provider === 'railway' ? (String(options.workspace ?? '') || null) : provider === 'netlify' ? (String(options.siteId ?? '') || null) : provider === 'gcloud' ? [options.project, options.region, options.zone].filter(Boolean).join(' · ') : KEYED.includes(provider) ? (provider === 'digitalocean' ? 'API token saved' : (String(options.workspace ?? options.environment ?? options.apiUrl ?? '') || null)) : null);
      return connections();
    },
    /** Providers that can run cloud agents, ready once connected. */
    agentTargets() { return AGENT_TARGETS.map(([provider, label]) => ({ provider, label, ready: connected.has(provider) })); },
    disconnect(provider: unknown) { connected.delete(String(provider)); if (provider === 'cloudflare') sandboxes = false; if (provider === 'instabox') instaboxImage = INSTABOX_DEFAULT; if (provider === 'digitalocean') { doRegion = ''; doSize = ''; } if (provider === 'colab') colab = { ...COLAB_DEFAULTS }; return connections(); },
    colabSignInStart(authMode: unknown, oauthConfigPath?: unknown) {
      if (oauthConfigPath !== undefined && (typeof oauthConfigPath !== 'string' || !oauthConfigPath.trim().endsWith('.json') || oauthConfigPath.includes('missing'))) {
        throw new Error(`No OAuth client file at ${String(oauthConfigPath)}. Choose the client_secret JSON you downloaded from Google Cloud.`);
      }
      // A new start replaces the running attempt, which ends cancelled.
      if (signIn) { const old = signIn; signIn = null; emit('colab-sign-in', { id: old.id, state: 'cancelled' }); }
      const mode = authMode === 'adc' ? 'adc' : 'oauth2';
      const attempt: ColabAttempt = { id: ++signInIds, mode, update: mode === 'adc' ? { state: 'exchanging', message: 'Reading gcloud application-default credentials…' } : { state: 'waiting', url: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1' } };
      signIn = attempt;
      emit('colab-sign-in', { id: attempt.id, ...attempt.update });
      if (!(globalThis as any).__colabSignInHold) setTimeout(() => finishSignIn(attempt), COLAB_STEP_MS);
      return { id: attempt.id };
    },
    colabSignInStatus() { return signIn ? { id: signIn.id, ...signIn.update } : null; },
    colabSignInCancel() {
      const attempt = signIn; signIn = null;
      // The native run reports its end after Cancel returns.
      if (attempt) setTimeout(() => emit('colab-sign-in', { id: attempt.id, state: 'cancelled' }), 0);
      return null;
    },
    colabUsage() {
      requireColab();
      // An unrounded rate, as Google sends it, so the view's number formatting is exercised.
      return { ccuBalance: 94.2, ccuRate: colab.accelerator === 'NONE' ? 0.07 : 1.7600000000000002 };
    },
    colabConfig,
    async colabSetConfig(patch: Record<string, unknown>) {
      // Tests hold a save open with `window.__colabSaveGate` (a promise) to see the UI mid-save.
      await (globalThis as any).__colabSaveGate;
      requireColab();
      if ((globalThis as any).__colabSetConfigFail) throw new Error('Could not save the Colab settings: the disk is full.');
      if (patch.accelerator !== undefined && !COLAB_ACCELERATORS.includes(String(patch.accelerator))) throw new Error('Choose hardware Colab offers.');
      const flags = Object.fromEntries((['highMem', 'nativeTools', 'colabMcp'] as const).filter(key => typeof patch[key] === 'boolean').map(key => [key, patch[key] as boolean]));
      colab = { ...colab, ...(patch.accelerator !== undefined ? { accelerator: String(patch.accelerator) } : {}), ...flags };
      connected.set('colab', colabDetail(colab.accelerator, colab.highMem));
      return colabConfig();
    },
    colabInstallCli() { requireColab(); colabCli = true; return colabConfig(); },
    setColabRuntimes(sessionId: unknown, runtimes: unknown) { return setRuntimes(String(sessionId), Array.isArray(runtimes) ? runtimes : []); },
    colabThreadRuntimes(sessionId: unknown, refresh?: unknown) {
      recordRuntimeCall('cloud_colab_thread_runtimes', { sessionId, refresh: refresh === true });
      return runtimesOf(String(sessionId));
    },
    colabRuntimeAction(sessionId: unknown, endpoint: unknown, action: unknown): PreviewRuntime[] | Promise<PreviewRuntime[]> {
      recordRuntimeCall('cloud_colab_runtime_action', { sessionId, endpoint, action });
      const gate = (globalThis as any).__colabRuntimeGate as Promise<unknown> | undefined;
      return gate ? gate.then(() => runtimeAction(String(sessionId), endpoint, action)) : runtimeAction(String(sessionId), endpoint, action);
    },
    setInheritEnvironment(provider: unknown, inherit: unknown) {
      const id = String(provider);
      if (![...BASE, ...KEYED].includes(id)) throw new Error('Choose an available cloud provider.');
      if (inherit) inheritEnvironment.add(id); else inheritEnvironment.delete(id);
      return connections();
    },
    instaboxImages,
    setInstaboxImage(image: unknown) {
      if (!instaboxImages().images.some(option => option.value === image)) throw new Error('InstaBox can’t create machines from that image on this account. Pick another one.');
      instaboxImage = String(image);
      return instaboxImages();
    },
    digitalOceanCatalog,
    setDigitalOceanOptions(region: unknown, size: unknown) {
      if (!connected.has('digitalocean')) throw new Error('Connect DigitalOcean in Settings → Cloud first.');
      doRegion = slug(region, 'region', 'nyc1 or fra1');
      doSize = slug(size, 'machine size', 's-2vcpu-4gb or c-2');
      ((globalThis as any).__doOptionSaves ??= []).push({ region: doRegion, size: doSize });
      connected.set('digitalocean', [doSize, doRegion].filter(Boolean).join(' · ') || 'API token saved');
      return connections();
    },
    setupSandboxes() { if (!connected.has('cloudflare')) throw new Error('Connect Cloudflare first.'); sandboxes = true; return connections(); },
    list() { return { machines: structuredClone(machines.filter(m => connected.has(kinds[Object.keys(kinds).find(k => kinds[k].provider === m.provider)!].needs))), errors: [] }; },
    create(kind: unknown, name: unknown) {
      const spec = kinds[String(kind)];
      if (!spec || !connected.has(spec.needs)) throw new Error('Connect this provider in Settings → Cloud first.');
      const machine = { id: `${spec.provider}:${String(name)}`, provider: spec.provider, name: String(name), state: 'running', os: spec.os, desktop: spec.desktop, detail: spec.detail };
      machines.push(machine); return structuredClone(machine);
    },
    power(id: unknown, action: unknown) {
      const machine = find(id);
      if (action === 'delete') machines.splice(machines.indexOf(machine), 1);
      else if (action === 'start' || action === 'stop') machine.state = action === 'start' ? 'running' : 'stopped';
      else throw new Error('Unknown action.');
      return null;
    },
    async frame(id: unknown) {
      const machine = find(id);
      if (!machine.desktop) throw new Error('This machine has no screen.');
      if (machine.state !== 'running') throw new Error('This sandbox is stopped. Start it first.');
      const canvas = new OffscreenCanvas(1280, 800), g = canvas.getContext('2d')!;
      g.fillStyle = machine.os === 'windows' ? '#0b5cad' : '#2b2f3a'; g.fillRect(0, 0, 1280, 800);
      g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(`${machine.name} · ${machine.provider}`, 40, 60);
      return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer();
    },
    input(id: unknown, input: Record<string, unknown>) {
      const machine = find(id);
      if (!machine.desktop) throw new Error('This machine has no screen.');
      inputs.push({ id: machine.id, input: structuredClone(input) });
      return `${input.action} done`;
    },
  };
}
