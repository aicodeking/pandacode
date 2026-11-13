/** Synthetic E23 policy/UI parity, never native execution evidence. */
import { validateContract, type Json } from './contracts.ts';
import type { ExtensionSnapshot } from './manager';
type Binding = { owner: string; version: string; context: Record<string, Json> };
export function createServicesPreview() {
  const grants = new Map<string, { owner: string; service: string }>();
  const calls = new Map<string, { handle: string; owner: string; provider: string; output: Json; events: { sequence: number; value: Json }[] }>();
  const fail = (code: string): never => { throw new Error(code); };
  const stop = (owner?: string, handle?: string) => {
    for (const [id, call] of calls) if ((!owner || [call.owner, call.provider].includes(owner)) && (!handle || call.handle === handle)) calls.delete(id);
    for (const [key, grant] of grants) if ((!owner || grant.owner === owner || grant.service.startsWith(`${owner}/`)) && (!handle || key.startsWith(`${handle}:`))) grants.delete(key);
  };
  return { stop, call(snapshot: ExtensionSnapshot, binding: Binding | undefined, handle: string, request: Record<string, unknown>) {
    if (!binding || snapshot.safeMode) return fail('StaleContext');
    const consumer = snapshot.packages.find(pkg => pkg.enabled && pkg.executable?.trusted && pkg.manifest.id === binding.owner)?.manifest;
    if (!consumer) return fail('PermissionDenied');
    const shapes: Record<string, string[]> = { grant: ['op', 'service', 'allow'], start: ['op', 'service', 'version', 'method', 'input'], poll: ['op', 'request'], dispose: ['op', 'request'] };
    const op = String(request.op);
    if (!shapes[op] || Object.keys(request).sort().join() !== shapes[op].sort().join()) return fail('InvalidShape');
    if (JSON.stringify(request).length > 10000) return fail('LimitExceeded');
    if (op === 'grant') {
      if (!consumer.permissions?.includes('services.call')) return fail('PermissionDenied');
      if (request.allow === true) grants.set(`${handle}:${request.service}`, { owner: binding.owner, service: String(request.service) });
      else stop(binding.owner, handle);
      return null;
    }
    if (op === 'poll' || op === 'dispose') {
      const call = calls.get(String(request.request)); if (!call) return fail('Cancelled');
      if (call.owner !== binding.owner || call.handle !== handle) return fail('PermissionDenied');
      if (op === 'dispose') { calls.delete(String(request.request)); return null; }
      const events = call.events; call.events = [];
      return { schemaVersion: 1, request: request.request, state: 'settled', output: call.output, events, error: null };
    }
    if (!grants.has(`${handle}:${request.service}`)) return fail('PermissionDenied');
    const provider = snapshot.packages.find(pkg => pkg.manifest.id === String(request.service).split('/')[0] && pkg.enabled);
    if (!provider) return fail('NotFound');
    if (!provider.executable?.trusted || !consumer.dependencies?.[provider.manifest.id] || !consumer.permissions?.includes('services.call')) return fail('PermissionDenied');
    const pending = [consumer.id], seen = new Set<string>(), closure = [];
    while (pending.length) {
      const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
      const pkg = snapshot.packages.find(pkg => pkg.enabled && pkg.manifest.id === id); if (!pkg) return fail('NotFound');
      closure.push(pkg.manifest); pending.push(...Object.keys(pkg.manifest.dependencies ?? {}));
    }
    const checked = validateContract('packages', closure as unknown as Json);
    if (!checked.ok) return fail(checked.error.code);
    const descriptor = provider.manifest.contributes.services?.find(item => item.id === request.service);
    if (!descriptor) return fail('NotFound');
    if (descriptor.version !== request.version) return fail('IncompatibleApi');
    const method = descriptor.methods.find(item => item.id === request.method); if (!method) return fail('PermissionDenied');
    const type = method.inputSchema.type;
    if (!(type === 'null' ? request.input === null : type === 'integer' ? Number.isSafeInteger(request.input) : type === typeof request.input)) return fail('InvalidShape');
    const id = crypto.randomUUID(); calls.set(id, { owner: binding.owner, handle, provider: provider.manifest.id, output: `Hello ${String(request.input)}`, events: [{ sequence: 1, value: `Consumer ${binding.owner}; project ${binding.context.projectId ?? 'none'}` }] });
    return { schemaVersion: 1, request: id, state: 'running', output: null, events: [], error: null };
  } };
}
