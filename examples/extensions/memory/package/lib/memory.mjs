// Project memory (sample.memory): the whole logic, as one browser-safe ES module (no imports, no Node, nothing but the
// `panda` it is handed and the `store` main.cjs hands in).
//
// What it does: a public model tool `memory` (add, search, list, forget), recall appended to the user's message at send
// (`prompt.submit` returning `{ context }`), and capture after a turn (`turn.finish` and `task.idle`, debounced): it reads the
// turn through the host's transcript and tools reads, asks for a summary with one `panda.models.call`, drops what sits inside
// <private> tags, skips a near duplicate and stores the rest. The scorer is deterministic (shared words) so tests are exact;
// a real package would use an embedding model.
//
// Compaction: recall comes back on the turn after a compaction (`sinceCompaction` is 0 there). Whether a harness's own
// compaction could be shaped by a companion is NOT claimed: companions are deferred (user decision 2026-11-17), so the status
// says "pending" and no code path pretends otherwise.

export const IDS = Object.freeze({
  owner: 'sample.memory',
  tool: 'sample.memory/memory',
  view: 'sample.memory/memories',
  page: 'sample.memory/settings',
  open: 'sample.memory/open',
  control: 'sample.memory/control',
});

export const DEFAULTS = Object.freeze({ inject: 'first', count: 3, debounceMs: 10000, capture: true });
export const DUPLICATE = 0.9;
export const COMPANION = 'pending - companions deferred, user decision 2026-11-17';
export const PRIVATE_BLOCKED = 'Private content blocked';
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'not', 'but', 'have', 'has', 'can', 'will', 'its', 'into', 'about']);
const SUMMARY_SYSTEM = 'Summarize the work of this turn as one short memory (at most two sentences) that would help in a later session of the same project. Reply with the memory only.';

// ---- pure helpers (also read by tests/extensions-example-memory.test.mjs) ---------------------------------------------------

