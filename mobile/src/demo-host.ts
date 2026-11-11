// The fake computer behind demo mode (src/demo.ts): client.ts sends every host call here instead
// of the relay, so sends, steers, approvals, answers and stops act on the local demo data and
// nothing touches the network. Pure apart from the injected timer (tested in node).
import { OFFLINE, UNKNOWN_METHOD, type Method } from './connect/rpc.ts';
import { DEMO_HANDLERS } from './demo/index.ts';
import { queueDemoMessage, takeQueuedDemoMessage } from './demo/composer.ts';
import { SWITCH_METHODS, type Access } from './connect/api/hello.ts';
import type { Bot, ConfigureParams, Message, StartParams, TaskSummary } from './connect/types.ts';
import { demoChanges, demoDiff, demoPull, demoPullPatch } from './demo-pull.ts';
import { DEMO_TEAM_TASK, demoTeam, demoWorkerMessages } from './demo-team.ts';
import type { ConnectState } from './store/index.ts';
import { idleLive, lastId } from './store/reduce.ts';

export const REPLY_MS = 1500;
export const DEMO_REPLY = 'This is the demo, so nothing ran. On your own computer the agent would work on this now: its tools, approvals and reply would stream in here as it goes.';

type Patch = Partial<ConnectState>;

export interface DemoHost {
  get: () => ConnectState;
  set: (update: (s: ConnectState) => Patch) => void;
  later: (run: () => void, ms: number) => void;
  now: () => number;
}

const key = (deviceId: string, sessionId: string) => `${deviceId}/${sessionId}`;

const append = (list: readonly Message[] | undefined, role: string, content: string, now: number, turnDurationMs: number | null = null): Message[] =>
  [...(list ?? []), { id: lastId(list) + 1, role, content, createdAt: now, turnDurationMs }];

export function withTask(s: ConnectState, deviceId: string, sessionId: string, change: Partial<TaskSummary>): ConnectState['tasks'] {
  const list = s.tasks[deviceId];
  if (!list) return s.tasks;
  return { ...s.tasks, [deviceId]: { ...list, tasks: list.tasks.map(t => (t.sessionId === sessionId ? { ...t, ...change } : t)) } };
}

/** A prompt joins the transcript and the task runs until the canned reply. */
export function sent(s: ConnectState, deviceId: string, sessionId: string, text: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  return {
    messages: { ...s.messages, [k]: append(s.messages[k], 'user', text, now) },
    live: { ...s.live, [k]: { ...idleLive(), status: 'running', activity: 'Generating response' } },
    tasks: withTask(s, deviceId, sessionId, { status: 'running', updatedAt: now, lastPromptAt: now }),
  };
}

/** The canned reply ends a run that is still going; a stopped or waiting run gets none. */
export function replied(s: ConnectState, deviceId: string, sessionId: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  if (s.live[k]?.status !== 'running') return {};
  return {
    messages: { ...s.messages, [k]: append(s.messages[k], 'assistant', DEMO_REPLY, now, REPLY_MS) },
    live: { ...s.live, [k]: idleLive() },
    tasks: withTask(s, deviceId, sessionId, { status: 'idle', updatedAt: now, pending: [] }),
  };
}

/** Stop ends the run and, as on the host, pauses an architect's team. */
export function stopped(s: ConnectState, deviceId: string, sessionId: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  const team = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.team;
  const loaded = s.teams[k];
  return {
    live: { ...s.live, [k]: { ...idleLive(), status: 'stopped' } },
    tasks: withTask(s, deviceId, sessionId, { status: 'stopped', updatedAt: now, pending: [], ...(team !== undefined && { team: { status: 'paused', activeWorkers: 0 } }) }),
    ...(loaded && loaded !== 'outdated' && { teams: { ...s.teams, [k]: { ...loaded, status: 'paused' } } }),
  };
}

