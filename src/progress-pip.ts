import './progress-pip.css';
import { escape, icon } from './dom';
import { IDEA, openLightbox, type Lightbox } from './progress-lightbox';
import { createDimmer } from './progress-dim';
import { legend, linkMarks, marks, type Annotation } from './progress-marks';
import { createMedia, lazyThumbs } from './progress-media';
import { flipHeight, play, settle, still } from './progress-motion';

/* Visual progress: a picture-in-picture over the conversation showing the screenshots
 * and idea sketches an agent posted, iteration by iteration. Collapsed it is a pill of
 * fanned thumbnails; expanded, a glass card with the annotated stage, a legend, a
 * filmstrip, slideshow, before/after compare and a lightbox (progress-lightbox.ts).
 * It animates by request (progress-motion.ts); everything is still under reduced motion. */

export type { Annotation, Tone } from './progress-marks';
export type Snapshot = { id: string; iteration: number; title: string; note?: string; kind: 'image' | 'idea'; annotations: Annotation[]; createdAt: number; width?: number; height?: number };
export type ProgressHost = { call<T>(command: string, args?: Record<string, unknown>): Promise<T>; notify(text: string): void };
export type ProgressPip = {
  /** The pane's thread, whether the PiP may show there, and whether its agent runs. */
  update(sessionId: string, allowed: boolean, running: boolean): void;
  /** Reload the list; ignored for another thread. */
  refresh(sessionId?: string): void;
};

