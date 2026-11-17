// Bots and shared channels for trusted services (`workspace.bots`, `workspace.channels`, runtime phase R4, slice R0406).
//
// The native rules live in src-tauri/src/extensions/runtime_workspace_automation.rs. The first half of this file mirrors
// the forms and the refusal envelope with no I/O for the browser preview and the deterministic checks of
// tests/extensions-runtime-workspace-automation.spec.ts. The second half is what the main window runs: it shows the host
// confirmation of an irreversible deletion (the default, which the user can turn off per package) and reads which package
// made each bot and channel. `workspace.manage` is global and checked natively on every call; a package that holds it is
// never asked per action (ADR-0005), except for the deletion's confirmation. Removing a channel archives it, as the
// interface's "Delete channel" does. Shared-channel posts are tasks for the `tasks.*` calls; recipes, wake-ups, moodboards and
// cloud belong to the sibling slices.
import { call } from '../bridge';
import type { Json } from './contracts';

export const PERMISSION = 'workspace.manage';
export const BOT_FIELDS = ['name', 'role', 'instructions', 'goals', 'soul', 'avatar', 'provider', 'model', 'mode', 'heartbeatMinutes', 'color', 'reasoningEffort', 'backupModels', 'fallbackMode', 'notify', 'whileWorking', 'showPlan', 'skills', 'mcp'] as const;
const BOT_TEXT: readonly string[] = ['name', 'role', 'instructions', 'goals', 'soul', 'avatar', 'provider', 'model', 'mode', 'color', 'reasoningEffort', 'fallbackMode', 'whileWorking'];
export const CHANNEL_FIELDS = ['name', 'memberIds', 'leadBotId'] as const;
export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_BACKUPS = 4;
export const MAX_REFERENCES = 50;
export const MAX_MEMBERS = 64;
export const MAX_ORIGINS = 10_000;
export const MAX_CONFIRMATIONS = 8;
export const MAX_CONFIRMATIONS_PER_PACKAGE = 2;
/** The harnesses the interface lets a bot use, and the permission modes (what the native form accepts). */
export const BOT_PROVIDERS = ['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes', 'cursor'] as const;
export const MODES = ['ask', 'auto', 'review', 'plan', 'full'] as const;

export type Code = 'NotFound' | 'StaleContext' | 'PermissionDenied' | 'InvalidShape' | 'LimitExceeded' | 'UnsupportedCapability' | 'HostUnavailable' | 'Cancelled' | 'Timeout' | 'Revoked';
export type Refusal = { code: Code; path: string };
export type Reply<T = Json> = { ok: true; value: T } | { ok: false; error: { schemaVersion: 1; code: Code; path: string; ids: string[] } };
const failure = (code: Code, path = '$'): Reply<never> => ({ ok: false, error: { schemaVersion: 1, code, path, ids: [] } });
const refuse = (code: Code, path = '$'): Refusal => ({ code, path });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ident = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && [...text].length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(text);

export type Family = 'bots' | 'channels';
export type Op = 'create' | 'update' | 'remove';
export type Request = { family: Family; op: Op; id: string | null; input: unknown };

function references(value: unknown, name: string, skill: boolean): Refusal | null {
  if (!Array.isArray(value)) return refuse('InvalidShape', name);
  if (value.length > MAX_REFERENCES) return refuse('LimitExceeded', name);
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    const valid = text.length > 0 && text.length <= (skill ? 64 : 100) && (skill ? /^[a-z0-9-]+$/.test(text) : !/[\u0000-\u001f\u007f-\u009f]/.test(text));
    if (!valid) return refuse('InvalidShape', name);
  }
  return null;
}
const unknownField = (map: Record<string, unknown>, allowed: readonly string[]): Refusal | null => {
  const name = Object.keys(map).find(key => !allowed.includes(key));
  return name === undefined ? null : refuse('InvalidShape', name);
};

