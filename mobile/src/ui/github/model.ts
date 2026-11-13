// The GitHub screens' pure logic (src/app/github.tsx, github-item.tsx): state badges, row lines,
// the search filter and Markdown made safe to render. No React Native imports (tested in node).
import type { HubIssue, HubPull, HubRun, ItemCheck } from '../../connect/api/github.ts';

export type GithubTab = 'issues' | 'pulls' | 'runs';
/** Badge tones, a subset of the design system's `Tone`. */
export type BadgeTone = 'success' | 'danger' | 'warning' | 'info' | 'running' | 'team' | undefined;
export interface Badge { label: string; tone: BadgeTone }

export const TABS: readonly { value: GithubTab; label: string }[] = [
  { value: 'issues', label: 'Issues' }, { value: 'pulls', label: 'Pull requests' }, { value: 'runs', label: 'Actions' },
];

/** How long ago, the way the desktop's tracker says it: now, 25m, 5h, 3d, 2mo. */
export function age(iso: string | number, now = Date.now()): string {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 30) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 43_200)}mo`;
}

/** An issue's or pull request's state chip. */
export function itemBadge(state: string): Badge {
  switch (state) {
    case 'merged': return { label: 'Merged', tone: 'team' };
    case 'closed': return { label: 'Closed', tone: 'danger' };
    case 'draft': return { label: 'Draft', tone: undefined };
    default: return { label: 'Open', tone: 'success' };
  }
}

/** A pull request row's chip: its checks when they say something, else its review, else its state. */
export function pullBadge(pull: Pick<HubPull, 'state' | 'checks' | 'review'>): Badge {
  if (pull.state === 'draft') return itemBadge('draft');
  if (pull.checks === 'failing') return { label: 'Failing', tone: 'danger' };
  if (pull.review === 'changes_requested') return { label: 'Changes', tone: 'warning' };
  if (pull.review === 'approved') return { label: 'Approved', tone: 'success' };
  if (pull.checks === 'pending') return { label: 'Checks', tone: 'running' };
  return itemBadge(pull.state);
}

/** A workflow run's or job's state chip. */
export function runBadge(state: string): Badge {
  switch (state) {
    case 'passed': return { label: 'Passed', tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'not_started': return { label: 'Didn’t start', tone: 'danger' };
    case 'cancelled': return { label: 'Cancelled', tone: undefined };
    case 'in_progress': return { label: 'Running', tone: 'running' };
    default: return { label: 'Queued', tone: 'info' };
  }
}

export function checkBadge(state: ItemCheck['state']): Badge {
  return state === 'success' ? { label: 'Passed', tone: 'success' } : state === 'failure' ? { label: 'Failed', tone: 'danger' } : state === 'pending' ? { label: 'Pending', tone: 'running' } : { label: 'Skipped', tone: undefined };
}

/** Checks summary for a pull request's head: "2 failing · 5 passed". */
export function checksLine(checks: readonly ItemCheck[]): string {
  const count = (state: ItemCheck['state']) => checks.filter(c => c.state === state).length;
  return [[count('failure'), 'failing'], [count('pending'), 'pending'], [count('success'), 'passed'], [count('neutral'), 'skipped']]
    .filter(([n]) => (n as number) > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
}

export const issueLine = (issue: HubIssue, now = Date.now()) =>
  [`#${issue.number}`, issue.author, age(issue.updatedAt, now), issue.comments ? `${issue.comments} comment${issue.comments === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
export const pullLine = (pull: HubPull, now = Date.now()) =>
  [`#${pull.number}`, pull.author, `${pull.head} → ${pull.base}`, age(pull.updatedAt, now)].filter(Boolean).join(' · ');
export const runLine = (run: HubRun, now = Date.now()) =>
  [run.workflow, run.branch, run.event.replace(/_/g, ' '), run.attempt > 1 ? `attempt ${run.attempt}` : '', age(run.createdAt, now)].filter(Boolean).join(' · ');

/** Rows matching the search field: by number ("#12" or "12"), title, author, branch or label. */
export function filterRows<T extends object>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const number = /^#?(\d+)$/.exec(q)?.[1];
  return rows.filter(row => {
    const r = row as Partial<HubIssue & HubPull & HubRun>;
    if (number && (String(r.number ?? '') === number || String(r.id ?? '') === number)) return true;
    return [r.title, r.author, r.head, r.branch, r.workflow, ...(r.labels ?? [])].some(field => typeof field === 'string' && field.toLowerCase().includes(q));
  });
}

const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * GitHub Markdown the phone can draw without fetching anything: images (Markdown or HTML) become
 * links to open on tap, and HTML comments (issue templates) are dropped.
 */
export function safeMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(IMAGE, (_m, alt: string, src: string) => `[${alt.trim() || 'Image'}](${src})`)
    .replace(HTML_IMAGE, (_m, src: string) => `[Image](${src})`)
    .replace(/!\[/g, '[')
    .trim();
}

/** Only web links open from the GitHub screens. */
export const isWebUrl = (url: string) => /^https:\/\//i.test(url);
