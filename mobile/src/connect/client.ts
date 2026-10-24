// The phone's Connect client: a viewer of tasks on the user's computers (it never hosts).
// Owns the relay socket, the pending calls and the store; screens call `connect.*` and read
// state with the hooks in src/store. See README.md beside this file.
import './polyfill.ts';
import { initialState, taskKey, useConnect, type ConnectState } from '../store/index.ts';
import { chunks, dueIcons, mergeIcons } from '../store/icon-cache.ts';
import { loadIcons, saveIcons, useIcons } from '../store/icons.ts';
import { applyEvent, fromList, fromSubscribe, idleLive, lastId, mergeMessages, staleLists } from '../store/reduce.ts';
import * as auth from './auth.ts';
import { build, NOT_CONFIGURED } from './config.ts';
import { open, pairKey, seal } from './crypto.ts';
import { LOST, NOT_CONNECTED, OFFLINE, Pending, RATE, Replay, request, STALE, START_TIMEOUT_MS, TIMEOUT_MS, type Method } from './rpc.ts';
import * as secrets from './secrets.ts';
import { AppState } from 'react-native';
import { RelaySocket } from './socket.ts';
import type { AgentEvent, ConfigureParams, Device, MessagePage, Provider, ProviderModel, RunFinished, StartParams, SubscribedTask, TasksList } from './types.ts';

const RENEW_MS = 9 * 60_000;
const REFRESH_MS = 12 * 3600_000;
const MAX_FRAME = 256 * 1024;
const MAX_PAGES = 50;
/** Task lists refresh this often while the app is open (faster while a task runs). */
const LIST_IDLE_MS = 60_000;
const LIST_ACTIVE_MS = 15_000;
/** Presence frames come in bursts; a list younger than this is fresh enough. */
const LIST_FRESH_MS = 5_000;

let token: string | null = null;
let secret: Uint8Array | null = null;
let presence = false;
let signInAbort: AbortController | null = null;
let timers: ReturnType<typeof setInterval>[] = [];
/** Per module instance: Fast Refresh re-runs this file with fresh state while the store says ready. */
let initialized = false;
const pending = new Pending();
const inbound = new Replay();
/** Pair keys by device id, with the public key they were derived from. */
const keys = new Map<string, { publicKey: string; key: Uint8Array }>();
/** Tasks the UI has open, per host; subscribed, renewed, and re-subscribed on presence. */
const watched = new Map<string, Set<string>>();
const loads = new Map<string, Promise<void>>();

const state = () => useConnect.getState();
const patch = (update: Partial<ConnectState> | ((s: ConnectState) => Partial<ConnectState>)) => useConnect.setState(update);

const socket = new RelaySocket({
  token: () => token,
  url: () => `${build!.relay.replace(/^https:/, 'wss:')}/v1/connect?host=0`,
  onOpen: () => {
    patch({ connected: true, error: null });
    void refreshIfDue();
    timers = [setInterval(() => void subscribeAll(), RENEW_MS), setInterval(() => void refreshIfDue(), REFRESH_MS), setInterval(pollLists, LIST_ACTIVE_MS)];
  },
  onClose: () => {
    timers.forEach(clearInterval);
    timers = [];
    pending.failAll(LOST);
    patch({ connected: false });
  },
  onText: frame,
  onRefused: (used, revoked) => {
    if (revoked || auth.expired(used)) return signOutIf(used);
    // A WebSocket upgrade hides its HTTP status; ask the API whether the token still works.
    auth.listDevices(used).catch(error => { if (error instanceof auth.SignedOut) signOutIf(error.token); });
  },
});

// In development Fast Refresh re-runs this module whenever it or an import changes: the new
// instance (token unset, socket closed) would serve every call while the old socket still kept
// the store connected, so each new copy failed with NOT_SIGNED_IN. The newest instance closes the
// previous socket, and init() (re-run by the layout's effect) starts this one.
const instances = globalThis as { __pandacodeSocket?: RelaySocket };
instances.__pandacodeSocket?.dispose();
instances.__pandacodeSocket = socket;

/** Reads secrets and connects when signed in. Call once at app start. */
async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const [saved, account, deviceId] = await Promise.all([secrets.getToken(), secrets.getAccount(), secrets.getDeviceId()]);
  secret = await secrets.getSecret();
  // A newer instance took over while this one read secrets: two sockets would replace each other.
  if (instances.__pandacodeSocket !== socket) return;
  token = saved && !auth.expired(saved) && build ? saved : null;
  patch({ ready: true, deviceId, signedIn: !!token, account: token ? account : null });
  if (token) socket.start();
  void secrets.forgetPins();
}

