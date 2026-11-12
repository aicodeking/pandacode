import type { CloneState, RecentRepo } from '../connect/api/projects.ts';
import type { Project, TasksList } from '../connect/types.ts';

/** Projectless chats live in their own "Chat" projects, which aren't something to start a task in. */
export function pickableProjects(list: TasksList | undefined | null): Project[] {
  if (!list) return [];
  const chats = new Set(list.tasks.filter(task => task.chat).map(task => task.projectId));
  return list.projects.filter(project => !chats.has(project.id));
}

/** The project picker's value for "Chat (no project)"; never a real project id (those are uuids). */
export const CHAT_CHOICE = '__chat__';
/** The project picker's value that opens Add project instead of choosing. */
export const ADD_PROJECT_CHOICE = '__add__';

export interface ProjectChoice { value: string; label: string }

/** The project picker: the computer's projects, then Chat when the host can start one, then Add project. */
export function projectChoices(projects: readonly { id: string; name: string }[], { chat, add }: { chat: boolean; add: boolean }): ProjectChoice[] {
  return [
    ...projects.map(p => ({ value: p.id, label: p.name })),
    ...(chat ? [{ value: CHAT_CHOICE, label: 'Chat (no project)' }] : []),
    ...(add ? [{ value: ADD_PROJECT_CHOICE, label: 'Add project…' }] : []),
  ];
}

/** What a new task can start with: `allowed` is false when this phone may not call the start method
 * there (its grant or the computer's switch); `attachments`, pending files or images, which can
 * stand in for typed words. */
export interface StartReadiness {
  deviceId: string; projectId: string; provider: string; prompt: string; starting: boolean; chat: boolean;
  allowed?: boolean; attachments?: boolean;
}

/** Whether a new task can start: a project, or Chat when picked (or when there is no project to pick). */
export function canStartWith({ deviceId, projectId, provider, prompt, starting, chat, allowed = true, attachments = false }: StartReadiness): boolean {
  return !!(deviceId && (chat || projectId) && provider && (prompt.trim() || attachments)) && allowed && !starting;
}

/** The host method a new task's Start calls: chat.start for a Chat, team.start for a team, else task.start. */
export const startMethod = ({ chat, team }: { chat: boolean; team: boolean }) => (chat ? 'chat.start' : team ? 'team.start' : 'task.start');

const PART = /^(?![-.])[A-Za-z0-9_.-]{1,100}$/;

/**
 * What the user typed or pasted as a repository → `owner/name`, or null. Takes `owner/name` and
 * github.com links (https, with `.git`, a trailing slash, or a deeper page such as /tree/main or
 * /pull/3, which name the same repository). The host checks it again.
 */
export function parseRepoInput(input: string): string | null {
  let text = input.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text) ?? /^git@github\.com:(.+)$/i.exec(text);
  if (link) {
    const [owner, name] = link[1].split(/[/?#]/);
    text = `${owner}/${(name ?? '').replace(/\.git$/, '')}`;
  } else if (text.includes('://') || text.startsWith('git@')) {
    return null;
  }
  const parts = text.split('/');
  if (parts.length !== 2 || !PART.test(parts[0]) || !PART.test(parts[1]) || parts[1] === '..') return null;
  return text;
}

/** Recent repositories matching a search (owner, name or description), the ones not on the computer first. */
export function filterRepos(repos: readonly RecentRepo[], query: string): RecentRepo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = repos.filter(r => words.every(w => r.repo.toLowerCase().includes(w) || r.description.toLowerCase().includes(w)));
  return [...hits.filter(r => !r.projectId), ...hits.filter(r => r.projectId)];
}

/** The clone's default folder name: the repository's name. */
export const folderFor = (repo: string) => repo.split('/')[1] ?? repo;

/** How often and how long Add project asks after a clone the computer runs in the background. */
export const CLONE_POLL_MS = 2_000;
export const CLONE_GIVE_UP_MS = 10 * 60_000;

type CloneReply = CloneState;

/**
 * Asks `status` until the clone is done or failed, or `cancelled()` (the sheet closed), or it ran
 * past `giveUpMs`. 'unknown' means the computer forgot the clone (a restart), so it stops there too.
 */
