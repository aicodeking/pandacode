// Demo answers for the `github` feature group (src/connect/api/github.ts). See ./index.ts.
// Three of the demo projects are on GitHub; each has a few open issues, pull requests and runs.
import type { GithubRepo, HubIssue, HubPull, HubRun, IssueDetail, RunDetail, SearchItem } from '../connect/api/github.ts';
import { DEMO_PULL_TASK, started, withTask } from '../demo-host.ts';
import { demoPull } from '../demo-pull.ts';
import type { DemoHandlers } from './index.ts';

const HOUR = 3_600_000;
/** A `pull.review` event's verdict on the timeline (github_pull.rs lowercases GitHub's). */
const REVIEW_STATES: Record<string, string> = { approve: 'approved', request_changes: 'changes_requested', comment: 'commented' };
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const REPOS: Record<string, string> = { pandacode: 'pandacode-app/pandacode', relay: 'pandacode-app/relay', 'pandacode-web': 'pandacode-app/pandacode-web' };
const url = (projectId: string, path: string) => `https://github.com/${REPOS[projectId] ?? 'pandacode-app/demo'}/${path}`;

function issues(projectId: string): HubIssue[] {
  const i = (number: number, title: string, author: string, hours: number, comments: number, labels: string[], assignees: string[] = []): HubIssue =>
    ({ number, title, author, updatedAt: iso(hours), url: url(projectId, `issues/${number}`), comments, labels, assignees });
  return [
    i(412, 'Sidebar flickers when a task finishes while scrolling', 'mara', 2, 3, ['bug', 'sidebar'], ['devon']),
    i(409, 'Show the run clock on the Lock Screen', 'devon', 20, 1, ['enhancement', 'mobile']),
    i(398, 'Keyboard covers the last approval button on iPad', 'sam-k', 50, 5, ['bug', 'mobile']),
    i(377, 'Document the relay frame limits', 'mara', 140, 0, ['docs']),
  ];
}

function pulls(projectId: string): HubPull[] {
  const p = (number: number, title: string, author: string, head: string, hours: number, review: string, checks: string, additions: number, deletions: number, labels: string[] = [], state = 'open'): HubPull =>
    ({ number, title, author, state, head, base: 'main', updatedAt: iso(hours), url: url(projectId, `pull/${number}`), review, checks, additions, deletions, labels });
  return [
    p(415, 'Fold tool groups in the phone transcript', 'devon', 'feat/tool-groups', 1, 'review_required', 'pending', 284, 61, ['mobile']),
    p(413, 'Retry relay uploads with jittered backoff', 'mara', 'fix/upload-retry', 6, 'approved', 'passing', 92, 30),
    p(406, 'Bump Expo to the next SDK', 'renovate', 'deps/expo', 30, '', 'failing', 412, 388, ['dependencies']),
    p(401, 'Draft: Schedules on the phone', 'sam-k', 'feat/phone-schedules', 70, '', 'none', 640, 12, [], 'draft'),
  ];
}

function runs(projectId: string): HubRun[] {
  const r = (id: number, workflow: string, title: string, branch: string, event: string, state: string, hours: number, attempt = 1, pullNumbers: number[] = []): HubRun =>
    ({ id, workflow, title, branch, event, state, createdAt: iso(hours), startedAt: iso(hours), updatedAt: iso(hours - 0.1), url: url(projectId, `actions/runs/${id}`), attempt, pulls: pullNumbers });
  return [
    r(9_001_204, 'CI', 'Fold tool groups in the phone transcript', 'feat/tool-groups', 'pull_request', 'in_progress', 0.2, 1, [415]),
    r(9_001_180, 'CI', 'Bump Expo to the next SDK', 'deps/expo', 'pull_request', 'failed', 3, 2, [406]),
    r(9_001_150, 'Release', 'chore: release 0.3.102', 'main', 'push', 'passed', 9),
    r(9_001_101, 'CI', 'Retry relay uploads with jittered backoff', 'fix/upload-retry', 'pull_request', 'passed', 6, 1, [413]),
    r(9_000_990, 'Nightly', 'Nightly', 'main', 'schedule', 'cancelled', 26),
  ];
}

