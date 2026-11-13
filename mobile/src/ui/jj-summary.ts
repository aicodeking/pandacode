// What the read-only jj card (ui/JjCard.tsx) says about a checkout's working-copy change. Pure, for
// tests/jj.test.ts.
import type { JjStatus } from '../connect/api/settings.ts';

const SHORT_ID = 12;

export interface JjSummary { title: string; subtitle: string; conflict: boolean }

/** Null when the checkout isn't a jj repo (or jj didn't describe a change). */
export function jjSummary(status: JjStatus | null | undefined): JjSummary | null {
  const change = status?.isRepo ? status.change : null;
  if (!status || !change) return null;
  const files = status.files.length;
  const count = files ? `${files}${status.truncated ? '+' : ''} file${files === 1 && !status.truncated ? '' : 's'} changed` : change.empty ? 'Empty change' : '';
  const parts = [
    change.changeId.slice(0, SHORT_ID),
    change.bookmarks.length ? change.bookmarks.join(', ') : '',
    count,
    change.conflict ? 'Has conflicts' : '',
    status.colocated ? 'Colocated with Git' : '',
  ];
  return { title: change.description.trim().split('\n')[0] || '(no description)', subtitle: parts.filter(Boolean).join(' · '), conflict: change.conflict };
}
