// Usage band (sample.usage): the whole logic of the package, as one browser-safe ES module (no imports, no Node, nothing but
// the `panda` it is handed). The installed service (main.cjs) and the browser preview load this same file.
//
// What it shows: one band segment above the composer for the task in view (`panda.composer.band`, registered per task with
// `scope: { taskId }`): the context fill as a percentage with a bar, and the tightest limit window ("5h: 63% left, resets
// 14:20"). Every number comes from a native resource the host serves (`usage` per task, `limits` and `accounts` per harness)
// or from the answer of the declared connection; nothing is read from a display string.
//
// What it never does: read or hold a credential. The connection's credential stays with the host (it only passes the opaque
// handle `status` gave it), and the band shows an account's label, never its e-mail, plan or token.
//
// env (all optional; the installed service and a test fill in what they need):
//   now()                       clock in ms
//   schedule(fn, ms) -> {cancel} timers (a test drives them by hand)
//   sleep(ms)                   pause between two polls of a connection request
//   ledger {read(), write(rows)} where the daily ledger lives (default: memory)
//   liveMs                      how often a running task's usage is read again (default 500)
//   pollMs                      pause between two polls of a running connection request (default 50)

export const OWNER = 'sample.usage';
export const IDS = Object.freeze({
  band: `${OWNER}/band`,
  report: `${OWNER}/report`,
  openReport: `${OWNER}/open-report`,
  startFresh: `${OWNER}/start-fresh`,
  insertCheckpoint: `${OWNER}/insert-checkpoint`,
  cleanUp: `${OWNER}/clean-up`,
  page: `${OWNER}/options`,
  api: `${OWNER}/api`,
  operation: 'usage',
  promptHook: `${OWNER}/prompt-note`,
  turnHook: `${OWNER}/turn-finish`,
  location: 'panda.composer.band',
});
export const LIMITS = Object.freeze({
  noteAbove: 70, fullAt: 80, lowLeft: 20, noteEveryMs: 300000, notesPerTask: 3, armMs: 8000, ledgerDays: 400,
  defaultIntervalSeconds: 300, maxIntervalSeconds: 86400,
});

const pad = value => String(value).padStart(2, '0');
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64);
const codeOf = error => (error && typeof error === 'object' && 'code' in error ? String(error.code) : 'Failed');
const TONES = ['neutral', 'success', 'info', 'warning', 'danger'];
const worse = (a, b) => (TONES.indexOf(a) >= TONES.indexOf(b) ? a : b);

/** The tone follows the thresholds: under 50, 50 to 70, 70 to 80, above. */
export const fillTone = fill => (fill < 50 ? 'success' : fill < 70 ? 'info' : fill < 80 ? 'warning' : 'danger');
export const formatReset = ms => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
export const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
export const fillOf = usage => (usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
  ? clamp(Math.round((usage.usedTokens / usage.contextWindow) * 100), 0, 100) : null);

/** A limit window as the band reads it: `left` is whole percent remaining, `resetsAt` is ms or null. */
export function toWindow(raw, source, stale) {
  const used = Number(raw?.usedPercent);
  if (!Number.isFinite(used)) return null;
  const at = typeof raw.resetsAt === 'number' ? raw.resetsAt : typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN;
  // The host's own windows are named by their label ("5h"); the API's by its id, marked as the API's.
  const name = source === 'api' ? `api ${raw.id ?? raw.label ?? 'window'}` : String(raw.label ?? raw.id ?? 'window');
  return { id: name, label: String(raw.label ?? raw.id ?? name), left: clamp(100 - Math.round(used), 0, 100), resetsAt: Number.isFinite(at) ? at : null, source, stale: Boolean(stale) };
}
export const tightest = windows => windows.reduce((best, item) => (best === null || item.left < best.left ? item : best), null);
export const windowText = item => `${item.id}: ${item.left}% left, resets ${item.resetsAt === null ? 'unknown' : formatReset(item.resetsAt)}${item.stale ? ' (stale)' : ''}`;

const memoryLedger = () => { let rows = []; return { read: async () => rows, write: async next => { rows = next; } }; };

