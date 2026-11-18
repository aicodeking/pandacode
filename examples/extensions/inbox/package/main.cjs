// Attention inbox (sample.inbox, R1210): one place that lists what waits for the user. A background service that
//  - keeps the open approvals and questions of the host (approval.pending / question.pending and their resolved events,
//    rebuilt from panda.hooks.pending() at start, on every idle task, after an event gap and when a panel opens, so a lost
//    event never leaves a row that no longer waits or hides one that does),
//  - answers one of them late with panda.tasks.respond (never a bypass: a mode or sandbox that holds an approval, a request
//    the user answered first, a revoked grant are results the panel shows; the host prompt stays where it was),
//  - offers three model tools (inbox_notify, inbox_ask, inbox_resolve) and a short brief for the agent,
//  - draws a rich panel (panel/) through panda.views and a badge on a status item.
// Everything is best effort: a failure here never blocks an agent and never approves anything.
const fs = require('node:fs');
const path = require('node:path');

const VIEW = 'sample.inbox/inbox';
const BADGE = 'sample.inbox/count';
const PAGE = 'sample.inbox/settings';
const NOTICE = 'sample.inbox/waiting';
const MAX_ROWS = 200;
const MAX_MESSAGES = 500;
const DAY = 86_400_000;
const BRIEF = 'Attention inbox: call inbox_notify to leave the user a message that does not block you, inbox_ask when you cannot go on without them, and inbox_resolve when that is settled.';

const text = value => (typeof value === 'string' ? value : '');
const clip = (value, size) => { const s = text(value); return s.length > size ? `${s.slice(0, size - 1)}...` : s; };
const short = input => {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return clip(input, 160);
  const first = input.command ?? input.path ?? input.file_path ?? input.url ?? input.query;
  return clip(typeof first === 'string' ? first : JSON.stringify(input), 160);
};

