/** Browser preview for PandaCode Connect: in-memory sample account and computers, no network. Native builds use src-tauri/src/remote. */
import type { RemoteDevice, RemoteSignIn, RemoteStatus, RemoteTarget } from './remote-types';

const THIS = 'dev-this';
let signedIn = false, hostEnabled = false, remoteFullAccess = false;
let devices: RemoteDevice[] = [], cancelSignIn: (() => void) | undefined;
const offline = new Set<string>();
const status = (): RemoteStatus => ({ configured: true, signedIn, account: signedIn ? { login: 'octocat' } : undefined, device: { id: THIS, name: 'This Mac', fingerprint: '3fa91c07d2b64e58a1e07c94b25d3f66' }, hostEnabled, remoteFullAccess, connected: signedIn });
const sampleDevices = (): RemoteDevice[] => [
  { id: THIS, name: 'This Mac', platform: 'macOS', fingerprint: '3fa91c07d2b64e58a1e07c94b25d3f66', host: hostEnabled, online: true, lastSeen: Date.now(), current: true },
  { id: 'dev-studio', name: 'Studio iMac', platform: 'macOS', fingerprint: '9b02e4aa71c3d6050c8e2b7f41a96d13', host: true, online: !offline.has('dev-studio'), lastSeen: Date.now(), current: false },
  { id: 'dev-nas', name: 'Home NAS', platform: 'Linux', fingerprint: '17aa5e90b3c4d2867f30e1ac95b4c028', host: true, online: true, lastSeen: Date.now(), current: false },
  { id: 'dev-laptop', name: 'Old laptop', platform: 'Windows', fingerprint: 'c4d81f3e0a9957b26e3d0a8c17f4b952', host: true, online: false, lastSeen: Date.now() - 86_400_000, current: false },
];
export function invokeRemote<T>(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): Promise<T> {
  return Promise.resolve().then(() => handle(command, args, emit) as T);
}
function handle(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): unknown {
  switch (command) {
    case 'remote_status': (window as any).__remoteOnline = (id: string, online: boolean) => setPreviewOnline(id, online, emit); return status();
    case 'remote_sign_in_start': return { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900 } satisfies RemoteSignIn;
    case 'remote_sign_in_finish': return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cancelSignIn = undefined; signedIn = true; devices = sampleDevices(); emit('remote://status', status()); resolve(status()); }, (window as any).__signInDelay ?? 400);
      cancelSignIn = () => { clearTimeout(timer); reject(new Error('Sign-in cancelled')); };
    });
    case 'remote_sign_in_cancel': cancelSignIn?.(); cancelSignIn = undefined; return {};
    case 'remote_sign_out': signedIn = false; hostEnabled = false; remoteFullAccess = false; devices = []; emit('remote://status', status()); return status();
    case 'remote_set_host_enabled':
      if (args.fullAccess !== undefined) remoteFullAccess = Boolean(args.fullAccess);
      if (args.enabled !== undefined) { hostEnabled = Boolean(args.enabled); devices = sampleDevices(); emit('remote://presence', devices); }
      return status();
    case 'remote_devices': return devices = signedIn ? sampleDevices() : [];
    case 'remote_revoke_device': devices = devices.filter(d => d.id !== args.deviceId); emit('remote://presence', devices); return {};
    // Other online computers with remote control on; preview.ts mocks remote_repo_check and remote_start_task.
    case 'remote_targets': return (signedIn ? sampleDevices() : []).filter(d => !d.current && d.host && d.online).map((d): RemoteTarget => ({ deviceId: d.id, name: d.name, platform: d.platform, online: d.online }));
    default: throw new Error(`Unknown preview command: ${command}`);
  }
}
/** Test hook: a computer going offline or coming back. */
export function setPreviewOnline(id: string, online: boolean, emit: (name: string, payload: unknown) => void): void {
  if (online) offline.delete(id); else offline.add(id);
  devices = sampleDevices(); emit('remote://presence', devices);
}
