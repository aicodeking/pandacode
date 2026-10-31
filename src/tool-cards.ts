import { basename, mcpAction, parseFields, shellCommand, toolKind, type TraceKind } from './tool-trace.ts';
import { escape, fileIcon, icon } from './dom.ts';

/** Rich, escaped result-card bodies per tool kind, in the reference's language: hairline rows with a
 * leading mark, bold title + muted inline meta, right-aligned time, a second body line and `+N more`.
 * Styles: tool-cards.css (imported by the caller; Node tests cannot load CSS). Returns '' when unhandled. */
export type CardTool = { name: string; status: string; input: string; output: string };
type Fields = Record<string, unknown>;
type Row = { mark: string; title: string; meta?: string; time?: string; body?: string; titleHtml?: string; bodyHtml?: string; status?: string };

const MAX_SCAN = 40_000;
const ROWS = 6;
const LINES = 12;
const DIFF_ROWS = 18;
const MATCHES_PER_FILE = 3;
const KEYS = 6;
const OMITTED = '[Non-text content omitted]';

const clip = (value: string, limit = 140) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
};
const str = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const field = (fields: Fields, ...keys: string[]) => {
  for (const key of keys) { const value = str(fields[key]); if (value) return value; }
  return '';
};
const objects = (value: unknown): Fields[] => Array.isArray(value) ? value.filter((item): item is Fields => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
const splitLines = (value: string) => value ? value.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n') : [];
const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
}
function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, 60); }
}
function urlPath(url: string): string {
  try { const { pathname } = new URL(url); return pathname === '/' ? '' : pathname; } catch { return ''; }
}
function cleanOutput(output: string): string {
  const value = output.slice(0, MAX_SCAN);
  return value.trim() === OMITTED ? '' : unwrapContent(value);
}
/** MCP results often arrive as `[{"type":"text","text":"…"}]` content blocks. */
function unwrapContent(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith('[{')) return output;
  try {
    const parts = objects(JSON.parse(trimmed));
    return parts.length && parts.every(part => part.type === 'text' && typeof part.text === 'string') ? parts.map(part => part.text).join('\n') : output;
  } catch { return output; }
}
function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

// ── Building blocks ──────────────────────────────────────────────────────────

/** A small rounded letter tile, the neutral stand-in for a brand mark. */
function letterMark(label: string): string {
  const ch = (label.replace(/^[^a-z0-9]+/i, '')[0] ?? '?').toUpperCase();
  return `<span class="tc-mark tc-letter" aria-hidden="true">${escape(ch)}</span>`;
}
const iconMark = (name: string, cls = '') => `<span class="tc-mark${cls ? ' ' + cls : ''}" aria-hidden="true">${icon(name)}</span>`;
const fileMark = (path: string, isDir = false) => `<span class="tc-mark tc-file-mark" aria-hidden="true">${fileIcon(basename(path), isDir)}</span>`;