/** Mirrors `bot_patch`: the fields of a bot form a call names, checked for shape and bound. */
export function botPatch(input: unknown, creating: boolean): Refusal | Record<string, unknown> {
  if (!isObject(input)) return refuse('InvalidShape', 'input');
  const unknown = unknownField(input, BOT_FIELDS); if (unknown) return unknown;
  for (const [key, value] of Object.entries(input)) {
    if (BOT_TEXT.includes(key)) {
      if (typeof value !== 'string') return refuse('InvalidShape', key);
      if (new TextEncoder().encode(value).length > MAX_TEXT_BYTES) return refuse('LimitExceeded', key);
    } else if (key === 'heartbeatMinutes') { if (!Number.isInteger(value)) return refuse('InvalidShape', key); }
    else if (key === 'notify' || key === 'showPlan') { if (typeof value !== 'boolean') return refuse('InvalidShape', key); }
    else if (key === 'backupModels') {
      if (!Array.isArray(value)) return refuse('InvalidShape', key);
      if (value.length > MAX_BACKUPS) return refuse('LimitExceeded', key);
      for (const item of value) if (!isObject(item) || unknownField(item, ['provider', 'model']) || typeof item.provider !== 'string' || typeof item.model !== 'string') return refuse('InvalidShape', key);
    } else if (key === 'skills' || key === 'mcp') { const bad = references(value, key, key === 'skills'); if (bad) return bad; }
  }
  if (creating && !(typeof input.name === 'string' && input.name.trim())) return refuse('InvalidShape', 'name');
  return { ...input };
}

/** Mirrors `channel_patch`. `leadBotId` may be `null` (the first member leads). */
export function channelPatch(input: unknown, creating: boolean): Refusal | Record<string, unknown> {
  if (!isObject(input)) return refuse('InvalidShape', 'input');
  const unknown = unknownField(input, CHANNEL_FIELDS); if (unknown) return unknown;
  if ('name' in input) {
    if (typeof input.name !== 'string') return refuse('InvalidShape', 'name');
    if (new TextEncoder().encode(input.name).length > MAX_TEXT_BYTES) return refuse('LimitExceeded', 'name');
  }
  if ('memberIds' in input) {
    if (!Array.isArray(input.memberIds)) return refuse('InvalidShape', 'memberIds');
    if (input.memberIds.length > MAX_MEMBERS) return refuse('LimitExceeded', 'memberIds');
    if (!input.memberIds.every(id => ident(id)) || new Set(input.memberIds).size !== input.memberIds.length) return refuse('InvalidShape', 'memberIds');
  }
  if ('leadBotId' in input && input.leadBotId !== null && !ident(input.leadBotId)) return refuse('InvalidShape', 'leadBotId');
  if (creating && !('name' in input && 'memberIds' in input)) return refuse('InvalidShape', 'name' in input ? 'memberIds' : 'name');
  return { ...input };
}

/** Mirrors `read_request`: `{ family, op, id?, input? }`, checked before anything is touched. */
export function readRequest(params: unknown): Refusal | Request {
  if (!isObject(params)) return refuse('InvalidShape');
  const unknown = unknownField(params, ['family', 'op', 'id', 'input']); if (unknown) return unknown;
  if (params.family !== 'bots' && params.family !== 'channels') return refuse('InvalidShape', 'family');
  if (params.op !== 'create' && params.op !== 'update' && params.op !== 'remove') return refuse('InvalidShape', 'op');
  const family = params.family, op = params.op;
  let id: string | null = null;
  if (op === 'create') { if (params.id !== undefined && params.id !== null) return refuse('InvalidShape', 'id'); }
  else if (ident(params.id)) id = params.id;
  else return refuse('InvalidShape', family === 'bots' ? 'botId' : 'channelId');
  const input = params.input ?? null;
  if (op === 'remove') { if (input !== null) return refuse('InvalidShape', 'input'); }
  else { const bad = family === 'bots' ? botPatch(input, op === 'create') : channelPatch(input, op === 'create'); if (isRefusal(bad)) return bad; }
  return { family, op, id, input };
}
const isRefusal = (value: unknown): value is Refusal => isObject(value) && typeof value.code === 'string' && typeof value.path === 'string' && Object.keys(value).length === 2;

/** Mirrors `channel_merge`: a lead who is no longer a member falls back to the first member. */
export function channelMerge(base: Record<string, unknown> | null, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of CHANNEL_FIELDS) if (base && key in base) merged[key] = base[key];
  Object.assign(merged, patch);
  const members = Array.isArray(merged.memberIds) ? merged.memberIds as string[] : [];
  if (!(typeof merged.leadBotId === 'string' && members.includes(merged.leadBotId))) merged.leadBotId = null;
  return merged;
}

/** What the irreversible-deletion table calls each removal. */
export const removalAction = (family: string): string | null => family === 'bots' ? 'bots.remove' : family === 'channels' ? 'channels.remove' : null;

// ---- The main window: the host confirmation and the labels --------------------------------------------------------------

export type Confirmation = { ticket: string; owner: string; name: string; action: string; what: string };
export type Origin = { package: string; name: string; action: string; at: number };
export type Origins = { schemaVersion: 1; revision: number; origins: Record<string, Origin> };
/** What the main window supplies: the host confirmation dialog (the same plate the interface's own deletions use). */
export type MainHost = { confirm: (options: { title: string; text: string; button: string }) => Promise<boolean> };

