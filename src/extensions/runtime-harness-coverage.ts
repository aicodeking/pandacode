// Run coverage and harness capabilities (runtime phase R5, slice R0509): the webview twin of
// src-tauri/src/extensions/runtime_harness_coverage.rs.
//
// The native side traces every launch path to the seam that starts the turn and the seam that reports its events,
// classifies each turn's `HookRun` (kind, trigger, executor and whose run it is), counts launches and reported hook
// occurrences while a hook is attached, and answers `panda.harnesses.list` (under `harnesses.inventory`): per harness
// and mode, the source and coverage `tool.before` has today, what else is feasible, and a qualification for every
// cell (`sourceFeasible`, `recorded`, `installedQualified`, `unsupported`), never a bare yes or no. This file mirrors
// those rules so the preview, the spec and the native tests agree on one fixture
// (tests/fixtures/extensions/runtime-harness-coverage/). It runs no harness and reads no store.
import { builtinSupport, can, providerSupport, type HookPayloads, type Json, type Support } from './runtime-hook-payload.ts';
import { DELIVERED, RUN_KINDS, type HookRegistry, type Occurrence, type RunFacts } from './runtime-hook-registration.ts';

type Obj = { [key: string]: Json };

export const SCHEMA_VERSION = 1;
export const PERMISSION = 'harnesses.inventory';
export const MODES = ['ask', 'auto', 'review', 'plan', 'full'] as const;
export const QUALIFICATIONS = ['sourceFeasible', 'recorded', 'installedQualified', 'unsupported'] as const;
export const SOURCES = ['companion', 'askAtHost', 'permissionRequest', 'hostTool', 'activity'] as const;
export const COVERAGES = ['everyCall', 'askedCalls', 'escalationsOnly', 'afterOnly', 'none'] as const;
export const TRIGGERS = ['user', 'package', 'tool', 'team', 'council', 'bot', 'schedule', 'remote', 'cloud', 'mirror'] as const;
export type Qualification = typeof QUALIFICATIONS[number];
export type Coverage = typeof COVERAGES[number];

const CLAUDE = ['claude', 'glm', 'mimo', 'alibaba'];
const ACP = ['kimi', 'opencode', 'antigravity', 'grok', 'deepseek', 'commandcode', 'cline', 'kilo', 'github-copilot', 'devin', 'hermes', 'cursor'];
/** Harnesses whose permission-request and tool frames are recorded in the repository's protocol tests. */
export const RECORDED = ['claude', 'glm', 'mimo', 'alibaba', 'codex', 'kimi', 'pi'];
/** `[harness, path]` pairs qualified by an authorized capture on an installed harness. None exists. */
export const INSTALLED_QUALIFIED: readonly (readonly [string, string])[] = [];
/** The built-in roster (`PROVIDERS` in providers.rs). */
export const BUILT_INS: readonly (readonly [string, string])[] = [
  ['claude', 'Claude Code'], ['codex', 'Codex'], ['kimi', 'Kimi Code'], ['opencode', 'OpenCode'], ['glm', 'GLM Coding Plan'], ['antigravity', 'Antigravity'],
  ['grok', 'Grok Build'], ['mimo', 'MiMo Token Plan'], ['alibaba', 'Alibaba Token Plan'], ['pi', 'Pi'], ['deepseek', 'DeepSeek'], ['commandcode', 'Command Code'],
  ['cline', 'Cline'], ['kilo', 'Kilo Code'], ['omp', 'Oh My Pi'], ['github-copilot', 'GitHub Copilot CLI'], ['muse', 'Muse Code'], ['devin', 'Devin CLI'],
  ['zcode', 'ZCode'], ['hermes', 'Hermes Agent'], ['cursor', 'Cursor CLI'],
];

// ---- Launch scope and classification -------------------------------------------------------------------------------

export type LaunchOrigin = { schedule: { schedule: string } } | { tool: { parent: string; tool: string } } | { remote: { device: string } };
export interface LaunchFacts { worker?: boolean; parent?: string; workerId?: string; councilLens?: string; bot?: string; cloud?: boolean; package?: string; executor?: string }