async function signInStart(): Promise<auth.SignInCode> {
  if (!build) throw new Error(NOT_CONFIGURED);
  signInAbort?.abort();
  signInAbort = new AbortController();
  return auth.startSignIn();
}

/** Waits for approval on GitHub and registers this phone. */
async function signInFinish(code: auth.SignInCode): Promise<void> {
  const abort = signInAbort ?? new AbortController();
  const result = await auth.finishSignIn(code, abort.signal);
  if (signInAbort === abort) signInAbort = null;
  token = result.token;
  presence = false;
  patch({ signedIn: true, account: result.account, deviceId: result.deviceId, error: null });
  socket.stop();
  socket.start();
}

function signInCancel() {
  signInAbort?.abort();
  signInAbort = null;
}

async function signOut(): Promise<void> {
  socket.stop();
  pending.failAll('Signed out.');
  token = null;
  keys.clear();
  watched.clear();
  presence = false;
  await secrets.clearSession();
  const { deviceId, ready } = state();
  useConnect.setState({ ...initialState(), deviceId, ready }, true);
}

/** A refusal signs out only if it refused the token that is still current. */
function signOutIf(used: string) {
  if (token !== used) return;
  void signOut().then(() => patch({ error: auth.SIGNED_OUT }));
}

async function refreshIfDue() {
  const old = token;
  if (!old || !auth.needsRefresh(old)) return;
  try {
    const fresh = await auth.refreshToken(old);
    if (!fresh || token !== old) return;
    token = fresh;
    await secrets.setToken(fresh);
  } catch (error) {
    if (error instanceof auth.SignedOut) signOutIf(error.token);
  }
}

// ---- Devices ----

const validDevice = (d: any): d is Device =>
  d && typeof d.id === 'string' && /^[\x21-\x7e]{1,200}$/.test(d.id) && typeof d.name === 'string' && typeof d.publicKey === 'string';

/** Every device signed in to the same GitHub account is the user's: presence is the whole list. */
function applyDevices(list: unknown[]) {
  const devices = list.filter(validDevice).slice(0, 64);
  for (const id of keys.keys()) if (!devices.some(d => d.id === id && d.publicKey === keys.get(id)!.publicKey)) keys.delete(id);
  for (const id of watched.keys()) if (!devices.some(d => d.id === id)) watched.delete(id);
  patch({ devices });
}

/** The device list over HTTP; only needed before the socket's first presence frame. */
async function refreshDevices(): Promise<void> {
  if (!token || presence) return;
  const used = token;
  try {
    const devices = await auth.listDevices(used);
    if (!presence) applyDevices(devices);
  } catch (error) {
    if (error instanceof auth.SignedOut) signOutIf(error.token);
    throw error;
  }
}

async function revokeDevice(deviceId: string): Promise<void> {
  if (!token) throw new Error(NOT_SIGNED_IN);
  const used = token;
  await auth.revokeDevice(used, deviceId).catch(error => {
    if (error instanceof auth.SignedOut) signOutIf(error.token);
    throw error;
  });
  if (deviceId === state().deviceId) return signOut();
}

// ---- Calls ----

/** Thrown by calls made while the token is still loading or after sign-out; screens don't show it. */
export const NOT_SIGNED_IN = 'Sign in to PandaCode Connect first.';

function callable(deviceId: string): Device {
  if (!token) throw new Error(NOT_SIGNED_IN);
  const s = state();
  if (deviceId === s.deviceId) throw new Error('That is this phone.');
  const device = s.devices.find(d => d.id === deviceId);
  if (!device) throw new Error('That computer is no longer on your account.');
  if (!device.online) throw new Error(OFFLINE);
  return device;
}

function pairFor(device: Device): Uint8Array {
  const cached = keys.get(device.id);
  if (cached?.publicKey === device.publicKey) return cached.key;
  const key = pairKey(secret!, state().deviceId, device.publicKey, device.id);
  keys.set(device.id, { publicKey: device.publicKey, key });
  return key;
}

async function call<T>(deviceId: string, method: Method, params: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const device = callable(deviceId);
  const message = request(method, params);
  const body = seal(pairFor(device), state().deviceId, device.id, JSON.stringify(message));
  const frame = JSON.stringify({ to: device.id, body, ref: message.id });
  if (frame.length > MAX_FRAME) throw new Error('That request is too large.');
  const reply = pending.wait(device.id, message.id, timeoutMs);
  if (!socket.send(frame)) pending.fail(device.id, message.id, NOT_CONNECTED);
  return reply as Promise<T>;
}

