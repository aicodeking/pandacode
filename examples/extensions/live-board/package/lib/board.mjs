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
//   cli(args) -> Promise<json>                optional (cut B): one run of the tracker's command-line tool, e.g.
//                                             ['claim', '--id=T-1', '--actor=Ada']; rejects with an error that has a `code`
//                                             (Conflict, NotFound, Unreachable...). Without it the panel is read-only.
// Cut B adds the rich panel (`panda.views`): the same snapshot as a board with selection and detail, and Claim, Close
// and Undo through that command-line tool.
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
const CHUNK = 200;

const fail = code => Object.assign(new Error(code), { code });
const clean = (value, fallback = '-') => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, MAX_CELL) : fallback; };
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const dispose = handle => { if (typeof handle === 'function') handle(); else handle?.dispose?.(); };

export async function run(panda, lifetime, link, options = {}) {
  const now = options.now ?? Date.now;
  const state = {
    unit: UNIT, daemon: '', revision: null, snapshot: null, offline: false, since: null, failure: null,
    retries: 0, actor: null, answers: [], refused: [], switches: 0, refreshes: 0,
    acts: 0, undo: null, notice: null,
    // Cut C: the Start flow. `agents` maps an issue id to what its agent task is doing; `started` maps a task id to the issues
    // it was started for; `project` is the last project the user showed (the dialog's suggestion).
    agents: {}, started: new Map(), project: '', starting: false, starts: 0,
  };
  const disposers = [];
  const topics = new Set();
  let retryItem = null, retryBusy = null, flight = null, dirty = false, stopped = false, last = '';

  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error).slice(0, 40)); if (state.refused.length > 3) state.refused.shift(); return null; };
  const guard = work => (...args) => { void Promise.resolve().then(() => work(...args)).catch(refuse); };

  // One short line, always under the host's 200 character cap.
  const report = () => {
    const body = { ready: state.snapshot ? state.snapshot.readyIds.length : null, total: state.snapshot ? state.snapshot.issues.length : null, offline: state.offline, retries: state.retries, actor: state.actor, unit: state.unit, revision: state.revision, switches: state.switches, refreshes: state.refreshes, answers: state.answers.length, acts: state.acts, undo: state.undo ? state.undo.op : null, tasks: state.started.size, refused: state.refused };
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

  // The host-rendered fallback (status item and table) and the rich panel are two views of the same snapshot.
  const render = async force => {
    await renderHost(force);
    await pushPanel(force);
  };

  const renderHost = async force => {
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

  // ---- the rich panel (cut B) ------------------------------------------------------------------------------------
  //
  // The panel is a picture of the service's snapshot. The service sends it as `board.begin` (counts, the daemon's own
  // readyIds and blockedIds, the stale marking, the undo that is possible), then the issues in `board.rows` chunks of
  // CHUNK rows (a message holds at most 256 KiB), so 2,000 issues are 10 small messages and never one large one. A
  // panel that opens gets the current board, to that instance only. Claim, Close and Undo go through the command-line
  // tool of the tracker (link.cli), never straight to the daemon.
  const panel = panda.views;
  const VIEW = IDS.view;
  const ID = /^[A-Za-z0-9._-]{1,64}$/;
  let sequence = 0, pushed = '';

  const undoLabel = () => (state.undo ? `Undo ${state.undo.op} of ${state.undo.id}` : null);
  const boardMessages = () => {
    const snapshot = state.snapshot;
    if (!snapshot) return [{ kind: 'board.unknown', offline: state.offline, failure: state.failure }];
    sequence += 1;
    const parts = Math.ceil(snapshot.issues.length / CHUNK);
    const messages = [{
      kind: 'board.begin', seq: sequence, total: snapshot.issues.length, parts, readyIds: snapshot.readyIds, blockedIds: snapshot.blockedIds,
      revision: snapshot.revision ?? null, stale: state.offline, since: state.since ? clock(state.since) : null, actor: state.actor,
      unit: state.unit, undo: undoLabel(), notice: state.notice, agents: { ...state.agents },
    }];
    for (let index = 0; index < parts; index += 1) {
      messages.push({ kind: 'board.rows', seq: sequence, index, rows: snapshot.issues.slice(index * CHUNK, (index + 1) * CHUNK).map(issue => ({ id: clean(issue.id), title: clean(issue.title), status: clean(issue.status), assignee: clean(issue.assignee, ''), revision: issue.revision ?? null })) });
    }
    return messages;
  };
  // One send at a time per target is not needed: a newer `board.begin` makes the panel drop the older, unfinished one.
  const sendBoard = async instance => {
    if (!panel) return;
    const options = instance ? { instance } : undefined;
    for (const message of boardMessages()) await panel.post(VIEW, message, options);
  };
  const pushPanel = async force => {
    if (!panel) return;
    const snapshot = state.snapshot;
    const body = snapshot ? (snapshot.revision ?? JSON.stringify(snapshot.issues)) : null;
    const signature = JSON.stringify([body, snapshot ? snapshot.readyIds : null, snapshot ? snapshot.blockedIds : null, state.offline, state.since, state.actor, state.unit, undoLabel(), state.notice, snapshot ? null : state.failure, state.agents]);
    if (!force && signature === pushed) return;
    pushed = signature;
    await Promise.resolve(sendBoard()).catch(refuse);
  };

  const needCli = () => { if (typeof link.cli !== 'function') throw fail('UnsupportedCapability'); };
  const issueOf = id => {
    if (!ID.test(String(id ?? ''))) throw fail('InvalidShape');
    const issue = state.snapshot?.issues.find(item => item.id === id);
    if (!issue) throw fail('NotFound');
    return issue;
  };
  const doer = () => clean(state.actor, 'board');
  const refused = (message, code) => Object.assign(fail(code), { text: message });

  const claimIssue = async id => {
    needCli();
    const issue = issueOf(id);
    if (issue.status === 'closed') throw refused(`${id} is closed.`, 'InvalidState');
    const result = await link.cli(['claim', `--id=${id}`, `--actor=${doer()}`]);
    state.undo = { op: 'claim', id, revision: result?.revision ?? null, before: { status: clean(issue.status, 'open'), assignee: String(issue.assignee ?? '') } };
    return `Claimed ${id}.`;
  };
  const closeIssue = async (id, reason) => {
    needCli();
    const issue = issueOf(id);
    if (issue.status === 'closed') throw refused(`${id} is already closed.`, 'InvalidState');
    const result = await link.cli(['close', `--id=${id}`, `--reason=${clean(reason, 'closed from the work board')}`]);
    state.undo = { op: 'close', id, revision: result?.revision ?? null, before: null };
    return `Closed ${id}.`;
  };
  // Undo changes the issue back only when nobody else touched it since: a closed issue is reopened with the daemon's own
  // revision guard; a claimed one is read first and left alone when its revision moved. The refusal is shown.
  const undoLast = async () => {
    needCli();
    const last = state.undo;
    if (!last) throw refused('There is nothing to undo.', 'NothingToUndo');
    const changed = () => refused(`${last.id} changed since you ${last.op === 'close' ? 'closed' : 'claimed'} it; the undo was refused.`, 'Conflict');
    try {
      if (last.op === 'close') {
        await link.cli(['reopen', `--id=${last.id}`, `--if-revision=${last.revision}`]);
      } else {
        const now = await link.cli(['show', `--id=${last.id}`]);
        if (now?.revision !== last.revision) throw changed();
        await link.cli(['update', `--id=${last.id}`, `--status=${last.before.status}`, `--assignee=${last.before.assignee}`]);
      }
    } catch (error) {
      if (error?.code === 'Conflict') { state.undo = null; state.notice = (error.text ?? changed().text); throw Object.assign(fail('Conflict'), { text: state.notice }); }
      throw error;
    }
    state.undo = null; state.notice = null;
    return `Undid the ${last.op} of ${last.id}.`;
  };
  const detailOf = async id => {
    needCli();
    issueOf(id);
    const issue = await link.cli(['show', `--id=${id}`]);
    return { kind: 'detail', id, issue: { id: clean(issue.id), title: clean(issue.title), status: clean(issue.status), assignee: clean(issue.assignee, ''), type: clean(issue.type, ''), priority: issue.priority ?? null, revision: issue.revision ?? null, description: String(issue.description ?? '').slice(0, 2000), dependsOn: Array.isArray(issue.dependsOn) ? issue.dependsOn.map(item => clean(item)).slice(0, 50) : [] } };
  };

  // ---- Start: an attributed agent task (cut C) --------------------------------------------------------------------
  //
  // Three steps, all of them the user's: (1) a host dialog chooses project, harness, work mode and worktree; (2) a second host
  // dialog previews the exact prompt built from the issues as they are NOW and the service remembers a fingerprint of those
  // issues; (3) on confirmation the board is read again and, only if every selected issue is still what the preview showed,
  // `panda.tasks.start` creates exactly one task with that previewed prompt. The host labels the task with the package name
  // (R0402). A change between the preview and the confirmation, an offline tracker or a missing `tasks.start` grant creates
  // nothing. Fake agents only in routine acceptance: Start never authorizes a real harness.
  const MAX_START = 12;
  const MODES = {
    research: { host: 'ask', lead: 'Research these issues. Read the code and the tracker and report findings; do not change files.', close: 'Report what you found for each issue.' },
    implementation: { host: null, lead: 'Implement these issues in this worktree.', close: 'Work on one issue at a time and report what changed for each.' },
  };
  const WORKTREES = ['current', 'new'];
  const printOf = (snapshot, ids) => {
    const ready = new Set(snapshot.readyIds), blocked = new Set(snapshot.blockedIds);
    return ids.map(id => {
      const issue = snapshot.issues.find(item => item.id === id);
      return issue ? JSON.stringify([issue.id, issue.title, issue.status, issue.assignee ?? '', issue.revision ?? null, ready.has(id), blocked.has(id)]) : JSON.stringify([id, null]);
    });
  };
  const promptFor = (snapshot, ids, mode) => {
    const lines = ids.map(id => {
      const issue = snapshot.issues.find(item => item.id === id);
      return `- ${id}: ${clean(issue?.title).slice(0, 120)} [${clean(issue?.status, 'open')}]${issue?.assignee ? ` (assignee ${clean(issue.assignee)})` : ''}`;
    });
    return [`Work board handoff (${mode}).`, MODES[mode].lead, '', ...lines, '', MODES[mode].close].join('\n');
  };
  const titleFor = ids => `Work board: ${ids[0]}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''}`;
  const choose = values => {
    const project = String(values?.project ?? '').trim(), harness = String(values?.harness ?? '').trim();
    const mode = String(values?.mode ?? ''), worktree = String(values?.worktree ?? '');
    if (!ID.test(project) || (harness && !/^[A-Za-z0-9._/-]{1,128}$/.test(harness)) || !MODES[mode] || !WORKTREES.includes(worktree)) throw refused('Choose a project, a work mode and a worktree.', 'InvalidShape');
    return { project, harness, mode, worktree };
  };
  const startWork = async ids => {
    if (state.starting) throw refused('A start is already waiting for an answer.', 'Busy');
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_START || new Set(ids).size !== ids.length) throw refused(`Select between 1 and ${MAX_START} issues.`, 'InvalidShape');
    for (const id of ids) { const issue = issueOf(id); if (issue.status === 'closed') throw refused(`${id} is closed.`, 'InvalidState'); }
    if (state.offline) throw refused('The tracker is offline; start again after it answers.', 'Unreachable');
    state.starting = true;
    try {
      // Step 1: the choices.
      const chosen = await panda.ui.showDialog({
        title: 'Start an agent task',
        fields: [
          { id: 'project', label: 'Project', kind: 'text', required: true, value: state.project },
          { id: 'harness', label: 'Harness (blank: your default)', kind: 'text', value: '' },
          { id: 'mode', label: 'Mode', kind: 'select', required: true, options: [{ value: 'research', label: 'Research' }, { value: 'implementation', label: 'Implementation' }] },
          { id: 'worktree', label: 'Worktree', kind: 'select', required: true, options: [{ value: 'current', label: 'Current checkout' }, { value: 'new', label: 'New worktree' }] },
        ],
        confirmLabel: 'Preview', successMessage: 'Choices kept',
      });
      if (chosen?.status !== 'confirmed') return { status: 'cancelled' };
      const pick = choose(chosen.values);
      state.project = pick.project;
      // Step 2: the preview. The prompt and the fingerprint are fixed here.
      const ids2 = [...ids];
      const snapshot = state.snapshot;
      const prompt = promptFor(snapshot, ids2, pick.mode), print = printOf(snapshot, ids2), title = titleFor(ids2);
      const confirmed = await panda.ui.showDialog({
        title: 'Start an agent task: preview',
        fields: [{ id: 'prompt', label: `Prompt, sent exactly as shown (${pick.project}, ${pick.harness || 'default harness'}, ${pick.mode}, ${pick.worktree} worktree)`, kind: 'textarea', rows: 10, value: prompt }],
        confirmLabel: 'Start', successMessage: 'Starting',
      });
      if (confirmed?.status !== 'confirmed') return { status: 'cancelled' };
      // Step 3: read the board again; anything that moved since the preview rejects the start and creates nothing.
      await refresh().catch(refuse);
      if (state.offline) throw refused('The tracker went offline before the start; nothing was created.', 'Unreachable');
      const now = printOf(state.snapshot, ids2);
      const moved = ids2.filter((_, index) => now[index] !== print[index]);
      if (moved.length) throw refused(`${moved.join(', ')} changed since the preview; nothing was started. Preview again.`, 'Conflict');
      let task;
      try {
        task = await panda.tasks.start({
          projectId: pick.project, prompt, title, worktree: pick.worktree,
          ...(pick.harness ? { harness: pick.harness } : {}), ...(MODES[pick.mode].host ? { mode: MODES[pick.mode].host } : {}),
        });
      } catch (error) {
        const code = String(error?.code ?? 'Failed');
        throw refused(code === 'PermissionDenied' ? 'Starting tasks is not allowed for Work board (tasks.start); nothing was started.' : `The task could not be started (${code}); nothing was started.`, code);
      }
      state.starts += 1;
      state.started.set(task.id, { ids: ids2, title, project: pick.project });
      for (const id of ids2) state.agents[id] = 'Agent running';
      await render(true);
      report();
      return { status: 'started', taskId: task.id, message: `Started ${task.id} for ${ids2.join(', ')}.` };
    } finally { state.starting = false; }
  };
  // The turn of a task the board started ended: the linked issues say so, and a notice names the issue (the host adds the package).
  const agentEnded = async (event, label, tone) => {
    const entry = state.started.get(String(event?.taskId ?? ''));
    if (!entry) return;
    for (const id of entry.ids) state.agents[id] = label;
    await Promise.resolve(panda.ui.notify({ key: `agent-${event.taskId}`, title: 'Work board', text: `${label}: ${entry.ids.join(', ')}`, tone })).catch(refuse);
    await render(true);
    report();
  };

  const answerPanel = async (message, from) => {
    const op = message?.kind;
    const target = from?.instanceId ? { instance: from.instanceId } : undefined;
    const tell = body => Promise.resolve(panel.post(VIEW, body, target)).catch(refuse);
    if (op === 'start') {
      // The dialogs wait for the user: the panel's other messages never queue behind them.
      void (async () => {
        try {
          const done = await startWork(message.ids);
          if (done.status === 'started') await tell({ kind: 'result', op, id: '', ok: true, message: done.message, taskId: done.taskId });
          else await tell({ kind: 'result', op, id: '', ok: false, code: 'Cancelled', message: 'Start cancelled; nothing was created.' });
        } catch (error) { await tell({ kind: 'result', op, id: '', ok: false, code: String(error?.code ?? 'Failed'), message: error?.text ?? `start failed (${error?.code ?? 'Failed'}).` }); }
      })().catch(refuse);
      return null;
    }
    if (op === 'detail') {
      try { await tell(await detailOf(message.id)); } catch (error) { await tell({ kind: 'result', op, id: String(message.id ?? ''), ok: false, code: String(error?.code ?? 'Failed'), message: error?.text ?? `Could not read ${message.id}.` }); }
      return null;
    }
    if (!['claim', 'close', 'undo'].includes(op)) return null;
    state.acts += 1;
    let outcome;
    try {
      const text = op === 'claim' ? await claimIssue(message.id) : op === 'close' ? await closeIssue(message.id, message.reason) : await undoLast();
      state.notice = op === 'undo' ? null : state.notice;
      outcome = { kind: 'result', op, id: String(message.id ?? state.undo?.id ?? ''), ok: true, message: text };
    } catch (error) {
      outcome = { kind: 'result', op, id: String(message.id ?? ''), ok: false, code: String(error?.code ?? 'Failed'), message: error?.text ?? `${op} failed (${error?.code ?? 'Failed'}).` };
    }
    // Read again at once so the board shows what the tracker says; the daemon's own change event makes at most one more.
    await refresh().catch(refuse);
    outcome.undo = undoLabel();
    await tell(outcome);
    report();
    return null;
  };

  const guardAnswer = (message, from) => answerPanel(message, from).catch(refuse);

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
  if (panel) {
    try {
      disposers.push(panel.on('opened', instance => { void Promise.resolve(sendBoard(instance?.instanceId)).catch(refuse); }));
      disposers.push(panel.onMessage(VIEW, guardAnswer));
    } catch (error) { refuse(error); }
  }

  const on = (kind, handler) => { try { disposers.push(panda.events.on(kind, guard(handler))); } catch (error) { refuse(error); } };
  on('settings.changed', async () => {
    const moved = await readSettings();
    await render(true);
    report();
    if (moved) await refresh();
  });
  // A switch of task or project changes nothing on the board: it is one tracker. It is counted, and nothing is rebuilt.
  for (const kind of ['task.shown', 'project.opened', 'project.closed']) on(kind, event => { state.switches += 1; if (kind !== 'project.closed' && typeof event?.projectId === 'string') state.project = event.projectId; report(); });
  // Cut C: the turn of a task this board started ended.
  on('turn.finished', event => agentEnded(event, 'Agent finished', 'success'));
  on('turn.failed', event => agentEnded(event, 'Agent failed', 'warning'));
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
