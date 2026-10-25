/* The generative UI component library. `normalize` validates an agent's JSON spec at the
 * boundary (types, lengths, counts, depth) and is pure, so Node tests can run it; `renderBlock`
 * draws a fence's view. Interactivity is local (tabs, sort, toggles) or fills the composer;
 * nothing here executes agent code or fetches a remote URL. */
import { t } from './i18n.ts';

// Explicit .ts extension for Node's direct test import (tests/generative-ui.test.mjs).
import { markTightCustom } from './generative-ui-selectors.ts';

export const LIMITS = { source: 64 * 1024, depth: 4, nodes: 120, text: 4000, prompt: 4000, css: 16 * 1024, rows: 200, columns: 12, items: 40 } as const;

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'note';
type Status = 'done' | 'active' | 'pending' | 'error' | 'skipped';
export type Action = { label: string; prompt: string; tone: 'primary' | 'secondary' | 'danger' };
type Step = { title: string; detail?: string; status: Status; time?: string };
type TreeItem = { name: string; note?: string; status?: string; children: TreeItem[] };
type Field = { name: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox'; options: string[]; placeholder?: string; value?: string; required: boolean };
type Panel = { label: string; body?: string; children: View[]; open?: boolean };

export type View =
  | { type: 'markdown'; text: string }
  | { type: 'callout'; tone: Tone; title?: string; body?: string }
  | { type: 'card'; title?: string; body?: string; footer?: string; actions: Action[]; children: View[] }
  | { type: 'stats'; items: { label: string; value: string; delta?: string; trend?: 'up' | 'down' | 'flat'; hint?: string; spark?: number[] }[] }
  | { type: 'table'; title?: string; columns: { label: string; align?: 'left' | 'center' | 'right' }[]; rows: string[][]; sortable: boolean }
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
  | { type: 'custom'; html: string; css: string; state: Record<string, string>; height: number }
  | { type: 'unknown'; name: string; raw: string };

export const VIEW_TYPES = ['markdown', 'callout', 'card', 'stats', 'table', 'chart', 'progress', 'steps', 'plan', 'timeline', 'checklist', 'tabs', 'accordion', 'tree', 'diff', 'code', 'terminal', 'compare', 'gallery', 'actions', 'chips', 'form', 'stack', 'grid', 'custom'] as const;

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
  const root: TreeItem[] = [];
  for (const path of paths.slice(0, 200)) {
    let level = root;
    for (const part of path.split('/').filter(Boolean)) {
      let node = level.find(item => item.name === part);
      if (!node) { node = { name: part, children: [] }; level.push(node); }
      level = node.children;
    }
  }
  return root;
}

class Budget { nodes = 0; }

/** Validates one spec. Throws only for a value that is not a spec at all. */
export function normalize(value: unknown, depth = 0, budget = new Budget()): View {
  const raw = obj(value);
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) throw new Error(t('A view needs a "type".'));
  if (++budget.nodes > LIMITS.nodes) throw new Error(t`A view may hold at most ${LIMITS.nodes} parts.`);
  if (depth > LIMITS.depth) throw new Error(t`Views nest at most ${LIMITS.depth} deep.`);
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
        return label ? [{ label, key: str(column.key, 80) ?? label, align: ['left', 'center', 'right'].includes(column.align as string) ? column.align as 'left' | 'center' | 'right' : undefined }] : [];
      });
      const rows = list(raw.rows, LIMITS.rows).map(row => Array.isArray(row)
        ? row.slice(0, columns.length).map(cell => str(cell, 400) ?? '')
        : columns.map(column => str(obj(row)[column.key], 400) ?? ''));
      if (!columns.length) throw new Error(t('A table needs "columns".'));
      return { type: 'table', title, columns: columns.map(({ label, align }) => ({ label, align })), rows, sortable: raw.sortable !== false };
    }
    case 'chart': {
      const labels = list(raw.labels, 48).map(label => str(label, 40) ?? '');
      const series = list(raw.series, 6).map(entry => { const item = obj(entry); return { name: str(item.name, 60), values: list(item.values, labels.length || 60).map(v => num(v) ?? 0) }; });
      if (!series.some(entry => entry.values.length)) throw new Error(t('A chart needs at least one series of "values".'));
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
      if (!items.length) throw new Error(t`${type === 'tabs' ? t('Tabs need "tabs"') : t('An accordion needs "items"')} with a label.`);
      return { type, items };
    }
    case 'tree': case 'files': return { type: 'tree', title, items: Array.isArray(raw.paths) ? treeFromPaths(list(raw.paths, 200).map(path => str(path, 300) ?? '').filter(Boolean)) : tree(raw.items, 0) };
    case 'diff': return { type: 'diff', file: str(raw.file, 300), diff: str(raw.diff ?? raw.patch, 24_000) ?? '' };
    case 'code': return { type: 'code', file: str(raw.file ?? raw.filename, 300), language: str(raw.language, 30), code: str(raw.code, 24_000) ?? '' };
    case 'terminal': return { type: 'terminal', command: str(raw.command, 500), output: str(raw.output, 24_000) ?? '', exitCode: num(raw.exitCode) };
    case 'compare': case 'pros-cons': {
      const source = Array.isArray(raw.items) ? raw.items : [raw];
      const strings = (entries: unknown) => list(entries, 20).map(entry => str(entry, 300)).filter((text): text is string => Boolean(text));
      return { type: 'compare', title: Array.isArray(raw.items) ? title : undefined, items: list(source, 4).map(entry => { const item = obj(entry); return { title: str(item.title ?? item.name, 120) ?? '', pros: strings(item.pros), cons: strings(item.cons), verdict: str(item.verdict, 300) }; }) };
    }
    case 'gallery': return { type: 'gallery', images: list(raw.images, 12).flatMap(entry => {
      const item = typeof entry === 'string' ? { path: entry } : obj(entry), path = str(item.path, 400);
      return path && !/^[a-z][\w+.-]*:/i.test(path) && !path.includes('..') ? [{ path, caption: str(item.caption ?? item.alt, 160) }] : [];
    }) };
    case 'actions': case 'buttons': return { type: 'actions', label: str(raw.label, 120), buttons: actions(raw.buttons ?? raw.actions) };
    case 'chips': return { type: 'chips', label: str(raw.label, 120), options: actions(raw.options) };
    case 'followups': return { type: 'chips', label: str(raw.label, 120) ?? t('Suggested follow-ups'), options: actions(raw.items ?? raw.options) };
    case 'form': {
      const fields = list(raw.fields, 12).flatMap(entry => {
        const field = obj(entry), name = str(field.name, 40)?.replace(/[^\w-]/g, '');
        if (!name) return [];
        const options = list(field.options, 30).map(option => str(option, 120)).filter((text): text is string => Boolean(text));
        return [{ name, label: str(field.label, 120) ?? name, type: pick(field.type, ['text', 'textarea', 'number', 'select', 'checkbox'] as const, options.length ? 'select' : 'text'), options, placeholder: str(field.placeholder, 120), value: str(field.value, 400), required: field.required === true }];
      });
      if (!fields.length) throw new Error(t('A form needs "fields" with a "name".'));
      return { type: 'form', title, fields, submit: str(raw.submit, 40) ?? t('Add to prompt'), prompt: str(raw.prompt, LIMITS.prompt) };
    }
    case 'stack': case 'grid': return { type, columns: Math.min(4, Math.max(1, Math.round(num(raw.columns) ?? 2))), children: children(raw.children) };
    case 'custom': {
      const html = typeof raw.html === 'string' ? raw.html : '';
      if (!html.trim()) throw new Error(t('A custom view needs "html".'));
      if (html.length > LIMITS.source) throw new Error(t('A custom view may hold at most 64 KB of HTML.'));
      const state: Record<string, string> = {};
      for (const [key, entry] of Object.entries(obj(raw.state)).slice(0, 40)) { const text = str(entry, 400); if (/^[\w-]{1,40}$/.test(key) && text !== undefined) state[key] = text; }
      return { type: 'custom', html, css: scrubCss(typeof raw.css === 'string' ? raw.css : ''), state, height: Math.min(900, Math.max(80, num(raw.height) ?? 480)) };
    }
    default: return { type: 'unknown', name: type.slice(0, 40), raw: JSON.stringify(value, null, 2).slice(0, 2000) };
  }
}

