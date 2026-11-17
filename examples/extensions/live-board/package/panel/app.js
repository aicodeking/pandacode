// Work board, cut B: the rich panel of sample.live-board. It draws the service's snapshot and sends the user's wishes
// back; it never reads the tracker itself. The service sends `board.begin` (counts, the daemon's own readyIds and
// blockedIds, the stale marking) followed by `board.rows` chunks; this page assembles one board at a time, keeps showing
// the previous board while a new one arrives, and draws only the rows in view so that thousands of issues stay light.
// `window.__liveBoard` and `window.__liveBoardDo` are what the qualification reads and drives; the product does not need them.
const view = window.pandaView;
const ROW = 28, OVERSCAN = 8;
const el = id => document.getElementById(id);
const viewport = el('viewport'), spacer = el('spacer');

const observed = window.__liveBoard = {
  boot: crypto.randomUUID(), init: null, visibility: [], boards: [], results: [], details: [], renders: 0, rowsInDom: 0, unknown: false,
};
let board = null;        // the committed board: { meta, issues, ready:Set, blocked:Set }
let building = null;     // the board being assembled
let selected = null;
let statusOf = new Map();

const remember = () => { try { view.state.set({ selected, scrollTop: viewport.scrollTop }); } catch { /* the bound is 256 KiB; two fields never reach it */ } };
const send = async message => { try { await view.postMessage(message); } catch (error) { observed.results.push({ ok: false, local: true, code: error?.code ?? 'Failed' }); show('result', `${error?.code ?? 'Failed'}: ${error?.message ?? ''}`); } };
const show = (id, text) => { el(id).textContent = text; };

function statusFor(issue) {
  return board.ready.has(issue.id) ? 'ready' : board.blocked.has(issue.id) ? 'blocked' : issue.status;
}

function draw() {
  if (!board) return;
  observed.renders += 1;
  const total = board.issues.length;
  spacer.style.height = `${total * ROW}px`;
  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW) - OVERSCAN);
  const last = Math.min(total, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW) + OVERSCAN);
  const fragment = document.createDocumentFragment();
  for (let index = first; index < last; index += 1) {
    const issue = board.issues[index];
    const status = statusFor(issue);
    const row = document.createElement('div');
    row.className = 'row'; row.role = 'option'; row.dataset.id = issue.id; row.dataset.status = status;
    row.setAttribute('aria-selected', String(issue.id === selected));
    row.style.top = `${index * ROW}px`;
    for (const [name, text] of [['id', issue.id], ['title', issue.title], ['status', status], ['assignee', issue.assignee || '-']]) {
      const cell = document.createElement('span'); cell.className = name; cell.textContent = text; row.append(cell);
    }
    fragment.append(row);
  }
  spacer.replaceChildren(fragment);
  spacer.style.height = `${total * ROW}px`;
  observed.rowsInDom = last - first;
  buttons();
}

function buttons() {
  const issue = board?.issues.find(item => item.id === selected) ?? null;
  const closed = issue ? statusFor(issue) === 'closed' : true;
  el('claim').disabled = !issue || closed;
  el('close').disabled = !issue || closed;
  el('undo').disabled = !board?.meta.undo;
  el('undo').textContent = board?.meta.undo ?? 'Undo';
}

function header() {
  const meta = board.meta;
  show('counts', `${board.ready.size} ${meta.unit} of ${meta.total} issues, ${board.blocked.size} blocked`);
  show('actor', meta.actor ? `Working: ${meta.actor}` : '');
  const banner = el('banner');
  banner.dataset.shown = String(!!meta.stale);
  banner.textContent = meta.stale ? `Stale: the tracker is offline (stale since ${meta.since}). This is the last snapshot.` : '';
  const notice = el('notice');
  notice.dataset.shown = String(!!meta.notice);
  notice.textContent = meta.notice ?? '';
}

function commit(next) {
  board = next;
  statusOf = new Map(board.issues.map(issue => [issue.id, statusFor(issue)]));
  if (selected && !statusOf.has(selected)) selected = null;
  header();
  draw();
  observed.boards.push({ seq: next.meta.seq, total: next.meta.total, ready: next.ready.size, blocked: next.blocked.size, stale: !!next.meta.stale, at: Date.now() });
  observed.unknown = false;
}