function head(mark: string, title: string, meta = '', right = ''): string {
  return `<div class="tc-head">${mark}<span class="tc-head-title">${title}</span>${meta ? `<span class="tc-head-meta">${escape(meta)}</span>` : ''}${right ? `<span class="tc-head-right">${right}</span>` : ''}</div>`;
}
function more(count: number, noun = 'more'): string {
  return count > 0 ? `<div class="tc-more">+${count} ${escape(noun)}</div>` : '';
}
function rowHtml(row: Row): string {
  const title = row.titleHtml ?? escape(clip(row.title, 120));
  const status = row.status ? ` data-status="${escape(row.status)}"` : '';
  const body = row.bodyHtml ?? (row.body ? escape(clip(row.body, 220)) : '');
  return `<li class="tc-row"${status}>${row.mark}<div class="tc-row-main"><div class="tc-row-line"><span class="tc-row-title">${title}</span>${row.meta ? `<span class="tc-row-meta">${escape(clip(row.meta, 80))}</span>` : ''}${row.time ? `<span class="tc-row-time">${escape(row.time)}</span>` : ''}</div>${body ? `<div class="tc-row-body">${body}</div>` : ''}</div></li>`;
}
function rows(items: Row[], total = items.length, noun = 'more'): string {
  if (!items.length) return '';
  return `<ul class="tc-rows">${items.slice(0, ROWS).map(rowHtml).join('')}</ul>${more(total - Math.min(items.length, ROWS), noun)}`;
}
/** Numbered code lines; `numbers` null leaves the gutter blank. */
function codeLines(values: string[], numbers: (number | null)[] | number, label: string, total = values.length): string {
  if (!values.length) return '';
  const shown = values.slice(0, LINES);
  const body = shown.map((line, i) => {
    const n = typeof numbers === 'number' ? numbers + i : numbers[i];
    return `<span class="tc-line"><span class="tc-gutter">${n ?? ''}</span><span class="tc-code">${escape(line.slice(0, 400)) || ' '}</span></span>`;
  }).join('');
  return `<pre class="tc-lines" tabindex="0" aria-label="${escape(label)}">${body}</pre>${more(total - shown.length, total - shown.length === 1 ? 'more line' : 'more lines')}`;
}
function pathTitle(path: string): string {
  const dir = dirname(path);
  return `<span class="tc-path"><b>${escape(basename(path))}</b>${dir ? `<span class="tc-dir">${escape(clip(dir, 60))}</span>` : ''}</span>`;
}
/** Escapes text, turning `code` spans into <code>; split before escaping so nothing else becomes markup. */
export function inlineCode(text: string): string {
  return text.split(/`([^`\n]+)`/).map((part, i) => i % 2 ? `<code>${escape(part)}</code>` : escape(part)).join('');
}
function excerpt(text: string, limit = 4): string {
  const shown = splitLines(text.trim()).map(line => line.trim()).filter(Boolean);
  return shown.length ? `<p class="tc-excerpt">${inlineCode(clip(shown.slice(0, limit).join(' '), 360))}</p>` : '';
}
function clockTime(value: string): string {
  if (!/\d{4}-\d{2}-\d{2}|^\d{10,13}$/.test(value)) return '';
  const date = new Date(/^\d{10}$/.test(value) ? Number(value) * 1000 : /^\d{13}$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Shell ────────────────────────────────────────────────────────────────────

function exitCode(output: string): { code?: number; body: string } {
  const codex = /^Exit code: (-?\d+)\n?/.exec(output);
  if (codex) return { code: Number(codex[1]), body: output.slice(codex[0].length).replace(/^Wall time:.*\n?/, '').replace(/^Output:\n?/, '') };
  const json = parseFields(output);
  const code = typeof json.exitCode === 'number' ? json.exitCode : typeof json.exit_code === 'number' ? json.exit_code : undefined;
  if (code !== undefined) return { code, body: [str(json.stdout), str(json.stderr)].filter(Boolean).join('\n') };
  const trailing = /(?:^|\n)Exit code:? (-?\d+)\s*$/.exec(output);
  return trailing ? { code: Number(trailing[1]), body: output.slice(0, trailing.index) } : { body: output };
}
function shellCard(tool: CardTool, fields: Fields, output: string): string {
  const command = shellCommand(tool.input, fields);
  if (!command) return '';
  const { code, body } = exitCode(output);
  const failed = code !== undefined ? code !== 0 : tool.status === 'failed';
  const badge = code !== undefined || failed ? `<span class="tc-badge${failed ? ' is-failed' : ''}">${escape(code !== undefined ? `exit ${code}` : 'failed')}</span>` : '';
  const where = /vm_exec$/.test(tool.name) ? field(fields, 'name', 'vm') : '';
  const all = splitLines(stripAnsi(body).trimEnd());
  const tail = all.slice(-LINES);
  const earlier = all.length - tail.length;
  const out = tail.length
    ? `${earlier > 0 ? `<div class="tc-more tc-earlier">${escape(plural(earlier, 'earlier line'))}</div>` : ''}<pre class="tc-term-out" tabindex="0" aria-label="Command output, last lines">${escape(tail.map(line => line.slice(0, 400)).join('\n'))}</pre>`
    : '';
  return `<div class="tc-term${failed ? ' is-failed' : ''}">${termHead(command, where, badge)}${out}</div>`;
}
function termHead(command: string, where: string, badge = ''): string {
  return `<div class="tc-term-head"><span class="tc-dollar" aria-hidden="true">$</span><code class="tc-command">${escape(clip(command, 400))}</code>${where ? `<span class="tc-head-meta">on ${escape(where)}</span>` : ''}${badge}</div>`;
}

// ── Files: read, write, edit ─────────────────────────────────────────────────

function filePath(input: string, fields: Fields): string {
  return field(fields, 'file_path', 'path', 'filePath', 'target_file', 'notebook_path') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');
}
function fileHead(path: string, meta: string, right = ''): string {
  return head(fileMark(path), pathTitle(path), meta, right);
}
function readCard(tool: CardTool, fields: Fields, output: string): string {
  const path = filePath(tool.input, fields);
  if (!path) return '';
  const numbered = splitLines(output).map(line => /^\s*(\d+)(?:→|\t)(.*)$/.exec(line));
  const isNumbered = numbered.length > 0 && numbered.filter(Boolean).length >= numbered.length * 0.8;
  const entries = isNumbered ? numbered.filter((m): m is RegExpExecArray => !!m).map(m => ({ n: Number(m[1]), text: m[2] })) : splitLines(output).map((text, i) => ({ n: i + 1, text }));
  const offset = Number(fields.offset) || 0;
  const start = entries[0]?.n ?? (offset || 1);
  const end = entries.length ? entries[entries.length - 1].n : 0;
  const range = entries.length ? (start === 1 && !offset && !fields.limit ? plural(entries.length, 'line') : `Lines ${start}–${end}`) : '';
  return fileHead(path, range) + codeLines(entries.map(e => e.text), entries.map(e => e.n), 'File preview', entries.length);
}
function writeCard(fields: Fields): string {
  const path = field(fields, 'file_path', 'path', 'filePath');
  if (!path) return '';
  const content = splitLines(field(fields, 'content', 'contents', 'text'));
  return fileHead(path, 'New file') + codeLines(content, 1, 'New file preview');
}

type DiffLine = { sign: ' ' | '+' | '-'; text: string; old?: number; new?: number };
type FileDiff = { path: string; lines: DiffLine[]; action?: string };

/** Old/new strings become context + removed + added around their shared prefix and suffix. */
function diffStrings(before: string, after: string): DiffLine[] {
  const a = splitLines(before), b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const context = (text: string): DiffLine => ({ sign: ' ', text });
  return [
    ...a.slice(Math.max(0, pre - 2), pre).map(context),
    ...a.slice(pre, a.length - post).map((text): DiffLine => ({ sign: '-', text })),
    ...b.slice(pre, b.length - post).map((text): DiffLine => ({ sign: '+', text })),
    ...a.slice(a.length - post, a.length - post + 2).map(context),
  ];
}
/** Codex `*** Begin Patch` envelopes and plain unified diffs; `@@ -a,b +c,d` headers give real line numbers. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let oldN = 0, newN = 0, numbered = false;
  for (const line of splitLines(patch)) {
    const envelope = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const plain = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (envelope || (plain && plain[1] !== '/dev/null')) {
      current = { path: (envelope ? envelope[2] : plain![1]).trim(), lines: [], action: envelope?.[1] };
      files.push(current); numbered = false; continue;
    }
    if (!current || /^(\*\*\*|--- |diff --git|index )/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { oldN = Number(hunk[1]); newN = Number(hunk[2]); numbered = true; continue; }
    if (line.startsWith('@@')) { numbered = false; continue; }
    const sign = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    const entry: DiffLine = { sign, text: line.slice(1) };
    if (numbered) {
      if (sign !== '+') entry.old = oldN++;
      if (sign !== '-') entry.new = newN++;
    }
    current.lines.push(entry);
  }
  return files;
}
function editDiffs(tool: CardTool, fields: Fields): FileDiff[] {
  const patch = field(fields, 'patch', 'input', 'diff') || (/^\s*(\*\*\* Begin Patch|diff --git|--- )/.test(tool.input) ? tool.input : '');
  if (patch) return parsePatch(patch);
  const path = filePath(tool.input, fields);
  const edits = Array.isArray(fields.edits) ? objects(fields.edits) : [fields];
  const lines = edits.flatMap(edit => diffStrings(field(edit, 'old_string', 'oldText', 'old_str'), field(edit, 'new_string', 'newText', 'new_str')));
  return path || lines.length ? [{ path, lines }] : [];
}
function diffSection(file: FileDiff, budget: number): { html: string; used: number } {
  const added = file.lines.filter(l => l.sign === '+').length;
  const removed = file.lines.filter(l => l.sign === '-').length;
  const shown = file.lines.slice(0, budget);
  const numbered = shown.some(l => l.old !== undefined || l.new !== undefined);
  const gutters = (l: DiffLine) => numbered ? `<span class="tc-gutter">${l.old ?? ''}</span><span class="tc-gutter">${l.new ?? ''}</span>` : '';
  const body = shown.map(l => `<span class="tc-diff-line" data-sign="${l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : 'ctx'}">${gutters(l)}<span class="tc-sign">${l.sign === '-' ? '−' : l.sign}</span><span class="tc-code">${escape(l.text.slice(0, 300)) || ' '}</span></span>`).join('');
  const meta = file.action === 'Add' ? 'New file' : file.action === 'Delete' ? 'Deleted' : '';
  const title = file.path ? fileHead(file.path, meta) : head(iconMark('edit'), '<b>Edit</b>', meta);
  const rest = file.lines.length - shown.length;
  return { html: `<div class="tc-diff-file">${title}${shown.length ? `<pre class="tc-diff${numbered ? '' : ' is-unnumbered'}" tabindex="0" aria-label="${escape(`Changes to ${basename(file.path) || 'file'}`)}">${body}</pre>` : ''}${more(rest, rest === 1 ? 'more line' : 'more lines')}</div>`, used: shown.length };
}
function editCard(tool: CardTool, fields: Fields): string {
  const files = editDiffs(tool, fields);
  let budget = DIFF_ROWS;
  const sections = files.slice(0, 3).map(file => { const section = diffSection(file, Math.max(budget, 4)); budget -= section.used; return section.html; });
  return sections.join('') + more(files.length - sections.length, files.length - sections.length === 1 ? 'more file' : 'more files');
}

// ── Search: grep, glob, ls ───────────────────────────────────────────────────

function queryPattern(pattern: string): RegExp | undefined {
  if (!pattern) return;
  try { return new RegExp(pattern, 'gi'); } catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }
}
/** Escapes text while wrapping query matches in <mark>; split before escaping so markup cannot leak. */
export function highlight(text: string, pattern?: RegExp): string {
  if (!pattern) return escape(text);
  let html = '', last = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break;
    html += escape(text.slice(last, match.index)) + `<mark>${escape(match[0])}</mark>`;
    last = match.index! + match[0].length;
  }
  return html + escape(text.slice(last));
}
function searchCard(tool: CardTool, fields: Fields, output: string): string {
  const pattern = field(fields, 'pattern', 'query', 'regex', 'glob');
  const found = splitLines(output).map(line => line.trimEnd()).filter(line => line.trim() && !/^(Found \d+|No (files|matches) found|Showing |\(Results are truncated)/i.test(line.trim()));
  const isGlob = /glob|file_search/i.test(tool.name);
  const isList = /^(ls|list|list_dir)$/i.test(tool.name);
  const groups = new Map<string, { n?: number; text: string }[]>();
  for (const line of found) {
    const match = /^(.+?):(\d+)[:-](.*)$/.exec(line) ?? (isGlob || isList ? null : /^([^\s:]+\.[\w]+):(.*)$/.exec(line));
    if (match && match.length === 4) (groups.get(match[1]) ?? groups.set(match[1], []).get(match[1])!).push({ n: Number(match[2]), text: match[3] });
    else if (match) (groups.get(match[1]) ?? groups.set(match[1], []).get(match[1])!).push({ text: match[2] });
    else if (!groups.has(line.trim())) groups.set(line.trim().replace(/^- /, ''), []);
  }
  const files = [...groups.entries()];
  const total = files.reduce((sum, [, hits]) => sum + Math.max(1, hits.length), 0);
  // The row above already names the scope and the query; the card adds only the match count.
  const counted = [...groups.values()].some(hits => hits.length);
  const top = counted ? `<div class="tc-head"><span class="tc-head-meta">${escape(`${plural(total, 'match', 'matches')} in ${plural(files.length, 'file')}`)}</span></div>` : '';
  if (!files.length) return output.trim() ? excerpt(output, 2) : `<p class="tc-empty">No matches</p>`;
  const re = queryPattern(isGlob || isList ? '' : pattern);
  const items: Row[] = files.slice(0, ROWS).map(([path, hits]) => {
    const isDir = path.endsWith('/');
    const clean = path.replace(/\/$/, '');
    const shown = hits.slice(0, MATCHES_PER_FILE);
    const bodyHtml = shown.length ? `<span class="tc-hits">${shown.map(hit => `<span class="tc-hit">${hit.n !== undefined ? `<span class="tc-gutter">${hit.n}</span>` : ''}<span class="tc-code">${highlight(clip(hit.text, 160), re)}</span></span>`).join('')}${hits.length > shown.length ? `<span class="tc-hit-more">+${hits.length - shown.length} more in file</span>` : ''}</span>` : '';
    return { mark: fileMark(clean, isDir), title: basename(clean), meta: dirname(clean), time: hits.length > 1 ? String(hits.length) : '', bodyHtml };
  });
  return top + rows(items, files.length, files.length - ROWS === 1 ? 'more file' : 'more files');
}

// ── Web ──────────────────────────────────────────────────────────────────────

type WebResult = { title: string; url: string; snippet: string };
function webResults(output: string): WebResult[] {
  const at = output.indexOf('Links:');
  const start = at >= 0 ? output.indexOf('[', at) : -1;
  const json = start >= 0 ? (() => { const end = output.indexOf(']\n', start); return parseJson(output.slice(start, end > 0 ? end + 1 : output.lastIndexOf(']') + 1)); })() : parseJson(output);
  const list = objects(Array.isArray(json) ? json : json && typeof json === 'object' ? (json as Fields).results : undefined);
  const parsed = list.map(item => ({ title: field(item, 'title', 'name'), url: field(item, 'url', 'link', 'href'), snippet: field(item, 'snippet', 'description', 'content', 'text') })).filter(item => item.title && item.url);
  if (parsed.length) return parsed;
  return [...output.matchAll(/\[([^\]\n]{2,200})\]\((https?:\/\/[^)\s]+)\)(?:\s*[-—:]\s*([^\n]+))?/g)].map(m => ({ title: m[1], url: m[2], snippet: m[3] ?? '' }));
}
function webCard(fields: Fields, output: string): string {
  // The row above shows the query; the card is the results.
  const results = webResults(output);
  if (!results.length) return output.trim() ? excerpt(output) : '';
  return rows(results.map(r => ({ mark: letterMark(domain(r.url)), title: r.title, meta: domain(r.url), body: r.snippet })), results.length);
}
function fetchCard(fields: Fields, output: string): string {
  const url = field(fields, 'url', 'uri');
  if (!url) return '';
  const text = output.trim();
  const titleLine = /^#{1,2}\s+(.+)$/m.exec(text)?.[1] ?? /<title>([^<]{1,200})<\/title>/i.exec(text)?.[1] ?? '';
  const body = text.replace(/<[^>]+>/g, ' ').split('\n').filter(line => line.trim() && !line.trim().startsWith('#') && line.trim() !== titleLine).join('\n');
  return `<div class="tc-page">${letterMark(domain(url))}<div class="tc-row-main"><div class="tc-row-line"><span class="tc-row-title">${escape(clip(titleLine || domain(url), 120))}</span><span class="tc-row-meta">${escape(clip(titleLine ? domain(url) + urlPath(url) : urlPath(url), 80))}</span></div>${body ? excerpt(body, 4) : ''}</div></div>`;
}

// ── Plans, agents, skills ────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = { completed: 'Done', in_progress: 'In progress', pending: 'To do', cancelled: 'Cancelled' };
function statusMark(status: string): string {
  const s = STATUS_LABEL[status] ? status : 'pending';
  const glyph = s === 'completed' ? '<circle cx="8" cy="8" r="6.5" class="tc-fill"/><path d="m5.2 8.2 1.9 1.9 3.7-3.9" class="tc-tick"/>'
    : s === 'in_progress' ? '<circle cx="8" cy="8" r="6"/><path d="M8 3.5a4.5 4.5 0 0 1 0 9Z" class="tc-fill"/>'
      : s === 'cancelled' ? '<circle cx="8" cy="8" r="6"/><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4"/>'
        : '<circle cx="8" cy="8" r="6"/>';
  return `<span class="tc-mark tc-status" data-status="${s}" role="img" aria-label="${STATUS_LABEL[s]}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}