const BODIES: Record<number, string> = {
  412: 'When a task finishes while the sidebar is mid-scroll, its row jumps to **Recent** and the list flickers for a frame.\n\n### Steps\n1. Start two tasks.\n2. Scroll the sidebar while one finishes.\n\n```\nmacOS 26.1 · PandaCode 0.3.102\n```',
  415: 'Groups consecutive reads and searches into one foldable row, like the desktop trace.\n\n- [x] Reads and greps fold\n- [x] Edits stay separate\n- [ ] Screenshots for the README',
  406: 'Updates `expo` and its modules. The iOS build fails on the new `expo-widgets` config plugin.',
};

function detail(projectId: string, kind: 'issue' | 'pull', number: number): IssueDetail {
  const issue = issues(projectId).find(i => i.number === number);
  const pull = pulls(projectId).find(p => p.number === number);
  const base = kind === 'pull' ? pull : issue;
  if (!base) throw new Error(`#${number} was not found.`);
  const comments = [
    { author: 'devon', body: 'I can reproduce this on the Mac Studio. Looks like the row is measured before the section moves.', createdAt: iso(5), truncated: false },
    { author: 'mara', body: 'Thanks! A fix is in progress — see the linked branch.', createdAt: iso(3), truncated: false },
  ];
  const shared = { number, title: base.title, url: base.url, author: base.author, createdAt: iso(72), updatedAt: base.updatedAt, body: BODIES[number] ?? 'No description provided.', labels: base.labels, comments, earlierComments: 0, truncated: false };
  if (kind === 'issue' || !pull) return { ...shared, kind: 'issue', state: 'open', assignees: issue?.assignees ?? [] };
  const checkState = pull.checks === 'passing' ? 'success' : pull.checks === 'failing' ? 'failure' : 'pending';
  return {
    ...shared, kind: 'pull', state: pull.state, assignees: [], head: pull.head, base: pull.base, review: pull.review, additions: pull.additions, deletions: pull.deletions,
    checks: pull.checks === 'none' ? [] : [
      { name: 'build (macos)', workflow: 'CI', state: checkState, url: url(projectId, 'actions') },
      { name: 'test (node)', workflow: 'CI', state: 'success', url: url(projectId, 'actions') },
      { name: 'lint', workflow: 'CI', state: 'success', url: url(projectId, 'actions') },
    ],
  };
}

function runDetail(projectId: string, runId: number): RunDetail {
  const run = runs(projectId).find(r => r.id === runId);
  if (!run) throw new Error('That run was not found.');
  const failed = run.state === 'failed';
  const step = (name: string, state = 'passed') => ({ name, state, startedAt: run.startedAt, completedAt: run.updatedAt });
  return {
    kind: 'run', runId, truncated: false,
    jobs: [
      { id: runId * 10 + 1, name: 'build (macos)', state: failed ? 'failed' : run.state, startedAt: run.startedAt, completedAt: run.updatedAt, url: `${run.url}/job/1`,
        steps: [step('Set up job'), step('Checkout'), step('Install dependencies'), step('Build', failed ? 'failed' : run.state === 'in_progress' ? 'in_progress' : 'passed')],
        summary: failed ? '### Build failed\n`expo-widgets` config plugin: **Unknown option `liveActivity`**.' : '' },
      { id: runId * 10 + 2, name: 'test (node)', state: run.state === 'in_progress' ? 'queued' : 'passed', startedAt: run.startedAt, completedAt: run.updatedAt, url: `${run.url}/job/2`, steps: [step('Set up job'), step('Run tests')], summary: '' },
    ],
    attempts: run.attempt > 1 ? [{ attempt: 1, state: 'failed', startedAt: iso(5), updatedAt: iso(4.9), url: `${run.url}/attempts/1` }] : [],
    artifacts: failed ? [{ name: 'build-log', size: 182_400, expired: false }] : [],
  };
}

