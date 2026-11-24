import { escape } from './dom';
import { measureTokenPx } from './css-metrics';

/* Annotation overlay for a visual-progress snapshot: SVG strokes (boxes, ellipses,
 * arrows, numbered pins, a spotlight cut out around highlights). Each labelled mark gets a
 * small numbered badge and the labels sit in a numbered legend. Hovering or focusing a
 * legend row (or hovering a mark) lights that mark and shows its label in a chip kept
 * inside the stage; the other marks recede. Every coordinate is 0..1 of the image. Box, circle and
 * highlight are rectangles from their top-left (a circle is the ellipse inside it; without
 * w/h it is centred on x,y); an arrow runs x,y → x2,y2; a pin is a point. */

export type Tone = 'accent' | 'info' | 'success' | 'warning' | 'danger';
/** Every annotation type `marks()` draws as one `.pp-mark` group, in one list `rescaleMarks()` walks too. */
export const MARK_TYPES = ['box', 'circle', 'highlight', 'arrow', 'pin'] as const;
export type MarkType = typeof MARK_TYPES[number];
export type Annotation = { type: MarkType; x: number; y: number; w?: number; h?: number; x2?: number; y2?: number; label?: string; tone?: Tone };

/** The native side refuses longer labels. */
export const MAX_LABEL = 160;
const TONES = new Set<string>(['accent', 'info', 'success', 'warning', 'danger']);
const W = 1000;
let masks = 0;
const unit = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const n = (value: number): string => value.toFixed(1);
const pct = (value: number, of: number): string => `${n(value / of * 100)}%`;
export const toneOf = (a: Annotation): Tone => TONES.has(a.tone ?? '') ? a.tone! : 'accent';
export const labelOf = (a: Annotation): string => typeof a.label === 'string' ? [...a.label.trim()].slice(0, MAX_LABEL).join('') : '';

/** The number each mark shows: labelled marks and pins, in order; 0 for the rest. */
export function numbering(list: Annotation[]): number[] {
  let count = 0;
  return list.map(a => labelOf(a) || a.type === 'pin' ? ++count : 0);
}

/** Overlay markup for an image of `aspect` (width / height) drawn `width` CSS pixels wide. */
type Metrics = { s: number; stroke: string; thin: string; radius: string; pinR: number; pinFont: string };
/** Stroke widths and radii in viewBox units for an image drawn `width` CSS pixels wide. */
function markMetrics(width: number, host?: HTMLElement | null): Metrics {
  const pinSize = measureTokenPx('--type-caption', 11, host);
  const boxRadius = measureTokenPx('--ds-control-radius', 8, host);
  const s = W / Math.max(width, 1);
  return { s, stroke: n(2 * s), thin: n(1.5 * s), radius: n(boxRadius * s), pinR: (pinSize * 10 / 11) * s, pinFont: n(pinSize * s) };
}
/** Arrowhead triangle at x2,y2 for a shaft from x,y, `11 * s` long. */
function arrowPoints(x: number, y: number, x2: number, y2: number, s: number): string {
  const angle = Math.atan2(y2 - y, x2 - x), head = 11 * s;
  const point = (turn: number) => `${n(x2 - head * Math.cos(angle + turn))},${n(y2 - head * Math.sin(angle + turn))}`;
  return `${n(x2)},${n(y2)} ${point(0.42)} ${point(-0.42)}`;
}
const DRAWN: ReadonlySet<string> = new Set(MARK_TYPES);
/** True for a type that renders a `.pp-mark` group; payloads from disk may carry unknown types. */
const isDrawn = (type: unknown): type is MarkType => typeof type === 'string' && DRAWN.has(type);