function todoCard(fields: Fields): string {
  const todos = objects(fields.todos ?? fields.plan ?? fields.steps);
  if (!todos.length) return '';
  const norm = (status: string) => status.replace(/-/g, '_').toLowerCase();
  const done = todos.filter(t => norm(field(t, 'status')) === 'completed').length;
  const explanation = field(fields, 'explanation');
  const bar = `<span class="tc-progress" role="img" aria-label="${done} of ${todos.length} done"><span style="width:${Math.round(done / todos.length * 100)}%"></span></span>`;
  const items = todos.slice(0, 10).map(todo => {
    const status = norm(field(todo, 'status'));
    const active = status === 'in_progress' ? field(todo, 'activeForm') : '';
    return rowHtml({ mark: statusMark(status), title: field(todo, 'content', 'step', 'title', 'text') || 'Untitled step', status, body: active });
  }).join('');
  return head(iconMark('plan'), '<b>Plan</b>', `${done} of ${todos.length} done`, bar) + (explanation ? excerpt(explanation, 2) : '') + `<ul class="tc-rows tc-todos">${items}</ul>` + more(todos.length - 10, 'more steps');
}
function agentCard(tool: CardTool, fields: Fields, output: string): string {
  const description = field(fields, 'description', 'title');
  const prompt = field(fields, 'prompt', 'task');
  if (!description && !prompt && !output.trim()) return '';
  const state = tool.status === 'running' ? 'Working' : tool.status === 'failed' ? 'Failed' : 'Done';
  // The row above names the agent and its description; the card adds the prompt, the state and the result.
  const top = `<div class="tc-agent"><div class="tc-row-main">${prompt ? `<div class="tc-row-body">${escape(clip(prompt, 200))}</div>` : ''}</div><span class="tc-pill" data-state="${state.toLowerCase()}">${state}</span></div>`;
  return top + (output.trim() ? `<div class="tc-result"><span class="tc-label">Result</span>${excerpt(output, 6)}</div>` : '');
}
/** The row above names the skill and its args; a card appears only for the skill's description. */
function skillCard(output: string): string {
  const first = splitLines(output.trim()).find(line => line.trim()) ?? '';
  const description = /^description:\s*(.+)$/m.exec(output)?.[1] ?? (/^launching skill\b/i.test(first) ? '' : first);
  return description ? `<p class="tc-excerpt">${escape(clip(description, 200))}</p>` : '';
}