export async function run(panda, lifetime, env = {}) {
  const now = env.now ?? (() => Date.now());
  const schedule = env.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; });
  const sleep = env.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const ledger = env.ledger ?? memoryLedger();
  const liveMs = env.liveMs ?? 500;
  const pollMs = env.pollMs ?? 50;
  const queryUsage = params => (panda.usage?.query ? panda.usage.query(params) : panda.context.query(params));

  let stopped = false;
  let settings = { intervalMs: LIMITS.defaultIntervalSeconds * 1000, afterReply: 'low' };
  let shown = null;
  const tasks = new Map();
  const native = new Map();            // harness key -> { account, label, status, stale, windows, readAt }
  const compactable = new Map();       // harness -> boolean
  const recorded = new Set();          // `${taskId}:${turn}` of a turn already in the ledger
  const timers = new Set();
  const disposers = [];
  const faults = [];
  const api = { state: 'unknown', windows: [], at: 0, lastTry: -Infinity, ticking: false };

  const keep = (value) => { disposers.push(value); return value; };
  const later = (fn, ms) => { const timer = schedule(() => { timers.delete(timer); if (!stopped) fn(); }, ms); timers.add(timer); return timer; };
  /** A call that fails is a recorded fault, never the end of the service. */
  const safe = async (what, call) => {
    try { return await call(); } catch (error) { faults.push({ what, code: codeOf(error) }); return undefined; }
  };

  // ---- settings ----------------------------------------------------------------------------------------------------
  async function loadSettings() {
    const page = await safe('settings.get', () => panda.settings.get({ page: IDS.page }));
    const values = page?.values ?? {};
    const seconds = Number.parseInt(String(values['min-interval-seconds'] ?? ''), 10);
    settings = {
      intervalMs: clamp(Number.isFinite(seconds) ? seconds : LIMITS.defaultIntervalSeconds, 1, LIMITS.maxIntervalSeconds) * 1000,
      afterReply: ['off', 'low', 'always'].includes(values['after-reply']) ? values['after-reply'] : 'low',
    };
  }

  // ---- reads: usage, limits and accounts are the host's resources ---------------------------------------------------
  async function readUsage(task) {
    let latest = null, cursor, pages = 0;
    do {
      const page = await queryUsage({ resource: 'usage', taskId: task.id, limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items ?? []) if (latest === null || item.turn >= latest.turn) latest = item;
      cursor = page.nextCursor ?? null;
      pages += 1;
    } while (cursor !== null && cursor !== undefined && pages < 20);
    return latest;
  }

  /** Re-reads the task's usage. True when the figures changed. An unknown task is forgotten. */
  async function refreshUsage(task) {
    try {
      const item = await readUsage(task);
      task.error = null;
      const signature = item ? `${item.turn}:${item.usedTokens}:${item.contextWindow ?? ''}:${item.reports}:${item.at}` : '';
      if (signature === task.signature) return false;
      task.signature = signature;
      task.usage = item ? { turn: item.turn, usedTokens: item.usedTokens, contextWindow: item.contextWindow } : null;
      await afterUsageChange(task);
      return true;
    } catch (error) {
      const code = codeOf(error);
      faults.push({ what: 'usage', code });
      if (code === 'NotFound') { await forget(task.id); return false; }
      if (task.error !== code) { task.error = code; await paint(task); }
      return false;
    }
  }

  async function readLimits(harness) {
    const key = harness ?? '*';
    try {
      const options = harness ? { harness } : {};
      const accounts = (await queryUsage({ resource: 'accounts', limit: 50, ...options })).items ?? [];
      const rows = (await queryUsage({ resource: 'limits', limit: 50, ...options })).items ?? [];
      const active = harness ? (accounts.find(item => item.active)?.id ?? 'default') : null;
      const picked = harness ? [rows.find(row => row.account === active) ?? rows[0]].filter(Boolean) : rows;
      const windows = picked.flatMap(row => (row.windows ?? []).map(raw => toWindow(raw, 'native', row.stale)).filter(Boolean));
      const label = harness ? (accounts.find(item => item.id === active)?.label ?? active) : null;
      const status = picked.length === 0 ? 'unchecked' : picked.every(row => row.status === 'signedOut') ? 'signedOut' : String(picked[0].status ?? 'ready');
      native.set(key, { account: active, label, status, stale: picked.some(row => row.stale), windows, readAt: now() });
    } catch (error) {
      faults.push({ what: 'limits', code: codeOf(error) });
      const known = native.get(key);
      if (known) native.set(key, { ...known, stale: true });
    }
  }

  const windowsFor = task => [
    ...(native.get(task.harness ?? '*')?.windows ?? []),
    ...api.windows.map(item => ({ ...item, stale: item.stale || api.state !== 'ok' })),
  ];

  // ---- the band ---------------------------------------------------------------------------------------------------
  function present(task) {
    const fill = fillOf(task.usage);
    const windows = windowsFor(task);
    const tight = tightest(windows);
    const known = native.get(task.harness ?? '*');
    const head = task.error ? 'Usage unavailable' : fill !== null ? `Context ${fill}%` : task.usage ? `${task.usage.usedTokens} tokens` : 'No usage yet';
    const parts = [head];
    if (tight) parts.push(windowText(tight));
    else if (known?.status === 'signedOut') parts.push('signed out');
    let tone = fill === null ? 'neutral' : fillTone(fill);
    if (tight && tight.left <= LIMITS.lowLeft) tone = worse(tone, tight.left <= 5 ? 'danger' : 'warning');
    const lines = [];
    if (task.usage) lines.push(`Context: ${task.usage.usedTokens}${task.usage.contextWindow ? ` of ${task.usage.contextWindow}` : ''} tokens, turn ${task.usage.turn}`);
    for (const item of windows) lines.push(windowText(item));
    if (known?.label) lines.push(`Account: ${known.label}`);
    if (api.state === 'offline') lines.push('The usage API did not answer; its values may be out of date.');
    if (api.state === 'signedOut') lines.push('The usage API needs its credential in Settings.');
    if (known?.stale) lines.push('The host\'s last reading is stale.');
    const items = [{ id: `${IDS.band}-${slug(task.id)}-fresh`, kind: 'command', title: task.armedAt === null ? 'Start fresh' : 'Click again to start fresh', command: IDS.startFresh },
      { id: `${IDS.band}-${slug(task.id)}-insert`, kind: 'command', title: 'Insert checkpoint', command: IDS.insertCheckpoint }];
    if (compactable.get(task.harness ?? '')) items.push({ id: `${IDS.band}-${slug(task.id)}-clean`, kind: 'command', title: 'Clean up', command: IDS.cleanUp });
    return { text: parts.join(' | ').slice(0, 120), tone, tooltip: lines.join('\n') || 'No usage reported for this task yet.', ...(fill === null ? {} : { progress: fill }), items };
  }

  async function paint(task) {
    if (stopped) return;
    const patch = present(task);
    const text = JSON.stringify(patch);
    if (task.handle === null) {
      if (task.denied) return;
      const handle = await safe('ui.register', () => panda.ui.register({
        kind: 'menu', id: `${IDS.band}-${slug(task.id)}`, location: IDS.location, command: IDS.openReport, presentation: 'status', scope: { taskId: task.id }, ...patch,
      }));
      if (handle) { task.handle = handle; task.painted = text; } else task.denied = faults.at(-1)?.code === 'PermissionDenied';
      return;
    }
    if (text === task.painted) return;
    task.painted = text;
    const { items, ...rest } = patch;
    const done = await safe('ui.update', () => panda.ui.update(task.handle.id, { ...rest, items }));
    if (done === undefined && faults.at(-1)?.what === 'ui.update') {
      const code = faults.at(-1).code;
      if (code === 'NotFound') task.handle = null;
      if (code === 'PermissionDenied') task.denied = true;
    }
  }

  const paintAll = () => Promise.all([...tasks.values()].map(paint));

  async function forget(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    task.watching?.cancel?.();
    // A registered item is a handle with `dispose` (the SDK) or an id the preview runner disposes by name.
    if (task.handle) await safe('ui.dispose', () => (typeof task.handle.dispose === 'function' ? task.handle.dispose() : panda.ui.dispose(task.handle.id)));
    if (shown === taskId) shown = null;
    await safe('ui.withdraw', () => panda.ui.withdraw(`${OWNER}/full-${slug(taskId)}`));
  }

  async function ensureTask(id, hints = {}) {
    let task = tasks.get(id);
    if (!task) {
      task = { id, projectId: null, harness: null, usage: null, signature: '', error: null, armed: true, armedAt: null, disarm: null, notes: { count: 0, lastAt: -Infinity }, handle: null, painted: '', denied: false, running: false, watching: null };
      tasks.set(id, task);
    }
    if (hints.projectId) task.projectId = hints.projectId;
    if (hints.harness) task.harness = hints.harness;
    if (task.harness && !compactable.has(task.harness)) await learnCompact(task.harness);
    return task;
  }

  async function learnCompact(harness) {
    compactable.set(harness, false);
    if (!panda.harnesses?.list) return;
    const report = await safe('harnesses.list', () => panda.harnesses.list({ harness }));
    const row = report?.harnesses?.find(item => item.id === harness);
    compactable.set(harness, Boolean(row && row.compact?.how && row.compact.how !== 'none'));
  }

  /** Crossing 80% raises one notice per task; it is armed again when the fill drops under it (a compaction). */
  async function afterUsageChange(task) {
    const fill = fillOf(task.usage);
    if (fill !== null && fill >= LIMITS.fullAt && task.armed) {
      task.armed = false;
      await safe('ui.notify', () => panda.ui.notify({ key: `${OWNER}/full-${slug(task.id)}`, title: 'Context nearly full', text: `The context of this task is ${fill}% full.`, tone: 'warning' }));
    } else if (fill !== null && fill < LIMITS.fullAt) task.armed = true;
    await paint(task);
  }

  // A running task is read again while it runs, so the band follows each usage report of the harness within a second.
  function watch(task) {
    if (task.watching || stopped) return;
    const step = () => {
      task.watching = null;
      if (stopped || !task.running || !tasks.has(task.id)) return;
      task.watching = later(async () => { task.watching = null; await refreshUsage(task); step(); }, liveMs);
    };
    step();
  }

  // ---- the limit poller: one request per interval through the declared connection -----------------------------------
  async function pollApi(force = false) {
    if (stopped || tasks.size === 0) return;                    // none while no task exists
    const at = now();
    if (!force && at - api.lastTry < settings.intervalMs) return;
    api.lastTry = at;
    const resource = { connection: IDS.api, operation: IDS.operation };
    try {
      const status = await panda.connections.status(resource);
      if (status.state !== 'connected' || !status.credential) { api.state = 'signedOut'; return; }
      const started = await panda.connections.start({ ...resource, credential: status.credential });
      let state = started, guard = 0;
      while (state.state === 'running' && guard < 100 && !stopped) { guard += 1; await sleep(pollMs); state = await panda.connections.poll({ ...resource, request: started.request }); }
      const body = state.response?.body;
      if (state.state === 'completed' && state.response?.status >= 200 && state.response.status < 300 && Array.isArray(body?.windows)) {
        api.windows = body.windows.map(raw => toWindow(raw, 'api', false)).filter(Boolean);
        api.state = 'ok'; api.at = at;
      } else api.state = 'offline';
    } catch (error) { faults.push({ what: 'connections', code: codeOf(error) }); api.state = 'offline'; }
    finally { await paintAll(); }
  }

  async function readAllLimits() {
    const harnesses = new Set([...tasks.values()].map(task => task.harness));
    for (const harness of harnesses) await readLimits(harness);
  }

  async function tick() {
    if (stopped) return;
    if (tasks.size > 0) {
      if (panda.harnesses?.refreshLimits) await safe('limits.refresh', () => panda.harnesses.refreshLimits({}));
      await readAllLimits();
      await pollApi();
      await paintAll();
    }
    later(tick, settings.intervalMs);
  }

  // ---- the ledger and the report panel ---------------------------------------------------------------------------
  async function record(taskId, turn, harness, model, usedTokens) {
    const mark = `${taskId}:${turn}`;
    if (recorded.has(mark) || !Number.isFinite(usedTokens)) return;
    recorded.add(mark);
    const rows = await ledger.read();
    const day = dayOf(now());
    const row = rows.find(item => item.day === day && item.harness === harness && item.model === model);
    if (row) { row.tokens += usedTokens; row.turns += 1; } else rows.push({ day, harness, model, tokens: usedTokens, turns: 1 });
    const oldest = dayOf(now() - LIMITS.ledgerDays * 86400000);
    await ledger.write(rows.filter(item => item.day >= oldest));
    await sendReport();
  }

  async function buildReport() {
    const rows = await ledger.read();
    const today = dayOf(now());
    const ranges = {};
    for (const [name, span] of [['today', 1], ['d7', 7], ['d30', 30]]) {
      const from = dayOf(now() - (span - 1) * 86400000);
      const inside = rows.filter(item => item.day >= from && item.day <= today);
      const byDay = new Map(), byGroup = new Map();
      for (const item of inside) {
        byDay.set(item.day, (byDay.get(item.day) ?? 0) + item.tokens);
        const key = `${item.harness}\u0000${item.model}`;
        const group = byGroup.get(key) ?? { harness: item.harness, model: item.model, tokens: 0, turns: 0 };
        group.tokens += item.tokens; group.turns += item.turns; byGroup.set(key, group);
      }
      ranges[name] = { from, days: [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, tokens]) => ({ day, tokens })), groups: [...byGroup.values()].sort((a, b) => b.tokens - a.tokens) };
    }
    return { kind: 'report.data', generatedAt: now(), today, ranges };
  }

  async function sendReport(instance) {
    if (!panda.views) return;
    const data = await buildReport();
    await safe('views.post', () => panda.views.post(IDS.report, data, instance ? { instance } : undefined));
  }

  // ---- hooks -----------------------------------------------------------------------------------------------------
  async function onPrompt(payload) {
    const task = await ensureTask(String(payload.taskId), { projectId: payload.projectId, harness: payload.harness });
    if (!task.usage) await refreshUsage(task);
    const fill = fillOf(task.usage);
    if (fill === null || fill <= LIMITS.noteAbove) return null;
    if (task.notes.count >= LIMITS.notesPerTask || now() - task.notes.lastAt < LIMITS.noteEveryMs) return null;
    task.notes.count += 1; task.notes.lastAt = now();
    return { context: `context is ${fill}% full; keep output brief` };
  }

  async function onTurnFinish(payload) {
    const task = await ensureTask(String(payload.taskId), { projectId: payload.projectId, harness: payload.harness });
    task.running = false;
    await refreshUsage(task);
    await readLimits(task.harness);
    await paint(task);
    const tokens = task.usage?.usedTokens ?? payload.usage?.usedTokens;
    await record(task.id, payload.index ?? task.usage?.turn ?? 0, payload.harness ?? task.harness ?? 'unknown', payload.model ?? 'unknown', tokens);
    const tight = tightest(windowsFor(task));
    if (settings.afterReply === 'always' || (settings.afterReply === 'low' && tight && tight.left <= LIMITS.lowLeft)) {
      const lines = windowsFor(task).map(windowText);
      if (lines.length > 0) await safe('ui.notify', () => panda.ui.notify({ key: `${OWNER}/windows-${slug(task.id)}`, title: 'Usage limits', text: lines.join('\n'), tone: tight && tight.left <= LIMITS.lowLeft ? 'warning' : 'info' }));
    }
  }

  // ---- the band's buttons ---------------------------------------------------------------------------------------
  const checkpointOf = task => {
    const fill = fillOf(task.usage);
    return `Checkpoint from task ${task.id}${task.harness ? ` (${task.harness})` : ''}: ${fill === null ? 'context use unknown' : `${fill}% of the context was used`} after ${task.usage?.turn ?? 0} turn(s). Continue from where it stopped and keep the answers short.`;
  };
  // A band button runs its command with the captured task (`sessionId`); a test or another caller may name it in `args`.
  const taskFor = context => tasks.get(String(context?.args?.taskId ?? context?.sessionId ?? context?.context?.sessionId ?? shown ?? ''));
  const note = (key, text, tone) => safe('ui.notify', () => panda.ui.notify({ key: `${OWNER}/${key}`, title: 'Usage band', text, tone }));

  async function startFresh(context) {
    const task = taskFor(context);
    if (!task) return null;
    if (task.armedAt === null) {                               // the first click only arms the button
      task.armedAt = now();
      task.disarm = later(async () => { task.armedAt = null; task.disarm = null; await paint(task); }, LIMITS.armMs);
      await paint(task);
      return { armed: true };
    }
    task.disarm?.cancel?.(); task.armedAt = null; task.disarm = null;
    if (!task.projectId) { await paint(task); await note('fresh', 'The project of this task is not known, so no task was started.', 'warning'); return { started: false }; }
    const started = await safe('tasks.start', () => panda.tasks.start({ projectId: task.projectId, prompt: checkpointOf(task), title: 'Fresh start', ...(task.harness ? { harness: task.harness } : {}) }));
    await paint(task);
    if (started) await note('fresh', 'Started a new task from the checkpoint.', 'success');
    else await note('fresh', `No task was started (${faults.at(-1)?.code ?? 'Failed'}).`, 'danger');
    return { started: Boolean(started) };
  }

  async function insertCheckpoint(context) {
    const task = taskFor(context);
    if (!task) return null;
    const done = await safe('tasks.draft', () => panda.tasks.draft.insert({ taskId: task.id, text: checkpointOf(task) }));
    if (!done) await note('insert', `The checkpoint was not written (${faults.at(-1)?.code ?? 'Failed'}).`, 'danger');
    return { inserted: Boolean(done) };
  }

  async function cleanUp(context) {
    const task = taskFor(context);
    if (!task) return null;
    const done = await safe('tasks.compact', () => panda.tasks.compact(task.id));
    if (done === undefined) await note('clean', `Clean up did not run (${faults.at(-1)?.code ?? 'Failed'}).`, 'warning');
    return { compacting: done !== undefined };
  }

  // ---- events ---------------------------------------------------------------------------------------------------
  async function seed(id, hints) {
    const task = await ensureTask(id, hints);
    await refreshUsage(task);
    if (!tasks.has(id)) return task;                           // the host does not know it (any more): nothing to show
    await readLimits(task.harness);
    await paint(task);
    pollApi();
    return task;
  }

  async function onEvent(event) {
    switch (event.kind) {
      case 'task.created': await seed(event.taskId, { projectId: event.projectId, harness: event.harness }); break;
      case 'task.removed': await forget(event.taskId); break;
      case 'task.shown': {
        shown = event.taskId;
        if (event.taskId) await seed(event.taskId, { projectId: event.projectId });
        break;
      }
      case 'turn.started': { const task = await ensureTask(event.taskId, { projectId: event.projectId }); task.running = true; await paint(task); watch(task); break; }
      case 'turn.finished': case 'turn.failed': case 'task.idle': case 'task.stopped': {
        const task = tasks.get(event.taskId);
        if (task) { task.running = false; await refreshUsage(task); }
        break;
      }
      case 'task.compacted': { const task = tasks.get(event.taskId); if (task) { task.armed = true; task.signature = ''; await refreshUsage(task); } break; }
      case 'app.focus': if (event.focused) { await readAllLimits(); await paintAll(); } break;
      case 'settings.changed': if (event.page === IDS.page) { await loadSettings(); } break;
      case 'gap': { for (const task of [...tasks.values()]) { task.signature = ''; await refreshUsage(task); } await readAllLimits(); await paintAll(); break; }
      default: break;
    }
  }

  // ---- start -----------------------------------------------------------------------------------------------------
  lifetime.onStop(() => {
    stopped = true;
    for (const timer of timers) timer.cancel?.();
    timers.clear();
    for (const task of tasks.values()) { task.watching?.cancel?.(); task.disarm?.cancel?.(); }
    for (const value of disposers.splice(0).reverse()) { try { if (typeof value === 'function') value(); else value.dispose(); } catch { /* a cleanup never blocks the others */ } }
  });

  await loadSettings();
  await safe('ui.update', () => panda.ui.update(IDS.band, { visible: false }));   // the per-task segments replace the manifest's placeholder

  for (const kind of ['task.created', 'task.removed', 'task.shown', 'turn.started', 'turn.finished', 'turn.failed', 'task.idle', 'task.stopped', 'task.compacted', 'app.focus', 'settings.changed', 'gap']) {
    const off = await safe(`events.${kind}`, () => panda.events.on(kind, event => onEvent(event).catch(error => faults.push({ what: kind, code: codeOf(error) }))));
    if (off) keep(off);
  }
  if (panda.hooks) {
    for (const [event, handler] of [['prompt.submit', onPrompt], ['turn.finish', onTurnFinish]]) {
      const registration = await safe(`hooks.${event}`, () => panda.hooks.on(event, handler));
      if (registration) keep(registration);
    }
  }
  for (const [id, handler] of [[IDS.startFresh, startFresh], [IDS.insertCheckpoint, insertCheckpoint], [IDS.cleanUp, cleanUp]]) keep(panda.commands.register(id, handler));
  if (panda.views) {
    keep(panda.views.onMessage(IDS.report, (message, from) => { if (message?.kind === 'report.request') return sendReport(from?.instanceId ?? from?.id); return null; }));
    keep(panda.views.on('opened', instance => sendReport(instance?.instanceId ?? instance?.id)));
  }

  // Tasks that already exist when the service starts.
  const known = await safe('context.query', () => panda.context.query({ resource: 'tasks', limit: 50 }));
  for (const item of known?.items ?? []) await seed(String(item.id), { projectId: item.projectId });
  later(tick, settings.intervalMs);

  lifetime.setStatus?.({ text: 'Usage band running' });
  return {
    faults: () => faults.slice(),
    state: () => ({ shown, api: { state: api.state, at: api.at }, tasks: [...tasks.keys()], settings }),
    pollNow: () => pollApi(true),
  };
}

/** The entry the preview runner loads. The installed package enters through main.cjs instead. */
export const service = (panda, lifetime, env) => run(panda, lifetime, env);
