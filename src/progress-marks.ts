import { escape } from './dom';

/* Annotation overlay for a visual-progress snapshot: SVG strokes (boxes, ellipses,
 * arrows, numbered pins, a spotlight cut out around highlights). Each labelled mark gets a
 * small numbered badge and the labels sit in a numbered legend. Hovering or focusing a
 * legend row (or hovering a mark) lights that mark and shows its label in a chip kept
 * inside the stage; the other marks recede. Every coordinate is 0..1 of the image. Box, circle and
 * highlight are rectangles from their top-left (a circle is the ellipse inside it; without
 * w/h it is centred on x,y); an arrow runs x,y → x2,y2; a pin is a point. */

export type Tone = 'accent' | 'info' | 'success' | 'warning' | 'danger';
export type Annotation = { type: 'box' | 'circle' | 'arrow' | 'pin' | 'highlight'; x: number; y: number; w?: number; h?: number; x2?: number; y2?: number; label?: string; tone?: Tone };

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
export function marks(list: Annotation[], aspect: number, width: number): string {
  const H = W / aspect, s = W / Math.max(width, 1), stroke = n(2 * s), mask = `pp-spot-${++masks}`, numbers = numbering(list);
  const shapes: string[] = [], holes: string[] = [], tags: string[] = [];
  list.forEach((a, i) => {
    const tone = toneOf(a), number = numbers[i], text = labelOf(a);
    const x = unit(a.x) * W, y = unit(a.y) * H, w = unit(a.w) * W, h = unit(a.h) * H;
    // Badge point (top-left of the shape) and chip anchor with the side it sits on.
    let bx = x, by = y, ax = x, ay = y, side = 'above';
    const below = (bottom: number) => { if (y < H * 0.12) { ay = bottom; side = 'below'; } };
    let body = '';
    switch (a.type) {
      case 'box':
        body = `<rect class="pp-stroke" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(7 * s)}" pathLength="1" stroke-width="${stroke}"/>`;
        below(y + h); break;
      case 'circle': {
        const rx = w / 2 || 50, ry = h / 2 || 50, cx = w ? x + rx : x, cy = h ? y + ry : y;
        body = `<ellipse class="pp-stroke" cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" pathLength="1" stroke-width="${stroke}"/>`;
        bx = cx - rx * 0.7; by = cy - ry * 0.7; ax = cx - rx; ay = cy - ry;
        if (ay < H * 0.12) { ay = cy + ry; side = 'below'; } break;
      }
      case 'highlight':
        holes.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(8 * s)}" fill="black"/>`);
        body = `<rect class="pp-stroke pp-glow" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(8 * s)}" pathLength="1" stroke-width="${n(1.5 * s)}"/>`;
        below(y + h); break;
      case 'arrow': {
        const x2 = unit(a.x2) * W, y2 = unit(a.y2) * H, angle = Math.atan2(y2 - y, x2 - x), head = 11 * s;
        const point = (turn: number) => `${n(x2 - head * Math.cos(angle + turn))},${n(y2 - head * Math.sin(angle + turn))}`;
        body = `<line class="pp-stroke" x1="${n(x)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y2)}" pathLength="1" stroke-width="${stroke}"/><polygon class="pp-arrowhead" points="${n(x2)},${n(y2)} ${point(0.42)} ${point(-0.42)}"/>`;
        if (y2 < y || y < H * 0.12) side = 'below'; break;
      }
      case 'pin': {
        const r = 10 * s;
        body = `<circle class="pp-pin" cx="${n(x)}" cy="${n(y)}" r="${n(r)}" stroke-width="${n(1.5 * s)}"/><text class="pp-pin-n" x="${n(x)}" y="${n(y)}" font-size="${n(11 * s)}" text-anchor="middle" dominant-baseline="central">${number}</text>`;
        ax = x + r * 1.4; side = 'right'; break;
      }
      default: return;
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
