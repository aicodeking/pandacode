/** Pure synthetic inventory projections. Real discovery stays in the native host. */
import type { SummaryItem } from './context-state.ts';
const capabilities = new Map([['projects', 'projects.summary'], ['tasks', 'tasks.summary'], ['harnesses', 'harnesses.inventory'], ['connections', 'connections.summary'], ['jobs', 'jobs.summary']]);
export const capabilityFor = (resource: string): string | undefined => capabilities.get(resource);
export type InventoryData = {
  harnesses?: { id: string; name: string; installed: 'Installed' | 'Absent' | 'Unknown'; version?: string | null }[];
  connections?: { id: string; provider: string; projectId: string }[];
};
export function inventoryItems(data: InventoryData & { tasks: { id: string; projectId: string; status: string; draft?: boolean }[] }, project: string, resource: string): SummaryItem[] {
  if (resource === 'harnesses') return (data.harnesses ?? []).map(item => ({ id: item.id, name: item.name, installed: item.installed, version: item.version && /^\d+(\.\d+)+$/.test(item.version) && item.version.length <= 32 ? item.version : null, capabilities: ['start', 'cancel'], capabilitySource: 'hostAdapter' }));
  if (resource === 'connections') return (data.connections ?? []).filter(item => item.projectId === project).map(item => ({ id: item.id, name: item.provider, status: 'Configured', authentication: 'Unknown', capabilities: ['harness.launch'] }));
  return data.tasks.filter(item => item.projectId === project && !item.draft).sort((a, b) => a.id.localeCompare(b.id)).map(item => ({ id: item.id, projectId: project, kind: 'agentTask', status: safeStatus(item.status) }));
}
export const safeStatus = (status: string) => ['running', 'completed', 'failed', 'stopped', 'pending', 'idle'].includes(status) ? status : 'unknown';
export function createInventoryJournal() {
  let cursor = 0, floor = 0;
  const events: { sequence: number; id: string; kind: 'progress' | 'terminal'; status: string }[] = [];
  return {
    cursor: () => cursor,
    record(id: string, kind: 'progress' | 'terminal', status: string) {
      if (id.length > 256 || !['progress', 'terminal'].includes(kind)) return;
      cursor++;
      if (kind === 'progress' && events.at(-1)?.id === id && events.at(-1)?.kind === 'progress') floor = Math.max(floor, events.pop()!.sequence);
      events.push({ sequence: cursor, id, kind, status: safeStatus(status) });
      if (events.length > 128) floor = Math.max(floor, events.shift()!.sequence);
    },
    read(after: number, ids: Set<string>) { return { gap: after < floor || after > cursor, events: events.filter(event => event.sequence > after && ids.has(event.id)).map(event => ({ ...event })) }; },
  };
}
