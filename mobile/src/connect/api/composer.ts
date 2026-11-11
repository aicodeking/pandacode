// Host calls for the `composer` feature group (src-tauri/src/remote/methods/composer.rs): the slash
// menu, /btw side threads, the host's message queue and agent usage. Declared with
// registerMethods; see docs/remote-access.md, "Adding a method". Pure helpers are in
// ../../store/slash.ts.
import { create } from 'zustand';
import { hostCall, type HostCallOptions } from '../client.ts';
import { registerMethods, type Method } from '../rpc.ts';
import { capabilitiesOf } from './capabilities.ts';
import { runOnce } from './github.ts';
import { taskKey } from '../../store/index.ts';
import { decodeQueue, type ProviderUsage, type QueuedEntry, type SlashCommand, type SlashResolution, type UsageOverview } from '../../store/slash.ts';

registerMethods(['slash.list', 'slash.resolve', 'btw.ask', 'queue.list', 'queue.update', 'queue.remove', 'queue.reorder', 'queue.restore', 'usage.get', 'usage.limits', 'usage.resumeAtReset', 'usage.clearLimit'] as const);

// ---- Once per call ----

/** The host.hello feature of hosts that run a repeated `btw.ask`, `vm.start`, `vm.stop` or
 * `moodboards.add` with the same `sendId` once (host.rs ONCE_METHODS), and refuse a background
 * call still queued past the phone's timeout instead of running it late. */
export const BACKGROUND_SEND_ID = 'backgroundSendId';

/** github.ts `hostCallOnce` for the calls [`BACKGROUND_SEND_ID`] covers: a lost reply is retried
 * under the same `sendId` only where the host dedupes it, so a retry never asks, powers or adds twice. */
export function hostCallBackgroundOnce<T>(deviceId: string, method: Method, params: Record<string, unknown>, options?: HostCallOptions): Promise<T> {
  const caps = capabilitiesOf(deviceId);
  const dedupes = caps?.kind === 'hello' && caps.features.has(BACKGROUND_SEND_ID);
  return runOnce(sendId => hostCall<T>(deviceId, method, sendId ? { ...params, sendId } : params, options), dedupes);
}

// ---- Slash commands ----

export interface SlashCatalog { commands: SlashCommand[]; warnings: string[]; truncated?: boolean }

/** Catalogs per task, kept for the session: discovery on the host can take a few seconds. */
const catalogs = new Map<string, Promise<SlashCatalog>>();

export function slashCommands(deviceId: string, sessionId: string, force = false): Promise<SlashCatalog> {
  const key = taskKey(deviceId, sessionId);
  const cached = catalogs.get(key);
  if (cached && !force) return cached;
  const run = hostCall<SlashCatalog>(deviceId, 'slash.list', { sessionId, force }, { timeoutMs: 30_000 })
    .then(reply => ({ commands: Array.isArray(reply?.commands) ? reply.commands : [], warnings: Array.isArray(reply?.warnings) ? reply.warnings : [], truncated: !!reply?.truncated }));
  catalogs.set(key, run);
  run.catch(() => { if (catalogs.get(key) === run) catalogs.delete(key); });
  return run;
}

export const resolveSlash = (deviceId: string, sessionId: string, text: string) =>
  hostCall<SlashResolution>(deviceId, 'slash.resolve', { sessionId, text }, { timeoutMs: 30_000 });

// ---- /btw ----

/** A side question is a model call; the host's `background_timeout` matches this. */
const BTW_TIMEOUT_MS = 60_000;

export interface BtwLink { sideId: string; seenId: number; title: string }

/** Each main thread's side thread on this phone, as the desktop keeps them in localStorage. */
export const useBtwLinks = create<Record<string, BtwLink>>(() => ({}));

/** Asks on the side of `sessionId`; creates its side thread the first time (or when the old one is gone). */
export async function askBtw(deviceId: string, sessionId: string, text: string): Promise<BtwLink> {
  const key = taskKey(deviceId, sessionId);
  const link = useBtwLinks.getState()[key];
  // Once per question: a lost reply is retried under the same `sendId`, never asked twice.
  const reply = await hostCallBackgroundOnce<{ sideId: string; title: string; seenId: number }>(deviceId, 'btw.ask', { sessionId, text, ...(link && { sideId: link.sideId, seenId: link.seenId }) }, { timeoutMs: BTW_TIMEOUT_MS });
  const next = { sideId: reply.sideId, seenId: Number(reply.seenId) || 0, title: reply.title };
  useBtwLinks.setState({ [key]: next });
  return next;
}

/** "New side thread": the next question starts a fresh one. */
export function forgetBtw(deviceId: string, sessionId: string) {
  const { [taskKey(deviceId, sessionId)]: _gone, ...rest } = useBtwLinks.getState();
  useBtwLinks.setState(() => rest, true);
}

// ---- Queue ----

/** The host queue per task, shared by the composer chip and the Queue screen. */
export const useHostQueues = create<Record<string, QueuedEntry[]>>(() => ({}));

const keep = (deviceId: string, sessionId: string) => (reply: unknown) => {
  const entries = decodeQueue(reply);
  useHostQueues.setState({ [taskKey(deviceId, sessionId)]: entries });
  return entries;
};

export const loadQueue = (deviceId: string, sessionId: string) =>
  hostCall<unknown>(deviceId, 'queue.list', { sessionId }, { background: true }).then(keep(deviceId, sessionId));
export const updateQueued = (deviceId: string, sessionId: string, id: string, text: string) =>
  hostCall<unknown>(deviceId, 'queue.update', { sessionId, id, text }).then(keep(deviceId, sessionId));
export const removeQueued = (deviceId: string, sessionId: string, id: string) =>
  hostCall<unknown>(deviceId, 'queue.remove', { sessionId, id }).then(keep(deviceId, sessionId));
/** Puts back an entry `queue.remove` took out moments ago, exactly as it was (id, text,
 * attachments) at its old place. The host holds removals briefly; a retry is harmless. */
export const restoreRemoved = (deviceId: string, sessionId: string, id: string) =>
  hostCall<unknown>(deviceId, 'queue.restore', { sessionId, id }).then(keep(deviceId, sessionId));
export function reorderQueue(deviceId: string, sessionId: string, ids: string[]) {
  // Shown at once; the host's answer (or a reload after a refusal) settles it.
  const key = taskKey(deviceId, sessionId);
  const before = useHostQueues.getState()[key] ?? [];
  const byId = new Map(before.map(entry => [entry.id, entry]));
  useHostQueues.setState({ [key]: ids.flatMap(id => byId.get(id) ?? []) });
  return hostCall<unknown>(deviceId, 'queue.reorder', { sessionId, ids }).then(keep(deviceId, sessionId), error => {
    useHostQueues.setState({ [key]: before });
    throw error;
  });
}

// ---- Usage ----

export const usageOverview = (deviceId: string, sessionId?: string, refresh = false) =>
  hostCall<UsageOverview>(deviceId, 'usage.get', { ...(sessionId && { sessionId }), refresh }, { timeoutMs: 60_000 });
export const usageLimits = (deviceId: string, provider: string, refresh = false) =>
  hostCall<ProviderUsage>(deviceId, 'usage.limits', { provider, refresh }, { timeoutMs: 45_000 });
export const setResumeAtReset = (deviceId: string, sessionId: string, on: boolean) =>
  hostCall<{ resumeAtReset: boolean; limitedUntil: number | null }>(deviceId, 'usage.resumeAtReset', { sessionId, on });
export const clearUsageLimit = (deviceId: string, sessionId: string) => hostCall<object>(deviceId, 'usage.clearLimit', { sessionId });