export const confirmationText = (item: Confirmation): { title: string; text: string; button: string } => {
  const noun = item.action === 'channels.remove' ? 'channel' : 'bot';
  return {
    title: `Delete this ${noun}?`,
    text: `${item.name} asks to delete ${item.what.replace(/^Delete the (bot|channel) /, `the ${noun} `).replace(/ for the extension .*$/, '')}. ${noun === 'bot' ? 'Its conversations and channel connections are removed; its workspace folder stays on disk.' : 'Pending work in it stops; it stays under Deleted channels and can be restored.'} You can let this extension delete without asking in Settings, Extensions.`,
    button: `Delete ${noun}`,
  };
};

type Subscribe = (name: string, callback: (event: unknown) => void) => Promise<() => void>;
let started = false;
/** The spec drives the window half through `window.__workspaceAutomation`, so the app's own start stands aside then. */
const seam = typeof location !== 'undefined' && new URLSearchParams(location.search).has('workspace-automation');
/** Asks the user about each deletion a service waits on, answers natively and labels what packages changed. */
export async function startWorkspaceAutomation(host: MainHost, options: { force?: boolean } = {}): Promise<() => void> {
  if (started || (seam && !options.force)) return () => undefined;
  started = true;
  const bridge = await import('../bridge');
  const subscribe = bridge.subscribe as unknown as Subscribe;
  const seen = new Set<string>();
  let disposed = false;
  const ask = async (item: Confirmation) => {
    if (seen.has(item.ticket)) return;
    seen.add(item.ticket);
    let accepted = false;
    try { accepted = await host.confirm(confirmationText(item)); } catch { accepted = false; }
    // A refusal, a closed dialog and a failure are all "no": nothing is deleted.
    try { await call('extensions_workspace_automation_confirm_answer', { ticket: item.ticket, accepted }); } catch { /* the call timed out or the authority was revoked: nothing waits */ }
  };
  const drain = async () => {
    try { const reply = await call<{ pending: Confirmation[] }>('extensions_workspace_automation_pending'); for (const item of reply.pending) if (!disposed) void ask(item); } catch { /* the next event asks again */ }
  };
  const stop = await subscribe('extensions-workspace-automation-confirm', event => { void ask(event as Confirmation); });
  void drain();
  return () => { disposed = true; started = false; stop(); };
}
/** Test seam: forget the started flag so a spec can start the window half again. */
export function resetWorkspaceAutomation(): void { started = false; }

export async function loadWorkspaceOrigins(): Promise<Origins> {
  try { return await call<Origins>('extensions_workspace_automation_origins'); } catch { return { schemaVersion: 1, revision: 0, origins: {} }; }
}

// ---- Preview stand-in ------------------------------------------------------------------------------------------------------

type PreviewBot = Record<string, Json> & { id: string; name: string; projectId: string; skills: string[]; mcp: string[]; activity: string[] };
type PreviewChannel = { id: string; name: string; memberIds: string[]; leadBotId: string | null; archived: boolean; updatedAt: number };
export type PreviewState = {
  bots: Map<string, PreviewBot>; channels: Map<string, PreviewChannel>; installed: Set<string>; granted: Set<string>;
  /** Packages whose deletion confirmation the user turned off. */
  trusting: Set<string>; answers: boolean[]; asked: Confirmation[]; origins: Record<string, Origin>; revision: number; sequence: number;
  /** What the window did: the interface's own operations the adapters ran, to compare action counts with the UI route. */
  actions: string[]; emit?: (name: string, payload: unknown) => void;
};
let preview: PreviewState | undefined;
const previewState = (): PreviewState => preview ??= { bots: new Map(), channels: new Map(), installed: new Set(), granted: new Set(), trusting: new Set(), answers: [], asked: [], origins: {}, revision: 0, sequence: 0, actions: [] };
/** Lets the preview deliver the events of this slice (set by `src/extensions/preview.ts`). */
export function previewWorkspaceAutomationNotifier(emit: (name: string, payload: unknown) => void): void { previewState().emit = emit; }
const clean = (text: string, max: number) => [...text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('');

function previewRefusal(message: string): Refusal {
  const text = message.toLowerCase();
  if (text.includes('no longer exists')) return refuse('NotFound');
  if (text.includes('is deleted')) return refuse('StaleContext');
  const path = text.includes('channel name') || text.includes('a name') ? 'name' : text.includes('permission mode') ? 'mode' : text.includes('harness and model') ? 'provider' : text.includes('check-ins') ? 'heartbeatMinutes'
    : text.includes('personality') ? 'soul' : text.includes('color') ? 'color' : text.includes('lead') ? 'leadBotId' : text.includes('member') ? 'memberIds' : '';
  return path ? refuse('InvalidShape', path) : refuse('HostUnavailable');
}
class Native extends Error { readonly refusal: Refusal; constructor(refusal: Refusal) { super(refusal.code); this.refusal = refusal; } }
const native = (message: string): never => { throw new Native(previewRefusal(message)); };

function previewBotForm(form: Record<string, unknown>): void {
  if (!clean(String(form.name ?? ''), 60)) native('Give the bot a name.');
  if (!MODES.includes(form.mode as never)) native('Choose a permission mode for the bot.');
  if (!BOT_PROVIDERS.includes(form.provider as never) || String(form.model ?? '').length > 200) native('Choose a harness and model for the bot.');
  const minutes = Number(form.heartbeatMinutes ?? 0);
  if (!(minutes >= 0 && minutes <= 7 * 24 * 60)) native('Check-ins run at most once a week and at least every minute.');
  const color = String(form.color ?? '').trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) native('Choose a color from the list.');
}
const previewRecord = (state: PreviewState, key: string, owner: string, action: string) => {
  state.origins[key] = { package: owner, name: owner, action, at: ++state.sequence };
  state.revision += 1;
  state.emit?.('extensions-workspace-automation-origins', state.revision);
};