/** The `HookRun` of a turn, by the native precedence: worker, bot workspace, schedule, paired device, cloud, tool, package, user. */
export function classify(facts: LaunchFacts, origin: LaunchOrigin | null): Obj {
  const byOrigin = (fallback: string): string => origin && 'schedule' in origin ? 'schedule' : origin && 'remote' in origin ? 'remote' : origin && 'tool' in origin ? 'tool' : facts.package ? 'package' : fallback;
  let kind: string; let trigger: string;
  if (facts.worker) { kind = 'worker'; trigger = facts.councilLens ? 'council' : 'team'; }
  else if (facts.bot) { kind = 'bot'; trigger = byOrigin('bot'); }
  else if (origin && 'schedule' in origin) { kind = 'schedule'; trigger = 'schedule'; }
  else if (origin && 'remote' in origin) { kind = 'remote'; trigger = 'remote'; }
  else if (facts.cloud) { kind = 'remote'; trigger = byOrigin('cloud'); }
  else if (origin && 'tool' in origin) { kind = 'task'; trigger = 'tool'; }
  else { kind = 'task'; trigger = byOrigin('user'); }
  const run: Obj = { kind, trigger, executor: facts.cloud ? 'cloud' : facts.executor ?? 'desktop' };
  if (facts.worker) {
    if (facts.parent) run.parentTaskId = facts.parent;
    if (facts.workerId) run.workerId = facts.workerId;
    if (facts.councilLens) run.lens = facts.councilLens;
  }
  if (facts.bot && !facts.worker) run.botId = facts.bot;
  if (origin && kind !== 'worker') {
    if ('schedule' in origin) run.scheduleId = origin.schedule.schedule;
    else if ('remote' in origin) run.deviceId = origin.remote.device;
    else { run.parentTaskId = origin.tool.parent; run.tool = origin.tool.tool; }
  }
  if (facts.package && trigger === 'package') run.package = facts.package;
  return run;
}
export const mirrorRun = (host: string): Obj => ({ kind: 'remote', trigger: 'mirror', executor: 'remote', hostId: host });

// ---- Counters ----------------------------------------------------------------------------------------------------

/** Launches by run kind and trigger, occurrences by run kind, event and source (`host` without one). */
export class Tally {
  private launches = new Map<string, Map<string, number>>();
  private events = new Map<string, Map<string, Map<string, number>>>();
  launch(run: Obj): void {
    const kind = typeof run.kind === 'string' ? run.kind : 'task';
    const trigger = typeof run.trigger === 'string' ? run.trigger : 'user';
    const triggers = this.launches.get(kind) ?? new Map(); this.launches.set(kind, triggers);
    triggers.set(trigger, (triggers.get(trigger) ?? 0) + 1);
  }
  event(kind: string, event: string, payload: Obj): void {
    const source = typeof payload.source === 'string' ? payload.source : 'host';
    const byEvent = this.events.get(kind) ?? new Map(); this.events.set(kind, byEvent);
    const bySource = byEvent.get(event) ?? new Map(); byEvent.set(event, bySource);
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  observe(occurrence: Occurrence): void { this.event(occurrence.run, occurrence.event, occurrence.payload); }
  json(): Obj {
    const sorted = <T>(map: Map<string, T> | undefined, value: (item: T) => Json): Obj => Object.fromEntries([...(map ?? new Map<string, T>()).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, value(item)]));
    const out: Obj = {};
    for (const kind of RUN_KINDS) {
      const triggers = this.launches.get(kind);
      out[kind] = {
        launches: [...(triggers?.values() ?? [])].reduce((sum, count) => sum + count, 0),
        triggers: sorted(triggers, count => count),
        events: sorted(this.events.get(kind), bySource => sorted(bySource, count => count)),
      };
    }
    return out;
  }
}

// ---- Harness capabilities ----------------------------------------------------------------------------------------

export interface Harness { id: string; name: string; package: string | null; installed: 'Installed' | 'Absent' | 'Unknown' }

function family(harness: Harness): string {
  if (harness.package !== null) return 'package';
  if (CLAUDE.includes(harness.id)) return 'claude';
  if (ACP.includes(harness.id)) return 'acp';
  return ({ codex: 'codex', pi: 'pi', omp: 'pi', muse: 'muse', zcode: 'zcode' } as Record<string, string>)[harness.id] ?? 'unknown';
}
const installedQualified = (id: string, path: string) => INSTALLED_QUALIFIED.some(([harness, qualified]) => harness === id && qualified === path);
const recorded = (harness: Harness) => harness.package !== null || RECORDED.includes(harness.id);
const qualify = (harness: Harness, path: string, isRecorded: boolean): Qualification => installedQualified(harness.id, path) ? 'installedQualified' : isRecorded ? 'recorded' : 'sourceFeasible';

