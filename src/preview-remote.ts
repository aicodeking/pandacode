/** Browser preview for PandaCode Connect: in-memory sample account and computers, no network. Native builds use src-tauri/src/remote. */
import type { RemoteDevice, RemoteSignIn, RemoteStatus, RemoteTarget } from './remote-types';
import type { Access, LinkRequest, OrchestrationStatus } from './machine-orchestration';

const THIS = 'dev-this';
let signedIn = false, hostEnabled = false;
let devices: RemoteDevice[] = [], cancelSignIn: (() => void) | undefined;
const offline = new Set<string>();
const trusted = new Set<string>(['dev-studio', 'dev-laptop', 'dev-mini']);
const status = (): RemoteStatus => ({ configured: true, signedIn, account: signedIn ? { login: 'octocat' } : undefined, device: { id: THIS, name: 'This Mac', fingerprint: '3fa91c07d2b64e58' }, hostEnabled, connected: signedIn });
const sampleDevices = (): RemoteDevice[] => [
  { id: THIS, name: 'This Mac', platform: 'macOS', fingerprint: '3fa91c07d2b64e58', host: hostEnabled, online: true, trusted: true, lastSeen: Date.now(), current: true },
  { id: 'dev-studio', name: 'Studio iMac', platform: 'macOS', fingerprint: '9b02e4aa71c3d605', host: true, online: !offline.has('dev-studio'), trusted: trusted.has('dev-studio'), lastSeen: Date.now(), current: false },
  { id: 'dev-nas', name: 'Home NAS', platform: 'Linux', fingerprint: '17aa5e90b3c4d286', host: true, online: true, trusted: trusted.has('dev-nas'), lastSeen: Date.now(), current: false },
  { id: 'dev-laptop', name: 'Old laptop', platform: 'Windows', fingerprint: 'c4d81f3e0a9957b2', host: true, online: false, trusted: trusted.has('dev-laptop'), lastSeen: Date.now() - 86_400_000, current: false },
  { id: 'dev-mini', name: 'ProMini', platform: 'macOS', fingerprint: '5e60b1d2c3a49f78', host: !hostOff.has('dev-mini'), online: true, trusted: trusted.has('dev-mini'), lastSeen: Date.now(), current: false },
];
/* Machine orchestration (docs/machine-orchestration.md): links, the switch and pending link requests. */
let orchestration = false, pending: LinkRequest[] = [];
const hostOff = new Set<string>(['dev-mini']);
const links = new Map<string, Access>();
const targets = () => (signedIn ? sampleDevices() : []).filter(d => !d.current && d.host && d.trusted);
const orchestrationStatus = (): OrchestrationStatus => ({ enabled: orchestration, links: targets().filter(d => links.has(d.id)).map(d => ({ deviceId: d.id, name: d.name, platform: d.platform, online: d.online, access: links.get(d.id)! })) });
function setLink(deviceId: string, access: Access | null, emit: (name: string, payload: unknown) => void): OrchestrationStatus {
  if (access && !targets().some(d => d.id === deviceId)) throw new Error('That computer is not trusted or has remote control off.');
  if (access && !['read', 'ask', 'full'].includes(access)) throw new Error(`Unknown access: ${access}`);
  if (access) links.set(deviceId, access); else links.delete(deviceId);
  emit('orchestration://status', orchestrationStatus());
  return orchestrationStatus();
}
/** Test hooks: an agent asking to link a machine, and a computer turning remote control on or off. */
function installOrchestrationHooks(emit: (name: string, payload: unknown) => void): void {
  const w = window as any;
  w.__machineLinkRequest = (sessionId: string, machine: string | null, reason: string) => {
    const request: LinkRequest = { requestId: crypto.randomUUID(), sessionId, machine, reason };
    pending = [...pending.filter(item => item.sessionId !== sessionId), request];
    emit('machine-link-request', request);
    return request.requestId;
  };
  w.__machineHost = (id: string, on: boolean) => { if (on) hostOff.delete(id); else hostOff.add(id); devices = sampleDevices(); emit('remote://presence', devices); emit('orchestration://status', orchestrationStatus()); };
  w.__machineLinkResponses ??= [];
  w.__machineLinkSettle = (requestId: string) => { pending = pending.filter(item => item.requestId !== requestId); emit('machine-link-settled', { requestId }); };
  w.__orchestrationEnable = (on: boolean) => { orchestration = on; emit('orchestration://status', orchestrationStatus()); };
}
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
    case 'remote_sign_out': signedIn = false; hostEnabled = false; devices = []; links.clear(); emit('remote://status', status()); return status();
    case 'remote_set_host_enabled': hostEnabled = Boolean(args.enabled); devices = sampleDevices(); emit('remote://presence', devices); return status();
    case 'remote_devices': return devices = signedIn ? sampleDevices() : [];
    case 'remote_set_trusted': if (args.trusted) trusted.add(args.deviceId); else trusted.delete(args.deviceId); return devices = sampleDevices();
    case 'remote_revoke_device': devices = devices.filter(d => d.id !== args.deviceId); emit('remote://presence', devices); return {};
    // Other trusted computers with remote control on; preview.ts mocks remote_repo_check and remote_start_task.
    case 'remote_targets': return targets().map((d): RemoteTarget => ({ deviceId: d.id, name: d.name, platform: d.platform, online: d.online }));
    case 'orchestration_status': installOrchestrationHooks(emit); return orchestrationStatus();
    case 'orchestration_set_enabled': orchestration = Boolean(args.enabled); emit('orchestration://status', orchestrationStatus()); return orchestrationStatus();
    case 'orchestration_set_link': return setLink(args.deviceId, args.access ?? null, emit);
    case 'orchestration_pending': {
      // Tests: `__seedLinkRequest` is a request made before this window loaded; `__pendingDelay`
      // holds the snapshot back so events can race it.
      installOrchestrationHooks(emit);
      const w = window as any, seed = w.__seedLinkRequest as LinkRequest | undefined;
      if (seed && !pending.some(item => item.requestId === seed.requestId)) pending = [...pending, seed];
      const snapshot = [...pending];
      return w.__pendingDelay ? new Promise(resolve => setTimeout(() => resolve(snapshot), w.__pendingDelay)) : snapshot;
    }
    case 'orchestration_link_respond': {
      const request = pending.find(item => item.requestId === args.requestId);
      if (!request) throw new Error('That link request has already been answered.');
      const next = args.deviceId && args.access ? setLink(args.deviceId, args.access, emit) : orchestrationStatus();
      pending = pending.filter(item => item !== request);
      (window as any).__machineLinkResponses.push({ requestId: request.requestId, deviceId: args.deviceId ?? null, access: args.access ?? null });
      emit('machine-link-settled', { requestId: request.requestId });
      return next;
    }
    default: throw new Error(`Unknown preview command: ${command}`);
  }
}
/** Test hook: a computer going offline or coming back. */
export function setPreviewOnline(id: string, online: boolean, emit: (name: string, payload: unknown) => void): void {
  if (online) offline.delete(id); else offline.add(id);
  devices = sampleDevices(); emit('remote://presence', devices); emit('orchestration://status', orchestrationStatus());
}