function onBegin(meta) {
  building = { meta, parts: new Array(meta.parts), got: 0 };
  if (meta.parts === 0) { const done = building; building = null; commit({ meta, issues: [], ready: new Set(meta.readyIds), blocked: new Set(meta.blockedIds) }); return done; }
}
function onRows(message) {
  // A chunk of an older board that a newer begin has replaced is dropped.
  if (!building || message.seq !== building.meta.seq || building.parts[message.index]) return;
  building.parts[message.index] = message.rows;
  building.got += 1;
  if (building.got < building.meta.parts) return;
  const done = building; building = null;
  commit({ meta: done.meta, issues: done.parts.flat(), ready: new Set(done.meta.readyIds), blocked: new Set(done.meta.blockedIds) });
}

function onDetail(message) {
  observed.details.push(message.issue);
  if (message.id !== selected) return;
  const issue = message.issue;
  el('detail').textContent = `${issue.id}  ${issue.title}\nStatus: ${statusOf.get(issue.id) ?? issue.status}   Assignee: ${issue.assignee || '-'}   Revision: ${issue.revision ?? '-'}\nDepends on: ${issue.dependsOn.join(', ') || 'nothing'}${issue.description ? `\n${issue.description}` : ''}`;
}

function onResult(message) {
  observed.results.push({ op: message.op, id: message.id, ok: message.ok, code: message.code ?? null, message: message.message, undo: message.undo ?? null });
  show('result', message.message ?? '');
  el('result').dataset.ok = String(message.ok);
  if (message.op === 'detail' && !message.ok) el('detail').textContent = message.message;
}

function select(id) {
  selected = id;
  remember();
  el('detail').textContent = `${id}: reading the detail`;
  draw();
  void send({ kind: 'detail', id });
}

view.onDidInitialize(init => {
  observed.init = { viewId: view.viewId, instanceId: init.instanceId ?? null, placement: init.placement ?? null, restored: init.restored ?? null, state: init.state ?? null, at: Date.now() };
  if (init.state?.selected) selected = init.state.selected;
  if (init.state?.scrollTop) viewport.scrollTop = init.state.scrollTop;
});
view.onDidChangeVisibility(state => { observed.visibility.push({ visible: state.visible, focused: state.focused, at: Date.now() }); });
view.onMessage(message => {
  switch (message?.kind) {
    case 'board.begin': onBegin(message); break;
    case 'board.rows': onRows(message); break;
    case 'board.unknown': observed.unknown = true; show('counts', message.offline ? 'Tracker offline: nothing is known about the issues yet' : 'Waiting for the board'); break;
    case 'detail': onDetail(message); break;
    case 'result': onResult(message); break;
    default: break;
  }
});

viewport.addEventListener('scroll', () => { draw(); remember(); }, { passive: true });
viewport.addEventListener('click', event => { const row = event.target.closest?.('.row'); if (row) select(row.dataset.id); });
viewport.addEventListener('keydown', event => {
  if (!board || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const at = board.issues.findIndex(issue => issue.id === selected);
  const next = board.issues[Math.max(0, Math.min(board.issues.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
  if (!next) return;
  select(next.id);
  const top = board.issues.indexOf(next) * ROW;
  if (top < viewport.scrollTop) viewport.scrollTop = top; else if (top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW - viewport.clientHeight;
});
el('claim').addEventListener('click', () => { if (selected) void send({ kind: 'claim', id: selected }); });
el('close').addEventListener('click', () => { if (selected) void send({ kind: 'close', id: selected }); });
el('undo').addEventListener('click', () => { void send({ kind: 'undo' }); });

window.__liveBoardDo = {
  select: id => select(id),
  claim: id => send({ kind: 'claim', id: id ?? selected }),
  close: id => send({ kind: 'close', id: id ?? selected }),
  undo: () => send({ kind: 'undo' }),
  scrollTo: index => { viewport.scrollTop = index * ROW; },
  rows: () => [...spacer.children].map(row => ({ id: row.dataset.id, status: row.dataset.status })),
  counts: () => el('counts').textContent,
};