export const modes = (harness: Harness): string[] => family(harness) === 'claude' ? [...MODES] : ['ask', 'auto', 'plan', 'full'];

/** What a permission request covers in `mode`. */
export function requestCoverage(harness: Harness, mode: string): Coverage {
  const id = harness.id; const kind = family(harness);
  if (kind === 'package') return 'askedCalls';
  if (kind === 'claude') return mode === 'full' ? 'escalationsOnly' : 'askedCalls';
  if (id === 'codex') return mode === 'ask' || mode === 'auto' ? 'escalationsOnly' : 'none';
  if ((id === 'kimi' || id === 'commandcode') && mode === 'auto') return 'escalationsOnly';
  if ((id === 'opencode' || id === 'kilo') && mode === 'plan') return 'escalationsOnly';
  if (['commandcode', 'pi', 'omp'].includes(id) && mode === 'plan') return 'none';
  if (id === 'antigravity') return 'askedCalls';
  if ((id === 'deepseek' && mode === 'full') || (id === 'muse' && (mode === 'plan' || mode === 'full'))) return 'none';
  if (['deepseek', 'muse', 'devin'].includes(id)) return 'escalationsOnly';
  if (id === 'zcode' && mode === 'full') return 'escalationsOnly';
  if (mode === 'full') return 'none';
  return 'askedCalls';
}
function companion(harness: Harness): [string, string] {
  const kind = family(harness);
  if (kind === 'claude') return ['sourceFeasible', 'hook callbacks registered in the initialize control request'];
  switch (harness.id) {
    case 'codex': return ['sourceFeasible', 'hook declarations in the session configuration, trusted for the session'];
    case 'opencode': return ['sourceFeasible', 'a plugin named in the inline configuration (V1 file or V2 directory by version)'];
    case 'kilo': return ['sourceFeasible', 'a V1 plugin named in the inline configuration'];
    case 'pi': case 'omp': return ['sourceFeasible', 'the bridge extension PandaCode already loads, consulting the host'];
    case 'cline': return ['unknown', ''];
    default: return ['none', ''];
  }
}
const askAtHost = (harness: Harness): Coverage | null => harness.package === null && ['opencode', 'kilo', 'cline', 'kimi', 'grok', 'commandcode', 'github-copilot', 'hermes', 'zcode'].includes(harness.id) ? 'askedCalls' : null;
const inputComplete = (harness: Harness) => ['claude', 'acp', 'package'].includes(family(harness));
const toolServers = (harness: Harness) => !['zcode', 'package'].includes(family(harness));
function compact(harness: Harness): [string, Qualification] {
  const kind = family(harness);
  if (kind !== 'package' && harness.id === 'codex') return ['request', 'recorded'];
  if (kind === 'claude' || (kind === 'acp' && harness.id === 'kimi')) return ['command', 'recorded'];
  if (kind === 'acp') return ['command', 'sourceFeasible'];
  return ['none', 'unsupported'];
}
const compactionSeen = (harness: Harness) => ['claude', 'codex'].includes(family(harness));
function compactionCan(harness: Harness): string[] {
  const kind = family(harness);
  if (kind === 'claude') return ['instructions', 'cancel'];
  if (kind === 'codex') return ['cancel'];
  if (kind === 'pi') return ['summary', 'instructions', 'cancel'];
  if (kind === 'acp' && harness.id === 'opencode') return ['summary'];
  return [];
}
function rewriteResult(harness: Harness): string {
  const kind = family(harness);
  if (kind === 'claude' || kind === 'pi' || (kind === 'acp' && (harness.id === 'opencode' || harness.id === 'kilo'))) return 'replace';
  return kind === 'codex' ? 'feedback' : 'none';
}
const evidence = (harness: Harness) => recorded(harness) ? 'frame' : harness.package === null && (harness.id === 'opencode' || harness.id === 'kilo') ? 'spike' : 'documentation';
const support = (harness: Harness): Support => harness.package !== null ? providerSupport(null) : builtinSupport(harness.id);

