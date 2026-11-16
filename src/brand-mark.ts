import './brand-mark.css';
import { BOX_HEIGHT, DIP, HALF_WIDTH, PANDA_SIZE, PERCH_OFFSET_D, REST_GAP, SINK, TRICK_JUMP } from '../mobile/src/ui/brand/geometry.ts';
import { lerp, smooth } from '../mobile/src/ui/brand/motion-curves.ts';
import { answer, canTrick, letter, moving, nextWake, passTimes, perchGlow, PERCH_LETTER, pose, SHOW_END, TRICK_S, trick, type Pose } from '../mobile/src/ui/brand/panda-motion.ts';
import { BEAT_END, flight, glide, HANDOFF_MS, introPose, LAND, LAUNCH, launchLetter, letterOpacity, letterRise, letterTimes, letterTone, WORD_SCALE, type Point } from '../mobile/src/ui/splash/timeline.ts';

const WORD = 'PandaCode';
const SCALE = 0.7;
const TONES = ['team', 'plan', 'remote', 'edit', 'team', 'saver', 'plan', 'team', 'worktree'];
interface Span { left: number; width: number }

/** Keep the word readable; a tight title bar gets a full-size panda instead. */
export function desktopBrandFit(available: number, width: number, height: number) {
  const limit = Math.min(SCALE, height / 55 * SCALE);
  const compact = available / width < .55;
  const scale = compact ? limit : Math.min(limit, available / width);
  return { compact, scale, width: (compact ? 32 : width) * scale };
}

/** Perches follow the actual glyph advances and ascenders on this platform. */
export function desktopBrandLayout(spans: readonly Span[], ascents: readonly number[], baseline: number) {
  const centre = (i: number) => spans[i].left + spans[i].width / 2;
  const end = spans[8].left + spans[8].width;
  const px = [end + REST_GAP + HALF_WIDTH, centre(7) + PERCH_OFFSET_D, centre(5)];
  return { px, ph: [0, ascents[7] - SINK, ascents[5] - SINK], passes: passTimes(spans.map((_, i) => centre(i)), px), baseline, width: px[0] + HALF_WIDTH + 2 };
}

/** A missing destination clears in place; it must never fly to a hidden sidebar's zero rect. */
export function desktopBrandFlight(h: number, rest: Point, target: (Point & { scale?: number }) | null) {
  if (!target) return { ...rest, scale: WORD_SCALE, opacity: 1 - smooth(h) };
  const p = flight(h, rest, target);
  return { ...p, scale: WORD_SCALE * p.scale * (target.scale ?? SCALE) ** glide(h), opacity: 1 };
}

let markId = 0;
function makeMark() {
  const stage = document.createElement('span');
  stage.className = 'desktop-brand-stage';
  const word = document.createElement('span');
  word.className = 'desktop-brand-word';
  const letters = [...WORD].map((char, i) => {
    const el = document.createElement('span');
    el.className = 'desktop-brand-letter';
    el.textContent = char;
    el.dataset.letter = char;
    el.style.setProperty('--brand-tone', `var(--ds-tone-${TONES[i]})`);
    word.append(el);
    return el;
  });
  const baseline = document.createElement('span');
  baseline.className = 'desktop-brand-baseline';
  word.append(baseline);
  const id = `desktop-panda-head-${++markId}`;
  const panda = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  panda.classList.add('desktop-brand-panda');
  panda.setAttribute('viewBox', '0 0 22 22');
  panda.setAttribute('aria-hidden', 'true');
  panda.setAttribute('focusable', 'false');
  panda.innerHTML = `<defs><clipPath id="${id}"><rect x=".5" y="2" width="21" height="15.5" rx="7.75"/></clipPath></defs>
    <g data-part="lean"><g data-part="spin"><g data-part="squash">
      <g data-part="body"><rect class="panda-belly" x="4" y="13" width="14" height="8" rx="4"/>
        <g data-part="feet" class="panda-ink"><rect x="5.4" y="18.4" width="5" height="3.6" rx="1.8"/><rect x="11.6" y="18.4" width="5" height="3.6" rx="1.8"/></g>
        <rect data-part="armL" class="panda-ink" x="2.4" y="13.4" width="4" height="4" rx="2"/>
        <rect data-part="armR" class="panda-ink" x="15.6" y="13.4" width="4" height="4" rx="2"/>
      </g>
      <g data-part="head">
        <g data-part="earL"><circle class="panda-ear-rim" cx="4.9" cy="3.9" r="3.5"/><circle class="panda-ink" cx="4.9" cy="3.9" r="3"/></g>
        <g data-part="earR"><circle class="panda-ear-rim" cx="17.1" cy="3.9" r="3.5"/><circle class="panda-ink" cx="17.1" cy="3.9" r="3"/></g>
        <rect class="panda-rim" x="-.1" y="1.4" width="22.2" height="16.7" rx="8.35"/>
        <g clip-path="url(#${id})"><rect class="panda-shade" x=".5" y="2" width="21" height="15.5" rx="7.75"/>
          <circle data-part="shade" class="panda-fur" cx="8.5" cy="7.5" r="11"/><circle data-part="shine" class="panda-shine" cx="6.1" cy="6.4" r="3"/>
          <g data-part="face">
            <g data-part="eyeL"><rect class="panda-ink" x="3.5" y="6.8" width="5.6" height="7" rx="2.8" transform="rotate(30 6.3 10.3)"/><circle class="panda-pupil" cx="6.9" cy="10.6" r="1.1"/><circle class="panda-fur" cx="6.5" cy="10.2" r=".5"/></g>
            <g data-part="eyeR"><rect class="panda-ink" x="12.9" y="6.8" width="5.6" height="7" rx="2.8" transform="rotate(-30 15.7 10.3)"/><circle class="panda-pupil" cx="15.1" cy="10.6" r="1.1"/><circle class="panda-fur" cx="14.7" cy="10.2" r=".5"/></g>
            <ellipse class="panda-blush" cx="3.3" cy="13.8" rx="1.8" ry="1"/><ellipse class="panda-blush" cx="18.7" cy="13.8" rx="1.8" ry="1"/>
            <rect class="panda-ink" x="9.3" y="12.8" width="3.4" height="2.1" rx="1.05"/>
            <path class="panda-mouth" d="M9.3 14.6q.15 1.5 1.7 .3q1.55 1.2 1.7-.3"/>
          </g>
        </g>
      </g>
    </g></g></g>`.replace(/>\s+</g, '><');
  stage.append(word, panda);
  const parts = Object.fromEntries([...panda.querySelectorAll<SVGElement>('[data-part]')].map(el => [el.dataset.part!, el]));
  return { stage, word, letters, baseline, panda, parts };
}
type Mark = ReturnType<typeof makeMark>;

