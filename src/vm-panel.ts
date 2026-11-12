import './vm-panel.css';
import { escape, icon } from './dom';
import { cloudName, createOptions, machines, type CloudConnection, type CloudMachine, type Machine } from './vm-machines';
import { errorText } from './error-text';

/* The inspector's VM panel: one local macOS or Linux VM's live screen, which you can
 * click, scroll and type into. Agents reach the same machines through pandacode_vm_*. */

export type VmImage = { id: string; name: string; os: 'linux' | 'darwin'; source: string; downloadGb: number; memoryMb: number; cpus: number };
export type Vm = { name: string; running: boolean; attached: boolean; os: string; memoryMb: number; cpus: number; sizeGb: number; desktop?: 'installing' | 'failed' | null; desktopError?: string | null };
export type VmStatus = { supported: boolean; installed: boolean; vms: Vm[]; shown: string | null; images: VmImage[] };
type ChoiceItem = { id: string; label: string; description?: string; icon?: string; selected?: boolean };
export type VmHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(text: string): void;
  choose(anchor: HTMLElement, title: string, items: ChoiceItem[], onSelect: (id: string) => void): void;
  /** The current project's folder, offered to share read-only when a VM starts. */
  project(): string | null;
};

const FRAME_GAP = 220, CLOUD_FRAME_GAP = 1200, TYPE_DELAY = 120, NOTCH = 40, SHARE_KEY = 'pandacode.vmShareProject';
const KEYS: Record<string, string> = { Enter: 'Return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ' ': 'space' };
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

export function mountVmPanel(root: HTMLElement, host: VmHost) {
  root.innerHTML = `<div class="vm-stage" tabindex="0" role="application" aria-label="VM screen. Click to use it; type while it is focused.">
      <canvas class="vm-screen" role="img" aria-label="VM screen" hidden></canvas>
      <div class="vm-empty"></div>
    </div>
    <p class="vm-status" role="status" hidden></p>
    <div class="vm-dock">
      <button type="button" class="vm-select" data-vm="select" aria-haspopup="menu" aria-label="Choose VM">${icon('monitor')}<span class="vm-name">Machines</span><small class="vm-detail"></small>${icon('down')}</button>
      <div class="vm-actions" role="toolbar" aria-label="VM controls">
        <button type="button" class="icon-button" data-vm="power" aria-label="Start VM" title="Start">${icon('play')}</button>
        <button type="button" class="icon-button" data-vm="suspend" aria-label="Suspend VM" title="Suspend (frees memory)" hidden>${icon('pause')}</button>
        <button type="button" class="icon-button" data-vm="desktop" aria-label="Add a desktop" title="Add a desktop for computer use" hidden>${icon('grid')}</button>
        <button type="button" class="icon-button" data-vm="share" aria-label="Share project read-only at start" title="Share this project read-only when the VM starts" aria-pressed="false">${icon('folder')}</button>
        <button type="button" class="icon-button" data-vm="new" aria-label="New VM" title="New machine" aria-haspopup="menu">${icon('plus')}</button>
      </div>
    </div>`;
  const stage = root.querySelector<HTMLElement>('.vm-stage')!;
  // Frames are drawn, not loaded: the app's CSP allows no blob: images.
  const screen = root.querySelector<HTMLCanvasElement>('.vm-screen')!;
  const paint = screen.getContext('2d')!;
  const empty = root.querySelector<HTMLElement>('.vm-empty')!;
  const statusLine = root.querySelector<HTMLElement>('.vm-status')!;
  const dock = root.querySelector<HTMLElement>('.vm-dock')!;
  const button = (name: string) => dock.querySelector<HTMLButtonElement>(`[data-vm="${name}"]`)!;
  let status: VmStatus | undefined, visible = false, disposed = false, pump = 0, busy = '', painted = false, desktopNotice = false;
  let cloud: CloudMachine[] = [], connections: CloudConnection[] = [];
  let queue: Promise<unknown> = Promise.resolve(), typed = '', typeTimer = 0, wheel = 0, wheelTimer = 0;
  let pressed: { x: number; y: number; moved: boolean } | null = null;
  let share = (() => { try { return localStorage.getItem(SHARE_KEY) === 'true'; } catch { return false; } })();

  const all = () => machines(status, cloud);
  const current = (): Machine | undefined => { const list = all(); return list.find(m => m.key === status?.shown) ?? (list.length === 1 ? list[0] : undefined); };
  const live = () => Boolean(current()?.live);
  const anyCloud = () => connections.some(c => c.connected);
  function say(text: string): void { statusLine.textContent = text; statusLine.hidden = !text; }
  const failure = (error: unknown) => errorText(error);

  function emptyState(): string {
    if (!status) return '<p>Loading machines…</p>';
    const vm = current();
    if (!vm) {
      if (all().length) return '<p>Choose a machine below.</p>';
      const setup = status.supported && !status.installed ? `<button type="button" class="primary-button" data-vm="setup">Set up VMs</button><small>Downloads Tart from Cirrus Labs and checks Apple's notarization. Free for personal and small-team use.</small>` : '';
      const options = createOptions(status, connections);
      const local = status.supported ? "PandaCode runs Linux and macOS VMs on Apple's Virtualization framework: headless, and only the memory you give it." : 'Local VMs need a Mac with Apple silicon.';
      return `<strong>${options.length ? 'Create a machine' : 'Run Linux, macOS and Windows machines'}</strong><p>Agents can see, click, type and run commands in an isolated machine. ${local}${anyCloud() ? '' : ' Cloud sandboxes from Daytona, Cloudflare and AWS connect in Settings → Agents.'}</p>${setup}${options.length ? `<div class="vm-images">${options.map(option => `<button type="button" class="secondary-button" data-vm-create="${escape(option.id)}">${escape(option.label)}<small>${escape(option.description)}</small></button>`).join('')}</div>` : ''}`;
    }
    if (vm.elsewhere) return `<strong>${escape(vm.name)} is running outside PandaCode</strong><p>Stop it, then start it here to see its screen.</p><button type="button" class="secondary-button" data-vm="power">Stop</button>`;
    if (!vm.running) return `<strong>${escape(vm.name)} is ${vm.os === 'darwin' && !vm.cloud ? 'stopped or suspended' : 'stopped'}</strong><p>${escape(vm.detail)}</p>${vm.canStart ? '<button type="button" class="primary-button" data-vm="power">Start</button>' : ''}`;
    if (!vm.desktop) return `<strong>${escape(vm.name)} has no screen</strong><p>Agents use it with commands (vm_exec). ${escape(vm.detail)}</p>`;
    return '<p>Connecting to the screen…</p>';
  }
  function render(): void {
    const vm = current();
    empty.innerHTML = emptyState();
    empty.hidden = live() && painted;
    screen.hidden = !live() || !painted;
    root.querySelector('.vm-name')!.textContent = vm?.name ?? 'Machines';
    root.querySelector('.vm-detail')!.textContent = vm ? vm.detail : '';
    const power = button('power');
    power.disabled = !vm || Boolean(busy) || (!vm.running && !vm.canStart);
    power.innerHTML = icon(vm?.running ? 'stop' : 'play');
    power.setAttribute('aria-label', vm?.running ? 'Stop VM' : 'Start VM'); power.title = vm?.running ? 'Stop' : 'Start';
    button('suspend').hidden = !(vm && !vm.cloud && vm.os === 'darwin' && live());
    // Desktops install on their own; the button is only a retry after a failure.
    button('desktop').hidden = !(vm && !vm.cloud && vm.os === 'linux' && live() && vm.local?.desktop === 'failed');
    if (!busy && vm?.local?.desktop === 'installing' && live()) say('Installing a desktop for agents (a few minutes). The console shows until it is ready; commands already work.');
    else if (!busy && vm?.local?.desktop === 'failed' && live()) say(vm.local.desktopError ?? 'The desktop could not be installed.');
    else if (!busy && desktopNotice) say('');
    desktopNotice = Boolean(vm?.local?.desktop && live());
    button('share').hidden = Boolean(vm?.cloud);
    button('share').setAttribute('aria-pressed', String(share));
    button('share').disabled = !host.project();
    button('new').disabled = !createOptions(status, connections).length || Boolean(busy);
    button('select').disabled = !all().length;
    for (const name of ['suspend', 'desktop']) button(name).disabled = Boolean(busy);
    stage.classList.toggle('vm-live', live());
  }

  async function refresh(): Promise<void> {
    const [local, remote, linked] = await Promise.allSettled([host.call<VmStatus>('vm_status'), host.call<{ machines: CloudMachine[]; errors: string[] }>('cloud_machines'), host.call<CloudConnection[]>('cloud_connections')]);
    if (disposed) return;
    if (local.status === 'fulfilled') status = local.value; else say(failure(local.reason));
    if (remote.status === 'fulfilled') { cloud = remote.value.machines; if (remote.value.errors.length && !busy) say(remote.value.errors.join(' ')); }
    if (linked.status === 'fulfilled') connections = linked.value;
    render();
    void frames();
  }
  /** One action at a time; the status line says what is happening. */
  async function run(label: string, work: () => Promise<unknown>, done = ''): Promise<void> {
    if (busy) return;
    busy = label || 'busy'; say(label); render();
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'vms' in result) status = result as VmStatus;
      say(done);
    } catch (error) { say(failure(error)); }
    finally { busy = ''; if (!disposed) { await refresh(); } }
  }
  const power = () => {
    const vm = current(); if (!vm) return;
    const action = vm.running ? 'stop' : 'start';
    const label = `${vm.running ? 'Stopping' : 'Starting'} ${vm.name}…`;
    if (vm.cloud) return run(label, () => host.call('cloud_power', { id: vm.key, action }));
    return run(label, () => host.call<VmStatus>('vm_power', { name: vm.key, action, ...(action === 'start' ? { share: share ? host.project() : null } : {}) }));
  };
  function uniqueName(image: string): string {
    const taken = new Set(status?.vms.map(vm => vm.name));
    let name = `pandacode-${image}`;
    for (let n = 2; taken.has(name); n++) name = `pandacode-${image}-${n}`;
    return name;
  }
  function create(option: string): void {
    if (option.startsWith('cloud:')) {
      const provider = option.slice(6), label = createOptions(status, connections).find(o => o.id === option)?.label ?? 'cloud machine';
      void run(`Creating a ${label}…`, async () => {
        const machine = await host.call<CloudMachine>('cloud_create', { provider, name: cloudName() });
        await host.call('vm_show', { name: machine.id });
      }, `${label} created. Cloud machines can take a minute or more to be ready.`);
      return;
    }
    const id = option.replace(/^image:/, '');
    const image = status?.images.find(candidate => candidate.id === id); if (!image) return;
    void run(`Downloading ${image.name} (about ${image.downloadGb} GB). This can take a while…`, () => host.call<VmStatus>('vm_create', { image: id, name: uniqueName(id) }), image.os === 'linux' ? '' : `${image.name} is starting.`);
  }
  function chooseNew(anchor: HTMLElement): void {
    host.choose(anchor, 'New machine', createOptions(status, connections).map(option => ({ id: option.id, label: option.label, description: option.description, icon: 'monitor' })), create);
  }
  function chooseVm(anchor: HTMLElement): void {
    const vm = current();
    const items: ChoiceItem[] = all().map(machine => ({ id: `vm:${machine.key}`, label: machine.name, description: machine.detail, icon: 'monitor', selected: machine.key === vm?.key }));
    if (vm) items.push({ id: 'delete', label: `Delete ${vm.name}`, description: vm.cloud ? 'Removes it from your cloud account' : `Frees about ${vm.local?.sizeGb ?? 0} GB`, icon: 'trash' });
    host.choose(anchor, 'Machines', items, id => {
      if (id === 'delete' && vm) void run(`Deleting ${vm.name}…`, () => vm.cloud ? host.call('cloud_power', { id: vm.key, action: 'delete' }) : host.call<VmStatus>('vm_power', { name: vm.key, action: 'delete' }), `${vm.name} is deleted.`);
      else if (id.startsWith('vm:')) void run('', () => host.call<VmStatus>('vm_show', { name: id.slice(3) }));
    });
  }

  /** Frames while the panel shows a machine whose screen is available; stops when hidden or stopped. */
  async function frames(): Promise<void> {
    const generation = ++pump;
    while (!disposed && visible && generation === pump && live()) {
      const vm = current()!;
      try {
        const bytes = vm.cloud ? await host.call<ArrayBuffer>('cloud_frame', { id: vm.key }) : await host.call<ArrayBuffer>('vm_frame', { name: vm.key });
        if (generation !== pump) break;
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (generation !== pump) { bitmap.close(); break; }
        if (screen.width !== bitmap.width || screen.height !== bitmap.height) { screen.width = bitmap.width; screen.height = bitmap.height; }
        paint.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (!painted) { painted = true; render(); }
      } catch (error) {
        say(failure(error));
        await sleep(vm.cloud ? 4000 : 0);
        await refresh();
        return;
      }
      // Cloud screens cost a round trip each; refresh them less often.
      await sleep(vm.cloud ? CLOUD_FRAME_GAP : FRAME_GAP);
    }
  }

  /** Screen pixels under a pointer event, in the frame's own pixels (what agents see). */
  function at(event: MouseEvent): { x: number; y: number } {
    // The frame is letterboxed inside the element (object-fit: contain), whatever size CSS gives it.
    const box = screen.getBoundingClientRect();
    const scale = Math.min(box.width / screen.width, box.height / screen.height);
    const left = box.left + (box.width - screen.width * scale) / 2, top = box.top + (box.height - screen.height * scale) / 2;
    const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 0), max - 1);
    return { x: clamp((event.clientX - left) / scale, screen.width), y: clamp((event.clientY - top) / scale, screen.height) };
  }
  function send(input: Record<string, unknown>): void {
    const vm = current(); if (!vm || !live()) return;
    queue = queue.then(() => vm.cloud ? host.call('cloud_input', { id: vm.key, input }) : host.call('vm_input', { name: vm.key, input })).catch(error => say(failure(error)));
  }
  function flushTyping(): void { window.clearTimeout(typeTimer); if (typed) { send({ action: 'type', text: typed }); typed = ''; } }

  screen.addEventListener('pointerdown', event => { if (event.button !== 0) return; stage.focus({ preventScroll: true }); pressed = { ...at(event), moved: false }; screen.setPointerCapture(event.pointerId); });
  screen.addEventListener('pointermove', event => { if (pressed) { const point = at(event); pressed.moved ||= Math.hypot(point.x - pressed.x, point.y - pressed.y) > 6; } });
  screen.addEventListener('pointerup', event => {
    if (!pressed) return;
    const start = pressed, end = at(event); pressed = null;
    flushTyping();
    send(start.moved ? { action: 'drag', x: start.x, y: start.y, endX: end.x, endY: end.y } : { action: 'click', ...start });
  });
  screen.addEventListener('contextmenu', event => { event.preventDefault(); flushTyping(); send({ action: 'right_click', ...at(event) }); });
  screen.addEventListener('wheel', event => {
    event.preventDefault();
    wheel += event.deltaY;
    const point = at(event);
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => {
      const notches = Math.round(wheel / NOTCH); wheel = 0;
      if (notches) send({ action: 'scroll', ...point, direction: notches > 0 ? 'down' : 'up', amount: Math.min(Math.abs(notches), 15) });
    }, 60);
  }, { passive: false });
  stage.addEventListener('keydown', event => {
    if (!live() || event.isComposing) return;
    const modifiers = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.metaKey && 'cmd'].filter(Boolean) as string[];
    if (event.key.length === 1 && !modifiers.length) {
      event.preventDefault();
      typed += event.key;
      window.clearTimeout(typeTimer); typeTimer = window.setTimeout(flushTyping, TYPE_DELAY);
      return;
    }
    const key = KEYS[event.key] ?? (/^F([1-9]|1[0-2])$/.test(event.key) ? event.key : event.key.length === 1 ? event.key.toLowerCase() : '');
    if (!key) return;
    event.preventDefault();
    flushTyping();
    send({ action: 'key', keys: [...modifiers, ...(event.shiftKey && event.key.length > 1 ? ['shift'] : []), key].join('+') });
  });

  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-vm],[data-vm-create]') : null;
    if (!target || (target as HTMLButtonElement).disabled) return;
    if (target.dataset.vmCreate) { create(target.dataset.vmCreate); return; }
    const vm = current();
    switch (target.dataset.vm) {
      case 'setup': void run('Downloading and checking Tart…', () => host.call<string>('vm_setup'), 'Tart is installed. Create a VM to begin.'); break;
      case 'power': void power(); break;
      case 'suspend': if (vm) void run(`Suspending ${vm.name}…`, () => host.call<VmStatus>('vm_power', { name: vm.key, action: 'suspend' }), `${vm.name} is suspended and uses no memory.`); break;
      case 'desktop': if (vm) void run(`Adding a desktop to ${vm.name} (a few minutes)…`, () => host.call<string>('vm_desktop', { name: vm.key }), 'Desktop ready.'); break;
      case 'share': share = !share; try { localStorage.setItem(SHARE_KEY, String(share)); } catch { /* This window keeps it. */ } render(); break;
      case 'new': chooseNew(target); break;
      case 'select': chooseVm(target); break;
    }
  });

  return {
    show(): void { if (visible) return; visible = true; void refresh(); },
    hide(): void { visible = false; pump++; flushTyping(); },
    refresh,
    dispose(): void { disposed = true; pump++; root.replaceChildren(); },
  };
}
