// Bot settings and machines, as the host's `admin` methods send them (src-tauri/src/remote/methods/admin.rs),
// plus the pure logic the Bot settings and Machines screens share. No React, no network: tests/admin.test.ts.

export interface BotProfile {
  id: string; name: string; role: string; avatar: string; color: string; provider: string; model: string; mode: string;
  paused: boolean; heartbeatMinutes: number; nextHeartbeatAt: number | null; projectId: string;
}
/** A chat channel without its config or secrets; `identity` is who it connects as. */
export interface BotChannel { id: string; kind: string; label: string; enabled: boolean; status: string; identity: string }
export interface BotPairing { channelId: string; senderId: string; senderName: string; status: 'pending' | 'approved' | 'blocked' | (string & {}); code?: string; createdAt: number }
export interface BotRule { id: string; pattern: string; decision: string; createdAt: number }
export interface BotSchedule {
  id: string; botId: string; title: string; prompt: string; kind: 'once' | 'interval' | 'daily' | 'weekdays' | (string & {});
  intervalMinutes: number | null; timeOfDay: string | null; nextRunAt: number | null; lastRunAt: number | null; enabled: boolean; createdBy: string;
}
export interface BotMemory { id: string; content: string; source: string; createdAt: number }
/** A message held because the bot's model is unavailable, waiting for Send (on `target`) or Wait. */
export interface FailoverAsk {
  botId: string; sessionId: string; cause: 'limit' | 'provider-error' | (string & {}); provider: string; model: string;
  target: { provider: string; model: string }; resetsAt: number | null;
}
/** How many memories, schedules and rules a bot has, sent instead of the lists to a View phone. */
export interface BotCounts { memories: number; schedules: number; rules: number }
export interface BotDetail {
  bot: BotProfile; channels: BotChannel[]; pairings: BotPairing[]; rules: BotRule[]; schedules: BotSchedule[];
  memories: BotMemory[]; failovers: FailoverAsk[]; truncated: boolean;
  /** A View phone's detail (`limited: true`): memories, schedules and rules come only as `counts`
   * (normalizeDetail always sets both; absent reads as a full detail). */
  limited?: boolean; counts?: BotCounts | null;
}
/** bot.detail's raw reply: a View phone's carries `memoryCount`, `scheduleCount`, `ruleCount`. */
export type RawBotDetail = Partial<BotDetail> & { memoryCount?: unknown; scheduleCount?: unknown; ruleCount?: unknown; limited?: unknown };

export interface VmStatus { name: string; running: boolean; attached: boolean; os: string; memoryMb: number; cpus: number; sizeGb: number; desktop: 'installing' | 'failed' | null; desktopError: string | null }
export interface LinkedComputer { deviceId: string; name: string; platform: string; online: boolean; access: 'read' | 'ask' | 'full' | (string & {}); departed?: boolean }
/** An agent asking the user to link one of their computers (`machine` is the name it suggested). */
export interface LinkRequest { requestId: string; sessionId: string; machine: string | null; reason: string }
export interface AccountComputer { id: string; name: string; platform: string; online: boolean }
export interface MachinesList {
  vms: { supported: boolean; installed: boolean; vms: VmStatus[] };
  orchestration: { enabled: boolean; links: LinkedComputer[] };
  pending: LinkRequest[];
  devices: AccountComputer[];
}
export interface CloudMachine { id: string; provider: string; name: string; state: string; os: string; desktop: boolean; detail: string }
export interface CloudAgent { sessionId: string; title: string; status: string; updatedAt: number; cloud: { provider: string; label: string; machine: string | null; stage: string; detail: string | null } }
export interface RoutingStatus { enabled: boolean; mode: string; minP: number; profiler: string; error: string | null }

export type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'running';

