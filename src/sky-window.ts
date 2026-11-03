import './sky-window.css';
import { DARK_CEILING, lightFloor, minutesOf, moonPosition, skyColorsAt, sunPosition, type Rgb } from './sky-math';
import { SCENES, sceneById, sceneFor, type Scene } from './scenes';
import { PRELUDE, UNIFORMS, VERTEX } from './scenes/types';

/** The thread's window: a procedural scene (src/scenes/: the sky, the aurora, …; WebGL fragment shader, CSS gradient
 * fallback) behind the conversation, picked per thread by `setThread` and crossfaded (~300 ms) on a switch.
 * Wind follows the open thread's run (`#transcript[data-running]`), the pointer parts the clouds, and it renders
 * only while visible: about 8 fps at rest (on a timer, not rAF), 30 while only the wind moves, 60 while the pointer does.
 * A governor drops the render scale from 0.6 to 0.45 of device pixels when a paint averages over ~8 ms. */
export interface SkyOptions {
  /** Whether the sky should show at all (wallpapers off, no accessibility override). */
  wanted(): boolean;
  /** Fixed clock for previews and specs (`?sky=06:30`). */
  fixedMinutes?: number | null;
  /** A tile's own scene (thread-tiles.ts): pointer moves come from this ancestor, since the real pane may lie over the
   * tile, and it leaves the idle precompile to the main instance. */
  tileRoot?: HTMLElement;
  /** Preview only: `window.__sky.frames` counts painted frames for specs. */
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
const IDLE_FPS = 8, WIND_FPS = 30;
/** Render scale (of device pixels) and the governor's budget: paint time averaged over SAMPLE frames above BUDGET_MS drops
 * to LOW_SCALE; it goes back up only after QUIET_MS of averages under half the budget. */
const SCALE = .6, LOW_SCALE = .45, BUDGET_MS = 8, SAMPLE = 30, QUIET_MS = 60_000;
/** `__sky.gpuMs` (preview) is the mean of this many GPU timer results. */
const GPU_SAMPLE = 10;
/** The precompile waits this long after the last input, and polls a parallel compile this often. */
const INPUT_QUIET_MS = 1000, COMPILE_POLL_MS = 100;
/** Pointer influence stops over the thread's readable surfaces: the clouds answer only where the sky shows. */
const READABLE = '.message,.turn-activity,.message-error,.empty-conversation,.turn-changes-row,.thinking-block,#composer-area,.new-task-welcome,.workspace-header,#action-dock,.file-tabs';
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
  const canvas = document.createElement('canvas');
  // The outgoing scene's last frame, copied here on a thread switch and faded out over the new one (opacity only).
  const fade = document.createElement('canvas');
  fade.className = 'thread-sky-fade';
  fade.hidden = true;
  layer.append(canvas, fade);
  pane.prepend(layer);
  const pointerRoot = options.tileRoot ?? pane;
  const transcript = (): HTMLElement | null => pane.querySelector('#transcript');
  // One WebGL context; each scene's program compiles on first use (`programFor`).
  let ctx: Context | null | undefined, bound: Program | null = null, fades = 0;
  let scene: Scene = sceneById(options.pinnedScene) ?? sceneFor(null), hadThread = false, fading: Animation | null = null;
  let frame = 0, timer = 0, last = 0, frames = 0, disposed = false, shown = false, visible = true, focused = true;
  // Size from the ResizeObserver, so a paint never reads layout.
  let paneWidth = 0, paneHeight = 0;
  // The governor: recent paint times (GPU timer query where the driver has one, else the rAF interval past a 60 Hz frame).
  let scale = SCALE, costs: number[] = [], droppedAt = 0, query: WebGLQuery | null = null, timing: 'gpu' | 'frame' = 'frame';
  // Preview only (`__sky.forcePaintMs`, `__sky.quietMs`): specs drive the governor with made-up paint times.
  let forcePaintMs: number | null = null, quietMs = QUIET_MS, gpuMs: number | null = null, gpuCosts: number[] = [];
  // The precompile (`precompile`): the idle callback or poll timer it is waiting on, and the last user input.
  let idle = 0, idleTimer = 0, inputAt = 0;
  // Wind and pointer are critically damped springs; drift is integrated so a speed change never jumps the clouds.
  let wind = 0, windVelocity = 0, drift = 0, time = 0;
  const pointer = { x: .5, y: .5, tx: .5, ty: .5, sx: 0, sy: 0, amt: 0, amtVelocity: 0, target: 0, vx: 0, vy: 0, movedAt: 0 };

