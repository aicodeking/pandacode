// Arcade game rules: a snake on a grid. Pure functions over plain data, so a round can be saved as JSON, restored after
// a reload and replayed by a test. No DOM, no timers: the page decides when `step` runs.
export const COLS = 20;
export const ROWS = 20;
export const DIRECTIONS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

/** A small seeded generator (mulberry32), so a level and a fruit sequence can be rebuilt from a number. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The level: a few short wall bars away from the start. The page builds it in a worker; this is also its fallback. */
export function buildLevel(seed, cols = COLS, rows = ROWS) {
  const next = rng(seed);
  const walls = [];
  for (let bar = 0; bar < 4; bar += 1) {
    const x = 3 + Math.floor(next() * (cols - 6));
    const y = 3 + Math.floor(next() * (rows - 8));
    const horizontal = next() < 0.5;
    for (let index = 0; index < 3; index += 1) {
      const cell = horizontal ? [x + index, y] : [x, y + index];
      // The start row stays free so a new round never begins at a wall.
      if (cell[1] !== Math.floor(rows / 2)) walls.push(cell);
    }
  }
  return walls;
}

const key = (x, y) => `${x},${y}`;

function placeFruit(round) {
  const taken = new Set([...round.snake, ...round.walls].map(([x, y]) => key(x, y)));
  const next = rng(round.seed + round.score * 7919 + round.ticks);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const x = Math.floor(next() * COLS), y = Math.floor(next() * ROWS);
    if (!taken.has(key(x, y))) return [x, y];
  }
  for (let y = 0; y < ROWS; y += 1) for (let x = 0; x < COLS; x += 1) if (!taken.has(key(x, y))) return [x, y];
  return null;
}

export function newRound(seed, walls) {
  const y = Math.floor(ROWS / 2);
  const round = { seed, walls, snake: [[4, y], [3, y], [2, y]], dir: [1, 0], queued: null, fruit: [0, 0], score: 0, ticks: 0, over: false };
  round.fruit = placeFruit(round) ?? [0, 0];
  return round;
}

/** Steer: a reversal is ignored, and one turn is queued per step. */
export function turn(round, name) {
  const dir = DIRECTIONS[name];
  if (!dir || round.over) return false;
  const basis = round.queued ?? round.dir;
  if (dir[0] === -basis[0] && dir[1] === -basis[1]) return false;
  if (dir[0] === basis[0] && dir[1] === basis[1]) return false;
  round.queued = dir;
  return true;
}

/** One tick. Returns `ate` when the head took the fruit and `over` when the round ended. */
export function step(round) {
  if (round.over) return { ate: false, over: true };
  if (round.queued) { round.dir = round.queued; round.queued = null; }
  const [hx, hy] = round.snake[0];
  const head = [hx + round.dir[0], hy + round.dir[1]];
  const solid = new Set([...round.snake.slice(0, -1), ...round.walls].map(([x, y]) => key(x, y)));
  round.ticks += 1;
  if (head[0] < 0 || head[1] < 0 || head[0] >= COLS || head[1] >= ROWS || solid.has(key(head[0], head[1]))) {
    round.over = true;
    return { ate: false, over: true };
  }
  round.snake.unshift(head);
  const ate = head[0] === round.fruit[0] && head[1] === round.fruit[1];
  if (ate) {
    round.score += 1;
    const fruit = placeFruit(round);
    if (fruit) round.fruit = fruit; else round.over = true;
  } else {
    round.snake.pop();
  }
  return { ate, over: round.over };
}

/** A saved round is accepted only when it has the shape `step` needs; anything else starts a new round. */
export function revive(saved) {
  const cell = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);
  const ok = saved && typeof saved === 'object' && Number.isInteger(saved.seed) && Array.isArray(saved.snake) && saved.snake.length >= 2
    && saved.snake.length <= COLS * ROWS && saved.snake.every(cell) && Array.isArray(saved.walls) && saved.walls.every(cell)
    && cell(saved.dir) && cell(saved.fruit) && Number.isInteger(saved.score) && Number.isInteger(saved.ticks);
  if (!ok) return null;
  return { seed: saved.seed, walls: saved.walls, snake: saved.snake, dir: saved.dir, queued: null, fruit: saved.fruit, score: saved.score, ticks: saved.ticks, over: saved.over === true };
}