// ── PandaCode and MCP tools ──────────────────────────────────────────────────

function pandacodeCard(tool: string, fields: Fields, output: string): string | undefined {
  switch (tool) {
    case 'dispatch_workers': {
      const workers = objects(fields.workers ?? fields.tasks);
      if (!workers.length) return '';
      // The row above already reads `Dispatched 2 workers`.
      return rows(workers.map(w => {
        const name = field(w, 'name', 'title', 'id') || 'Worker';
        return { mark: letterMark(name), title: name, meta: field(w, 'model', 'provider'), body: field(w, 'prompt', 'assignment', 'task', 'description') };
      }), workers.length, 'more workers');
    }
    case 'title': {
      const title = field(fields, 'title');
      return title ? `<div class="tc-title-card"><span class="tc-label">Task title</span><b>${escape(clip(title, 120))}</b></div>` : '';
    }
    case 'design_write': {
      const name = field(fields, 'name', 'file', 'path', 'title') || 'Artboard';
      const html = field(fields, 'html', 'content');
      const size = [field(fields, 'width'), field(fields, 'height')].filter(Boolean).join(' × ');
      return head(iconMark('sketch'), `<b>${escape(clip(name, 80))}</b>`, ['Design artboard', size].filter(Boolean).join(' · '), html ? `<span class="tc-count">${escape(plural(splitLines(html).length, 'line'))}</span>` : '');
    }
    case 'vm_screenshot': {
      const vm = field(fields, 'name', 'vm', 'id') || 'VM';
      const dims = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(output);
      return head(iconMark('monitor'), `<b>${escape(clip(vm, 60))}</b>`, ['Screenshot', dims ? `${dims[1]} × ${dims[2]}` : ''].filter(Boolean).join(' · '));
    }
    case 'preview_file': {
      const path = field(fields, 'path', 'file');
      return path ? fileHead(path, 'Opened in preview') : '';
    }
    case 'run_project': return head(iconMark('play'), '<b>pandacode-run.sh</b>', 'Started run script') + (output.trim() ? excerpt(output, 2) : '');
    default: return undefined;
  }
}
function mcpParts(name: string): { server: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && (/^pandacode/.test(mcp[1]) || /^pandacode_/.test(mcp[2]))) return { server: 'PandaCode', tool: mcp[2].replace(/^pandacode_/, '') };
  if (mcp) return { server: mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' '), tool: mcp[2] };
  return { server: 'PandaCode', tool: name.replace(/^pandacode_architect_/, '').replace(/^pandacode_/, '') };
}
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.every(v => typeof v !== 'object') ? value.join(', ') : plural(value.length, 'item');
  return value && typeof value === 'object' ? plural(Object.keys(value).length, 'field') : '';
}
function keyValues(fields: Fields, cls: string): string {
  const entries = Object.entries(fields).filter(([, v]) => valueText(v) !== '');
  if (!entries.length) return '';
  const shown = entries.slice(0, KEYS).map(([k, v]) => `<dt>${escape(clip(k.replace(/_/g, ' '), 32))}</dt><dd>${escape(clip(valueText(v), 120))}</dd>`).join('');
  return `<dl class="tc-kv ${cls}">${shown}</dl>${more(entries.length - KEYS, 'more fields')}`;
}
/** A JSON record becomes a reference row: title, short meta, right-aligned time, second line. */
function recordRow(item: Fields): Row {
  const title = field(item, 'title', 'name', 'subject', 'summary', 'identifier', 'key', 'id') || clip(valueText(Object.values(item).find(v => typeof v === 'string') ?? ''), 80) || 'Item';
  const link = field(item, 'url', 'link', 'href');
  const meta = field(item, 'from', 'author', 'user', 'repo', 'repository', 'channel', 'state', 'status', 'identifier', 'number') || (link ? domain(link) + urlPath(link) : '');
  const time = clockTime(field(item, 'updated_at', 'updatedAt', 'created_at', 'createdAt', 'date', 'time', 'timestamp', 'ts'));
  const body = field(item, 'snippet', 'preview', 'description', 'body', 'text', 'content', 'message', 'prompt');
  return { mark: letterMark(title), title, meta: meta === title ? '' : meta, time, body: body === title ? '' : body };
}
function recordList(value: unknown): Fields[] {
  if (Array.isArray(value)) return objects(value);
  if (!value || typeof value !== 'object') return [];
  const list = Object.values(value as Fields).find(v => Array.isArray(v) && objects(v).length);
  return list ? objects(list) : [];
}
function mcpCard(tool: CardTool, fields: Fields, output: string): string {
  const { tool: name } = mcpParts(tool.name);
  const json = parseJson(output);
  const records = recordList(json);
  // The row above names the server, the tool and (for searches and reads) the query; the card drops all three.
  const queryKey = mcpAction(name) ? ['query', 'q', 'search', 'filter'].find(key => typeof fields[key] === 'string' && fields[key]) : undefined;
  const input = keyValues(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== queryKey)), 'tc-kv-input');
  const result = records.length ? rows(records.map(recordRow), records.length)
    : json && typeof json === 'object' && !Array.isArray(json) ? keyValues(json as Fields, 'tc-kv-output')
      : output.trim() ? excerpt(output, 5) : '';
  return input + result;
}