export const stripPrivate = text => String(text ?? '').replace(/<private>[\s\S]*?<\/private>/gi, '').replace(/<private>[\s\S]*$/i, '').replace(/[ \t]+\n/g, '\n').trim();
export const hasPrivate = text => /<private>/i.test(String(text ?? ''));
export const tokens = text => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter(word => !STOP.has(word)));
/** Jaccard similarity of two texts: 1 for the same words, used for the duplicate rule. */
export function similarity(a, b) {
  const left = tokens(a), right = tokens(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
/** Share of the query's words that the memory holds: the order of search and recall. */
export function relevance(query, memory) {
  const wanted = tokens(query);
  if (!wanted.size) return 0;
  const held = tokens(`${memory.text} ${(memory.tags ?? []).join(' ')}`);
  let shared = 0;
  for (const word of wanted) if (held.has(word)) shared += 1;
  return shared / wanted.size;
}
export const shorten = (text, limit) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`; };
export function tagsOf(text, count = 3) {
  const seen = new Map();
  for (const word of String(text ?? '').toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []) if (!STOP.has(word)) seen.set(word, (seen.get(word) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, count).map(item => item[0]);
}
export function rank(memories, query, { project, scope = 'project', limit = 5 } = {}) {
  return memories
    .filter(memory => scope === 'all-projects' || !project || memory.project === project)
    .map(memory => ({ memory, score: relevance(query, memory) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.memory.id < b.memory.id ? -1 : 1))
    .slice(0, limit);
}
export const recallText = items => items.map(item => `- ${item.memory.text}${item.memory.tags?.length ? ` [${item.memory.tags.join(', ')}]` : ''}`).join('\n');
export function capturePrompt(turn) {
  return `User asked:\n${shorten(turn.user, 1500)}\n\nAssistant answered:\n${shorten(turn.assistant, 2500)}${turn.tools.length ? `\n\nTool calls: ${turn.tools.join('; ')}` : ''}`;
}
export const rawMemory = turn => shorten(`${turn.user} -> ${turn.assistant}${turn.tools.length ? ` (tools: ${turn.tools.join('; ')})` : ''}`, 600);

const code = error => (error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'Failed');
const whole = (value, low, high, fallback) => { const number = Number.parseInt(String(value ?? '').trim(), 10); return Number.isFinite(number) && number >= low && number <= high ? number : fallback; };
export function readSettings(values) {
  const inject = String(values?.inject ?? '').trim().toLowerCase();
  const capture = String(values?.capture ?? '').trim().toLowerCase();
  return {
    inject: inject === 'always' ? 'always' : 'first',
    count: whole(values?.count, 1, 10, DEFAULTS.count),
    debounceMs: whole(values?.debounce, 0, 600000, DEFAULTS.debounceMs),
    capture: capture === 'off' ? false : true,
  };
}

// ---- the service ------------------------------------------------------------------------------------------------------

/**
 * `store`: { load(): Promise<{ nextId:number, items:Memory[] }>, save(data): Promise<void> }.
 * Memory: { id, project, text, tags, at, source:'tool'|'capture', raw? }.
 */
export async function run(panda, lifetime, store, options = {}) {
  const now = options.now ?? (() => Date.now());
  const disposers = [];
  let stopped = false;
  const data = await store.load();
  data.items = Array.isArray(data.items) ? data.items : [];
  data.nextId = Number.isInteger(data.nextId) ? data.nextId : data.items.length + 1;
  const state = {
    settings: { ...DEFAULTS }, project: null, recalled: new Set(), captured: new Set(), timers: new Map(), refused: [], receipts: [],
    tool: 'unknown', recall: 'unknown', capture: 'unknown', usage: [], notes: [], unavailable: [], skippedPrivate: 0, skippedDuplicate: 0, captures: 0, recalls: 0,
  };
  const refuse = error => { state.refused.push(code(error)); return undefined; };
  const note = text => { if (!state.notes.includes(text)) state.notes.push(text); };
  const save = () => store.save(data);

  // ---- store operations -----------------------------------------------------------------------------------------------

  const add = async (project, text, source, extra = {}) => {
    const memory = { id: `m-${data.nextId}`, project, text, tags: tagsOf(text), at: now(), source, ...extra };
    data.nextId += 1;
    data.items.push(memory);
    await save();
    return memory;
  };
  const forget = async id => {
    const at = data.items.findIndex(item => item.id === id);
    if (at < 0) return false;
    data.items.splice(at, 1);
    await save();
    return true;
  };
  const view = memory => ({ id: memory.id, project: memory.project, text: memory.text, tags: memory.tags, at: memory.at, source: memory.source });

  // ---- the model tool ---------------------------------------------------------------------------------------------------

  const answer = (content, isError) => (isError ? { content, isError: true } : { content });
  const tool = async (input, call) => {
    const project = call?.projectId ?? state.project;
    const mode = input?.mode;
    if (mode === 'add') {
      const text = typeof input.content === 'string' ? input.content : '';
      const clean = stripPrivate(text);
      if (!clean) return answer({ success: false, error: PRIVATE_BLOCKED }, true);
      const memory = await add(project, clean, 'tool');
      void pushPanel();
      return answer({ success: true, id: memory.id });
    }
    if (mode === 'search') {
      const query = typeof input.query === 'string' ? input.query : typeof input.content === 'string' ? input.content : '';
      const hits = rank(data.items, query, { project, scope: input.scope === 'all-projects' ? 'all-projects' : 'project', limit: input.limit ?? 5 });
      return answer({ success: true, results: hits.map(item => ({ ...view(item.memory), score: Number(item.score.toFixed(3)) })) });
    }
    if (mode === 'list') {
      const items = data.items.filter(memory => memory.project === project).slice(-(input.limit ?? 20)).reverse();
      return answer({ success: true, memories: items.map(view) });
    }
    if (mode === 'forget') {
      if (typeof input.id !== 'string') return answer({ success: false, error: 'forget needs an id' }, true);
      const target = data.items.find(item => item.id === input.id);
      if (!target || target.project !== project) return answer({ success: false, error: `No memory ${input.id} in this project` }, true);
      await forget(input.id);
      void pushPanel();
      return answer({ success: true });
    }
    return answer({ success: false, error: 'Unknown mode' }, true);
  };

  // ---- recall at send ---------------------------------------------------------------------------------------------------

  const onPrompt = async turn => {
    const task = turn?.taskId ?? '';
    const project = turn?.projectId ?? state.project;
    const first = !state.recalled.has(task);
    // The turn after a compaction (sinceCompaction 0 on a task already seen) gets recall again: the summary may have dropped it.
    const afterCompaction = !first && turn?.sinceCompaction === 0;
    if (state.settings.inject === 'first' && !first && !afterCompaction) return undefined;
    state.recalled.add(task);
    const hits = rank(data.items, stripPrivate(turn?.text), { project, scope: 'project', limit: state.settings.count });
    if (!hits.length) return undefined;
    state.recalls += 1;
    return { context: recallText(hits) };
  };

  // ---- capture after a turn ---------------------------------------------------------------------------------------------

  const readTurn = async (taskId) => {
    const page = await panda.context.query({ resource: 'transcript', taskId, limit: 50 });
    const rows = (page?.items ?? []).filter(row => row && typeof row.text === 'string');
    const last = rows.reduce((top, row) => Math.max(top, Number(row.turn) || 0), 0);
    const mine = rows.filter(row => (Number(row.turn) || 0) === last);
    const user = mine.filter(row => row.role === 'user').map(row => row.text).join('\n');
    const assistant = mine.filter(row => row.role === 'assistant').map(row => row.text).join('\n');
    let tools = [];
    try {
      const calls = await panda.context.query({ resource: 'tools', taskId, limit: 50 });
      tools = (calls?.items ?? []).filter(item => (Number(item.turn) || 0) === last).map(item => `${item.tool?.name ?? 'tool'}(${shorten(typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? ''), 60)})`);
    } catch (error) { refuse(error); note('tool calls unavailable: captured without them'); }
    return { last, user, assistant, tools };
  };
  const capture = async (taskId, projectId) => {
    if (stopped || !state.settings.capture) return;
    let turn;
    try { turn = await readTurn(taskId); } catch (error) { refuse(error); note(`transcript unavailable (${code(error)}): nothing captured`); return; }
    const key = `${taskId}:${turn.last}`;
    if (state.captured.has(key)) return;
    const hadPrivate = hasPrivate(turn.user) || hasPrivate(turn.assistant);
    const clean = { ...turn, user: stripPrivate(turn.user), assistant: stripPrivate(turn.assistant) };
    if (!clean.user && !clean.assistant) { if (hadPrivate) state.skippedPrivate += 1; state.captured.add(key); return; }
    let text, raw = false;
    try {
      const result = await panda.models.call({ prompt: capturePrompt(clean), system: SUMMARY_SYSTEM, taskId, projectId, timeoutMs: 30000 });
      text = stripPrivate(result?.text);
      state.capture = 'model';
      state.usage.push({ harness: result?.harness ?? null, model: result?.model ?? null, input: result?.usage?.input ?? null, output: result?.usage?.output ?? null });
    } catch (error) {
      refuse(error);
      state.capture = `raw (${code(error)})`;
      note(`No model call (${code(error)}): the turn text is stored shortened.`);
    }
    if (!text) { text = rawMemory(clean); raw = true; }
    state.captured.add(key);
    const project = projectId ?? state.project;
    if (data.items.some(memory => memory.project === project && similarity(memory.text, text) >= DUPLICATE)) { state.skippedDuplicate += 1; return; }
    await add(project, text, 'capture', raw ? { raw: true } : {});
    state.captures += 1;
    void pushPanel();
  };
  const schedule = event => {
    if (stopped || !state.settings.capture || typeof event?.taskId !== 'string') return;
    clearTimeout(state.timers.get(event.taskId));
    state.timers.set(event.taskId, setTimeout(() => { state.timers.delete(event.taskId); void capture(event.taskId, event.projectId).catch(refuse); }, state.settings.debounceMs));
  };

  // ---- the panel --------------------------------------------------------------------------------------------------------

  const panel = panda.views;
  const status = () => ({
    tool: state.tool, recall: state.recall, capture: state.settings.capture ? state.capture : 'off', inject: state.settings.inject,
    unavailable: [...state.unavailable], notes: [...state.notes],
    compaction: { recallAfterCompaction: true, companion: COMPANION },
  });
  let query = '';
  const snapshot = () => {
    const project = state.project;
    const scoped = data.items.filter(memory => !project || memory.project === project);
    const items = query ? rank(scoped, query, { project, limit: 100 }).map(item => item.memory) : scoped.slice().reverse().slice(0, 100);
    return { kind: 'memories', project, query, total: scoped.length, items: items.map(view), status: status() };
  };
  const pushPanel = async instance => {
    if (!panel) return;
    try { await panel.post(IDS.view, snapshot(), instance ? { instance } : undefined); } catch (error) { refuse(error); }
  };
  const onPanel = async (message, from) => {
    if (message?.kind === 'search') { query = typeof message.query === 'string' ? message.query.slice(0, 200) : ''; }
    else if (message?.kind === 'delete' && typeof message.id === 'string') {
      const target = data.items.find(item => item.id === message.id);
      if (target) await forget(message.id);
    } else if (message?.kind !== 'list' && message?.kind !== 'ready') return;
    await pushPanel(message.kind === 'ready' ? from?.instanceId : undefined);
  };

  // ---- settings, hosts and wiring ---------------------------------------------------------------------------------------

  const loadSettings = async () => {
    try { const page = await panda.settings.get({ page: IDS.page }); state.settings = readSettings(page?.values); } catch (error) { refuse(error); }
  };
  const harnesses = async () => {
    try {
      const report = await panda.harnesses.list();
      state.unavailable = (report?.harnesses ?? []).filter(row => row?.toolServers?.value === false).map(row => row.name ?? row.id);
    } catch (error) { refuse(error); note(`Harness inventory unavailable (${code(error)}).`); }
  };
  const attach = (register, onReady) => {
    try { const handle = register(); disposers.push(handle); handle?.ready?.then(() => onReady('active'), error => { refuse(error); onReady(`inactive (${code(error)})`); }); } catch (error) { refuse(error); onReady(`inactive (${code(error)})`); }
  };

  attach(() => panda.modelTools.register(IDS.tool, guard(tool)), value => { state.tool = value; void pushPanel(); });
  attach(() => panda.hooks.on('prompt.submit', onPrompt), value => { state.recall = value; void pushPanel(); });
  // `turn.finish` and `task.idle` share one debounce: the second only moves the timer; one turn is captured once.
  try { disposers.push(panda.hooks.on('turn.finish', schedule)); disposers.push(panda.hooks.on('task.idle', schedule)); } catch (error) { refuse(error); }
  try {
    disposers.push(panda.hooks.onApplied(receipt => {
      state.receipts.push(receipt);
      if (receipt?.event === 'prompt.submit' && receipt.refused?.context) { state.recall = `inactive (${receipt.refused.context})`; note('Recall is not applied: harness.hooks.context is missing.'); void pushPanel(); }
    }));
  } catch (error) { refuse(error); }
  try {
    const events = panda.events;
    for (const kind of ['task.shown', 'project.opened']) disposers.push(events.on(kind, event => { if (typeof event?.projectId === 'string') { state.project = event.projectId; void pushPanel(); } }));
    disposers.push(events.on('settings.changed', async () => { await loadSettings(); void pushPanel(); }));
  } catch (error) { refuse(error); }
  if (panel) {
    try {
      disposers.push(panel.on('opened', instance => { void pushPanel(instance?.instanceId); }));
      disposers.push(panel.onMessage(IDS.view, (message, from) => onPanel(message, from).catch(refuse)));
    } catch (error) { refuse(error); }
  }
  try {
    disposers.push(panda.commands.register(IDS.control, async context => {
      const args = context?.args ?? {};
      if (args.op === 'state') return { ...status(), refused: [...state.refused], receipts: [...state.receipts], usage: [...state.usage], captures: state.captures, recalls: state.recalls, skippedPrivate: state.skippedPrivate, skippedDuplicate: state.skippedDuplicate, memories: data.items.length };
      throw Object.assign(new Error('InvalidShape'), { code: 'InvalidShape' });
    }));
  } catch (error) { refuse(error); }

  lifetime.onStop(() => {
    stopped = true;
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.timers.clear();
    for (const handle of disposers.splice(0).reverse()) { try { handle?.dispose?.(); } catch { /* the host disposes the rest */ } }
  });

  function guard(handler) { return async (...args) => { try { return await handler(...args); } catch (error) { refuse(error); return answer({ success: false, error: code(error) }, true); } }; }

  await loadSettings();
  await harnesses();
  return state;
}
