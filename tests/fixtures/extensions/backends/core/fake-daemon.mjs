// Browser-importable state machine. Time and event delivery are injected.
export function createDaemon({ now = () => Date.now(), emit = () => {}, seed = {} } = {}) {
  let issues, machines, histories, scripts, transfers, revision, sequence, serial;
  const copy = value => structuredClone(value);
  const error = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
  function reset() {
    issues = new Map(); machines = new Map(); histories = new Map(); scripts = new Map(); transfers = new Map();
    revision = 0; sequence = 0; serial = 0;
    for (const item of seed.issues ?? []) put(item);
    for (const item of seed.machines ?? []) machine(item);
  }
  function event(topic, name, data) { emit(topic, { event: name, seq: ++sequence, data: copy(data) }); }
  function put(value) {
    let id = value.id;
    if (!id) { do { id = `T-${++serial}`; } while (issues.has(id)); }
    const old = issues.get(id);
    const item = { title: id, type: 'task', priority: 2, status: 'open', assignee: null, labels: [], description: '', dependsOn: [], ...old, ...copy(value), id, revision: ++revision, updatedAt: now() };
    issues.set(id, item);
    event('issues', 'issues.changed', { ids: [id], revision });
    return copy(item);
  }
  function snapshot() {
    const all = [...issues.values()];
    const blocked = item => item.status === 'blocked' || item.dependsOn.some(id => issues.get(id)?.status !== 'closed');
    return copy({ issues: all, readyIds: all.filter(x => x.status === 'open' && !blocked(x)).map(x => x.id), blockedIds: all.filter(x => x.status !== 'closed' && blocked(x)).map(x => x.id), revision, fetchedAt: now() });
  }
  function machine(value) {
    if (!value.id) error('InvalidArgument', 'Machine id required');
    const item = { name: value.id, online: true, lastSeen: now(), cpu: 0, mem: 0, ...machines.get(value.id), ...copy(value) };
    machines.set(item.id, item);
    event('metrics', 'metrics.machine', item);
    return copy(item);
  }
  function sample(id) {
    const item = machines.get(id);
    if (!item?.online) return null;
    const next = scripts.get(id)?.shift();
    if (next) Object.assign(item, next);
    item.lastSeen = now();
    const value = { machine: id, t: now(), cpu: item.cpu, mem: item.mem };
    const history = histories.get(id) ?? [];
    history.push(value); histories.set(id, history.filter(x => x.t >= now() - 1800000));
    event('metrics', 'metrics.sample', value);
    return copy(value);
  }
  function request(op, params = {}) {
    if (op === 'hello') return { server: 'fake-daemon', version: 1 };
    if (op === 'ack') return { acknowledged: params.signal };
    if (op === 'subscribe') {
      if (!['issues', 'metrics', 'signals'].includes(params.topic)) error('UnknownTopic');
      return { revision };
    }
    if (op === 'issues.snapshot') {
      const value = snapshot();
      if (new TextEncoder().encode(JSON.stringify(value)).length < 60000) return value;
      const text = JSON.stringify(value), parts = [];
      // Code-point chunks keep UTF-8 and JSON escaping below the wire cap.
      const points = Array.from(text);
      for (let i = 0; i < points.length; i += 6000) parts.push(points.slice(i, i + 6000).join(''));
      const transfer = `transfer-${++serial}`;
      transfers.set(transfer, parts);
      return { chunks: parts.length, transfer };
    }
    if (op === 'issues.chunk') {
      const parts = transfers.get(params.transfer);
      if (!parts || !Number.isInteger(params.index) || !parts[params.index]) error('UnknownChunk');
      return { transfer: params.transfer, index: params.index, text: parts[params.index] };
    }
    if (op === 'issues.create') return put(params);
    if (op.startsWith('issues.') || op.startsWith('deps.') || op === 'comments.add') {
      const item = issues.get(params.issueId ?? params.id);
      if (!item) error('NotFound');
      if (params.ifRevision !== undefined && params.ifRevision !== item.revision) error('Conflict');
      if (op === 'issues.get') return copy(item);
      if (op === 'issues.update') return put({ ...item, ...params.patch, id: item.id });
      if (op === 'issues.claim') return put({ ...item, assignee: params.actor, status: 'in_progress' });
      if (op === 'issues.close') return put({ ...item, status: 'closed', closeReason: params.reason ?? '' });
      if (op === 'issues.reopen') return put({ ...item, status: 'open' });
      if (op === 'deps.add') return put({ ...item, dependsOn: [...new Set([...item.dependsOn, params.dependsOn])] });
      if (op === 'deps.remove') return put({ ...item, dependsOn: item.dependsOn.filter(x => x !== params.dependsOn) });
      if (op === 'comments.add') return put({ ...item, comments: [...item.comments ?? [], { text: params.text, t: now() }] });
    }
    if (op === 'metrics.machines') return copy([...machines.values()]);
    if (op === 'metrics.history') return copy((histories.get(params.machine) ?? []).filter(x => x.t >= (params.sinceMs ?? 0)));
    error('UnknownOp', op);
  }
  function control(path, params = {}) {
    if (path === 'reset') { reset(); return { reset: true }; }
    if (path === 'signal') {
      const value = { id: `signal-${++serial}`, name: params.name, payload: params.payload };
      event('signals', 'signal', value); return value;
    }
    if (path === 'issues') {
      if (params.op === 'remove') { issues.delete(params.issue.id); ++revision; event('issues', 'issues.changed', { ids: [params.issue.id], revision }); return { removed: true }; }
      if (!['add', 'update'].includes(params.op)) error('InvalidArgument');
      return put(params.issue);
    }
    if (path === 'issues/fill') {
      if (!Number.isInteger(params.count) || params.count < 0 || params.count > 10000) error('InvalidArgument');
      issues.clear();
      for (let i = 1; i <= params.count; i++) put({ id: `T-${i}`, title: `Generated issue ${i}` });
      return { count: issues.size };
    }
    if (path === 'machine') return machine(params);
    if (path === 'metrics' || path === 'metrics/script') {
      if (!machines.has(params.machine)) machine({ id: params.machine });
      scripts.set(params.machine, copy(params.samples ?? [{ cpu: params.cpu, mem: params.mem }]));
      return { queued: scripts.get(params.machine).length };
    }
    error('UnknownControl', path);
  }
  reset();
  return { request, control, sample, snapshot };
}
