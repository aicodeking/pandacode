import type { Annotation, Snapshot } from './progress-pip';

/* Browser-preview stand-ins for progress_list / progress_media / progress_thumb /
 * progress_clear: six iterations of a small search app on the first preview thread (light,
 * dark, one portrait phone screen and one idea sketch). Open the preview with `?progress` to
 * see them, or `?progress=many` for 40; without it no thread has snapshots, so the other
 * browser suites never get an overlay. The "screenshots" are generated SVG data: URLs. */

const W = 960, H = 600, PW = 390, PH = 780;
const svg = (body: string, bg: string, w = W, h = H) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system,Helvetica,Arial,sans-serif"><rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`)}`;
const bar = (x: number, y: number, w: number, h: number, fill: string, r = 6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const text = (x: number, y: number, s: string, size: number, fill: string, weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${s}</text>`;

type Theme = { bg: string; panel: string; line: string; ink: string; soft: string; brand: string };
const LIGHT: Theme = { bg: '#f7f7f5', panel: '#ffffff', line: '#e6e5e0', ink: '#242423', soft: '#8d8c86', brand: '#3a6ff0' };
const DARK: Theme = { bg: '#18191c', panel: '#212226', line: '#30323a', ink: '#eeeef0', soft: '#8c8f99', brand: '#7aa2ff' };

function app(t: Theme, step: number): string {
  const side = step >= 2, x0 = side ? 220 : 40, width = W - x0 - 40;
  let out = bar(0, 0, W, 56, t.panel, 0) + `<line x1="0" y1="56" x2="${W}" y2="56" stroke="${t.line}"/>` + text(28, 35, 'Orbit', 19, t.ink, 700);
  if (side) {
    out += bar(0, 56, 190, H - 56, t.panel, 0) + `<line x1="190" y1="56" x2="190" y2="${H}" stroke="${t.line}"/>`;
    ['Library', 'Recent', 'Starred', 'Shared'].forEach((label, i) => {
      if (i === 0) out += bar(14, 78, 162, 34, step >= 4 ? `${t.brand}22` : t.line, 8);
      out += text(30, 101 + i * 44, label, 14, i === 0 && step >= 4 ? t.brand : t.ink, i === 0 ? 600 : 400);
    });
  }
  out += bar(x0, 84, width, 48, t.panel, 12) + `<rect x="${x0}" y="84" width="${width}" height="48" rx="12" fill="none" stroke="${step >= 4 ? t.brand : t.line}" stroke-width="${step >= 4 ? 2 : 1}"/>`;
  out += `<circle cx="${x0 + 26}" cy="107" r="8" fill="none" stroke="${t.soft}" stroke-width="2"/><line x1="${x0 + 32}" y1="113" x2="${x0 + 38}" y2="119" stroke="${t.soft}" stroke-width="2"/>`;
  out += text(x0 + 50, 113, step >= 2 ? 'search index' : 'Search…', 15, step >= 2 ? t.ink : t.soft);
  if (step >= 4) out += bar(x0 + width - 52, 96, 38, 24, t.line, 6) + text(x0 + width - 44, 113, '⌘K', 12, t.soft, 600);
  let y = 156;
  if (step >= 4) {
    ['All', 'Docs', 'Code', 'Issues'].forEach((chip, i) => {
      out += bar(x0 + i * 86, y, 76, 28, i === 0 ? t.brand : t.panel, 14) + text(x0 + 18 + i * 86, y + 19, chip, 13, i === 0 ? '#fff' : t.ink, 600);
    });
    y += 46;
  }
  if (step === 1) {
    for (let i = 0; i < 4; i++) out += bar(x0, y + i * 58, width * (0.9 - i * 0.12), 16, t.line, 8) + bar(x0, y + 24 + i * 58, width * 0.4, 10, t.line, 5);
    return out;
  }
  out += text(x0, y + 4, step >= 4 ? '12 results · 18 ms' : '12 results', 13, t.soft, 600);
  y += 18;
  const rows = step >= 5 ? 3 : 4;
  for (let i = 0; i < rows; i++) {
    const top = y + i * 78;
    out += bar(x0, top, width, 66, t.panel, 10) + `<rect x="${x0}" y="${top}" width="${width}" height="66" rx="10" fill="none" stroke="${t.line}"/>`;
    out += bar(x0 + 14, top + 14, 38, 38, step >= 4 ? `${t.brand}${i === 0 ? '33' : '18'}` : t.line, 8);
    out += text(x0 + 66, top + 30, ['createSearchIndex', 'search-index.ts', 'Fuzzy ranking', 'Highlight matches'][i], 15, t.ink, 600);
    out += text(x0 + 66, top + 50, ['src/lib · updated 2m ago', 'src/lib · 214 lines', 'docs · ranking notes', 'src/components'][i], 12, t.soft);
    if (step >= 4 && i === 0) out += bar(x0 + width - 92, top + 22, 74, 22, `${t.brand}22`, 11) + text(x0 + width - 78, top + 37, 'Best', 12, t.brand, 700);
  }
  if (step >= 5) {
    const top = y + 3 * 78 + 6, bars = [22, 38, 30, 52, 44, 66, 58, 74, 62, 80];
    out += bar(x0, top, width, 104, t.panel, 10) + text(x0 + 16, top + 26, 'Query latency', 13, t.soft, 600);
    bars.forEach((v, i) => { out += bar(x0 + 18 + i * ((width - 36) / bars.length), top + 94 - v * 0.75, (width - 36) / bars.length - 8, v * 0.75, i === bars.length - 1 ? t.brand : `${t.brand}55`, 3); });
  }
  return out;
}

/** The same search on a phone: a portrait screenshot. */
function phone(t: Theme): string {
  let out = text(24, 64, 'Search', 30, t.ink, 700) + bar(20, 88, PW - 40, 46, t.panel, 14) + `<rect x="20" y="88" width="${PW - 40}" height="46" rx="14" fill="none" stroke="${t.brand}" stroke-width="2"/>` + text(48, 117, 'search index', 16, t.ink);
  ['All', 'Docs', 'Code'].forEach((chip, i) => { out += bar(20 + i * 78, 150, 68, 30, i === 0 ? t.brand : t.panel, 15) + text(38 + i * 78, 170, chip, 13, i === 0 ? '#fff' : t.ink, 600); });
  ['createSearchIndex', 'search-index.ts', 'Fuzzy ranking', 'Highlight matches', 'Keyboard shortcuts'].forEach((label, i) => {
    const top = 202 + i * 84;
    out += bar(20, top, PW - 40, 72, t.panel, 14) + bar(34, top + 16, 40, 40, `${t.brand}${i === 0 ? '33' : '18'}`, 10) + text(88, top + 33, label, 16, t.ink, 600) + text(88, top + 54, 'src/lib · 2m ago', 12, t.soft);
  });
  return out + bar(0, PH - 74, PW, 74, t.panel, 0) + `<line x1="0" y1="${PH - 74}" x2="${PW}" y2="${PH - 74}" stroke="${t.line}"/>` +
    ['Search', 'Recent', 'Starred'].map((label, i) => text(40 + i * 120, PH - 32, label, 13, i === 0 ? t.brand : t.soft, 600)).join('');
}

/** A pencil-on-paper idea: wobbly strokes, no app chrome. */
function sketch(): string {
  const pen = '#5b5547', soft = '#b9b1a0';
  const wobble = (x: number, y: number, w: number, h: number) => `<path d="M${x} ${y + 3} Q${x + w / 2} ${y - 3} ${x + w} ${y + 2} Q${x + w + 3} ${y + h / 2} ${x + w - 2} ${y + h} Q${x + w / 2} ${y + h + 4} ${x + 1} ${y + h - 1} Q${x - 3} ${y + h / 2} ${x} ${y + 3}Z" fill="none" stroke="${pen}" stroke-width="2.4" stroke-linecap="round"/>`;
  let out = '';
  for (let y = 40; y < H; y += 32) out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#e7dfcf" stroke-width="1"/>`;
  out += text(60, 76, 'Idea: command palette', 30, pen, 600);
  out += `<rect x="200" y="120" width="560" height="380" rx="18" fill="#fffdf6"/>` + wobble(200, 120, 560, 380);
  out += wobble(230, 150, 500, 50) + text(256, 183, '›  type to search everything', 18, soft);
  ['Open file…', 'Jump to symbol', 'Recent searches', 'Toggle dark mode'].forEach((label, i) => {
    out += wobble(230, 222 + i * 64, 500, 48) + text(256, 253 + i * 64, label, 18, pen) + text(660, 253 + i * 64, ['⌘O', '⌘T', '⌘R', '⌘D'][i], 16, soft);
  });
  return out + `<path d="M120 380 Q150 330 196 318" fill="none" stroke="${pen}" stroke-width="2" stroke-dasharray="6 6"/>` + text(64, 410, 'opens with ⌘K', 16, pen);
}

const MIN = 60_000;
function seed(): Array<Snapshot & { url: string }> {
  const at = Date.now();
  const make = (iteration: number, title: string, note: string, url: string, annotations: Annotation[], kind: Snapshot['kind'] = 'image', width = W, height = H) =>
    ({ id: `snap-${iteration}`, iteration, title, note, kind, annotations, createdAt: at - (7 - iteration) * 7 * MIN, url, width, height });
  return [
    make(1, 'First pass: search shell', 'The page renders and the search field takes input. Results are still placeholder bars.', svg(app(LIGHT, 1), LIGHT.bg), [
      { type: 'box', x: 0.035, y: 0.13, w: 0.93, h: 0.095, label: 'Search field works', tone: 'success' },
      { type: 'arrow', x: 0.62, y: 0.6, x2: 0.48, y2: 0.42, label: 'Results unstyled', tone: 'warning' },
    ]),
    make(2, 'Sidebar and result cards', 'Added the library sidebar and real result rows from the index.', svg(app(LIGHT, 2), LIGHT.bg), [
      { type: 'box', x: 0.01, y: 0.115, w: 0.18, h: 0.33, label: 'New sidebar', tone: 'accent' },
      { type: 'circle', x: 0.215, y: 0.235, w: 0.12, h: 0.08, label: 'Count, no timing', tone: 'info' },
      { type: 'pin', x: 0.3, y: 0.38, label: 'Rows need icons' },
    ]),
    make(3, 'Idea: a command palette', 'Sketching a ⌘K palette before building it — open files, jump to symbols, recent searches.', svg(sketch(), '#fbf6ea'), [
      { type: 'pin', x: 0.27, y: 0.29, label: 'Fuzzy input', tone: 'accent' },
      { type: 'pin', x: 0.27, y: 0.68, label: 'Shortcut hints', tone: 'info' },
      { type: 'arrow', x: 0.1, y: 0.62, x2: 0.2, y2: 0.54, tone: 'accent' },
    ], 'idea'),
    make(4, 'Filters, focus ring and ⌘K hint', 'Filter chips scope the search; the focused field picks up the brand ring; best match is tagged.', svg(app(LIGHT, 4), LIGHT.bg), [
      { type: 'highlight', x: 0.22, y: 0.25, w: 0.37, h: 0.07, label: 'New filter chips', tone: 'accent' },
      { type: 'box', x: 0.885, y: 0.152, w: 0.06, h: 0.058, label: '⌘K', tone: 'info' },
      { type: 'pin', x: 0.86, y: 0.43, label: 'Best match tag', tone: 'success' },
    ]),
    make(5, 'Phone layout', 'The same search on a 390 px screen: filters scroll sideways, results become cards and a tab bar sits at the bottom.', svg(phone(LIGHT), LIGHT.bg, PW, PH), [
      { type: 'box', x: 0.04, y: 0.105, w: 0.92, h: 0.075, label: 'Field keeps its focus ring', tone: 'success' },
      { type: 'pin', x: 0.85, y: 0.21, label: 'Chips scroll on small screens', tone: 'info' },
      { type: 'highlight', x: 0, y: 0.9, w: 1, h: 0.1, label: 'New tab bar', tone: 'accent' },
    ], 'image', PW, PH),
    make(6, 'Dark theme and latency chart', 'Dark theme passes contrast. A small latency chart now sits under the results.', svg(app(DARK, 5), DARK.bg), [
      { type: 'box', x: 0.225, y: 0.735, w: 0.735, h: 0.18, label: 'Latency chart', tone: 'success' },
      { type: 'circle', x: 0.25, y: 0.39, w: 0.07, h: 0.1, label: 'Check icon contrast', tone: 'danger' },
      { type: 'arrow', x: 0.7, y: 0.07, x2: 0.9, y2: 0.17, label: 'Keyboard hint', tone: 'info' },
    ]),
  ];
}

type Stored = Snapshot & { url: string };
/** `?progress=many`: 40 iterations cycling the six, for lazy loading. */
function many(): Stored[] {
  const base = seed(), at = Date.now();
  return Array.from({ length: 40 }, (_, i) => {
    const from = base[i % base.length];
    return { ...from, id: `many-${i + 1}`, iteration: i + 1, title: `${from.title} (${i + 1})`, createdAt: at - (40 - i) * 3 * MIN };
  });
}
const mode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('progress') : null;
const store = new Map<string, Stored[]>(mode === null ? [] : [['session-1', mode === 'many' ? many() : seed()]]);
const strip = ({ url: _url, ...snapshot }: Stored): Snapshot => structuredClone(snapshot);
const find = (sessionId: string, id: string): Stored => {
  const found = store.get(sessionId)?.find(s => s.id === id);
  if (!found) throw new Error('That snapshot no longer exists.');
  return found;
};

export const previewProgress = {
  /** Set by preview.ts to emit `progress-changed`. */
  onChange: (_sessionId: string) => {},
  /** Every progress_thumb call, so tests can see thumbnails load lazily. */
  thumbCalls: [] as string[],
  list: (sessionId: string): Snapshot[] => (store.get(sessionId) ?? []).map(strip),
  media: (sessionId: string, id: string): string => find(sessionId, id).url,
  // The native side scales to 320 px; these SVGs are already small.
  thumb(sessionId: string, id: string): string { this.thumbCalls.push(id); return find(sessionId, id).url; },
  clear(sessionId: string): null { store.delete(sessionId); this.onChange(sessionId); return null; },
  /** What an agent's pandacode_progress_* call does: post the next iteration. */
  add(sessionId: string, title = 'Polish pass'): Snapshot {
    const list = store.get(sessionId) ?? [], iteration = list.length + 1;
    const next: Stored = { id: `snap-${iteration}-${Date.now()}`, iteration, title, note: 'Tightened spacing and tuned the chart colors.', kind: 'image', createdAt: Date.now(), url: svg(app(LIGHT, 5), LIGHT.bg), width: W, height: H,
      annotations: [{ type: 'box', x: 0.225, y: 0.735, w: 0.735, h: 0.18, label: 'Chart in light theme', tone: 'success' }] };
    store.set(sessionId, [...list, next]);
    this.onChange(sessionId);
    return strip(next);
  },
};