function beforeCell(harness: Harness, mode: string): Obj {
  const coverage = requestCoverage(harness, mode);
  const cell: Obj = coverage === 'none'
    ? { source: null, coverage: 'none', can: [], sourceCan: [], qualification: 'unsupported' }
    : { source: 'permissionRequest', coverage, can: [], sourceCan: can(support(harness)), qualification: qualify(harness, `toolBefore.permissionRequest.${mode}`, recorded(harness)) };
  const feasible: Obj[] = [];
  if (companion(harness)[0] === 'sourceFeasible') feasible.push({ source: 'companion', coverage: 'everyCall', qualification: installedQualified(harness.id, `toolBefore.companion.${mode}`) ? 'installedQualified' : 'sourceFeasible' });
  const ask = askAtHost(harness);
  if (mode === 'full' && coverage !== 'askedCalls' && ask) feasible.push({ source: 'askAtHost', coverage: ask, qualification: 'sourceFeasible' });
  cell.feasible = feasible;
  return cell;
}

/** One `HarnessCapabilities` row, field for field the native one. */
export function row(harness: Harness): Obj {
  const [state, mechanism] = companion(harness);
  const answer = support(harness);
  const [how, compactQualification] = compact(harness);
  const seen = compactionSeen(harness);
  const rewrite = rewriteResult(harness);
  const canCompact = compactionCan(harness);
  const out: Obj = {
    schemaVersion: SCHEMA_VERSION, id: harness.id, name: harness.name, kind: harness.package !== null ? 'package' : 'builtin', installed: harness.installed,
    modes: modes(harness), evidence: evidence(harness),
    toolServers: { value: toolServers(harness), qualification: !toolServers(harness) ? 'unsupported' : recorded(harness) ? 'recorded' : 'sourceFeasible' },
    compact: { how, qualification: compactQualification },
    denyReason: answer.denyReason, rewriteInput: answer.rewriteInput,
    companion: { state, mechanism: mechanism || null, qualification: state === 'sourceFeasible' ? 'sourceFeasible' : 'unsupported' },
    hooks: {
      toolBefore: Object.fromEntries(modes(harness).map(mode => [mode, beforeCell(harness, mode)])),
      toolAfter: {
        source: 'activity', coverage: 'afterOnly', rewriteResult: 'none', inputComplete: inputComplete(harness),
        qualification: qualify(harness, 'toolAfter.activity', recorded(harness)),
        feasible: rewrite === 'none' ? [] : [{ source: 'companion', rewriteResult: rewrite, qualification: 'sourceFeasible' }],
      },
      hostTools: { delivered: { source: 'activity', coverage: 'afterOnly' }, feasible: toolServers(harness) ? { source: 'hostTool', coverage: 'everyCall', qualification: 'sourceFeasible' } : null },
      promptSubmit: { source: 'host', can: [], qualification: 'recorded' },
      turn: { source: 'host', qualification: 'recorded' },
      compaction: {
        phase: seen ? 'after' : 'none', can: [], qualification: seen ? qualify(harness, 'compaction.after', true) : 'unsupported',
        feasible: canCompact.length ? [{ source: 'companion', can: canCompact, qualification: 'sourceFeasible' }] : [],
      },
    },
  };
  if (harness.package !== null) out.owner = harness.package;
  return out;
}

interface Path { kind: string; trigger: string; launch: string; events: string; companions: 'perHarness' | 'unavailable' }
export const PATHS: readonly Path[] = [
  { kind: 'task', trigger: 'user', launch: 'send', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'task', trigger: 'package', launch: 'tasksStart', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'task', trigger: 'tool', launch: 'agentTool', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'worker', trigger: 'team', launch: 'teamWorker', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'worker', trigger: 'council', launch: 'teamWorker', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'bot', trigger: 'bot', launch: 'botWorkspace', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'bot', trigger: 'remote', launch: 'remoteRequest', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'schedule', trigger: 'schedule', launch: 'scheduleFiring', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'remote', trigger: 'remote', launch: 'remoteRequest', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'remote', trigger: 'remote', launch: 'remoteStart', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'remote', trigger: 'cloud', launch: 'cloudRun', events: 'agentEvents', companions: 'perHarness' },
  { kind: 'remote', trigger: 'mirror', launch: 'mirrorSend', events: 'mirrorEvents', companions: 'unavailable' },
];

export function runs(counters: Obj | null): Obj[] {
  return RUN_KINDS.map(kind => ({
    kind,
    paths: PATHS.filter(path => path.kind === kind).map(path => ({
      trigger: path.trigger, launch: path.launch, events: path.events,
      toolBefore: { source: 'permissionRequest', companions: path.companions }, delivered: [...DELIVERED], qualification: 'recorded',
    })),
    counters: counters?.[kind] ?? null,
  }));
}
export function report(harnesses: readonly Harness[], counters: Obj | null, only: string | null): Obj {
  return { schemaVersion: SCHEMA_VERSION, decisions: 'observeOnly', harnesses: harnesses.filter(harness => only === null || harness.id === only).map(row), runs: runs(counters) };
}

