/** The queue above the composer: follow-ups typed while an agent works, delivered in order. */
import { t } from './i18n.ts';
import { escape, icon } from './dom';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  /** Prompt attachments and mentioned file paths, as the composer described them. */
  attachments: QueuedAttachment[];
  createdAt: number;
  updatedAt: number;
}
export type QueuedAttachment = { kind: 'path'; path: string } | ({ kind: 'image' | 'document' | 'folder' | 'sketch' } & Record<string, unknown>);

export type HoldReason = 'restart' | 'failed' | 'stopped' | 'limited' | 'reset';
export const HOLD_LABEL: Record<HoldReason, string> = {
  restart: t('Paused after restart'),
  failed: t('Paused after the run failed'),
  stopped: t('Paused after you stopped the run'),
  limited: t('Paused until the usage limit resets'),