export function marks(list: Annotation[], aspect: number, width: number, host?: HTMLElement | null): string {
  const m = markMetrics(width, host), { s, stroke } = m;
  const H = W / aspect, mask = `pp-spot-${++masks}`, numbers = numbering(list);
  const shapes: string[] = [], holes: string[] = [], tags: string[] = [];
  list.forEach((a, i) => {
    const tone = toneOf(a), number = numbers[i], text = labelOf(a);
    const x = unit(a.x) * W, y = unit(a.y) * H, w = unit(a.w) * W, h = unit(a.h) * H;
    // Badge point (top-left of the shape) and chip anchor with the side it sits on.
    let bx = x, by = y, ax = x, ay = y, side = 'above';
    const below = (bottom: number) => { if (y < H * 0.12) { ay = bottom; side = 'below'; } };
    if (!isDrawn(a.type)) return;
    let body = '';
    switch (a.type) {
      case 'box':
        body = `<rect class="pp-stroke" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${m.radius}" pathLength="1" stroke-width="${stroke}"/>`;
        below(y + h); break;
      case 'circle': {
        const rx = w / 2 || 50, ry = h / 2 || 50, cx = w ? x + rx : x, cy = h ? y + ry : y;
        body = `<ellipse class="pp-stroke" cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" pathLength="1" stroke-width="${stroke}"/>`;
        bx = cx - rx * 0.7; by = cy - ry * 0.7; ax = cx - rx; ay = cy - ry;
        if (ay < H * 0.12) { ay = cy + ry; side = 'below'; } break;
      }
      case 'highlight':
        holes.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${m.radius}" fill="black"/>`);
        body = `<rect class="pp-stroke pp-glow" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${m.radius}" pathLength="1" stroke-width="${m.thin}"/>`;
        below(y + h); break;
      case 'arrow': {
        const x2 = unit(a.x2) * W, y2 = unit(a.y2) * H;
        body = `<line class="pp-stroke" x1="${n(x)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y2)}" pathLength="1" stroke-width="${stroke}"/><polygon class="pp-arrowhead" points="${arrowPoints(x, y, x2, y2, s)}"/>`;
        if (y2 < y || y < H * 0.12) side = 'below'; break;
      }
      case 'pin': {
        const r = m.pinR;
        body = `<circle class="pp-pin" cx="${n(x)}" cy="${n(y)}" r="${n(r)}" stroke-width="${m.thin}"/><text class="pp-pin-n" x="${n(x)}" y="${n(y)}" font-size="${m.pinFont}" text-anchor="middle" dominant-baseline="central">${number}</text>`;
        ax = x + r * 1.4; side = 'right'; break;
      }
      default: { const unhandled: never = a.type; return unhandled; }
    }
    const order = `--i:${Math.min(i, 8)}`;
    const link = number ? ` data-n="${number}"` : '';
    shapes.push(`<g class="pp-mark" data-tone="${tone}"${link} style="${order}">${body}</g>`);
    if (number && a.type !== 'pin') tags.push(`<span class="pp-badge" data-tone="${tone}"${link} style="left:clamp(9px,${pct(bx, W)},calc(100% - 9px));top:clamp(9px,${pct(by, H)},calc(100% - 9px));${order}">${number}</span>`);
    if (!text) return;
    const end = ax > W * 0.62 && side !== 'right';
    if (end) ax = a.type === 'arrow' ? x : Math.min(W, x + w);
    tags.push(`<span class="pp-chip" data-tone="${tone}"${link} data-side="${side}"${end ? ' data-end' : ''} style="left:${pct(ax, W)};top:${pct(ay, H)}"><i></i>${escape(text)}</span>`);
  });
  const spot = holes.length ? `<mask id="${mask}"><rect width="${W}" height="${n(H)}" fill="white"/>${holes.join('')}</mask><rect class="pp-spot" width="${W}" height="${n(H)}" mask="url(#${mask})"/>` : '';
  return `<svg class="pp-marks" viewBox="0 0 ${W} ${n(H)}" aria-hidden="true">${spot}${shapes.join('')}</svg><div class="pp-tags" aria-hidden="true">${tags.join('')}</div>`;
}

/** Re-fit the stroke widths, corner radii, pin sizes and arrowheads of a frame's live overlay
 * after its image is redrawn `width` CSS pixels wide, in place: no new SVG, no replayed entrance,
 * and the lit mark keeps its `.is-on` state. */