const MINUTE = 60;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** Every list empty: what a malformed or partial reply becomes, so screens never index undefined. */
export function normalizeDetail(raw: RawBotDetail | null | undefined): BotDetail {
  if (!raw?.bot) throw new Error('The computer sent no bot.');
  const list = <T,>(value: T[] | undefined) => (Array.isArray(value) ? value : []);
  const limited = raw.limited === true;
  return {
    bot: raw.bot, channels: list(raw.channels), pairings: list(raw.pairings), rules: list(raw.rules), schedules: list(raw.schedules),
    memories: list(raw.memories), failovers: list(raw.failovers), truncated: !!raw.truncated,
    limited, counts: limited ? { memories: count(raw.memoryCount), schedules: count(raw.scheduleCount), rules: count(raw.ruleCount) } : null,
  };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A limited detail's counts as rows ("3 memories"), in the screen's section order. */
export const countLines = (counts: BotCounts): string[] =>
  [plural(counts.schedules, 'schedule', 'schedules'), plural(counts.rules, 'rule', 'rules'), plural(counts.memories, 'memory', 'memories')];

/** People waiting to be let in, newest first. */
export const pendingPairings = (detail: BotDetail): BotPairing[] =>
  [...detail.pairings.filter(p => p.status === 'pending')].sort((a, b) => b.createdAt - a.createdAt);

/** How many decisions wait on the user: pairings plus held messages. */
export const pendingCount = (detail: BotDetail) => pendingPairings(detail).length + detail.failovers.length;

export function channelTone(channel: BotChannel): Tone {
  if (!channel.enabled) return 'muted';
  const status = channel.status.toLowerCase();
  if (status === 'connected' || status === 'ready' || status === 'listening') return 'success';
  if (status === 'connecting' || status === 'starting' || status === 'reconnecting') return 'running';
  if (status.startsWith('error') || status === 'failed' || status.includes('invalid')) return 'danger';
  return 'warning';
}

const KIND_NAMES: Readonly<Record<string, string>> = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp', web: 'Web chat', imessage: 'iMessage', email: 'Email' };
export const channelName = (channel: Pick<BotChannel, 'kind' | 'label'>) => channel.label || KIND_NAMES[channel.kind] || channel.kind;

export function channelLine(channel: BotChannel): string {
  const state = channel.enabled ? channel.status || 'Unknown' : 'Off';
  return [KIND_NAMES[channel.kind] ?? channel.kind, channel.identity, state.charAt(0).toUpperCase() + state.slice(1)].filter(Boolean).join(' · ');
}

function minutesText(minutes: number): string {
  if (minutes % DAY_MINUTES === 0) return minutes === DAY_MINUTES ? 'day' : `${minutes / DAY_MINUTES} days`;
  if (minutes % HOUR_MINUTES === 0) return minutes === HOUR_MINUTES ? 'hour' : `${minutes / HOUR_MINUTES} h`;
  return `${minutes} min`;
}

/** A bot schedule's cadence in the desktop's words. */
export function botCadence(schedule: Pick<BotSchedule, 'kind' | 'intervalMinutes' | 'timeOfDay'>): string {
  switch (schedule.kind) {
    case 'once': return 'Once';
    case 'interval': return schedule.intervalMinutes ? `Every ${minutesText(schedule.intervalMinutes)}` : 'Repeating';
    case 'daily': return schedule.timeOfDay ? `Daily at ${schedule.timeOfDay}` : 'Daily';
    case 'weekdays': return schedule.timeOfDay ? `Weekdays at ${schedule.timeOfDay}` : 'Weekdays';
    default: return schedule.kind;
  }
}

/** Seconds or ms until `at`, as "in 5 min" / "in 3 h" / "in 2 d"; past times read "due". */
export function untilText(at: number | null, now: number): string {
  if (at === null) return '';
  const minutes = Math.round((at - now) / 1000 / MINUTE);
  if (minutes <= 0) return 'due';
  if (minutes < HOUR_MINUTES) return `in ${minutes} min`;
  if (minutes < DAY_MINUTES) return `in ${Math.round(minutes / HOUR_MINUTES)} h`;
  return `in ${Math.round(minutes / DAY_MINUTES)} d`;
}

export function scheduleLine(schedule: BotSchedule, now: number): string {
  const next = schedule.enabled ? untilText(schedule.nextRunAt, now) : 'Off';
  return [botCadence(schedule), next && (next === 'Off' ? next : `next ${next}`)].filter(Boolean).join(' · ');
}

/** The held message's card text. */
export function failoverLine(ask: FailoverAsk, now: number): string {
  const why = ask.cause === 'limit' ? `${ask.model} hit its usage limit` : `${ask.model} is not answering`;
  const reset = ask.cause === 'limit' && ask.resetsAt ? ` (resets ${untilText(ask.resetsAt, now)})` : '';
  return `${why}${reset}. Send it with ${ask.target.model} instead?`;
}

/** The detail with `memory` added (or kept once, when the desktop answered with an existing one). */
export const withMemory = (detail: BotDetail, memory: BotMemory): BotDetail =>
  ({ ...detail, memories: [...detail.memories.filter(m => m.id !== memory.id), memory] });
export const withoutMemory = (detail: BotDetail, memoryId: string): BotDetail =>
  ({ ...detail, memories: detail.memories.filter(m => m.id !== memoryId) });
export const withoutPairing = (detail: BotDetail, channelId: string, senderId: string): BotDetail =>
  ({ ...detail, pairings: detail.pairings.filter(p => !(p.channelId === channelId && p.senderId === senderId)) });
export const withoutFailover = (detail: BotDetail, sessionId: string): BotDetail =>
  ({ ...detail, failovers: detail.failovers.filter(f => f.sessionId !== sessionId) });

/** What a memory field may send: trimmed, 1–2000 characters. */
export const MAX_MEMORY = 2000;
export const memoryError = (text: string): string =>
  !text.trim() ? 'Write something to remember.' : [...text.trim()].length > MAX_MEMORY ? `Keep it under ${MAX_MEMORY} characters.` : '';

// ---- machines ----

export function vmLine(vm: VmStatus): string {
  const memory = vm.memoryMb >= 1024 ? `${Math.round(vm.memoryMb / 1024)} GB` : vm.memoryMb ? `${vm.memoryMb} MB` : '';
  const state = vm.desktop === 'installing' ? 'Adding a desktop' : vm.desktop === 'failed' ? 'Desktop failed' : vm.running ? 'Running' : 'Stopped';
  return [state, vm.os === 'darwin' ? 'macOS' : vm.os === 'linux' ? 'Linux' : vm.os, vm.cpus ? `${vm.cpus} CPUs` : '', memory].filter(Boolean).join(' · ');
}

/** Running VMs first, then by name. */
export const sortVms = (vms: VmStatus[]) => [...vms].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));