export function started(s: ConnectState, deviceId: string, sessionId: string, params: StartParams, now: number): Patch {
  const list = s.tasks[deviceId] ?? { tasks: [], projects: [], loadedAt: now };
  const projectId = params.projectId ?? params.repo ?? 'demo';
  const task: TaskSummary = {
    sessionId, title: params.prompt.split('\n')[0].slice(0, 80) || 'New task', status: 'running',
    projectId, projectName: list.projects.find(p => p.id === projectId)?.name ?? projectId,
    provider: params.provider, model: params.model, effort: params.effort ?? null, mode: params.mode ?? 'ask',
    pinned: false, updatedAt: now, lastPromptAt: now, branch: params.branch,
  };
  return {
    tasks: { ...s.tasks, [deviceId]: { ...list, tasks: [task, ...list.tasks] } },
    messages: { ...s.messages, [key(deviceId, sessionId)]: append([], 'user', params.prompt, now) },
  };
}

/** The demo's one pull request is on the passkeys task. */
export const DEMO_PULL_TASK = 'auth';

export function withBot(s: ConnectState, deviceId: string, botId: string, change: Partial<Bot>): Patch {
  return { bots: { ...s.bots, [deviceId]: (s.bots[deviceId] ?? []).map(b => (b.id === botId ? { ...b, ...change } : b)) } };
}

/** Demo uploads: chunks per uploadId until the image is whole, then ids a task.send may claim once. */
const uploads = new Map<string, number>();
const demoImages = new Set<string>();
const MAX_DEMO_UPLOADS = 16;
let demoImageCount = 0;

/** One `image.put` chunk, checked as the host does (images.rs); the last one names the image. */
function putImage(params: any): { imageId?: string } {
  const uploadId = typeof params?.uploadId === 'string' ? params.uploadId : '';
  const size = Number(params?.size);
  const data = typeof params?.data === 'string' ? params.data : '';
  if (!uploadId || !Number.isInteger(params?.index) || !Number.isInteger(size) || size < 1 || !data) throw new Error('Invalid image data.');
  const got = (uploads.get(uploadId) ?? 0) + Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (got < size) {
    if (!uploads.has(uploadId) && uploads.size >= MAX_DEMO_UPLOADS) throw new Error('Too many images are on their way. Try again in a moment.');
    uploads.set(uploadId, got);
    return {};
  }
  uploads.delete(uploadId);
  const imageId = `demo-image-${(demoImageCount += 1)}`;
  demoImages.add(imageId);
  return { imageId };
}

/** Claims a task.send's `imageIds` (each once), as the host does. */
function claimImages(ids: unknown) {
  if (ids == null) return;
  if (!Array.isArray(ids) || ids.length > 4) throw new Error('Invalid imageIds.');
  if (ids.some(id => !demoImages.has(id))) throw new Error('An image for this message is missing on this computer. Send it again.');
  for (const id of ids) demoImages.delete(id);
}

/** Whether the demo task's run is going (its live status, or the seeded task list's). */
const running = (s: ConnectState, deviceId: string, sessionId: string) =>
  s.live[key(deviceId, sessionId)]?.status === 'running' || s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.status === 'running';

