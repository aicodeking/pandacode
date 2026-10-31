import type { TaskStatus } from '../connect/types.ts';
import { tNow } from './language.ts';

export const isActive = (status: TaskStatus) => status === 'running' || status === 'waiting';

export function ago(ms: number): string {
  const t = tNow();
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('now');
  if (s < 3600) return t`${Math.floor(s / 60)}m`;
  if (s < 86400) return t`${Math.floor(s / 3600)}h`;
  return t`${Math.floor(s / 86400)}d`;
}

export const MODES = [
  { id: 'ask', label: 'Standard' },
  { id: 'auto', label: 'Auto-approve edits' },
  { id: 'plan', label: 'Plan only' },
  { id: 'full', label: 'Full access' },
];
