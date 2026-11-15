import './sky-window.css';
import { DARK_CEILING, lightFloor, minutesOf, moonPosition, skyColorsAt, sunPosition, type Rgb } from './sky-math';
import { SCENES, sceneById, sceneFor, type Scene } from './scenes';
import { PRELUDE, UNIFORMS, VERTEX } from './scenes/types';

/** The thread's window: a procedural scene (src/scenes/: the sky, the aurora, …; WebGL fragment shader, CSS gradient
 * fallback) behind the conversation, picked per thread by `setThread` and crossfaded (~300 ms) on a switch.
 * Wind follows the open thread's run (`#transcript[data-running]`), the pointer parts the clouds, and it renders
 * only while visible: about 8 fps at rest (on a timer, not rAF), 30 while only the wind moves, 60 while the pointer does,
 * and, once the wind has arrived, 4 fps for a steady run (2 on a tile, 15 for a fast scene, 6 on a fast tile). A transcript
 * that is still growing stays at 8 fps, and the pointer's 60 fps burst is held back for the whole run. After eight quiet
 * seconds, and after a ten-second pause, the last frame is copied onto a 2D canvas and the WebGL context is released. It
 * also stands still while the reader moves a transcript or types in a composer — the pane's or any tile's — and for
 * HOLD_MS after the last such input: the canvas is the backdrop of the whole transcript, so every frame it paints makes
 * the compositor redo the region above it. The scene's glass is a plain fill on the surfaces that scroll with the text and
 * on the composer's (and a tile's) glass, where a blur would re-blur its backdrop on every canvas frame and every scroll
 * step; the floating ones keep theirs, at two real densities: the action dock, its label tip, the agents flyout and the
 * progress pills blur over a dense 90% `--dock-fill` (action-dock.css, dense enough that the blur only adds depth and
 * chosen so they read over the sky and a wallpaper). The agents popover and the tip bubbles are the wider glass instead —
 * `--glass-warm` to `--glass-tint`, .58–.72 — where the blur rather than the fill separates them from the canvas
 * (pre-existing). Reader intent is read off the events (a wheel, a touch, a press, a key), never off the scroll position,
 * so the app's own scrolling never holds a frame.
 * The hold only defers the loop, it never stops it, and the resumed frame spans the wait with `dt` clamped at .1 s
 * (`tick`): a hold shorter than that is taken up, a longer one is dropped rather than jumped, so the clock never rewinds.
 * That spanned `dt` is integrated in substeps of at most 1/60 s (`step`), so the springs advance by the elapsed time
 * without ever overshooting. The wind is caught up over the whole span — that is what makes it look continuous — while the
 * pointer is seeded from the resumed instant and steps at most one frame's worth, so a freeze resumes the parting where it
 * stopped instead of handing it the whole wait in one 16 ms frame.
 * A governor drops the render scale from 0.6 to 0.45 of device pixels when a paint averages over ~8 ms. */
export interface SkyOptions {
  /** Whether the sky should show at all (wallpapers off, no accessibility override). */
  wanted(): boolean;
  /** Fixed clock for previews and specs (`?sky=06:30`). */
  fixedMinutes?: number | null;
  /** A tile's own scene (thread-tiles.ts): pointer moves come from this ancestor, since the real pane may lie over the
   * tile, and it leaves the idle precompile to the main instance. */
  tileRoot?: HTMLElement;
  /** Preview only: `window.__sky.frames` counts painted frames for specs, and `ptrAmt`/`ptrVel`/`ptrTarget` are the parting
   * spring's own state (read-only), so a spec can hold it to its 0..1 contract on every frame across a resumed one. */
  expose?: boolean;
  /** Preview only (`?scene=aurora`): every thread shows this scene. */
  pinnedScene?: string | null;
}
export interface SkyController {
  refresh(): void;
  /** The open thread (null: none, which shows the sky). A change crossfades to that thread's scene. */
  setThread(id: string | null): void;
  dispose(): void;
}
const FADE_MS = 300;

const css = (c: Rgb): string => `rgb(${c.map(v => Math.round(v * 255)).join(' ')})`;
const IDLE_FPS = 8, WIND_FPS = 30, RUN_FPS = 4, TILE_FPS = 2, FAST_FPS = 15, FAST_TILE_FPS = 6;
/** Quiet this long with nothing moving, and the sky snapshots itself and releases WebGL. A covered sky waits this long
 * before the same park, so a brief settings glance keeps the live context. */
const SETTLE_MS = 8000, PAUSE_PARK_MS = 10_000, CLOCK_MS = 3 * 60_000;
/** Reader input holds frames this long past the last piece of it (a wheel, a touch drag, a press or a key on a
 * transcript, a keystroke or text input in a composer): long enough to span the gap between two wheel notches or two
 * keystrokes, short enough to read as an instant resume, and re-armed by the next one. */
const HOLD_MS = 150;
/** How long past its last growth a streaming run still counts as churning the transcript (`churning`): long enough to span
 * the gap between two streamed chunks, short enough that the cap lifts between two turns. It costs no timer of its own —
 * every paint samples the height and compares it — so it releases on the first paint after this window, at most one idle
 * interval (125 ms) later. */
const GROWTH_MS = 150;
/** The physics substep: a frame's `dt` is integrated in equal steps of at most this, so a resumed frame (`.1` s, six of
 * them at most) can never hand an explicit-Euler spring a step it cannot take — the parting spring's rising branch
 * (k = 280, c = 33) is only stable to about 2/c ≈ 60 ms. */
const FIXED_DT = 1 / 60;
/** Render scale (of device pixels) and the governor's budget: paint time averaged over SAMPLE frames above BUDGET_MS drops
 * to LOW_SCALE; it goes back up only after QUIET_MS of averages under half the budget. */
