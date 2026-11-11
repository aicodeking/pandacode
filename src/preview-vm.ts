/* Browser-preview stand-ins for the native VM commands: engine setup (Tart, or Lima on a
 * Linux platform), a catalog of images, VMs that start and stop, a drawn 1024×768 desktop
 * for frames, and recorded input. `__vmHostIssue` holds a host issue; `__vmOrphan` names a
 * VM to leave running without PandaCode, as after a crash; `__vmCreating` names a VM an agent
 * is creating, listed as stopped and creating for a few status checks, then stopped and
 * starting for a few more (Lima boots it under the same claim) before it runs. */
import { isLinux } from './platform';
import type { Vm, VmHostIssue, VmImage, VmStatus } from './vm-panel';

const IMAGES: VmImage[] = [
  { id: 'ubuntu', name: 'Ubuntu 24.04', os: 'linux', source: 'ghcr.io/cirruslabs/ubuntu:latest', downloadGb: 5, memoryMb: 2048, cpus: 2 },
  { id: 'debian', name: 'Debian', os: 'linux', source: 'ghcr.io/cirruslabs/debian:latest', downloadGb: 4, memoryMb: 2048, cpus: 2 },
  { id: 'fedora', name: 'Fedora', os: 'linux', source: 'ghcr.io/cirruslabs/fedora:latest', downloadGb: 5, memoryMb: 2048, cpus: 2 },
  { id: 'macos-tahoe', name: 'macOS Tahoe', os: 'darwin', source: 'ghcr.io/cirruslabs/macos-tahoe-base:latest', downloadGb: 30, memoryMb: 4096, cpus: 4 },
  { id: 'macos-sequoia', name: 'macOS Sequoia', os: 'darwin', source: 'ghcr.io/cirruslabs/macos-sequoia-base:latest', downloadGb: 28, memoryMb: 4096, cpus: 4 },
];
const LIMA_IMAGES: VmImage[] = [
  { id: 'ubuntu', name: 'Ubuntu 26.04', os: 'linux', source: 'template://ubuntu-lts', downloadGb: 1, memoryMb: 2048, cpus: 2 },
  { id: 'debian', name: 'Debian 13', os: 'linux', source: 'template://debian', downloadGb: 1, memoryMb: 2048, cpus: 2 },
  { id: 'fedora', name: 'Fedora 44', os: 'linux', source: 'template://fedora', downloadGb: 1, memoryMb: 2048, cpus: 2 },
];

