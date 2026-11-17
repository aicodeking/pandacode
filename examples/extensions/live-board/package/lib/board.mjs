// Work board, cut A: the service logic of sample.live-board.
//
// A browser-safe ES module on purpose: it has no imports, no Node, and no global but what it is handed, so the very
// same file runs in the installed service (main.cjs gives it a TCP link to the tracker daemon) and in the browser
// preview (service() below builds its link from `panda.daemon`, the replaced backend of the preview runner).
//
// What it does: it keeps one snapshot of the tracker's issues; the status item reads `N ready` (N is the length of the
// daemon's own ready list, never derived here); the view `sample.live-board/board` shows a table of the issues. When
// the daemon is unreachable it KEEPS the last snapshot and marks it stale (status item "Tracker offline", the table
// label and text say "stale since <time>"), registers a Retry button in the workspace header, and removes that
// button when the daemon answers again. It never shows a failed read as an empty board. A dialog asks who is working
// and keeps the answer. Everything here is for predictability, not for trust (ADR-0005).
//
// The link it needs (`link`):
//   request(op, params) -> Promise            one request of the tracker (rejects with an error that has a `code`)
//   subscribe(topic, handler) -> Promise<off> frames are `{ event, seq, data }`
//   onDown(handler), onUp(handler)            optional: the connection was lost / is (re)established
//   reconnect(), retarget(address)            optional: try again now / use another address
export const OWNER = 'sample.live-board';
export const IDS = Object.freeze({
  page: `${OWNER}/tracker`, status: `${OWNER}/ready`, view: `${OWNER}/board`,
  retryItem: `${OWNER}/retry-button`, retry: `${OWNER}/retry`, who: `${OWNER}/who`,
});

const UNIT = 'ready';
const MAX_ROWS = 100;
const MAX_CELL = 200;
const COLUMNS = ['Issue', 'Title', 'Status', 'Assignee'];
const NOTICE = 'tracker';

const fail = code => Object.assign(new Error(code), { code });
const clean = (value, fallback = '-') => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, MAX_CELL) : fallback; };
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const dispose = handle => { if (typeof handle === 'function') handle(); else handle?.dispose?.(); };

