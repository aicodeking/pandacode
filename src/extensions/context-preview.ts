/** Synthetic policy counterpart, not evidence of native IPC authorization. No core objects returned. */
import { validateContract, type Json } from './contracts.ts';
import { createDeclarativeActivation } from './activation.ts';
import { contextFailure, type ContextReply } from './context-state.ts';
import type { ExtensionSnapshot } from './manager.ts';
type Data = { projects: { id: string; name: string }[]; tasks: { id: string; projectId: string; status: string; draft?: boolean }[] };
type Invocation = { id: string; version: string; context: Record<string, Json>; owner: string; expires: number };
export function createPreviewContextBroker() {
  const handles = new Map<string, Invocation>(), grants = new Set<string>();
  const grantKey = (invocation: Invocation, capability: string) => JSON.stringify([invocation.owner, invocation.version, invocation.context.projectId ?? '', capability]);
  function resolve(snapshot: ExtensionSnapshot, id: string, version: string, context: Record<string, Json>) {
    const activation = createDeclarativeActivation(snapshot, 1);
    try {
      const command = activation.commands.find(entry => entry.command.id === id && entry.owner.version === version);
      if (command && ['panda.commands', 'panda.shortcuts'].includes(String(context.surfaceId)) && activation.commandAction(id, context)?.kind === 'showProjectContext') return command.owner.extensionId;
      const entry = activation.entries.find(entry => entry.owner.version === version && (entry.menu.id === id || JSON.stringify(entry.menu.items ?? []).includes(JSON.stringify(id))));
      return entry && activation.actionFor(id, context)?.kind === 'showProjectContext' ? entry.owner.extensionId : undefined;
    } finally { activation.dispose(); }
  }
  const dispatch = (raw: Record<string, unknown>, snapshot: ExtensionSnapshot, data: Data): ContextReply => {
    const fail = contextFailure;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('InvalidShape');
    if (new TextEncoder().encode(JSON.stringify(raw)).length > 8192) return fail('LimitExceeded');
    const shapes: Record<string, string[]> = { capture: ['op', 'id', 'version', 'context'], consent: ['op', 'handle', 'capability', 'allow'], query: ['op', 'handle', 'resource', 'limit', 'cursor', 'revision'], release: ['op', 'handle'] };
    if (!shapes[String(raw.op)] || Object.keys(raw).some(key => !shapes[String(raw.op)].includes(key))) return fail('InvalidShape');
    for (const [key, invocation] of handles) if (invocation.expires <= Date.now()) handles.delete(key);
    try {
      if (raw.op === 'capture') {
        if (typeof raw.id !== 'string' || typeof raw.version !== 'string' || !validateContract('context', raw.context).ok) return fail('InvalidShape');
        const context = structuredClone(raw.context) as Record<string, Json>;
        if (context.windowId !== 'main') return fail('PermissionDenied');
        const owner = resolve(snapshot, raw.id, raw.version, context);
        if (!owner) return fail('PermissionDenied');
        if (context.sessionId) {
          const task = data.tasks.find(task => task.id === context.sessionId);
          if (!task) return fail('NotFound');
          if (task.projectId !== (context.projectId ?? '')) return fail('PermissionDenied');
        }
        if (handles.size >= 64) return fail('LimitExceeded');
        const handle = crypto.randomUUID(); handles.set(handle, { id: raw.id, version: raw.version, context, owner, expires: Date.now() + 300000 });
        return { ok: true, value: { schemaVersion: 1, handle, owner } };
      }
      if (typeof raw.handle !== 'string' || raw.handle.length > 64) return fail('InvalidShape');
      if (raw.op === 'release') { handles.delete(raw.handle); return { ok: true, value: null }; }
      const invocation = handles.get(raw.handle);
      if (!invocation) return fail('StaleContext');
      if (resolve(snapshot, invocation.id, invocation.version, invocation.context) !== invocation.owner) return fail('PermissionDenied');
      const manifest = snapshot.packages.find(item => item.manifest.id === invocation.owner)!.manifest as typeof snapshot.packages[number]['manifest'] & { permissions: string[] };
      if (raw.op === 'query' && !['projects', 'tasks'].includes(String(raw.resource))) return fail('UnsupportedCapability');
      const capability = raw.op === 'consent' ? raw.capability : raw.resource === 'projects' ? 'projects.summary' : raw.resource === 'tasks' ? 'tasks.summary' : undefined;
      if (typeof capability !== 'string' || !['projects.summary', 'tasks.summary'].includes(capability) || !manifest.permissions.includes(capability)) return fail('PermissionDenied');
      const key = grantKey(invocation, capability);
      if (raw.op === 'consent') {
        if (typeof raw.allow !== 'boolean') return fail('InvalidShape');
        if (raw.allow) { if (grants.size >= 256 && !grants.has(key)) return fail('LimitExceeded'); grants.add(key); } else grants.delete(key);
        return { ok: true, value: null };
      }
      const cursor = raw.cursor ?? 0;
      if (!Number.isInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 50 || !Number.isInteger(cursor) || Number(cursor) < 0 || Number(cursor) > 10000 || raw.revision !== undefined && (typeof raw.revision !== 'string' || raw.revision.length > 64)) return fail('LimitExceeded');
      if (!grants.has(key)) return fail('PermissionDenied');
      const project = data.projects.find(project => project.id === invocation.context.projectId);
      const tasks = data.tasks.filter(task => task.projectId === invocation.context.projectId && !task.draft).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(task => ({ id: task.id, projectId: task.projectId, status: task.status }));
      // Revision fingerprints summaries only; never serialize paths, prompts or core objects.
      let hash = 2166136261;
      for (const byte of new TextEncoder().encode(JSON.stringify([project && { id: project.id, name: project.name }, tasks]))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      const revision = String(hash);
      if (!invocation.context.projectId) return { ok: true, value: { schemaVersion: 1, state: 'NoProject', revision, items: [], nextCursor: null } };
      if (!project) return fail('NotFound');
      if (raw.revision !== undefined && raw.revision !== revision) return fail('StaleContext');
      if ([...project.name].length > 256 || tasks.some(task => task.id.length > 256 || task.status.length > 64)) return fail('LimitExceeded');
      if (raw.resource === 'projects' && cursor !== 0) return fail('InvalidShape');
      const items = raw.resource === 'projects' ? [{ id: project.id, name: project.name }] : tasks.slice(Number(cursor), Number(cursor) + Number(raw.limit));
      const value = { schemaVersion: 1, state: 'Ready', revision, items, nextCursor: raw.resource === 'tasks' && Number(cursor) + Number(raw.limit) < tasks.length ? Number(cursor) + Number(raw.limit) : null };
      return new TextEncoder().encode(JSON.stringify({ ok: true, value })).length > 65536 ? fail('LimitExceeded') : { ok: true, value };
    } catch { return fail('PermissionDenied'); }
  };
  return Object.assign(dispatch, { invalidate(owner?: string) {
    for (const [key, invocation] of handles) if (owner === undefined || invocation.owner === owner) handles.delete(key);
    for (const key of grants) if (owner === undefined || JSON.parse(key)[0] === owner) grants.delete(key);
  } });
}