const SCALE = .6, LOW_SCALE = .45, BUDGET_MS = 8, SAMPLE = 30, QUIET_MS = 60_000;
/** `__sky.gpuMs` (preview) is the mean of this many GPU timer results. */
const GPU_SAMPLE = 10;
/** The precompile waits this long after the last input, and polls a parallel compile this often. */
const INPUT_QUIET_MS = 1000, COMPILE_POLL_MS = 100;
/** Pointer influence stops over the thread's readable surfaces: the clouds answer only where the sky shows. */
const READABLE = '.message,.turn-activity,.message-error,.empty-conversation,.turn-changes-row,.thinking-block,#composer-area,.new-task-welcome,.workspace-header,#action-dock,.file-tabs';
/** The reader's input surfaces (`readerMoves`, `readerTypes`): what scrolls a thread, and what takes typing in one. Each
 * has two spellings — the real one and a tile's read-only replica (`docs/agent-reference.md`: a rule that targets
 * `#transcript` needs `:is(#transcript,.thread-mirror-rows)`) — and a tile's `pane` holds neither the focused thread's
 * `#transcript`/`#composer-area` nor another tile's rows, so the listeners that use these are on `document`. The By the
 * way panel's own log and composer (`.btw-transcript`, `.btw-input`) are the reader's too, though they live in the
 * inspector: that is its own opaque panel (`--panel-surface`) over the main pane, so no sky shows behind it, and its
 * scrolls hold the pane's sky all the same. */
const SCROLLERS = '#transcript,.thread-mirror-rows,.btw-transcript';
const TYPING = '#transcript,.thread-mirror-rows,#composer-area,.thread-mirror-composer,.btw-transcript,.btw-input';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const lessTransparency = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
type TimerExt = { TIME_ELAPSED_EXT: number; QUERY_RESULT_EXT: number; QUERY_RESULT_AVAILABLE_EXT: number; GPU_DISJOINT_EXT: number;
  createQueryEXT(): WebGLQuery | null; beginQueryEXT(target: number, query: WebGLQuery): void; endQueryEXT(target: number): void;
  getQueryObjectEXT(query: WebGLQuery, name: number): number | boolean; deleteQueryEXT(query: WebGLQuery): void };
type Context = { gl: WebGLRenderingContext; timer: TimerExt | null; parallel: boolean; programs: Map<string, Program | null>; pending: Map<string, Pending> };
type Program = { program: WebGLProgram; locations: Record<string, WebGLUniformLocation | null> };
type Pending = { program: WebGLProgram; shaders: WebGLShader[] };
/** KHR_parallel_shader_compile's query: true once the driver has finished, so asking for the status never blocks. */
const COMPLETION_STATUS = 0x91B1;

function context(canvas: HTMLCanvasElement): Context | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return { gl, timer: gl.getExtension('EXT_disjoint_timer_query') as TimerExt | null, parallel: !!gl.getExtension('KHR_parallel_shader_compile'),
    programs: new Map(), pending: new Map() };
}
/** Hands a scene's shaders to the driver without waiting for them (the precompile's first half). */
function startProgram(ctx: Context, scene: Scene): void {
  if (ctx.programs.has(scene.id) || ctx.pending.has(scene.id)) return;
  const { gl } = ctx, program = gl.createProgram(), shaders: WebGLShader[] = [];
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, PRELUDE + scene.fragment]] as const) {
    const s = gl.createShader(type);
    if (!s || !program) { ctx.programs.set(scene.id, null); return; }
    gl.shaderSource(s, source); gl.compileShader(s); gl.attachShader(program, s); shaders.push(s);
  }
  gl.bindAttribLocation(program!, 0, 'p'); gl.linkProgram(program!);
  ctx.pending.set(scene.id, { program: program!, shaders });
}
/** A scene's program, compiled on first use (or ahead, on idle) and cached (null when it fails to compile: the CSS
 * fallback shows). With `wait` false it returns undefined while the driver is still compiling in parallel. */
function programFor(ctx: Context, scene: Scene, wait = true): Program | null | undefined {
  const cached = ctx.programs.get(scene.id);
  if (cached !== undefined) return cached;
  startProgram(ctx, scene);
  const pending = ctx.pending.get(scene.id);
  if (!pending) return ctx.programs.get(scene.id);
  const { gl } = ctx;
  if (!wait && ctx.parallel && !gl.getProgramParameter(pending.program, COMPLETION_STATUS)) return undefined;
  ctx.pending.delete(scene.id);
  let result: Program | null = null;
  if (gl.getProgramParameter(pending.program, gl.LINK_STATUS))
    result = { program: pending.program, locations: Object.fromEntries(UNIFORMS.map(name => [name, gl.getUniformLocation(pending.program, name)])) };
  else for (const s of pending.shaders) if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(`Scene ${scene.id}:`, gl.getShaderInfoLog(s));
  for (const s of pending.shaders) { gl.detachShader(pending.program, s); gl.deleteShader(s); }
  if (!result) gl.deleteProgram(pending.program);
  ctx.programs.set(scene.id, result);
  return result;
}