// ---- Incoming frames ----

function frame(text: string) {
  let value: any;
  try { value = JSON.parse(text); } catch { return; }
  switch (value?.kind) {
    case 'presence':
      if (!Array.isArray(value.devices)) return;
      presence = true;
      applyDevices(value.devices);
      void subscribeAll();
      void refreshLists(LIST_FRESH_MS);
      return;
    case 'undeliverable':
      if (typeof value.to === 'string') pending.fail(value.to, typeof value.ref === 'string' ? value.ref : undefined, value.reason === 'rate' ? RATE : OFFLINE);
      return;
    case 'error':
      patch({ error: typeof value.error === 'string' ? `Relay: ${value.error.slice(0, 300)}` : 'The relay reported an error.' });
      return;
  }
  const { from, to, body } = value ?? {};
  const s = state();
  if (typeof from !== 'string' || typeof body !== 'string' || to !== s.deviceId || from === s.deviceId) return;
  const device = s.devices.find(d => d.id === from);
  // Only a device presence lists may answer or send events, opened with the key it lists now.
  if (!device?.publicKey) return;
  let message: any;
  try { message = JSON.parse(open(pairFor(device), from, to, body)); } catch { return; }
  // Replies and events carry ts + nonce: a stale or repeated one (or an older host's) is dropped.
  if ((message?.type === 'res' || message?.type === 'event') && !inbound.check(message.ts, message.nonce)) {
    if (message.type === 'res') pending.resolve(from, { id: message.id, ok: false, error: STALE });
    return;
  }
  if (message?.type === 'res') pending.resolve(from, message);
  else if (message?.type === 'event' && message.name === 'agent.events') events(from, message.data?.events);
  else if (message?.type === 'event' && message.name === 'run.finished') void finished(from, message.data);
}

function events(host: string, list: unknown) {
  const ids = watched.get(host);
  if (!ids || !Array.isArray(list)) return;
  patch(s => {
    const live = { ...s.live };
    for (const event of list as AgentEvent[]) {
      if (typeof event?.sessionId !== 'string' || typeof event.kind !== 'string' || !ids.has(event.sessionId)) continue;
      const key = taskKey(host, event.sessionId);
      live[key] = applyEvent(live[key] ?? idleLive(), { ...event, text: typeof event.text === 'string' ? event.text : '' });
    }
    return { live, tasks: withStatuses(s, host, live) };
  });
}

/** Mirrors live statuses into the host's task list. */
function withStatuses(s: ConnectState, host: string, live: ConnectState['live']): ConnectState['tasks'] {
  const list = s.tasks[host];
  if (!list) return s.tasks;
  let changed = false;
  const tasks = list.tasks.map(t => {
    const status = live[taskKey(host, t.sessionId)]?.status;
    if (!status || status === t.status) return t;
    changed = true;
    return { ...t, status };
  });
  // Unchanged → same object, so a streamed delta doesn't re-render task lists.
  return changed ? { ...s.tasks, [host]: { ...list, tasks } } : s.tasks;
}

async function finished(host: string, data: RunFinished) {
  if (typeof data?.sessionId !== 'string') return;
  void listTasks(host).catch(() => undefined); // titles, statuses and order
  if (!watched.get(host)?.has(data.sessionId)) return;
  await loadMessages(host, data.sessionId).catch(() => undefined); // the next subscribe retries
  const key = taskKey(host, data.sessionId);
  const status = data.stopped ? 'stopped' : data.successful ? 'idle' : 'failed';
  patch(s => {
    const live = { ...s.live, [key]: { ...idleLive(), status } };
    return { live, tasks: withStatuses(s, host, live) };
  });
}

// ---- Subscriptions and messages ----

/** Keeps these tasks' events and messages flowing while the UI shows them. */
function watch(deviceId: string, sessionIds: string[]) {
  const ids = watched.get(deviceId) ?? new Set();
  const before = ids.size;
  sessionIds.forEach(id => ids.add(id));
  watched.set(deviceId, ids);
  if (ids.size !== before) void subscribeHost(deviceId);
}

function unwatch(deviceId: string, sessionIds: string[]) {
  const ids = watched.get(deviceId);
  sessionIds.forEach(id => ids?.delete(id));
  if (ids && !ids.size) watched.delete(deviceId);
}

async function subscribeAll() {
  await Promise.all([...watched.keys()].map(subscribeHost));
}

