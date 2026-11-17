// Machine monitor (sample.monitor): the service logic.
//
// A browser-safe ES module on purpose: no imports, no Node, no global but what it is handed (and setTimeout), so the very same
// file runs in the installed service (main.cjs gives it a TCP link to the metrics daemon) and in the browser preview
// (service() below builds its link from `panda.daemon`, the replaced backend of the preview runner).
//
// What it does: it keeps a 30-minute history per machine from the daemon's `metrics` topic, works out a level for each
// (ok, strained, critical, offline) from thresholds the user sets, and shows it three ways: a status item (`2 machines ok`,
// `<name> strained`, `<name> critical`, plus `· 1 offline`), a host-rendered table (the fallback) and a rich panel (cards,
// sparklines, charts). It asks the daemon for samples every `fast` seconds while a panel is visible and every `slow` seconds
// otherwise, learning visibility from the host (`panda.views.on('visible' | 'hidden')`), never from heartbeats. It raises
// attributed notices by rule (critical at once, strained after two readings, reminders, an hourly cap per machine, a notice
// when a machine with high memory stops answering). When the daemon itself is unreachable it KEEPS the last readings and says
// so (status `Daemon offline`, the panel's stale banner); it never shows a failed read as an empty fleet.
// Everything here is for predictability, not for trust (ADR-0005).
//
// The link it needs (`link`):
//   request(op, params) -> Promise            one request of the daemon (rejects with an error that has a `code`)
//   subscribe(topic, handler) -> Promise<off> frames are `{ event, seq, data }`
//   pace(topic, intervalMs)                   optional: ask the daemon for this sampling interval from now on
//   onDown(handler), onUp(handler)            optional: the connection was lost / is (re)established
//   reconnect(), retarget(address)            optional: try again now / use another address
export const OWNER = 'sample.monitor';
export const IDS = Object.freeze({
  page: `${OWNER}/thresholds`, status: `${OWNER}/status`, view: `${OWNER}/fleet`, show: `${OWNER}/show`, test: `${OWNER}/test-alert`,
});

export const DEFAULTS = Object.freeze({
  fast: 5, slow: 60, cpuStrained: 70, cpuCritical: 90, memStrained: 75, memCritical: 90, memElevated: 75, cap: 4, reminder: 10, alerts: true,
});
export const HISTORY_MS = 30 * 60 * 1000;
export const PUSH_MS = 1000;
const MAX_POINTS = 400;
const MAX_ROWS = 100;
const TITLE = 'Machines';
const DAEMON_KEY = 'daemon';

const fail = code => Object.assign(new Error(code), { code });
const clean = (value, fallback = '-') => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, 120) : fallback; };
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const dispose = handle => { if (typeof handle === 'function') handle(); else handle?.dispose?.(); };
const pct = value => `${Math.round(value)}%`;
const number = (value, fallback, min, max) => { const parsed = Number(String(value ?? '').trim()); return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback; };

/** The settings page values as the service uses them: anything out of range falls back to its default. */
export function readValues(values = {}) {
  return {
    daemon: typeof values.daemon === 'string' ? values.daemon.trim() : '',
    fast: number(values.fast, DEFAULTS.fast, 1, 60), slow: number(values.slow, DEFAULTS.slow, 5, 600),
    cpuStrained: number(values['cpu-strained'], DEFAULTS.cpuStrained, 1, 100), cpuCritical: number(values['cpu-critical'], DEFAULTS.cpuCritical, 1, 100),
    memStrained: number(values['mem-strained'], DEFAULTS.memStrained, 1, 100), memCritical: number(values['mem-critical'], DEFAULTS.memCritical, 1, 100),
    memElevated: number(values['mem-elevated'], DEFAULTS.memElevated, 1, 100), cap: Math.floor(number(values.cap, DEFAULTS.cap, 1, 60)),
    reminder: number(values.reminder, DEFAULTS.reminder, 1, 240), alerts: typeof values.alerts === 'boolean' ? values.alerts : DEFAULTS.alerts,
  };
}

