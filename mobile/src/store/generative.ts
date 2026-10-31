// Generative UI in agent replies, parsed for the phone. A port of the desktop's validation
// (`normalize` in src/generative-ui-components.ts, the chart spec in src/rich-markdown.ts and the
// followup directive in src/enriched-markdown.ts), kept pure so Node tests run it. Nothing here
// runs agent code: buttons and forms only fill the composer, and remote URLs are never loaded.

export const LIMITS = { source: 64 * 1024, depth: 4, nodes: 120, text: 4000, prompt: 4000, rows: 200, columns: 12, items: 40 } as const;

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'note';
export type Status = 'done' | 'active' | 'pending' | 'error' | 'skipped';
export type Action = { label: string; prompt: string; tone: 'primary' | 'secondary' | 'danger' };
type Step = { title: string; detail?: string; status: Status; time?: string };
export type TreeItem = { name: string; note?: string; status?: string; children: TreeItem[] };
export type Field = { name: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox'; options: string[]; placeholder?: string; value?: string; required: boolean };
export type Panel = { label: string; body?: string; children: View[]; open?: boolean };

export type View =
  | { type: 'markdown'; text: string }
  | { type: 'callout'; tone: Tone; title?: string; body?: string }
  | { type: 'card'; title?: string; body?: string; footer?: string; actions: Action[]; children: View[] }
  | { type: 'stats'; items: { label: string; value: string; delta?: string; trend: 'up' | 'down' | 'flat'; hint?: string; spark?: number[] }[] }
  | { type: 'table'; title?: string; columns: { label: string; align?: 'left' | 'center' | 'right' }[]; rows: string[][] }
  | { type: 'chart'; chart: 'bar' | 'line' | 'pie' | 'area' | 'sparkline'; title?: string; labels: string[]; series: { name?: string; values: number[] }[] }
  | { type: 'progress'; label?: string; value: number; max: number; note?: string }
  | { type: 'steps' | 'plan' | 'timeline'; title?: string; summary?: string; items: Step[]; actions: Action[] }
  | { type: 'checklist'; title?: string; items: { text: string; done: boolean }[] }
  | { type: 'tabs' | 'accordion'; items: Panel[] }
  | { type: 'tree'; title?: string; items: TreeItem[] }
  | { type: 'diff'; file?: string; diff: string }
  | { type: 'code'; file?: string; language?: string; code: string }
  | { type: 'terminal'; command?: string; output: string; exitCode?: number }
  | { type: 'compare'; title?: string; items: { title: string; pros: string[]; cons: string[]; verdict?: string }[] }
  | { type: 'gallery'; images: { path: string; caption?: string }[] }
  | { type: 'actions'; label?: string; buttons: Action[] }
  | { type: 'chips'; label?: string; options: Action[] }
  | { type: 'form'; title?: string; fields: Field[]; submit: string; prompt?: string }
  | { type: 'stack' | 'grid'; columns: number; children: View[] }
  | { type: 'custom'; title?: string }
  | { type: 'unknown'; name: string; raw: string };

/* ---------- validation ---------- */

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const str = (value: unknown, max = 200): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
};
const list = (value: unknown, max: number = LIMITS.items): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const num = (value: unknown): number | undefined => { const n = typeof value === 'string' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : undefined; };
const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? value as T : fallback);
const strings = (entries: unknown) => list(entries, 20).map(entry => str(entry, 300)).filter((text): text is string => Boolean(text));
const STATUS = ['done', 'active', 'pending', 'error', 'skipped'] as const;

