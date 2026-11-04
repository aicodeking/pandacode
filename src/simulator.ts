import './simulator.css';
import { icon } from './dom';
import { isWindows } from './platform';
import type { Device3D, DeviceButton, DuoPose, DeviceShape, ScreenGesture } from './simulator-3d';
import { chosenFinish, modelSpec, rememberFinish } from './simulator-models';

/* The inspector's iOS Simulator: one device shown as a 3D model with its live
 * screen. Agents reach the same device through the pandacode_simulator_* tools. */

export type SimDevice = { udid: string; name: string; runtime: string; state: string; family: 'phone' | 'pad'; deviceType: string; platform?: 'ios' | 'android'; duo?: boolean; web?: WebModel };
/** A web app on the mockup alone: viewport in points and the system bars around it. */
type WebModel = { width: number; height: number; top: number; bottom: number; front: 'island' | 'notch' | 'punch' | 'pad' };
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
/* Web apps run in the mockup itself, no simulator: an iframe at the device's viewport. */
const webDevice = (id: string, name: string, deviceType: string, web: WebModel, platform: 'ios' | 'android' = 'ios', family: 'phone' | 'pad' = 'phone'): SimDevice =>
  ({ udid: `web:${id}`, name, runtime: 'Web app', state: 'Booted', family, deviceType, platform, web });
