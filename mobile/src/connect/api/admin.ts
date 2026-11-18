// Host calls for the `admin` feature group (src-tauri/src/remote/methods/admin.rs): a bot's settings and this
// computer's machines. Reads are View; remember/forget are Control; running a schedule, answering pairings,
// held messages and link requests, starting or stopping a VM and starting a cloud agent are Full.
import type { HostCallOptions } from '../client.ts';
import { capabilitiesOf } from './capabilities.ts';
import { supports } from './hello.ts';
import { followStart, unsentFields, type FollowDeps } from '../start-retry.ts';
import { hostCallOnce } from './github.ts';
import { registerMethods, START_TIMEOUT_MS, type Method } from '../rpc.ts';
import {
  cloudStartParams, normalizeDetail, normalizeTargets, readFrame, type BotDetail, type CloudStartForm, type CloudTargets, type BotMemory, type CloudAgent, type CloudMachine, type FramePage, type MachinesList, type RoutingStatus,
} from '../../store/admin.ts';
import { decodeDeployTargets, type DeployTargetState } from '../../ui/new-task-projects.ts';

// client.ts and composer.ts load on first call (as in github.ts), so the Node tests can import
// this file's pure parts.
const hostCall = async <T>(deviceId: string, method: Method, params: unknown, options?: HostCallOptions): Promise<T> =>
  (await import('../client.ts')).hostCall<T>(deviceId, method, params, options);
const hostCallBackgroundOnce = async <T>(deviceId: string, method: Method, params: Record<string, unknown>, options: HostCallOptions): Promise<T> =>
  (await import('./composer.ts')).hostCallBackgroundOnce<T>(deviceId, method, params, options);

export const ADMIN_METHODS = registerMethods([
  'bot.detail', 'bot.remember', 'bot.forget', 'bot.runSchedule', 'bot.pairingDecide', 'bot.failoverDecide',
  'machines.list', 'cloud.machines', 'cloudAgents.list', 'cloudAgents.targets', 'cloudAgents.start', 'vm.frame', 'vm.start', 'vm.stop', 'orchestration.respond', 'routing.status', 'deploy.targets',
] as const);

export const botDetail = (deviceId: string, botId: string) =>
  hostCall<Partial<BotDetail>>(deviceId, 'bot.detail', { botId }).then(normalizeDetail);

export async function rememberForBot(deviceId: string, botId: string, content: string): Promise<BotMemory> {
  const reply = await hostCall<{ memory?: BotMemory }>(deviceId, 'bot.remember', { botId, content });
  if (!reply?.memory) throw new Error('The computer sent no memory.');
  return reply.memory;
}

export const forgetForBot = (deviceId: string, botId: string, memoryId: string) => hostCall<object>(deviceId, 'bot.forget', { botId, memoryId });
/** Once per call: a lost reply is retried under the same `sendId` (github.ts `runOnce`), never run twice. */
export const runBotSchedule = (deviceId: string, botId: string, scheduleId: string) => hostCallOnce<object>(deviceId, 'bot.runSchedule', { botId, scheduleId });
export type PairingDecision = 'approved' | 'blocked' | 'removed';
export const decidePairing = (deviceId: string, botId: string, channelId: string, senderId: string, decision: PairingDecision) =>
  hostCall<object>(deviceId, 'bot.pairingDecide', { botId, channelId, senderId, decision });
export const decideFailover = (deviceId: string, sessionId: string, action: 'send' | 'wait', always = false) =>
  hostCall<object>(deviceId, 'bot.failoverDecide', { sessionId, action, always });

export async function listMachines(deviceId: string): Promise<MachinesList> {
  const reply = await hostCall<Partial<MachinesList>>(deviceId, 'machines.list', {});
  return {
    vms: { supported: !!reply?.vms?.supported, installed: !!reply?.vms?.installed, vms: Array.isArray(reply?.vms?.vms) ? reply.vms.vms : [] },
    orchestration: { enabled: !!reply?.orchestration?.enabled, links: Array.isArray(reply?.orchestration?.links) ? reply.orchestration.links : [] },
    pending: Array.isArray(reply?.pending) ? reply.pending : [],
    devices: Array.isArray(reply?.devices) ? reply.devices : [],
  };
}

export async function listCloudMachines(deviceId: string): Promise<{ machines: CloudMachine[]; errors: string[] }> {
  const reply = await hostCall<{ machines?: CloudMachine[]; errors?: string[] }>(deviceId, 'cloud.machines', {});
  return { machines: Array.isArray(reply?.machines) ? reply.machines : [], errors: Array.isArray(reply?.errors) ? reply.errors : [] };
}