export function mountSky(pane: HTMLElement, workspace: HTMLElement, options: SkyOptions): SkyController {
  const layer = document.createElement('div');
  layer.className = 'thread-sky';
  layer.setAttribute('aria-hidden', 'true');
  let canvas = document.createElement('canvas');
  // Settled, static and long-paused skies copy the last WebGL frame here so the WebGL context can be released at rest.
  const stillCanvas = document.createElement('canvas');
  stillCanvas.className = 'thread-sky-still';
  stillCanvas.hidden = true; stillCanvas.width = 0; stillCanvas.height = 0;
  // The outgoing scene's last frame, copied here on a thread switch and faded out over the new one (opacity only).
  const fade = document.createElement('canvas');
  fade.className = 'thread-sky-fade';
  fade.hidden = true; fade.width = 0; fade.height = 0;
  layer.append(canvas, stillCanvas, fade);
  pane.prepend(layer);
  const pointerRoot = options.tileRoot ?? pane;
  const transcript = (): HTMLElement | null => pane.querySelector('#transcript');
  // One WebGL context; each scene's program compiles on first use (`programFor`).
  let ctx: Context | null | undefined, bound: Program | null = null, fades = 0;
  let scene: Scene = sceneById(options.pinnedScene) ?? sceneFor(null), hadThread = false, fading: Animation | null = null;
  let frame = 0, timer = 0, pauseParkTimer = 0, stillKey = '', stillShape = '', settled = false, woken = false, last = 0, frames = 0, disposed = false, shown = false, visible = true, focused = true;
  // Size from the ResizeObserver, so a paint never reads layout.
  let paneWidth = 0, paneHeight = 0;
  // The governor: recent paint times (GPU timer query where the driver has one, else the rAF interval past a 60 Hz frame).
  let scale = SCALE, costs: number[] = [], droppedAt = 0, query: WebGLQuery | null = null, timing: 'gpu' | 'frame' = 'frame';
  // Preview only (`__sky.forcePaintMs`, `__sky.quietMs`): specs drive the governor with made-up paint times.
  let forcePaintMs: number | null = null, quietMs = QUIET_MS, gpuMs: number | null = null, gpuCosts: number[] = [];
  // The precompile (`precompile`): the idle callback or poll timer it is waiting on, and the last user input.
  let idle = 0, idleTimer = 0, inputAt = 0, activityAt = performance.now();
  // The reader-input hold (`hold`): no frame is painted before this time, and `resumeIn` marks the frame that ends it
  // (armed by `armResume`, cleared by the frame it fires).
  let holdUntil = 0, resumeIn = false;
  // A growing transcript (`churning`): the content height last sampled from its scroller, and when it last moved (a long
  // time ago, so a page that has not grown yet never reads as growing).
  let seenHeight = -1, grewAt = -1e9;
  // Wind and pointer are critically damped springs; drift is integrated so a speed change never jumps the clouds.
  let wind = 0, windVelocity = 0, drift = 0, time = 0;
  const pointer = { x: .5, y: .5, tx: .5, ty: .5, sx: 0, sy: 0, amt: 0, amtVelocity: 0, target: 0, vx: 0, vy: 0, movedAt: 0 };

  let shownGradient = '';
  const setData = (key: string, value: string): void => { if (layer.dataset[key] !== value) layer.dataset[key] = value; };
  const running = (): boolean => transcript()?.hasAttribute('data-running') ?? pane.hasAttribute('data-running');
  const covered = (): boolean => workspace.matches('.settings-open,.board-view,.github-view') || pane.querySelector('.conversation-pane')?.hasAttribute('inert') === true;
  const active = (): boolean => shown && visible && !document.hidden && focused && !covered();
  const minutes = (): number => options.fixedMinutes ?? minutesOf(new Date());
  const currentStillShape = (): string => `${scene.id}:${document.documentElement.dataset.theme ?? ''}:${Math.round(paneWidth)}x${Math.round(paneHeight)}`;
  const currentStillKey = (): string => `${scene.id}:${options.fixedMinutes ?? Math.floor(minutes() / (CLOCK_MS / 60_000))}:${document.documentElement.dataset.theme ?? ''}:${Math.round(paneWidth)}x${Math.round(paneHeight)}`;

  function paint(): void {
    const m = minutes(), colors = skyColorsAt(m), sun = sunPosition(m), moon = moonPosition(m);
    // Style writes only on change: each one would cost a style recalc on every frame.
    const [top, mid, bottom] = scene.fallback(colors).map(css);
    const gradient = [top, mid, bottom].join();
    if (gradient !== shownGradient) {
      shownGradient = gradient;
      layer.style.setProperty('--sky-top', top);
      layer.style.setProperty('--sky-mid', mid);
      layer.style.setProperty('--sky-horizon', bottom);
    }
    setData('night', String(colors.night > .5));
    setData('threadScene', scene.id);
    if (shown && ctx === undefined) ctx = context(canvas);
    const program = ctx ? programFor(ctx, scene) ?? null : null;
    if (!ctx || !program) { clearStill(); layer.removeAttribute('data-gl'); return; }
    const { gl } = ctx, u = program.locations;
    if (bound !== program) { gl.useProgram(program.program); bound = program; }
    // 0.6 of the device pixels (0.45 when the governor drops it; at least 0.75 per CSS pixel), so the near clouds stay crisp.
    const ratio = Math.max(.75, Math.min(devicePixelRatio || 1, 2) * scale);
    const width = Math.max(1, Math.round(paneWidth * ratio)), height = Math.max(1, Math.round(paneHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(u.res, width, height);
    gl.uniform1f(u.aspect, width / height);
    gl.uniform1f(u.drift, drift); gl.uniform1f(u.time, time); gl.uniform1f(u.wind, wind);
    gl.uniform1f(u.night, colors.night); gl.uniform1f(u.floorY, lightFloor(colors.night)); gl.uniform1f(u.ceilY, DARK_CEILING);
    gl.uniform1f(u.dark, document.documentElement.dataset.theme === 'dark' ? 1 : 0);
    for (const key of ['top', 'mid', 'glow', 'shade'] as const) gl.uniform3fv(u[key], colors[key]);
    gl.uniform3fv(u.hor, colors.horizon); gl.uniform3fv(u.lit, colors.light);
    gl.uniform3f(u.sun, sun.x, sun.y, sun.visible ? Math.min(1, Math.max(0, sun.elevation * 6 + .15)) : 0);
    gl.uniform3f(u.moon, moon.x, moon.y, moon.visible ? Math.min(1, Math.max(0, moon.elevation * 3)) * colors.night : 0);
    gl.uniform2f(u.ptr, pointer.x, pointer.y); gl.uniform2f(u.ptrVel, pointer.vx, pointer.vy);
    gl.uniform1f(u.ptrAmt, pointer.amt);
    const ext = ctx.timer;
    if (ext) readQuery(ext);
    const measure = ext && !query ? ext.createQueryEXT() : null;
    if (ext && measure) ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, measure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (ext && measure) { ext.endQueryEXT(ext.TIME_ELAPSED_EXT); query = measure; }
    frames++;
    if (!layer.hasAttribute('data-gl')) { layer.setAttribute('data-gl', ''); precompile(); }
  }
  /** After the first paint, compiles the scenes not yet used, one per idle slot and never within a second of input or
   * while the pointer stirs the scene, so a first visit to a scene draws without a compile stall. With
   * KHR_parallel_shader_compile the driver compiles in the background and a later slot only collects the result. */
  function precompile(): void {
    if (options.tileRoot || idle || idleTimer || disposed || !ctx || typeof requestIdleCallback !== 'function') return;
    idle = requestIdleCallback(deadline => {
      idle = 0;
      const c = ctx;
      if (!c || disposed) return;
      const later = (ms: number): void => { idleTimer = window.setTimeout(() => { idleTimer = 0; precompile(); }, ms); };
      if (performance.now() - inputAt < INPUT_QUIET_MS || stirring || deadline.timeRemaining() < 8) { later(INPUT_QUIET_MS / 2); return; }
      for (const id of [...c.pending.keys()]) programFor(c, sceneById(id)!, false);
      if (c.pending.size) { later(COMPILE_POLL_MS); return; }
      const next = SCENES.find(candidate => !c.programs.has(candidate.id));
      if (!next) return;
      if (c.parallel) startProgram(c, next); else programFor(c, next);
      later(c.parallel ? COMPILE_POLL_MS : 0);
    });
  }
  function input(): void { inputAt = performance.now(); }
  /** The reader is moving the transcript or typing: keep frames off (and the precompile quiet) for HOLD_MS after each such
   * event. Additive to the schedule — it never stops the loop, it only makes the next tick wait, and it always releases: the
   * armed wake fires at `holdUntil` at the latest, so nothing can extend the hold but another reader event. */
  function hold(): void {
    const now = performance.now();
    inputAt = now;
    holdUntil = Math.max(holdUntil, now + HOLD_MS);
    // Reduced motion paints one still frame off its own interval, and nothing is queued here to defer.
    if (disposed || reducedMotion.matches) return;
    // Nothing is scheduled at all (the last frame was the idle one): arm the wake that ends the hold.
    if (!frame && !timer && active()) armResume();
  }
  /** Arms the wake that ends a reader hold, and marks the frame it fires as the resumed one: `resumeIn` is what tells
   * `step` that this frame's `dt` spans the wait, so its pointer step is the one that has to be clamped. Every path that
   * arms a wake for the end of a hold goes through here — the hold's own early return below, the idle arm above and
   * `wake`'s — and that frame is the one that clears it. */
  function armResume(): void {
    resumeIn = true;
    if (!timer) timer = window.setTimeout(() => tick(performance.now()), Math.max(1, holdUntil - performance.now()));
  }
  function holding(): boolean { return performance.now() < holdUntil; }
  /** The scroller whose content a run grows: the open thread's transcript, or a tile's read-only rows (a tile's `pane`
   * holds neither: `docs/agent-reference.md`'s `:is(#transcript,.thread-mirror-rows)`). */
  const scroller = (): HTMLElement | null => transcript() ?? pane.querySelector('.thread-mirror-rows');
  /** Records the scroller's content height, once per painted frame (`tick`) and nowhere else: `scrollHeight` is the whole
   * cost of the growth signal — one integer read per paint, which forces a style/layout flush only when the DOM is dirty,
   * and a frame that is painting a streaming thread has just made it dirty, so the flush it moves forward would have
   * happened in that same frame anyway (paint() reads no layout, so this is the instance's only read). It is 8 reads a
   * second under the cap it arms, at most 30 while only the wind moves and 60 while the pointer burst runs, and none at
   * all while nothing paints. A `ResizeObserver` would not
   * do: the transcript is a fixed-height scroller, so a growing thread does not resize its box. */
  function sampleGrowth(now: number): void {
    const height = scroller()?.scrollHeight ?? -1;
    if (height === seenHeight) return;
    if (seenHeight >= 0) grewAt = now;
    seenHeight = height;
  }
  /** Whether a run is churning the transcript: it is streaming (`#transcript[data-running]`, or a tile's), or the content
   * height sampled above moved within GROWTH_MS. Costs one attribute read, never a layout: `grewAt` is written by
   * `sampleGrowth` alone. */
  const churning = (now: number): boolean => running() || now - grewAt < GROWTH_MS;
  /** The last GPU timer query, once its result is in (a disjoint result is dropped). */
  function readQuery(ext: TimerExt): void {
    if (!query || !ctx || !ext.getQueryObjectEXT(query, ext.QUERY_RESULT_AVAILABLE_EXT)) return;
    const disjoint = ctx.gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    if (!disjoint && forcePaintMs === null) {
      const ms = Number(ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT)) / 1e6;
      timing = 'gpu'; sample(ms);
      gpuCosts.push(ms);
      if (gpuCosts.length >= GPU_SAMPLE) { gpuMs = gpuCosts.reduce((sum, value) => sum + value, 0) / gpuCosts.length; gpuCosts = []; }
    }
    ext.deleteQueryEXT(query); query = null;
  }
  /** One paint-time sample: over budget on average drops the scale; a long quiet stretch restores it. */
  function sample(ms: number): void {
    costs.push(ms);
    if (costs.length < SAMPLE) return;
    const mean = costs.reduce((sum, value) => sum + value, 0) / costs.length;
    costs = [];
    const now = performance.now();
    if (scale === SCALE && mean > BUDGET_MS) { scale = LOW_SCALE; droppedAt = now; }
    else if (scale === LOW_SCALE && mean < BUDGET_MS / 2 && now - droppedAt > quietMs) scale = SCALE;
    else if (scale === LOW_SCALE && mean >= BUDGET_MS / 2) droppedAt = now;
  }
  /** Spring steps for one frame; `resumed` marks the frame that ends a reader hold (see `resumeIn`), the one whose `dt`
   * spans the wait. Returns whether anything is still moving fast enough to need full frame rate. */
  function step(dt: number, resumed: boolean): boolean {
    const spring = (value: number, velocity: number, target: number, response: number, h: number): [number, number] => {
      const k = (2 * Math.PI / response) ** 2, c = 2 * Math.sqrt(k);
      const v = velocity + (k * (target - value) - c * velocity) * h;
      return [value + v * h, v];
    };
    // Fixed-step integration. `dt` spans whatever the loop missed — up to .1 s across a reader hold, or a slow
    // cadence frame up to .5 s — and that is past what explicit Euler can take on the parting spring's rising branch
    // (k = 280, c = 33: stable to about 2/c ≈ 60 ms; at .1 s a single step from rest drives `pointer.amt` to ~2.8
    // where the scene contract is 0..1, and from mid-ramp it inverts the velocity). So the frame is split into equal
    // substeps of at most 1/60 s, which advances the scene by exactly `dt` (each substep is `dt / substeps`, so no
    // time is lost and none is counted twice). Everything that is per frame rather than per step (the `data-wind`
    // write, `drift`/`time`, the settling reset, `stirring`) stays below the loop and runs once.
    const substeps = Math.max(1, Math.ceil(dt / FIXED_DT - 1e-9));
    const h = dt / substeps;
    // Read once per frame, like the flags below: neither can change inside the substeps.
    const windTarget = running() ? 1 : 0;
    if (performance.now() - pointer.movedAt > 350) pointer.target = 0;
    let settling = false;
    for (let i = 0; i < substeps; i++) {
      [wind, windVelocity] = spring(wind, windVelocity, windTarget, 1, h);
      if (Math.abs(wind - Math.round(wind)) < .002 && Math.abs(windVelocity) < .002) { wind = Math.round(wind); windVelocity = 0; }
    }
    // The pointer, in its own substeps. On every ordinary frame that is `h` each, so it advances by exactly the elapsed
    // time at whatever rate the loop is on — a 33 ms wind frame, a 125 ms churn frame or a 60 fps rAF one — and its
    // settle back keeps the documented ~0.5 s, with the 350 ms target release landing when it should. The exception is the
    // frame that ends a reader hold (`resumed`): it is the only frame whose `dt` spans a wait, and stepping the parting
    // over that .1 s would hand it .58 of the full parting in a single 16 ms paint, which reads as the clouds snapping. So
    // that one steps once, by one frame's worth at most (`ph`), and the parting resumes where it stopped — while the wind,
    // which has to look continuous, is what catches up, over every substep above.
    const pSteps = resumed ? 1 : substeps, ph = resumed ? Math.min(dt, FIXED_DT) : h;
    for (let i = 0; i < pSteps; i++) {
      // Nearly critically damped, so the clouds settle back softly and quickly (~0.5 s).
      // It answers within ~150 ms as the pointer arrives; the settle back stays as soft as before.
      const rising = pointer.target > pointer.amt, k = rising ? 280 : 90, c = rising ? 33 : 16;
      pointer.amtVelocity += (k * (pointer.target - pointer.amt) - c * pointer.amtVelocity) * ph;
      pointer.amt = Math.max(0, pointer.amt + pointer.amtVelocity * ph);
      // The parting follows the cursor on its own soft spring (damping 0.7), so the clouds trail it and settle with a
      // little overshoot; its velocity (clamped) drags a billow along the motion.
      const pk = 70, pc = 2 * .7 * Math.sqrt(pk);
      pointer.sx += (pk * (pointer.tx - pointer.x) - pc * pointer.sx) * ph; pointer.sy += (pk * (pointer.ty - pointer.y) - pc * pointer.sy) * ph;
      pointer.x += pointer.sx * ph; pointer.y += pointer.sy * ph;
      const speed = Math.hypot(pointer.sx, pointer.sy), drag = speed > 4 ? 4 / speed : 1;
      pointer.vx = pointer.sx * .07 * drag; pointer.vy = pointer.sy * .07 * drag;
      settling = pointer.amt > .02 || Math.abs(pointer.amtVelocity) > .02 || pointer.target > 0;
    }
    // Tenths, rounded up (any breeze reads 0.1): a write per frame would cost a style recalc per frame.
    setData('wind', String(Math.ceil(wind * 10) / 10));
    drift += dt * (.012 + wind * .11);
    time += dt;
    if (!settling) { pointer.amt = 0; pointer.amtVelocity = 0; pointer.sx = 0; pointer.sy = 0; }
    // 60 fps while the pointer is live and while the parting closes fast; its last slow stretch is fine at the wind's 30 —
    // and none of it while a run churns the transcript, where `tick` keeps the timer at IDLE_FPS instead.
    stirring = settling && (pointer.target > 0 || Math.abs(pointer.amtVelocity) > 1.5);
    return windVelocity !== 0 || settling;
  }
  let stirring = false;
  /** One frame: on rAF while anything moves, else on a timer at IDLE_FPS, so the idle sky never wakes every vsync. */
  function tick(now: number): void {
    const onFrame = frame !== 0;
    frame = 0; timer = 0;
    if (!active()) return;
    // The reader is moving the transcript or typing: paint nothing, and come back when the hold lifts. `last` stays where
    // it was, so the resumed frame spans the hold the way a slow frame spans its gap: `dt` is clamped at .1 s below, so a
    // hold shorter than that is taken up and a longer one is dropped rather than jumped — the clock never rewinds. That
    // .1 s is then integrated in 1/60 s substeps (`step`), so the springs cannot overshoot on the resumed frame — and the
    // pointer is seeded from the resumed instant there, one frame's worth, while the wind catches up over the whole span.
    if (now < holdUntil) {
      armResume();
      return;
    }
    // The growth signal, sampled once here and nowhere else (`sampleGrowth`): it decides this frame's interval, and the
    // release needs no timer of its own, since every paint compares the height again.
    sampleGrowth(now);
    const churn = churning(now);
    const interval = now - (last || now);
    // Only the frame that ends a reader hold is clamped at .1 s: that wait is not scene time. A slow cadence
    // (4 fps, 2 on a tile) still advances the shader clock with the wall gap, capped at .5 s so a backgrounded
    // tab does not integrate a long stall. `step` splits either span into 1/60 s substeps.
    const dt = Math.min(resumeIn ? .1 : .5, interval / 1000);
    last = now;
    // A held tick returned above, before `paint()` and this sample; its wait is never sampled. A timer frame is costed by
    // how long the paint itself took, not by the intentional gap between idle ticks, so a quiet sky does not trip the governor.
    const started = performance.now();
    const busy = step(dt, resumeIn);
    resumeIn = false;
    paint();
    if (forcePaintMs !== null) sample(forcePaintMs);
    else if (onFrame && timing === 'frame' && interval > 0) sample(Math.max(0, interval - 1000 / 60));
    else if (!ctx?.timer) sample(Math.max(0, performance.now() - started));
    if (!busy && !running() && now - activityAt >= SETTLE_MS) { still('settled'); return; }
    setData('skyState', busy || running() ? 'moving' : 'idle');
    // The pointer's rAF burst stays gated by `churn` (any run, or a transcript that just grew): a streaming thread already
    // relays out every frame, and 60 canvas frames on top of that pin a core. A steady run that is not growing uses its
    // scene cadence instead of the wind's 30. A growing transcript stays at the idle 8.
    const growing = now - grewAt < GROWTH_MS;
    if (busy && stirring && !churn) frame = requestAnimationFrame(tick);
    else {
      const fps = growing ? IDLE_FPS
        : busy ? WIND_FPS
        : scene.motion === 'fast' ? (options.tileRoot ? FAST_TILE_FPS : FAST_FPS)
        : options.tileRoot ? TILE_FPS
        : running() ? RUN_FPS
        : IDLE_FPS;
      timer = window.setTimeout(() => tick(performance.now()), 1000 / fps);
    }
  }
  function stopPrecompile(): void {
    if (idle) cancelIdleCallback(idle);
    window.clearTimeout(idleTimer); idle = 0; idleTimer = 0;
  }
  function clearPausePark(): void {
    if (pauseParkTimer) { window.clearTimeout(pauseParkTimer); pauseParkTimer = 0; }
  }
  function clearStill(): void {
    stillKey = ''; stillShape = ''; settled = false;
    if (stillCanvas.hidden && !stillCanvas.width && !stillCanvas.height) return;
    stillCanvas.hidden = true; stillCanvas.width = 0; stillCanvas.height = 0;
  }
  function clearFade(): void {
    fading?.cancel(); fading = null;
    fade.hidden = true; fade.width = 0; fade.height = 0;
    delete layer.dataset.fading;
  }
  function loseWebglCanvas(): void {
    stopPrecompile();
    const oldContext = ctx, old = canvas;
    ctx = undefined; bound = null; query = null;
    if (oldContext === undefined && !old.width && !old.height) return;
    old.removeEventListener('webglcontextlost', contextLost);
    canvas = document.createElement('canvas'); canvas.width = 0; canvas.height = 0;
    canvas.addEventListener('webglcontextlost', contextLost);
    old.replaceWith(canvas);
    (oldContext?.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    old.width = 0; old.height = 0;
  }
  function snapshotAndPark(): boolean {
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) {
      if (ctx) { loseWebglCanvas(); if (stillCanvas.hidden) layer.removeAttribute('data-gl'); }
      return !stillCanvas.hidden;
    }
    const g = stillCanvas.getContext('2d', { alpha: false });
    if (!g) return false;
    if (stillCanvas.width !== canvas.width || stillCanvas.height !== canvas.height) {
      stillCanvas.width = canvas.width;
      stillCanvas.height = canvas.height;
    }
    g.drawImage(canvas, 0, 0);
    stillCanvas.hidden = false;
    stillKey = currentStillKey();
    stillShape = currentStillShape();
    layer.setAttribute('data-gl', '');
    loseWebglCanvas();
    return true;
  }
  function releaseContext(): void {
    clearPausePark(); clearFade(); clearStill();
    loseWebglCanvas();
    costs = []; gpuCosts = []; gpuMs = null; timing = 'frame';
    layer.removeAttribute('data-gl');
  }
  function still(state: 'static' | 'settled'): void {
    last = 0;
    const parked = ctx ? snapshotAndPark() : true;
    setData('skyState', state);
    timer = window.setInterval(() => {
      if (active()) {
        paint();
        settled = (!ctx || snapshotAndPark()) && state === 'settled';
      }
    }, CLOCK_MS);
    if (!parked) return;
    settled = state === 'settled';
  }
  function stop(): void {
    clearPausePark();
    window.clearTimeout(timer); window.clearInterval(timer); timer = 0;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
  }
  function schedule(): void {
    const wasWoken = woken;
    woken = false;
    stop();
    stopPrecompile();
    last = 0;
    if (!shown) { setData('skyState', 'off'); return; }
    if (!active()) {
      clearFade();
      setData('skyState', 'paused');
      if (ctx) {
        pauseParkTimer = window.setTimeout(() => {
          pauseParkTimer = 0;
          if (disposed || !shown || active() || !ctx) return;
          if (paneWidth > 0 && paneHeight > 0) {
            paint();
            snapshotAndPark();
          } else {
            clearStill();
            loseWebglCanvas();
            layer.removeAttribute('data-gl');
          }
        }, PAUSE_PARK_MS);
      }
      return;
    }
    if (reducedMotion.matches) {
      wind = 0; windVelocity = 0; pointer.amt = 0; setData('wind', '0');
      clearFade();
      if (stillCanvas.hidden || stillKey !== currentStillKey()) paint();
      still('static');
      return;
    }
    if (settled && !wasWoken && !running() && wind === 0 && windVelocity === 0 && pointer.amt === 0 && pointer.target === 0 && fading === null && fade.hidden && !stillCanvas.hidden && stillShape === currentStillShape()) {
      if (stillKey !== currentStillKey()) paint();
      still('settled');
      return;
    }
    settled = false;
    activityAt = performance.now();
    clearStill();
    if (!ctx) paint();
    precompile();
    frame = requestAnimationFrame(tick);
  }
  /** Wakes the loop at once (pointer, wind). A settled sky leaves its snapshot only on this path. A run keeps the
   * pointer off the 60 fps burst (`churning`); an urgent wake (the run flipping) still gets one frame. */
  function wake(urgent = false): void {
    activityAt = performance.now();
    settled = false;
    if (frame || !active() || reducedMotion.matches) return;
    // A parked snapshot stays on top of the live canvas until it is cleared. A run wakes through the churn path
    // below, which does not go through `schedule`, so the still has to come down here.
    if (!stillCanvas.hidden) clearStill();
    if (holding()) { armResume(); return; }
    if (churning(performance.now())) {
      if (!urgent) {
        setData('skyState', 'moving');
        if (!timer) timer = window.setTimeout(() => tick(performance.now()), 1000 / IDLE_FPS);
        return;
      }
      window.clearTimeout(timer); timer = 0;
      setData('skyState', 'moving');
      woken = true;
      frame = requestAnimationFrame(tick);
      return;
    }
    woken = true;
    setData('skyState', 'moving');
    const previous = last;
    schedule();
    last = previous;
  }
  /** The run flipped: the wind starts moving on this frame (a small push, still eased by its spring), not a beat later. */
  function windChanged(): void {
    if (reducedMotion.matches) return;
    windVelocity += ((running() ? 1 : 0) - wind) * 1.2;
    wake(true);
  }
  function refresh(): void {
    if (disposed) return;
    const want = options.wanted() && !lessTransparency.matches;
    if (want !== shown) {
      shown = want;
      layer.hidden = !want;
      if (want && ctx === undefined) ctx = context(canvas);
      if (want && !paneWidth) { paneWidth = layer.clientWidth; paneHeight = layer.clientHeight; }
      if (want) paint(); else releaseContext();
    }
    syncScene();
    schedule();
  }
  /** `data-scene` on the workspace drives the thread's readable surfaces (wallpapers.css, sky-window.css). */
  function syncScene(): void {
    const scene = workspace.dataset.wallpaper ? 'wallpaper' : shown && !workspace.matches('.board-view,.github-view') ? 'sky' : '';
    if ((workspace.dataset.scene ?? '') === scene) return;
    if (scene) workspace.dataset.scene = scene; else delete workspace.dataset.scene;
  }
  /** The open thread changed: show its scene, crossfading from the last frame of the old one. Instant on the first
   * thread, before the startup gate opens, under reduced motion, while paused, or without WebGL. */
  function setThread(id: string | null): void {
    if (disposed) return;
    const next = sceneById(options.pinnedScene) ?? sceneFor(id), first = !hadThread;
    if (id) hadThread = true;
    if (next === scene) return;
    const animate = !first && shown && active() && !reducedMotion.matches && layer.hasAttribute('data-gl') && document.documentElement.hasAttribute('data-ready');
    clearFade();
    let fadeSource: HTMLCanvasElement | null = null;
    if (animate) {
      if (ctx) {
        paint();
        if (canvas.width > 0 && canvas.height > 0) fadeSource = canvas;
      } else if (!stillCanvas.hidden && stillCanvas.width > 0 && stillCanvas.height > 0) {
        fadeSource = stillCanvas;
      }
    }
    if (fadeSource) {
      const g = fade.getContext('2d');
      if (g) {
        if (fade.width !== fadeSource.width || fade.height !== fadeSource.height) { fade.width = fadeSource.width; fade.height = fadeSource.height; }
        g.drawImage(fadeSource, 0, 0);
        fade.hidden = false;
        setData('fading', 'true'); fades++;
        fading = fade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'cubic-bezier(.33,0,.2,1)' });
        const done = fading;
        const finish = (): void => { if (fading === done) clearFade(); };
        void done.finished.then(finish, finish);
      }
    } else delete layer.dataset.fading;
    scene = next;
    shownGradient = '';
    if (shown && active()) {
      if (reducedMotion.matches) { schedule(); return; }
      clearStill();
      paint();
      wake();
    } else if (shown) {
      clearStill();
      if (!ctx) layer.removeAttribute('data-gl');
    } else clearStill();
  }
  function move(event: PointerEvent): void {
    if (!shown || reducedMotion.matches || event.pointerType === 'touch') return;
    if ((event.target as Element | null)?.closest?.(READABLE)) { leave(); return; }
    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (options.tileRoot && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) { leave(); return; }
    pointer.tx = (event.clientX - rect.left) / rect.width;
    pointer.ty = 1 - (event.clientY - rect.top) / rect.height;
    if (pointer.target === 0 && pointer.amt < .05) { pointer.x = pointer.tx; pointer.y = pointer.ty; pointer.sx = 0; pointer.sy = 0; }
    pointer.target = 1; pointer.movedAt = performance.now(); inputAt = pointer.movedAt;
    wake();
  }
  function leave(): void { pointer.target = 0; }
  /** The reader moving a transcript holds frames: a wheel, a touch drag, or a press on it (its scrollbar included). Reader
   * intent is read from the event, never from the scroll position, so every scroll the app makes itself — a send's eased
   * follow, a fold or a handoff keeping its own card still, the browser anchoring an older page — holds nothing, and nothing
   * here depends on a follow constant in main.ts. One `closest()` on the target, and no layout read: a wheel that lands
   * anywhere else (the sidebar, an inspector view that is not the side thread, a dialog) costs that call and nothing
   * more. */
  function readerMoves(event: Event): void {
    if (event.target instanceof Element && event.target.closest(SCROLLERS)) hold();
  }
  /** Keys in a transcript (the reader scrolling it from the keyboard) and keystrokes or text input in a composer hold
   * frames; `input` also covers what a keystroke does not fire: paste, IME composition, dictation. A tile's composer is a
   * button (`.thread-mirror-composer`) that focuses the real `#prompt`, so the keystrokes that follow land in
   * `#composer-area`; the button itself takes the press. */
  function readerTypes(event: Event): void {
    if (event.target instanceof Element && event.target.closest(TYPING)) hold();
  }
  function onFocus(event: Event): void { focused = event.type === 'focus'; schedule(); }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.attributeName === 'data-running') windChanged();
      if (record.attributeName === 'data-focused') { schedule(); return; }
      if (record.attributeName === 'class' || record.attributeName === 'inert' || record.attributeName === 'data-wallpaper') { syncScene(); schedule(); return; }
      if (record.attributeName === 'data-theme' && active()) { paint(); if (reducedMotion.matches) snapshotAndPark(); else wake(); }
    }
  });
  observer.observe(workspace, { attributes: true, attributeFilter: ['class', 'data-wallpaper'] });
  observer.observe(pane, { attributes: true, subtree: true, attributeFilter: ['data-running', 'inert', 'data-focused'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const intersection = new IntersectionObserver(entries => { visible = entries.at(-1)?.isIntersecting ?? true; schedule(); });
  intersection.observe(layer);
  const resize = new ResizeObserver(entries => {
    const box = entries.at(-1)?.contentRect;
    if (!box || (!box.width && !box.height)) return;
    const changed = box.width !== paneWidth || box.height !== paneHeight;
    paneWidth = box.width; paneHeight = box.height;
    if (!changed && !stillCanvas.hidden) return;
    if (active()) { paint(); if (reducedMotion.matches) snapshotAndPark(); else wake(); }
  });
  resize.observe(layer);
  function contextLost(event: Event): void {
    event.preventDefault();
    if (event.target !== canvas) return;
    stopPrecompile(); ctx = null; bound = null; query = null;
    if (stillCanvas.hidden) layer.removeAttribute('data-gl');
  }
  canvas.addEventListener('webglcontextlost', contextLost);
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(type, input, { capture: true, passive: true });
  // The reader's own input holds frames (`hold`); a scroll that arrives without one of these is the app's and holds nothing.
  // On `document`, never on `pane` or on #transcript/#composer-area: no single instance's pane holds them all — a tile's
  // `pane` is its own `.thread-tile`, whose scroller is `.thread-mirror-rows`, while the focused thread's `#transcript` and
  // `#composer-area` are its siblings in `.work-area` — so a pane-scoped listener would leave every tile painting at 30 fps
  // through a reader's scroll of the real transcript. The filter is the only thing that decides (one `closest()` per
  // event), so input from the sidebar, an inspector view other than the side thread, or a dialog still holds nothing.
  for (const type of ['wheel', 'touchmove', 'pointerdown'] as const) document.addEventListener(type, readerMoves, { capture: true, passive: true });
  for (const type of ['keydown', 'input'] as const) document.addEventListener(type, readerTypes, { capture: true, passive: true });
  pointerRoot.addEventListener('pointermove', move, { passive: true });
  pointerRoot.addEventListener('pointerleave', leave, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onFocus);
  reducedMotion.addEventListener('change', schedule);
  lessTransparency.addEventListener('change', refresh);
  if (options.expose) Object.assign(window, { __sky: { get frames() { return frames; }, get scene() { return scene.id; }, get fades() { return fades; }, get scale() { return scale; }, get timing() { return timing; }, get gpuMs() { return gpuMs; },
    get scenes() { return SCENES.map(each => each.id); }, get compiled() { return ctx ? [...ctx.programs.keys()] : []; },
    // The parting spring: `amt` is the 0..1 presence the scenes take as `ptrAmt`, `vel` its Euler velocity and `target`
    // whether the pointer holds it (1 over the bare scene, 0 over a readable surface or after ~350 ms of rest).
    get ptrAmt() { return pointer.amt; }, get ptrVel() { return pointer.amtVelocity; }, get ptrTarget() { return pointer.target; },
    set forcePaintMs(ms: number | null) { forcePaintMs = ms; costs = []; }, set quietMs(ms: number) { quietMs = ms; } } });
  refresh();

  return {
    refresh,
    setThread,
    dispose(): void {
      disposed = true;
      stop();
      stopPrecompile();
      clearFade();
      clearStill();
      for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.removeEventListener(type, input, { capture: true });
      for (const type of ['wheel', 'touchmove', 'pointerdown'] as const) document.removeEventListener(type, readerMoves, { capture: true });
      for (const type of ['keydown', 'input'] as const) document.removeEventListener(type, readerTypes, { capture: true });
      observer.disconnect(); intersection.disconnect(); resize.disconnect();
      pointerRoot.removeEventListener('pointermove', move);
      pointerRoot.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onFocus);
      reducedMotion.removeEventListener('change', schedule);
      lessTransparency.removeEventListener('change', refresh);
      loseWebglCanvas();
      layer.remove();
    },
  };
}
