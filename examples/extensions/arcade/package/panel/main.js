// Arcade panel: a snake on a canvas, in a package with no service. The page owns everything: the board, the keyboard, the
// sound and the saved round. Durable data lives in the page's own storage (its origin belongs to this package) and, for the
// restore path of a reload, in `pandaView.state`; nothing here needs a process, a worker of the host or the network.
// `window.__arcade` and `window.__arcadeDo` are what tests read and drive; the product does not need them.
import { COLS, ROWS, DIRECTIONS, buildLevel, newRound, revive, step, turn } from './game.js';
import { createAudio } from './audio.js';

const view = window.pandaView;
const TICK_MS = 120;
const CELL = 16;
const JOURNAL = 'arcade.journal.v1';
const el = id => document.getElementById(id);
const canvas = el('board');
const context = canvas.getContext('2d');
const base = view.baseUrl ?? document.baseURI;
const audio = createAudio(base);

const observed = window.__arcade = {
  boot: crypto.randomUUID(), frames: 0, ticks: 0, score: 0, best: 0, paused: true, over: false, sound: false, theme: null,
  restored: null, visibility: [], levelFrom: 'pending', spriteLoaded: false, errors: [],
};

let round = null;
let best = 0;
let paused = true;
let reason = 'Press Space or an arrow key to start.';
let theme = { background: '#101418', grid: '#1b232b', head: '#2f9e5f', body: '#53b97f', fruit: '#d9534f', wall: '#7a7f87' };
let lastTick = 0;
let accumulator = 0;
const sprite = new Image();
sprite.addEventListener('load', () => { observed.spriteLoaded = true; });
sprite.src = new URL('sprite.svg', base).href;

// --- storage ----------------------------------------------------------------------------------------------------
// The journal is written synchronously on every change: a write the host makes for `pandaView.state` may not finish when
// the frame closes, but a local-storage write does. On start the newer of the two wins.
const readJournal = () => { try { const value = JSON.parse(localStorage.getItem(JOURNAL) ?? 'null'); return value && typeof value === 'object' ? value : null; } catch { return null; } };
function save() {
  const snapshot = { ts: Date.now(), best, sound: audio.enabled, round: round && !round.over ? round : null };
  try { localStorage.setItem(JOURNAL, JSON.stringify(snapshot)); } catch (error) { observed.errors.push(`journal: ${error?.name ?? 'failed'}`); }
  try { view.state.set(snapshot); } catch (error) { observed.errors.push(`state: ${error?.code ?? error?.name ?? 'failed'}`); }
}

// --- the level, built in a worker ---------------------------------------------------------------------------------
function levelFor(seed) {
  return new Promise(resolve => {
    let done = false;
    const finish = (walls, from) => { if (done) return; done = true; observed.levelFrom = from; resolve(walls); };
    try {
      const worker = new Worker(new URL('level-worker.js', base), { type: 'module' });
      worker.addEventListener('message', event => { finish(event.data.walls, 'worker'); worker.terminate(); });
      worker.addEventListener('error', () => { finish(buildLevel(seed), 'page'); worker.terminate(); });
      worker.postMessage({ seed });
      // A worker that never answers must not leave the game without a board.
      setTimeout(() => { finish(buildLevel(seed), 'page'); worker.terminate(); }, 2000);
    } catch {
      finish(buildLevel(seed), 'page');
    }
  });
}

async function startRound() {
  const seed = (Date.now() % 100000) + 1;
  round = newRound(seed, await levelFor(seed));
  paused = true;
  reason = 'Press Space or an arrow key to start.';
  accumulator = 0;
  sync();
  save();
}

// --- drawing ----------------------------------------------------------------------------------------------------
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  theme = { background: pick('--arcade-bg', theme.background), grid: pick('--arcade-grid', theme.grid), head: pick('--arcade-head', theme.head), body: pick('--arcade-body', theme.body), fruit: pick('--arcade-fruit', theme.fruit), wall: pick('--arcade-wall', theme.wall) };
}
function applyTheme(next) {
  const scheme = next && next.colorScheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = scheme;
  observed.theme = scheme;
  if (next && next.tokens) for (const [name, value] of Object.entries(next.tokens)) if (name.startsWith('--') && typeof value === 'string') document.documentElement.style.setProperty(name, value);
  readTheme();
}

function tile(index, x, y, fallback) {
  if (observed.spriteLoaded && sprite.naturalWidth > 0) context.drawImage(sprite, index * CELL, 0, CELL, CELL, x * CELL, y * CELL, CELL, CELL);
  else { context.fillStyle = fallback; context.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2); }
}
function draw() {
  context.fillStyle = theme.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = theme.grid;
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 1; x < COLS; x += 1) { context.moveTo(x * CELL + 0.5, 0); context.lineTo(x * CELL + 0.5, ROWS * CELL); }
  for (let y = 1; y < ROWS; y += 1) { context.moveTo(0, y * CELL + 0.5); context.lineTo(COLS * CELL, y * CELL + 0.5); }
  context.stroke();
  if (!round) return;
  for (const [x, y] of round.walls) tile(3, x, y, theme.wall);
  tile(2, round.fruit[0], round.fruit[1], theme.fruit);
  round.snake.forEach(([x, y], index) => tile(index === 0 ? 0 : 1, x, y, index === 0 ? theme.head : theme.body));
}