export async function waitForClone(
  first: CloneReply,
  status: () => Promise<CloneReply>,
  { sleep, cancelled, now, pollMs = CLONE_POLL_MS, giveUpMs = CLONE_GIVE_UP_MS }:
  { sleep: (ms: number) => Promise<void>; cancelled: () => boolean; now: () => number; pollMs?: number; giveUpMs?: number },
): Promise<CloneReply | null> {
  const start = now();
  let state = first;
  while (state.state === 'cloning') {
    if (now() - start > giveUpMs) return { repo: state.repo, state: 'failed', error: 'The clone is taking a long time. It keeps going on the computer; check back later.' };
    await sleep(pollMs);
    if (cancelled()) return null;
    state = await status();
  }
  return state;
}

// ---- Deploy (the desktop's src/deploy.ts): a new task in the project that ships it end to end ----

export type DeployTarget = 'vercel' | 'cloudflare' | 'railway' | 'netlify' | 'aws' | 'gcloud';
export const DEPLOY_TARGETS: readonly { id: DeployTarget; label: string; description: string }[] = [
  { id: 'vercel', label: 'Deploy to Vercel', description: 'Preview first, then production' },
  { id: 'cloudflare', label: 'Deploy to Cloudflare', description: 'Workers, static assets or Pages' },
  { id: 'railway', label: 'Deploy to Railway', description: 'Servers, containers and databases' },
  { id: 'netlify', label: 'Deploy to Netlify', description: 'Draft first, then production' },
  { id: 'aws', label: 'Deploy to AWS', description: 'The simplest fitting AWS service' },
  { id: 'gcloud', label: 'Deploy to Google Cloud', description: 'Cloud Run or Cloud Storage' },
];

/** Kept word for word with the desktop's, so a phone deploy runs the same brief. */
const DEPLOY_COMMON = `Work end to end and verify the result yourself. Use the pandacode_cloud_cli tool for the CLI below: it is already signed in to my account, so never ask me for tokens and never print or commit secrets. First read the project to understand how it builds and runs, install dependencies and run the build locally, and fix anything that stops it. If the app needs environment variables, list them and ask me for their values before deploying. When the deploy finishes, open the URL (fetch it, or use the browser) and check the main page and one key route really work; fix and redeploy if not. Finish with the live URL, what you changed in the project, and how to redeploy.`;

const DEPLOY_BRIEFS: Record<DeployTarget, string> = {
  netlify: `Deploy this project to Netlify.\n\n${DEPLOY_COMMON}\n\nWith tool "netlify": use the linked or connected project. If neither is set, ask which existing project or team to use before creating one with \`deploy --site-name <name> --team <team>\`. After a successful local build, run \`deploy --dir <output>\` for a draft, check its URL, then \`deploy --prod --dir <output>\` for production. The tool always adds \`--no-build\` so the connected token never enters local build scripts. Keep existing netlify.toml settings. Do not run login, raw API commands, hosted agents, or delete projects.`,
  vercel: `Deploy this project to Vercel.\n\n${DEPLOY_COMMON}\n\nWith tool "vercel": run \`deploy --yes\` for a preview, check it, then \`deploy --prod --yes\` for production. Let Vercel detect the framework; add a minimal vercel.json only if it is needed. Add environment variables with \`env add\` if I give you values.`,
  cloudflare: `Deploy this project to Cloudflare.\n\n${DEPLOY_COMMON}\n\nWith tool "wrangler": for a static site or a frontend build, prefer a Worker with static assets (a wrangler.jsonc with "assets": {"directory": "<build output>"}); for an API or full-stack app, a Worker with the right compatibility flags (nodejs_compat when Node APIs are used). Run \`deploy\` and report the workers.dev URL. Use Pages (\`pages deploy <dir> --project-name <name>\`) only if the project is already set up for it.`,
  railway: `Deploy this project to Railway.\n\n${DEPLOY_COMMON}\n\nWith tool "railway": if the checkout is not linked yet, run \`init --name <project>\` (it links this folder), then \`up --ci\` to build and deploy, and \`domain\` to give the service a public railway.app URL. Let Railway's builder detect the stack; add a minimal railway.json only if the start command or build needs it. If the app needs a database, add it with \`add --database postgres\` and use the variable Railway provides. Set variables with \`variable set KEY=value\` only for values I give you, and never print variable values. Check \`logs\` and \`status\` if the deploy fails. Do not delete existing projects or services.`,
  aws: `Deploy this project to AWS.\n\n${DEPLOY_COMMON}\n\nWith tool "aws": choose the simplest fitting service and say why before creating anything: a static site goes to S3 behind CloudFront; a container or server app to App Runner (build and push the image to ECR first) or Lambda for small functions. Tag everything you create with pandacode=deploy, keep it in the configured region, prefer the free tier, and tell me the expected monthly cost before creating anything that is not free. Do not delete existing resources.`,
  gcloud: `Deploy this project to Google Cloud.\n\n${DEPLOY_COMMON}\n\nWith tool "gcloud" (signed in to my configured project and region): choose the simplest fitting service and say why before creating anything. Prefer Cloud Run for servers and containers: \`run deploy <service> --source . --allow-unauthenticated --labels pandacode=deploy\` (it builds with Cloud Build; enable the needed APIs with \`services enable\` first if it asks). For a static site, a Cloud Storage bucket (\`storage buckets create\`, \`storage cp --recursive\`, public read) or a small Cloud Run service that serves the build. Label everything you create with pandacode=deploy, keep it in the configured region, prefer the free tier, and tell me the expected monthly cost before creating anything that is not free. Do not delete existing resources.`,
};

