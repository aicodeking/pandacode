// Provider handoffs: switching a task's agent stores a message with role 'handoff' whose content is JSON
// ({ fromProvider, toProvider, summary }, src-tauri/src/storage.rs). A port of the desktop's
// src/provider-handoff.ts decoder. Pure (tests/handoff.test.ts).
import type { Message } from '../connect/types.ts';

export const HANDOFF_ROLE = 'handoff';

/** The harness ids the host can switch between, as the desktop's decoder accepts them. */
export const HANDOFF_PROVIDERS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode',
  'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes',
]);

/** The longest summary kept, as on the desktop. */
export const HANDOFF_SUMMARY_MAX = 1000;

export interface Handoff { fromProvider: string; toProvider: string; summary: string }

export const isHandoff = (message: Pick<Message, 'role'>) => message.role === HANDOFF_ROLE;

/** The switch a handoff message records, or null for any other message or one that doesn't parse. */
export function decodeHandoff(message: Pick<Message, 'role' | 'content'>): Handoff | null {
  if (!isHandoff(message)) return null;
  let value: unknown;
  try { value = JSON.parse(message.content); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const { fromProvider, toProvider, summary } = value as Record<string, unknown>;
  if (typeof fromProvider !== 'string' || typeof toProvider !== 'string' || typeof summary !== 'string') return null;
  if (!HANDOFF_PROVIDERS.has(fromProvider) || !HANDOFF_PROVIDERS.has(toProvider)) return null;
  return { fromProvider, toProvider, summary: summary.slice(0, HANDOFF_SUMMARY_MAX) };
}

/** The card's title, with harness names from `name` (harnessName in ui/harness.tsx). */
export const handoffTitle = (handoff: Handoff, name: (id: string) => string) => `Switched from ${name(handoff.fromProvider)} to ${name(handoff.toProvider)}`;
