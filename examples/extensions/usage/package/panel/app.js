// Usage report: the rich panel of sample.usage. The service owns the ledger and sends this page `report.data` (tokens per day,
// and per harness and model, for today, 7 and 30 days). The page only draws it on a canvas and asks for a fresh copy; it reads
// nothing else and holds no credential. `window.__usageReport` is what the qualification reads; the product does not need it.
const view = window.pandaView;
const el = id => document.getElementById(id);
const observed = window.__usageReport = { boot: crypto.randomUUID(), reports: [], draws: 0, range: 'd7' };
let data = null;
let range = 'd7';

const remember = () => { try { view.state.set({ range }); } catch { /* two fields never reach the bound */ } };

function bars(days) {
  const canvas = el('chart');
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const color = getComputedStyle(document.body).color;
  context.fillStyle = color; context.strokeStyle = color; context.font = '11px system-ui';
  const peak = Math.max(1, ...days.map(item => item.tokens));
  const slot = canvas.width / Math.max(1, days.length);
  days.forEach((item, index) => {
    const height = Math.round((item.tokens / peak) * (canvas.height - 28));
    context.globalAlpha = 0.75;
    context.fillRect(index * slot + 4, canvas.height - 16 - height, Math.max(2, slot - 8), height);
    context.globalAlpha = 1;
    if (days.length <= 10) context.fillText(item.day.slice(5), index * slot + 4, canvas.height - 3);
  });
  observed.draws += 1;
}

function draw() {
  observed.range = range;
  for (const name of ['today', 'd7', 'd30']) el(name).setAttribute('aria-pressed', String(name === range));
  const groups = el('groups');
  groups.textContent = '';
  if (!data) return;
  const picked = data.ranges[range];
  bars(picked.days);
  if (picked.groups.length === 0) {
    const empty = document.createElement('div'); empty.id = 'empty'; empty.textContent = 'No turn has been recorded in this range.'; groups.append(empty);
  }
  for (const item of picked.groups) {
    const row = document.createElement('div'); row.className = 'group';
    for (const text of [`${item.harness} / ${item.model}`, String(item.tokens), `${item.turns} turn(s)`]) { const cell = document.createElement('span'); cell.textContent = text; row.append(cell); }
    groups.append(row);
  }
  el('status').textContent = `${picked.days.reduce((sum, item) => sum + item.tokens, 0)} tokens since ${picked.from}`;
}

for (const name of ['today', 'd7', 'd30']) el(name).addEventListener('click', () => { range = name; remember(); draw(); });

view.onMessage(message => {
  if (message?.kind !== 'report.data') return;
  data = message;
  observed.reports.push({ generatedAt: message.generatedAt, today: message.today });
  draw();
});

view.onDidInitialize(init => {
  if (init?.state?.range && ['today', 'd7', 'd30'].includes(init.state.range)) range = init.state.range;
  draw();
  view.postMessage({ kind: 'report.request' }).catch(() => {});
});
