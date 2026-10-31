import './coordination-message.css';
import type { Message } from './types';
import { escape, icon } from './dom';

const TEAM: Record<string, string> = {
  worker_review: 'Reviewing worker results', worker_update: 'Checking worker updates',
  continue: 'Continuing the plan', worker_failed: 'Handling a failed worker',
};
/** App-origin turns about threads on other computers (docs/machine-orchestration.md). */
const MACHINES: Record<string, string> = { machine_threads: 'Machine threads finished' };

/** Only app-origin rows use this renderer; user JSON stays ordinary conversation. */
export function renderCoordination(message: Message): string {
  const kind = message.coordinationKind ?? '';
  // A kind added natively later still reads as words, under the group its name points to.
  const machine = kind in MACHINES || /^(machine|link)_/.test(kind);
  const label = TEAM[kind] ?? MACHINES[kind] ?? (kind ? kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Coordinating team');
  return machine
    ? `<div class="coordination-status" role="note" aria-label="Machines status: ${escape(label)}">${icon('monitor')}<strong>Machines</strong><span>${escape(label)}</span></div>`
    : `<div class="coordination-status" role="note" aria-label="Team status">${icon('worktree')}<strong>Team</strong><span>${escape(label)}</span></div>`;
}
