import './simulator.css';
import { icon } from './dom';
import { androidOnly, isWindows } from './platform';
import type { Device3D, DeviceButton, DuoPose, DeviceShape, ScreenGesture } from './simulator-3d';
import { chosenFinish, modelSpec, rememberFinish } from './simulator-models';

/* The inspector's iOS Simulator: one device shown as a 3D model with its live
 * screen. Agents reach the same device through the pandacode_simulator_* tools. */

export type SimDevice = { udid: string; name: string; runtime: string; state: string; family: 'phone' | 'pad'; deviceType: string; platform?: 'ios' | 'android'; duo?: boolean };
export type SimScreen = { width: number; height: number; scale: number; homeButton: boolean; inner?: { width: number; height: number } | null };
export type SimStatus = { available: boolean; axe: boolean; axeInstall: string; android?: boolean; duoAvailable?: boolean; pose?: DuoPose | null; devices: SimDevice[]; selected: string | null; screen: SimScreen | null; error: string | null };
type Input =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number; durationMs: number }
  | { kind: 'swipe'; x: number; y: number; endX: number; endY: number; durationMs: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'button'; button: string };
type ChoiceItem = { id: string; label: string; description?: string; icon?: string; selected?: boolean; disabled?: boolean };

export type SimulatorHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(text: string): void;
  choose(anchor: HTMLElement, title: string, items: ChoiceItem[], onSelect: (id: string) => void): void;
  /** Native progress events, e.g. Android setup. */
  listen?(name: 'android-setup', callback: (event: AndroidSetup) => void): Promise<() => void>;
};
export type AndroidSetup = { step: number; total: number; label: string; done: boolean; error: string | null };