function actions(value: unknown): Action[] {
  return list(value, 8).flatMap(entry => {
    const raw = typeof entry === 'string' ? { label: entry } : obj(entry);
    const label = str(raw.label, 60);
    return label ? [{ label, prompt: str(raw.prompt, LIMITS.prompt) ?? label, tone: pick(raw.tone ?? raw.style, ['primary', 'secondary', 'danger'] as const, 'secondary') }] : [];
  });
}
function steps(value: unknown): Step[] {
  return list(value).flatMap(entry => {
    const raw = typeof entry === 'string' ? { title: entry } : obj(entry);
    const title = str(raw.title ?? raw.text ?? raw.label, 300);
    return title ? [{ title, detail: str(raw.detail ?? raw.body, LIMITS.text), status: pick(raw.status, STATUS, 'pending'), time: str(raw.time ?? raw.date, 40) }] : [];
  });
}
function tree(value: unknown, depth: number): TreeItem[] {
  if (depth > 8) return [];
  return list(value, 100).flatMap(entry => {
    const raw = typeof entry === 'string' ? { name: entry } : obj(entry);
    const name = str(raw.name ?? raw.path, 200);
    return name ? [{ name, note: str(raw.note, 120), status: str(raw.status, 20), children: tree(raw.children, depth + 1) }] : [];
  });
}
/** Builds a tree from flat paths, so `["src/a.ts","src/b.ts"]` nests under `src`. */
export function treeFromPaths(paths: string[]): TreeItem[] {
  const insert = (items: TreeItem[], parts: string[]): TreeItem[] => {
    if (!parts.length) return items;
    const [head, ...rest] = parts;
    const found = items.find(item => item.name === head);
    if (!found) return [...items, { name: head, children: insert([], rest) }];
    return items.map(item => (item === found ? { ...item, children: insert(item.children, rest) } : item));
  };
  return paths.slice(0, 200).reduce((root, path) => insert(root, path.split('/').filter(Boolean)), [] as TreeItem[]);
}

