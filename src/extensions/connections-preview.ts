/** Synthetic no-network/no-persistent-secret transport. Native HTTP tests are authoritative. */
import type { ExtensionSnapshot } from './manager';
import type { Json } from './contracts';
import type { ConnectionRequest } from './sdk';
type Binding = { owner: string; version: string; id: string; context: Record<string, Json> };
export function createConnectionsPreview() {
  const grants = new Map<string, string>(), pending = new Map<string, { scope: string; polls: number; operation: string; dto: ConnectionRequest }>();
  let starts = 0;
  let admitted: number[] = [];
  const fail = (code: string): never => { throw new Error(code); };
  const revoke = (scope: string) => { grants.delete(scope); for (const entry of pending.values()) if (entry.scope === scope) entry.dto = { ...entry.dto, state: 'failed', response: null, error: 'PermissionDenied' }; };
  const stop = (owner?: string, handle?: string) => { for (const scope of grants.keys()) { const identity = JSON.parse(scope); if ((!owner || identity[0] === owner) && (!handle || identity[4] === handle)) revoke(scope); } };
  return { stop, stats: () => ({ starts, grants: grants.size, requests: pending.size }), call(snapshot: ExtensionSnapshot, binding: Binding | undefined, handle: string, request: Record<string, unknown>) {
    if (!binding || snapshot.safeMode) return fail('StaleContext');
    const pkg = snapshot.packages.find(pkg => pkg.manifest.id === binding.owner && pkg.enabled && pkg.executable?.trusted);
    if (!pkg || !pkg.manifest.permissions?.includes('connections.request')) return fail('PermissionDenied');
    const command = pkg.manifest.contributes.commands?.find(command => command.id === binding.id) ?? pkg.manifest.contributes.commands?.find(command => command.id === pkg.manifest.contributes.menus?.find(menu => menu.id === binding.id)?.command);
    const descriptor = pkg.manifest.contributes.connections?.find(connection => connection.id === request.connection && connection.command === command?.id);
    if (!descriptor || !descriptor.operations.some(operation => operation.id === request.operation)) return fail('PermissionDenied');
    const keys: Record<string, string[]> = { connect: ['op', 'connection', 'operation', 'secret'], revoke: ['op', 'connection', 'operation'], status: ['op', 'connection', 'operation'], start: ['op', 'connection', 'operation', 'credential'], poll: ['op', 'connection', 'operation', 'request'], cancel: ['op', 'connection', 'operation', 'request'] };
    if (typeof request.op !== 'string' || !keys[request.op] || Object.keys(request).sort().join() !== keys[request.op].sort().join()) return fail('InvalidShape');
    const scope = JSON.stringify([binding.owner, binding.version, pkg.executable?.digest, binding.context.projectId ?? '', handle, descriptor.id, request.operation]);
    const status = () => ({ schemaVersion: 1, state: grants.has(scope) ? 'connected' : 'disconnected', credential: grants.get(scope) ?? null });
    if (request.op === 'revoke') { revoke(scope); return status(); }
    if (request.op === 'status') return status();
    if (['connect', 'start'].includes(request.op) && descriptor.authentication !== 'bearer') return fail('UnsupportedCapability');
    if (request.op === 'connect') {
      if (typeof request.secret !== 'string' || !request.secret.trim() || request.secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(request.secret)) return fail('InvalidShape');
      if (grants.size >= 128 && !grants.has(scope)) return fail('LimitExceeded');
      revoke(scope); grants.set(scope, crypto.randomUUID()); return status();
    }
    if (request.op === 'start') {
      if (!grants.has(scope) || request.credential !== grants.get(scope)) return fail('PermissionDenied');
      if ([...pending.values()].filter(entry => entry.dto.state === 'running').length >= 8) return fail('Conflict');
      if (pending.size >= 64) { const old = [...pending].find(([, entry]) => entry.dto.state !== 'running'); if (!old) return fail('LimitExceeded'); pending.delete(old[0]); }
      admitted = admitted.filter(time => Date.now() - time < 60_000); if (admitted.length >= 30) return fail('LimitExceeded'); admitted.push(Date.now());
      const id = crypto.randomUUID(); const dto: ConnectionRequest = { schemaVersion: 1, request: id, state: 'running', response: null, error: null };
      pending.set(id, { scope, dto, polls: 0, operation: String(request.operation) }); starts++; return structuredClone(dto);
    }
    const entry = pending.get(String(request.request)); if (!entry || entry.scope !== scope) return fail('PermissionDenied');
    if (entry.dto.state === 'running') {
      let error: string | null = null;
      if (request.op === 'cancel') error = 'Cancelled';
      else if (++entry.polls >= (entry.operation === 'wait' ? 15 : 3)) error = ({ wait: 'Timeout', redirect: 'PermissionDenied', large: 'LimitExceeded', failure: 'HostUnavailable' } as Record<string, string>)[entry.operation] ?? null;
      if (error) entry.dto = { ...entry.dto, state: 'failed', error };
      else if (entry.polls >= 3 && entry.operation === 'summary') entry.dto = { ...entry.dto, state: 'completed', response: { schemaVersion: 1, accepted: true, count: 3 } };
    }
    return structuredClone(entry.dto);
  } };
}