  let shownGradient = '';
  const setData = (key: string, value: string): void => { if (layer.dataset[key] !== value) layer.dataset[key] = value; };
  const running = (): boolean => transcript()?.hasAttribute('data-running') ?? pane.hasAttribute('data-running');
  const covered = (): boolean => workspace.matches('.settings-open,.board-view,.github-view') || pane.querySelector('.conversation-pane')?.hasAttribute('inert') === true;
  const active = (): boolean => shown && visible && !document.hidden && focused && !covered();
  const minutes = (): number => options.fixedMinutes ?? minutesOf(new Date());

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
    const program = ctx ? programFor(ctx, scene) ?? null : null;
    if (!ctx || !program) { layer.removeAttribute('data-gl'); return; }
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
  /** Spring steps; returns whether anything is still moving fast enough to need full frame rate. */
  function step(dt: number): boolean {
    const spring = (value: number, velocity: number, target: number, response: number): [number, number] => {
      const k = (2 * Math.PI / response) ** 2, c = 2 * Math.sqrt(k);
      const v = velocity + (k * (target - value) - c * velocity) * dt;
      return [value + v * dt, v];
    };
    [wind, windVelocity] = spring(wind, windVelocity, running() ? 1 : 0, 1);
    if (Math.abs(wind - Math.round(wind)) < .002 && Math.abs(windVelocity) < .002) { wind = Math.round(wind); windVelocity = 0; }
    // Tenths, rounded up (any breeze reads 0.1): a write per frame would cost a style recalc per frame.
    setData('wind', String(Math.ceil(wind * 10) / 10));
    drift += dt * (.012 + wind * .11);
    time += dt;
    if (performance.now() - pointer.movedAt > 350) pointer.target = 0;
    // Nearly critically damped, so the clouds settle back softly and quickly (~0.5 s).
    // It answers within ~150 ms as the pointer arrives; the settle back stays as soft as before.
    const rising = pointer.target > pointer.amt, k = rising ? 280 : 90, c = rising ? 33 : 16;
    pointer.amtVelocity += (k * (pointer.target - pointer.amt) - c * pointer.amtVelocity) * dt;
    pointer.amt = Math.max(0, pointer.amt + pointer.amtVelocity * dt);
    // The parting follows the cursor on its own soft spring (damping 0.7), so the clouds trail it and settle with a
    // little overshoot; its velocity (clamped) drags a billow along the motion.
    const pk = 70, pc = 2 * .7 * Math.sqrt(pk);
    pointer.sx += (pk * (pointer.tx - pointer.x) - pc * pointer.sx) * dt; pointer.sy += (pk * (pointer.ty - pointer.y) - pc * pointer.sy) * dt;
    pointer.x += pointer.sx * dt; pointer.y += pointer.sy * dt;
    const speed = Math.hypot(pointer.sx, pointer.sy), drag = speed > 4 ? 4 / speed : 1;
    pointer.vx = pointer.sx * .07 * drag; pointer.vy = pointer.sy * .07 * drag;
    const settling = pointer.amt > .02 || Math.abs(pointer.amtVelocity) > .02 || pointer.target > 0;
    if (!settling) { pointer.amt = 0; pointer.amtVelocity = 0; pointer.sx = 0; pointer.sy = 0; }
    // 60 fps while the pointer is live and while the parting closes fast; its last slow stretch is fine at the wind's 30.
    stirring = settling && (pointer.target > 0 || Math.abs(pointer.amtVelocity) > 1.5);
    return windVelocity !== 0 || wind > 0 || settling;
  }
  let stirring = false;
  /** One frame: on rAF while anything moves, else on a timer at IDLE_FPS, so the idle sky never wakes every vsync. */
  function tick(now: number): void {
    const onFrame = frame !== 0;
    frame = 0; timer = 0;
    if (!active()) return;
    const interval = now - (last || now);
    const dt = Math.min(.1, interval / 1000);
    last = now;
    // Without a GPU timer, a 60 Hz frame that took longer than its slot is the paint cost showing.
    if (forcePaintMs !== null) sample(forcePaintMs);
    else if (onFrame && timing === 'frame' && interval > 0) sample(Math.max(0, interval - 1000 / 60));
    const busy = step(dt);
    paint();
    setData('skyState', busy ? 'moving' : 'idle');
    // Full frame rate only while the pointer stirs the clouds; the wind alone moves slowly enough for 30.
    if (busy && stirring) frame = requestAnimationFrame(tick);
    else timer = window.setTimeout(() => tick(performance.now()), 1000 / (busy ? WIND_FPS : IDLE_FPS));
  }
  function stop(): void {
    window.clearTimeout(timer); window.clearInterval(timer); timer = 0;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
  }
  function schedule(): void {
    stop();
    last = 0;
    if (!shown) { setData('skyState', 'off'); return; }
    if (!active()) { setData('skyState', 'paused'); return; }
    if (reducedMotion.matches) {
      // One still frame for the current time, refreshed every few minutes.
      wind = 0; windVelocity = 0; pointer.amt = 0; setData('wind', '0');
      paint(); setData('skyState', 'static');
      timer = window.setInterval(() => { if (active()) paint(); }, 3 * 60_000);
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  /** Wakes the loop at once (pointer, wind); a frame already queued on rAF is left alone. */
  function wake(): void {
    if (frame || !active() || reducedMotion.matches) return;
    setData('skyState', 'moving');
    schedule();
  }
  /** The run flipped: the wind starts moving on this frame (a small push, still eased by its spring), not a beat later. */
  function windChanged(): void {
    if (reducedMotion.matches) return;
    windVelocity += ((running() ? 1 : 0) - wind) * 1.2;
    wake();
  }
  function refresh(): void {
    if (disposed) return;
    const want = options.wanted() && !lessTransparency.matches;
    if (want !== shown) {
      shown = want;
      layer.hidden = !want;
      if (want && ctx === undefined) ctx = context(canvas);
      if (want && !paneWidth) { paneWidth = layer.clientWidth; paneHeight = layer.clientHeight; }
      if (want) paint();
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
    fading?.cancel(); fading = null; fade.hidden = true;
    if (animate && ctx) {
      // The drawing buffer is still the last frame within this task: paint it once more and copy it before it is gone.
      paint();
      const g = fade.getContext('2d');
      if (g) {
        if (fade.width !== canvas.width || fade.height !== canvas.height) { fade.width = canvas.width; fade.height = canvas.height; }
        g.drawImage(canvas, 0, 0);
        fade.hidden = false;
        setData('fading', 'true'); fades++;
        fading = fade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'cubic-bezier(.33,0,.2,1)' });
        const done = fading;
        void done.finished.then(() => { if (fading === done) { fade.hidden = true; fading = null; delete layer.dataset.fading; } }, () => {});
      }
    } else delete layer.dataset.fading;
    scene = next;
    shownGradient = '';
    // Paused: the loop paints the new scene when it resumes.
    if (shown && (active() || !ctx)) paint();
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
  function onFocus(event: Event): void { focused = event.type === 'focus'; schedule(); }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.attributeName === 'data-running') windChanged();
      if (record.attributeName === 'class' || record.attributeName === 'inert' || record.attributeName === 'data-wallpaper') { syncScene(); schedule(); return; }
      if (record.attributeName === 'data-theme' && shown) paint();
    }
  });
  observer.observe(workspace, { attributes: true, attributeFilter: ['class', 'data-wallpaper'] });
  observer.observe(pane, { attributes: true, subtree: true, attributeFilter: ['data-running', 'inert'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const intersection = new IntersectionObserver(entries => { visible = entries.at(-1)?.isIntersecting ?? true; schedule(); });
  intersection.observe(layer);
  const resize = new ResizeObserver(entries => {
    const box = entries.at(-1)?.contentRect;
    if (box) { paneWidth = box.width; paneHeight = box.height; }
    if (shown) paint();
  });
  resize.observe(layer);
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); ctx = null; bound = null; layer.removeAttribute('data-gl'); });
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(type, input, { capture: true, passive: true });
  pointerRoot.addEventListener('pointermove', move, { passive: true });
  pointerRoot.addEventListener('pointerleave', leave, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onFocus);
  reducedMotion.addEventListener('change', schedule);
  lessTransparency.addEventListener('change', refresh);
  if (options.expose) Object.assign(window, { __sky: { get frames() { return frames; }, get scene() { return scene.id; }, get fades() { return fades; }, get scale() { return scale; }, get timing() { return timing; }, get gpuMs() { return gpuMs; },
    get scenes() { return SCENES.map(each => each.id); }, get compiled() { return ctx ? [...ctx.programs.keys()] : []; },
    set forcePaintMs(ms: number | null) { forcePaintMs = ms; costs = []; }, set quietMs(ms: number) { quietMs = ms; } } });
  refresh();

  return {
    refresh,
    setThread,
    dispose(): void {
      disposed = true;
      stop();
      if (idle) cancelIdleCallback(idle);
      window.clearTimeout(idleTimer);
      for (const type of ['pointerdown', 'keydown', 'wheel'] as const) window.removeEventListener(type, input, { capture: true });
      observer.disconnect(); intersection.disconnect(); resize.disconnect();
      pointerRoot.removeEventListener('pointermove', move);
      pointerRoot.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onFocus);
      reducedMotion.removeEventListener('change', schedule);
      lessTransparency.removeEventListener('change', refresh);
      (ctx?.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
      layer.remove();
    },
  };
}
