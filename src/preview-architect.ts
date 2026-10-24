import type { ModelSelection, TeamConfig, TeamLibrary, TeamMessage, TeamMessagePage, TeamSetup, TeamSnapshot, TeamWorker, WorkerProfile } from './architect-types';
import type { AgentEvent, Message, MessagePage, ProviderId, ProviderModel, Session } from './types';
import { workerQueueReason } from './worker-scheduling.ts';

interface PreviewHost {
  parent(id: unknown): Session;
  assertIdle(parent: Session): void;
  append(parentId: string, role: string, content: string): Message;
  finishTiming(parentId: string): void;
  finishChanges(user: Message): void;
  nextMessageId(): number;
  models(provider: ProviderId): ProviderModel[];
  emit(event: TeamSnapshot | { sessionId: string; removed: true }): void;
  agent(event: AgentEvent): void;
}
interface WorkerRun { worker: TeamWorker; output: string; cursor: number; timer?: number; messages: Message[] }
interface TeamRun { snapshot: TeamSnapshot; runs: WorkerRun[]; batchStart: number; reviewTimer?: number; messages?: TeamMessage[] }

const storageKey = 'pandacode.preview.architect-configs';
const libraryKey = 'pandacode.preview.architect-library';
const sampleNotice = 'Browser preview — sample output only. No model, command, or file operation is running.';
function boundedSummary(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The preview demonstrates coordination without starting any model or shell. */
export function createPreviewArchitect(host: PreviewHost) {
  const teams = new Map<string, TeamRun>();
  const configs = new Map<string, TeamConfig>();
  let library: TeamLibrary = { enabled: false, lastSetup: null, activeProfileId: null, profiles: [] };

  function integer(value: unknown, low: number, high: number, label: string): number {
    if (!Number.isInteger(value) || Number(value) < low || Number(value) > high) throw new Error(`${label} must be between ${low} and ${high}.`);
    return Number(value);
  }
  function validateSelection(selection: ModelSelection): ModelSelection {
    if (!selection || !['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse'].includes(selection.provider) || typeof selection.model !== 'string' || selection.model.length > 200) throw new Error('Choose a valid architect harness and model.');
    const models = host.models(selection.provider);
    const model = selection.model ? models.find(model => model.id === selection.model) : models[0];
    if (selection.reasoningEffort != null && (typeof selection.reasoningEffort !== 'string' || selection.reasoningEffort.length > 32 || model && !model.reasoningEfforts?.some(effort => effort.id === selection.reasoningEffort))) throw new Error('This architect model does not support that reasoning effort.');
    return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ?? null };
  }
  function parentSelection(parent: Session): ModelSelection {
    return { provider: parent.provider, model: parent.model, reasoningEffort: parent.reasoningEffort ?? null };
  }
  function validateSetup(setup: TeamSetup): TeamSetup {
    if (!setup) throw new Error('Choose an architect and worker setup.');
    return { architect: validateSelection(setup.architect), config: validate(setup.config) };
  }
  function profileName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.trim())) throw new Error('Profile names must be 1–80 characters.');
    return value.trim();
  }
  function validate(config: TeamConfig): TeamConfig {
    // Auto teams carry an optional roster (the lead picks models); configured teams name 1–6 profiles.
    const [min, max] = config?.auto ? [0, 24] : [1, 6];
    if (!config || !Array.isArray(config.workers) || config.workers.length < min || config.workers.length > max) throw new Error(config?.auto ? 'Auto teams list at most 24 models.' : 'Add between 1 and 6 worker profiles.');
    const ids = new Set<string>();
    const workers = config.workers.map((profile): WorkerProfile => {
      if (!profile || typeof profile.id !== 'string' || !profile.id.trim() || profile.id.length > 100 || ids.has(profile.id)) throw new Error('Worker profile IDs must be unique.');
      ids.add(profile.id);
      if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80) throw new Error('Worker names must be 1–80 characters.');
      if (!['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse'].includes(profile.provider) || typeof profile.model !== 'string' || profile.model.length > 200) throw new Error('Choose a valid worker harness and model.');
      const models = host.models(profile.provider);
      const model = profile.model ? models.find(model => model.id === profile.model) : models[0];
      if (profile.reasoningEffort != null && (typeof profile.reasoningEffort !== 'string' || profile.reasoningEffort.length > 32 || model && !model.reasoningEfforts?.some(effort => effort.id === profile.reasoningEffort))) throw new Error('This worker model does not support that reasoning effort.');
      return { id: profile.id, name: profile.name.trim(), provider: profile.provider, model: profile.model, reasoningEffort: profile.reasoningEffort ?? null };
    });
    if (config.workspace !== 'shared') throw new Error('Workers must use the task’s shared workspace.');
    if (config.rosterOnly && (!config.auto || !workers.length)) throw new Error('A named agent team needs at least one model.');
    if (config.name != null && (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80)) throw new Error('Team names must be 1–80 characters.');
    const guidance = typeof config.leadGuidance === 'string' ? config.leadGuidance.trim() : '';
    // Native counts UTF-8 bytes, so multibyte text reaches the limit sooner than its length.
    if (new TextEncoder().encode(guidance).length > 2000) throw new Error('Lead guidance must be under 2000 bytes.');
    return { ...(config.auto ? { auto: true } : {}), ...(config.rosterOnly ? { rosterOnly: true } : {}), ...(config.name != null ? { name: config.name } : {}), ...(guidance ? { leadGuidance: guidance } : {}), workers, maxParallel: integer(config.maxParallel, 0, Number.MAX_SAFE_INTEGER, 'Parallel workers'), maxRounds: integer(config.maxRounds, 1, 20, 'Review rounds'), maxAssignments: integer(config.maxAssignments, 1, 50, 'Assignments'), workspace: 'shared', summaryLimit: integer(config.summaryLimit, 512, 6000, 'Summary limit') };
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [sessionId, config] of Object.entries(saved).slice(0, 100)) {
        try { host.parent(sessionId); configs.set(sessionId, validate(config)); } catch { /* Removed tasks and invalid older setups are ignored. */ }
      }
    }
  } catch { /* Storage can be unavailable in a private preview. */ }
  function persist(): void {
    // Only setups survive preview reloads; sample workers are never resumed as real work.
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(configs))); } catch { /* In-memory preview remains usable. */ }
  }
  function persistLibrary(): void {
    try { localStorage.setItem(libraryKey, JSON.stringify(library)); } catch { /* In-memory preview remains usable. */ }
  }
  try {
    const raw = localStorage.getItem(libraryKey);
    if (raw !== null) {
      const saved = JSON.parse(raw) as TeamLibrary;
      const lastSetup = saved.lastSetup ? validateSetup(saved.lastSetup) : null;
      const profiles: TeamLibrary['profiles'] = [], ids = new Set<string>(), names = new Set<string>();
      for (const profile of Array.isArray(saved.profiles) ? saved.profiles.slice(0, 20) : []) {
        try {
          const name = profileName(profile.name), key = name.toLowerCase();
          if (typeof profile.id !== 'string' || !profile.id || ids.has(profile.id) || names.has(key)) continue;
          const setup = validateSetup(profile.setup);
          profiles.push({ id: profile.id, name, setup, updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : 0 });
          ids.add(profile.id); names.add(key);
        } catch { /* Invalid older templates do not hide other saved profiles. */ }
      }
      library = { enabled: saved.enabled === true && lastSetup !== null, lastSetup, profiles, activeProfileId: profiles.some(profile => profile.id === saved.activeProfileId) ? saved.activeProfileId : null };
    } else if (configs.size) {
      const newest = [...configs].sort(([a], [b]) => host.parent(b).updatedAt - host.parent(a).updatedAt)[0];
      library = { enabled: true, lastSetup: validateSetup({ architect: parentSelection(host.parent(newest[0])), config: newest[1] }), activeProfileId: null, profiles: [] };
      persistLibrary();
    }
  } catch { /* Corrupt or inaccessible preview storage starts with a disabled default. */ }
  function profiles(): TeamLibrary { return structuredClone(library); }
  function setLeadGuidance(guidance: unknown): TeamLibrary {
    const text = typeof guidance === 'string' ? guidance.trim() : '';
    if (new TextEncoder().encode(text).length > 2000 || text.includes('\0')) throw new Error('Lead guidance must be under 2000 bytes.');
    library = { ...library, leadGuidance: text || undefined };
    persistLibrary();
    return profiles();
  }
  function saveProfile(id: unknown, name: unknown, setup: TeamSetup): TeamLibrary {
    const checkedName = profileName(name), checked = validateSetup(setup);
    const existing = id == null ? undefined : library.profiles.find(profile => profile.id === id);
    if (id != null && !existing) throw new Error('Team profile not found.');
    if (library.profiles.some(profile => profile.id !== existing?.id && profile.name.toLowerCase() === checkedName.toLowerCase())) throw new Error('A team profile with this name already exists.');
    if (!existing && library.profiles.length >= 20) throw new Error('Save up to 20 team profiles.');
    const profile = { id: existing?.id ?? crypto.randomUUID(), name: checkedName, setup: checked, updatedAt: Date.now() };
    if (existing) library.profiles[library.profiles.indexOf(existing)] = profile;
    else library.profiles.push(profile);
    if (library.activeProfileId === profile.id && JSON.stringify(profile.setup) !== JSON.stringify(library.lastSetup)) library.activeProfileId = null;
    persistLibrary(); return profiles();
  }
  function deleteProfile(id: unknown): TeamLibrary {
    if (!library.profiles.some(profile => profile.id === id)) throw new Error('Team profile not found.');
    library.profiles = library.profiles.filter(profile => profile.id !== id);
    if (library.activeProfileId === id) library.activeProfileId = null;
    persistLibrary(); return profiles();
  }
  function inherit(sessionId: unknown): void {
    const parent = host.parent(sessionId);
    // Called only by user-facing creation paths; internal workers never enter this store.
    if (!library.enabled || !library.lastSetup || configs.has(parent.id)) return;
    // An auto team is led by whatever model the new task was created with.
    if (!library.lastSetup.config.auto) Object.assign(parent, structuredClone(library.lastSetup.architect));
    configs.set(parent.id, structuredClone(library.lastSetup.config)); persist();
  }
  function publish(team: TeamRun): TeamSnapshot {
    team.snapshot.revision++; team.snapshot.updatedAt = Date.now();
    host.emit(structuredClone(team.snapshot));
    return structuredClone(team.snapshot);
  }
  function active(team: TeamRun | undefined): boolean { return !!team && ['running', 'waiting', 'paused'].includes(team.snapshot.status); }
  function get(sessionId: unknown): TeamSnapshot | null {
    const parent = host.parent(sessionId);
    let team = teams.get(parent.id);
    const config = configs.get(parent.id);
    if (!team && config) {
      team = { snapshot: { sessionId: parent.id, config: structuredClone(config), status: 'ready', round: 0, revision: 0, workers: [], updatedAt: Date.now() }, runs: [], batchStart: 0 };
      teams.set(parent.id, team);
    }
    return team ? structuredClone(team.snapshot) : null;
  }
  function configure(sessionId: unknown, config: TeamConfig | null, architect?: ModelSelection | null, profileId?: string | null): TeamSnapshot | null {
    const parent = host.parent(sessionId);
    const existing = teams.get(parent.id);
    const used = !!existing && (existing.snapshot.round > 0 || existing.snapshot.workers.length > 0);
    const running = !!existing && ['running', 'waiting'].includes(existing.snapshot.status);
    if (!existing || config === null) host.assertIdle(parent);
    if (parent.archived || parent.taskStage === 'completed') throw new Error('Reopen this task before changing its team.');
    if (parent.goalState?.status === 'active') throw new Error('Pause the task goal before enabling architect mode.');
    if (config === null) {
      if (existing && used) throw new Error('This run keeps its saved setup. Create a new task to use a different team.');
      library.enabled = false;
      configs.delete(parent.id); teams.delete(parent.id); persist(); persistLibrary();
      host.emit({ sessionId: parent.id, removed: true }); return null;
    }
    const checked = validateSetup({ config, architect: architect ?? parentSelection(parent) });
    if (profileId != null) {
      const profile = library.profiles.find(profile => profile.id === profileId);
      if (!profile) throw new Error('Team profile not found.');
      if (JSON.stringify(profile.setup) !== JSON.stringify(checked)) throw new Error('This setup does not match the saved team profile.');
    }
    if (!existing && parent.resumeId && parent.provider !== checked.architect.provider) throw new Error('A started task keeps its harness. Create a new task to change it.');
    if (existing && checked.config.maxAssignments < existing.snapshot.workers.length) throw new Error('Assignment limit cannot be below the existing assignment count.');
    if (existing && checked.config.maxRounds < existing.snapshot.round) throw new Error('Architect round limit cannot be below the current round.');
    // Validation completes before either task or remembered default changes.
    library = { ...library, enabled: true, lastSetup: structuredClone(checked), activeProfileId: profileId ?? null };
    persistLibrary();
    if (existing) {
      existing.snapshot.pendingSetup = checked;
      if (JSON.stringify(checked) === JSON.stringify({ architect: parentSelection(parent), config: existing.snapshot.config })) existing.snapshot.pendingSetup = null;
      if (!running) applyPending(existing);
      return publish(existing);
    }
    Object.assign(parent, checked.architect, { updatedAt: Date.now() });
    configs.set(parent.id, checked.config); persist();
    teams.delete(parent.id); get(parent.id);
    return publish(teams.get(parent.id)!);
  }
  function applyPending(team: TeamRun): void {
    const setup = team.snapshot.pendingSetup;
    if (!setup) return;
    const parent = host.parent(team.snapshot.sessionId);
    if (parent.provider !== setup.architect.provider) { parent.resumeId = null; parent.contextUsage = null; }
    Object.assign(parent, structuredClone(setup.architect), { updatedAt: Date.now() });
    team.snapshot.config = structuredClone(setup.config); team.snapshot.pendingSetup = null;
    configs.set(parent.id, structuredClone(setup.config)); persist();
  }
  function workerMessage(run: WorkerRun, role: string, content: string): Message {
    const message = { id: host.nextMessageId(), sessionId: run.worker.sessionId, role, content, createdAt: Date.now() };
    run.messages.push(message); return message;
  }
  function finishWorker(team: TeamRun, run: WorkerRun): void {
    run.timer = undefined;
    workerMessage(run, 'assistant', run.output);
    const user = [...run.messages].reverse().find(message => message.role === 'user');
    if (user) user.turnDurationMs = Math.max(0, Date.now() - user.createdAt);
    host.finishChanges(workerMessage(run, 'changes', ''));
    run.worker.status = 'completed'; run.worker.updatedAt = Date.now();
    run.worker.summary = boundedSummary(run.output, team.snapshot.config.summaryLimit);
    run.worker.checkpoint = { summary: 'Sample assignment explored. No files were changed.', nextSteps: 'Await the sample architect review.', blocker: null, updatedAt: Date.now() };
    const messages = team.messages ??= [];
    messages.push({ id: messages.length + 1, sender: run.worker.id, recipient: 'architect', message: `${run.worker.name}: sample summary ready for review. ${sampleNotice}`, createdAt: Date.now() });
    team.snapshot.coordinationRevision = (team.snapshot.coordinationRevision ?? 0) + 1;
    host.agent({ sessionId: run.worker.sessionId, kind: 'done', text: '' });
    publish(team); schedule(team);
  }
  function tick(team: TeamRun, run: WorkerRun): void {
    run.timer = undefined;
    if (team.snapshot.status !== 'running') return;
    const chunk = run.output.slice(run.cursor, run.cursor + 9); run.cursor += chunk.length;
    host.agent({ sessionId: run.worker.sessionId, kind: 'text', text: chunk });
    if (team.snapshot.status !== 'running') return;
    if (run.cursor < run.output.length) run.timer = window.setTimeout(() => tick(team, run), 45);
    else finishWorker(team, run);
  }
  function review(team: TeamRun): void {
    team.reviewTimer = undefined;
    if (team.snapshot.status !== 'running') return;
    applyPending(team);
    const parent = host.parent(team.snapshot.sessionId);
    const count = team.runs.length - team.batchStart;
    const output = `### Sample architect review\n\n${count} worker${count === 1 ? '' : 's'} returned a bounded summary. The sample assignments are ready for your review.\n\n${sampleNotice}`;
    host.agent({ sessionId: parent.id, kind: 'message_start', text: '' });
    host.agent({ sessionId: parent.id, kind: 'text', text: output });
    host.append(parent.id, 'assistant', output); host.finishTiming(parent.id);
    parent.status = 'idle'; parent.taskStage = 'review'; parent.lastResponseAt = Date.now(); parent.updatedAt = Date.now();
    team.snapshot.status = 'completed'; team.snapshot.summary = boundedSummary(output, team.snapshot.config.summaryLimit);
    publish(team);
    host.agent({ sessionId: parent.id, kind: 'done', text: '' });
  }
  function schedule(team: TeamRun): void {
    if (team.snapshot.status !== 'running') return;
    const batch = team.runs.slice(team.batchStart);
    for (const run of batch) {
      if (run.worker.status !== 'queued' || workerQueueReason(run.worker, team.snapshot.workers, team.snapshot.config.maxParallel)) continue;
      run.worker.status = 'running'; run.worker.updatedAt = Date.now();
      run.worker.checkpoint = { summary: 'Sample assignment started.', nextSteps: 'Explore the sample scope and report a concise result.', blocker: null, updatedAt: Date.now() };
      host.agent({ sessionId: run.worker.sessionId, kind: 'status', text: 'Running sample worker' });
      run.timer = window.setTimeout(() => tick(team, run), 200);
    }
    publish(team);
    if (batch.every(run => run.worker.status === 'completed') && team.reviewTimer === undefined) {
      host.agent({ sessionId: team.snapshot.sessionId, kind: 'status', text: 'Reviewing sample worker summaries' });
      team.reviewTimer = window.setTimeout(() => review(team), 350);
    }
  }
  function start(sessionId: unknown, text: unknown, imageIds?: unknown): void {
    const parent = host.parent(sessionId); host.assertIdle(parent);
    if (parent.archived || parent.taskStage === 'completed') throw new Error('Reopen this task before starting its team.');
    if (parent.goalState?.status === 'active') throw new Error('Pause the task goal before starting an architect team.');
    get(parent.id);
    const team = teams.get(parent.id);
    if (!team) throw new Error('Configure workers before starting an architect team.');
    if (['running', 'waiting'].includes(team.snapshot.status)) throw new Error('This team is already active.');
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 128 * 1024) throw new Error('Write a task under 128 KiB.');
    if (imageIds != null && (!Array.isArray(imageIds) || imageIds.length > 8 || imageIds.some(id => typeof id !== 'string'))) throw new Error('Invalid image attachments.');
    applyPending(team);
    const available = team.snapshot.config.maxAssignments - team.runs.length;
    if (available <= 0) throw new Error('Worker assignment limit reached. Increase the run limit before starting more work.');
    parent.status = 'running'; parent.taskStage = 'in_progress'; parent.completedAt = null; parent.updatedAt = Date.now();
    if (parent.title === 'New conversation') parent.title = text.trim().slice(0, 48);
    host.append(parent.id, 'user', text.trim());
    team.snapshot.status = 'running'; team.snapshot.round = 1; team.snapshot.summary = null; team.snapshot.error = null;
    team.batchStart = team.runs.length;
    // An auto lead with no roster staffs the sample batch with its own model.
    const roster = team.snapshot.config.workers;
    const staff = !team.snapshot.config.auto ? roster : roster.length ? roster.slice(0, 2) : [{ id: 'auto', name: parent.model || 'Default model', provider: parent.provider, model: parent.model, reasoningEffort: parent.reasoningEffort ?? null }];
    const batch = staff.slice(0, available).map((profile, index) => {
      const time = Date.now();
      const worker: TeamWorker = { ...profile, id: crypto.randomUUID(), sessionId: crypto.randomUUID(), profileId: profile.id, status: 'queued', assignment: `Sample assignment ${index + 1}: ${text.trim().slice(0, 320)}`, summary: '', dependsOn: [], files: [`sample/assignment-${team.batchStart + index + 1}`], readOnly: false, attempt: 1, createdAt: time, updatedAt: time };
      const run: WorkerRun = { worker, cursor: 0, messages: [], output: `**${profile.name}** is exploring sample assignment ${index + 1}.\n\nI would inspect the relevant files, make a focused change, and report the result to the architect. This preview demonstrates a separate worker conversation and streamed progress.\n\n${sampleNotice}` };
      workerMessage(run, 'user', worker.assignment); return run;
    });
    team.runs.push(...batch);
    team.snapshot.workers = team.runs.map(run => run.worker);
    host.agent({ sessionId: parent.id, kind: 'status', text: 'Planning sample worker assignments' });
    const planning = `I’ll coordinate ${batch.length} sample worker${batch.length === 1 ? '' : 's'} and review their summaries. ${sampleNotice}`;
    host.append(parent.id, 'assistant', planning);
    host.agent({ sessionId: parent.id, kind: 'text', text: planning });
    schedule(team);
  }
  function control(sessionId: unknown, action: unknown): TeamSnapshot {
    const parent = host.parent(sessionId); get(parent.id);
    const team = teams.get(parent.id);
    if (!team) throw new Error('This task has no architect team.');
    if (!['pause', 'resume', 'stop'].includes(String(action))) throw new Error('Choose pause, resume, or stop.');
    if (action === 'resume') {
      if (!['paused', 'interrupted', 'failed'].includes(team.snapshot.status)) throw new Error('Only an interrupted team can resume.');
      const restart = team.snapshot.status !== 'paused' || Boolean(team.snapshot.error);
      if (parent.archived || parent.taskStage === 'completed') throw new Error('Reopen this task before resuming its team.');
      host.assertIdle(parent);
      applyPending(team);
      // Like the native team: Resume at the round limit grants a few more rounds, up to 20.
      if (team.snapshot.round >= team.snapshot.config.maxRounds) {
        if (team.snapshot.round >= 20) throw new Error('This team used all 20 architect rounds. Send a message to continue.');
        team.snapshot.config = { ...team.snapshot.config, maxRounds: Math.min(20, team.snapshot.round + 4) };
      }
      parent.status = 'running'; team.snapshot.status = 'running'; team.snapshot.error = null;
      for (const run of team.runs.slice(team.batchStart)) if (run.worker.status === 'stopped' || run.worker.status === 'failed') {
        if (restart) { run.cursor = 0; run.worker.attempt++; }
        run.worker.status = 'queued';
      }
      host.agent({ sessionId: parent.id, kind: 'status', text: 'Resuming sample workers' });
      schedule(team); return structuredClone(team.snapshot);
    }
    if (!active(team)) throw new Error('This team is not running.');
    window.clearTimeout(team.reviewTimer); team.reviewTimer = undefined;
    for (const run of team.runs) {
      window.clearTimeout(run.timer); run.timer = undefined;
      if (['queued', 'running', 'waiting'].includes(run.worker.status)) {
        if (action === 'stop' && run.cursor) workerMessage(run, 'assistant', run.output.slice(0, run.cursor));
        run.worker.status = 'stopped'; run.worker.updatedAt = Date.now();
        // Pausing keeps the visible sample buffer intact; stopping finalizes its transcript.
        if (action === 'stop') host.agent({ sessionId: run.worker.sessionId, kind: 'done', text: 'Stopped' });
      }
    }
    parent.status = 'idle'; parent.updatedAt = Date.now();
    applyPending(team);
    team.snapshot.status = 'paused';
    team.snapshot.error = action === 'stop' ? 'Team stopped. Resume explicitly to retry unfinished work.' : null;
    host.finishTiming(parent.id); host.agent({ sessionId: parent.id, kind: 'done', text: action === 'pause' ? 'Paused' : 'Stopped' });
    return publish(team);
  }
  function workerMessages(sessionId: unknown, workerId: unknown, beforeId?: unknown): MessagePage {
    const parent = host.parent(sessionId);
    const run = teams.get(parent.id)?.runs.find(run => run.worker.id === workerId);
    if (!run) throw new Error('Worker does not belong to this task.');
    if (beforeId != null && (!Number.isSafeInteger(beforeId) || Number(beforeId) < 1)) throw new Error('Invalid message cursor.');
    const eligible = run.messages.filter(message => beforeId == null || message.id < Number(beforeId));
    return structuredClone({ messages: eligible.slice(-100), hasOlder: eligible.length > 100 });
  }
  function teamMessages(sessionId: unknown, afterId: unknown = 0, limit: unknown = 50): TeamMessagePage {
    const parent = host.parent(sessionId);
    const team = teams.get(parent.id);
    if (!team) throw new Error('This task has no architect team.');
    if (!Number.isSafeInteger(afterId) || Number(afterId) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new Error('Invalid team message cursor or page size.');
    const eligible = (team.messages ?? []).filter(message => message.id > Number(afterId));
    const messages = eligible.slice(0, Number(limit));
    return structuredClone({ messages, nextCursor: messages.at(-1)?.id ?? Number(afterId), hasMore: eligible.length > messages.length });
  }
  function remove(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const team = teams.get(sessionId);
      if (team) { window.clearTimeout(team.reviewTimer); for (const run of team.runs) window.clearTimeout(run.timer); }
      teams.delete(sessionId); configs.delete(sessionId);
    }
    persist();
  }
  return { get, configure, profiles, setLeadGuidance, saveProfile, deleteProfile, inherit, start, control, workerMessages, teamMessages, remove, isActive: (sessionId: string) => active(teams.get(sessionId)) };
}