export const deployBrief = (target: DeployTarget): string => DEPLOY_BRIEFS[target];

/** The task a deploy starts: a new task in `task`'s project with its harness, model and mode, the
 * brief as its first message; null for a Chat or a bot's conversation (no project to deploy). */
export function deployTaskParams(
  task: { projectId: string; provider: string; model?: string; mode?: string; effort?: string | null; chat?: boolean; botId?: string | null } | undefined,
  target: DeployTarget,
): { projectId: string; prompt: string; provider: string; model: string; mode: string; effort?: string; worktree: false } | null {
  if (!task || task.chat || task.botId || !task.projectId) return null;
  return {
    projectId: task.projectId, prompt: deployBrief(target), provider: task.provider, model: task.model || 'default', mode: task.mode || 'ask',
    ...(task.effort ? { effort: task.effort } : {}), worktree: false,
  };
}

/** What the desktop says about one deploy target (deploy.targets): whether its CLI is connected, and
 * why not. Ids the phone doesn't know are dropped. */
export interface DeployTargetState { id: DeployTarget; connected: boolean; note?: string }
/** The desktop's own hint for a target whose CLI isn't connected yet. */
export const DEPLOY_CONNECT_NOTE = 'Connect it in Settings → Agents → Cloud sandboxes.';
const MAX_NOTE = 200;

/** Decodes a deploy.targets reply; never throws (a malformed row is skipped). */
export function decodeDeployTargets(reply: unknown): DeployTargetState[] {
  const rows = reply && typeof reply === 'object' ? (reply as { targets?: unknown }).targets : undefined;
  if (!Array.isArray(rows)) return [];
  const known = new Set<string>(DEPLOY_TARGETS.map(t => t.id));
  return rows.flatMap(row => {
    const r = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    if (typeof r.id !== 'string' || !known.has(r.id)) return [];
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, MAX_NOTE) : undefined;
    return [{ id: r.id as DeployTarget, connected: r.connected === true, ...(note ? { note } : {}) }];
  });
}

/** One Deploy menu row: the target, its description, and `note` (then disabled) when the desktop says
 * its CLI isn't connected. `states` null (an older host, or not answered yet): every target is offered. */
export interface DeployChoice { id: DeployTarget; label: string; description: string; note?: string }
export function deployChoices(states: readonly DeployTargetState[] | null): DeployChoice[] {
  const byId = new Map((states ?? []).map(s => [s.id, s]));
  return DEPLOY_TARGETS.map(t => {
    const state = byId.get(t.id);
    // A host that answers but leaves a target out has nothing to say against it.
    if (!state || state.connected) return { ...t };
    return { ...t, note: state.note ?? DEPLOY_CONNECT_NOTE };
  });
}

/** The confirm before a deploy starts: title and message. */
export function deployConfirm(choice: { label: string; description: string }, project: string, computer: string): { title: string; message: string } {
  const target = choice.label.replace(/^Deploy to /, '');
  return {
    title: `Deploy to ${target}?`,
    message: `${choice.description}. A new task ships ${project || 'this project'} with ${computer ? `${computer}’s` : 'the computer’s'} signed-in CLI.`,
  };
}