type Corner = 'tl' | 'tr' | 'bl' | 'br';
type State = 'collapsed' | 'expanded';
const STORE = 'pandacode.progressPip', PLAY_MS = 2800, GAP = 12, NARROW = 1000, CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];
const glyph = (d: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const COMPARE = glyph('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 3v18"/>');
const ENLARGE = glyph('<path d="M14 4h6v6M10 20H4v-6M20 4l-6 6M4 20l6-6"/>');
const MARKS = glyph('<rect x="4" y="5" width="9" height="7" rx="1.5"/><circle cx="17" cy="16" r="3.5"/><path d="M6 19l4-4"/>');
const GRIP = '<span class="pp-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>';

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(at: number): string {
  const s = (at - Date.now()) / 1000, a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return RTF.format(Math.round(s / 60), 'minute');
  if (a < 86400) return RTF.format(Math.round(s / 3600), 'hour');
  return RTF.format(Math.round(s / 86400), 'day');
}
function readSaved(): { collapsed: boolean; corner: Corner } {
  try {
    const value = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return { collapsed: value.collapsed === true, corner: CORNERS.includes(value.corner) ? value.corner : 'tl' };
  } catch { return { collapsed: false, corner: 'tl' }; }
}
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const label = (s: Snapshot) => `Iteration ${s.iteration}: ${s.title}${s.kind === 'idea' ? ' (idea sketch)' : ''}`;
const fromHtml = (html: string): HTMLElement => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

export function mountProgressPip(root: HTMLElement, host: ProgressHost): ProgressPip {
  let saved = readSaved();
  let sessionId = '', allowed = false, snaps: Snapshot[] = [], index = 0, loadTicket = 0;
  let marksOn = true, comparing = false, split = 50, userExpanded = false, dragged = false;
  let playing = false, stepTimer = 0, stepLeft = 0, stepStarted = 0, ring: Animation | undefined, stageHover = false;
  let lightbox: Lightbox | null = null, observer: IntersectionObserver | null = null;
  let morph: { to: State; anims: Animation[] } | null = null;
  const unseen = new Set<string>();
  const media = createMedia((command, args) => host.call(command, args), () => sessionId);
  const save = (next: Partial<typeof saved>) => { saved = { ...saved, ...next }; localStorage.setItem(STORE, JSON.stringify(saved)); };
  const q = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = root) => scope.querySelector<T>(selector);
  const current = () => snaps[index];
  const total = () => snaps.length;
  const pane = () => root.parentElement;
  const wanted = (): State => saved.collapsed || ((pane()?.clientWidth ?? NARROW) < NARROW && !userExpanded) ? 'collapsed' : 'expanded';
  const state = (): State => morph?.to ?? (q('.pp-card') ? 'expanded' : 'collapsed');
  const dim = createDimmer(root, { card: () => q<HTMLElement>('.pp-card:not(.is-overlay)'), busy: () => Boolean(lightbox || morph) });

  /* ---------- placement ---------- */
  function place(): void {
    const host = pane(); if (!host) return;
    const heading = q<HTMLElement>('#task-details-heading', host), composer = q<HTMLElement>('#composer-area', host);
    const top = (heading && !heading.hidden ? heading.offsetTop + heading.offsetHeight : 0) + GAP;
    const bottom = (composer ? host.clientHeight - composer.offsetTop : 0) + GAP;
    root.style.setProperty('--pp-top', `${top}px`);
    root.style.setProperty('--pp-bottom', `${bottom}px`);
    root.style.setProperty('--pp-room', `${Math.max(150, host.clientHeight - top - bottom)}px`);
    root.dataset.corner = saved.corner;
  }
  new ResizeObserver(() => { place(); fitFrames(); }).observe(pane() ?? root);
  // A pane attribute instead of a `.conversation-pane:has(#progress-pip…)` rule: that :has made every
  // streamed Markdown insert in the pane restyle the whole pane. Watching only the PiP stays cheap.
  const markTop = () => pane()?.toggleAttribute('data-pip-top', !root.hidden && (root.dataset.corner ?? '').startsWith('t') && Boolean(q('.pp-pill:not(.is-overlay)')));
  new MutationObserver(markTop).observe(root, { attributes: true, attributeFilter: ['hidden', 'data-corner', 'class'], childList: true, subtree: true });

  /* ---------- markup ---------- */
  function pillHtml(): string {
    const last = snaps[snaps.length - 1], stack = snaps.slice(-3);
    return `<button type="button" class="pp-pill" data-pp="expand" aria-expanded="false" aria-label="Show visual progress, iteration ${last.iteration} of ${total()}: ${escape(last.title)}">${pillInner()}</button>`;
    function pillInner(): string {
      return `<span class="pp-stack">${stack.map((s, i) => `<img data-pill="${escape(s.id)}" alt="" style="--d:${stack.length - 1 - i}">`).join('')}</span>
        <span class="pp-pill-text"><strong>${escape(last.title)}</strong><small>${total()} ${total() === 1 ? 'iteration' : 'iterations'} · ${ago(last.createdAt)}</small></span>
        <span class="pp-live" aria-hidden="true"></span>`;
    }
  }
  const thumbHtml = (s: Snapshot, i: number) => `<button type="button" class="pp-thumb${s.kind === 'idea' ? ' is-idea' : ''}${unseen.has(s.id) ? ' is-new' : ''}" data-pp="thumb" data-index="${i}" aria-label="${escape(label(s))}${unseen.has(s.id) ? ', new' : ''}" tabindex="-1" style="--i:${Math.min(i, 8)}"><img data-thumb="${escape(s.id)}" alt=""><span class="pp-thumb-n" aria-hidden="true">${s.iteration}</span>${s.kind === 'idea' ? `<span class="pp-idea" aria-hidden="true">${IDEA}</span>` : ''}</button>`;
  function cardHtml(): string {
    const tool = (action: string, text: string, glyphHtml: string, extra = '') => `<button type="button" class="pp-icon" data-pp="${action}" aria-label="${text}" title="${text}" tabindex="-1"${extra}>${glyphHtml}</button>`;
    return `<section class="pp-card" aria-label="Visual progress">
      <header class="pp-head">${GRIP}<div class="pp-titles" aria-live="polite"></div>
        <button type="button" class="pp-icon pp-collapse" data-pp="collapse" aria-expanded="true" aria-label="Collapse visual progress" title="Collapse (Esc)">${icon('minimize')}</button></header>
      <figure class="pp-stage"><div class="pp-stage-error" hidden></div><input class="pp-split" type="range" min="0" max="100" value="${split}" hidden></figure>
      <div class="pp-legend-host"></div>
      <p class="pp-note"></p>
      <div class="pp-strip" role="group" aria-label="Iterations"><div class="pp-strip-inner"><span class="pp-rail" aria-hidden="true"><span class="pp-rail-fill"></span></span>${snaps.map(thumbHtml).join('')}</div></div>
      <div class="pp-bar" role="toolbar" aria-label="Progress controls">
        ${tool('prev', 'Previous iteration', icon('back'))}<button type="button" class="pp-icon pp-play" data-pp="play" aria-label="Play iterations" title="Play iterations" aria-pressed="false" tabindex="-1"><svg class="pp-ring" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12.5" pathLength="1"/></svg><span class="pp-play-icon">${icon('play')}</span></button>${tool('next', 'Next iteration', icon('forward'))}
        <span class="pp-bar-gap"></span>
        ${tool('marks', 'Show annotations', MARKS, ' aria-pressed="true"')}${tool('compare', 'Compare with the previous iteration', COMPARE, ' aria-pressed="false"')}${tool('enlarge', 'Open large view', ENLARGE)}${tool('clear', 'Clear visual history', icon('trash'))}
      </div>
      <div class="pp-confirm" role="alertdialog" aria-label="Clear visual history" hidden><span></span><button type="button" class="pp-text-button" data-pp="clear-no">Cancel</button><button type="button" class="pp-text-button is-danger" data-pp="clear-yes">Clear</button></div>
    </section>`;
  }
  function fillPill(scope: ParentNode): void {
    for (const img of scope.querySelectorAll<HTMLImageElement>('img[data-pill]')) media.thumb(img.dataset.pill!).then(url => { img.src = url; }, () => img.classList.add('is-broken'));
  }
  function watchStrip(): void {
    observer?.disconnect();
    const strip = q('.pp-strip');
    observer = strip ? lazyThumbs(strip, media.thumb) : null;
  }
  function buildCard(): HTMLElement {
    const card = fromHtml(cardHtml());
    root.append(card);
    watchStrip();
    const tools = [...card.querySelectorAll<HTMLElement>('.pp-bar .pp-icon')];
    tools[0].tabIndex = 0;
    linkMarks(card);
    // The slideshow holds while the pointer rests on the image.
    const stage = q<HTMLElement>('.pp-stage', card)!;
    stage.addEventListener('pointerenter', () => { stageHover = true; hold(); });
    stage.addEventListener('pointerleave', () => { stageHover = false; resume(); });
    sync(0, true);
    return card;
  }
  function buildPill(): HTMLElement {
    const pill = fromHtml(pillHtml());
    root.append(pill);
    fillPill(pill);
    return pill;
  }

  /* ---------- rendering ---------- */
  /** Drop the strip observer and every cached image (thread switch, hide, clear). */
  function release(): void { observer?.disconnect(); observer = null; media.reset(); stageHover = false; }
  function render(fresh = false): void {
    root.hidden = !(allowed && snaps.length);
    morph?.anims.forEach(a => a.cancel()); morph = null;
    root.replaceChildren();
    if (root.hidden) { stopPlay(); lightbox?.close(); release(); dim.apply(); return; }
    place();
    if (wanted() === 'collapsed') buildPill(); else buildCard();
    // A thread's PiP arrives softly rather than popping in.
    if (fresh) play(root, [{ opacity: 0 }, { opacity: 1 }], 160, { easing: 'ease-out' });
    dim.apply();
  }
  /** Header, legend, note, filmstrip and controls for the current index; repaints the stage. */
  function sync(direction: number, fresh = false): void {
    const s = current(), card = q<HTMLElement>('.pp-card'); if (!s || !card) return;
    const before = card.offsetHeight;
    q('.pp-titles', card)!.innerHTML = `<h3 class="pp-title" title="${escape(s.title)}"><span>${escape(s.title)}</span><span class="pp-live" aria-hidden="true"></span></h3><p class="pp-meta">${s.kind === 'idea' ? `<span class="pp-tag">${IDEA}Idea</span>` : ''}<span>Iteration ${s.iteration} of ${total()}</span><span aria-hidden="true">·</span><time datetime="${new Date(s.createdAt).toISOString()}">${ago(s.createdAt)}</time></p>`;
    q('.pp-legend-host', card)!.innerHTML = marksOn && !comparing ? legend(s.annotations) : '';
    const note = q('.pp-note', card)!; note.textContent = s.note ?? ''; note.hidden = !s.note; note.title = s.note ?? '';
    card.querySelectorAll<HTMLElement>('.pp-thumb').forEach((thumb, i) => {
      const on = i === index;
      thumb.tabIndex = on ? 0 : -1;
      if (!on) { thumb.removeAttribute('aria-current'); return; }
      thumb.setAttribute('aria-current', 'step');
      thumb.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: still() || fresh ? 'auto' : 'smooth' });
      if (unseen.delete(snaps[i].id)) { thumb.classList.remove('is-new'); thumb.setAttribute('aria-label', label(snaps[i])); }
    });
    rail();
    const set = (action: string, disabled: boolean) => { const b = q<HTMLButtonElement>(`[data-pp="${action}"]`, card); if (b) b.disabled = disabled; };
    set('prev', index === 0); set('next', index === total() - 1); set('compare', index === 0); set('play', total() < 2);
    if (index === 0 && comparing) setComparing(false);
    const stage = q<HTMLElement>('.pp-stage', card)!;
    void paint(stage, direction, false).then(changed => { if (!fresh && (changed || direction === 0)) flipHeight(card, before); });
    lightbox?.update(direction);
  }
  function rail(): void {
    const fill = q<HTMLElement>('.pp-rail-fill'), thumb = root.querySelectorAll<HTMLElement>('.pp-strip .pp-thumb')[index];
    if (!fill || !thumb) return;
    const before = fill.style.width, width = `${thumb.offsetLeft + thumb.offsetWidth / 2}px`;
    fill.style.width = width;
    if (before && before !== width) play(fill, [{ width: before }, { width }], 420);
  }

  /** Size every frame to its image's aspect inside its stage. */
  function fitFrames(scope: ParentNode = document): void {
    for (const frame of scope.querySelectorAll<HTMLElement>('.progress-pip .pp-frame, .pp-lightbox .pp-frame')) {
      const stage = frame.closest<HTMLElement>('.pp-stage'), aspect = Number(frame.dataset.aspect);
      if (!stage || !aspect) continue;
      const width = Math.min(stage.clientWidth, stage.clientHeight * aspect);
      frame.style.width = `${width}px`; frame.style.height = `${width / aspect}px`;
    }
  }
  /** Draw the current snapshot into a stage, crossfading from what it showed. Resolves true if it changed. */
  async function paint(stage: HTMLElement, direction: number, large: boolean): Promise<boolean> {
    const s = current(), previous = snaps[index - 1], compare = comparing && Boolean(previous) && !large;
    const key = `${s.id}|${compare ? previous.id : ''}|${marksOn}`;
    if (stage.dataset.key === key) return false;
    stage.dataset.key = key;
    const ticket = String(Number(stage.dataset.ticket ?? 0) + 1); stage.dataset.ticket = ticket;
    const error = q<HTMLElement>('.pp-stage-error', stage)!;
    let url: string, before = '', aspect: number;
    try { [url, before] = await Promise.all([media.full(s.id), compare ? media.full(previous.id) : '']); aspect = await media.aspect(s, url); }
    catch (e) { if (stage.dataset.ticket === ticket) { error.hidden = false; error.textContent = `Could not show this snapshot. ${failure(e)}`; stage.dataset.key = ''; } return false; }
    if (stage.dataset.ticket !== ticket || !stage.isConnected) return false;
    error.hidden = true;
    const box = large ? aspect : Math.max(aspect, 1.3);
    stage.style.aspectRatio = String(box);
    stage.style.setProperty('--stage-aspect', String(box));
    const width = Math.min(stage.clientWidth, stage.clientHeight * aspect);
    const layer = document.createElement('div');
    layer.className = 'pp-layer';
    // A letterboxed (portrait) image sits on a blurred, dimmed copy of itself.
    const band = !large && aspect < box - 0.05 ? `<img class="pp-band" src="${escape(url)}" alt="" aria-hidden="true">` : '';
    layer.innerHTML = `${band}<div class="pp-frame" data-aspect="${aspect}" style="width:${width}px;height:${width / aspect}px">
      ${compare ? `<img class="pp-before" src="${escape(before)}" alt="${escape(label(previous))}"><span class="pp-tag pp-tag-before" aria-hidden="true">Before · ${previous.iteration}</span>` : ''}
      <img class="pp-media" src="${escape(url)}" alt="${escape(label(s))}"${compare ? ` style="clip-path:inset(0 0 0 ${split}%)"` : ''}>
      ${compare ? `<span class="pp-divider" style="left:${split}%" aria-hidden="true"></span><span class="pp-tag pp-tag-after" aria-hidden="true">After · ${s.iteration}</span>` : marksOn ? marks(s.annotations, aspect, width) : ''}
    </div>`;
    // Rapid stepping keeps at most the outgoing layer and the new one.
    stage.querySelectorAll(':scope > .pp-layer.is-leaving').forEach(old => old.remove());
    const old = q<HTMLElement>(':scope > .pp-layer', stage);
    stage.insertBefore(layer, q('.pp-split', stage));
    const range = q<HTMLInputElement>('.pp-split', stage);
    if (range) { range.hidden = !compare; range.value = String(split); range.setAttribute('aria-label', compare ? `Compare iteration ${previous.iteration} with ${s.iteration}` : 'Compare'); }
    if (!old) return true;
    if (still()) { old.remove(); return true; }
    const shift = direction * 14, from = Number(getComputedStyle(old).opacity);
    settle(old); old.classList.add('is-leaving');
    play(old, [{ opacity: from }, { opacity: 0, transform: `translateX(${-shift}px) scale(${direction ? 0.985 : 1})`, filter: `blur(${direction ? 6 : 0}px)` }], direction ? 360 : 220, { fill: 'forwards' })?.finished.then(() => old.remove(), () => undefined);
    play(layer, [{ opacity: 0, transform: `translateX(${shift}px) scale(${direction ? 1.015 : 1})`, filter: `blur(${direction ? 6 : 0}px)` }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], direction ? 440 : 260);
    return true;
  }

  /* ---------- navigation and slideshow ---------- */
  function go(next: number, focus = false): void {
    const target = Math.max(0, Math.min(total() - 1, next));
    if (target === index) return;
    const direction = Math.sign(target - index);
    index = target;
    sync(direction);
    if (focus) root.querySelectorAll<HTMLElement>('.pp-strip .pp-thumb')[index]?.focus();
  }
  const playButton = () => q<HTMLButtonElement>('[data-pp="play"]');
  function setPlayButton(on: boolean): void {
    const b = playButton(); if (!b) return;
    b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Pause' : 'Play iterations'); b.title = on ? 'Pause' : 'Play iterations';
    q('.pp-play-icon', b)!.innerHTML = icon(on ? 'pause' : 'play');
  }
  function stopPlay(): void { playing = false; clearTimeout(stepTimer); stepTimer = 0; ring?.cancel(); ring = undefined; setPlayButton(false); }
  /** One slide: PLAY_MS on the clock, drawn by the ring around Play. */
  function step(): void {
    ring?.cancel();
    const circle = q('.pp-ring circle');
    ring = circle ? play(circle, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], PLAY_MS, { easing: 'linear', fill: 'forwards' }) : undefined;
    stepLeft = PLAY_MS;
    resume();
  }
  /** Run the rest of the current slide, unless the pointer rests on the image. */
  function resume(): void {
    clearTimeout(stepTimer); stepTimer = 0;
    if (!playing) return;
    if (stageHover) { ring?.pause(); return; }
    ring?.play();
    stepStarted = performance.now();
    stepTimer = window.setTimeout(advance, stepLeft);
  }
  /** Freeze the slide where it is; the ring stays visible, paused. */
  function hold(): void {
    if (!playing) return;
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = 0; stepLeft = Math.max(0, stepLeft - (performance.now() - stepStarted)); }
    ring?.pause();
  }
  function advance(): void {
    stepTimer = 0;
    if (index >= total() - 1) stopPlay(); else { go(index + 1); step(); }
  }
  function startPlay(): void {
    if (total() < 2) return;
    if (index === total() - 1) go(0);
    playing = true; setPlayButton(true); step();
  }
  function setComparing(on: boolean): void {
    comparing = on;
    q('[data-pp="compare"]')?.setAttribute('aria-pressed', String(on));
    root.classList.toggle('is-comparing', on);
  }

  /* ---------- collapse / expand: interruptible clip morph between pill and card ---------- */
  function clipFor(pill: DOMRect, card: DOMRect): string {
    const dx = Math.max(0, card.width - pill.width), dy = Math.max(0, card.height - pill.height), c = saved.corner;
    return `inset(${c[0] === 't' ? 0 : dy}px ${c[1] === 'l' ? dx : 0}px ${c[0] === 't' ? dy : 0}px ${c[1] === 'l' ? 0 : dx}px round 24px)`;
  }
  function transition(to: State): void {
    if (state() === to) return;
    const card = q<HTMLElement>('.pp-card') ?? buildCard(), pill = q<HTMLElement>('.pp-pill') ?? buildPill();
    const hadFocus = root.contains(document.activeElement);
    // Interrupted mid-way: start from where the running animations have things now.
    const was = morph ? { clip: getComputedStyle(card).clipPath, card: getComputedStyle(card).opacity, pill: getComputedStyle(pill).opacity } : null;
    morph?.anims.forEach(a => a.cancel());
    card.classList.toggle('is-overlay', to === 'collapsed'); pill.classList.toggle('is-overlay', to === 'expanded');
    if (to === 'expanded') root.prepend(card); else root.prepend(pill);
    const full = 'inset(0px 0px 0px 0px round 16px)', small = clipFor(pill.getBoundingClientRect(), card.getBoundingClientRect());
    const anims = (to === 'expanded' ? [
      play(card, [{ clipPath: was?.clip ?? small, opacity: was?.card ?? 1 }, { clipPath: full, opacity: 1 }], 460, { fill: 'both' }),
      play(pill, [{ opacity: was?.pill ?? 1 }, { opacity: 0 }], 180, { fill: 'forwards' }),
      ...(was ? [] : [...card.children].map((child, i) => play(child, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 340, { delay: 100 + Math.min(i, 8) * 40 }))),
    ] : [
      play(card, [{ clipPath: was?.clip ?? full, opacity: was?.card ?? 1 }, { clipPath: small, opacity: 0 }], 340, { fill: 'forwards', easing: 'cubic-bezier(.4,0,.2,1)' }),
      play(pill, [{ opacity: was?.pill ?? 0, scale: '.94' }, { opacity: 1, scale: '1' }], 300, { delay: was ? 0 : 110, fill: 'both' }),
    ]).filter((a): a is Animation => Boolean(a));
    const current = { to, anims };
    morph = current;
    if (to === 'collapsed' && hadFocus) pill.focus({ preventScroll: true });
    const done = () => {
      if (morph !== current) return;
      morph = null;
      anims.forEach(a => a.cancel());
      if (to === 'expanded') { pill.remove(); card.classList.remove('is-overlay'); if (hadFocus || !still()) q<HTMLElement>('[data-pp="collapse"]')?.focus({ preventScroll: true }); }
      else { card.remove(); observer?.disconnect(); observer = null; pill.classList.remove('is-overlay'); stageHover = false; }
      dim.apply();
    };
    if (!anims.length) done(); else Promise.all(anims.map(a => a.finished)).then(done, () => undefined);
  }
  function expand(): void { userExpanded = true; save({ collapsed: false }); transition('expanded'); }
  function collapse(): void { stopPlay(); save({ collapsed: true }); transition('collapsed'); }
  function arrive(): void {
    const pill = q('.pp-pill');
    if (pill) play(pill, [{ scale: '1', boxShadow: '0 0 0 0 rgb(var(--accent-rgb) / .5)' }, { scale: '1.04', boxShadow: '0 0 0 8px rgb(var(--accent-rgb) / .18)', offset: 0.35 }, { scale: '1', boxShadow: '0 0 0 14px rgb(var(--accent-rgb) / 0)' }], 900);
    const newest = q('.pp-stack img:last-child');
    if (newest) play(newest, [{ opacity: 0, transform: 'translateY(-6px) scale(.8)' }, { opacity: 1, transform: 'none' }], 420);
  }

  /* ---------- lightbox ---------- */
  function openLarge(fromPointer: boolean): void {
    if (lightbox) return;
    stopPlay();
    lightbox = openLightbox({
      snaps: () => snaps, index: () => index, go: i => go(i), thumb: media.thumb, ago, fromPointer,
      paint: (stage, direction) => void paint(stage, direction, true),
      closed: () => { lightbox = null; q<HTMLElement>('[data-pp="enlarge"]')?.focus({ preventScroll: true }); dim.apply(); },
    });
  }

  /* ---------- clear ---------- */
  function confirmClear(on: boolean): void {
    const confirm = q<HTMLElement>('.pp-confirm'), bar = q<HTMLElement>('.pp-bar'); if (!confirm || !bar) return;
    confirm.hidden = !on; bar.hidden = on;
    if (on) { stopPlay(); q('span', confirm)!.textContent = `Clear ${total() === 1 ? 'this snapshot' : `all ${total()} iterations`} from this thread?`; play(confirm, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 260); q<HTMLElement>('[data-pp="clear-no"]')?.focus(); }
    else q<HTMLElement>('[data-pp="clear"]')?.focus();
  }
  async function clear(): Promise<void> {
    const id = sessionId;
    try { await host.call('progress_clear', { sessionId: id }); }
    catch (error) { host.notify(`Could not clear visual progress. ${failure(error)}`); return; }
    if (id !== sessionId) return;
    snaps = []; index = 0; render();
    document.querySelector<HTMLElement>('#prompt')?.focus();
  }

  /* ---------- events ---------- */
  root.addEventListener('click', event => {
    if (dragged) { dragged = false; event.preventDefault(); return; }
    const button = (event.target as Element).closest<HTMLElement>('[data-pp]');
    switch (button?.dataset.pp) {
      case 'expand': expand(); break;
      case 'collapse': collapse(); break;
      case 'prev': stopPlay(); go(index - 1); break;
      case 'next': stopPlay(); go(index + 1); break;
      case 'thumb': stopPlay(); go(Number(button.dataset.index)); break;
      case 'play': if (playing) stopPlay(); else startPlay(); break;
      case 'marks': marksOn = !marksOn; button.setAttribute('aria-pressed', String(marksOn)); sync(0); break;
      case 'compare': setComparing(!comparing); sync(0); break;
      case 'enlarge': openLarge(event.detail > 0); break;
      case 'clear': confirmClear(true); break;
      case 'clear-no': confirmClear(false); break;
      case 'clear-yes': void clear(); break;
    }
  });
  root.addEventListener('keydown', event => {
    const target = event.target as Element;
    if (event.key === 'Escape') {
      // Esc is the PiP's only when it closes something here; otherwise it stays the app's
      // (which stops a running agent).
      const confirm = q<HTMLElement>('.pp-confirm');
      if (confirm && !confirm.hidden) { event.preventDefault(); confirmClear(false); }
      else if (state() === 'expanded') { event.preventDefault(); collapse(); }
      return;
    }
    const steps = (list: HTMLElement[], at: number): number | undefined => ({ ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: list.length - 1 } as Record<string, number>)[event.key];
    if (target.closest('.pp-thumb')) {
      const to = steps([...root.querySelectorAll<HTMLElement>('.pp-strip .pp-thumb')], index);
      if (to !== undefined) { event.preventDefault(); stopPlay(); go(to, true); }
    } else if (target.closest('.pp-bar')) {
      const tools = [...root.querySelectorAll<HTMLButtonElement>('.pp-bar .pp-icon')].filter(b => !b.disabled);
      const to = steps(tools, tools.indexOf(target as HTMLButtonElement));
      if (to === undefined) return;
      event.preventDefault();
      const next = tools[Math.max(0, Math.min(tools.length - 1, to))];
      root.querySelectorAll<HTMLElement>('.pp-bar .pp-icon').forEach(b => { b.tabIndex = b === next ? 0 : -1; });
      next.focus();
    }
  });
  root.addEventListener('focusin', event => {
    const tool = (event.target as Element).closest<HTMLElement>('.pp-bar .pp-icon');
    if (tool) root.querySelectorAll<HTMLElement>('.pp-bar .pp-icon').forEach(b => { b.tabIndex = b === tool ? 0 : -1; });
  });
  root.addEventListener('input', event => {
    const range = event.target as HTMLInputElement;
    if (!range.classList.contains('pp-split')) return;
    split = Number(range.value);
    const layer = range.parentElement?.querySelector<HTMLElement>('.pp-layer:not(.is-leaving)');
    q<HTMLElement>('.pp-media', layer ?? root)?.style.setProperty('clip-path', `inset(0 0 0 ${split}%)`);
    q<HTMLElement>('.pp-divider', layer ?? root)?.style.setProperty('left', `${split}%`);
  });
  // Drag the header or pill to any corner; the corner is chosen from where it is heading.
  root.addEventListener('pointerdown', event => {
    const handle = (event.target as Element).closest<HTMLElement>('.pp-head, .pp-pill');
    if (!handle || morph || event.button !== 0 || ((event.target as Element).closest('button') && !handle.matches('.pp-pill'))) return;
    settle(root);
    root.style.translate = '';
    const startX = event.clientX, startY = event.clientY;
    let moving = false, last = { x: startX, y: startY, t: event.timeStamp }, velocity = { x: 0, y: 0 };
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moving && Math.hypot(dx, dy) < 6) return;
      if (!moving) { moving = true; handle.setPointerCapture(e.pointerId); root.classList.add('is-dragging'); stopPlay(); }
      const dt = Math.max(1, e.timeStamp - last.t);
      velocity = { x: (e.clientX - last.x) / dt, y: (e.clientY - last.y) / dt };
      last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      root.style.translate = `${dx}px ${dy}px`;
    };
    const up = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      if (!moving) return;
      dragged = true; setTimeout(() => { dragged = false; }, 0);
      const area = pane()!.getBoundingClientRect(), first = root.getBoundingClientRect();
      const cx = first.left + first.width / 2 + velocity.x * 150, cy = first.top + first.height / 2 + velocity.y * 150;
      save({ corner: `${cy > area.top + area.height / 2 ? 'b' : 't'}${cx > area.left + area.width / 2 ? 'r' : 'l'}` as Corner });
      root.classList.remove('is-dragging'); root.style.translate = ''; place();
      const end = root.getBoundingClientRect();
      if (e.type === 'pointerup') play(root, [{ translate: `${first.left - end.left}px ${first.top - end.top}px` }, { translate: '0px 0px' }], 420);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });

  /* ---------- data ---------- */
  async function reload(): Promise<void> {
    const ticket = ++loadTicket, id = sessionId;
    let list: Snapshot[];
    try { list = await host.call<Snapshot[]>('progress_list', { sessionId: id }); }
    catch (error) { console.warn('progress_list failed', error); return; }
    if (ticket !== loadTicket || id !== sessionId) return;
    const valid = (Array.isArray(list) ? list : []).filter(s => s && typeof s.id === 'string' && Number.isFinite(s.iteration))
      .map(s => ({ ...s, title: String(s.title ?? `Iteration ${s.iteration}`), annotations: Array.isArray(s.annotations) ? s.annotations : [] }))
      .sort((a, b) => a.iteration - b.iteration || a.createdAt - b.createdAt);
    const old = snaps, first = !old.length, atLatest = index >= old.length - 1, viewing = current()?.id;
    const appended = !first && valid.length > old.length && old.every((s, i) => valid[i].id === s.id);
    snaps = valid;
    const kept = snaps.findIndex(s => s.id === viewing);
    index = first || kept < 0 ? snaps.length - 1 : kept;
    if (!appended || root.hidden || morph) { render(first); return; }
    const added = snaps.slice(old.length);
    const pill = q<HTMLElement>('.pp-pill');
    if (pill) { const focused = pill === document.activeElement, next = buildPill(); pill.replaceWith(next); if (focused) next.focus({ preventScroll: true }); arrive(); return; }
    // Expanded: append the new thumbnails in place; follow the newest only when already there.
    if (!atLatest) added.forEach(s => unseen.add(s.id));
    const inner = q('.pp-strip-inner');
    if (inner) {
      inner.insertAdjacentHTML('beforeend', added.map((s, i) => thumbHtml(s, old.length + i)).join(''));
      for (const img of inner.querySelectorAll('img[data-thumb]:not([src])')) observer?.observe(img);
      [...inner.querySelectorAll<HTMLElement>('.pp-thumb')].slice(old.length).forEach(t => play(t, [{ opacity: 0, transform: 'translateX(12px) scale(.85)' }, { opacity: 1, transform: 'none' }], 420));
    }
    if (atLatest) { index = snaps.length - 1; sync(1); } else sync(0);
    dim.wake();
  }

  return {
    update(id, show, running) {
      root.classList.toggle('is-running', running);
      const changed = id !== sessionId;
      if (!changed && show === allowed) return;
      allowed = show;
      if (changed) {
        sessionId = id; snaps = []; index = 0; unseen.clear(); stopPlay(); setComparing(false); lightbox?.close(); release();
        morph?.anims.forEach(a => a.cancel()); morph = null;
        root.hidden = true; root.replaceChildren(); dim.apply();
        if (id) void reload();
        return;
      }
      render();
    },
    refresh(id) { if (sessionId && (!id || id === sessionId)) void reload(); },
  };
}