/** The built-in roster and the package providers of enabled, trusted packages outside safe mode. */
export function roster(snapshot: Obj, installed: (id: string) => boolean): Harness[] {
  const out: Harness[] = BUILT_INS.map(([id, name]) => ({ id, name, package: null, installed: installed(id) ? 'Installed' : 'Absent' }));
  if (snapshot.safeMode === true) return out;
  for (const item of (Array.isArray(snapshot.packages) ? snapshot.packages : []) as Obj[]) {
    const executable = item.executable as Obj | null | undefined;
    if (item.enabled !== true || executable?.trusted !== true) continue;
    const manifest = item.manifest as Obj; const owner = manifest?.id;
    if (typeof owner !== 'string') continue;
    const providers = ((manifest.contributes as Obj | undefined)?.providers ?? []) as Obj[];
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (typeof provider.id !== 'string' || typeof provider.name !== 'string') continue;
      const state = ((provider.metadata as Obj | undefined)?.readiness as Obj | undefined)?.state;
      out.push({ id: provider.id, name: provider.name, package: owner, installed: state === undefined || state === 'ready' ? 'Installed' : 'Unknown' });
    }
  }
  return out;
}

/** `panda.harnesses.list(options?)`: `{ harness?, includeModels?: false }`; a string is the failure code. */
export function readOptions(params: Json): { harness: string | null } | string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return 'InvalidShape';
  if (Object.keys(params).some(key => key !== 'harness' && key !== 'includeModels')) return 'InvalidShape';
  const models = params.includeModels;
  if (models === true) return 'UnsupportedCapability';
  if (models !== undefined && models !== null && models !== false) return 'InvalidShape';
  const harness = params.harness;
  if (harness === undefined || harness === null) return { harness: null };
  if (typeof harness !== 'string' || !harness || harness.length > 160 || /[\u0000-\u001f\u007f]/.test(harness)) return 'InvalidShape';
  return { harness };
}

// ---- A task that runs on another computer -------------------------------------------------------------------------

const STARTING = ['turn_start', 'message_start', 'text', 'tool', 'status', 'approval', 'input_request'];
const ENDED = ['completed', 'success', 'failed', 'error', 'cancelled', 'canceled', 'denied', 'rejected', 'interrupted'];

/** The native `feed`: mirrored events into `hub` (approvals as `tool.before`, finished rows as `tool.after`). */
export function feedMirror(hub: HookRegistry, book: HookPayloads, events: readonly Obj[], start: (local: string) => RunFacts | null, launched: (run: Obj) => void): void {
  const payload = (base: Obj, callId: string) => book.hookCall(base, callId) as Obj | string;
  for (const event of events) {
    const local = event.sessionId; const kind = event.kind;
    if (typeof local !== 'string' || typeof kind !== 'string') continue;
    if (!hub.run(local)) {
      if (!STARTING.includes(kind)) continue;
      const facts = start(local);
      if (!facts) continue;
      launched(facts.run);
      hub.turnStarted(facts);
    }
    const project = hub.run(local)?.projectId;
    if (project === undefined) continue;
    if (kind === 'approval') {
      const request = event.requestId;
      if (typeof request !== 'string') continue;
      const data = (event.data ?? {}) as Obj;
      const name = (['name', 'tool_name', 'title'].map(key => data[key]).find(value => typeof value === 'string') as string | undefined) ?? 'tool';
      const input = data.input ?? data.rawInput ?? { preview: event.text ?? null };
      const { callId } = book.record(local, project, `request:${request}`, input);
      hub.toolBefore(local, callId, callId, name, request, payload);
      continue;
    }
    const tool = event.tool as Obj | undefined;
    if (!tool || typeof tool.id !== 'string' || typeof tool.name !== 'string' || typeof tool.status !== 'string') continue;
    if (tool.name === 'Compact context') { if (tool.status === 'completed') hub.compaction(local); continue; }
    if (!ENDED.includes(tool.status)) continue;
    const text = typeof tool.input === 'string' ? tool.input : '';
    let input: Json; try { input = JSON.parse(text); } catch { input = { preview: text }; }
    const callId = book.callId(local, tool.id) ?? book.record(local, project, tool.id, input).callId;
    hub.toolAfter(local, callId, callId, tool.name, tool.status, typeof tool.output === 'string' ? tool.output : '', payload);
  }
}