export function levelOf(machine, settings) {
  if (!machine.online) return 'offline';
  if (machine.cpu >= settings.cpuCritical || machine.mem >= settings.memCritical) return 'critical';
  if (machine.cpu >= settings.cpuStrained || machine.mem >= settings.memStrained) return 'strained';
  return 'ok';
}

export async function run(panda, lifetime, link, options = {}) {
  const now = options.now ?? Date.now;
  const state = {
    settings: readValues(), daemon: '', revision: null, offline: false, since: null, failure: null,
    paceMs: null, paceChanges: 0, sent: 0, capped: 0, tests: 0, pushes: 0, refreshes: 0, refused: [],
  };
  const machines = new Map();
  const disposers = [];
  const topics = new Set();
  const seen = new Map();       // panel instance id -> visible
  const pending = new Map();    // machine id -> newest sample not yet pushed to a panel
  let flight = null, dirty = false, stopped = false, last = '', timer = null, lastPush = -Infinity, sequence = 0, metaDirty = false;

  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error).slice(0, 40)); if (state.refused.length > 3) state.refused.shift(); return null; };
  const guard = work => (...args) => { void Promise.resolve().then(() => work(...args)).catch(refuse); };
  const levels = () => { const count = { ok: 0, strained: 0, critical: 0, offline: 0 }; for (const machine of machines.values()) count[levelOf(machine, state.settings)] += 1; return count; };
  const visibleCount = () => { let count = 0; for (const visible of seen.values()) if (visible) count += 1; return count; };

  // One short line, always under the host's 200 character cap.
  const report = () => {
    const body = { machines: machines.size, levels: levels(), daemonOffline: state.offline, paceMs: state.paceMs, paceChanges: state.paceChanges, panels: visibleCount(), pushes: state.pushes, sent: state.sent, capped: state.capped, tests: state.tests, refused: state.refused };
    let text = JSON.stringify(body);
    if (text.length > 200) text = JSON.stringify({ ...body, refused: state.refused.length });
    void Promise.resolve(lifetime.setStatus({ text: text.slice(0, 200) })).catch(() => undefined);
  };

  // ---- the machines ----------------------------------------------------------------------------------------------

  const machineOf = id => {
    let machine = machines.get(id);
    if (!machine) {
      machine = { id, name: id, online: true, lastSeen: null, cpu: 0, mem: 0, history: [], runs: 0, alerted: 'none', noticedAt: 0, sent: [], stopped: false };
      machines.set(id, machine);
    }
    return machine;
  };
  const summary = machine => ({ id: machine.id, name: machine.name, level: levelOf(machine, state.settings), online: machine.online, cpu: machine.cpu, mem: machine.mem, lastSeen: machine.lastSeen });
  const addPoint = (machine, point) => {
    const history = machine.history;
    if (history.length && point.t <= history[history.length - 1].t) return false;
    history.push(point);
    const floor = point.t - HISTORY_MS;
    while (history.length > MAX_POINTS || (history.length && history[0].t < floor)) history.shift();
    return true;
  };
  const mergeHistory = (machine, points) => {
    const merged = new Map(machine.history.map(point => [point.t, point]));
    for (const point of points) if (Number.isFinite(point?.t) && Number.isFinite(point?.cpu) && Number.isFinite(point?.mem)) merged.set(point.t, { t: point.t, cpu: point.cpu, mem: point.mem });
    const sorted = [...merged.values()].sort((a, b) => a.t - b.t);
    const newest = sorted.length ? sorted[sorted.length - 1].t : 0;
    machine.history = sorted.filter(point => point.t >= newest - HISTORY_MS).slice(-MAX_POINTS);
  };

  // ---- notices: rules, caps, replacement ---------------------------------------------------------------------------
  //
  // One key per machine and kind, so a repeated notice REPLACES its row (the host replaces by key and merges past six sends
  // a minute: R2). The hourly cap per machine is this package's own rule, on top of the host's.

  const send = (machine, key, text, tone) => {
    const hour = now() - 3600000;
    machine.sent = machine.sent.filter(at => at >= hour);
    if (!state.settings.alerts) return false;
    if (machine.sent.length >= state.settings.cap) { state.capped += 1; return false; }
    machine.sent.push(now()); machine.noticedAt = now(); state.sent += 1;
    void Promise.resolve(panda.ui.notify({ key, title: TITLE, text, tone })).catch(refuse);
    return true;
  };
  const withdraw = key => { void Promise.resolve(panda.ui.withdraw(key)).catch(() => undefined); };
  const readings = machine => `CPU ${pct(machine.cpu)}, memory ${pct(machine.mem)}`;

  const evaluate = machine => {
    const level = levelOf(machine, state.settings);
    const key = `level:${machine.id}`;
    if (level === 'critical') {
      machine.runs = 0;
      if (machine.alerted !== 'critical') { if (send(machine, key, `${machine.name} is critical: ${readings(machine)}`, 'danger')) machine.alerted = 'critical'; }
      else if (now() - machine.noticedAt >= state.settings.reminder * 60000) send(machine, key, `${machine.name} is still critical: ${readings(machine)}`, 'danger');
    } else if (level === 'strained') {
      machine.runs += 1;
      // Falling from critical: the reminders stop and nothing new is raised.
      if (machine.alerted === 'critical') machine.alerted = 'strained';
      else if (machine.alerted === 'none' && machine.runs >= 2 && send(machine, key, `${machine.name} is strained: ${readings(machine)}`, 'warning')) machine.alerted = 'strained';
    } else if (level === 'ok') {
      machine.runs = 0;
      if (machine.alerted !== 'none') { machine.alerted = 'none'; withdraw(key); }
    }
  };
  const stoppedAnswering = machine => {
    if (machine.stopped || machine.mem < state.settings.memElevated) return;
    if (send(machine, `offline:${machine.id}`, `${machine.name} stopped answering (memory was ${pct(machine.mem)})`, 'warning')) machine.stopped = true;
  };

  // ---- reading the daemon ------------------------------------------------------------------------------------------

  const onSample = data => {
    if (typeof data?.machine !== 'string' || !Number.isFinite(data.t) || !Number.isFinite(data.cpu) || !Number.isFinite(data.mem)) return;
    const machine = machineOf(data.machine);
    const recovered = !machine.online;
    machine.online = true; machine.cpu = data.cpu; machine.mem = data.mem; machine.lastSeen = data.t;
    if (recovered && machine.stopped) { machine.stopped = false; withdraw(`offline:${machine.id}`); }
    if (!addPoint(machine, { t: data.t, cpu: data.cpu, mem: data.mem })) return;
    evaluate(machine);
    pending.set(machine.id, { machine: machine.id, t: data.t, cpu: data.cpu, mem: data.mem });
    void render().catch(refuse);
    schedulePush();
  };
  const onMachine = data => {
    if (typeof data?.id !== 'string') return;
    const machine = machineOf(data.id);
    const was = machine.online;
    if (typeof data.name === 'string') machine.name = clean(data.name, data.id);
    if (Number.isFinite(data.cpu)) machine.cpu = data.cpu;
    if (Number.isFinite(data.mem)) machine.mem = data.mem;
    if (Number.isFinite(data.lastSeen)) machine.lastSeen = data.lastSeen;
    if (typeof data.online === 'boolean') machine.online = data.online;
    if (was && !machine.online) stoppedAnswering(machine);
    if (!was && machine.online && machine.stopped) { machine.stopped = false; withdraw(`offline:${machine.id}`); }
    metaDirty = true;
    void render().catch(refuse);
    schedulePush();
  };

  const ensureSubscribed = async () => {
    if (topics.has('metrics')) return;
    await link.pace?.('metrics', paceSeconds() * 1000);
    state.paceMs = paceSeconds() * 1000;
    disposers.push(await link.subscribe('metrics', frame => {
      if (frame?.event === 'metrics.sample') onSample(frame.data);
      else if (frame?.event === 'metrics.machine') onMachine(frame.data);
    }));
    topics.add('metrics');
  };

  // One read at a time; a change that arrives while one runs makes exactly one more read.
  const refresh = () => {
    if (flight) { dirty = true; return flight; }
    flight = (async () => {
      do {
        dirty = false;
        try { await load(); } catch (error) { await markOffline(error).catch(refuse); }
      } while (dirty && !stopped);
    })().finally(() => { flight = null; });
    return flight;
  };
  const load = async () => {
    await ensureSubscribed();
    const list = await link.request('metrics.machines', {});
    if (!Array.isArray(list)) throw fail('InvalidShape');
    const since = now() - HISTORY_MS;
    const histories = [];
    for (const item of list) {
      if (typeof item?.id !== 'string') continue;
      const machine = machineOf(item.id);
      machine.name = clean(item.name, item.id); machine.online = item.online !== false;
      if (Number.isFinite(item.cpu)) machine.cpu = item.cpu;
      if (Number.isFinite(item.mem)) machine.mem = item.mem;
      if (Number.isFinite(item.lastSeen)) machine.lastSeen = item.lastSeen;
      histories.push([machine, await link.request('metrics.history', { machine: item.id, sinceMs: since })]);
    }
    for (const [machine, points] of histories) if (Array.isArray(points)) mergeHistory(machine, points);
    state.refreshes += 1;
    if (state.offline) markOnline();
    metaDirty = true;
    await render(true);
    await sendSnapshot();
    report();
  };

  // ---- offline and recovery ----------------------------------------------------------------------------------------

  const markOffline = async error => {
    if (stopped) return;
    state.failure = String(error?.code ?? error?.message ?? 'Unreachable').slice(0, 40);
    if (!state.offline) {
      state.offline = true; state.since = now();
      void Promise.resolve(panda.ui.notify({ key: DAEMON_KEY, title: TITLE, text: 'Metrics daemon offline', tone: 'warning' })).catch(refuse);
    }
    metaDirty = true;
    await render(true);
    await pushMeta();
    report();
  };
  const markOnline = () => {
    state.offline = false; state.since = null; state.failure = null;
    withdraw(DAEMON_KEY);
  };

  // ---- what the user sees ------------------------------------------------------------------------------------------

  const statusOf = () => {
    const list = [...machines.values()];
    const online = list.filter(machine => machine.online);
    const gone = list.length - online.length;
    const lines = list.slice(0, 8).map(machine => `${machine.name}: ${levelOf(machine, state.settings)}, ${readings(machine)}`);
    if (list.length > 8) lines.push(`and ${list.length - 8} more`);
    const tooltip = lines.join('; ') || 'No machines listed by the daemon.';
    if (state.offline) return { text: 'Daemon offline', tone: 'warning', tooltip: list.length ? `Last readings kept, ${state.since ? `stale since ${clock(state.since)}` : 'stale'}. ${tooltip}`.slice(0, 480) : 'No readings yet; the metrics daemon is not answering.' };
    if (!list.length) return { text: 'No machines', tone: 'neutral', tooltip };
    const tail = gone ? ` · ${gone} offline` : '';
    let worst = null;
    for (const machine of online) {
      const level = levelOf(machine, state.settings);
      if (level === 'critical') { worst = { machine, level }; break; }
      if (level === 'strained' && !worst) worst = { machine, level };
    }
    if (worst) return { text: `${worst.machine.name} ${worst.level}${tail}`, tone: worst.level === 'critical' ? 'danger' : 'warning', tooltip: tooltip.slice(0, 480) };
    if (!online.length) return { text: `No machines online${tail}`, tone: 'neutral', tooltip: tooltip.slice(0, 480) };
    return { text: `${online.length} ${online.length === 1 ? 'machine' : 'machines'} ok${tail}`, tone: 'success', tooltip: tooltip.slice(0, 480) };
  };

  // The host-rendered fallback (status item and table) and the rich panel are two views of the same readings.
  const render = async force => {
    const status = statusOf();
    const list = [...machines.values()];
    const stale = state.offline ? `stale since ${clock(state.since ?? now())}` : null;
    const rows = list.slice(0, MAX_ROWS).map(machine => [clean(machine.name), levelOf(machine, state.settings), pct(machine.cpu), pct(machine.mem), machine.online && !stale ? 'now' : machine.lastSeen ? `last seen ${clock(machine.lastSeen)}` : 'never']);
    const view = {
      text: `${stale ? `Stale: the metrics daemon is offline (${stale}). ` : ''}${status.text}.`,
      controls: list.length
        ? [{ kind: 'table', label: stale ? `Machines (${stale})` : 'Machines', columns: ['Machine', 'Level', 'CPU', 'Memory', 'Seen'], rows }]
        : [{ kind: 'list', label: 'Machines', items: [state.offline ? 'Unknown until the daemon answers' : 'No machines yet'] }],
    };
    const signature = JSON.stringify([status, view]);
    if (!force && signature === last) return;
    last = signature;
    await Promise.resolve(panda.ui.update(IDS.status, status)).catch(refuse);
    await Promise.resolve(panda.ui.updateView(IDS.view, view)).catch(refuse);
    report();
  };

  // ---- the rich panel ----------------------------------------------------------------------------------------------
  //
  // The panel is a picture of the service's readings. A panel that opens or becomes visible gets `fleet.begin` (the machines,
  // the thresholds, the stale marking) and one `fleet.history` per machine; after that it gets at most one `fleet.samples` a
  // second with what changed. A hidden panel gets nothing: it asks for a snapshot (or is sent one) when it shows again.
  const panel = panda.views;
  const VIEW = IDS.view;
  const beginOf = () => ({
    kind: 'fleet.begin', seq: ++sequence, machines: [...machines.values()].map(summary), stale: state.offline, since: state.since ? clock(state.since) : null,
    status: statusOf().text, intervalMs: state.paceMs, thresholds: { cpuStrained: state.settings.cpuStrained, cpuCritical: state.settings.cpuCritical, memStrained: state.settings.memStrained, memCritical: state.settings.memCritical },
    windowMs: HISTORY_MS,
  });
  const sendSnapshot = async instance => {
    if (!panel) return;
    if (!instance && visibleCount() === 0) return;
    const target = instance ? { instance } : undefined;
    const begin = beginOf();
    await panel.post(VIEW, begin, target);
    for (const machine of machines.values()) await panel.post(VIEW, { kind: 'fleet.history', seq: begin.seq, machine: machine.id, points: machine.history.map(point => [point.t, point.cpu, point.mem]) }, target);
    state.pushes += 1;
  };
  const pushMeta = async () => {
    if (!panel || visibleCount() === 0) return;
    metaDirty = false;
    await panel.post(VIEW, { kind: 'fleet.samples', samples: [], machines: [...machines.values()].map(summary), stale: state.offline, since: state.since ? clock(state.since) : null, status: statusOf().text });
    state.pushes += 1;
  };
  const flush = async () => {
    timer = null;
    lastPush = now();
    const samples = [...pending.values()];
    pending.clear();
    if (!panel || (!samples.length && !metaDirty)) return;
    if (visibleCount() === 0) { metaDirty = false; return; }
    metaDirty = false;
    await panel.post(VIEW, { kind: 'fleet.samples', samples, machines: [...machines.values()].map(summary), stale: state.offline, since: state.since ? clock(state.since) : null, status: statusOf().text });
    state.pushes += 1;
  };
  // At most one push a second: a push that is due now goes out now, a later one waits for the rest of the second.
  function schedulePush() {
    if (!panel || stopped || timer) return;
    const wait = Math.max(0, lastPush + PUSH_MS - now());
    if (wait === 0) { lastPush = now(); void flush().catch(refuse); return; }
    timer = setTimeout(() => { void flush().catch(refuse); }, Math.min(wait, PUSH_MS));
  }

  // ---- the polling rate follows visibility --------------------------------------------------------------------------

  const paceSeconds = () => (visibleCount() > 0 ? state.settings.fast : state.settings.slow);
  const applyPace = async () => {
    const wanted = paceSeconds() * 1000;
    if (wanted === state.paceMs) return;
    state.paceMs = wanted; state.paceChanges += 1;
    await Promise.resolve(link.pace?.('metrics', wanted)).catch(refuse);
    report();
  };
  const track = (instance, visible) => {
    if (typeof instance?.instanceId !== 'string') return;
    seen.set(instance.instanceId, visible);
  };

  const answerPanel = async (message, from) => {
    if (message?.kind === 'snapshot' && typeof from?.instanceId === 'string') await sendSnapshot(from.instanceId);
    return null;
  };

  // ---- settings ----------------------------------------------------------------------------------------------------

  const readSettings = async () => {
    const page = await panda.settings.get({ page: IDS.page }).catch(refuse);
    if (!page) return false;
    state.revision = page.revision ?? state.revision;
    state.settings = readValues(page.values ?? {});
    const daemon = state.settings.daemon;
    if (daemon === state.daemon) return false;
    state.daemon = daemon;
    if (daemon && link.retarget) await link.retarget(daemon);
    return true;
  };

  // ---- wiring ------------------------------------------------------------------------------------------------------

  const command = (id, handler) => { try { disposers.push(panda.commands.register(id, handler)); } catch (error) { refuse(error); } };
  // "Send a test alert" always raises one notice, whatever the alerts switch says: the user asked for it.
  command(IDS.test, async () => {
    state.tests += 1;
    await Promise.resolve(panda.ui.notify({ key: 'test-alert', title: TITLE, text: 'Test alert from Machines', tone: 'info' }));
    report();
    return { sent: true, tests: state.tests };
  });
  if (panel) {
    try {
      disposers.push(panel.on('opened', instance => { track(instance, instance?.visible !== false); void applyPace().catch(refuse); if (instance?.visible !== false) void sendSnapshot(instance.instanceId).catch(refuse); }));
      disposers.push(panel.on('visible', instance => { track(instance, true); void applyPace().catch(refuse); void sendSnapshot(instance?.instanceId).catch(refuse); }));
      disposers.push(panel.on('hidden', instance => { track(instance, false); void applyPace().catch(refuse); }));
      disposers.push(panel.on('closed', instance => { if (typeof instance?.instanceId === 'string') seen.delete(instance.instanceId); void applyPace().catch(refuse); }));
      disposers.push(panel.onMessage(VIEW, (message, from) => answerPanel(message, from).catch(refuse)));
    } catch (error) { refuse(error); }
  }

  const on = (kind, handler) => { try { disposers.push(panda.events.on(kind, guard(handler))); } catch (error) { refuse(error); } };
  // A changed threshold takes effect at the next reading, with no restart; the levels shown change at once.
  on('settings.changed', async () => {
    const moved = await readSettings();
    await applyPace();
    await render(true);
    await sendSnapshot();
    report();
    if (moved) await refresh();
  });
  on('app.focus', event => { if (event?.focused && state.offline) return refresh(); });
  on('gap', () => refresh());

  if (link.onDown) disposers.push(link.onDown(guard(() => markOffline(fail('Unreachable')))));
  if (link.onUp) disposers.push(link.onUp(guard(() => refresh())));

  lifetime.onStop(() => {
    stopped = true;
    clearTimeout(timer); timer = null;
    for (const handle of disposers.splice(0).reverse()) { try { dispose(handle); } catch { /* the host disposes the rest */ } }
  });

  // Seed the panels that already exist (a service that restarts finds its panels open).
  if (panel) {
    try { for (const instance of await panel.instances(VIEW)) track(instance, instance.visible !== false); } catch (error) { refuse(error); }
  }
  await readSettings();
  await refresh();
  report();
  return state;
}

/** The link of the browser preview: the replaced backend answers `panda.daemon`. */
export const linkFromPanda = panda => ({
  request: (op, params) => panda.daemon.request(op, params),
  subscribe: (topic, handler) => panda.daemon.subscribe(topic, handler),
  pace: (topic, intervalMs) => panda.daemon.request('subscribe', { topic, intervalMs }),
});

/** The entry the preview runner loads. The installed package enters through main.cjs instead. */
export const service = (panda, lifetime) => run(panda, lifetime, linkFromPanda(panda));