exports.service = async (panda, lifetime) => {
  const now = () => Date.now();
  const rows = new Map();            // id -> waiting row (approvals and questions by requestId, asks, failures)
  let messages = [];
  const briefed = new Set();
  let revision = Math.floor(now() / 1000);   // grows across restarts too, so a panel never ignores a restarted service
  let focused = true;
  let seq = 0;
  let directory = null;
  const settings = { retentionDays: 7, notifyDelaySec: 120, brief: true };
  const titles = new Map();          // taskId -> last title seen, for labels

  // ---- storage (messages only; the host's open requests are never persisted: they come from the host) -------------
  const file = () => (directory ? path.join(directory, 'inbox.json') : null);
  const save = () => {
    const target = file();
    if (!target) return;
    try { fs.writeFileSync(target, JSON.stringify({ seq, messages })); } catch { /* the inbox lives on without its file */ }
  };
  const load = async () => {
    try {
      directory = (await panda.storage.directory({ scope: 'global' })).path;
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (Array.isArray(saved.messages)) messages = saved.messages.slice(-MAX_MESSAGES);
      if (Number.isInteger(saved.seq)) seq = saved.seq;
    } catch { /* first run, no grant, or a damaged file: start empty */ }
  };
  const readSettings = async () => {
    try {
      const { values } = await panda.settings.get({ page: PAGE });
      const days = Number.parseInt(values['retention-days'], 10);
      const delay = Number.parseInt(values['notify-delay-sec'], 10);
      settings.retentionDays = Number.isFinite(days) && days > 0 ? days : 7;
      settings.notifyDelaySec = Number.isFinite(delay) && delay >= 0 ? delay : 120;
      settings.brief = values.brief !== false;
    } catch { /* keep the last good values */ }
  };

  // ---- the model of the inbox -------------------------------------------------------------------------------------
  const prune = () => {
    const limit = now() - settings.retentionDays * DAY;
    const before = messages.length;
    messages = messages.filter(message => message.at >= limit).slice(-MAX_MESSAGES);
    return messages.length !== before;
  };
  const unread = () => messages.filter(message => !message.read).length;
  const byProject = () => {
    const counts = {};
    for (const row of rows.values()) { const key = row.projectId ?? ''; counts[key] = (counts[key] ?? 0) + 1; }
    return counts;
  };
  const snapshot = () => ({
    type: 'inbox', revision, at: now(), unread: unread(), waitingCount: rows.size, byProject: byProject(),
    waiting: [...rows.values()].slice(0, MAX_ROWS),
    messages: messages.slice(-MAX_MESSAGES).reverse(),
  });
  const push = async instance => {
    try { await panda.views.post(VIEW, snapshot(), instance ? { instance } : undefined); } catch { /* no panel is open */ }
  };
  const badge = async () => {
    const n = rows.size + unread();
    try {
      await panda.ui.update(BADGE, { badge: n ? String(n) : '', tone: rows.size ? 'warning' : 'neutral', tooltip: `${rows.size} waiting, ${unread()} unread.` });
    } catch { /* the grant was revoked: the panel and the tools go on */ }
  };
  const changed = async (persist) => {
    revision += 1;
    if (persist) save();
    await Promise.allSettled([push(), badge()]);
  };

  const addRow = row => {
    if (!rows.has(row.id) && rows.size >= MAX_ROWS) rows.delete(rows.keys().next().value);
    rows.set(row.id, row);
  };
  const approvalRow = request => ({
    id: request.requestId, kind: 'approval', requestId: request.requestId, taskId: request.taskId, projectId: request.projectId ?? null,
    title: titles.get(request.taskId) ?? request.taskId, tool: request.tool?.name ?? 'tool', toolKind: request.tool?.kind ?? 'other',
    input: short(request.input ?? request.text), at: request.at ? Date.parse(request.at) || now() : now(),
    askedBy: request.askedBy ?? null, mode: request.mode ?? null, notified: false,
  });
  const questionRow = request => ({
    id: request.requestId, kind: 'question', requestId: request.requestId, taskId: request.taskId, projectId: request.projectId ?? null,
    title: titles.get(request.taskId) ?? request.taskId, text: clip((request.questions ?? []).map(q => q.question).join(' / '), 300),
    questions: (request.questions ?? []).slice(0, 8).map(q => ({ id: text(q.id), question: clip(q.question, 300), options: (q.options ?? []).slice(0, 12).map(o => clip(o.label ?? o, 80)), secret: q.secret === true })),
    at: request.at ? Date.parse(request.at) || now() : now(), notified: false,
  });

  // Rebuild the host's open set: whatever the snapshot does not list is gone, whatever it lists is there. Own rows (asks,
  // failures) are never touched, and a resolved request never comes back because the host never lists one.
  let resyncing = null;
  const resync = () => {
    resyncing ??= (async () => {
      try {
        const open = await panda.hooks.pending();
        const keep = new Map();
        for (const row of rows.values()) if (row.kind === 'ask' || row.kind === 'failed') keep.set(row.id, row);
        for (const request of open.approvals) keep.set(request.requestId, { ...approvalRow(request), notified: rows.get(request.requestId)?.notified ?? false });
        for (const request of open.questions) keep.set(request.requestId, { ...questionRow(request), notified: rows.get(request.requestId)?.notified ?? false });
        rows.clear();
        for (const [id, row] of keep) rows.set(id, row);
        await changed(false);
      } catch { /* UnknownReference before the hooks attach, or the service is stopping: the next trigger tries again */ }
      finally { resyncing = null; }
    })();
    return resyncing;
  };

  // ---- hooks ------------------------------------------------------------------------------------------------------
  const hooks = [
    panda.hooks.on('approval.pending', request => { if (request?.requestId) { addRow(approvalRow(request)); return changed(false); } }),
    panda.hooks.on('question.pending', request => { if (request?.requestId) { addRow(questionRow(request)); return changed(false); } }),
    panda.hooks.on('approval.resolved', ended => { if (rows.delete(ended?.requestId)) return changed(false); }),
    panda.hooks.on('question.resolved', ended => { if (rows.delete(ended?.requestId)) return changed(false); }),
    panda.hooks.on('turn.fail', failure => {
      if (!failure?.taskId) return;
      const id = `failed:${failure.taskId}`;
      addRow({ id, kind: 'failed', taskId: failure.taskId, projectId: failure.projectId ?? null, title: titles.get(failure.taskId) ?? failure.taskId, text: clip(failure.error?.message ?? failure.error ?? failure.reason ?? 'The turn failed.', 300), at: now(), notified: false });
      return changed(false);
    }),
    // A task that goes idle keeps its own rows; the open set is read again because deliveries are one-way.
    panda.hooks.on('task.idle', () => resync()),
    panda.hooks.on('prompt.submit', payload => {
      if (!settings.brief || !payload?.taskId || briefed.has(payload.taskId)) return undefined;
      briefed.add(payload.taskId);
      return { context: BRIEF };
    }),
  ];

  // ---- answering ---------------------------------------------------------------------------------------------------
  const outcome = (op, id, error) => ({ type: 'result', op, id, ok: !error, code: error ? (error.code ?? 'Failed') : null, message: error ? clip(error.message ?? '', 200) : null });
  const tell = async result => { try { await panda.views.post(VIEW, result); } catch { /* the panel closed */ } return result; };
  const answer = async (op, id, reply) => {
    const row = rows.get(id);
    if (!row || (row.kind !== 'approval' && row.kind !== 'question')) return tell(outcome(op, id, Object.assign(new Error('Not waiting any more.'), { code: 'StaleContext' })));
    try {
      await panda.tasks.respond(row.taskId, row.requestId, reply);
      rows.delete(id);
      await changed(false);
      return tell(outcome(op, id));
    } catch (error) {
      // StaleContext / NotFound: the user or another package answered first, so the row is stale and leaves. Every other
      // refusal (a mode or sandbox that holds an approve, a missing grant) leaves the request with the user's own prompt.
      if (error?.code === 'StaleContext' || error?.code === 'NotFound') { rows.delete(id); await changed(false); }
      return tell(outcome(op, id, error));
    }
  };

  const go = async (op, id) => {
    const row = rows.get(id) ?? messages.find(message => message.id === id);
    if (!row?.taskId) return tell(outcome(op, id, Object.assign(new Error('No task.'), { code: 'NotFound' })));
    try { await panda.ui.reveal({ taskId: row.taskId }); return tell(outcome(op, id)); } catch (error) { return tell(outcome(op, id, error)); }
  };

  const handle = async (op, id) => {
    const row = rows.get(id);
    if (row?.kind === 'ask' || row?.kind === 'failed') { rows.delete(id); await changed(true); return tell(outcome(op, id)); }
    return tell(outcome(op, id, Object.assign(new Error('Only the inbox\'s own rows can be marked handled.'), { code: 'InvalidShape' })));
  };

  const read = async (op, id) => {
    const message = messages.find(item => item.id === id);
    if (message) message.read = true;
    await changed(true);
    return tell(outcome(op, id, message ? undefined : Object.assign(new Error('No such message.'), { code: 'NotFound' })));
  };

  const reply = async (op, id, body) => {
    const message = messages.find(item => item.id === id);
    const value = clip(body, 4000).trim();
    if (!message?.taskId || !value) return tell(outcome(op, id, Object.assign(new Error('Nothing to send.'), { code: 'InvalidShape' })));
    try { await panda.tasks.message(message.taskId, { text: value, delivery: 'queue' }); return tell(outcome(op, id)); } catch (error) { return tell(outcome(op, id, error)); }
  };

  const dispatch = async (message) => {
    if (!message || typeof message !== 'object') return undefined;
    const id = text(message.id);
    switch (message.op) {
      case 'sync': return push();
      case 'approve': return answer('approve', id, { approved: true, reason: 'Approved through the Attention inbox.' });
      case 'deny': return answer('deny', id, { approved: false, reason: clip(message.reason, 4000) || 'Denied through the Attention inbox.' });
      case 'answer': return answer('answer', id, { answers: message.answers && typeof message.answers === 'object' ? message.answers : {} });
      case 'go': return go('go', id);
      case 'handle': return handle('handle', id);
      case 'read': return read('read', id);
      case 'reply': return reply('reply', id, message.text);
      default: return undefined;                // a message the service does not know changes nothing
    }
  };

  // ---- model tools --------------------------------------------------------------------------------------------------
  const labelOf = call => titles.get(call.taskId) ?? call.taskId;
  const tools = [
    panda.modelTools.register('sample.inbox/notify', async (input, call) => {
      seq += 1;
      messages.push({ id: `m${seq}`, taskId: call.taskId, projectId: call.projectId ?? null, task: labelOf(call), text: clip(input.message, 1000), url: input.url ? clip(input.url, 2000) : null, at: now(), read: false });
      prune();
      await changed(true);
      return { content: { ok: true, id: `m${seq}` } };
    }),
    panda.modelTools.register('sample.inbox/ask', async (input, call) => {
      seq += 1;
      const id = `ask:${seq}`;
      addRow({ id, kind: 'ask', taskId: call.taskId, projectId: call.projectId ?? null, title: labelOf(call), text: clip(input.message, 1000), at: now(), notified: false });
      await changed(true);
      return { content: { ok: true, id } };
    }),
    panda.modelTools.register('sample.inbox/resolve', async (input, call) => {
      const own = [...rows.values()].filter(row => row.kind === 'ask' && row.taskId === call.taskId);
      const target = input.id ? own.find(row => row.id === input.id) : own.at(-1);
      if (!target) return { content: { ok: false, reason: 'No waiting row of this task.' }, isError: true };
      rows.delete(target.id);
      await changed(true);
      return { content: { ok: true, id: target.id } };
    }),
  ];

  // ---- events, the delay notice, the panel ----------------------------------------------------------------------------
  const tick = async () => {
    let dirty = prune();
    const limit = settings.notifyDelaySec * 1000;
    if (!focused && limit > 0) {
      const late = [...rows.values()].filter(row => !row.notified && now() - row.at >= limit);
      if (late.length) {
        for (const row of late) row.notified = true;
        try { await panda.ui.notify({ key: NOTICE, text: late.length === 1 ? `${late[0].title} is waiting for you.` : `${late.length} items are waiting for you.`, tone: 'warning' }); } catch { /* no grant */ }
        dirty = true;
      }
    }
    if (dirty) await changed(true);
  };

  const events = [
    panda.events.on('app.focus', event => { focused = event.focused === true; }),
    panda.events.on('gap', () => resync()),
    panda.events.on('settings.changed', event => (event.page === PAGE ? readSettings() : undefined)),
    panda.events.on('task.created', event => { briefed.delete(event.taskId); }),
    panda.events.on('task.removed', async event => {
      let dirty = false;
      for (const [id, row] of rows) if (row.taskId === event.taskId) { rows.delete(id); dirty = true; }
      briefed.delete(event.taskId);
      if (dirty) await changed(true);
    }),
    panda.events.on('turn.started', async event => {
      // A new turn answers a failure: its row goes; an ask stays until it is handled.
      if (rows.delete(`failed:${event.taskId}`)) await changed(false);
    }),
  ];
  const views = [
    panda.views.onMessage(VIEW, message => dispatch(message)),
    panda.views.on('opened', instance => { if (instance.viewId === VIEW) return push(instance.instanceId); }),
  ];

  panda.commands.register('sample.inbox/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'list': return { waiting: [...rows.keys()], messages: messages.map(message => message.id), unread: unread(), revision, settings: { ...settings } };
      case 'resync': await resync(); return { waiting: [...rows.keys()], revision };
      case 'tick': await tick(); return { waiting: [...rows.keys()], notified: [...rows.values()].filter(row => row.notified).map(row => row.id) };
      case 'dispatch': await dispatch(args.message); return { waiting: [...rows.keys()], revision };
      default: throw new Error('InvalidShape');
    }
  });

  await load();
  await readSettings();
  await Promise.allSettled([...hooks, ...tools].map(item => item.ready));
  await resync();
  await badge();
  const timer = setInterval(() => { void tick(); }, 5000);
  timer.unref?.();
  lifetime.onStop(() => {
    clearInterval(timer);
    for (const item of [...hooks, ...tools, ...events, ...views]) { try { item?.dispose?.(); } catch { /* already gone */ } }
    rows.clear();
  });
};
