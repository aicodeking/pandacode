// The pull request's summary card: checks, approval and conflicts as one line each. Pure (tested in node).
import type { MergeMethod, PullCheck, PullDetail } from '../connect/types.ts';

export type SummaryTone = 'success' | 'danger' | 'warning' | 'neutral';
export interface SummaryLine { tone: SummaryTone; title: string; meta?: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function checksLine(checks: readonly PullCheck[]): SummaryLine | null {
  if (!checks.length) return null;
  const failing = checks.filter(c => c.state === 'failure').length;
  const pending = checks.filter(c => c.state === 'pending').length;
  const meta = `${checks.length - failing - pending} of ${checks.length}`;
  if (failing) return { tone: 'danger', title: `${plural(failing, 'check')} failing`, meta };
  if (pending) return { tone: 'warning', title: `${plural(pending, 'check')} pending`, meta };
  return { tone: 'success', title: 'All checks passed', meta };
}

export function reviewLine(pull: Pick<PullDetail, 'reviewDecision' | 'timeline'>): SummaryLine | null {
  const reviewers = [...new Set(pull.timeline.filter(c => c.kind === 'review' && c.state.toLowerCase() === 'approved').map(c => c.author))];
  switch (pull.reviewDecision) {
    case 'approved': return { tone: 'success', title: reviewers.length ? `Approved by ${reviewers.join(', ')}` : 'Approved' };
    case 'changes_requested': return { tone: 'danger', title: 'Changes requested' };
    case 'review_required': return { tone: 'warning', title: 'Review required' };
    case 'commented': return { tone: 'neutral', title: 'Commented' };
    default: return null;
  }
}

export function conflictsLine(pull: Pick<PullDetail, 'mergeable' | 'base'>, method: MergeMethod): SummaryLine {
  const meta = method;
  if (pull.mergeable === 'conflicting') return { tone: 'danger', title: `Conflicts with ${pull.base}`, meta };
  if (pull.mergeable === 'mergeable') return { tone: 'success', title: `No conflicts with ${pull.base}`, meta };
  return { tone: 'neutral', title: 'Checking for conflicts', meta };
}

/** `+6`, `−2` or both: a side with nothing changed says nothing. */
export function countParts(additions = 0, deletions = 0): { added?: string; removed?: string } {
  return { ...(additions > 0 && { added: `+${additions}` }), ...(deletions > 0 && { removed: `−${deletions}` }) };
}
