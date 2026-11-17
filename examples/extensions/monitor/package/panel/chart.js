// Machine monitor panel: the chart module. Pure functions over points `[t, cpu, mem]` (t in epoch milliseconds), so a test can
// hand them the samples it scripted and read back exactly what was plotted. `draw` paints a canvas and returns the same list.
export const WINDOW_MS = 30 * 60 * 1000;

/** The values of one field (1: CPU, 2: memory) as `{ t, v }`, oldest first, only inside the window that ends at `end`. */
export function series(points, field, end = points.length ? points[points.length - 1][0] : 0, windowMs = WINDOW_MS) {
  return points.filter(point => point[0] >= end - windowMs && point[0] <= end).map(point => ({ t: point[0], v: Number(point[field]) }));
}

/** Average and peak of a series (both `null` for an empty one). Percent values, as the daemon reports them. */
export function stats(values) {
  if (!values.length) return { count: 0, avg: null, peak: null };
  let sum = 0, peak = -Infinity;
  for (const item of values) { sum += item.v; if (item.v > peak) peak = item.v; }
  return { count: values.length, avg: sum / values.length, peak };
}

/** Where each value lands on a canvas of `width` by `height`: time left to right over the window, 0 to 100 percent bottom to top. */
export function plot(values, { width, height, end, windowMs = WINDOW_MS, pad = 2 }) {
  const span = Math.max(1, windowMs);
  return values.map(item => ({
    t: item.t, v: item.v,
    x: pad + ((item.t - (end - span)) / span) * (width - pad * 2),
    y: pad + (1 - Math.min(100, Math.max(0, item.v)) / 100) * (height - pad * 2),
  }));
}

/** Paints a line chart (and a faint 50 percent rule when `grid`) and returns what it plotted. */
export function draw(canvas, values, options = {}) {
  const width = canvas.width, height = canvas.height;
  const end = options.end ?? (values.length ? values[values.length - 1].t : 0);
  const plotted = plot(values, { width, height, end, windowMs: options.windowMs ?? WINDOW_MS, pad: options.pad ?? 2 });
  const context = canvas.getContext?.('2d');
  if (!context) return plotted;
  const style = getComputedStyle(canvas);
  context.clearRect(0, 0, width, height);
  if (options.grid) {
    context.strokeStyle = style.getPropertyValue('--grid') || '#8884';
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
  }
  context.strokeStyle = options.color || style.color || '#4a90d9';
  context.lineWidth = options.line ?? 1.5;
  context.lineJoin = 'round';
  context.beginPath();
  plotted.forEach((point, index) => { if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y); });
  context.stroke();
  return plotted;
}
