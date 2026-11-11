// Demo answers for the `projects` feature group (src/connect/api/projects.ts): a projectless Chat
// becomes its own "Chat" project as on the desktop, and a clone finishes on the first status check
// by adding the repository as a project. Nothing touches the network. See ./index.ts.
import type { CloneState, RecentRepo } from '../connect/api/projects.ts';
import type { Project } from '../connect/types.ts';
import { parseRepoInput } from '../ui/new-task-projects.ts';
import { started, withTask } from '../demo-host.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const DAY = 24 * 60 * 60_000;

/** The demo account's repositories; ones the demo computer has are marked by project id. */
const RECENT: readonly (Omit<RecentRepo, 'projectId' | 'pushedAt'> & { daysAgo: number; projectId?: string })[] = [
  { repo: 'pandacode-app/pandacode', description: 'The PandaCode desktop app', private: false, fork: false, archived: false, language: 'TypeScript', daysAgo: 0, projectId: 'pandacode' },
  { repo: 'pandacode-app/relay', description: 'The Connect relay', private: false, fork: false, archived: false, language: 'TypeScript', daysAgo: 1, projectId: 'relay' },
  { repo: 'pandacode-app/brand', description: 'Logos, colours and type', private: true, fork: false, archived: false, language: 'HTML', daysAgo: 4 },
  { repo: 'pandacode-app/recipes', description: 'Shared recipes for agents', private: false, fork: false, archived: false, language: 'Markdown', daysAgo: 9 },
  { repo: 'octo/hello-world', description: 'A first repository', private: false, fork: true, archived: true, language: '', daysAgo: 400 },
];

/** Per device: repo → clone state; replaced (never edited in place) on every change. */
let clones: Record<string, Readonly<Record<string, CloneState>>> = {};

const projectsOf = (ctx: DemoContext): readonly Project[] => ctx.state.tasks[ctx.deviceId]?.projects ?? [];
const haveRepo = (ctx: DemoContext, repo: string) => projectsOf(ctx).find(p => p.repo?.toLowerCase() === repo.toLowerCase() || p.id === RECENT.find(r => r.repo === repo)?.projectId);

function repoParam(p: { repo?: unknown }): string {
  const repo = parseRepoInput(String(p.repo ?? ''));
  if (!repo) throw new Error('Enter a GitHub repository as owner/name or a github.com link.');
  return repo;
}

function setClone(ctx: DemoContext, repo: string, state: CloneState): CloneState {
  clones = { ...clones, [ctx.deviceId]: { ...clones[ctx.deviceId], [repo]: state } };
  return state;
}

/** Adds the cloned repository as a project, as the computer does when the clone finishes. */
function finishClone(ctx: DemoContext, repo: string, name: string): CloneState {
  const id = `demo-${name.toLowerCase()}`;
  ctx.host.set(s => {
    const list = s.tasks[ctx.deviceId] ?? { tasks: [], projects: [], loadedAt: ctx.host.now() };
    if (list.projects.some(p => p.id === id)) return {};
    return { tasks: { ...s.tasks, [ctx.deviceId]: { ...list, projects: [...list.projects, { id, name, repo }] } } };
  });
  return setClone(ctx, repo, { repo, state: 'done', projectId: id, existing: false });
}

export const handlers: DemoHandlers = {
  'projects.recentRepos': ctx => {
    const now = ctx.host.now();
    const repos: RecentRepo[] = RECENT.map(({ daysAgo, projectId, ...r }) => ({
      ...r, pushedAt: new Date(now - daysAgo * DAY).toISOString(),
      projectId: haveRepo(ctx, r.repo)?.id ?? (projectId && projectsOf(ctx).some(p => p.id === projectId) ? projectId : null),
    }));
    return { repos };
  },
  'projects.clone': (ctx, p) => {
    const repo = repoParam(p);
    const have = haveRepo(ctx, repo);
    if (have) return setClone(ctx, repo, { repo, state: 'done', projectId: have.id, existing: true });
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : repo.split('/')[1];
    const state = setClone(ctx, repo, { repo, state: 'cloning' });
    ctx.host.later(() => void finishClone(ctx, repo, name), 1500);
    return state;
  },
  'projects.cloneStatus': (ctx, p) => {
    const repo = repoParam(p);
    const state = clones[ctx.deviceId]?.[repo];
    if (state?.state === 'cloning') return finishClone(ctx, repo, repo.split('/')[1]);
    return state ?? { repo, state: 'unknown' };
  },
  'chat.start': ({ host, deviceId, reply }, p) => {
    const prompt = String(p.prompt ?? '').trim();
    if (!prompt) throw new Error('Write a message first.');
    const now = host.now();
    const sessionId = `demo-chat-${now.toString(36)}`;
    const projectId = `chat-${now.toString(36)}`;
    host.set(s => {
      const list = s.tasks[deviceId] ?? { tasks: [], projects: [], loadedAt: now };
      return { tasks: { ...s.tasks, [deviceId]: { ...list, projects: [...list.projects, { id: projectId, name: 'Chat', repo: null }] } } };
    });
    host.set(s => started(s, deviceId, sessionId, { projectId, prompt, provider: p.provider, model: p.model, mode: p.mode, effort: p.effort, worktree: false }, now));
    host.set(s => ({ tasks: withTask(s, deviceId, sessionId, { chat: true }) }));
    reply(sessionId);
    return { sessionId, projectId };
  },
};
