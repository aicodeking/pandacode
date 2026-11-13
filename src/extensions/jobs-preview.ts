/** Synthetic transport only: never executes package source or resolves an executable. */
import type { ExtensionSnapshot } from './manager';
import type { Json } from './contracts';
import type { OwnedJob } from './jobs';
type Binding = { owner: string; version: string; id: string; context: Record<string, Json> };
export function createJobsPreview() {
  const grants = new Set<string>(), jobs = new Map<string, { scope: string; dto: OwnedJob; args: string[]; polls: number }>();
  const fail = (code: string): never => { throw new Error(code); };
  function stop(owner?: string) {
    for (const scope of grants) if (!owner || JSON.parse(scope)[0] === owner) grants.delete(scope);
    for (const job of jobs.values()) if ((!owner || JSON.parse(job.scope)[0] === owner) && job.dto.state === 'running') { job.dto.state = 'cancelled'; job.dto.error = 'Cancelled'; }
  }
  return { stop, call(snapshot: ExtensionSnapshot, binding: Binding | undefined, request: Record<string, unknown>) {
    if (!binding || snapshot.safeMode) return fail('StaleContext');
    const pkg = snapshot.packages.find(item => item.manifest.id === binding.owner && item.enabled && item.executable?.trusted);
    if (!pkg || !pkg.manifest.permissions?.includes('tools.execute') || !binding.context.projectId) return fail('PermissionDenied');
    const command = pkg.manifest.contributes.commands?.find(command => command.id === binding.id) ?? pkg.manifest.contributes.commands?.find(command => command.id === pkg.manifest.contributes.menus?.find(menu => menu.id === binding.id)?.command);
    const tool = pkg.manifest.contributes.tools?.find(tool => tool.id === request.tool && tool.command === command?.id);
    if (!tool) return fail('PermissionDenied');
    const scope = JSON.stringify([binding.owner, binding.version, pkg.executable?.digest, binding.context.projectId, tool.id]);
    const keys: Record<string, string[]> = { grant: ['op', 'tool', 'allow'], start: ['op', 'tool', 'args'], poll: ['op', 'tool', 'job'], cancel: ['op', 'tool', 'job'] };
    if (typeof request.op !== 'string' || !keys[request.op] || Object.keys(request).sort().join() !== keys[request.op].sort().join()) return fail('InvalidShape');
    if (request.op === 'grant') {
      if (typeof request.allow !== 'boolean') return fail('InvalidShape');
      if (request.allow) grants.add(scope); else { grants.delete(scope); for (const entry of jobs.values()) if (entry.scope === scope && entry.dto.state === 'running') { entry.dto.state = 'cancelled'; entry.dto.error = 'Cancelled'; } }
      return null;
    }
    if (request.op === 'start') {
      if (!grants.has(scope)) return fail('PermissionDenied');
      if (!Array.isArray(request.args) || request.args.length > tool.arguments.maxItems || request.args.some(arg => typeof arg !== 'string' || new TextEncoder().encode(arg).length > tool.arguments.maxLength || arg.includes('\0'))) return fail('InvalidShape');
      if (!new URLSearchParams(location.search).has('extension-jobs')) return fail('UnsupportedRuntime');
      const job = crypto.randomUUID(); const dto: OwnedJob = { schemaVersion: 1, job, state: 'running', progress: [{ phase: 'testing', completed: 0 }], result: null, error: null };
      if (jobs.size >= 64) return fail('LimitExceeded');
      jobs.set(job, { scope, dto, args: request.args, polls: 0 }); return structuredClone(dto);
    }
    const entry = jobs.get(String(request.job)); if (!entry || entry.scope !== scope) return fail('PermissionDenied');
    if (request.op === 'cancel' && entry.dto.state === 'running') { entry.dto.state = 'cancelled'; entry.dto.error = 'Cancelled'; }
    if (request.op === 'poll' && entry.dto.state === 'running' && ++entry.polls >= 3) {
      if (entry.args[0] === 'timeout') { entry.dto.state = 'timeout'; entry.dto.error = 'Timeout'; }
      else if (entry.args[0] !== 'wait') { entry.dto.state = 'completed'; entry.dto.progress.push({ phase: 'testing', completed: 100 }); entry.dto.result = { passed: 1, args: entry.args }; }
    }
    return structuredClone(entry.dto);
  } };
}
