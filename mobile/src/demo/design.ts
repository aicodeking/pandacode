// Demo answers for the `design` feature group (src/connect/api/design.ts): two made-up artboards
// that every demo project and task shares, an SVG standing in for the computer's rendered PNG, and
// a few comments. Changes live for the demo session only. See ./index.ts.
import type { DesignComment } from '../connect/api/design.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const MIN = 60_000;
const ARTBOARD_WIDTH = 390;
const ARTBOARD_HEIGHT = 640;

const HTML: Readonly<Record<string, string>> = {
  'home.html': '<!doctype html>\n<title>Home</title>\n<header><h1>Uploads</h1><button>New upload</button></header>\n<main><ul class="files"><li>report.pdf</li><li>logo.svg</li></ul></main>\n',
  'settings.html': '<!doctype html>\n<title>Settings</title>\n<main><h1>Settings</h1><label><input type="checkbox"> Retry failed uploads</label></main>\n',
};

/** A phone-sized mock of the artboard, as the computer's QuickLook render would show it. */
function previewSvg(name: string): string {
  const title = name === 'home.html' ? 'Uploads' : 'Settings';
  const rows = name === 'home.html' ? ['report.pdf', 'logo.svg', 'notes.md'] : ['Retry failed uploads', 'Keep originals', 'Upload on Wi-Fi only'];
  const items = rows.map((row, i) => `<rect x="20" y="${140 + i * 64}" width="350" height="52" rx="12" fill="#ffffff" stroke="#e4ded3"/><text x="36" y="${172 + i * 64}" font-size="16" fill="#333">${row}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ARTBOARD_WIDTH}" height="${ARTBOARD_HEIGHT}" viewBox="0 0 ${ARTBOARD_WIDTH} ${ARTBOARD_HEIGHT}">`
    + `<rect width="${ARTBOARD_WIDTH}" height="${ARTBOARD_HEIGHT}" fill="#f6f2ea"/>`
    + `<text x="20" y="70" font-size="30" font-weight="700" fill="#222">${title}</text>`
    + '<rect x="250" y="44" width="120" height="36" rx="18" fill="#3b82f6"/><text x="270" y="68" font-size="14" fill="#fff">New upload</text>'
    + `${items}</svg>`;
}

/** Per device, made on first use; replaced (never edited in place) on every change. */
let byDevice: Record<string, readonly DesignComment[]> = {};

const pin = (id: string, artboard: string, x: number, y: number, text: string, createdAt: number, status: DesignComment['status'] = 'open'): DesignComment =>
  ({ id, artboard, selector: 'body', bbox: { x: x - 8, y: y - 8, width: 16, height: 16 }, text, status, createdAt, note: 'From the phone' });

function seed(now: number): readonly DesignComment[] {
  return [
    pin('demo-c1', 'home.html', 310, 62, 'Make this button a bit smaller.', now - 90 * MIN),
    pin('demo-c2', 'home.html', 120, 230, 'Show the file size on each row.', now - 60 * MIN),
    pin('demo-c3', 'settings.html', 160, 166, 'Turn this on by default.', now - 30 * MIN, 'resolved'),
  ];
}

function comments(ctx: DemoContext): readonly DesignComment[] {
  const found = byDevice[ctx.deviceId] ?? seed(ctx.host.now());
  byDevice = { ...byDevice, [ctx.deviceId]: found };
  return found;
}

/** The project or task must exist on the demo computer, as the host checks. */
function checkTarget(ctx: DemoContext, p: { projectId?: string; sessionId?: string }) {
  const list = ctx.state.tasks[ctx.deviceId];
  const ok = p.sessionId ? list?.tasks.some(t => t.sessionId === p.sessionId) : p.projectId ? list?.projects.some(proj => proj.id === p.projectId) : false;
  if (!ok) throw new Error(p.sessionId || p.projectId ? 'That project or task no longer exists.' : 'Choose a project or a task.');
}

/** "home" or "home.html" → "home.html", when that artboard exists. */
function artboard(name: unknown): string {
  const text = String(name ?? '');
  const full = text.endsWith('.html') ? text : `${text}.html`;
  if (!HTML[full]) throw new Error(`No artboard named ${full}.`);
  return full;
}

export const handlers: DemoHandlers = {
  'design.list': (ctx, p) => {
    checkTarget(ctx, p);
    const open = comments(ctx).filter(c => c.status === 'open').reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.artboard]: (acc[c.artboard] ?? 0) + 1 }), {});
    const now = ctx.host.now();
    const artboards = Object.entries(HTML).map(([name, html], i) => ({ name, size: html.length, modified: Math.floor((now - (i + 1) * 3 * 60 * MIN) / 1000) }));
    return { artboards, open, preview: true };
  },
  'design.read': (ctx, p) => {
    checkTarget(ctx, p);
    const text = HTML[artboard(p.name)];
    return { text, offset: 0, total: text.length, done: true };
  },
  'design.preview': (ctx, p) => {
    checkTarget(ctx, p);
    const data = btoa(previewSvg(artboard(p.name)));
    return { mime: 'image/svg+xml', total: data.length, offset: 0, data, done: true, scale: 1 };
  },
  'design.comments': (ctx, p) => {
    checkTarget(ctx, p);
    const only = p.artboard ? artboard(p.artboard) : null;
    return { comments: comments(ctx).filter(c => !only || c.artboard === only), truncated: false };
  },
  'design.comment': (ctx, p) => {
    checkTarget(ctx, p);
    const text = String(p.text ?? '').trim();
    if (!text) throw new Error('Write a comment first.');
    const now = ctx.host.now();
    const comment = pin(`demo-${now.toString(36)}`, artboard(p.artboard), Number(p.x), Number(p.y), text, now);
    byDevice = { ...byDevice, [ctx.deviceId]: [...comments(ctx), comment] };
    return { comment };
  },
  'design.resolve': (ctx, p) => {
    checkTarget(ctx, p);
    const found = comments(ctx).find(c => c.id === p.commentId);
    if (!found) throw new Error('This comment no longer exists.');
    const comment: DesignComment = { ...found, status: p.status === 'open' ? 'open' : 'resolved' };
    byDevice = { ...byDevice, [ctx.deviceId]: comments(ctx).map(c => (c.id === comment.id ? comment : c)) };
    return { comment };
  },
};
