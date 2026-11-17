// Machine monitor: the rich panel of sample.monitor. It draws the service's readings and asks for nothing else: it never reads
// the daemon. The service sends `fleet.begin` (the machines, the thresholds, the stale marking), one `fleet.history` per
// machine, then at most one `fleet.samples` a second. A new `fleet.begin` replaces the old picture once its histories arrive;
// until then the previous one stays on screen. `window.__monitor` and `window.__monitorDo` are what the qualification reads and
// drives; the product does not need them.
import { WINDOW_MS, series, stats, draw } from './chart.js';

const view = window.pandaView;
const el = id => document.getElementById(id);
const observed = window.__monitor = {
  boot: Math.random().toString(36).slice(2), init: null, visibility: [], begins: [], samples: 0, renders: 0, charts: [], asked: 0, stale: false, lastSeq: null,
};
const machines = new Map();   // id -> { info, points: [[t, cpu, mem]] }
let selected = null;
let building = null;          // { seq, ids:Set, waiting:Set }
let meta = { status: '', stale: false, since: null, intervalMs: null };

const remember = () => { try { view.state.set({ selected }); } catch { /* the bound is 256 KiB; one id never reaches it */ } };
const send = async message => { try { await view.postMessage(message); } catch (error) { el('summary').textContent = `${error?.code ?? 'Failed'}: ${error?.message ?? ''}`; } };
const pct = value => `${Math.round(Number(value))}%`;
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

function trim(entry) {
  const end = entry.points.length ? entry.points[entry.points.length - 1][0] : 0;
  while (entry.points.length && entry.points[0][0] < end - WINDOW_MS) entry.points.shift();
}

function drawCard(card, entry) {
  const canvas = card.querySelector('canvas');
  const plotted = draw(canvas, series(entry.points, 1), { line: 1 });
  card.dataset.points = String(plotted.length);
}

function drawDetail() {
  const entry = selected ? machines.get(selected) : null;
  el('detail-title').textContent = entry ? entry.info.name : 'Select a machine';
  el('detail-seen').textContent = entry ? (entry.info.online && !meta.stale ? `${entry.info.level}: CPU ${pct(entry.info.cpu)}, memory ${pct(entry.info.mem)}` : `${entry.info.level}: last seen ${entry.info.lastSeen ? clock(entry.info.lastSeen) : 'never'}; CPU ${pct(entry.info.cpu)}, memory ${pct(entry.info.mem)}`) : '';
  for (const [field, name] of [[1, 'cpu'], [2, 'mem']]) {
    const values = entry ? series(entry.points, field) : [];
    const result = stats(values);
    el(`${name}-stats`).textContent = result.count ? `average ${pct(result.avg)}, peak ${pct(result.peak)}` : '';
    const plotted = draw(el(`${name}-chart`), values, { grid: true });
    observed.charts.push({ machine: selected, field: name, given: values.map(item => [item.t, item.v]), plotted: plotted.length, avg: result.avg, peak: result.peak });
    if (observed.charts.length > 50) observed.charts.shift();
  }
}

function drawAll() {
  observed.renders += 1;
  const cards = el('cards');
  const keep = new Map([...cards.children].map(card => [card.dataset.id, card]));
  const order = [];
  for (const [id, entry] of machines) {
    let card = keep.get(id);
    if (!card) {
      card = document.createElement('button');
      card.type = 'button'; card.className = 'card'; card.role = 'option'; card.dataset.id = id;
      for (const name of ['name', 'level', 'readings']) { const span = document.createElement('span'); span.className = name; card.append(span); }
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 32; card.append(canvas);
      card.addEventListener('click', () => select(id));
    }
    card.dataset.level = entry.info.level;
    card.setAttribute('aria-selected', String(id === selected));
    card.querySelector('.name').textContent = entry.info.name;
    card.querySelector('.level').textContent = entry.info.online && !meta.stale ? entry.info.level : (entry.info.online ? `${entry.info.level} (stale)` : `offline, last seen ${entry.info.lastSeen ? clock(entry.info.lastSeen) : 'never'}`);
    card.querySelector('.readings').textContent = `CPU ${pct(entry.info.cpu)}  Memory ${pct(entry.info.mem)}`;
    drawCard(card, entry);
    order.push(card);
  }
  cards.replaceChildren(...order);
  el('summary').textContent = meta.status || (machines.size ? `${machines.size} machines` : 'Waiting for the machines');
  const banner = el('banner');
  banner.dataset.shown = String(!!meta.stale);
  banner.textContent = meta.stale ? `Stale: the metrics daemon is offline (stale since ${meta.since ?? 'unknown'}). These are the last readings.` : '';
  observed.stale = !!meta.stale;
  drawDetail();
}

