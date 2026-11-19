/* IPC contract for Memory Fabric (src-tauri/src/memory_fabric.rs). Notes live in
 * SQLite; the composer asks for a bounded block and sends it only when it changes. */
import { call } from './bridge.ts';

export type MemoryNote = {
  id: number;
  scope: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  hits: number;
  lastHitAt: number | null;
};

export type MemoryScope = { scope: string; count: number; updatedAt: number | null };
export type MemoryStats = { total: number; scopes: number; updatedAt: number | null };
export type MemoryContext = { digest: string; text: string; count: number; truncated: boolean; ids: number[] };

export type RememberInput = { scope: string; content: string; source?: string };
export type RecallInput = {
  scope?: string;
  projectId?: string;
  sessionId?: string;
  query?: string;
  limit?: number;
  /** Injection marks a hit; browsing in Settings does not. */
  mark?: boolean;
};

export const memoryApi = {
  remember: (input: RememberInput) => call<MemoryNote>('memory_remember', { input }),
  recall: (input: RecallInput = {}) => call<MemoryNote[]>('memory_recall', { input }),
  context: (projectId: string | null | undefined, sessionId: string | null | undefined) =>
    call<MemoryContext>('memory_context', { projectId: projectId ?? null, sessionId: sessionId ?? null }),
  touch: (ids: number[]) => call<void>('memory_touch', { ids }),
  update: (memoryId: number, content: string) => call<MemoryNote>('memory_update', { memoryId, content }),
  forget: (memoryId: number) => call<boolean>('memory_forget', { memoryId }),
  scopes: () => call<MemoryScope[]>('memory_scopes'),
  stats: () => call<MemoryStats>('memory_stats'),
};

/** A scope as a person reads it: "All projects", a project's name, or a thread. */
export function scopeLabel(scope: string, projects: { id: string; name: string }[] = []): string {
  if (scope === 'user') return 'All projects';
  if (scope.startsWith('project:')) {
    const id = scope.slice('project:'.length);
    return projects.find(project => project.id === id)?.name ?? `Project ${id.slice(0, 8)}`;
  }
  if (scope.startsWith('thread:')) return `Thread ${scope.slice('thread:'.length, 'thread:'.length + 8)}`;
  return scope;
}