const KEYS: Record<string, string> = { Enter: 'return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Delete: 'delete' };
const TYPE_DELAY = 140, SCROLL_DELAY = 90, SETUP = 'android-setup', ADD_DUO = 'add-duo', DUO_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo';
const POSES: { id: DuoPose; label: string; description: string }[] = [{ id: 'closed', label: 'Closed', description: 'Cover display' }, { id: 'book', label: 'Book', description: 'Inner display, half open' }, { id: 'open', label: 'Open', description: 'Inner display, flat' }];
const poseName = (pose: DuoPose | null | undefined) => POSES.find(p => p.id === pose)?.label ?? 'Closed';
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

/** Windows and Linux have no one-click setup (it uses Homebrew on macOS). */
const NO_SDK = `Install Android Studio (or the Android command-line tools) into ${isWindows ? '%LOCALAPPDATA%\\Android\\Sdk' : '~/Android/Sdk, or set ANDROID_HOME'}, create an emulator in Device Manager, then reopen this tab.`;
/** Windows and Linux run Android emulators only: iOS devices, Xcode and AXe never appear there. */
const forPlatform = (status: SimStatus): SimStatus => {
  if (!androidOnly) return status;
  const devices = status.devices.filter(d => d.platform === 'android');
  const selected = devices.some(d => d.udid === status.selected) ? status.selected : null;
  return { ...status, available: Boolean(status.android) || devices.length > 0, axe: true, duoAvailable: false, pose: null, error: null, devices, selected, screen: selected ? status.screen : null };
};

export function mountSimulator(root: HTMLElement, host: SimulatorHost) {
  root.innerHTML = `<div class="sim-stage-wrap"><button type="button" class="sim-reset" data-sim="reset" aria-label="Face forward" title="Face forward">${icon('reset')}</button><div class="sim-stage" tabindex="0" role="application" aria-label="iOS Simulator. Click the screen to tap, drag on it to swipe, type to enter text. Drag around the device to turn it." aria-describedby="sim-hint" title="Drag to turn · Scroll to zoom · Click the screen to tap · Double-click to face forward"></div></div>
    <p class="sr-only" id="sim-hint">Drag around the device to turn it, scroll to zoom, click the screen to tap, double-click to face forward.</p>
    <p class="sim-status" role="status" hidden></p>
    <div class="sim-axe" role="note" hidden><span>Touch and typing need <strong>AXe</strong>.</span><code></code><button type="button" class="secondary-button" data-sim="copy-axe">${icon('copy')}Copy</button></div>
    <div class="sim-dock">
      <button type="button" class="sim-device" data-sim="device" aria-haspopup="menu" aria-label="Choose simulator">${icon('phone')}<span class="sim-device-name">Simulator</span><small class="sim-device-runtime"></small>${icon('down')}</button>
      <div class="sim-actions" role="toolbar" aria-label="Simulator controls">
        <button type="button" class="icon-button" data-sim="power" aria-label="Boot simulator" title="Boot">${icon('stop')}</button>
        <button type="button" class="icon-button" data-sim="back" aria-label="Back" title="Back" hidden>${icon('back')}</button>
        <button type="button" class="icon-button" data-sim="home" aria-label="Home" title="Home">${icon('circle')}</button>
        <button type="button" class="icon-button" data-sim="recents" aria-label="Recent apps" title="Recent apps" hidden>${icon('square')}</button>
        <button type="button" class="icon-button" data-sim="lock" aria-label="Lock" title="Lock">${icon('lock')}</button>
        <button type="button" class="icon-button" data-sim="pose" aria-haspopup="menu" aria-label="iPhone Duo pose: Closed" title="Closed" hidden>${icon('panel')}</button>
        <button type="button" class="icon-button" data-sim="appearance" aria-label="Toggle dark appearance" title="Light / dark">${icon('moon')}</button>
        <button type="button" class="icon-button" data-sim="capture" aria-label="Copy screenshot" title="Copy screenshot">${icon('camera')}</button>
        <button type="button" class="icon-button sim-finish" data-sim="finish" aria-haspopup="menu" aria-label="Device finish" title="Finish"><span class="sim-finish-dot"></span></button>
      </div>
    </div>`;
  const stage = root.querySelector<HTMLElement>('.sim-stage')!;
  const statusLine = root.querySelector<HTMLElement>('.sim-status')!;
  const button = (name: string) => root.querySelector<HTMLButtonElement>(`[data-sim="${name}"]`)!;

  let status: SimStatus | undefined, device: Device3D | undefined, flat: HTMLImageElement | undefined, settingUp = false;
  let visible = false, disposed = false, pumpGeneration = 0, seq = 0, busy = false, poseBusy = false, poseWanted: DuoPose | undefined, poseEpoch = 0, poll = 0, polling = false, appearance: 'light' | 'dark' = 'light', warnedAxe = false;
  let typed = '', typeTimer = 0, scroll = { dx: 0, dy: 0, at: { x: 0, y: 0 } }, scrollTimer = 0;

  const call = async (command: string, args?: Record<string, unknown>) => forPlatform(await host.call<SimStatus>(command, args));
  const current = (): SimDevice | undefined => status?.devices.find(d => d.udid === status?.selected);
  const booted = () => current()?.state === 'Booted';
  const shape = (): DeviceShape => {
    const screen = status?.screen, base = { homeButton: screen?.homeButton ?? false, family: current()?.family ?? 'phone', deviceType: current()?.deviceType ?? '' };
    if (!current()?.duo) return { width: screen?.width ?? 402, height: screen?.height ?? 874, ...base };
    const cover = { width: screen?.width ?? 466, height: screen?.height ?? 678 }, inner = screen?.inner ?? { width: 951, height: 669 };
    return { ...(status?.pose && status.pose !== 'closed' ? inner : cover), ...base, duo: { cover, inner } };
  };
  const spec = () => modelSpec(current()?.duo ? DUO_TYPE : current()?.deviceType ?? '', current()?.family ?? 'phone');

  function message(text: string): void {
    stage.removeAttribute('aria-busy');
    device?.setMessage(text);
    if (flat) { flat.removeAttribute('src'); flat.alt = text; }
  }
  /** A spinner on the display until its first frame arrives; `aria-busy` tells assistive tech. */
  function loading(): void {
    stage.setAttribute('aria-busy', 'true');
    device?.setLoading(true);
    if (flat) { flat.removeAttribute('src'); flat.alt = 'Loading display…'; }
  }
  function say(text: string): void { statusLine.textContent = text; statusLine.hidden = !text; }

  async function ensureView(): Promise<void> {
    if (device || flat) return;
    try {
      const { mountDevice3D } = await import('./simulator-3d');
      if (disposed) return;
      device = mountDevice3D(stage, { onGesture: gesture => void send(gesture), onButton: name => void press(name), onScroll: queueScroll });
      device.setDark(isDark());
    } catch {
      // Without WebGL the screen still works, flat.
      flat = Object.assign(document.createElement('img'), { className: 'sim-flat', alt: '' });
      flat.addEventListener('click', event => {
        const rect = flat!.getBoundingClientRect(), s = shape();
        void send({ kind: 'tap', x: ((event.clientX - rect.left) / rect.width) * s.width, y: ((event.clientY - rect.top) / rect.height) * s.height });
      });
      stage.append(flat); stage.classList.add('sim-stage-flat');
    }
  }

  function render(): void {
    const chosen = current();
    root.querySelector('.sim-device-name')!.textContent = chosen?.name ?? (status?.available ? 'No simulators' : 'Simulator');
    root.querySelector('.sim-device-runtime')!.textContent = chosen ? `${chosen.runtime} · ${chosen.state === 'Booted' ? 'Running' : chosen.state}` : '';
    button('device').title = chosen ? `${chosen.name} · ${chosen.runtime}` : '';
    const power = button('power');
    power.innerHTML = icon(booted() ? 'stop' : 'play');
    power.setAttribute('aria-label', booted() ? 'Shut down simulator' : 'Boot simulator'); power.title = booted() ? 'Shut down' : 'Boot';
    power.disabled = !chosen || busy;
    for (const name of ['home', 'lock', 'appearance', 'capture', 'back', 'recents']) button(name).disabled = !booted() || busy;
    // Android navigates with Back and Recents beside Home.
    const android = chosen?.platform === 'android';
    button('back').hidden = !android; button('recents').hidden = !android;
    button('appearance').innerHTML = icon(appearance === 'dark' ? 'sun' : 'moon');
    const pose = button('pose'), shown = poseName(status?.pose);
    pose.hidden = !chosen?.duo; pose.setAttribute('aria-label', `iPhone Duo pose: ${shown}`); pose.title = shown; pose.disabled = !booted() || busy;
    const look = chosenFinish(spec());
    button('finish').style.setProperty('--finish', look.color);
    button('finish').setAttribute('aria-label', `Device finish: ${look.name}`); button('finish').title = look.name;
    button('finish').disabled = !chosen;
    const axeNote = root.querySelector<HTMLElement>('.sim-axe')!;
    axeNote.hidden = !status || !status.available || status.axe;
    axeNote.querySelector('code')!.textContent = status?.axeInstall ?? '';
    if (!status) return;
    if (!status.available) { say(androidOnly ? NO_SDK : status.error ?? 'Install Xcode to use the iOS Simulator.'); message(androidOnly ? 'Android SDK needed' : 'Xcode needed'); return; }
    if (!chosen) { say(androidOnly ? 'No Android emulators. Add one in Android Studio → Device Manager.' : 'No iOS simulators. Add one in Xcode → Window → Devices and Simulators.'); message(''); return; }
    say('');
    device?.setShape(shape());
    if (chosen.duo && status.pose && device?.getPose() !== status.pose) device?.setPose(status.pose, false);
    if (busy) return;
    if (!booted()) message(chosen.state === 'Booting' ? 'Booting…' : 'Press ▶ to boot');
  }

  async function refresh(): Promise<void> {
    try {
      // The 3D view loads while the simulator tools answer.
      const view = ensureView();
      let next = await call('simulator_status');
      // Show something useful: the first running device, else the newest one.
      if (!next.selected && next.devices.length) next = await call('simulator_select', { udid: (next.devices.find(d => d.state === 'Booted') ?? next.devices[0]).udid });
      if (disposed) return;
      const changed = next.selected !== status?.selected;
      status = next;
      if (changed) seq = 0;
      await view;
      render();
      pump();
    } catch (error) { say(error instanceof Error ? error.message : String(error)); }
  }

  /* Frames: a long-poll loop while visible and running. */
  function pump(): void {
    const generation = ++pumpGeneration;
    if (!visible || !booted() || !status?.selected) return;
    const udid = status.selected;
    void (async () => {
      let failures = 0;
      while (!disposed && visible && generation === pumpGeneration) {
        try {
          const data = await host.call<ArrayBuffer>('simulator_frame', { udid, after: seq });
          if (generation !== pumpGeneration) return;
          if (data && data.byteLength > 8) {
            seq = Number(new DataView(data).getBigUint64(0, true));
            const blob = new Blob([data.slice(8)]);
            if (device) { const bitmap = await createImageBitmap(blob); if (generation === pumpGeneration) device.setFrame(bitmap); bitmap.close(); }
            else if (flat) { const url = URL.createObjectURL(blob); flat.onload = () => URL.revokeObjectURL(url); flat.src = url; }
            if (generation === pumpGeneration) stage.removeAttribute('aria-busy');
            failures = 0;
          }
        } catch (error) {
          if (generation !== pumpGeneration) return;
          if (++failures >= 3) { message('Screen unavailable'); say(error instanceof Error ? error.message : String(error)); await sleep(2000); void refresh(); return; }
          await sleep(500);
        }
      }
    })();
  }

  async function input(value: Input): Promise<void> {
    const udid = status?.selected; if (!udid || !booted()) return;
    if (status && !status.axe && current()?.platform !== 'android') { if (!warnedAxe) { warnedAxe = true; host.notify(`Touch input needs AXe: ${status.axeInstall}`); } return; }
    try { await host.call<string>('simulator_input', { udid, input: value }); }
    catch (error) { host.notify(error instanceof Error ? error.message : String(error)); }
  }
  async function send(gesture: ScreenGesture): Promise<void> {
    stage.focus({ preventScroll: true });
    await flushTyping();
    await input(gesture);
  }
  async function press(name: DeviceButton | 'back' | 'recents'): Promise<void> { await input({ kind: 'button', button: name }); }

  function queueScroll(dx: number, dy: number, at: { x: number; y: number }): void {
    if (!scroll.dx && !scroll.dy) scroll.at = at;
    scroll.dx += dx; scroll.dy += dy;
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const s = shape(), limit = s.height * 0.38, { dx: sx, dy: sy, at: from } = scroll;
      scroll = { dx: 0, dy: 0, at: { x: 0, y: 0 } };
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const endX = clamp(from.x - clamp(sx, -limit, limit), 1, s.width - 1), endY = clamp(from.y - clamp(sy, -limit, limit), 1, s.height - 1);
      if (Math.hypot(endX - from.x, endY - from.y) >= 8) void input({ kind: 'swipe', x: from.x, y: from.y, endX, endY, durationMs: 220 });
    }, SCROLL_DELAY);
  }

  /* Typing: characters batch into one `type`; special keys flush first. */
  async function flushTyping(): Promise<void> {
    clearTimeout(typeTimer);
    const text = typed; typed = '';
    if (text) await input({ kind: 'type', text });
  }
  stage.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || !booted()) return;
    const named = KEYS[event.key];
    if (named) { event.preventDefault(); void flushTyping().then(() => input({ kind: 'key', key: named })); return; }
    if (event.key.length === 1) {
      event.preventDefault(); typed += event.key;
      clearTimeout(typeTimer); typeTimer = window.setTimeout(() => void flushTyping(), TYPE_DELAY);
    }
  });
  stage.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain'); if (!text || !booted()) return;
    event.preventDefault(); typed += text.slice(0, 2000); void flushTyping();
  });

  async function power(): Promise<void> {
    const chosen = current(); if (!chosen || busy) return;
    const on = chosen.state !== 'Booted';
    busy = true; render(); message(on ? 'Booting…' : 'Shutting down…');
    try {
      status = await call('simulator_power', { udid: chosen.udid, on });
      seq = 0;
    } catch (error) { host.notify(error instanceof Error ? error.message : String(error)); }
    finally { busy = false; render(); pump(); }
  }
  async function capture(): Promise<void> {
    const udid = status?.selected; if (!udid) return;
    try {
      const png = await host.call<ArrayBuffer>('simulator_capture', { udid });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      host.notify('Simulator screenshot copied');
    } catch (error) { host.notify(error instanceof Error ? error.message : String(error)); }
  }
  function chooseDevice(anchor: HTMLElement): void {
    if (!status) return;
    const items: ChoiceItem[] = status.devices.map(d => ({ id: d.udid, label: d.name, description: `${d.duo ? 'Foldable · ' : ''}${d.runtime} · ${d.state === 'Booted' ? 'Running' : d.state}`, icon: 'phone', selected: d.udid === status?.selected }));
    if (status.available && !androidOnly && !status.devices.some(d => d.duo)) items.push({ id: ADD_DUO, label: 'Add iPhone Duo', description: status.duoAvailable ? 'Foldable · creates a simulator' : 'Needs Xcode 27.1 or later', icon: 'plus', disabled: !status.duoAvailable });
    // One-click setup uses Homebrew, so Windows points to Android Studio instead.
    if (!status.android && !androidOnly) items.push({ id: SETUP, label: settingUp ? 'Setting up Android…' : 'Set up Android emulator…', description: 'Downloads about 2 GB with Homebrew', icon: 'download', disabled: settingUp });
    if (!items.length) return;
    host.choose(anchor, 'Devices', items, id => {
      if (id === SETUP) { void setupAndroid(); return; }
      if (id === ADD_DUO) { void addDuo(); return; }
      void call('simulator_select', { udid: id }).then(next => { status = next; seq = 0; render(); pump(); }).catch(error => host.notify(String(error)));
    });
  }
  async function addDuo(): Promise<void> {
    say('Adding iPhone Duo…');
    try { status = await call('simulator_create_duo'); seq = 0; say(''); render(); pump(); }
    catch (error) { say(''); host.notify(error instanceof Error ? error.message : String(error)); }
  }
  /** The hinge moves on click; the simulator follows in the background one fold at a
   * time, always to the newest pose asked for, and the new display shows a spinner until
   * its first frame. A failed fold moves back to the pose the simulator holds. */
  async function setPose(pose: DuoPose): Promise<void> {
    const udid = status?.selected, shown = status?.pose ?? 'closed';
    if (!udid || !status || pose === shown) return;
    poseEpoch++; poseWanted = pose; pumpGeneration++;
    status = { ...status, pose };
    device?.setPose(pose, true); render(); loading();
    if (poseBusy) return;
    poseBusy = true;
    let held = shown;
    try {
      while (poseWanted && !disposed && status?.selected === udid) {
        const target: DuoPose = poseWanted; poseWanted = undefined;
        try {
          const next = await call('simulator_pose', { udid, pose: target });
          held = next.pose ?? target;
          if (!poseWanted && !disposed && next.selected === status?.selected) { status = next; device?.setPose(held, true); }
        } catch (error) {
          if (poseWanted) continue;
          // The old display's newest frame replaces the spinner.
          if (status?.selected === udid) { status = { ...status, pose: held }; device?.setPose(held, true); seq = 0; }
          host.notify(error instanceof Error ? error.message : String(error));
        }
      }
    } finally { poseBusy = false; poseWanted = undefined; render(); pump(); }
  }
  /** The Duo's hinge can move outside PandaCode (Xcode's Device Hub), so follow the real pose while it is on screen. */
  function watchPose(): void {
    clearInterval(poll); poll = 0;
    if (!visible || disposed) return;
    poll = window.setInterval(async () => {
      if (polling || poseBusy || !visible || disposed || !current()?.duo || !booted()) return;
      polling = true;
      const epoch = poseEpoch;
      try {
        const next = await call('simulator_status');
        if (disposed || poseBusy || epoch !== poseEpoch || next.selected !== status?.selected || !next.pose || next.pose === device?.getPose()) return;
        status = next; device?.setPose(next.pose, true); render(); loading(); pump();
      } catch { /* the next tick tries again */ } finally { polling = false; }
    }, 3000);
  }
  /** One-click Android: JDK, SDK tools, emulator, system image and a Pixel AVD, with live progress. */
  async function setupAndroid(): Promise<void> {
    if (settingUp) return;
    settingUp = true;
    say('Setting up the Android emulator…');
    const stop = await host.listen?.('android-setup', event => { if (!event.done) say(`Android setup ${event.step}/${event.total} · ${event.label}`); });
    try {
      const avd = await host.call<string>('android_setup');
      host.notify('Android emulator ready');
      say('');
      await refresh();
      status = await call('simulator_select', { udid: `android:${avd}` });
      seq = 0; render(); pump();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    } finally { settingUp = false; stop?.(); }
  }

  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-sim]'); if (!target || (target as HTMLButtonElement).disabled) return;
    switch (target.dataset.sim) {
      case 'device': chooseDevice(target); break;
      case 'power': void power(); break;
      case 'home': void press('home'); break;
      case 'back': void press('back'); break;
      case 'recents': void press('recents'); break;
      case 'lock': void press('lock'); break;
      case 'appearance': {
        const udid = status?.selected; if (!udid) break;
        appearance = appearance === 'dark' ? 'light' : 'dark'; render();
        void host.call('simulator_appearance', { udid, mode: appearance }).catch(error => host.notify(String(error)));
        break;
      }
      case 'capture': void capture(); break;
      case 'pose': {
        const now = status?.pose ?? 'closed';
        host.choose(target, 'iPhone Duo pose', POSES.map(p => ({ id: p.id, label: p.label, description: p.description, icon: 'phone', selected: p.id === now })), id => void setPose(id as DuoPose));
        break;
      }
      case 'reset': device?.resetView(true); break;
      case 'finish': {
        const model = spec(), now = chosenFinish(model);
        host.choose(target, 'Finish', model.finishes.map(finish => ({ id: finish.id, label: finish.name, icon: 'circle', selected: finish.id === now.id })), id => {
          const finish = model.finishes.find(item => item.id === id); if (!finish) return;
          rememberFinish(model, finish); device?.setFinish(finish); render();
        });
        break;
      }
      case 'copy-axe': void navigator.clipboard.writeText(status?.axeInstall ?? '').then(() => host.notify('Install command copied')); break;
    }
  });
  const themeWatch = new MutationObserver(() => device?.setDark(isDark()));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    show(): void { if (visible) return; visible = true; watchPose(); device?.setActive(true); void refresh().then(() => device?.setActive(visible)); },
    hide(): void { visible = false; clearInterval(poll); pumpGeneration++; device?.setActive(false); },
    refresh,
    dispose(): void {
      disposed = true; visible = false; clearInterval(poll); pumpGeneration++; themeWatch.disconnect();
      clearTimeout(typeTimer); clearTimeout(scrollTimer); device?.dispose(); root.replaceChildren();
    },
  };
}