// ── States ───────────────────────────────────────────────────────────────────

const RUNNING_LABEL: Partial<Record<TraceKind, string>> = { shell: 'Running command…', read: 'Reading file…', edit: 'Applying edit…', write: 'Writing file…', search: 'Searching…', web: 'Searching the web…', fetch: 'Fetching page…', agent: 'Agent working…', skill: 'Loading skill…', mcp: 'Waiting for result…' };
/** One quiet line where the result will land; a shell keeps its final `$ command` header above it. */
function runningCard(kind: TraceKind, tool: CardTool, fields: Fields): string {
  const line = `<p class="tc-running" role="status">${escape(RUNNING_LABEL[kind] ?? 'Working…')}</p>`;
  const command = kind === 'shell' ? shellCommand(tool.input, fields) : '';
  return command ? `<div class="tc-term">${termHead(command, /vm_exec$/.test(tool.name) ? field(fields, 'name', 'vm') : '')}${line}</div>` : line;
}
function failedCard(tool: CardTool, output: string): string {
  const error = splitLines(stripAnsi(output).trim()).filter(line => line.trim()).slice(0, 4);
  return `<div class="tc-failed" role="alert">${iconMark('alert', 'tc-failed-mark')}<div class="tc-row-main"><div class="tc-row-line"><span class="tc-row-title">Failed</span><span class="tc-row-meta">${escape(clip(tool.name, 60))}</span></div>${error.length ? `<pre class="tc-failed-out">${escape(error.map(line => clip(line, 200)).join('\n'))}</pre>` : ''}</div></div>`;
}

