import './rich-markdown.css';
import { markdownHtml } from './dom';

/* Rich Markdown for an agent's questions: ordinary Markdown plus images from the task's
 * workspace, ```chart blocks (bar, line, pie), ```svg drawings and static ```html views.
 * Nothing here runs agent code: SVG and HTML are sanitized, HTML lives in a shadow root,
 * and remote images become links (the app never fetches them). */

export type RichContext = {
  /** A workspace image as a data: URL. */
  image(path: string): Promise<string>;
};

type Block = { kind: 'chart' | 'svg' | 'html'; code: string };
type Picture = { alt: string; src: string };

const TOKEN = 'PANDACODERICH';
const FENCE = /```(chart|svg|html)[ \t]*\n([\s\S]*?)```/g;
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BLOCK_LIMIT = 64 * 1024;

let purify: Promise<typeof import('dompurify').default> | undefined;
const sanitizer = () => (purify ??= import('dompurify').then(module => module.default));

export async function richMarkdown(target: HTMLElement, source: string, context: RichContext): Promise<void> {
  const blocks: Block[] = [], pictures: Picture[] = [];
  const text = source
    .replace(FENCE, (_, kind: Block['kind'], code: string) => `\n\n${TOKEN}B${blocks.push({ kind, code: code.slice(0, BLOCK_LIMIT) }) - 1}X\n\n`)
    .replace(IMAGE, (_, alt: string, src: string) => `${TOKEN}I${pictures.push({ alt, src }) - 1}X`);
  target.classList.add('markdown', 'rich-markdown');
  target.dataset.richSource = source;
  // Sanitized Markdown; the form may not be on screen yet, so render detached.
  const html = await markdownHtml(text);
  if (target.dataset.richSource !== source) return;
  target.innerHTML = html;
  safeLinks(target);
  if (!blocks.length && !pictures.length) return;
  const pending: Promise<void>[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node as Text).data.includes(TOKEN)) nodes.push(node as Text);
  for (const node of nodes) {
    const parts = node.data.split(new RegExp(`(${TOKEN}[BI]\\d+X)`));
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const match = part.match(new RegExp(`^${TOKEN}([BI])(\\d+)X$`));
      if (!match) { if (part) fragment.append(part); continue; }
      const index = Number(match[2]);
      if (match[1] === 'I' && pictures[index]) fragment.append(picture(pictures[index], context, pending));
      else if (match[1] === 'B' && blocks[index]) fragment.append(block(blocks[index], pending));
    }
    // A block stands alone in its paragraph: replace the paragraph rather than nest a figure in it.
    const parent = node.parentElement;
    if (parent?.tagName === 'P' && parent.childNodes.length === 1 && [...fragment.childNodes].some(child => child instanceof HTMLElement && child.classList.contains('rich-block'))) parent.replaceWith(fragment);
    else node.replaceWith(fragment);
  }
  await Promise.all(pending);
}

/** Web links open in the browser; anything else (a relative path) never navigates the app. */
function safeLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^(?:https?:|mailto:)/i.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    else anchor.removeAttribute('href');
  }
}

function picture({ alt, src }: Picture, context: RichContext, pending: Promise<void>[]): HTMLElement {
  // Remote images would be fetched from a server the agent chose: show them as a link instead.
  if (/^https?:/i.test(src)) {
    const link = document.createElement('a');
    link.href = src; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = alt || src;
    return link;
  }
  const figure = document.createElement('span');
  figure.className = 'rich-image';
  const image = document.createElement('img');
  image.alt = alt; image.decoding = 'async';
  figure.append(image);
  if (alt) { const caption = document.createElement('span'); caption.className = 'rich-caption'; caption.textContent = alt; figure.append(caption); }
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) image.src = src;
  else pending.push(context.image(src.replace(/^file:\/\//i, '')).then(url => { image.src = url; }).catch(() => {
    figure.classList.add('rich-missing');
    image.remove();
    figure.prepend(`Image not found: ${src}`);
  }));
  return figure;
}

function block({ kind, code }: Block, pending: Promise<void>[]): HTMLElement {
  const figure = document.createElement('div');
  figure.className = `rich-block rich-${kind}`;
  if (kind === 'chart') {
    try { figure.append(chart(JSON.parse(code))); }
    catch (cause) { failed(figure, cause instanceof Error ? cause.message : 'This chart could not be drawn.', code); }
    return figure;
  }
  pending.push(sanitizer().then(purify => {
    if (kind === 'svg') {
      const clean = purify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
      if (!clean.querySelector('svg')) { failed(figure, 'This drawing could not be shown.', code); return; }
      figure.append(clean);
    } else {
      // Static HTML in its own shadow root: its styles cannot leak out, and nothing in it runs.
      const clean = purify.sanitize(code, {
        USE_PROFILES: { html: true, svg: true },
        FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
        ADD_TAGS: ['style'], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true,
      });
      safeLinks(clean);
      // Only inline images: anything else would be fetched, or shown broken.
      for (const image of clean.querySelectorAll('img')) if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image.getAttribute('src') ?? '')) image.remove();
      const root = figure.attachShadow({ mode: 'open' });
      const base = document.createElement('style');
      base.textContent = ':host{display:block;color:var(--text);font:inherit}*{box-sizing:border-box;max-width:100%}img{height:auto}table{border-collapse:collapse}td,th{padding:4px 8px}th{background:var(--fill-hover)}tr:nth-child(even) td{background:var(--fill-hover)}a{color:var(--accent-ink)}';
      root.append(base, clean);
    }
  }).catch(() => failed(figure, 'This view could not be shown.', code)));
  return figure;
}