export function rescaleMarks(frame: HTMLElement, list: Annotation[], aspect: number, width: number, host?: HTMLElement | null): void {
  const svg = frame.querySelector<SVGSVGElement>('.pp-marks');
  if (!svg || !aspect) return;
  const m = markMetrics(width, host), H = W / aspect, numbers = numbering(list);
  svg.querySelectorAll('mask > rect:not(:first-child)').forEach(hole => hole.setAttribute('rx', m.radius));
  const groups = svg.querySelectorAll<SVGGElement>(':scope > .pp-mark');
  let g = 0;
  list.forEach((a, i) => {
    if (!isDrawn(a.type)) return;
    const group = groups[g++];
    if (!group) return;
    const set = (selector: string, attrs: Record<string, string>) => {
      const el = group.querySelector(selector);
      if (el) for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    };
    const x = unit(a.x) * W, y = unit(a.y) * H;
    switch (a.type) {
      case 'box': set('rect.pp-stroke', { rx: m.radius, 'stroke-width': m.stroke }); break;
      case 'circle': set('ellipse.pp-stroke', { 'stroke-width': m.stroke }); break;
      case 'highlight': set('rect.pp-stroke', { rx: m.radius, 'stroke-width': m.thin }); break;
      case 'arrow':
        set('line.pp-stroke', { 'stroke-width': m.stroke });
        set('polygon.pp-arrowhead', { points: arrowPoints(x, y, unit(a.x2) * W, unit(a.y2) * H, m.s) });
        break;
      case 'pin': {
        set('circle.pp-pin', { r: n(m.pinR), 'stroke-width': m.thin });
        set('text.pp-pin-n', { 'font-size': m.pinFont });
        const chip = frame.querySelector<HTMLElement>(`.pp-tags .pp-chip[data-n="${numbers[i]}"]`);
        if (chip) chip.style.left = pct(x + m.pinR * 1.4, W);
        break;
      }
      default: { const unhandled: never = a.type; return unhandled; }
    }
  });
}

/** Numbered list of the labels: tone-coloured number, then the text (full in a tooltip). */
export function legend(list: Annotation[]): string {
  const numbers = numbering(list);
  const items = list.map((a, i) => {
    const text = labelOf(a);
    return numbers[i] && text ? `<li data-tone="${toneOf(a)}" data-n="${numbers[i]}" tabindex="0" title="${escape(text)}"><span class="pp-num" aria-hidden="true">${numbers[i]}</span><span class="pp-legend-text">${escape(text)}</span></li>` : '';
  }).join('');
  return items ? `<ol class="pp-legend" aria-label="Annotations">${items}</ol>` : '';
}

/** Link legend rows and marks inside `container` (a card or the lightbox plate). */
export function linkMarks(container: HTMLElement): void {
  let on = '';
  const show = (n: string) => {
    if (n === on) return;
    on = n;
    container.querySelectorAll('.is-on[data-n]').forEach(el => el.classList.remove('is-on'));
    container.classList.toggle('has-mark-focus', Boolean(n));
    if (!n) return;
    const scope = `[data-n="${CSS.escape(n)}"]`;
    container.querySelectorAll(`.pp-layer:not(.is-leaving) ${scope}, .pp-legend ${scope}`).forEach(el => el.classList.add('is-on'));
    const chip = container.querySelector<HTMLElement>(`.pp-layer:not(.is-leaving) .pp-chip${scope}`);
    if (chip) keepInside(chip);
  };
  const from = (target: EventTarget | null) => (target as Element | null)?.closest?.('[data-n]')?.getAttribute('data-n') ?? '';
  container.addEventListener('pointerover', event => show(from(event.target)));
  container.addEventListener('pointerleave', () => show(''));
  container.addEventListener('focusin', event => show(from(event.target)));
  container.addEventListener('focusout', () => show(''));
}
/** Nudge a label chip so it stays inside its stage. */
function keepInside(chip: HTMLElement): void {
  chip.style.removeProperty('--dx'); chip.style.removeProperty('--dy');
  const stage = chip.closest('.pp-stage')?.getBoundingClientRect(), box = chip.getBoundingClientRect(), pad = 6;
  if (!stage) return;
  const dx = box.left < stage.left + pad ? stage.left + pad - box.left : box.right > stage.right - pad ? stage.right - pad - box.right : 0;
  const dy = box.top < stage.top + pad ? stage.top + pad - box.top : box.bottom > stage.bottom - pad ? stage.bottom - pad - box.bottom : 0;
  chip.style.setProperty('--dx', `${Math.round(dx)}px`); chip.style.setProperty('--dy', `${Math.round(dy)}px`);
}