function select(id) {
  selected = id;
  remember();
  drawAll();
}

function infoOf(item) { return { id: item.id, name: item.name, level: item.level, online: item.online, cpu: item.cpu, mem: item.mem, lastSeen: item.lastSeen }; }

function applyMachines(list) {
  for (const item of list) {
    const entry = machines.get(item.id);
    if (entry) entry.info = infoOf(item); else machines.set(item.id, { info: infoOf(item), points: [] });
  }
}

function onBegin(message) {
  building = { seq: message.seq, ids: new Set(message.machines.map(item => item.id)), waiting: new Set(message.machines.map(item => item.id)) };
  observed.lastSeq = message.seq;
  observed.begins.push({ seq: message.seq, machines: message.machines.length, stale: !!message.stale, at: Date.now() });
  meta = { status: message.status, stale: !!message.stale, since: message.since, intervalMs: message.intervalMs };
  for (const id of [...machines.keys()]) if (!building.ids.has(id)) machines.delete(id);
  applyMachines(message.machines);
  if (selected && !machines.has(selected)) selected = null;
  if (building.waiting.size === 0) building = null;
  drawAll();
}

function onHistory(message) {
  // A chunk of an older snapshot that a newer begin has replaced is dropped.
  if (!building || message.seq !== building.seq) return;
  const entry = machines.get(message.machine);
  if (!entry) return;
  entry.points = message.points.map(point => [point[0], point[1], point[2]]);
  building.waiting.delete(message.machine);
  if (building.waiting.size === 0) building = null;
  drawAll();
}

function onSamples(message) {
  observed.samples += message.samples.length;
  meta = { ...meta, status: message.status ?? meta.status, stale: !!message.stale, since: message.since ?? null };
  applyMachines(message.machines);
  for (const sample of message.samples) {
    const entry = machines.get(sample.machine);
    if (!entry) continue;
    const last = entry.points.length ? entry.points[entry.points.length - 1][0] : -Infinity;
    if (sample.t > last) { entry.points.push([sample.t, sample.cpu, sample.mem]); trim(entry); }
  }
  drawAll();
}

view.onDidInitialize(init => {
  observed.init = { viewId: view.viewId, instanceId: init.instanceId ?? null, placement: init.placement ?? null, restored: init.restored ?? null, state: init.state ?? null, at: Date.now() };
  if (typeof init.state?.selected === 'string') selected = init.state.selected;
});
view.onDidChangeVisibility(state => { observed.visibility.push({ visible: state.visible, focused: state.focused, at: Date.now() }); });
view.onMessage(message => {
  switch (message?.kind) {
    case 'fleet.begin': onBegin(message); break;
    case 'fleet.history': onHistory(message); break;
    case 'fleet.samples': onSamples(message); break;
    default: break;
  }
});

el('reload').addEventListener('click', () => { observed.asked += 1; void send({ kind: 'snapshot' }); });

window.__monitorDo = {
  select: id => select(id),
  snapshot: () => { observed.asked += 1; return send({ kind: 'snapshot' }); },
  cards: () => [...el('cards').children].map(card => ({ id: card.dataset.id, level: card.dataset.level, points: Number(card.dataset.points) })),
  selected: () => selected,
  points: id => (machines.get(id)?.points ?? []).map(point => [...point]),
};
