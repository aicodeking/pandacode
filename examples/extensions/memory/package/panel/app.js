// Project memory panel: draws the service's snapshot (`kind: 'memories'`), sends a search or a delete back, and says in plain
// words which parts are not available. It never reads the store itself. `window.__memoryPanel` is what the qualification reads.
const view = window.pandaView;
const el = id => document.getElementById(id);
const observed = window.__memoryPanel = { snapshots: [], sent: [], init: null };
let timer = null;

const send = async message => { observed.sent.push(message); try { await view.postMessage(message); } catch { /* the service answers the next snapshot */ } };

function states(status) {
  const lines = [];
  lines.push([status.tool === 'active' || status.tool === 'unknown' ? '' : 'warn', `Model tool: ${status.tool}`]);
  for (const harness of status.unavailable ?? []) lines.push(['warn', `tool unavailable for ${harness}`]);
  lines.push([String(status.recall).startsWith('inactive') ? 'warn' : '', `Recall at send (${status.inject}): ${status.recall}`]);
  lines.push([String(status.capture).startsWith('raw') ? 'warn' : '', `Capture: ${status.capture}`]);
  lines.push(['', `Compaction: recall comes back after a compaction; companion ${status.compaction?.companion ?? 'pending'}`]);
  for (const text of status.notes ?? []) lines.push(['warn', text]);
  el('states').replaceChildren(...lines.map(([tone, text]) => { const row = document.createElement('div'); if (tone) row.className = tone; row.textContent = text; return row; }));
}

function draw(snapshot) {
  observed.snapshots.push({ total: snapshot.total, shown: snapshot.items.length, query: snapshot.query, project: snapshot.project, at: Date.now() });
  el('summary').textContent = `${snapshot.items.length} of ${snapshot.total} memories${snapshot.project ? ` in ${snapshot.project}` : ''}`;
  states(snapshot.status);
  el('empty').hidden = snapshot.items.length > 0;
  el('list').replaceChildren(...snapshot.items.map(item => {
    const row = document.createElement('li');
    row.dataset.id = item.id;
    const body = document.createElement('div');
    const text = document.createElement('div'); text.className = 'text'; text.textContent = item.text;
    const tags = document.createElement('div'); tags.className = 'tags'; tags.textContent = item.tags.join(' · ');
    body.append(text, tags);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete memory ${item.id}`);
    remove.addEventListener('click', () => { void send({ kind: 'delete', id: item.id }); });
    row.append(body, remove);
    return row;
  }));
}

view.onDidInitialize(init => {
  observed.init = { viewId: view.viewId, restored: init.restored ?? null, state: init.state ?? null };
  if (typeof init.state?.query === 'string') el('search').value = init.state.query;
  void send({ kind: 'ready' });
});
view.onMessage(message => { if (message?.kind === 'memories') draw(message); });
el('search').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { view.state.set({ query: el('search').value }); } catch { /* the bound is 256 KiB */ }
    void send({ kind: 'search', query: el('search').value });
  }, 150);
});

window.__memoryPanelDo = {
  search: query => { el('search').value = query; return send({ kind: 'search', query }); },
  remove: id => send({ kind: 'delete', id }),
  rows: () => [...el('list').children].map(row => ({ id: row.dataset.id, text: row.querySelector('.text').textContent })),
  states: () => el('states').textContent,
};