/** Validates one spec. Throws only for a value that is not a spec at all. */
export function normalize(value: unknown, depth = 0, budget = { nodes: 0 }): View {
  const raw = obj(value);
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) throw new Error('A view needs a "type".');
  if (++budget.nodes > LIMITS.nodes) throw new Error(`A view may hold at most ${LIMITS.nodes} parts.`);
  if (depth > LIMITS.depth) throw new Error(`Views nest at most ${LIMITS.depth} deep.`);
  const children = (entries: unknown) => list(entries, 24).map(child => normalize(child, depth + 1, budget));
  const title = str(raw.title, 200);
  switch (type) {
    case 'markdown': case 'text': return { type: 'markdown', text: str(raw.text ?? raw.body, LIMITS.text) ?? '' };
    case 'callout': case 'alert': return { type: 'callout', tone: pick(raw.tone ?? raw.variant, ['info', 'success', 'warning', 'danger', 'note'] as const, 'info'), title, body: str(raw.body ?? raw.text, LIMITS.text) };
    case 'card': return { type: 'card', title, body: str(raw.body, LIMITS.text), footer: str(raw.footer, 400), actions: actions(raw.actions), children: children(raw.children) };
    case 'stats': case 'kv': return { type: 'stats', items: list(raw.items, 12).flatMap(entry => {
      const item = obj(entry), label = str(item.label ?? item.key, 80), shown = str(item.value, 80);
      if (!label || shown === undefined) return [];
      const delta = str(item.delta, 40);
      const trend = pick(item.trend, ['up', 'down', 'flat'] as const, delta?.startsWith('-') ? 'down' : delta ? 'up' : 'flat');
      const spark = list(item.spark, 60).map(num).filter((n): n is number => n !== undefined);
      return [{ label, value: shown, delta, trend, hint: str(item.hint, 120), spark: spark.length > 1 ? spark : undefined }];
    }) };
    case 'table': {
      const columns = list(raw.columns, LIMITS.columns).flatMap(entry => {
        const column = typeof entry === 'string' ? { label: entry } : obj(entry);
        const label = str(column.label ?? column.key, 80);
        return label ? [{ label, key: str(column.key, 80) ?? label, align: pick(column.align, ['left', 'center', 'right'] as const, 'left') }] : [];
      });
      if (!columns.length) throw new Error('A table needs "columns".');
      const rows = list(raw.rows, LIMITS.rows).map(row => Array.isArray(row)
        ? columns.map((_, i) => str(row[i], 400) ?? '')
        : columns.map(column => str(obj(row)[column.key], 400) ?? ''));
      return { type: 'table', title, columns: columns.map(({ label, align }) => ({ label, align })), rows };
    }
    case 'chart': {
      const labels = list(raw.labels, 48).map(label => str(label, 40) ?? '');
      const series = list(raw.series, 6).map(entry => { const item = obj(entry); return { name: str(item.name, 60), values: list(item.values, labels.length || 60).map(v => num(v) ?? 0) }; });
      if (!series.some(entry => entry.values.length)) throw new Error('A chart needs at least one series of "values".');
      const chart = pick(raw.chart ?? raw.kind, ['bar', 'line', 'pie', 'area', 'sparkline'] as const, 'bar');
      return { type: 'chart', chart, title, labels: labels.length ? labels : series[0].values.map((_, i) => String(i + 1)), series };
    }
    case 'progress': { const max = Math.max(1, num(raw.max) ?? 100); return { type: 'progress', label: str(raw.label, 120) ?? title, value: Math.min(max, Math.max(0, num(raw.value) ?? 0)), max, note: str(raw.note, 200) }; }
    case 'steps': case 'plan': case 'timeline':
      return { type, title, summary: str(raw.summary ?? raw.body, LIMITS.text), items: steps(raw.items ?? raw.steps), actions: actions(raw.actions) };
    case 'checklist': return { type: 'checklist', title, items: list(raw.items).flatMap(entry => {
      const item = typeof entry === 'string' ? { text: entry } : obj(entry), text = str(item.text ?? item.label, 300);
      return text ? [{ text, done: item.done === true || item.checked === true }] : [];
    }) };
    case 'tabs': case 'accordion': {
      const items = list(raw.items ?? raw.tabs, 12).flatMap(entry => {
        const item = obj(entry), label = str(item.label ?? item.title, 80);
        return label ? [{ label, body: str(item.body, LIMITS.text), children: children(item.children), open: item.open === true }] : [];
      });
      if (!items.length) throw new Error(`${type === 'tabs' ? 'Tabs need "tabs"' : 'An accordion needs "items"'} with a label.`);
      return { type, items };
    }
    case 'tree': case 'files': return { type: 'tree', title, items: Array.isArray(raw.paths) ? treeFromPaths(list(raw.paths, 200).map(path => str(path, 300) ?? '').filter(Boolean)) : tree(raw.items, 0) };
    case 'diff': return { type: 'diff', file: str(raw.file, 300), diff: str(raw.diff ?? raw.patch, 24_000) ?? '' };
    case 'code': return { type: 'code', file: str(raw.file ?? raw.filename, 300), language: str(raw.language, 30), code: str(raw.code, 24_000) ?? '' };
    case 'terminal': return { type: 'terminal', command: str(raw.command, 500), output: str(raw.output, 24_000) ?? '', exitCode: num(raw.exitCode) };
    case 'compare': case 'pros-cons': {
      const source = Array.isArray(raw.items) ? raw.items : [raw];
      return { type: 'compare', title: Array.isArray(raw.items) ? title : undefined, items: list(source, 4).map(entry => { const item = obj(entry); return { title: str(item.title ?? item.name, 120) ?? '', pros: strings(item.pros), cons: strings(item.cons), verdict: str(item.verdict, 300) }; }) };
    }
    case 'gallery': return { type: 'gallery', images: list(raw.images, 12).flatMap(entry => {
      const item = typeof entry === 'string' ? { path: entry } : obj(entry), path = str(item.path, 400);
      return path && !/^[a-z][\w+.-]*:/i.test(path) && !path.startsWith('//') && !path.includes('..') ? [{ path: path.replace(/^\.\//, ''), caption: str(item.caption ?? item.alt, 160) }] : [];
    }) };
    case 'actions': case 'buttons': return { type: 'actions', label: str(raw.label, 120), buttons: actions(raw.buttons ?? raw.actions) };
    case 'chips': return { type: 'chips', label: str(raw.label, 120), options: actions(raw.options) };
    case 'followups': return { type: 'chips', label: str(raw.label, 120) ?? 'Suggested follow-ups', options: actions(raw.items ?? raw.options) };
    case 'form': {
      const fields = list(raw.fields, 12).flatMap(entry => {
        const field = obj(entry), name = str(field.name, 40)?.replace(/[^\w-]/g, '');
        if (!name) return [];
        const options = strings(field.options);
        return [{ name, label: str(field.label, 120) ?? name, type: pick(field.type, ['text', 'textarea', 'number', 'select', 'checkbox'] as const, options.length ? 'select' : 'text'), options, placeholder: str(field.placeholder, 120), value: str(field.value, 400), required: field.required === true }];
      });
      if (!fields.length) throw new Error('A form needs "fields" with a "name".');
      return { type: 'form', title, fields, submit: str(raw.submit, 40) ?? 'Add to prompt', prompt: str(raw.prompt, LIMITS.prompt) };
    }
    case 'stack': case 'grid': return { type, columns: Math.min(4, Math.max(1, Math.round(num(raw.columns) ?? 2))), children: children(raw.children) };
    // The phone never runs agent HTML; the desktop draws it.
    case 'custom': return { type: 'custom', title };
    default: return { type: 'unknown', name: type.slice(0, 40), raw: JSON.stringify(value, null, 2).slice(0, 2000) };
  }
}

/** A form's prompt: `{name}` placeholders filled from the values, or one line per field. */
export function formPrompt(template: string | undefined, fields: { name: string; label: string }[], values: Record<string, string>): string {
  const text = template
    ? template.replace(/\{([\w-]+)\}/g, (match, name: string) => (name in values ? values[name] : match))
    : fields.map(field => `${field.label}: ${values[field.name] ?? ''}`).join('\n');
  return text.slice(0, LIMITS.prompt);
}

/* ---------- svg ---------- */

// Anything that runs code, loads a resource or escapes the drawing: refuse the whole drawing rather
// than try to repair it (a regex can't parse XML, but it can say no).
const SVG_DENY = [
  /<\s*script/i, /<\s*foreignObject/i, /<\s*(?:iframe|object|embed|image|feImage|a|animate|set|handler|listener)\b/i,
  /<!\s*(?:DOCTYPE|ENTITY)/i, /<\?/, /\son\w+\s*=/i, /javascript:/i, /data:(?!image\/(?:png|jpe?g|gif|webp);base64,)/i,
  /href\s*=\s*(?!["']?\s*#)/i, /url\(\s*(?!["']?\s*#)/i, /@import/i,
];
/** The drawing, if it holds nothing but shapes (only local `#id` references); else null. */
export function sanitizeSvg(source: string): string | null {
  const xml = source.trim();
  if (!xml || xml.length > LIMITS.source || !/^<svg[\s>]/i.test(xml) || !/<\/svg>$/i.test(xml)) return null;
  return SVG_DENY.some(rule => rule.test(xml)) ? null : xml;
}

/* ---------- fences ---------- */

export type Block =
  | { kind: 'view'; view: View }
  | { kind: 'code'; label?: string; code: string }
  | { kind: 'svg'; xml: string | null }
  | { kind: 'html' }
  | { kind: 'error'; message: string; source: string };

export const GENERATIVE = new Set(['ui', 'chart', 'svg', 'html', 'mermaid']);

function parseFence(lang: string, source: string): Block {
  if (lang === 'mermaid') return { kind: 'code', label: 'Diagram · Mermaid', code: source };
  if (lang === 'html') return { kind: 'html' };
  if (lang === 'svg') return { kind: 'svg', xml: sanitizeSvg(source) };
  if (source.length > LIMITS.source) return { kind: 'error', message: 'This view is larger than 64 KB.', source: source.slice(0, 4000) };
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { kind: 'error', message: 'This view is not valid JSON.', source: source.slice(0, 4000) }; }
  try {
    // ```chart uses the questions' spec: {"type": "bar" | "line" | "pie", labels, series}.
    if (lang === 'chart') {
      const raw = obj(value);
      if (!['bar', 'line', 'pie'].includes(raw.type as string)) throw new Error('A chart needs "type": "bar", "line" or "pie".');
      value = { ...raw, type: 'chart', chart: raw.type };
    }
    return { kind: 'view', view: normalize(value) };
  } catch (error) {
    return { kind: 'error', message: (error as Error).message, source: source.slice(0, 4000) };
  }
}

const cache = new Map<string, Block>();
const CACHE_SIZE = 200;
/** One fence's view, memoized by language and source so a re-render never re-parses. */
export function parseBlock(lang: string, source: string): Block {
  const key = `${lang}\u0000${source}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const block = parseFence(lang, source);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, block);
  return block;
}

export type GenerativePart =
  | { kind: 'text'; text: string }
  | { kind: 'block'; lang: string; source: string; pending: boolean }
  | { kind: 'chips'; options: Action[] };

const FENCE = /^(```|~~~)[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:^\1[ \t]*$|(?![\s\S]))/gm;
// Follow-up suggestions written as an inline directive, e.g. :codex-followup[Run tests]{prompt="Run the tests"}.
const FOLLOWUP = /:(?:codex-)?followup\[([^\]\n]{1,80})\](?:\{prompt=("|&quot;)([\s\S]*?)\2\})?/g;

const CODE = /(^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[^\n]*$|(?![\s\S]))|`+[^`\n]*`+)/m;

/** Pulls followup directives out of text (outside code) into chips. */
export function extractFollowups(text: string): { text: string; options: Action[] } {
  if (!text.includes('followup[')) return { text, options: [] };
  const options: Action[] = [];
  const pieces = text.split(CODE).map((piece, i) => (i % 2 ? piece : piece.replace(FOLLOWUP, (_, label: string, _quote: string, prompt?: string) => {
    if (options.length < 8) options.push({ label, prompt: (prompt ?? label).replace(/&quot;/g, '"').slice(0, LIMITS.prompt), tone: 'secondary' });
    return '';
  })));
  return { text: pieces.join(''), options };
}

/** Splits a reply into Markdown, generative fences and followup chips. Other fences stay text.
 * A fence still open at the end is `pending` (the agent is writing it). */
export function generativeParts(text: string): GenerativePart[] {
  if (!text.includes('followup[') && !/^(?:```|~~~)[ \t]*(?:ui|chart|svg|html|mermaid)\b/im.test(text)) return [{ kind: 'text', text }];
  const parts: GenerativePart[] = [];
  let buffer = '';
  const flush = () => {
    const { text: rest, options } = extractFollowups(buffer);
    if (rest.trim()) parts.push({ kind: 'text', text: rest });
    if (options.length) parts.push({ kind: 'chips', options });
    buffer = '';
  };
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const lang = m[2].toLowerCase();
    const before = text.slice(last, m.index);
    last = m.index! + m[0].length;
    buffer += before;
    if (!GENERATIVE.has(lang)) { buffer += m[0]; continue; }
    flush();
    // Past the header and body there is only the closing fence, if the agent has written it.
    const closed = m[0].length > m[0].indexOf('\n') + 1 + m[3].length;
    parts.push({ kind: 'block', lang, source: m[3].replace(/\n$/, ''), pending: !closed });
  }
  buffer += text.slice(last);
  flush();
  return parts;
}