/** Parses a fence's JSON and validates it. */
export function parseSpec(source: string): View {
  if (source.length > LIMITS.source) throw new Error(t('This view is larger than 64 KB.'));
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error(t('This view is not valid JSON.')); }
  return normalize(value);
}

/** CSS for a custom view: nothing that loads a resource (remote or local) or escapes the style element. */
export function scrubCss(css: string): string {
  return css.slice(0, LIMITS.css)
    .replace(/<\/?style/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:image\/(?:png|jpe?g|gif|webp);)[^)]*\)/gi, 'none')
    .replace(/image-set\([^)]*\)|expression\([^)]*\)|-moz-binding[^;]*/gi, 'none');
}

/** A form's prompt: `{name}` placeholders filled from the values, or one line per field. */
export function formPrompt(template: string | undefined, fields: { name: string; label: string }[], values: Record<string, string>): string {
  const text = template
    ? template.replace(/\{([\w-]+)\}/g, (match, name: string) => (name in values ? values[name] : match))
    : fields.map(field => `${field.label}: ${values[field.name] ?? ''}`).join('\n');
  return text.slice(0, LIMITS.prompt);
}

/** Fills `{key}` from a custom view's state. */
export const interpolate = (text: string, state: Record<string, string>) => text.replace(/\{([\w-]+)\}/g, (match, key: string) => state[key] ?? match).slice(0, LIMITS.prompt);

/* ---------- rendering ---------- */

type Props = Record<string, string | number | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const kid of kids) if (kid !== undefined && kid !== false) node.append(kid);
  return node;
}

/** Draws a fence: ```ui JSON, or ```chart/```svg/```html through the questions' renderer.
 * baseCss carries src/type-base.css and src/shadow-base.css, passed in because this module
 * must stay importable in Node and cannot import CSS. */
export async function renderBlock(kind: string, source: string, baseCss: string): Promise<HTMLElement> {
  const host = h('div', { class: 'gu' });
  if (kind === 'mermaid') {
    // No diagram renderer ships with PandaCode: show the source, labelled and copyable.
    host.append(codeView(t('Diagram · Mermaid'), source));
    return host;
  }
  if (kind !== 'ui') {
    const rich = await import('./rich-markdown');
    const box = h('div');
    await rich.richMarkdown(box, `\`\`\`${kind}\n${source.slice(0, LIMITS.source)}${source.endsWith('\n') ? '' : '\n'}\`\`\``, { image: workspaceImage });
    host.append(box);
    return host;
  }
  let spec: View;
  try { spec = parseSpec(source); }
    case 'stack': case 'grid': return h('div', { class: `gu-${spec.type}`, style: spec.type === 'grid' ? `--gu-columns:${spec.columns}` : undefined }, ...(await Promise.all(spec.children.map(view))));
    case 'custom': return custom(spec);
    case 'unknown': return h('div', { class: 'gu-failed' }, h('p', { class: 'gu-error' }, t`PandaCode has no “${spec.name}” view. Showing its data instead.`), h('pre', {}, h('code', {}, spec.raw)));