function sync() {
  observed.score = round?.score ?? 0;
  observed.best = best;
  observed.paused = paused;
  observed.over = round?.over ?? false;
  observed.sound = audio.enabled;
  el('score').textContent = String(round?.score ?? 0);
  el('best').textContent = String(best);
  el('state').textContent = round?.over ? 'Game over. Press Space for a new round.' : reason;
  el('state').dataset.paused = String(paused);
  const toggle = el('sound');
  toggle.setAttribute('aria-pressed', String(audio.enabled));
  toggle.textContent = audio.enabled ? 'Sound on' : 'Sound off';
}

// --- the loop -------------------------------------------------------------------------------------------------------
function frame(now) {
  observed.frames += 1;
  if (!lastTick) lastTick = now;
  const elapsed = Math.min(now - lastTick, 500);
  lastTick = now;
  if (round && !paused && !round.over) {
    accumulator += elapsed;
    while (accumulator >= TICK_MS && !round.over) {
      accumulator -= TICK_MS;
      const result = step(round);
      observed.ticks += 1;
      if (result.ate) {
        audio.play('point');
        if (round.score > best) best = round.score;
        el('score').dataset.bump = String(round.score);
      }
      if (result.over) { audio.play('over'); paused = true; accumulator = 0; }
      sync();
      save();
    }
  }
  draw();
  requestAnimationFrame(frame);
}

// --- pausing --------------------------------------------------------------------------------------------------------
function pause(why) {
  if (paused || !round || round.over) return;
  paused = true;
  reason = why;
  sync();
  save();
}
function resume() {
  if (!round) return;
  if (round.over) { void startRound().then(() => { paused = false; reason = ''; sync(); }); return; }
  paused = false;
  reason = '';
  accumulator = 0;
  lastTick = 0;
  sync();
}

view.onDidChangeVisibility(state => {
  observed.visibility.push({ visible: state.visible, focused: state.focused, at: Date.now() });
  if (!state.visible) pause('Paused: the panel is hidden. Press Space to resume.');
  else if (!state.focused) pause('Paused: the panel lost focus. Press Space to resume.');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('Paused: the window is hidden. Press Space to resume.'); });
window.addEventListener('blur', () => pause('Paused: the window lost focus. Press Space to resume.'));
// A page that is about to close writes its round synchronously; the host's own write may come too late.
window.addEventListener('pagehide', save);

// --- keyboard ---------------------------------------------------------------------------------------------------------
const typing = target => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
document.addEventListener('keydown', event => {
  // Input-method composition (WebKit sends the committing Enter with key code 229) and text fields are never the game's.
  if (event.isComposing || event.keyCode === 229 || typing(event.target)) return;
  audio.unlock();
  if (event.key === 'Escape') { event.preventDefault(); view.releaseFocus(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key in DIRECTIONS) {
    event.preventDefault();
    if (!round) return;
    if (paused && !round.over) resume();
    if (turn(round, event.key)) save();
    return;
  }
  if (event.key === ' ') { event.preventDefault(); if (paused || round?.over) resume(); else pause('Paused. Press Space to resume.'); }
});
document.addEventListener('pointerdown', () => audio.unlock());
canvas.addEventListener('pointerdown', () => canvas.focus());

el('sound').addEventListener('click', () => { audio.unlock(); audio.enabled = !audio.enabled; if (audio.enabled) audio.play('point'); sync(); save(); });
el('restart').addEventListener('click', () => { void startRound().then(resume); });

// --- start ----------------------------------------------------------------------------------------------------------
view.onDidChangeTheme(applyTheme);
view.onDidInitialize(async init => {
  applyTheme(init.theme);
  const journal = readJournal();
  const kept = init.state && typeof init.state === 'object' ? init.state : null;
  const newest = journal && (!kept || (journal.ts ?? 0) >= (kept.ts ?? 0)) ? journal : kept;
  best = Math.max(Number(journal?.best) || 0, Number(kept?.best) || 0);
  audio.enabled = newest?.sound === true;
  const saved = revive(newest?.round);
  observed.restored = { restored: init.restored === true, round: !!saved, from: newest === journal ? 'journal' : 'state' };
  if (saved) { round = saved; reason = 'Round restored. Press Space to continue.'; sync(); }
  else await startRound();
  sync();
});
requestAnimationFrame(frame);

window.__arcadeDo = {
  press: key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  round: () => (round ? JSON.parse(JSON.stringify(round)) : null),
  resources: () => performance.getEntriesByType('resource').map(entry => entry.name),
  // The two calls a panel without a service cannot make: each rejects with UnsupportedCapability.
  probe: async () => {
    const code = async run => { try { await run(); return 'ok'; } catch (error) { return error?.code ?? String(error); } };
    return { post: await code(() => view.postMessage({ kind: 'hello' })), directory: await code(() => view.panda.storage.directory({ scope: 'global' })) };
  },
  // Containment: a page that throws, and a page that loops. The host fails or ends that panel only.
  fail: () => { setTimeout(() => { throw new Error('The arcade failed on purpose.'); }, 0); },
  hang: ms => { const until = Date.now() + (ms ?? 60000); while (Date.now() < until) { /* loops on purpose */ } },
};