/** Answers one host call from the demo data, as the real host would. */
export async function demoCall(host: DemoHost, deviceId: string, method: Method, params: any): Promise<unknown> {
  const s = host.get();
  if (!s.devices.find(d => d.id === deviceId)?.online) throw new Error(OFFLINE);
  // The reply ends the run; then, as on the host, the task's queue delivers its next message.
  const reply = (sessionId: string): void => host.later(() => {
    const ending = host.get().live[key(deviceId, sessionId)]?.status === 'running';
    host.set(next => replied(next, deviceId, sessionId, host.now()));
    const queued = ending ? takeQueuedDemoMessage(deviceId, sessionId) : null;
    if (!queued) return;
    host.set(next => sent(next, deviceId, sessionId, queued.text, host.now()));
    reply(sessionId);
  }, REPLY_MS);
  switch (method) {
    case 'tasks.list': {
      const list = s.tasks[deviceId];
      return { tasks: list?.tasks ?? [], projects: list?.projects ?? [] };
    }
    case 'task.messages': return { messages: [], hasMore: false, title: '' };
    case 'subscribe': return { tasks: [] };
    case 'providers.list': return s.providers[deviceId] ?? [];
    case 'providers.models': return s.models[`${deviceId}/${params?.provider}`] ?? [];
    case 'image.put': return putImage(params);
    case 'task.send':
    case 'task.steer':
      if (method === 'task.send') claimImages(params?.imageIds);
      // A send behind a running turn waits in the task's queue, as on the host.
      if (method === 'task.send' && running(s, deviceId, params.sessionId)) {
        queueDemoMessage(deviceId, params.sessionId, String(params.text ?? ''), host.now());
        return { queued: true };
      }
      host.set(next => sent(next, deviceId, params.sessionId, String(params.text ?? ''), host.now()));
      reply(params.sessionId);
      return method === 'task.send' ? { queued: false } : {};
    case 'task.stop':
      host.set(next => stopped(next, deviceId, params.sessionId, host.now()));
      return {};
    case 'approval.respond':
    case 'input.respond':
      reply(params.sessionId); // client.ts clears the request and marks the run going again
      return {};
    case 'task.configure': {
      const { sessionId, ...change } = params as ConfigureParams;
      const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
      host.set(next => ({ tasks: withTask(next, deviceId, sessionId, defined) }));
      return {};
    }
    case 'task.start': {
      const sessionId = `demo-${host.now().toString(36)}`;
      host.set(next => started(next, deviceId, sessionId, params as StartParams, host.now()));
      reply(sessionId);
      return { sessionId };
    }
    case 'task.pull':
    case 'task.pullDetect': {
      // pullDetect finds only newly linked pull requests; the demo's is linked already.
      if (method === 'task.pullDetect' || params.sessionId !== DEMO_PULL_TASK) return { pull: null };
      return { pull: s.pulls[key(deviceId, DEMO_PULL_TASK)] ?? demoPull() };
    }
    case 'task.pullDiff':
      return params.path ? { patch: demoPullPatch(String(params.path)), truncated: false } : { files: demoPull().files, truncated: false };
    case 'task.pullMerge': {
      const k = key(deviceId, DEMO_PULL_TASK);
      host.set(next => ({ pulls: { ...next.pulls, [k]: { ...(next.pulls[k] ?? demoPull()), state: 'merged', mergedAt: new Date(host.now()).toISOString() } } }));
      return {};
    }
    case 'task.changes': return demoChanges(params.sessionId, s.tasks[deviceId]?.tasks.find(t => t.sessionId === params.sessionId)?.branch);
    case 'task.diff': return { diff: demoDiff(params.sessionId, params.path), truncated: false };
    case 'task.teamResume': return {};
    case 'task.team': return { team: params?.sessionId === DEMO_TEAM_TASK ? demoTeam(host.now()) : null };
    case 'task.workerMessages': {
      const all = params?.sessionId === DEMO_TEAM_TASK ? demoWorkerMessages(String(params.workerId), host.now()) : [];
      return { messages: all.filter(m => m.id > (Number(params?.afterId) || 0)), hasMore: false, hasOlder: false };
    }
    case 'bots.list': return { bots: s.bots[deviceId] ?? [] };
    case 'bot.thread': {
      const bot = s.bots[deviceId]?.find(b => b.id === params.botId);
      if (!bot) throw new Error('That bot no longer exists.');
      return { sessionId: bot.desktopSession ?? `bot-${bot.id}` };
    }
    case 'bot.message': {
      const bot = s.bots[deviceId]?.find(b => b.id === params.botId);
      if (!bot) throw new Error('That bot no longer exists.');
      const sessionId = bot.desktopSession ?? `bot-${bot.id}`;
      host.set(next => sent(next, deviceId, sessionId, String(params.text ?? ''), host.now()));
      reply(sessionId);
      return { sessionId };
    }
    case 'bot.pause':
      host.set(next => withBot(next, deviceId, params.botId, { paused: !!params.paused, state: params.paused ? 'paused' : 'ready' }));
      return {};
    case 'host.hello': return demoHello();
    default: {
      // Feature methods (src/demo/*.ts); projects.icons is unknown: the demo's one icon is seeded.
      const handler = DEMO_HANDLERS.get(method);
      if (!handler) throw new Error(UNKNOWN_METHOD);
      return handler({ host, deviceId, state: s, reply }, params);
    }
  }
}

