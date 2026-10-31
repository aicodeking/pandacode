// Preview data for scoped pairing (src-tauri/src/remote/grants.rs). Same sample computers as preview-remote.ts.
// Tests start devices waiting with `window.__pairingPending = ['dev-laptop']` and pick the next code with `window.__pairCode`.
type Scope = 'pending' | 'view' | 'control' | 'full' | 'blocked';
interface Grant { deviceId: string; name: string; platform: string; fingerprint: string; scope: Scope; online: boolean; requested: boolean }
const sample = (): Grant[] => {
  const waiting: string[] = (window as any).__pairingPending ?? [];
  const row = (deviceId: string, name: string, platform: string, fingerprint: string, scope: Scope, online = true): Grant => waiting.includes(deviceId) ? { deviceId, name, platform, fingerprint, scope: 'pending', online, requested: true } : { deviceId, name, platform, fingerprint, scope, online, requested: false };
  return [
    row('dev-studio', 'Studio iMac', 'macOS', '9b02e4aa71c3d6050c8e2b7f41a96d13', 'full'),
    row('dev-nas', 'Home NAS', 'Linux', '17aa5e90b3c4d2867f30e1ac95b4c028', 'control'),
    row('dev-laptop', 'Old laptop', 'Windows', 'c4d81f3e0a9957b26e3d0a8c17f4b952', 'view', false),
  ].sort((a, b) => Number(b.scope === 'pending') - Number(a.scope === 'pending'));
};
let grants: Grant[] | undefined;
export function previewGrants(command: string, args: Record<string, any>): unknown {
  const w = window as any;
  switch (command) {
    case 'remote_device_grants': return structuredClone(grants ??= sample());
    case 'remote_set_device_grant': {
      const grant = (grants ??= sample()).find(g => g.deviceId === args.deviceId);
      if (!grant) throw new Error('That computer is not on this account.');
      if (!['pending', 'view', 'control', 'full', 'blocked'].includes(args.scope)) throw new Error('Unknown access level.');
      grant.scope = args.scope; grant.requested = args.scope === 'blocked';
      (w.__grantCalls ??= []).push({ ...args });
      return undefined;
    }
    case 'remote_pair_code': {
      (w.__pairCodeCalls ??= []).push({ ...args });
      return { code: w.__pairCode ?? '428917', scope: args.scope, expiresAt: Date.now() + 600_000 };
    }
    case 'remote_pair_code_cancel': w.__pairCodeCancelled = (w.__pairCodeCancelled ?? 0) + 1; return undefined;
    case 'remote_pair_redeem':
      (w.__pairRedeems ??= []).push({ ...args });
      if (String(args.code).replace(/\D/g, '') !== (w.__pairCode ?? '428917')) throw new Error('That pairing code is not valid or has expired.');
      return { scope: 'control' };
    default: return undefined;
  }
}
