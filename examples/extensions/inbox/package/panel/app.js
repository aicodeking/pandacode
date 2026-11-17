// Attention inbox panel (sample.inbox). It draws the service's snapshot and sends the user's wishes back; it never reads the
// host itself and never answers a request on its own: Approve, Deny and Answer are messages the service turns into
// panda.tasks.respond, and the host decides whether the request is still open and whether the task's mode allows it.
// `window.__inbox` is what the qualification reads; the product does not need it.
const view = window.pandaView;
const el = id => document.getElementById(id);
const observed = window.__inbox = { boot: crypto.randomUUID(), snapshots: 0, revision: -1, results: [], sent: [] };
let snap = null;
let draft = {};   // typed text per row id, kept across redraws and in pandaView.state

const remember = () => { try { view.state.set({ draft }); } catch { /* bounded to 256 KiB; typed text never reaches it */ } };
const send = async message => {
  observed.sent.push(message.op);
  try { await view.postMessage(message); } catch (error) { show(`${error?.code ?? 'Failed'}: ${error?.message ?? ''}`); }
};
const show = textValue => { el('result').textContent = textValue; };
const age = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };

function node(tag, className, textValue) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (textValue !== undefined) item.textContent = textValue;
  return item;
}
function button(label, op, id, extra) {
  const item = node('button', '', label);
  item.type = 'button'; item.dataset.op = op; item.dataset.id = id;
  item.addEventListener('click', () => { void send({ op, id, ...(extra ? extra() : {}) }); });
  return item;
}
function field(id, placeholder) {
  const input = node('input'); input.type = 'text'; input.placeholder = placeholder; input.value = draft[id] ?? '';
  input.addEventListener('input', () => { draft[id] = input.value; remember(); });
  return input;
}

function waitingRow(row) {
  const item = node('div', 'item'); item.setAttribute('role', 'listitem'); item.dataset.id = row.id; item.dataset.kind = row.kind;
  const head = node('div', 'head');
  const label = { approval: 'Approval', question: 'Question', ask: 'Asks you', failed: 'Failed' }[row.kind] ?? row.kind;
  head.append(node('span', 'kind', label), node('span', 'title', row.title ?? ''), node('span', 'age', age(row.at)));
  item.append(head);
  if (row.kind === 'approval') item.append(node('div', 'body', `${row.tool}: ${row.input}`));
  else item.append(node('div', 'body', row.text ?? ''));
  const actions = node('div', 'actions');
  if (row.kind === 'approval') actions.append(button('Approve', 'approve', row.id), button('Deny', 'deny', row.id, () => ({ reason: draft[`deny:${row.id}`] ?? '' })), field(`deny:${row.id}`, 'Reason (optional)'));
  if (row.kind === 'question') {
    for (const question of row.questions ?? []) if (!question.secret) actions.append(field(`${row.id}:${question.id}`, question.question.slice(0, 40)));
    actions.append(button('Answer', 'answer', row.id, () => ({ answers: Object.fromEntries((row.questions ?? []).filter(q => !q.secret && (draft[`${row.id}:${q.id}`] ?? '') !== '').map(q => [q.id, draft[`${row.id}:${q.id}`]])) })));
  }
  if (row.kind === 'ask' || row.kind === 'failed') actions.append(button('Mark handled', 'handle', row.id));
  actions.append(button('Go to task', 'go', row.id));
  item.append(actions);
  return item;
}

function messageRow(message) {
  const item = node('div', 'item'); item.setAttribute('role', 'listitem'); item.dataset.id = message.id; item.dataset.unread = String(!message.read);
  const head = node('div', 'head');
  head.append(node('span', 'kind', message.task ?? ''), node('span', 'age', age(message.at)));
  item.append(head, node('div', 'body', message.text));
  if (message.url) { const link = node('div', 'body', message.url); item.append(link); }
  const actions = node('div', 'actions');
  if (!message.read) actions.append(button('Mark read', 'read', message.id));
  actions.append(button('Go to task', 'go', message.id), field(`reply:${message.id}`, 'Reply to the task'),
    button('Reply', 'reply', message.id, () => ({ text: draft[`reply:${message.id}`] ?? '' })));
  item.append(actions);
  return item;
}

function draw() {
  if (!snap) return;
  el('counts').textContent = `${snap.waitingCount} waiting, ${snap.unread} unread`;
  const waiting = el('waiting'), messages = el('messages');
  waiting.replaceChildren(...(snap.waiting.length ? snap.waiting.map(waitingRow) : [node('div', 'empty', 'Nothing is waiting.')]));
  messages.replaceChildren(...(snap.messages.length ? snap.messages.map(messageRow) : [node('div', 'empty', 'No messages.')]));
}

view.onDidInitialize(init => {
  const saved = init.state;
  if (saved && typeof saved === 'object' && saved.draft && typeof saved.draft === 'object') draft = saved.draft;
  void send({ op: 'sync' });
});
view.onMessage(message => {
  if (message?.type === 'inbox') {
    // Revisions only grow: an older snapshot that arrives late never replaces a newer one.
    if (typeof message.revision === 'number' && message.revision < observed.revision) return;
    snap = message; observed.snapshots += 1; observed.revision = message.revision; draw();
  } else if (message?.type === 'result') {
    observed.results.push({ op: message.op, id: message.id, ok: message.ok, code: message.code });
    show(message.ok ? `${message.op}: done` : `${message.op}: ${message.code}${message.message ? ` (${message.message})` : ''}`);
  }
});
view.onDidChangeVisibility(state => { if (state.visible) void send({ op: 'sync' }); });
setInterval(draw, 30000);   // ages only