const repoOf = (projectId: string) => {
  if (!REPOS[projectId]) throw new Error('This project has no GitHub remote.');
  return projectId;
};

export const handlers: DemoHandlers = {
  'github.repos': ({ state, deviceId }) => {
    const projects = state.tasks[deviceId]?.projects ?? [];
    const repos: GithubRepo[] = projects.filter(p => REPOS[p.id]).map(p => ({ projectId: p.id, projectName: p.name, repo: REPOS[p.id] }));
    return { repos, truncated: false };
  },
  'github.issues': (_ctx, p) => ({ items: issues(repoOf(p.projectId)), truncated: false }),
  'github.pulls': (_ctx, p) => ({ items: pulls(repoOf(p.projectId)), truncated: false }),
  'github.runs': (_ctx, p) => ({ items: runs(repoOf(p.projectId)), truncated: false }),
  'github.item': (_ctx, p) => (p.kind === 'run' ? runDetail(repoOf(p.projectId), Number(p.runId)) : detail(repoOf(p.projectId), p.kind, Number(p.number))),
  'github.search': (_ctx, p) => {
    const projectId = repoOf(p.projectId);
    const query = String(p.query ?? '').trim().replace(/^#/, '').toLowerCase();
    const items: SearchItem[] = [
      ...issues(projectId).map(i => ({ kind: 'issue' as const, number: i.number, title: i.title, state: 'open', url: i.url, author: i.author })),
      ...pulls(projectId).map(pr => ({ kind: 'pull' as const, number: pr.number, title: pr.title, state: pr.state, url: pr.url, author: pr.author })),
    ].filter(item => String(item.number) === query || item.title.toLowerCase().includes(query));
    return { items, truncated: false };
  },
  'github.comment': (_ctx, p) => ({ url: url(repoOf(p.projectId), `${p.kind === 'pull' ? 'pull' : 'issues'}/${p.number}#issuecomment-demo`) }),
  // Adds the review to the demo pull request's timeline, so the refresh after it shows it.
  'pull.review': ({ host, state, deviceId }, p) => {
    const event = String(p.event ?? '');
    if (!REVIEW_STATES[event]) throw new Error('Approve, request changes or comment.');
    const body = String(p.body ?? '').trim();
    if (event !== 'approve' && !body) throw new Error('Write a comment for this review.');
    const key = `${deviceId}/${String(p.sessionId)}`;
    if (p.sessionId !== DEMO_PULL_TASK && !state.pulls[key]) throw new Error('This task has no linked pull request.');
    const pull = state.pulls[key] ?? demoPull();
    const review = { kind: 'review', author: 'you', body, state: REVIEW_STATES[event], createdAt: new Date(host.now()).toISOString() };
    host.set(next => ({ pulls: { ...next.pulls, [key]: { ...pull, timeline: [...pull.timeline, review] } } }));
    return { number: pull.number };
  },
  'github.startTask': ({ host, deviceId, reply }, p) => {
    const issue = issues(repoOf(p.projectId)).find(i => i.number === Number(p.issueNumber));
    if (!issue) throw new Error(`#${p.issueNumber} was not found.`);
    const sessionId = `demo-${host.now().toString(36)}`;
    const prompt = `Fix issue #${issue.number}: ${issue.title}. Work on a new branch, make the change, add or update tests and run them. When it's done, summarize what changed and offer to open a pull request that closes #${issue.number}.`;
    host.set(next => started(next, deviceId, sessionId, { projectId: p.projectId, prompt, provider: p.provider, model: p.model, mode: p.mode, effort: p.effort, worktree: !!p.worktree }, host.now()));
    host.set(next => ({ tasks: withTask(next, deviceId, sessionId, { title: `Fix #${issue.number}: ${issue.title}`.slice(0, 120) }) }));
    reply(sessionId);
    return { sessionId };
  },
};
