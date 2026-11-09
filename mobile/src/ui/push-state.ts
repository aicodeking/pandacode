// What the Settings notifications row says, from the permission and the last registration. Pure, so tests run in node.
import type { RegisterOutcome } from '../connect/push.ts';

/** `skipped`: nothing to register with here (demo mode, a build without a relay). */
export type Registration = RegisterOutcome | 'skipped';
export interface PushStatus { granted: boolean; canAskAgain: boolean; registration: Registration | null }
export type NotificationRowKind = 'loading' | 'on' | 'ask' | 'denied' | 'failed' | 'unsupported';

export function notificationRow(status: PushStatus | null): NotificationRowKind {
  if (!status) return 'loading';
  if (!status.granted) return status.canAskAgain ? 'ask' : 'denied';
  if (status.registration === 'error') return 'failed';
  return status.registration === 'unsupported' ? 'unsupported' : 'on';
}

/** A granted phone registers again until the relay has answered for good: permission may have come from the system's settings. */
export const needsRegistration = (status: Pick<PushStatus, 'granted' | 'registration'>) =>
  status.granted && (status.registration === null || status.registration === 'error');