const WEB_DEVICES: SimDevice[] = [
  webDevice('iphone-17-pro', 'iPhone 17 Pro', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', { width: 402, height: 874, top: 62, bottom: 34, front: 'island' }),
  webDevice('iphone-air', 'iPhone Air', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Air', { width: 420, height: 912, top: 62, bottom: 34, front: 'island' }),
  webDevice('iphone-16e', 'iPhone 16e', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16e', { width: 390, height: 844, top: 47, bottom: 34, front: 'notch' }),
  webDevice('pixel-10', 'Pixel 10', 'android:pixel_10', { width: 412, height: 923, top: 40, bottom: 24, front: 'punch' }, 'android'),
  webDevice('ipad-mini', 'iPad mini', 'com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro', { width: 744, height: 1133, top: 24, bottom: 20, front: 'pad' }, 'ios', 'pad'),
];
const WEB_STORE = 'pandacode.simulatorWeb';
const remembered = (): { device?: string; url?: string } => { try { return JSON.parse(localStorage.getItem(WEB_STORE) ?? '{}') ?? {}; } catch { return {}; } };
const remember = (next: { device?: string; url?: string }) => { try { localStorage.setItem(WEB_STORE, JSON.stringify({ ...remembered(), ...next })); } catch { /* This session keeps it. */ } };
/** `5173`, `localhost:5173` and bare hosts become full HTTP(S) addresses. */
function webAddress(input: string): string {
  const value = input.trim();
  const url = new URL(/^\d{2,5}$/.test(value) ? `http://localhost:${value}` : /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : /^(localhost|127\.|\[::1\])/i.test(value) ? `http://${value}` : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS address.');
  return url.href;
}
const BARS = '<svg viewBox="0 0 18 12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>'
  + '<svg viewBox="0 0 16 12" aria-hidden="true"><path d="M8 2.3a9 9 0 0 1 6.4 2.6l1.2-1.2A10.7 10.7 0 0 0 8 .6 10.7 10.7 0 0 0 .4 3.7l1.2 1.2A9 9 0 0 1 8 2.3Zm0 3.4a5.6 5.6 0 0 1 4 1.6l1.2-1.2A7.3 7.3 0 0 0 8 4a7.3 7.3 0 0 0-5.2 2.1L4 7.3a5.6 5.6 0 0 1 4-1.6Zm0 3.4c-.6 0-1.2.3-1.6.7L8 11.4l1.6-1.6c-.4-.4-1-.7-1.6-.7Z"/></svg>'
  + '<span class="sim-web-battery"><i></i></span>';
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

/** Matches `WINDOWS_SETUP` in android_setup.rs: Windows has no one-click setup. */
const NO_SDK = 'Install Android Studio (or the Android command-line tools) into %LOCALAPPDATA%\\Android\\Sdk, create an emulator in Device Manager, then reopen this tab.';
/** Windows runs Android emulators only: iOS devices, Xcode and AXe never appear there. */
const forPlatform = (status: SimStatus): SimStatus => {
  if (!isWindows) return status;
  const devices = status.devices.filter(d => d.platform === 'android');
  const selected = devices.some(d => d.udid === status.selected) ? status.selected : null;
  return { ...status, available: Boolean(status.android) || devices.length > 0, axe: true, duoAvailable: false, pose: null, error: null, devices, selected, screen: selected ? status.screen : null };
};

export function mountSimulator(root: HTMLElement, host: SimulatorHost) {
  root.innerHTML = `<div class="sim-stage-wrap"><button type="button" class="sim-reset" data-sim="reset" aria-label="Face forward" title="Face forward">${icon('reset')}</button><div class="sim-stage" tabindex="0" role="application" aria-label="iOS Simulator. Click the screen to tap, drag on it to swipe, type to enter text. Drag around the device to turn it." aria-describedby="sim-hint" title="Drag to turn · Scroll to zoom · Click the screen to tap · Double-click to face forward"></div></div>
    <p class="sr-only" id="sim-hint">Drag around the device to turn it, scroll to zoom, click the screen to tap, double-click to face forward.</p>
    <p class="sim-status" role="status" hidden></p>
    <div class="sim-axe" role="note" hidden><span>Touch and typing need <strong>AXe</strong>.</span><code></code><button type="button" class="secondary-button" data-sim="copy-axe">${icon('copy')}Copy</button></div>
    <form class="sim-web" hidden><input type="text" inputmode="url" required placeholder="localhost:5173" aria-label="Web app address" spellcheck="false" autocomplete="off"><button type="submit" class="secondary-button">Open</button></form>
    <div class="sim-dock">
      <button type="button" class="sim-device" data-sim="device" aria-haspopup="menu" aria-label="Choose simulator">${icon('phone')}<span class="sim-device-name">Simulator</span><small class="sim-device-runtime"></small>${icon('down')}</button>
      <div class="sim-actions" role="toolbar" aria-label="Simulator controls">
        <button type="button" class="icon-button" data-sim="power" aria-label="Boot simulator" title="Boot">${icon('stop')}</button>
        <button type="button" class="icon-button" data-sim="back" aria-label="Back" title="Back" hidden>${icon('back')}</button>
        <button type="button" class="icon-button" data-sim="home" aria-label="Home" title="Home">${icon('circle')}</button>
        <button type="button" class="icon-button" data-sim="recents" aria-label="Recent apps" title="Recent apps" hidden>${icon('square')}</button>
        <button type="button" class="icon-button" data-sim="lock" aria-label="Lock" title="Lock">${icon('lock')}</button>
        <button type="button" class="icon-button" data-sim="pose" aria-haspopup="menu" aria-label="iPhone Duo pose: Closed" title="Closed" hidden>${icon('panel')}</button>
        <button type="button" class="icon-button" data-sim="reload" aria-label="Reload web app" title="Reload" hidden>${icon('refresh')}</button>
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
  let web: SimDevice | undefined = WEB_DEVICES.find(d => d.udid === remembered().device), webView: HTMLElement | undefined, webKey = '';
  let typed = '', typeTimer = 0, scroll = { dx: 0, dy: 0, at: { x: 0, y: 0 } }, scrollTimer = 0;

  const call = async (command: string, args?: Record<string, unknown>) => forPlatform(await host.call<SimStatus>(command, args));
  const current = (): SimDevice | undefined => web ?? status?.devices.find(d => d.udid === status?.selected);
  const booted = () => current()?.state === 'Booted';
  const shape = (): DeviceShape => {
    if (web?.web) return { width: web.web.width, height: web.web.height, homeButton: false, family: web.family, deviceType: web.deviceType };
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
    root.querySelector('.sim-device-runtime')!.textContent = chosen?.web ? `Web app · ${chosen.web.width}×${chosen.web.height}` : chosen ? `${chosen.runtime} · ${chosen.state === 'Booted' ? 'Running' : chosen.state}` : '';
    button('device').title = chosen ? `${chosen.name} · ${chosen.runtime}` : '';
    const power = button('power');
    power.innerHTML = icon(booted() ? 'stop' : 'play');
    power.setAttribute('aria-label', booted() ? 'Shut down simulator' : 'Boot simulator'); power.title = booted() ? 'Shut down' : 'Boot';
    power.disabled = !chosen || busy;
    for (const name of ['home', 'lock', 'appearance', 'capture', 'back', 'recents']) button(name).disabled = !booted() || busy;
    // Android navigates with Back and Recents beside Home.
    const android = chosen?.platform === 'android';
    button('back').hidden = !android || Boolean(web); button('recents').hidden = !android || Boolean(web);
    // A web app has no hardware to press: its address and reload stand in.
    for (const name of ['power', 'home', 'lock', 'capture']) button(name).hidden = Boolean(web);
    button('reload').hidden = !web; button('reload').disabled = false;
    root.querySelector<HTMLElement>('.sim-web')!.hidden = !web;
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
    if (web) { say(''); device?.setShape(shape()); showWeb(); return; }
    showWeb();
    if (!status) return;
    if (!status.available) { say(isWindows ? NO_SDK : status.error ?? 'Install Xcode to use the iOS Simulator.'); message(isWindows ? 'Android SDK needed' : 'Xcode needed'); return; }
    if (!chosen) { say(isWindows ? 'No Android emulators. Add one in Android Studio → Device Manager.' : 'No iOS simulators. Add one in Xcode → Window → Devices and Simulators.'); message(''); return; }
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
      if (!web && !next.selected && next.devices.length) next = await call('simulator_select', { udid: (next.devices.find(d => d.state === 'Booted') ?? next.devices[0]).udid });
      if (disposed) return;
      const changed = next.selected !== status?.selected;
      status = next;
      if (changed) seq = 0;
      if (!web && (!next.available || !next.devices.length)) web = WEB_DEVICES[0];
      await view;
      render();
      pump();
    } catch (error) {
      // No simulator tools at all: the mockup still runs web apps.
      if (!web) { web = WEB_DEVICES[0]; await ensureView(); render(); return; }
      say(error instanceof Error ? error.message : String(error));
    }
  }

  /* Frames: a long-poll loop while visible and running. */
  function pump(): void {
    const generation = ++pumpGeneration;
    if (!visible || web || !booted() || !status?.selected) return;
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
    const udid = status?.selected; if (web || !udid || !booted()) return;
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
    const items: ChoiceItem[] = (status?.devices ?? []).map(d => ({ id: d.udid, label: d.name, description: `${d.duo ? 'Foldable · ' : ''}${d.runtime} · ${d.state === 'Booted' ? 'Running' : d.state}`, icon: 'phone', selected: !web && d.udid === status?.selected }));
    items.push(...WEB_DEVICES.map(d => ({ id: d.udid, label: d.name, description: `Web app · ${d.web!.width}×${d.web!.height}`, icon: 'globe', selected: d.udid === web?.udid })));
    if (status?.available && !isWindows && !status.devices.some(d => d.duo)) items.push({ id: ADD_DUO, label: 'Add iPhone Duo', description: status.duoAvailable ? 'Foldable · creates a simulator' : 'Needs Xcode 27.1 or later', icon: 'plus', disabled: !status.duoAvailable });
    // One-click setup uses Homebrew, so Windows points to Android Studio instead.
    if (status && !status.android && !isWindows) items.push({ id: SETUP, label: settingUp ? 'Setting up Android…' : 'Set up Android emulator…', description: 'Downloads about 2 GB with Homebrew', icon: 'download', disabled: settingUp });
    if (!items.length) return;
    host.choose(anchor, 'Devices', items, id => {
      if (id === SETUP) { void setupAndroid(); return; }
      if (id === ADD_DUO) { void addDuo(); return; }
      const page = WEB_DEVICES.find(d => d.udid === id);
      remember({ device: page?.udid ?? '' });
      if (page) { web = page; pumpGeneration++; render(); return; }
      web = undefined;
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

  /** The web app's screen: status bar, the page at the viewport left between the system bars, home indicator. */
  const webForm = root.querySelector<HTMLFormElement>('.sim-web')!, webInput = webForm.querySelector('input')!;
  webInput.value = remembered().url ?? '';
  function showWeb(): void {
    const model = web?.web;
    if (!model) { if (webView) { device?.setWeb(null); webView.remove(); webView = undefined; webKey = ''; if (flat) flat.hidden = false; } return; }
    const key = web!.udid;
    if (webKey !== key) {
      const url = webView?.querySelector('iframe')?.src || remembered().url;
      webView?.remove();
      webView = document.createElement('div');
      webView.className = 'sim-web-screen'; webView.dataset.front = model.front;
      webView.style.setProperty('--sim-top', `${model.top}px`); webView.style.setProperty('--sim-bottom', `${model.bottom}px`);
      webView.innerHTML = `<div class="sim-web-status"><span class="sim-web-time">9:41</span><span class="sim-web-icons">${BARS}</span></div><iframe title="Web app" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" allow="clipboard-read; clipboard-write; geolocation; fullscreen"></iframe><p class="sim-web-empty">Type your web app's address below</p><div class="sim-web-home"></div><div class="sim-web-front"></div>`;
      webKey = key;
      if (url) openWeb(url, false);
      if (device) { device.setMessage(''); device.setWeb(webView); } else if (flat) { flat.hidden = true; stage.append(webView); }
    }
    webView!.dataset.theme = appearance;
    webView!.querySelector('iframe')!.style.colorScheme = appearance;
  }
  function openWeb(address: string, save = true): void {
    let url: string;
    try { url = webAddress(address); } catch (error) { host.notify(error instanceof Error ? error.message : String(error)); return; }
    if (save) remember({ url });
    webInput.value = url;
    const frame = webView?.querySelector('iframe'); if (!frame) return;
    frame.src = url; webView!.classList.add('sim-web-live');
  }
  webForm.addEventListener('submit', event => { event.preventDefault(); openWeb(webInput.value); });

  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-sim]'); if (!target || (target as HTMLButtonElement).disabled) return;
    switch (target.dataset.sim) {
      case 'device': chooseDevice(target); break;
      case 'power': void power(); break;
      case 'home': void press('home'); break;
      case 'back': void press('back'); break;
      case 'recents': void press('recents'); break;
      case 'lock': void press('lock'); break;
      case 'reload': { const frame = webView?.querySelector('iframe'); if (frame?.src) frame.src = frame.src; break; }
      case 'appearance': {
        if (web) { appearance = appearance === 'dark' ? 'light' : 'dark'; render(); break; }
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

