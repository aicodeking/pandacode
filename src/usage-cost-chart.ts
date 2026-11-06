import type { ProviderId } from './types';
import { t } from './i18n.ts';
import { formatUsd, formatUsdAxis } from './usage-ledger.ts';

export interface CostSeries { provider: ProviderId; name: string; values: number[]; }
export interface CostChartOptions { series: CostSeries[]; buckets: { start: string; end: string }[]; }

const WIDTH = 600, HEIGHT = 180;
const SVG = 'http://www.w3.org/2000/svg';
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function localDate(key: string): Date { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

/** Three round gridlines above zero, so the axis reads like $1,000 / $2,000 / $3,000. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / 3, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(value => value >= raw) ?? raw;
  return [0, step, step * 2, step * 3];
}

/** Monotone cubic (Fritsch–Carlson): smooth like the reference, never dipping below zero or overshooting a peak. */
export function smoothPath(points: readonly [number, number][]): string {
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : '';
  const n = points.length;
  const slopes = points.slice(1).map(([x, y], i) => (y - points[i][1]) / (x - points[i][0]));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i] / slopes[i], b = tangents[i + 1] / slopes[i], h = Math.hypot(a, b);
    if (h > 3) { tangents[i] = 3 * a / h * slopes[i]; tangents[i + 1] = 3 * b / h * slopes[i]; }
  }
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1], dx = (x1 - x0) / 3;
    path += `C${(x0 + dx).toFixed(1)},${(y0 + tangents[i] * dx).toFixed(1)} ${(x1 - dx).toFixed(1)},${(y1 - tangents[i + 1] * dx).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return path;
}

function bucketLabel(bucket: { start: string; end: string }): string {
  return bucket.start === bucket.end ? shortDay.format(localDate(bucket.end)) : `${shortDay.format(localDate(bucket.start))} – ${shortDay.format(localDate(bucket.end))}`;
}

/** Cost over time, one line per agent in its fixed color. A crosshair (pointer or arrow keys) reads every agent at that point. */
export function costChart(options: CostChartOptions): HTMLElement {
  const { series, buckets } = options;
  const figure = element('figure', 'cost-chart');
  const readout = element('figcaption', 'cost-chart-readout'); readout.setAttribute('aria-live', 'polite');
  const plot = element('div', 'cost-chart-plot');
  const max = Math.max(0, ...series.flatMap(line => line.values));
  const ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
  const x = (i: number) => buckets.length > 1 ? (i / (buckets.length - 1)) * WIDTH : WIDTH / 2;
  const y = (value: number) => HEIGHT - (value / top) * HEIGHT;
  const chart = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (const tick of ticks) chart.append(svg('line', { class: tick ? 'cost-grid' : 'cost-baseline', x1: '0', x2: String(WIDTH), y1: String(y(tick)), y2: String(y(tick)) }));
  for (const line of series) {
    const points = line.values.map((value, i) => [x(i), y(value)] as [number, number]);
    const path = smoothPath(points);
    chart.append(svg('path', { class: 'cost-area', 'data-provider': line.provider, d: `${path}L${x(buckets.length - 1)},${HEIGHT}L${x(0)},${HEIGHT}Z` }));
    chart.append(svg('path', { class: 'cost-line', 'data-provider': line.provider, d: path }));
  }
  const axis = element('div', 'cost-chart-y'); axis.setAttribute('aria-hidden', 'true');
  for (const tick of ticks) { const label = element('span', '', formatUsdAxis(tick)); label.style.bottom = `${(tick / top) * 100}%`; axis.append(label); }
  const dates = element('div', 'cost-chart-x'); dates.setAttribute('aria-hidden', 'true');
  for (const i of [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])]) {
    const label = element('span', '', shortDay.format(localDate(buckets[i].end))); label.style.left = `${(x(i) / WIDTH) * 100}%`; dates.append(label);
  }
  const cursor = element('div', 'cost-chart-cursor'); cursor.hidden = true;
  const dots = series.map(line => { const dot = element('span', 'cost-chart-dot'); dot.dataset.provider = line.provider; cursor.append(dot); return dot; });
  plot.append(chart, cursor);
  const frame = element('div', 'cost-chart-frame'); frame.append(axis, plot, dates);
  frame.tabIndex = 0; frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', t`Estimated API cost over time. ${series.map(line => `${line.name}: ${formatUsd(line.values.reduce((a, b) => a + b, 0))}`).join('. ')}. Use the arrow keys to read each point.`);
  figure.append(readout, frame);

  const whole = bucketLabel({ start: buckets[0].start, end: buckets[buckets.length - 1].end });
  const summary = () => { readout.replaceChildren(element('span', 'cost-chart-caption', t`${whole} · point to read values`)); };
  let active = -1;
  const show = (index: number) => {
    active = Math.max(0, Math.min(buckets.length - 1, index));
    cursor.hidden = false; cursor.style.left = `${(x(active) / WIDTH) * 100}%`;
    series.forEach((line, i) => { dots[i].style.bottom = `${(line.values[active] / top) * 100}%`; });
    const parts = series.map(line => {
      const item = element('span', 'cost-chart-value'); item.dataset.provider = line.provider; item.append(element('strong', '', formatUsd(line.values[active])), element('span', '', line.name));
      return item;
    });
    readout.replaceChildren(element('span', 'cost-chart-caption', bucketLabel(buckets[active])), ...parts);
  };
  const hide = () => { active = -1; cursor.hidden = true; summary(); };
  plot.addEventListener('pointermove', event => {
    const bounds = plot.getBoundingClientRect();
    if (bounds.width) show(Math.round(((event.clientX - bounds.left) / bounds.width) * (buckets.length - 1)));
  });
  plot.addEventListener('pointerleave', hide);
  frame.addEventListener('blur', hide);
  frame.addEventListener('keydown', event => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const target = step ? (active < 0 ? buckets.length - 1 : active + step) : event.key === 'Home' ? 0 : event.key === 'End' ? buckets.length - 1 : null;
    if (target === null) return;
    event.preventDefault(); show(target);
  });
  summary();
  return figure;
}