/** The core methods demoCall answers itself (the rest answer 'Unknown method.' there). */
const DEMO_CORE: readonly Method[] = ['tasks.list', 'task.messages', 'subscribe', 'providers.list', 'providers.models', 'task.send', 'task.steer', 'task.stop',
  'approval.respond', 'input.respond', 'task.configure', 'task.start', 'task.pull', 'task.pullDetect', 'task.pullDiff', 'task.pullMerge', 'task.changes', 'task.diff',
  'task.teamResume', 'task.team', 'task.workerMessages', 'bots.list', 'bot.thread', 'bot.message', 'bot.pause', 'image.put', 'host.hello'];

/** Core methods any approved phone may call, and those only Full may (the rest need Control),
 * as src-tauri/src/remote/grants.rs classifies them. */
const DEMO_VIEW: ReadonlySet<string> = new Set(['tasks.list', 'task.messages', 'subscribe', 'providers.list', 'providers.models', 'task.pull', 'task.pullDiff',
  'task.changes', 'task.diff', 'task.team', 'task.workerMessages', 'bots.list', 'bot.thread', 'host.hello']);
const DEMO_FULL_ONLY: ReadonlySet<string> = new Set(['task.start', 'task.pullMerge', 'task.teamResume', ...SWITCH_METHODS,
  // Registry methods declared Access::Full in src-tauri/src/remote/methods/*.rs.
  'bot.failoverDecide', 'bot.forget', 'bot.pairingDecide', 'bot.remember', 'bot.runSchedule', 'chat.start', 'checks.run', 'cloudAgents.start', 'files.write', 'git.commit', 'git.push', 'git.switchBranch', 'github.comment', 'github.startTask', 'moodboards.add', 'orchestration.respond', 'projects.clone', 'pull.create', 'pull.review', 'runScript.start', 'runScript.stop', 'schedules.create', 'schedules.delete', 'schedules.update', 'settings.setRouting', 'skills.activate', 'team.start', 'terminal.close', 'terminal.list', 'terminal.open', 'terminal.read', 'terminal.resize', 'terminal.write', 'thread.delete', 'vm.start', 'vm.stop', 'worktree.create', 'worktree.merge', 'worktree.remove']);
/** Feature handlers that only read (a View phone may call them); others need Control. */
const READS = /\.(list|get|detail|status|summary|search|read|messages|info|usage|log|branches|preview|tree|show|diff|frame)$/;

/** The narrowest grant a demo method needs: an approximation of the host's `methodAccess`. */
export function demoMethodAccess(method: string): Access {
  if (DEMO_FULL_ONLY.has(method)) return 'full';
  if (DEMO_VIEW.has(method) || (DEMO_HANDLERS.has(method) && READS.test(method))) return 'view';
  return 'control';
}

/**
 * The demo computer's host.hello, shaped like the real one (src-tauri/src/remote/methods/mod.rs
 * `hello_reply`): its core methods plus every src/demo handler, this phone's grant (`access`,
 * Full by default), each method's narrowest grant (`methodAccess`), the methods gated on the
 * Full access switch (`fullAccessSwitch`) and, while that switch is on, `remoteFullAccess`. So
 * demo mode runs the same gating code (connect/api/capabilities.ts) as a real computer.
 */
export function demoHello(access: Access = 'full', remoteFullAccess = true) {
  const methods = [...DEMO_CORE, ...DEMO_HANDLERS.keys()];
  return {
    protocol: 2, appVersion: 'demo', access,
    methodAccess: Object.fromEntries(methods.map(method => [method, demoMethodAccess(method)])),
    fullAccessSwitch: [...SWITCH_METHODS],
    methods, limits: {}, features: ['demo', ...(remoteFullAccess ? ['remoteFullAccess'] : [])],
  };
}