const STAGE_TONES: Readonly<Record<string, Tone>> = {
  running: 'running', ready: 'success', stopped: 'muted', error: 'danger', reconnecting: 'warning',
  creating: 'running', installing: 'running', credentials: 'running', uploading: 'running', syncing: 'running',
};
export const stageTone = (stage: string): Tone => STAGE_TONES[stage] ?? 'muted';

export function agentLine(agent: CloudAgent): string {
  const stage = agent.cloud.stage ? agent.cloud.stage.charAt(0).toUpperCase() + agent.cloud.stage.slice(1) : '';
  return [agent.cloud.label, stage, agent.cloud.detail ?? ''].filter(Boolean).join(' · ');
}

export const cloudTone = (machine: CloudMachine): Tone =>
  machine.state === 'running' ? 'success' : machine.state === 'error' ? 'danger' : machine.state === 'starting' || machine.state === 'stopping' ? 'running' : 'muted';

export const ACCESS_LABELS: Readonly<Record<string, string>> = { read: 'Read only', ask: 'Ask first', full: 'Full access' };

/**
 * Computers an agent's link request may be answered with: the account's other computers, the one the
 * agent named first. Already linked ones stay (re-linking changes nothing).
 */
export function linkChoices(list: MachinesList, request: LinkRequest): AccountComputer[] {
  const named = request.machine?.toLowerCase();
  return [...list.devices].sort((a, b) =>
    Number(b.name.toLowerCase() === named) - Number(a.name.toLowerCase() === named) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export function routingLine(status: RoutingStatus): string {
  if (status.error) return status.error;
  if (!status.enabled) return 'Off';
  const mode = status.mode ? status.mode.charAt(0).toUpperCase() + status.mode.slice(1) : '';
  return [mode, `min. confidence ${Math.round(status.minP * 100)}%`, status.profiler].filter(Boolean).join(' · ');
}

// ---- vm.frame pages ----

export interface FramePage { frameId: string; mime: string; total: number; offset: number; data: string; done: boolean }

/**
 * Joins `vm.frame` pages into a data: URL. `fetch(offset, frameId)` reads one page; pages must belong to one
 * frame and follow each other, else this throws (the screen changed mid-read: load it again).
 */
export async function readFrame(fetch: (offset: number, frameId?: string) => Promise<FramePage>, maxPages = 64): Promise<string> {
  let page = await fetch(0);
  const frameId = page.frameId;
  const parts = [page.data];
  let offset = page.data.length;
  for (let n = 1; !page.done; n++) {
    if (n >= maxPages || !page.data.length) throw new Error('The screenshot is too large.');
    page = await fetch(offset, frameId);
    if (page.frameId !== frameId || page.offset !== offset) throw new Error('The screen changed. Load it again.');
    parts.push(page.data);
    offset += page.data.length;
  }
  return `data:${page.mime};base64,${parts.join('')}`;
}

// ---- Starting a cloud agent (cloudAgents.targets / cloudAgents.start) ----

/** A cloud provider that runs agents; `ready` once it is connected in Settings → Cloud on the computer. */
export interface CloudTarget { provider: string; label: string; ready: boolean }
export interface CloudTargets { providers: CloudTarget[]; harnesses: string[] }
/** What the start form holds; `projectId` is a project on the computer. */
export interface CloudStartForm { provider: string; harness: string; projectId: string; prompt: string; model?: string; mode?: string; effort?: string | null }

/** The desktop's names for the harnesses a cloud machine can run (cloud_agents/setup.rs). */
const HARNESS_LABELS: Record<string, string> = { claude: 'Claude Code', glm: 'GLM', mimo: 'MiMo', codex: 'Codex', opencode: 'OpenCode' };
/** The harness a new form starts with when the host offers it. */
const FIRST_HARNESS = 'claude';
/** The model a phone start asks for: the harness's own default, as the desktop's picker does. */
export const CLOUD_DEFAULT_MODEL = 'default';
/** The desktop refuses a first prompt over 128 KiB; the phone's own text limit is lower. */
export const MAX_CLOUD_PROMPT = 100 * 1024;

export const harnessLabel = (id: string): string => HARNESS_LABELS[id] ?? id;

/** The host's reply with anything malformed dropped. */
export function normalizeTargets(reply: unknown): CloudTargets {
  const raw = (reply ?? {}) as { providers?: unknown; harnesses?: unknown };
  const providers = Array.isArray(raw.providers)
    ? raw.providers.filter((p): p is CloudTarget => !!p && typeof p.provider === 'string' && !!p.provider)
      .map(p => ({ provider: p.provider, label: typeof p.label === 'string' && p.label ? p.label : p.provider, ready: p.ready === true }))
    : [];
  const harnesses = Array.isArray(raw.harnesses) ? raw.harnesses.filter((h): h is string => typeof h === 'string' && !!h) : [];
  return { providers, harnesses };
}

/** A new form: the first connected provider, Claude Code when offered, the first project. */
export function initialCloudForm(targets: CloudTargets, projects: readonly { id: string }[]): CloudStartForm {
  const provider = targets.providers.find(p => p.ready)?.provider ?? '';
  const harness = targets.harnesses.includes(FIRST_HARNESS) ? FIRST_HARNESS : targets.harnesses[0] ?? '';
  return { provider, harness, projectId: projects[0]?.id ?? '', prompt: '' };
}

/** Why Start is off for this form, or null when it can start. */
export function cloudStartIssue(form: CloudStartForm, targets: CloudTargets, computer: string): string | null {
  if (!targets.providers.some(p => p.ready)) return `Connect a cloud provider in Settings → Cloud on ${computer} first.`;
  const provider = targets.providers.find(p => p.provider === form.provider);
  if (!provider) return 'Pick a cloud provider.';
  if (!provider.ready) return `Connect ${provider.label} in Settings → Cloud on ${computer} first.`;
  if (!targets.harnesses.includes(form.harness)) return 'Pick an agent.';
  if (!form.projectId) return `Add a project on ${computer} first.`;
  const prompt = form.prompt.trim();
  if (!prompt) return 'Write what the agent should do.';
  if (new TextEncoder().encode(prompt).length > MAX_CLOUD_PROMPT) return 'Write a message under 100 KB.';
  return null;
}

/** `cloudAgents.start`'s params. The mode is left to the computer, which asks for approvals without its Full access switch. */
export function cloudStartParams(form: CloudStartForm, startId: string) {
  return {
    startId, projectId: form.projectId, provider: form.provider, harness: form.harness, model: form.model || CLOUD_DEFAULT_MODEL, prompt: form.prompt.trim(),
    ...(form.mode ? { mode: form.mode } : {}), ...(form.effort ? { effort: form.effort } : {}),
  };
}

/** Why this phone can't start a cloud agent: the host's own answer for the method, and the Full access switch,
 * which `cloudAgents.start` needs although older hosts don't list it among their switch methods. */
export function cloudStartBlock(blocked: 'outdated' | 'access' | 'switch' | null, remoteFullAccess: boolean | undefined): 'outdated' | 'access' | 'switch' | null {
  return blocked ?? (remoteFullAccess === false ? 'switch' : null);
}

// ---- New task's "Run on" (this computer, or a cloud provider through cloudAgents.start) ----

/** The Run on choice for this computer; a cloud provider's is `cloud:<provider>` (the desktop's ids). */
export const RUN_HERE = 'local';
const CLOUD_PREFIX = 'cloud:';
export const cloudChoice = (provider: string): string => CLOUD_PREFIX + provider;
/** The provider of a Run on choice, or undefined for this computer. */
export const cloudProviderOf = (choice: string): string | undefined => (choice.startsWith(CLOUD_PREFIX) ? choice.slice(CLOUD_PREFIX.length) || undefined : undefined);

/** Run on's options: this computer, then each connected cloud provider (as the desktop's menu lists only those). */
export function runOnChoices(targets: CloudTargets | null): { value: string; label: string }[] {
  const ready = targets?.providers.filter(p => p.ready) ?? [];
  return [{ value: RUN_HERE, label: 'This computer' }, ...ready.map(p => ({ value: cloudChoice(p.provider), label: `Cloud · ${p.label}` }))];
}

/** The connected provider a Run on choice names, or null (this computer, or one no longer connected). */
export function chosenCloud(targets: CloudTargets | null, choice: string): CloudTarget | null {
  const provider = cloudProviderOf(choice);
  return (provider && targets?.providers.find(p => p.provider === provider && p.ready)) || null;
}

/** Why the picked harness can't run on a cloud machine (the desktop's harnessRefusal), or null. */
export function cloudHarnessRefusal(harness: string, targets: CloudTargets | null, name: string): string | null {
  const harnesses = targets?.harnesses ?? [];
  if (harnesses.includes(harness)) return null;
  const names = harnesses.map(harnessLabel);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? 'another agent';
  return `${name} can’t run on a cloud machine yet. Choose ${list}.`;
}

/** A New task's draft as a cloud start: the picked harness, model, mode and effort, as the desktop's sendCloud sends. */
export function cloudTaskForm(draft: { provider: string; harness: string; projectId: string; prompt: string; model: string; mode: string; effort?: string | null }): CloudStartForm {
  return { provider: draft.provider, harness: draft.harness, projectId: draft.projectId, prompt: draft.prompt, model: draft.model, mode: draft.mode, effort: draft.effort ?? null };
}