function measure(mark: Mark) {
  const style = getComputedStyle(mark.word);
  const context = document.createElement('canvas').getContext('2d');
  if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const ascents = [...WORD].map(char => context?.measureText(char).actualBoundingBoxAscent || 14);
  const baseline = BOX_HEIGHT / 2 + (context?.measureText('PC').actualBoundingBoxAscent || 14) / 2;
  mark.word.style.top = `${baseline - mark.baseline.offsetTop}px`;
  const spans = mark.letters.map(el => ({ left: el.offsetLeft, width: el.offsetWidth }));
  return { ...desktopBrandLayout(spans, ascents, baseline), spans };
}
type Layout = ReturnType<typeof measure>;
const transform = (el: SVGElement, value: string) => { el.setAttribute('transform', value); };

function drawPanda(mark: Mark, p: Pose, x: number, feetY: number, scale = 1, spin = 0) {
  mark.panda.style.transform = `translate(${x - PANDA_SIZE / 2}px,${feetY - PANDA_SIZE}px) scale(${scale})`;
  const g = mark.parts;
  transform(g.lean, `rotate(${p.groundLean} 11 22)`);
  transform(g.spin, `rotate(${p.pitch + p.tilt + spin} 11 11)`);
  transform(g.squash, `translate(11 22) scale(${1 / Math.sqrt(p.sy)} ${p.sy}) translate(-11 -22)`);
  transform(g.body, `translate(${-p.look} 0)`);
  transform(g.feet, `translate(0 ${-p.tuck})`);
  transform(g.armL, `translate(0 ${-2.5 * p.arms + p.brace}) rotate(${25 * p.arms} 6.4 13.4)`);
  transform(g.armR, `translate(0 ${-2.5 * p.arms + p.brace}) rotate(${-25 * p.arms} 15.6 13.4)`);
  transform(g.head, `translate(11 ${p.nod}) scale(${1 - .08 * Math.abs(p.look)} 1) translate(-11 0)`);
  transform(g.face, `translate(${p.look * 2.4} 0)`);
  const right = Math.max(p.look, 0), left = Math.max(-p.look, 0);
  transform(g.earL, `translate(${left - right * .5 - p.earsOut} ${p.earsL + left})`);
  transform(g.earR, `translate(${left * .5 - right + p.earsOut} ${p.earsR + right})`);
  transform(g.shade, `translate(${-p.look * 1.4} ${p.pitch * .06})`);
  transform(g.shine, `translate(${p.look * .9} ${-p.pitch * .06})`);
  const eyeY = 1 - .85 * p.blink;
  transform(g.eyeL, `translate(0 10.3) scale(1 ${eyeY}) translate(0 -10.3)`);
  transform(g.eyeR, `translate(0 10.3) scale(1 ${eyeY}) translate(0 -10.3)`);
}