function body(kind: TraceKind, tool: CardTool, fields: Fields, output: string): string {
  switch (kind) {
    case 'shell': return shellCard(tool, fields, output);
    case 'read': return readCard(tool, fields, output);
    case 'write': return writeCard(fields);
    case 'edit': return editCard(tool, fields);
    case 'search': return searchCard(tool, fields, output);
    case 'web': return webCard(fields, output);
    case 'fetch': return fetchCard(fields, output);
    case 'todo': return todoCard(fields);
    case 'agent': return agentCard(tool, fields, output);
    case 'skill': return skillCard(output);
    case 'mcp': {
      const { server, tool: name } = mcpParts(tool.name);
      return (server === 'PandaCode' ? pandacodeCard(name, fields, output) : undefined) ?? mcpCard(tool, fields, output);
    }
    default: return '';
  }
}

/** Escaped HTML for the inside of `.tool-trace-card`, or '' when the kind has nothing better than the raw record. */
export function richCard(tool: CardTool): string {
  const kind = toolKind(tool.name);
  const fields = parseFields(tool.input);
  const output = cleanOutput(tool.output ?? '');
  // Inputs-only kinds (edit, write, todo, agent, plan, title) render their card while running too.
  if (tool.status === 'running' && !output.trim() && !['edit', 'write', 'todo', 'agent'].includes(kind) && !/title$|dispatch_workers$/.test(tool.name)) return `<div class="tc" data-kind="${kind}">${runningCard(kind, tool, fields)}</div>`;
  if (tool.status === 'failed' && kind !== 'shell' && kind !== 'edit' && kind !== 'write') return failedCard(tool, output);
  const html = body(kind, tool, fields, output);
  return html ? `<div class="tc" data-kind="${kind}">${html}</div>` : '';
}