export const listCloudAgents = (deviceId: string) =>
  hostCall<{ agents?: CloudAgent[] }>(deviceId, 'cloudAgents.list', {}).then(reply => (Array.isArray(reply?.agents) ? reply.agents : []));

export const routingStatus = (deviceId: string) =>
  hostCall<{ routing?: RoutingStatus }>(deviceId, 'routing.status', {}).then(reply => reply?.routing ?? null);

/** Booting or shutting down a VM is slow; the host's `background_timeout` matches this. */
const VM_POWER_TIMEOUT_MS = 60_000;
/** Once per tap: a lost reply is retried under the same `sendId` (composer.ts `hostCallBackgroundOnce`). */
export const powerVm = (deviceId: string, name: string, action: 'start' | 'stop') =>
  hostCallBackgroundOnce<object>(deviceId, action === 'start' ? 'vm.start' : 'vm.stop', { name }, { timeoutMs: VM_POWER_TIMEOUT_MS });

/** The VM's current screen as a data: URL, read page by page. */
export const vmFrame = (deviceId: string, name: string) =>
  readFrame((offset, frameId) => hostCall<FramePage>(deviceId, 'vm.frame', frameId ? { name, offset, frameId } : { name }));

/** Accepts (linking `link.deviceId` with `link.access`) or declines an agent's request to link a computer. */
export const respondToLink = (deviceId: string, requestId: string, link: { deviceId: string; access: 'read' | 'ask' | 'full' } | null) =>
  hostCall<object>(deviceId, 'orchestration.respond', link ? { requestId, accept: true, ...link } : { requestId, accept: false });

/** Cloud providers that run agents (connected or not, no credentials) and the agents a cloud machine can run. */
export const cloudAgentTargets = (deviceId: string): Promise<CloudTargets> =>
  hostCall<unknown>(deviceId, 'cloudAgents.targets', {}).then(normalizeTargets);

/** What starting a cloud agent needs from the computer: the start itself and its status (task.startStatus). */
export type CloudStartDeps = Omit<FollowDeps, 'start' | 'status' | 'maxMs'> & {
  start: (params: Record<string, unknown>) => Promise<{ sessionId?: string; projectId?: string; sent?: boolean; error?: unknown }>;
  status: (startId: string) => ReturnType<FollowDeps['status']>;
};

/** Starts a cloud agent once per `startId` (a retry with the same id answers the first start). The
 * host keys it like task.start, so a lost reply turns into task.startStatus polls (start-retry.ts)
 * instead of a failure. The project is the one the host names, in its direct reply or in the
 * followed start's status (newer hosts), else the form's. */
export async function startCloudAgentWith(deps: CloudStartDeps, form: CloudStartForm, startId: string): Promise<{ sessionId: string; projectId: string; sent?: false; error?: string }> {
  const reply = await followStart({
    start: async () => {
      const sent = await deps.start(cloudStartParams(form, startId));
      if (!sent?.sessionId) throw new Error('The computer sent no task.');
      const project = typeof sent.projectId === 'string' && sent.projectId ? { projectId: sent.projectId } : {};
      return { sessionId: sent.sessionId, ...unsentFields(sent), ...project };
    },
    status: () => deps.status(startId),
    canPoll: deps.canPoll,
    sleep: deps.sleep,
    now: deps.now,
    maxMs: START_TIMEOUT_MS,
  });
  const projectId = typeof reply.projectId === 'string' && reply.projectId ? reply.projectId : form.projectId;
  return { sessionId: reply.sessionId, projectId, ...unsentFields(reply) };
}

/** [`startCloudAgentWith`] against the computer. */
export const startCloudAgent = (deviceId: string, form: CloudStartForm, startId: string) => startCloudAgentWith({
  start: params => hostCall<{ sessionId?: string; projectId?: string; sent?: boolean; error?: unknown }>(deviceId, 'cloudAgents.start', params, { timeoutMs: START_TIMEOUT_MS }),
  status: id => hostCall(deviceId, 'task.startStatus', { startId: id }),
  canPoll: () => supports(capabilitiesOf(deviceId), 'task.startStatus') !== false,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
}, form, startId);

/** Which deploy targets' CLIs the computer has connected (View); a target left out has nothing against it. */
export const deployTargets = (deviceId: string): Promise<DeployTargetState[]> =>
  hostCall<unknown>(deviceId, 'deploy.targets', {}).then(decodeDeployTargets);