function drawHeader(mark: Mark, layout: Layout, t: number, trickAt = 0) {
  const compact = mark.stage.hasAttribute('data-compact');
  const p = pose(compact ? 0 : t, layout.px, layout.ph), q = trick(trickAt);
  mark.letters.forEach((el, i) => {
    const state = letter(t, layout.passes[i]);
    const perch = PERCH_LETTER.indexOf(i as (typeof PERCH_LETTER)[number]);
    el.style.transform = `translateY(${state.dip * DIP}px)`;
    el.style.setProperty('--brand-wipe', `${100 * (1 - Math.max(state.glow, perch < 0 ? 0 : perchGlow(t, perch)))}%`);
  });
  const press = p.grounded && p.perch !== 0 ? letter(t, layout.passes[PERCH_LETTER[p.perch]]).dip * DIP : 0;
  drawPanda(mark, { ...p, sy: p.sy * q.sy * (1 + .04 * p.breath), earsL: p.earsL + q.earsL, earsR: p.earsR + q.earsR,
    earsOut: p.earsOut + q.earsOut, tuck: p.tuck + q.tuck, nod: p.nod + q.nod, arms: Math.max(p.arms, q.arms), brace: Math.max(p.brace, q.brace) },
  (compact ? 16 : p.x) + q.drift, layout.baseline - p.feet - q.lift * TRICK_JUMP + press + p.bob + q.bob, 1, q.spin);
}