function previewBotEffect(state: PreviewState, request: Request, owner: string): Json {
  const patch = botPatch(request.input, request.op === 'create') as Record<string, unknown>;
  const current = request.id ? state.bots.get(request.id) : undefined;
  if (request.id && !current) native('This bot no longer exists.');
  const form: Record<string, unknown> = { heartbeatMinutes: 0, ...(current ?? {}), ...patch };
  previewBotForm(form);
  const id = current?.id ?? `bot-${state.bots.size + 1}-${state.sequence + 1}`;
  const bot = { ...form, id, name: clean(String(form.name), 60), projectId: current?.projectId ?? `project-${id}`, skills: (patch.skills as string[] | undefined) ?? current?.skills ?? [], mcp: (patch.mcp as string[] | undefined) ?? current?.mcp ?? [],
    activity: [...(current?.activity ?? []), `${current ? 'Settings changed' : 'Created'} by extension ${owner}`] } as PreviewBot;
  state.bots.set(id, bot);
  state.actions.push(current ? 'bot_update' : 'bot_create');
  previewRecord(state, `bot:${id}`, owner, current ? 'updated' : 'created');
  state.emit?.('bots-changed', null);
  const { activity: _activity, ...visible } = bot;
  return visible as Json;
}
function previewChannelEffect(state: PreviewState, request: Request, owner: string): Json {
  const patch = channelPatch(request.input, request.op === 'create') as Record<string, unknown>;
  const current = request.id ? state.channels.get(request.id) : undefined;
  if (request.id && !current) throw new Native(refuse('NotFound', 'channelId'));
  if (current?.archived) native('This channel is deleted. Restore it to change it.');
  const merged = channelMerge(current ? { name: current.name, memberIds: current.memberIds, leadBotId: current.leadBotId } : null, patch);
  const name = clean(String(merged.name ?? '').replace(/^#/, ''), 100);
  if (!name || [...name].length > 48) native('Use a channel name up to 48 characters.');
  const members = merged.memberIds as string[];
  if (members.some(member => !state.bots.has(member))) native('This bot no longer exists.');
  const lead = typeof merged.leadBotId === 'string' ? merged.leadBotId : members[0] ?? null;
  const id = current?.id ?? `channel-${state.channels.size + 1}-${state.sequence + 1}`;
  const channel: PreviewChannel = { id, name, memberIds: members, leadBotId: lead, archived: false, updatedAt: ++state.sequence };
  state.channels.set(id, channel);
  state.actions.push(current ? 'bot_shared_channel_update' : 'bot_shared_channel_create');
  previewRecord(state, `channel:${id}`, owner, current ? 'updated' : 'created');
  state.emit?.('bot-shared-channel-changed', { channelId: id });
  return channel as unknown as Json;
}

/** The deletion's host confirmation, answered by the window's pre-set answers in the preview (the real one shows a dialog). */
function previewConfirm(state: PreviewState, request: Request, owner: string, what: string): Refusal | null {
  if (state.trusting.has(owner)) return null;
  const item: Confirmation = { ticket: `ticket-${state.asked.length + 1}`, owner, name: owner, action: removalAction(request.family) ?? '', what };
  if (state.asked.filter(entry => entry.owner === owner).length >= 1000) return refuse('LimitExceeded', 'confirmation');
  state.asked.push(item);
  state.emit?.('extensions-workspace-automation-confirm', item);
  return (state.answers.shift() ?? true) ? null : refuse('Cancelled', 'confirmation');
}

/** The service call as the host answers it: `{ok, value}` or the refusal envelope. Mirrors `serve`. */
export function serveAutomation(state: PreviewState, owner: string, params: unknown): Reply {
  if (!state.installed.has(owner) || !state.granted.has(owner)) return failure('PermissionDenied', PERMISSION);
  const request = readRequest(params);
  if (isRefusal(request)) return failure(request.code, request.path);
  try {
    if (request.op === 'remove') {
      const id = request.id as string;
      const exists = request.family === 'bots' ? state.bots.has(id) : state.channels.has(id);
      if (!exists) return failure('NotFound', request.family === 'bots' ? '$' : 'channelId');
      const label = request.family === 'bots' ? state.bots.get(id)!.name : state.channels.get(id)!.name;
      const refused = previewConfirm(state, request, owner, `Delete the ${request.family === 'bots' ? 'bot' : 'channel'} ${label} for the extension ${owner}`);
      if (refused) return failure(refused.code, refused.path);
      // The grant is read again after the wait: a revoke while the dialog was open removes nothing.
      if (!state.granted.has(owner)) return failure('PermissionDenied', PERMISSION);
      if (request.family === 'bots') {
        state.bots.delete(id);
        for (const channel of state.channels.values()) channel.memberIds = channel.memberIds.filter(member => member !== id);
        state.actions.push('bot_delete');
        state.emit?.('bots-changed', null);
      } else {
        state.channels.get(id)!.archived = true;
        state.actions.push('bot_shared_channel_archive');
        state.emit?.('bot-shared-channel-changed', { channelId: id });
      }
      previewRecord(state, `${request.family === 'bots' ? 'bot' : 'channel'}:${id}`, owner, 'removed');
      return { ok: true, value: null };
    }
    return { ok: true, value: request.family === 'bots' ? previewBotEffect(state, request, owner) : previewChannelEffect(state, request, owner) };
  } catch (error) {
    if (error instanceof Native) return failure(error.refusal.code, error.refusal.path);
    return failure('HostUnavailable');
  }
}

/**
 * The preview's IPC for the commands of this slice. `extensions_workspace_automation_service` is the service call as the
 * host answers it; `extensions_workspace_automation_preview` is the test hook (install, grant, revoke, the package's
 * confirmation preference, the answer of the next confirmation, seeds and the state).
 */
export function previewWorkspaceAutomation(command: string, args: Record<string, unknown>): unknown {
  const state = previewState();
  switch (command) {
    case 'extensions_workspace_automation_service': return serveAutomation(state, String(args.owner ?? ''), args.params);
    case 'extensions_workspace_automation_confirm_answer': return null;
    case 'extensions_workspace_automation_pending': return { schemaVersion: 1, pending: [] };
    case 'extensions_workspace_automation_origins': return { schemaVersion: 1, revision: state.revision, origins: state.origins };
    case 'extensions_workspace_automation_preview':
      switch (args.op) {
        case 'install': state.installed.add(String(args.owner)); return null;
        case 'uninstall': state.installed.delete(String(args.owner)); return null;
        case 'grant': state.granted.add(String(args.owner)); return null;
        case 'revoke': state.granted.delete(String(args.owner)); return null;
        case 'confirmDeletions': if (args.value === false) state.trusting.add(String(args.owner)); else state.trusting.delete(String(args.owner)); return null;
        case 'answerNext': state.answers.push(args.accepted === true); return null;
        case 'seedBot': { const form = { name: 'Seed', provider: 'claude', model: 'sonnet', mode: 'ask', ...(args.form as object) }; const id = `bot-seed-${state.bots.size + 1}`; state.bots.set(id, { ...form, id, projectId: `project-${id}`, skills: [], mcp: [], activity: [] } as unknown as PreviewBot); return id; }
        case 'state': return {
          bots: [...state.bots.values()], channels: [...state.channels.values()], asked: state.asked, actions: state.actions, origins: state.origins,
        };
        default: throw new Error('InvalidArguments');
      }
    default: throw new Error('Unsupported extension preview command.');
  }
}

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('workspace-automation')) {
  (globalThis as { __workspaceAutomation?: unknown }).__workspaceAutomation = {
    call: (command: string, args?: Record<string, unknown>) => call(command, args ?? {}),
    start: (confirm: MainHost['confirm']) => startWorkspaceAutomation({ confirm }, { force: true }),
    reset: resetWorkspaceAutomation,
  };
}