function failed(figure: HTMLElement, message: string, code: string): void {
  figure.classList.add('rich-failed');
  const note = document.createElement('p'); note.textContent = message;
  const pre = document.createElement('pre'); pre.textContent = code.slice(0, 2000);
  figure.replaceChildren(note, pre);
}

/* ---------- charts ---------- */

type Series = { name?: string; values: number[] };
type ChartSpec = { type: 'bar' | 'line' | 'pie'; title?: string; labels: string[]; series: Series[] };

function spec(value: unknown): ChartSpec {
  const raw = value as Partial<ChartSpec> | null;
  if (!raw || !['bar', 'line', 'pie'].includes(raw.type as string)) throw new Error('A chart needs "type": "bar", "line" or "pie".');
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 48).map(String) : [];
  const series = (Array.isArray(raw.series) ? raw.series : []).slice(0, 6).map(entry => ({
    name: typeof entry?.name === 'string' ? entry.name.slice(0, 60) : undefined,
    values: (Array.isArray(entry?.values) ? entry.values : []).slice(0, labels.length).map(Number).map(n => Number.isFinite(n) ? n : 0),
  }));
  if (!labels.length || !series.length || series.every(entry => !entry.values.length)) throw new Error('A chart needs "labels" and at least one series of "values".');
  return { type: raw.type as ChartSpec['type'], title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined, labels, series };
}

const PALETTE = ['var(--accent)', '#5ad19a', '#6aa8ff', '#f0679b', '#ff8a3d', '#a86cf0'];
const NS = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Draws a small chart as SVG in the app's colours; it scales with the question's width. */
export function chart(value: unknown): HTMLElement {
  const { type, title, labels, series } = spec(value);
  const wrap = document.createElement('figure');
  wrap.className = 'rich-chart';
  if (title) { const caption = document.createElement('figcaption'); caption.textContent = title; wrap.append(caption); }
  const width = 560, height = 260, left = 44, bottom = 34, top = 12, right = 12;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title ?? `${type} chart` });
  if (type === 'pie') {
    const values = series[0].values.map(v => Math.max(0, v)), total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = 130, cy = height / 2, r = 104;
    values.forEach((v, i) => {
      const sweep = (v / total) * Math.PI * 2, end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const path = sweep >= Math.PI * 2 - 1e-6
        ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
        : `M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} Z`;
      svg.append(el('path', { d: path, fill: PALETTE[i % PALETTE.length], stroke: 'var(--panel)', 'stroke-width': 2 }));
      svg.append(el('rect', { x: 268, y: 24 + i * 22, width: 12, height: 12, rx: 3, fill: PALETTE[i % PALETTE.length] }));
      svg.append(el('text', { x: 288, y: 35 + i * 22, class: 'rich-chart-label' }, `${labels[i] ?? ''} · ${Math.round((v / total) * 100)}%`));
      angle = end;
    });
  } else {
    const all = series.flatMap(entry => entry.values), max = Math.max(0, ...all), min = Math.min(0, ...all);
    const span = max - min || 1, plotW = width - left - right, plotH = height - top - bottom;
    const y = (v: number) => top + plotH - ((v - min) / span) * plotH;
    for (let i = 0; i <= 4; i++) {
      const v = min + (span * i) / 4, yy = y(v);
      svg.append(el('line', { x1: left, x2: width - right, y1: yy, y2: yy, class: 'rich-chart-grid' }));
      svg.append(el('text', { x: left - 6, y: yy + 4, 'text-anchor': 'end', class: 'rich-chart-axis' }, Number(v.toFixed(2)).toLocaleString()));
    }
    const step = plotW / labels.length;
    labels.forEach((label, i) => {
      if (labels.length <= 12 || i % Math.ceil(labels.length / 12) === 0) svg.append(el('text', { x: left + step * i + step / 2, y: height - 12, 'text-anchor': 'middle', class: 'rich-chart-axis' }, label.slice(0, 14)));
    });
    series.forEach((entry, s) => {
      const color = PALETTE[s % PALETTE.length];
      if (type === 'bar') {
        const groupW = step * 0.72, barW = groupW / series.length;
        entry.values.forEach((v, i) => {
          const x = left + step * i + (step - groupW) / 2 + barW * s, y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v));
          svg.append(el('rect', { x, y: y0, width: Math.max(1, barW - 2), height: Math.max(1, y1 - y0), rx: 2, fill: color }));
        });
      } else {
        const points = entry.values.map((v, i) => `${left + step * i + step / 2},${y(v)}`).join(' ');
        svg.append(el('polyline', { points, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        entry.values.forEach((v, i) => svg.append(el('circle', { cx: left + step * i + step / 2, cy: y(v), r: 3, fill: color })));
      }
    });
  }
  wrap.append(svg);
  if (type !== 'pie' && series.some(entry => entry.name)) {
    const legend = document.createElement('div'); legend.className = 'rich-chart-legend';
    series.forEach((entry, s) => { if (!entry.name) return; const item = document.createElement('span'); item.style.setProperty('--swatch', PALETTE[s % PALETTE.length]); item.textContent = entry.name; legend.append(item); });
    wrap.append(legend);
  }
  return wrap;
}
