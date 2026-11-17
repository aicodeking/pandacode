// R0306 fixture service (installed Windows qualification of rich panels). Staged by `../../qualify.mjs`, which replaces
// the two placeholders below with JSON-escaped text: B1's TCP address (the fake daemon the runner started) and a
// test-owned file where this service writes what it saw. The status line (at most 200 characters) is only a summary.
//
// What it does for its panel `sample.windows-panels/board`:
// - `stream {frames}`: subscribes to B1 metrics and posts one `frame` per sample of machine `m1` to the asking
//   instance until the budget is spent, then `stream-done` (canvas streaming).
// - `claim`: claims B1's first ready issue for the asking instance and answers `claimed` (action response).
// - `start-task {projectId, prompt}`: starts a task on the declared fake agent with `tasks.start` and answers `task`.
// - every 500 ms: counts the live instances and posts a `heartbeat` (the channel is live while it is delivered).
// - records the workspace events of the tasks it started (turn started/finished/failed, task stopped).
const net = require('node:net');
const fs = require('node:fs');

const B1 = '__B1_ADDRESS__';
const LOG = '__SERVICE_LOG__';
const VIEW = 'sample.windows-panels/board';
const AGENT = 'sample.windows-panels-agent/fake';
const LIMIT = 200;

exports.service = async (panda, lifetime) => {
  const seen = {
    schemaVersion: 1, kind: 'windows-panels-service', reason: lifetime.reason, restarts: lifetime.restarts, pid: process.pid,
    opened: [], closed: [], visible: [], hidden: [], messages: 0,
    stream: { requested: 0, posted: 0, delivered: 0, refused: 0 },
    claims: [], tasks: [], events: [], instances: [], heartbeat: [], refused: [], stopped: null,
  };
  const push = (list, value) => { list.push(value); if (list.length > LIMIT) list.splice(0, list.length - LIMIT); };
  let writing = null, dirty = false;
  const write = () => {
    if (writing) { dirty = true; return; }
    writing = fs.promises.writeFile(`${LOG}.tmp`, JSON.stringify(seen)).then(() => fs.promises.rename(`${LOG}.tmp`, LOG)).catch(() => {}).finally(() => { writing = null; if (dirty) { dirty = false; write(); } });
  };
  const report = () => {
    write();
    void lifetime.setStatus({ text: `frames ${seen.stream.posted}/${seen.stream.requested} claims ${seen.claims.length} tasks ${seen.tasks.length} instances ${seen.instances.at(-1)?.count ?? 0}`.slice(0, 200) }).catch(() => {});
  };
  const refuse = (where, error) => { push(seen.refused, { where, code: String(error?.code ?? error?.message ?? error), at: Date.now() }); report(); };

  // B1: newline-delimited JSON over TCP.
  let sequence = 0, buffer = '';
  const pending = new Map();
  const listeners = new Set();
  const [host, port] = B1.split(':');
  const socket = net.connect({ host, port: Number(port) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      let frame; try { frame = JSON.parse(buffer.slice(0, index)); } catch { frame = null; }
      buffer = buffer.slice(index + 1);
      if (!frame) continue;
      if (typeof frame.event === 'string') { for (const listener of [...listeners]) listener(frame); continue; }
      const waiter = pending.get(frame.id); if (!waiter) continue;
      pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.result); else waiter.reject(Object.assign(new Error(frame.error?.code ?? 'Failed'), { code: frame.error?.code ?? 'Failed' }));
    }
  });
  const request = (op, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.write(`${JSON.stringify({ id, op, params })}\n`); });
  await request('hello');

  // Canvas streaming: one budget per asking instance; B1 samples drive the frames.
  const streams = new Map();
  let subscribed = false;
  listeners.add(frame => {
    if (frame.event !== 'metrics.sample' || frame.data?.machine !== 'm1') return;
    for (const [instance, stream] of streams) {
      if (stream.left <= 0) continue;
      const seq = stream.sent++; stream.left--;
      seen.stream.posted++;
      panda.views.post(VIEW, { kind: 'frame', seq, cpu: frame.data.cpu, mem: frame.data.mem }, { instance }).then(answer => { seen.stream.delivered += answer.delivered; if (stream.left <= 0 && seq === stream.sent - 1) return panda.views.post(VIEW, { kind: 'stream-done', posted: stream.sent }, { instance }); }, error => { seen.stream.refused++; refuse('stream', error); }).finally(report);
    }
  });

  for (const kind of ['opened', 'closed', 'visible', 'hidden']) panda.views.on(kind, instance => { push(seen[kind], { instance: instance.instanceId, placement: instance.placement ?? null, at: Date.now() }); report(); });

  panda.views.onMessage(VIEW, async (message, from) => {
    seen.messages++;
    const answer = value => panda.views.post(VIEW, value, { instance: from.instanceId }).catch(error => refuse('answer', error));
    try {
      if (message?.kind === 'stream') {
        const frames = Math.max(1, Math.min(120, Number(message.frames) || 0));
        seen.stream.requested += frames;
        streams.set(from.instanceId, { left: frames, sent: 0 });
        if (!subscribed) { subscribed = true; await request('subscribe', { topic: 'metrics', intervalMs: 100 }); }
      } else if (message?.kind === 'claim') {
        const snapshot = await request('issues.snapshot');
        const id = snapshot.readyIds[0];
        const issue = await request('issues.claim', { id, actor: from.instanceId });
        push(seen.claims, { instance: from.instanceId, issueId: issue.id, status: issue.status, at: Date.now() });
        await answer({ kind: 'claimed', ok: true, issueId: issue.id, status: issue.status, assignee: issue.assignee });
      } else if (message?.kind === 'start-task') {
        const task = await panda.tasks.start({ projectId: String(message.projectId), prompt: String(message.prompt), harness: AGENT, title: 'Windows panels qualification task' });
        push(seen.tasks, { id: task.id, projectId: task.projectId, at: Date.now() });
        await answer({ kind: 'task', ok: true, id: task.id });
      }
    } catch (error) {
      refuse(message?.kind ?? 'message', error);
      await answer({ kind: 'error', for: message?.kind ?? null, code: String(error?.code ?? error?.message ?? error) });
    }
    report();
  });

  // The tasks this service started: their turns must finish while a panel faults.
  const mine = event => seen.tasks.some(task => task.id === event.taskId);
  for (const kind of ['turn.started', 'turn.finished', 'turn.failed', 'task.stopped']) {
    panda.events.on(kind, event => { if (mine(event)) { push(seen.events, { kind, taskId: event.taskId, index: event.index ?? null, at: Date.now() }); report(); } });
  }

  // The channel is live while instances exist and a heartbeat is delivered; after disable/revoke/safe mode it is not.
  const beat = setInterval(() => {
    panda.views.instances(VIEW).then(list => { push(seen.instances, { count: list.length, at: Date.now() }); return panda.views.post(VIEW, { kind: 'heartbeat', at: Date.now() }); })
      .then(answer => push(seen.heartbeat, { delivered: answer.delivered, at: Date.now() }), error => push(seen.heartbeat, { error: String(error?.code ?? error?.message ?? error), at: Date.now() }))
      .finally(report);
  }, 500);

  lifetime.onStop(async reason => {
    clearInterval(beat);
    seen.stopped = { reason, at: Date.now() };
    try { fs.writeFileSync(LOG, JSON.stringify(seen)); } catch { /* the runner reports a missing record */ }
    socket.end();
  });
  report();
};
