import type { Message, ProviderId } from './types.ts';
const providers = new Set(['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse']);
export interface Handoff { fromProvider: ProviderId; toProvider: ProviderId; summary: string; }
export function decodeHandoff(message: Message): Handoff | null {
  if (message.role !== 'handoff') return null;
  try {
    const value = JSON.parse(message.content);
    return providers.has(value.fromProvider) && providers.has(value.toProvider) && typeof value.summary === 'string'
      ? { fromProvider: value.fromProvider, toProvider: value.toProvider, summary: value.summary.slice(0, 1000) } : null;
  } catch { return null; }
}
/** Native pages carry their author; older clients can infer from a visible switch. */
export function historicalProvider(message: Message, messages: Message[], current: ProviderId): ProviderId {
  if (message.authorProvider && providers.has(message.authorProvider)) return message.authorProvider;
  if (message.id < 0) return current;
  for (const next of messages) {
    if (next.sessionId !== message.sessionId || next.id <= message.id) continue;
    const handoff = decodeHandoff(next);
    if (handoff) return handoff.fromProvider;
  }
  return current;
}