export async function run(panda, lifetime, link, options = {}) {
  const now = options.now ?? Date.now;
  const state = {
    unit: UNIT, daemon: '', revision: null, snapshot: null, offline: false, since: null, failure: null,
    retries: 0, actor: null, answers: [], refused: [], switches: 0, refreshes: 0,
  };
  const disposers = [];
  const topics = new Set();
  let retryItem = null, retryBusy = null, flight = null, dirty = false, stopped = false, last = '';

  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error).slice(0, 40)); if (state.refused.length > 3) state.refused.shift(); return null; };
  const guard = work => (...args) => { void Promise.resolve().then(() => work(...args)).catch(refuse); };

  // One short line, always under the host's 200 character cap.
  const report = () => {
    const body = { ready: state.snapshot ? state.snapshot.readyIds.length : null, total: state.snapshot ? state.snapshot.issues.length : null, offline: state.offline, retries: state.retries, actor: state.actor, unit: state.unit, revision: state.revision, switches: state.switches, refreshes: state.refreshes, answers: state.answers.length, refused: state.refused };
    let text = JSON.stringify(body);
    if (text.length > 200) text = JSON.stringify({ ...body, refused: state.refused.length });
    void Promise.resolve(lifetime.setStatus({ text: text.slice(0, 200) })).catch(() => undefined);
  };

  // A live item as one handle, whichever shape the host gives back (a handle with update/dispose, or just its id).
  const live = async definition => {
    const made = await panda.ui.register(definition);
    const id = made?.id ?? definition.id;
    return { id, dispose: () => (typeof made?.dispose === 'function' ? made.dispose() : panda.ui.dispose(id)) };
  };

  // ---- reading the tracker ---------------------------------------------------------------------------------------

  const readSnapshot = async () => {
    let snapshot = await link.request('issues.snapshot', {});
    if (snapshot && typeof snapshot.transfer === 'string') {
      const parts = [];
      for (let index = 0; index < Number(snapshot.chunks); index += 1) parts.push((await link.request('issues.chunk', { transfer: snapshot.transfer, index })).text);
      snapshot = JSON.parse(parts.join(''));
    }
    if (!Array.isArray(snapshot?.issues) || !Array.isArray(snapshot.readyIds) || !Array.isArray(snapshot.blockedIds)) throw fail('InvalidShape');
    return snapshot;
  };

  const signal = async data => {
    const payload = data?.payload ?? {};
    switch (payload.op ?? data?.name) {
      case 'refresh': await refresh(); break;
      // The dialog waits for the user: a signal never queues behind it.
      case 'ask': void ask().catch(refuse); break;
      case 'state': report(); break;
      default: break;
    }
  };

  const ensureSubscribed = async () => {
    const wanted = [['issues', () => { void refresh(); }], ['signals', frame => { void signal(frame?.data).catch(refuse); }]];
    for (const [topic, handler] of wanted) {
      if (topics.has(topic)) continue;
      disposers.push(await link.subscribe(topic, handler));
      topics.add(topic);
    }
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
    const snapshot = await readSnapshot();
    state.snapshot = snapshot;
    state.refreshes += 1;
    if (state.offline) await markOnline();
    await render();
    report();
  };

  // ---- offline and recovery --------------------------------------------------------------------------------------

  const ensureRetry = async () => {
    if (retryItem) return;
    retryBusy ??= (async () => {
      try {
        retryItem = await live({ kind: 'menu', id: IDS.retryItem, location: 'panda.workspace.header.actions', command: IDS.retry, presentation: 'button', text: 'Retry tracker', tooltip: 'Reconnect to the work tracker', tone: 'warning' });
      } catch (error) { refuse(error); } finally { retryBusy = null; }
    })();
    await retryBusy;
  };
  const dropRetry = async () => {
    await retryBusy;
    const item = retryItem;
    retryItem = null;
    if (item) await Promise.resolve(item.dispose()).catch(refuse);
  };

  const markOffline = async error => {
    if (stopped) return;
    state.failure = String(error?.code ?? error?.message ?? 'Unreachable').slice(0, 40);
    if (!state.offline) {
      state.offline = true;
      state.since = now();
      void Promise.resolve(panda.ui.notify({ key: NOTICE, title: 'Work board', text: 'Tracker offline', tone: 'warning' })).catch(refuse);
    }
    await ensureRetry();
    await render(true);
    report();
  };
  const markOnline = async () => {
    state.offline = false; state.since = null; state.failure = null;
    await dropRetry();
    void Promise.resolve(panda.ui.withdraw(NOTICE)).catch(refuse);
  };

  // ---- what the user sees ----------------------------------------------------------------------------------------

  const render = async force => {
    const snapshot = state.snapshot;
    let status, view;
    if (!snapshot) {
      // Nothing was ever read. Never a table: an empty one would claim the tracker has no issues.
      if (!state.offline) return;
      status = { text: 'Tracker offline', tone: 'warning', tooltip: 'No snapshot yet; the tracker is not answering.' };
      view = { text: 'Tracker offline. There is no snapshot yet, so nothing is known about the issues.', controls: [{ kind: 'list', label: 'Issues', items: ['Unknown until the tracker answers'] }] };
    } else {
      const ready = new Set(snapshot.readyIds), blocked = new Set(snapshot.blockedIds);
      const count = `${ready.size} ${state.unit}`;
      const totals = `${snapshot.issues.length} issues, ${blocked.size} blocked`;
      const who = state.actor ? ` Working: ${clean(state.actor)}.` : '';
      const stale = state.offline ? `stale since ${clock(state.since)}` : null;
      const rows = snapshot.issues.slice(0, MAX_ROWS).map(issue => [clean(issue.id), clean(issue.title), ready.has(issue.id) ? 'ready' : blocked.has(issue.id) ? 'blocked' : clean(issue.status), clean(issue.assignee)]);
      status = stale
        ? { text: 'Tracker offline', tone: 'warning', tooltip: `Last snapshot: ${count} of ${totals}, ${stale}.${who}` }
        : { text: count, tone: ready.size > 0 ? 'success' : 'neutral', tooltip: `${totals}.${who}` };
      view = {
        text: `${stale ? `Stale: the tracker is offline (${stale}). ` : ''}${count} of ${totals}.${snapshot.issues.length > MAX_ROWS ? ` Showing the first ${MAX_ROWS}.` : ''}${who}`,
        controls: [{ kind: 'table', label: stale ? `Issues (${stale})` : 'Issues', columns: COLUMNS, rows }],
      };
    }
    const signature = JSON.stringify([status, view]);
    if (!force && signature === last) return;
    last = signature;
    await Promise.resolve(panda.ui.update(IDS.status, status)).catch(refuse);
    await Promise.resolve(panda.ui.updateView(IDS.view, view)).catch(refuse);
  };

  // ---- the dialog ------------------------------------------------------------------------------------------------

  const ask = async () => {
    const answer = await panda.ui.showDialog({ title: 'Who is working?', fields: [{ id: 'actor', label: 'Name', kind: 'text', required: true }], confirmLabel: 'Save', successMessage: 'Saved' }).catch(refuse);
    if (!answer) return { status: 'refused', actor: state.actor };
    state.answers.push(answer.status);
    if (answer.status === 'confirmed') { state.actor = clean(answer.values?.actor, '') || null; await render(true); }
    report();
    return { status: answer.status, actor: state.actor };
  };

  // ---- settings --------------------------------------------------------------------------------------------------

  const readSettings = async () => {
    const page = await panda.settings.get({ page: IDS.page }).catch(refuse);
    if (!page) return false;
    const values = page.values ?? {};
    state.revision = page.revision ?? state.revision;
    state.unit = clean(values.unit, UNIT);
    const daemon = typeof values.daemon === 'string' ? values.daemon.trim() : '';
    if (daemon === state.daemon) return false;
    state.daemon = daemon;
    if (daemon && link.retarget) await link.retarget(daemon);
    return true;
  };

  // ---- wiring ----------------------------------------------------------------------------------------------------

  const command = (id, handler) => { try { disposers.push(panda.commands.register(id, handler)); } catch (error) { refuse(error); } };
  command(IDS.retry, async () => {
    state.retries += 1;
    await Promise.resolve(link.reconnect?.()).catch(() => undefined);
    await refresh();
    report();
    return { offline: state.offline, retries: state.retries };
  });
  command(IDS.who, () => ask());

  const on = (kind, handler) => { try { disposers.push(panda.events.on(kind, guard(handler))); } catch (error) { refuse(error); } };
  on('settings.changed', async () => {
    const moved = await readSettings();
    await render(true);
    report();
    if (moved) await refresh();
  });
  // A switch of task or project changes nothing on the board: it is one tracker. It is counted, and nothing is rebuilt.
  for (const kind of ['task.shown', 'project.opened', 'project.closed']) on(kind, () => { state.switches += 1; report(); });
  on('app.focus', event => { if (event?.focused && state.offline) return refresh(); });
  on('gap', () => refresh());

  if (link.onDown) disposers.push(link.onDown(guard(() => markOffline(fail('Unreachable')))));
  if (link.onUp) disposers.push(link.onUp(guard(() => refresh())));

  lifetime.onStop(() => {
    stopped = true;
    for (const handle of disposers.splice(0).reverse()) { try { dispose(handle); } catch { /* the host disposes the rest */ } }
  });

  await readSettings();
  await refresh();
  report();
  return state;
}

/** The link of the browser preview: the replaced backend answers `panda.daemon`. */
export const linkFromPanda = panda => ({
  request: (op, params) => panda.daemon.request(op, params),
  subscribe: (topic, handler) => panda.daemon.subscribe(topic, handler),
});

/** The entry the preview runner loads. The installed package enters through main.cjs instead. */
export const service = (panda, lifetime) => run(panda, lifetime, linkFromPanda(panda));
