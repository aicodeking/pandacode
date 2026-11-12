/** Synthetic policy counterpart, not evidence of native IPC authorization. No core objects returned. */
import { validateContract, type Json } from './contracts.ts';
import { createDeclarativeActivation } from './activation.ts';
import { contextFailure, type ContextReply, type SummaryPage } from './context-state.ts';
import type { ExtensionSnapshot } from './manager.ts';
import { readCapability, readPath, previewProjectRead, type ProjectReadData } from './project-reads-preview.ts';
import { capabilityFor, createInventoryJournal, inventoryItems, type InventoryData } from './context-inventory.ts';
type Data = InventoryData & ProjectReadData & { projects: { id: string; name: string; path?: string }[]; tasks: { id: string; projectId: string; status: string; draft?: boolean }[] };
type Invocation = { id: string; version: string; context: Record<string, Json>; owner: string; expires: number };
export function createPreviewContextBroker() {
  const handles = new Map<string, Invocation>(), grants = new Set<string>();
  const readGrants = new Map<string, string>();
  const journal = createInventoryJournal();
  const subscriptions = new Map<string, { handle: string; resource: string; limit: number; requestId?: string; cursor: string; offset: number; sequence: number; snapshot: SummaryPage }>();
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
    const shapes: Record<string, string[]> = { capture: ['op', 'id', 'version', 'context'], consent: ['op', 'handle', 'capability', 'allow'], query: ['op', 'handle', 'resource', 'limit', 'cursor', 'revision'], subscribe: ['op', 'handle', 'resource', 'limit', 'requestId'], events: ['op', 'handle', 'subscription', 'cursor'], unsubscribe: ['op', 'handle', 'subscription'], release: ['op', 'handle'], read: ['op', 'handle', 'resource', 'path', 'cursor', 'revision'], readConsent: ['op', 'handle', 'capability', 'path', 'allow'], cancelRead: ['op', 'handle'] };
    if (!shapes[String(raw.op)] || Object.keys(raw).some(key => !shapes[String(raw.op)].includes(key))) return fail('InvalidShape');
    for (const [key, invocation] of handles) if (invocation.expires <= Date.now()) handles.delete(key);
    for (const [key, subscription] of subscriptions) if (!handles.has(subscription.handle)) subscriptions.delete(key);
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
      if (raw.op === 'release') { handles.delete(raw.handle); for (const [id, stream] of subscriptions) if (stream.handle === raw.handle) subscriptions.delete(id); return { ok: true, value: null }; }
      const invocation = handles.get(raw.handle);
      if (!invocation) return fail('StaleContext');
      if (resolve(snapshot, invocation.id, invocation.version, invocation.context) !== invocation.owner) return fail('PermissionDenied');
      const manifest = snapshot.packages.find(item => item.manifest.id === invocation.owner)!.manifest as typeof snapshot.packages[number]['manifest'] & { permissions: string[] };
      if (raw.op === 'cancelRead') return { ok: true, value: null };
      if (raw.op === 'readConsent' || raw.op === 'read') {
        const capability = raw.op === 'readConsent' ? raw.capability : readCapability(raw.resource);
        if (typeof capability !== 'string' || !['projects.files.metadata', 'projects.files.read', 'projects.git.read'].includes(capability) || !manifest.permissions.includes(capability)) return fail('PermissionDenied');
        const error = readPath(raw.path, capability === 'projects.git.read'); if (error) return fail(error);
        const key = JSON.stringify([invocation.owner, invocation.version, invocation.context.projectId ?? '', capability, raw.path]);
        const project = data.projects.find(project => project.id === invocation.context.projectId);
        if (raw.op === 'readConsent') {
          if (typeof raw.allow !== 'boolean') return fail('InvalidShape');
          if (raw.allow) { if (!project) return fail('NotFound'); if (readGrants.size >= 256 && !readGrants.has(key)) return fail('LimitExceeded'); readGrants.set(key, project.path ?? project.id); } else readGrants.delete(key);
          return { ok: true, value: null };
        }
        if (!readGrants.has(key)) return fail('PermissionDenied');
        if (!project) return fail('NotFound');
        if (readGrants.get(key) !== (project.path ?? project.id)) return fail('StaleContext');
        return previewProjectRead(data, project.id, String(raw.resource), String(raw.path), raw.cursor, raw.revision);
      }
      const stream = typeof raw.subscription === 'string' ? subscriptions.get(raw.subscription) : undefined;
      if (raw.op === 'events' || raw.op === 'unsubscribe') {
        if (typeof raw.subscription !== 'string' || raw.subscription.length > 64) return fail('LimitExceeded');
        if (stream && stream.handle !== raw.handle) return fail('PermissionDenied');
        if (raw.op === 'unsubscribe') { subscriptions.delete(raw.subscription); return { ok: true, value: null }; }
        if (!stream) return fail('StaleContext');
      }
      const resource = stream?.resource ?? String(raw.resource);
      if (raw.op !== 'consent' && !capabilityFor(resource)) return fail('UnsupportedCapability');
      const capability = raw.op === 'consent' ? raw.capability : capabilityFor(resource);
      if (typeof capability !== 'string' || !['projects.summary', 'tasks.summary', 'harnesses.inventory', 'connections.summary', 'jobs.summary'].includes(capability) || !manifest.permissions.includes(capability)) return fail('PermissionDenied');
      const key = grantKey(invocation, capability);
      if (raw.op === 'consent') {
        if (typeof raw.allow !== 'boolean') return fail('InvalidShape');
        if (raw.allow) { if (grants.size >= 256 && !grants.has(key)) return fail('LimitExceeded'); grants.add(key); } else {
          grants.delete(key);
          for (const [id, stream] of subscriptions) { const other = handles.get(stream.handle); if (other && capabilityFor(stream.resource) === capability && grantKey(other, capability) === key) subscriptions.delete(id); }
        }
        return { ok: true, value: null };
      }
      if (!grants.has(key)) return fail('PermissionDenied');
      if (raw.op === 'subscribe' || raw.op === 'events') {
        if (raw.op === 'subscribe' && raw.requestId != null && (typeof raw.requestId !== 'string' || !raw.requestId.length || raw.requestId.length > 64)) return fail('LimitExceeded');
        if (raw.op === 'events' && (typeof raw.cursor !== 'string' || raw.cursor.length > 64)) return fail('LimitExceeded');
        const reply = dispatch({ op: 'query', handle: raw.handle, resource, limit: stream?.limit ?? raw.limit }, snapshot, data);
        if (!reply.ok) {
          if (reply.error.code === 'NotFound') { for (const [id, stream] of subscriptions) if (handles.get(stream.handle)?.context.projectId === invocation.context.projectId) subscriptions.delete(id); }
          else if (typeof raw.subscription === 'string') subscriptions.delete(raw.subscription);
          return reply;
        }
        const page = reply.value as SummaryPage;
        const cursor = crypto.randomUUID();
        if (!stream) {
          const existing = raw.requestId != null ? [...subscriptions].find(([, item]) => item.handle === raw.handle && item.requestId === raw.requestId) : undefined;
          if (existing) {
            const [subscription, item] = existing;
            if (item.resource !== resource || item.limit !== raw.limit) return fail('InvalidShape');
            item.snapshot = page; item.offset = journal.cursor(); item.cursor = cursor;
            return { ok: true, value: { schemaVersion: 1, subscription, cursor, snapshot: page, events: [], resync: true } };
          }
          if (subscriptions.size >= 64 || [...subscriptions.values()].filter(item => item.handle === raw.handle).length >= 5) return fail('LimitExceeded');
          const subscription = crypto.randomUUID(); subscriptions.set(subscription, { handle: raw.handle, resource, limit: Number(raw.limit), requestId: raw.requestId as string | undefined, cursor, offset: journal.cursor(), sequence: 0, snapshot: page });
          return { ok: true, value: { schemaVersion: 1, subscription, cursor, snapshot: page, events: [], resync: false } };
        }
        const batch = resource === 'jobs' ? journal.read(stream.offset, new Set(data.tasks.filter(task => task.projectId === invocation.context.projectId && !task.draft).map(task => task.id))) : { gap: false, events: [] };
        const resync = batch.gap || raw.cursor !== stream.cursor || new TextEncoder().encode(JSON.stringify(batch.events)).length > 24576;
        const events = resync ? [] : batch.events.map(event => { const sequence = ++stream.sequence; return { ...event, sequence, revision: `event:${sequence}` }; });
        const changed = JSON.stringify([page.items, page.state, page.nextCursor]) !== JSON.stringify([stream.snapshot.items, stream.snapshot.state, stream.snapshot.nextCursor]);
        stream.offset = journal.cursor(); stream.cursor = cursor; stream.snapshot = page;
        return { ok: true, value: { schemaVersion: 1, cursor, snapshot: changed || resync ? page : null, events, resync } };
      }
      const cursor = raw.cursor ?? 0;
      if (!Number.isInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 50 || !Number.isInteger(cursor) || Number(cursor) < 0 || Number(cursor) > 10000 || raw.revision !== undefined && (typeof raw.revision !== 'string' || raw.revision.length > 64)) return fail('LimitExceeded');
      if (!grants.has(key)) return fail('PermissionDenied');
      const project = data.projects.find(project => project.id === invocation.context.projectId);
      const tasks = data.tasks.filter(task => task.projectId === invocation.context.projectId && !task.draft).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(task => ({ id: task.id, projectId: task.projectId, status: task.status }));
      // Revision fingerprints summaries only; never serialize paths, prompts or core objects.
      let hash = 2166136261;
      for (const byte of new TextEncoder().encode(JSON.stringify([project && { id: project.id, name: project.name }, tasks]))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      const inventory = ['harnesses', 'connections', 'jobs'].includes(resource) ? inventoryItems(data, String(invocation.context.projectId ?? ''), resource) : undefined;
      if (inventory) for (const byte of new TextEncoder().encode(JSON.stringify(inventory))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      const revision = String(hash);
      if (!invocation.context.projectId) return { ok: true, value: { schemaVersion: 1, state: 'NoProject', revision, items: [], nextCursor: null } };
      if (!project) return fail('NotFound');
      if (raw.revision !== undefined && raw.revision !== revision) return fail('StaleContext');
      if ([...project.name].length > 256 || tasks.some(task => task.id.length > 256 || task.status.length > 64)) return fail('LimitExceeded');
      if (raw.resource === 'projects' && cursor !== 0) return fail('InvalidShape');
      const all = inventory ?? (resource === 'projects' ? [{ id: project.id, name: project.name }] : tasks);
      if (all.length > 10000 || all.some(item => item.id.length > 256)) return fail('LimitExceeded');
      const items = all.slice(Number(cursor), Number(cursor) + Number(raw.limit));
      const value = { schemaVersion: 1, state: 'Ready', revision, items, nextCursor: Number(cursor) + Number(raw.limit) < all.length ? Number(cursor) + Number(raw.limit) : null };
      return new TextEncoder().encode(JSON.stringify({ ok: true, value })).length > 65536 ? fail('LimitExceeded') : { ok: true, value };
    } catch { return fail('PermissionDenied'); }
  };
  return Object.assign(dispatch, { record: journal.record, subscriptionCount: () => subscriptions.size, invalidate(owner?: string) {
    for (const [key, invocation] of handles) if (owner === undefined || invocation.owner === owner) handles.delete(key);
    for (const key of grants) if (owner === undefined || JSON.parse(key)[0] === owner) grants.delete(key);
    for (const key of readGrants.keys()) if (owner === undefined || JSON.parse(key)[0] === owner) readGrants.delete(key);
    for (const [id, stream] of subscriptions) if (!handles.has(stream.handle)) subscriptions.delete(id);
  } });
}