const mounted = new WeakSet<HTMLElement>();
/** The host stays a native button; replay never intercepts the surrounding window drag region. */
export function mountDesktopBrand(host: HTMLElement): void {
  if (mounted.has(host)) return;
  mounted.add(host);
  host.classList.add('desktop-brand');
  const mark = makeMark();
  host.replaceChildren(mark.stage);
  let layout = measure(mark);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const forced = matchMedia('(forced-colors: active)');
  const root = document.documentElement;
  let frame = 0, timer = 0, last = 0, time = 0, trickAt = 0, ready = false, shown = false, scale = SCALE;
  let launch: { el: HTMLElement; mark: Mark; layout: Layout; rest: Point; from: Point; starts: number[]; pushed: number; at: number; target: (Point & { scale: number }) | null; flying: boolean; input: AbortController } | null = null;
  const staticMotion = () => motion.matches || forced.matches;
  const visible = () => host.isConnected && host.getClientRects().length > 0 && getComputedStyle(host).visibility !== 'hidden';
  const stop = () => { cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; };
  const syncLayout = () => {
    shown = visible();
    if (!shown) return;
    layout = measure(mark);
    const parent = host.parentElement!;
    const style = getComputedStyle(parent);
    const siblings = [...parent.children].filter(el => el !== host && (el as HTMLElement).offsetWidth > 0) as HTMLElement[];
    const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - siblings.reduce((sum, el) => sum + el.offsetWidth, 0) - (parseFloat(style.columnGap) || 0) * siblings.length;
    const fit = desktopBrandFit(available, layout.width, parent.clientHeight);
    scale = fit.scale;
    mark.stage.toggleAttribute('data-compact', fit.compact);
    host.style.setProperty('--brand-scale', String(scale));
    host.style.setProperty('--brand-width', `${fit.width}px`);
    drawHeader(mark, layout, time, trickAt);
  };
  const endLaunch = () => {
    if (!launch) return;
    launch.input.abort();
    launch.el.remove();
    launch = null;
    delete host.dataset.brandLaunch;
  };
  const canRun = () => ready && shown && host.isConnected && !document.hidden && !staticMotion();
  const wake = () => {
    stop();
    if (!launch && !canRun()) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const target = (): (Point & { scale: number }) | null => {
    if (!visible() || mark.stage.hasAttribute('data-compact')) return null;
    const rect = host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom > 0 ? { x: rect.left, y: rect.top, scale } : null;
  };
  const tick = (now: number) => {
    frame = 0;
    if (document.hidden || staticMotion()) { endLaunch(); return; }
    const dt = Math.min((now - last) / 1000, .05);
    last = now;
    if (launch) {
      const l = launch;
      const h = Math.max(0, (now - l.at - BEAT_END * 1000) / HANDOFF_MS);
      const t = Math.min((now - l.at) / 1000, BEAT_END + .3);
      const p = introPose(t, (now - l.at) / 1000, l.from, { x: l.layout.px[0] * WORD_SCALE, y: l.layout.baseline * WORD_SCALE });
      const calm = smooth(h);
      drawPanda(l.mark, { ...p, sy: lerp(p.sy, 1, calm), blink: p.blink * (1 - calm) }, p.x / WORD_SCALE, p.y / WORD_SCALE + p.bob, p.scale / WORD_SCALE);
      l.mark.letters.forEach((el, i) => {
        const rise = lerp(letterRise(t, l.starts[i]), 1, calm);
        const at = i === l.pushed ? LAUNCH : i >= 7 ? LAND : undefined;
        const dip = at === undefined ? 0 : answer(t - at).dip * DIP * (1 - calm);
        el.style.opacity = String(letterOpacity(t, l.starts[i]));
        el.style.transform = `translateY(${(1 - rise) * 8 + dip}px) scale(${1 - .35 * (1 - rise)})`;
        el.style.setProperty('--brand-wipe', `${100 * (1 - letterTone(t, l.starts[i], i === 8))}%`);
      });
      // The destination is read at the handoff, never per frame; geometry changes dismiss the flight.
      if (h > 0 && !l.flying) { l.target = target(); l.flying = true; }
      const f = desktopBrandFlight(h, l.rest, l.target);
      l.el.style.transform = `translate(${f.x}px,${f.y}px) scale(${f.scale})`;
      l.el.style.opacity = String(f.opacity);
      l.el.style.setProperty('--launch-plate', String(1 - smooth(h * 2)));
      if (h >= 1) { endLaunch(); syncLayout(); time = 0; }
    } else {
      if (!canRun()) return;
      time += dt;
      if (trickAt > 0) trickAt = trickAt + dt >= TRICK_S ? 0 : trickAt + dt;
      drawHeader(mark, layout, time, trickAt);
      if (!moving(time) && trickAt === 0) {
        const next = nextWake(time);
        timer = window.setTimeout(() => { time = next; wake(); }, (next - time) * 1000);
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (ready || !root.hasAttribute('data-ready')) return;
    ready = true;
    gate.disconnect();
    syncLayout();
    if (staticMotion() || document.hidden) { host.dataset.brandReady = ''; return; }
    const el = document.createElement('div');
    el.className = 'desktop-brand-launch';
    el.setAttribute('aria-hidden', 'true');
    const intro = makeMark();
    el.append(intro.stage);
    (host.closest('.workspace') || document.body).append(el);
    const introLayout = measure(intro);
    const width = introLayout.width * WORD_SCALE;
    const rest = { x: Math.max(16, (innerWidth - width) / 2), y: Math.max(24, innerHeight / 2 - introLayout.baseline * WORD_SCALE) };
    const from = { x: (introLayout.spans[2].left + introLayout.spans[2].width / 2) * WORD_SCALE, y: introLayout.baseline * WORD_SCALE };
    const input = new AbortController();
    launch = { el, mark: intro, layout: introLayout, rest, from, starts: letterTimes(introLayout.spans.map(s => (s.left + s.width / 2) * WORD_SCALE), from.x, introLayout.px[0] * WORD_SCALE), pushed: launchLetter(introLayout.spans.map(s => (s.left + s.width / 2) * WORD_SCALE), from.x), at: performance.now(), target: target(), flying: false, input };
    el.style.setProperty('--brand-width', `${introLayout.width}px`);
    host.dataset.brandLaunch = '';
    host.dataset.brandReady = '';
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(event, () => { endLaunch(); syncLayout(); wake(); }, { capture: true, passive: true, signal: input.signal });
    el.style.transform = `translate(${rest.x}px,${rest.y}px) scale(${WORD_SCALE})`;
    intro.letters.forEach(letter => { letter.style.opacity = '0'; });
    const p = introPose(0, 0, from, { x: introLayout.px[0] * WORD_SCALE, y: introLayout.baseline * WORD_SCALE });
    drawPanda(intro, p, p.x / WORD_SCALE, p.y / WORD_SCALE, p.scale / WORD_SCALE);
    wake();
  };
  const gate = new MutationObserver(start);
  gate.observe(root, { attributes: true, attributeFilter: ['data-ready'] });
  const resize = () => { endLaunch(); syncLayout(); wake(); };
  const observer = new ResizeObserver(() => { if (launch?.flying) endLaunch(); syncLayout(); if (!launch) wake(); });
  observer.observe(host);
  observer.observe(mark.word);
  if (host.parentElement) observer.observe(host.parentElement);
  window.addEventListener('resize', resize, { passive: true });
  document.fonts?.addEventListener('loadingdone', resize);
  const preference = () => { endLaunch(); stop(); time = staticMotion() ? 0 : SHOW_END + 8; trickAt = 0; syncLayout(); wake(); };
  motion.addEventListener('change', preference);
  forced.addEventListener('change', preference);
  document.addEventListener('visibilitychange', () => {
    stop();
    endLaunch();
    if (!document.hidden) { syncLayout(); wake(); }
  });
  host.addEventListener('click', () => {
    if (!canRun() || trickAt > 0) return;
    endLaunch();
    if (canTrick(time)) trickAt = .001;
    else { time = 0; trickAt = 0; }
    wake();
  });
  syncLayout();
  start();
}
