import type { CouncilConfig, ModelSelection, TeamConfig, TeamLibrary, TeamMessage, TeamMessagePage, TeamSetup, TeamSnapshot, TeamWorker, WorkerProfile } from './architect-types';
import type { AgentEvent, Message, MessagePage, ProviderId, ProviderModel, Session } from './types';
import { workerQueueReason } from './worker-scheduling.ts';
import { formatScore } from './council.ts';
import type { CouncilStatus } from './architect-types';

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
const showcase = typeof location !== 'undefined' && new URLSearchParams(location.search).has('workers');
const sampleNotice = 'Browser preview — sample output only. No model, command, or file operation is running.';

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
    if (!selection || !['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'hermes', 'cursor'].includes(selection.provider) || typeof selection.model !== 'string' || selection.model.length > 200) throw new Error('Choose a valid architect harness and model.');
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
  /** Like the native command: a sane range, or a refusal. */
  function validCouncil(council: CouncilConfig): CouncilConfig {
    if (!council || typeof council.target !== 'number' || !(council.target > 0 && council.target <= 10)) throw new Error('A council target is between 0 and 10.');
    return { target: council.target, maxRounds: integer(council.maxRounds, 1, 100, 'Council rounds'), reviewers: integer(council.reviewers, 0, 8, 'Council reviewers') };
  }
  function validate(config: TeamConfig): TeamConfig {
    // Auto teams carry an optional roster (the lead picks models); configured teams name at least one profile.
    const [min, max] = config?.auto ? [0, 24] : [1, Infinity];
    if (!config || !Array.isArray(config.workers) || config.workers.length < min || config.workers.length > max) throw new Error(config?.auto ? 'Auto teams list at most 24 models.' : 'Add at least one worker profile.');
    const ids = new Set<string>();
    const workers = config.workers.map((profile): WorkerProfile => {
      if (!profile || typeof profile.id !== 'string' || !profile.id.trim() || profile.id.length > 100 || ids.has(profile.id)) throw new Error('Worker profile IDs must be unique.');
      ids.add(profile.id);
      if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80) throw new Error('Worker names must be 1–80 characters.');
      if (!['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'hermes', 'cursor'].includes(profile.provider) || typeof profile.model !== 'string' || profile.model.length > 200) throw new Error('Choose a valid worker harness and model.');
      const models = host.models(profile.provider);
      const model = profile.model ? models.find(model => model.id === profile.model) : models[0];
      if (profile.reasoningEffort != null && (typeof profile.reasoningEffort !== 'string' || profile.reasoningEffort.length > 32 || model && !model.reasoningEfforts?.some(effort => effort.id === profile.reasoningEffort))) throw new Error('This worker model does not support that reasoning effort.');
      return { id: profile.id, name: profile.name.trim(), provider: profile.provider, model: profile.model, reasoningEffort: profile.reasoningEffort ?? null };
    });
    if (config.workspace !== 'shared') throw new Error('Workers must use the task’s shared workspace.');
    if (config.rosterOnly && (!config.auto || !workers.length)) throw new Error('A named agent team needs at least one model.');
    if (config.name != null && (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80)) throw new Error('Team names must be 1–80 characters.');
    const guidance = typeof config.leadGuidance === 'string' ? config.leadGuidance.trim() : '';
    return { ...(config.auto ? { auto: true } : {}), ...(config.rosterOnly ? { rosterOnly: true } : {}), ...(config.name != null ? { name: config.name } : {}), ...(guidance ? { leadGuidance: guidance } : {}), workers, ...(Array.isArray(config.catalog) && config.catalog.length ? { catalog: config.catalog.slice(0, 1000).map(p => ({ ...p })) } : {}), maxParallel: integer(config.maxParallel, 0, Number.MAX_SAFE_INTEGER, 'Parallel workers'), maxRounds: config.maxRounds, maxAssignments: config.maxAssignments, workspace: 'shared', summaryLimit: config.summaryLimit };
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [sessionId, config] of Object.entries(saved).slice(0, 100)) {
        try { host.parent(sessionId); configs.set(sessionId, { ...validate(config), ...(config.council ? { council: validCouncil(config.council) } : {}) }); } catch { /* Removed tasks and invalid older setups are ignored. */ }
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
      for (const profile of Array.isArray(saved.profiles) ? saved.profiles : []) {
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
    if (text.includes('\0')) throw new Error('Lead guidance must be plain text.');
    library = { ...library, leadGuidance: text || undefined };
    persistLibrary();
    return profiles();
  }
  function saveProfile(id: unknown, name: unknown, setup: TeamSetup): TeamLibrary {
    const checkedName = profileName(name), checked = validateSetup(setup);
    const existing = id == null ? undefined : library.profiles.find(profile => profile.id === id);
    if (id != null && !existing) throw new Error('Team profile not found.');
    if (library.profiles.some(profile => profile.id !== existing?.id && profile.name.toLowerCase() === checkedName.toLowerCase())) throw new Error('A team profile with this name already exists.');
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
  /** `?workers`: a running team with a worker in every state, for the compact workers list. */
  function seedShowcase(parent: Session): void {
    const now = Date.now(), minute = 60_000;
    const profiles: WorkerProfile[] = [
      { id: 'builder', name: 'Builder', provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' },
      { id: 'reviewer', name: 'Reviewer', provider: 'claude', model: 'sonnet', reasoningEffort: 'medium' },
      { id: 'scout', name: 'Scout', provider: 'claude', model: 'haiku', reasoningEffort: null },
    ];
    const config: TeamConfig = { auto: true, workers: profiles, maxParallel: 3, maxRounds: 4, maxAssignments: 8, workspace: 'shared', summaryLimit: 1800 };
    const sample = (id: string, profile: number, name: string, changes: Partial<TeamWorker>): TeamWorker => ({
      ...profiles[profile], id, name, sessionId: `${parent.id}-showcase-${id}`, profileId: profiles[profile].id, status: 'running',
      assignment: `${name}: sample assignment. Explore the relevant files, make one focused change and report back with a concise summary.\n\n${sampleNotice}`,
      summary: '', dependsOn: [], files: [`src/${id}.ts`], attempt: 1, createdAt: now - 4 * minute, updatedAt: now - minute, ...changes,
    });
    const workers: TeamWorker[] = [
      // A follow-up: created a while ago, its current run started two minutes back.
      sample('search', 0, 'Make search results stream as they arrive', { createdAt: now - 26 * minute, startedAt: now - 2 * minute }),
      sample('styles', 0, 'Compact the results list styles', { reasoningEffort: 'xhigh', attempt: 2, createdAt: now - 95_000 }),
      sample('tests', 1, 'Review the search tests', { status: 'completed', summary: 'Added three cases for empty, partial and streamed results; all pass.', createdAt: now - 80 * minute, updatedAt: now - 5 * minute }),
      sample('index', 1, 'Rebuild the index on change', { status: 'failed', attempt: 2, error: 'The sample build step failed: index.ts has a type error.', note: 'Asked for high effort; this model ran at medium.', createdAt: now - 12 * minute, updatedAt: now - 7 * minute }),
      sample('docs', 2, 'Document the search shortcuts', { status: 'queued', dependsOn: ['search'], readOnly: true, note: 'Claude Haiku 4.5 has no reasoning effort setting, so it runs at its default.' }),
      sample('audit', 2, 'Audit search accessibility', { status: 'stopped', createdAt: now - 27 * 60 * minute, updatedAt: now - 60 * minute }),
    ];
    const runs = workers.map((worker): WorkerRun => ({ worker, output: '', cursor: 0, messages: [{ id: host.nextMessageId(), sessionId: worker.sessionId, role: 'user', content: worker.assignment, createdAt: worker.createdAt }] }));
    teams.set(parent.id, { snapshot: { sessionId: parent.id, config, status: 'running', round: 1, revision: 1, workers, updatedAt: now }, runs, batchStart: 0, messages: [] });
    // The legacy fallback: an older host that does not auto-approve asks the user directly.
    window.setTimeout(() => host.agent({ sessionId: workers[1].sessionId, kind: 'approval', requestId: 'showcase-approval', text: `Run \`npm run lint\` in the shared checkout? ${sampleNotice}` }), 250);
  }
  /** What native sends, set explicitly: the mock keeps no copy of native's state machine. */
  const status = (council: CouncilConfig, over: Partial<CouncilStatus> = {}): CouncilStatus => ({ state: 'waiting', round: 0, lowest: null, target: council.target, stale: false, notice: null, ...over });
  /** Rests the team asking the user, as native does: status 'asking' with native's notice, and a refusal for the lead in
   *  `team.error` that the app never shows. */
  function askFor(team: TeamRun): void {
    const council = team.snapshot.config.council, now = team.snapshot.councilStatus;
    if (!council || !now) return;
    for (const worker of team.snapshot.workers) if (worker.status === 'running') worker.status = 'completed';
    const lowest = formatScore(now.lowest ?? 0), target = formatScore(council.target);
    team.snapshot.status = 'ready';
    team.snapshot.error = `Council round ${now.round}: lowest ${lowest}, target ${target}. Fix the blockers with workers, then dispatch a new round with councilLens.`;
    team.snapshot.councilStatus = status(council, { ...now, state: 'asking', notice: `The lead is asking how to continue: lowest score ${Number(lowest).toFixed(1)}, target ${Number(target).toFixed(1)}, after round ${now.round}.` });
  }
  function publish(team: TeamRun): TeamSnapshot {
    team.snapshot.revision++; team.snapshot.updatedAt = Date.now();
    host.emit(structuredClone(team.snapshot));
    return structuredClone(team.snapshot);
  }
  function active(team: TeamRun | undefined): boolean { return !!team && ['running', 'waiting', 'paused'].includes(team.snapshot.status); }
  function get(sessionId: unknown): TeamSnapshot | null {
    const parent = host.parent(sessionId);
    if (showcase && !teams.has(parent.id)) seedShowcase(parent);
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
    // Validation completes before either task or remembered default changes.
    library = { ...library, enabled: true, lastSetup: structuredClone(checked), activeProfileId: profileId ?? null };
    persistLibrary();
    if (existing) {
      // Choosing another team keeps the thread's council; it is never part of a remembered setup.
      if (existing.snapshot.config.council) checked.config.council = existing.snapshot.config.council;
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
    // Like native's with_council: the thread's council is not part of a setup, so a newer council survives it.
    const council = team.snapshot.config.council;
    team.snapshot.config = { ...structuredClone(setup.config), ...(council ? { council } : {}) }; team.snapshot.pendingSetup = null;
    configs.set(parent.id, structuredClone(team.snapshot.config)); persist();
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
    run.worker.summary = run.output;
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
    team.snapshot.status = 'completed'; team.snapshot.summary = output;
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
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw new Error('Write a task under 16 MiB.');
    if (imageIds != null && (!Array.isArray(imageIds) || imageIds.length > 8 || imageIds.some(id => typeof id !== 'string'))) throw new Error('Invalid image attachments.');
    applyPending(team);
    parent.status = 'running'; parent.taskStage = 'in_progress'; parent.completedAt = null; parent.updatedAt = Date.now();
    if (parent.title === 'New conversation') parent.title = text.trim().slice(0, 48);
    host.append(parent.id, 'user', text.trim());
    // A message continues an unsettled council cycle (after Stop or pause); only a settled one gives way to a new cycle.
    const council = team.snapshot.config.council, now = team.snapshot.councilStatus;
    const fresh = !now || ['waiting', 'passed', 'limit'].includes(now.state);
    if (fresh) team.snapshot.councilSince = Date.now();
    if (council) team.snapshot.councilStatus = fresh ? status(council) : { ...now, state: now.state === 'asking' ? 'fixing' : now.state, notice: null };
    team.snapshot.status = 'running'; team.snapshot.round = 1; team.snapshot.summary = null; team.snapshot.error = null;
    team.batchStart = team.runs.length;
    // An auto lead with no roster staffs the sample batch with its own model.
    const roster = team.snapshot.config.workers;
    const staff = !team.snapshot.config.auto ? roster : roster.length ? roster.slice(0, 2) : [{ id: 'auto', name: parent.model || 'Default model', provider: parent.provider, model: parent.model, reasoningEffort: parent.reasoningEffort ?? null }];
    const batch = staff.map((profile, index) => {
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
  function setCouncil(sessionId: unknown, council: CouncilConfig | null): TeamSnapshot | null {
    const parent = host.parent(sessionId); get(parent.id);
    const team = teams.get(parent.id);
    if (!team) return null;
    const checked = council === null ? null : validCouncil(council);
    team.snapshot.config = { ...team.snapshot.config, council: checked };
    const now = team.snapshot.councilStatus;
    team.snapshot.councilStatus = checked && (now ? { ...now, target: checked.target } : status(checked));
    // Like native: raising the limit on a team stopped at it wakes the lead once, and the council is fixing again.
    if (now?.state === 'limit' && checked && checked.maxRounds > now.round) { team.snapshot.councilStatus = status(checked, { ...now, target: checked.target, state: 'fixing', notice: null }); team.snapshot.status = 'running'; team.snapshot.error = null; }
    // Like native: lowering the target to the lowest score ends asking (the lead is woken to finish); still below, it keeps asking.
    if (now?.state === 'asking' && checked && now.lowest !== null) {
      if (now.lowest >= checked.target) { team.snapshot.councilStatus = status(checked, { ...now, target: checked.target, state: 'passed', notice: null }); team.snapshot.error = null; }
      else team.snapshot.councilStatus = status(checked, { ...now, target: checked.target, notice: `The lead is asking how to continue: lowest score ${Number(now.lowest).toFixed(1)}, target ${Number(checked.target).toFixed(1)}, after round ${now.round}.` });
    }
    // Like native's status_in: a team that finished below target reads passed once the target comes down to its lowest.
    if (!active(team) && now && checked && now.lowest !== null && ['fixing', 'reviewing', 'dispatch'].includes(now.state) && now.lowest >= checked.target) team.snapshot.councilStatus = status(checked, { ...now, target: checked.target, state: 'passed', notice: null });
    configs.set(parent.id, structuredClone(team.snapshot.config)); persist();
    return publish(team);
  }
  /** Preview and tests: give a council seat its score (completing it), or add a seat, running while unscored. */
  function councilSeat(sessionId: unknown, { round, lens, score, status: workerStatus, council, error }: { round: number; lens: string; score: number | null; status?: TeamWorker['status']; council?: Partial<CouncilStatus>; error?: string | null }): TeamSnapshot {
    const parent = host.parent(sessionId), team = teams.get(parent.id);
    if (!team) throw new Error('This task has no architect team.');
    const time = Date.now(), existing = team.snapshot.workers.find(worker => worker.council?.round === round && worker.council.lens === lens);
    const settled: TeamWorker['status'] = workerStatus ?? (score === null ? 'running' : 'completed');
    if (existing) Object.assign(existing, { status: settled, updatedAt: time, council: { ...existing.council!, score } });
    else {
      const worker: TeamWorker = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), profileId: 'auto', name: lens, provider: parent.provider, model: parent.model, reasoningEffort: null, status: settled, assignment: `Score the work out of 10 for ${lens.toLowerCase()}.`, summary: sampleNotice, dependsOn: [], files: [], readOnly: true, attempt: 1, createdAt: time, updatedAt: time, council: { round, lens, score, startedAt: time } };
      const run: WorkerRun = { worker, output: sampleNotice, cursor: sampleNotice.length, messages: [] };
      workerMessage(run, 'user', worker.assignment);
      team.runs.push(run); team.snapshot.workers = [...team.snapshot.workers, worker];
    }
    // The test says what native would report now.
    if (error !== undefined) team.snapshot.error = error;
    // Like native: the status follows the latest round's scored seats; a test may then say what else native reports.
    const now = team.snapshot.councilStatus;
    if (now && team.snapshot.config.council) {
      const latest = Math.max(now.round, round), since = team.snapshot.councilSince ?? 0;
      const scores = team.snapshot.workers.filter(worker => worker.council?.round === latest && worker.createdAt >= since && typeof worker.council.score === 'number').map(worker => worker.council!.score!);
      // A seat opening a new round, or one still unscored in it, means the round is under review, as native reports.
      const seats = team.snapshot.workers.filter(worker => worker.council?.round === latest && worker.createdAt >= since);
      const reviewing = round > now.round || seats.some(worker => worker.status === 'running');
      const lowest = scores.length ? Math.min(...scores) : null, target = team.snapshot.config.council.target;
      // Once every seat of the round is scored, native moves on: passed at or above target, else fixing.
      const complete = !reviewing && seats.length > 0 && scores.length === seats.length && lowest !== null && ['reviewing', 'dispatch'].includes(now.state);
      const moved = reviewing ? { state: 'reviewing' as const } : complete ? { state: lowest >= target ? 'passed' as const : 'fixing' as const } : {};
      team.snapshot.councilStatus = status(team.snapshot.config.council, { ...now, round: latest, lowest, ...moved, ...council });
    }
    return publish(team);
  }
  /** `architect_council_accept`: the user accepts this cycle's result; Council stays on. */
  function councilAccept(sessionId: unknown): TeamSnapshot {
    const parent = host.parent(sessionId), team = teams.get(parent.id), now = team?.snapshot.councilStatus;
    if (!team || !now || !team.snapshot.config.council) throw new Error('This task has no Council to accept.');
    team.snapshot.councilStatus = { ...now, state: 'accepted', notice: null }; team.snapshot.error = null;
    return publish(team);
  }
  /** Preview and tests: the team rests asking the user, like native after the lead's one Continue. */
  function councilAsk(sessionId: unknown): TeamSnapshot {
    const parent = host.parent(sessionId), team = teams.get(parent.id);
    if (!team) throw new Error('This task has no architect team.');
    askFor(team); parent.status = 'idle';
    return publish(team);
  }
  /** `?council` in the preview: a team partway through a council, in the named state. */
  function seedCouncil(sessionId: string, kind: string): void {
    const parent = host.parent(sessionId), council = { target: 9.5, maxRounds: kind === 'limit' ? 2 : 10, reviewers: 0 };
    const rounds: Record<string, (number | null)[][]> = {
      fixing: [[8.3, 9.1, 8.8]],
      finished: [[8.3, 9.1, 8.8]],
      asking: [[8.3, 9.1, 8.8]],
      accepted: [[8.3, 9.1, 8.8]],
      passed: [[8.3, 9.1, 8.8], [9.5, 9.6, 9.7]],
      limit: [[8.3, 9.1, 8.8], [8.7, 9.6, 9]],
    };
    const lenses = ['Correctness', 'Security', 'User experience'], models = host.models(parent.provider);
    // What native reports for each scenario.
    const reported: Record<string, Partial<CouncilStatus>> = {
      fixing: { state: 'fixing', round: 1, lowest: 8.3, stale: true }, finished: { state: 'fixing', round: 1, lowest: 8.3 }, asking: { state: 'fixing', round: 1, lowest: 8.3 },
      passed: { state: 'passed', round: 2, lowest: 9.5 }, limit: { state: 'limit', round: 2, lowest: 8.7 },
      accepted: { state: 'accepted', round: 1, lowest: 8.3 }, cycle: { state: 'reviewing', round: 1, lowest: 9.2 },
    };
    const base = Date.now() - 3_600_000;
    const profile = { provider: parent.provider, model: models[0]?.id ?? parent.model, reasoningEffort: null };
    const make = (name: string, assignment: string, at: number, extra: Partial<TeamWorker>): TeamWorker => ({ ...profile, id: crypto.randomUUID(), sessionId: crypto.randomUUID(), profileId: 'auto', name, status: 'completed', assignment, summary: sampleNotice, dependsOn: [], files: [], attempt: 1, createdAt: at, updatedAt: at + 60_000, ...extra });
    const seats = (rounds[kind] ?? [[8.3, 9.1, 8.8], [9.2, 9.4, null]]).flatMap((scores, index) => scores.map((score, seat) => make(lenses[seat], `Score the work out of 10 for ${lenses[seat].toLowerCase()}.`, base + 600_000 * (index + 1) + seat * 1000, { readOnly: true, status: score === null ? 'running' : 'completed', council: { round: kind === 'cycle' ? 1 : index + 1, lens: lenses[seat], score, startedAt: base + 600_000 * (index + 1) + seat * 1000 } })));
    const writer = make('Fix the findings', 'Fix what the first round found.', base + 900_000, { readOnly: false, files: ['src/search.ts'], status: kind === 'fixing' ? 'running' : 'completed', updatedAt: base + (kind === 'fixing' ? 1_500_000 : 1_100_000),
      // `fixing`: the writer is still running after round 1 began, so that round is stale below target, as native reports it.
      ...(kind === 'fixing' ? { wroteAt: base + 1_500_000 } : {}) });
    const workers = [...seats, writer].sort((a, b) => a.createdAt - b.createdAt);
    const running = kind === 'fixing' || !rounds[kind];
    const config: TeamConfig = { auto: true, workers: [], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072, council };
    parent.status = running ? 'running' : 'idle';
    configs.set(parent.id, config);
    // `cycle`: round 1 belongs to an earlier objective, so it shows as plain rows beside round 2's scorecard.
    const councilSince = kind === 'cycle' ? base + 1_200_000 : base;
    // `asking`: below target after the lead's one Continue, resting ready with native's refusal, the lead's question last in the thread.
    const asking = kind === 'asking';
    if (asking) host.append(parent.id, 'assistant', 'Round 1 scored 8.3 on correctness: the search index still rebuilds on every keystroke. **Should I keep fixing, or would you like to lower the target to 8.5?**');
    const snapshot: TeamSnapshot = { sessionId: parent.id, config, status: running ? 'running' : asking ? 'ready' : 'completed', round: 1, revision: 1, councilSince, workers, updatedAt: Date.now() };
    const runs = workers.map(worker => {
      const run: WorkerRun = { worker, output: sampleNotice, cursor: sampleNotice.length, messages: [] };
      workerMessage(run, 'user', worker.assignment); workerMessage(run, 'assistant', worker.council?.score != null ? `Score: ${worker.council.score}/10. ${sampleNotice}` : sampleNotice);
      return run;
    });
    const seeded: TeamRun = { snapshot: { ...snapshot, councilStatus: status(council, reported[kind] ?? { state: 'reviewing', round: 2, lowest: 9.2 }) }, runs, batchStart: 0 };
    if (asking) askFor(seeded);
    teams.set(parent.id, seeded);
  }
  function remove(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const team = teams.get(sessionId);
      if (team) { window.clearTimeout(team.reviewTimer); for (const run of team.runs) window.clearTimeout(run.timer); }
      teams.delete(sessionId); configs.delete(sessionId);
    }
    persist();
  }
  return { get, configure, setCouncil, seedCouncil, councilSeat, councilAsk, councilAccept, profiles, setLeadGuidance, saveProfile, deleteProfile, inherit, start, control, workerMessages, teamMessages, remove, isActive: (sessionId: string) => active(teams.get(sessionId)) };
}
