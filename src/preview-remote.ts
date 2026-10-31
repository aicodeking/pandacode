/** Browser preview for PandaCode Connect: in-memory sample account and computers, no network. Native builds use src-tauri/src/remote. */
import type { RemoteDevice, RemoteSignIn, RemoteStatus, RemoteTarget } from './remote-types';

const THIS = 'dev-this';
let signedIn = false, hostEnabled = false, notifyEnabled = false, remoteFullAccess = false;
let devices: RemoteDevice[] = [], cancelSignIn: (() => void) | undefined;
const offline = new Set<string>(), revoked = new Set<string>();
const status = (): RemoteStatus => ({ configured: true, signedIn, account: signedIn ? { login: 'octocat' } : undefined, device: { id: THIS, name: 'This Mac', fingerprint: '3fa91c07d2b64e58a1e07c94b25d3f66' }, hostEnabled, notifyEnabled, remoteFullAccess, connected: signedIn });
const sampleDevices = (): RemoteDevice[] => allDevices().filter(device => !revoked.has(device.id));
const allDevices = (): RemoteDevice[] => [
  { id: THIS, name: 'This Mac', platform: 'macOS', fingerprint: '3fa91c07d2b64e58a1e07c94b25d3f66', host: hostEnabled, online: true, lastSeen: Date.now(), current: true },
  { id: 'dev-studio', name: 'Studio iMac', platform: 'macOS', fingerprint: '9b02e4aa71c3d6050c8e2b7f41a96d13', host: true, online: !offline.has('dev-studio'), lastSeen: Date.now(), current: false },
  { id: 'dev-nas', name: 'Home NAS', platform: 'Linux', fingerprint: '17aa5e90b3c4d2867f30e1ac95b4c028', host: true, online: true, lastSeen: Date.now(), current: false },
  { id: 'dev-laptop', name: 'Old laptop', platform: 'Windows', fingerprint: 'c4d81f3e0a9957b26e3d0a8c17f4b952', host: true, online: false, lastSeen: Date.now() - 86_400_000, current: false },
];
export function invokeRemote<T>(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): Promise<T> {
  return Promise.resolve().then(() => handle(command, args, emit) as T);
}
function handle(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): unknown {
  const w = window as any;
  switch (command) {
    case 'remote_status':
      if (w.__remoteStatusFailures > 0) { w.__remoteStatusFailures--; throw new Error('The relay is unavailable.'); }
      w.__remoteOnline = (id: string, online: boolean) => setPreviewOnline(id, online, emit);
      w.__remoteRevoke = (id: string) => { revoked.add(id); devices = sampleDevices(); emit('remote://presence', devices); };
      return status();
    case 'remote_sign_in_start': return { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900 } satisfies RemoteSignIn;
    case 'remote_sign_in_finish': return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cancelSignIn = undefined; signedIn = true; devices = sampleDevices(); emit('remote://status', status()); resolve(status()); }, (window as any).__signInDelay ?? 400);
      cancelSignIn = () => { clearTimeout(timer); reject(new Error('Sign-in cancelled')); };
    });
    case 'remote_sign_in_cancel': cancelSignIn?.(); cancelSignIn = undefined; return {};
    case 'remote_sign_out': signedIn = false; hostEnabled = false; notifyEnabled = false; remoteFullAccess = false; devices = []; emit('remote://status', status()); return status();
    case 'remote_set_host_enabled':
      if (args.fullAccess !== undefined) remoteFullAccess = Boolean(args.fullAccess);
      if (args.enabled !== undefined) { hostEnabled = Boolean(args.enabled); devices = sampleDevices(); emit('remote://presence', devices); }
      return status();
    case 'remote_set_notify_enabled':
      notifyEnabled = Boolean(args.enabled);
      return status();
    case 'remote_devices':
      if (w.__remoteDevicesFailures > 0) { w.__remoteDevicesFailures--; throw new Error('The device list could not be loaded.'); }
      return devices = signedIn ? sampleDevices() : [];
    case 'remote_resubscribe':
      (w.__remoteResubscribes ??= []).push(args);
      if (w.__remoteResubscribeHold) return new Promise<void>(resolve => { w.__remoteResubscribeRelease = () => { w.__remoteResubscribeHold = false; resolve(); }; });
      return {};
    case 'remote_revoke_device': devices = devices.filter(d => d.id !== args.deviceId); emit('remote://presence', devices); return {};
    // Other online computers with remote control on; preview.ts mocks remote_repo_check and remote_start_task.
    case 'remote_targets': return (signedIn ? sampleDevices() : []).filter(d => !d.current && d.host && d.online).map((d): RemoteTarget => ({ deviceId: d.id, name: d.name, platform: d.platform, online: d.online, lastSeen: d.lastSeen }));
    default: throw new Error(`Unknown preview command: ${command}`);
  }
}
/** The host's start stages as `remote://start-progress` events, like `remote/start.rs` sends them.
 * Tests steer it: `__remoteStartStep` (ms per step, default 250), `__remoteStartManual` (each
 * step waits for `__remoteStartNext()`), `__remoteStartFail` (an error text sent at preparing). */
const activeStarts = new Map<string, () => void>();
/** A start whose reply was lost waits here until cancelled (or `undefined` once it attached). */
export function holdPreviewRemoteStart(sessionId: string, cancel: (() => void) | undefined): void {
  if (cancel) activeStarts.set(sessionId, () => { activeStarts.delete(sessionId); cancel(); }); else activeStarts.delete(sessionId);
}
export function cancelPreviewRemoteStart(sessionId: string): boolean {
  const cancel = activeStarts.get(sessionId); if (!cancel) return false;
  cancel(); return true;
}
export async function previewRemoteStart(args: Record<string, any>, emit: (name: string, payload: unknown) => void): Promise<void> {
  const w = window as any, repo = args.repo ?? 'orbit-labs/orbit', key = String(args.sessionId ?? args.startId ?? '');
  const step = () => new Promise<void>((resolve, reject) => {
    const cancel = () => { activeStarts.delete(key); if (w.__remoteStartManual) w.__remoteStartNext = undefined; reject(new Error('Remote start cancelled.')); };
    const next = () => { if (activeStarts.get(key) === cancel) activeStarts.delete(key); resolve(); };
    activeStarts.set(key, cancel);
    if (w.__remoteStartManual) w.__remoteStartNext = next; else setTimeout(next, w.__remoteStartStep ?? 250);
  });
  const send = (stage: string, percent: number | null = null, detail: string | null = null) => emit('remote://start-progress', { deviceId: args.deviceId, startId: args.startId ?? null, repo, stage, percent, detail });
  try {
    await step();
    for (const [stage, percent] of [['finding', null], ['downloading', null], ['downloading', 12], ['downloading', 58], ['downloading', 100], ['preparing', null]] as const) {
      send(stage, percent); await step();
    }
    const failure = w.__remoteStartFail;
    if (failure) { w.__remoteStartFail = undefined; send('error', null, failure); throw new Error(failure); }
    // `__remoteStartBusy`: the host's checkout was busy, so it reports the worktree it used instead.
    send('starting', null, w.__remoteStartBusy ?? null); await step();
  } finally { activeStarts.delete(key); }
}
/** Test hook: a computer going offline or coming back. */
export function setPreviewOnline(id: string, online: boolean, emit: (name: string, payload: unknown) => void): void {
  if (online) offline.delete(id); else offline.add(id);
  devices = sampleDevices(); emit('remote://presence', devices);
}
