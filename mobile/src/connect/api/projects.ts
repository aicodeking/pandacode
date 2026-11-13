// Host calls for the `projects` feature group (src-tauri/src/remote/methods/projects.rs): starting
// a projectless Chat, cloning a GitHub repository as a new project (always into ~/PandaCode on the
// computer: the phone never names a folder) and the account's recent repositories.
//
// chat.start carries a startId like task.start, so a lost reply turns into task.startStatus polls
// (start-retry.ts). client.ts is loaded only by the calls, so node can load this file.
import type { HostCallOptions } from '../client.ts';
import { registerMethods, START_TIMEOUT_MS, type Method } from '../rpc.ts';
import { draftStartId, followStart, keepsStartId, type DraftStart, type StartReply } from '../start-retry.ts';
import type { StartStatus } from '../types.ts';

export const PROJECTS_METHODS = registerMethods(['chat.start', 'projects.clone', 'projects.cloneStatus', 'projects.recentRepos'] as const);

export interface RecentRepo {
  repo: string; description: string; private: boolean; fork: boolean; archived: boolean;
  pushedAt: string; language: string;
  /** Set when the computer already has this repository as a project. */
  projectId: string | null;
}
export type CloneState =
  | { repo: string; state: 'cloning' }
  | { repo: string; state: 'done'; projectId: string; existing: boolean }
  | { repo: string; state: 'failed'; error: string }
  | { repo: string; state: 'unknown' };

export interface ChatStartParams { prompt: string; provider: string; model: string; mode?: string; effort?: string; startId?: string; imageIds?: string[] }

/** GitHub's own listing can be slow on a big account. */
const REPOS_TIMEOUT_MS = 30_000;

const hostCall = async <T>(deviceId: string, method: Method, params: unknown, options?: HostCallOptions): Promise<T> =>
  (await import('../client.ts')).hostCall<T>(deviceId, method, params, options);

export type ChatStartReply = StartReply & { projectId?: string };

export const startChat = (deviceId: string, params: ChatStartParams) =>
  hostCall<ChatStartReply>(deviceId, 'chat.start', params, { timeoutMs: START_TIMEOUT_MS });

export const recentRepos = (deviceId: string) =>
  hostCall<{ repos: RecentRepo[] }>(deviceId, 'projects.recentRepos', {}, { timeoutMs: REPOS_TIMEOUT_MS }).then(r => r.repos ?? []);

export const cloneRepo = (deviceId: string, repo: string, name?: string) =>
  hostCall<CloneState>(deviceId, 'projects.clone', { repo, ...(name ? { name } : {}) });

export const cloneStatus = (deviceId: string, repo: string) => hostCall<CloneState>(deviceId, 'projects.cloneStatus', { repo });

/** What starting a chat needs, handed in so tests can drive it. */
export interface ChatStartDeps {
  start: (params: ChatStartParams) => Promise<ChatStartReply>;
  status: (startId: string) => Promise<StartStatus & { worktree?: unknown; note?: unknown }>;
  canPoll: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
}

/** The last chat draft's start id: a retry of the same draft after a lost reply reuses it, so the host starts one chat. */
let chatDraft: DraftStart | null = null;

/** Starts a chat once per draft: the host runs one start per startId and a lost reply is followed
 * with task.startStatus (which knows chat starts too). A followed start keeps its projectId too. */
export async function startChatOnce(deps: ChatStartDeps, deviceId: string, params: Omit<ChatStartParams, 'startId'>): Promise<ChatStartReply> {
  const draft = draftStartId(chatDraft, JSON.stringify([deviceId, params]), deps.uuid);
  chatDraft = draft;
  const startId = draft.id;
  try {
    const reply = await followStart({
      start: () => deps.start({ ...params, startId }),
      status: () => deps.status(startId),
      canPoll: deps.canPoll,
      sleep: deps.sleep,
      now: deps.now,
      maxMs: START_TIMEOUT_MS,
    });
    chatDraft = null;
    return reply;
  } catch (e) {
    if (!keepsStartId(e)) chatDraft = null;
    throw e;
  }
}

/** Starts a Chat from the new-task form and refreshes the computer's tasks; throws on failure. */
export async function startChatTask(deviceId: string, params: Omit<ChatStartParams, 'startId'>): Promise<ChatStartReply> {
  const { connect } = await import('../client.ts');
  const { capabilitiesOf } = await import('./capabilities.ts');
  const { supports } = await import('./hello.ts');
  const { uuid } = await import('../crypto.ts');
  const reply = await startChatOnce({
    start: next => startChat(deviceId, next),
    status: startId => hostCall(deviceId, 'task.startStatus', { startId }),
    canPoll: () => supports(capabilitiesOf(deviceId), 'task.startStatus') !== false,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
    uuid,
  }, deviceId, params);
  void connect.listTasks(deviceId).catch(() => undefined);
  return reply;
}