/** Subscribe replies catch up on missed status changes, pending requests and messages. */
async function subscribeHost(deviceId: string): Promise<void> {
  const ids = [...(watched.get(deviceId) ?? [])].slice(0, 500);
  if (!ids.length || !socket.open) return;
  let reply: { tasks: SubscribedTask[] };
  try {
    reply = await call(deviceId, 'subscribe', { sessionIds: ids });
  } catch {
    return; // offline; the next presence frame or renewal retries
  }
  const tasks = Array.isArray(reply?.tasks) ? reply.tasks : [];
  patch(s => {
    const live = { ...s.live };
    for (const t of tasks) live[taskKey(deviceId, t.sessionId)] = fromSubscribe(live[taskKey(deviceId, t.sessionId)] ?? idleLive(), t.status, t.pending);
    return { live, tasks: withStatuses(s, deviceId, live) };
  });
  for (const t of tasks) if (t.lastId > lastId(state().messages[taskKey(deviceId, t.sessionId)])) void loadMessages(deviceId, t.sessionId).catch(() => undefined);
}

/** Copies messages newer than the last stored one, following hasMore. Calls run one at a time per task. */
function loadMessages(deviceId: string, sessionId: string): Promise<void> {
  const key = taskKey(deviceId, sessionId);
  const run = async () => {
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterId = lastId(state().messages[key]);
      const reply = await call<MessagePage>(deviceId, 'task.messages', { sessionId, afterId });
      const messages = Array.isArray(reply?.messages) ? reply.messages : [];
      patch(s => ({ messages: { ...s.messages, [key]: mergeMessages(s.messages[key] ?? [], messages) }, tasks: withTitle(s, deviceId, sessionId, reply?.title) }));
      if (!reply?.hasMore || !messages.length) return;
    }
  };
  const next = (loads.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  loads.set(key, next);
  const settle = (error: string | null) => {
    if (loads.get(key) !== next) return; // a later copy owns the state now
    loads.delete(key);
    patch(s => {
      const { [key]: _, ...history } = s.history;
      return { history: error === null ? history : { ...history, [key]: error } };
    });
  };
  patch(s => ({ history: { ...s.history, [key]: null } }));
  return next.then(() => settle(null), (error: Error) => {
    settle(error?.message || 'Could not load this task.');
    throw error;
  });
}

function withTitle(s: ConnectState, host: string, sessionId: string, title: unknown): ConnectState['tasks'] {
  const list = s.tasks[host];
  if (!list || typeof title !== 'string' || !title) return s.tasks;
  return { ...s.tasks, [host]: { ...list, tasks: list.tasks.map(t => (t.sessionId === sessionId && t.title !== title ? { ...t, title } : t)) } };
}

// ---- Typed methods ----

async function listTasks(deviceId: string, limit?: number): Promise<TasksList> {
  const reply = await call<TasksList>(deviceId, 'tasks.list', limit === undefined ? {} : { limit });
  const list = { tasks: Array.isArray(reply?.tasks) ? reply.tasks : [], projects: Array.isArray(reply?.projects) ? reply.projects : [] };
  patch(s => {
    // A task already waiting can be answered as soon as it opens; a run that ended while the
    // phone wasn't listening stops showing as working.
    const live = { ...s.live };
    for (const t of list.tasks) {
      const key = taskKey(deviceId, t.sessionId);
      const next = fromList(live[key], t.status, Array.isArray(t.pending) ? t.pending : undefined);
      if (next) live[key] = next;
    }
    return { live, tasks: { ...s.tasks, [deviceId]: { ...list, loadedAt: Date.now() } } };
  });
  void projectIcons(deviceId, list.tasks.map(t => t.projectId));
  return list;
}

/** Lists the tasks of every online host whose list is older than `maxAgeMs`; failures wait for the next refresh. */
async function refreshLists(maxAgeMs = 0): Promise<void> {
  const s = state();
  if (!token || !socket.open || AppState.currentState !== 'active') return;
  const hosts = s.devices.filter(d => d.host && d.online && d.id !== s.deviceId).map(d => d.id);
  const loadedAt = Object.fromEntries(Object.entries(s.tasks).map(([id, list]) => [id, list.loadedAt]));
  await Promise.all(staleLists(hosts, loadedAt, Date.now(), maxAgeMs).map(id => listTasks(id).catch(() => undefined)));
}