export function createPreviewVm() {
  const images = isLinux ? LIMA_IMAGES : IMAGES;
  let installed = false, shown: string | null = null;
  const vms: Vm[] = [];
  const desktops = new Set<string>();
  /** Like the native install: running for a couple of status checks, then done. */
  let installing: string | null = null, checks = 0;
  /** A VM still downloading, as when an agent creates one: the status checks left until it is ready. */
  let creating: string | null = null, downloads = 0;
  /** The VM booting after that download: the status checks left until it runs. */
  let booting: string | null = null, boots = 0;
  const inputs: { name: string; input: Record<string, unknown> }[] = [];
  const starts: { name: string; share: string | null }[] = [];
  let mark: { x: number; y: number } | null = null, typed = '';
  const status = (): VmStatus => {
    if (installing && ++checks > 2) { const vm = vms.find(v => v.name === installing); if (vm) vm.desktop = null; desktops.add(installing); installing = null; }
    const preview = globalThis as { __vmHostIssue?: VmHostIssue; __vmOrphan?: string; __vmCreating?: string };
    if (preview.__vmCreating) {
      const image = images[0];
      vms.push({ name: preview.__vmCreating, running: false, attached: false, creating: true, os: image.os, memoryMb: image.memoryMb, cpus: image.cpus, sizeGb: image.downloadGb, desktop: null });
      creating = shown = preview.__vmCreating; downloads = 3; delete preview.__vmCreating;
    } else if (creating && --downloads <= 0) {
      const vm = vms.find(v => v.name === creating); creating = null;
      if (vm) { vm.creating = false; vm.starting = true; booting = vm.name; boots = 2; }
    } else if (booting && --boots <= 0) {
      const vm = vms.find(v => v.name === booting); booting = null;
      if (vm) { vm.starting = false; startVm(vm); }
    }
    const orphan = vms.find(vm => vm.name === preview.__vmOrphan);
    if (orphan) { orphan.attached = false; delete preview.__vmOrphan; }
    return { supported: true, installed, engine: isLinux ? 'lima' : 'tart', hostIssue: preview.__vmHostIssue ?? null, vms: structuredClone(vms), shown, images: structuredClone(images) };
  };
  const startVm = (vm: Vm) => {
    vm.running = vm.attached = true;
    if (vm.os === 'linux' && !desktops.has(vm.name)) { vm.desktop = 'installing'; installing = vm.name; checks = 0; }
  };
  const find = (name: unknown) => { const vm = vms.find(candidate => candidate.name === name); if (!vm) throw new Error('No VM with that name.'); return vm; };
  const ready = (name: unknown) => { const vm = find(name); if (vm.creating) throw new Error(`${vm.name} is still being created.`); if (vm.starting) throw new Error(`${vm.name} is already starting.`); return vm; };

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
    setup() { installed = true; return isLinux ? '/home/you/.local/share/pandacode/lima-2.2.1/bin/limactl' : '/Users/you/Applications/tart.app/Contents/MacOS/tart'; },
    show(name: unknown) { if (name != null && !String(name).includes(':')) find(name); shown = name == null ? null : String(name); return status(); },
    create(image: unknown, name: unknown) {
      const found = images.find(candidate => candidate.id === image);
      if (!found) throw new Error('Unknown VM image.');
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('VM names use lowercase letters, digits and dashes.');
      if (vms.some(vm => vm.name === name)) throw new Error(`A VM named ${name} already exists.`);
      const vm: Vm = { name, running: false, attached: false, os: found.os, memoryMb: found.memoryMb, cpus: found.cpus, sizeGb: found.downloadGb, desktop: null };
      vms.push(vm); startVm(vm); starts.push({ name, share: null });
      shown = name; return status();
    },
    power(name: unknown, action: unknown, share: unknown) {
      const vm = ready(name);
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
const BASE = ['daytona', 'cloudflare', 'aws', 'vercel', 'railway', 'netlify', 'gcloud', 'docker'];
const KEYED = ['digitalocean', 'vultr', 'hetzner', 'runpod', 'e2b', 'modal', 'codesandbox', 'runloop', 'blaxel', 'tensorlake', 'freestyle', 'boat', 'instabox'];
const AGENT_TARGETS = [['e2b', 'E2B'], ['daytona', 'Daytona'], ['docker', 'Docker'], ['digitalocean', 'DigitalOcean'], ['vultr', 'Vultr'], ['hetzner', 'Hetzner'], ['runpod', 'RunPod'], ['modal', 'Modal'], ['vercel', 'Vercel Sandbox'], ['codesandbox', 'CodeSandbox'], ['runloop', 'Runloop'], ['blaxel', 'Blaxel'], ['tensorlake', 'Tensorlake'], ['freestyle', 'Freestyle'], ['boat', 'boat'], ['instabox', 'InstaBox'], ['cloudflare', 'Cloudflare'], ['aws', 'AWS EC2'], ['gcloud', 'Google Cloud']] as const;
type PreviewCloudMachine = { id: string; provider: string; name: string; state: string; os: string; desktop: boolean; detail: string };
export function createPreviewCloud() {
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
  const find = (id: unknown) => { const machine = machines.find(m => m.id === id); if (!machine) throw new Error('Unknown cloud machine.'); return machine; };
  return {
    inputs,
    connections,
    connect(provider: unknown, key: unknown, options: Record<string, unknown>) {
      if (typeof provider !== 'string' || ![...BASE, ...KEYED].includes(provider)) throw new Error('Unknown cloud provider.');
      if (provider === 'modal' && !options.tokenId) throw new Error('Enter the Modal token ID.');
      if (provider === 'blaxel' && !options.workspace) throw new Error('Enter the Blaxel workspace.');
      if (provider !== 'aws' && provider !== 'gcloud' && provider !== 'docker' && (typeof key !== 'string' || !key.trim())) throw new Error('Enter the key.');
      if (key === 'bad') throw new Error(`${provider === 'netlify' ? 'Netlify' : provider === 'daytona' ? 'Daytona' : 'Cloudflare'} refused the credentials (HTTP 401). Check them in Settings → Cloud.`);
      connected.set(provider, provider === 'aws' ? `${options.profile || 'default profile'} · ${options.region}` : provider === 'cloudflare' ? String(options.account) : provider === 'vercel' ? (String(options.team ?? '') || null) : provider === 'railway' ? (String(options.workspace ?? '') || null) : provider === 'netlify' ? (String(options.siteId ?? '') || null) : provider === 'gcloud' ? [options.project, options.region, options.zone].filter(Boolean).join(' · ') : KEYED.includes(provider) ? (String(options.workspace ?? options.environment ?? options.apiUrl ?? '') || null) : null);
      return connections();
    },
    /** Providers that can run cloud agents, ready once connected. */
    agentTargets() { return AGENT_TARGETS.map(([provider, label]) => ({ provider, label, ready: connected.has(provider) })); },
    disconnect(provider: unknown) { connected.delete(String(provider)); if (provider === 'cloudflare') sandboxes = false; if (provider === 'instabox') instaboxImage = INSTABOX_DEFAULT; return connections(); },
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
