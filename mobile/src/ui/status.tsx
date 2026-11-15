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

/** One name per mode everywhere: composer, menus and the segmented picker, whose four segments these must fit. */
export const MODES = [
  { id: 'ask', label: 'Standard', hint: 'Asks you when an action needs permission.' },
  { id: 'auto', label: 'Auto', hint: 'Allows file edits. Other actions may still ask.' },
  { id: 'plan', label: 'Plan', hint: 'Works out a plan first and leaves your files alone.' },
  { id: 'full', label: 'Full', hint: 'Runs everything without asking.' },
];