/** Every LIST_ACTIVE_MS tick: lists refresh at that pace while a task runs, else every LIST_IDLE_MS. */
function pollLists() {
  const running = Object.values(state().live).some(l => l.status === 'running' || l.status === 'waiting');
  void refreshLists(running ? LIST_ACTIVE_MS - 1000 : LIST_IDLE_MS - 1000);
}

// Back in the foreground: catch up on lists and subscriptions (a socket that stayed open
// gets no presence frame; one that closed reconnects and catches up on presence).
AppState.addEventListener('change', next => {
  if (next !== 'active' || !socket.open) return;
  void refreshLists(LIST_FRESH_MS);
  void subscribeAll();
});

/** Hosts that answered 'Unknown method.' (older desktops): not asked again this session. */
const noIcons = new Set<string>();
const iconsAsking = new Set<string>();

/** Fetches the icons of these projects that are new or a day old, in batches; failures wait for the next call. */
async function projectIcons(deviceId: string, projectIds: string[]): Promise<void> {
  await loadIcons();
  if (noIcons.has(deviceId)) return;
  const due = dueIcons(useIcons.getState().cache, deviceId, projectIds, Date.now()).filter(id => !iconsAsking.has(`${deviceId}/${id}`));
  if (!due.length) return;
  due.forEach(id => iconsAsking.add(`${deviceId}/${id}`));
  try {
    for (const batch of chunks(due)) {
      const reply = await call<{ icons?: unknown }>(deviceId, 'projects.icons', { projectIds: batch });
      useIcons.setState(s => ({ cache: mergeIcons(s.cache, deviceId, batch, reply?.icons, Date.now()) }));
    }
  } catch (error) {
    if ((error as Error).message === 'Unknown method.') noIcons.add(deviceId);
  } finally {
    due.forEach(id => iconsAsking.delete(`${deviceId}/${id}`));
    void saveIcons();
  }
}

async function listProviders(deviceId: string, force = false): Promise<Provider[]> {
  const providers = await call<Provider[]>(deviceId, 'providers.list', { force });
  patch(s => ({ providers: { ...s.providers, [deviceId]: providers } }));
  return providers;
}

async function listModels(deviceId: string, provider: string, force = false): Promise<ProviderModel[]> {
  const models = await call<ProviderModel[]>(deviceId, 'providers.models', { provider, force });
  patch(s => ({ models: { ...s.models, [`${deviceId}/${provider}`]: models } }));
  return models;
}

/** Starts a task on the host (repo OR projectId) and watches it. */
async function startTask(deviceId: string, params: StartParams): Promise<string> {
  if (!params.repo === !params.projectId) throw new Error('Choose a repository or a project.');
  const { sessionId } = await call<{ sessionId: string }>(deviceId, 'task.start', params, START_TIMEOUT_MS);
  watch(deviceId, [sessionId]);
  patch(s => ({ live: { ...s.live, [taskKey(deviceId, sessionId)]: { ...idleLive(), status: 'running', activity: 'Starting' } } }));
  return sessionId;
}

const sendMessage = (deviceId: string, sessionId: string, text: string) => call<{ queued: boolean }>(deviceId, 'task.send', { sessionId, text });
const stopTask = (deviceId: string, sessionId: string) => call<object>(deviceId, 'task.stop', { sessionId });
const steerTask = (deviceId: string, sessionId: string, text: string) => call<object>(deviceId, 'task.steer', { sessionId, text });
const configureTask = (deviceId: string, params: ConfigureParams) => call<object>(deviceId, 'task.configure', params);
/** An answered request leaves the live view at once, as on the desktop. */
async function answered(deviceId: string, sessionId: string, requestId: string, kind: 'approval_cancelled' | 'input_cancelled', reply: Promise<object>) {
  await reply;
  events(deviceId, [{ sessionId, kind, text: '', requestId }]);
  return {};
}
const respondApproval = (deviceId: string, sessionId: string, requestId: string, approve: boolean) =>
  answered(deviceId, sessionId, requestId, 'approval_cancelled', call(deviceId, 'approval.respond', { sessionId, requestId, approve }));
const respondInput = (deviceId: string, sessionId: string, requestId: string, response: unknown) =>
  answered(deviceId, sessionId, requestId, 'input_cancelled', call(deviceId, 'input.respond', { sessionId, requestId, response }));

export const connect = {
  init, signInStart, signInFinish, signInCancel, signOut,
  refreshDevices, revokeDevice,
  watch, unwatch, loadMessages,
  listTasks, refreshLists, listProviders, listModels, startTask, projectIcons,
  sendMessage, stopTask, steerTask, configureTask, respondApproval, respondInput,
};
