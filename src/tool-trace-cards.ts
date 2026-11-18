import { escape, icon } from './dom.ts';
import { brandFor } from './trace-brands.ts';
import { exitBadgeHtml, richCard, terminalHeadHtml } from './tool-cards.ts';
import { errorCount, errorCountText, searchFoundNothing } from './tool-trace-outcome.ts';
import { pandacodeCard, pandacodeTool } from './tool-trace-pandacode.ts';
import { fieldsOf, normalizeTool } from './tool-names.ts';
import { type Fields } from './tool-fields.ts';
import { basename, clip, isRecord } from './tool-text.ts';
import { toolImageCardHtml } from './tool-images.ts';
import { lex } from './shell-intent-lex.ts';
import { describeShell, testSummary } from './shell-intent.ts';
import { INTERRUPTED_NOTE, blockedNoteHtml, editFailureHtml, editFailureReason, isInterruptedOutput, stripToolError, withoutInterrupt } from './tool-trace-errors.ts';
import { pandacodeImage, specialCard, testSummaryCard } from './tool-trace-intent.ts';
import { harnessUnstarted } from './tool-trace-refusal.ts';
import type { Tool, TraceKind } from './tool-trace.ts';
import {
  MAX_SCAN, cleanOutput, clipText, describeTool, domain, editLines, exitCode, field, filePath, lines, mcpParts, parseJson, shellCommand, text,
  toolBlocked, toolFailed, traceKind, withReportedFailure,
} from './tool-trace.ts';

/* Result cards for an expanded row (`toolPreview`): terminals, file previews, diffs, search hits, MCP record rows and the
 * key/value fallbacks the PandaCode catalog shares. Pure and escaped. */

const LIST_ITEMS = 6;
const PREVIEW_LINES = 8;
const DIFF_LINES = 14;
const MCP_ROWS = 3;

const LONE_NOTE = /^(<!--trace-partial-->)?<p class="tool-trace-note( is-error| is-blocked)?">[^<]{0,120}<\/p>$/;
/** A card; a lone short note (a screenshot size, an error line) stays an inline result without the bordered plate. */
function card(kind: TraceKind, body: string): string {
  if (!body || body === COMPLETE) return body;
  return LONE_NOTE.test(body) ? body.replace('<p class="tool-trace-note', '<p data-trace-kind="' + kind + '" class="tool-trace-inline tool-trace-note') : `<div class="tool-trace-card" data-trace-kind="${kind}">${body}</div>`;
}
const BADGE_DONE = /^(completed?|done|saved|succeeded|success|resolved|booted|connected|available|delivered|true|passed)$/i;
const BADGE_LIVE = /^(running|in[_ ]progress|starting|working|active|waiting)$/i;
const BADGE_FAIL = /^(failed|error|errored|abandoned|cancell?ed|interrupted|blocked|false)$/i;
/** Status pill: success green, running accent with a still dot, failed red, everything else (queued, stopped, open) neutral. */
/** A status as lowercase words: `Booted` → `booted`, `in_progress` → `in progress`, `Shutdown` → `shut down`. */
function badgeWords(label: string): string {
  const words = label.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words === 'shutdown' ? 'shut down' : words;
}
export function badge(label: string): string {
  if (!label) return '';
  const tone = BADGE_FAIL.test(label) ? ' is-failed' : BADGE_LIVE.test(label) ? ' is-live' : BADGE_DONE.test(label) ? '' : ' is-quiet';
  return `<span class="tool-trace-badge${tone}">${escape(clip(badgeWords(label), 24))}</span>`;
}
export function head(main: string, meta = ''): string {
  return `<div class="tool-trace-card-head">${main}${meta ? `<span class="tool-trace-card-meta">${escape(meta)}</span>` : ''}</div>`;
}
export function linesPre(value: string[], label: string): string {
  return value.length ? `${value.some(line => line.length > 400) ? PARTIAL : ''}<pre class="tool-trace-lines" tabindex="0" aria-label="${escape(label)}">${escape(value.map(line => line.slice(0, 400)).join('\n'))}</pre>` : '';
}
export type ListItem = { title: string; meta?: string; hint?: string; badge?: string };
export function list(items: ListItem[], total = items.length): string {
  if (!items.length) return '';
  const rows = items.slice(0, LIST_ITEMS).map(item => `<li><span class="tool-trace-item-title"${item.hint ? ` title="${escape(item.hint)}"` : ''}>${escape(clip(item.title, 120))}</span>${item.meta ? `<span class="tool-trace-item-meta">${escape(clip(item.meta, 80))}</span>` : ''}${item.badge ? badge(item.badge) : ''}</li>`).join('');
  const more = total - Math.min(items.length, LIST_ITEMS);
  const clipped = more > 0 || items.some(item => item.title.length > 120 || (item.meta?.length ?? 0) > 80);
  return `${clipped ? PARTIAL : ''}<ul class="tool-trace-list">${rows}${more > 0 ? `<li class="tool-trace-more">+${more} more</li>` : ''}</ul>`;
}

function shellCard(tool: Tool, fields: Fields): string {
  return terminalCard(shellCommand(tool.input, fields), cleanOutput(tool.output), tool.status, toolFailed(tool));
}

/** Command line, exit badge and the output's last lines (Codex text or `{exitCode, stdout, stderr}`). Without the row's
 *  outcome, a nonzero exit fails unless a signal stopped it (143/137) or a search found nothing. */
export function terminalCard(command: string, output: string, status: Tool['status'], failedRow?: boolean): string {
  const { code, body } = exitCode(output);
  const failed = failedRow ?? (code !== undefined
    ? code !== 0 && code !== 143 && code !== 137 && !searchFoundNothing(command, code, body) : status === 'failed');
  const pill = exitBadgeHtml(code, failed || (code === undefined && status === 'failed'));
  const all = lines(body.trimEnd());
  if (!command) return '';
  if (status === 'completed' && !all.length && !pill && command.length <= 120) return COMPLETE;
  const partial = all.length > PREVIEW_LINES ? PARTIAL : '';
  return `${partial || command.length > 400 ? PARTIAL : ''}${head(`<code class="tool-trace-command">${escape(clip(command, 400))}</code>${pill}`)}${linesPre(all.slice(-PREVIEW_LINES), 'Command output, last lines')}`;
}

function fileCard(path: string, meta: string, preview: string[], partial = false): string {
  return path ? `${partial ? PARTIAL : ''}${head(`<span class="tool-trace-chip" title="${escape(path)}">${icon('file')}<b>${escape(basename(path))}</b></span>`, meta)}${linesPre(preview, 'File preview')}` : '';
}

function diffCard(tool: Tool, fields: Fields): string {
  const rows: string[] = [];
  for (const edit of editLines(fields)) {
    for (const line of lines(edit.old)) rows.push(`<del>- ${escape(line.slice(0, 300))}</del>`);
    for (const line of lines(edit.new)) rows.push(`<ins>+ ${escape(line.slice(0, 300))}</ins>`);
  }
  const shown = rows.slice(0, DIFF_LINES).join('\n');
  const clipped = rows.length > DIFF_LINES || editLines(fields).some(edit => lines(edit.old + '\n' + edit.new).some(line => line.length > 300));
  const more = rows.length > DIFF_LINES ? `<p class="tool-trace-more">+${rows.length - DIFF_LINES} more lines</p>` : '';
  const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
  // The row already shows the +/− delta.
  return (clipped ? PARTIAL : '') + (path ? fileCard(path, '', []) : '') + (shown ? `<pre class="tool-trace-diff" tabindex="0" aria-label="Edit preview">${shown}</pre>${more}` : '');
}

const SEARCH_NOTICE = /^(?:Found \d+ (?:files?|matches?)|No (?:files|matches) found)/i;
export function searchCard(output: string): string {
  const found = lines(output).map(line => line.trim()).filter(line => line && !SEARCH_NOTICE.test(line));
  // Only `No files found` (or `Found 0 files`): the row's `· no matches` says it all.
  if (!found.length && output.trim() && lines(output).every(line => !line.trim() || SEARCH_NOTICE.test(line.trim()))) return COMPLETE;
  if (!found.length) return output.trim() ? `${output.trim().length > 200 ? PARTIAL : ''}<p class="tool-trace-note">${escape(clip(output, 200))}</p>` : '';
  return list(found.slice(0, LIST_ITEMS).map(line => {
    const [path, ...match] = line.split(':');
    const lineNo = match.length && /^\d+$/.test(match[0] ?? '') ? match[0] : '';
    const meta = lineNo ? match.slice(1).join(':') : match.join(':');
    return { title: basename(path) + (lineNo ? `:${lineNo}` : ''), meta: [path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', meta.trim()].filter(Boolean).join(' · '), hint: line };
  }), found.length);
}

function webResults(output: string): { title: string; url: string }[] {
  const at = output.indexOf('Links:');
  if (at < 0) return [];
  const start = output.indexOf('[', at);
  const end = output.indexOf(']\n', start) > 0 ? output.indexOf(']\n', start) + 1 : output.lastIndexOf(']') + 1;
  try {
    const value: unknown = JSON.parse(output.slice(start, end));
    return Array.isArray(value) ? value.filter((item): item is { title: string; url: string } => typeof item?.title === 'string' && typeof item?.url === 'string') : [];
  } catch { return []; }
}

function webCard(output: string): string {
  const results = webResults(output);
  // The search summary after the links is not shown.
  if (results.length) return PARTIAL + list(results.map(result => ({ title: result.title, meta: domain(result.url), hint: result.url })), results.length);
  return excerptCard(output);
}

function fetchCard(fields: Fields, output: string): string {
  const url = field(fields, 'url');
  const prompt = field(fields, 'prompt');
  const top = url ? head(`<span class="tool-trace-chip" title="${escape(url)}">${icon('globe')}<b>${escape(domain(url))}</b></span>`) : '';
  return (output.length > 600 || prompt.length > 240 ? PARTIAL : '') + top + (prompt ? `<p class="tool-trace-prompt">${escape(clip(prompt, 240))}</p>` : '') + (output.trim() ? `<p class="tool-trace-note">${escape(clip(output, 600))}</p>` : '');
}

function todoCard(fields: Fields): string {
  const todos = (Array.isArray(fields.todos) ? fields.todos : Array.isArray(fields.plan) ? fields.plan : []) as Fields[];
  const items = todos.filter(todo => todo && typeof todo === 'object').slice(0, 12).map(todo => {
    const status = field(todo, 'status');
    return `<li data-status="${escape(status)}">${icon(status === 'completed' ? 'check' : status === 'in_progress' ? 'activity' : 'circle')}<span>${escape(clip(field(todo, 'content', 'step', 'title'), 160))}</span></li>`;
  }).join('');
  const clipped = todos.length > 12 || todos.some(todo => todo && typeof todo === 'object' && field(todo, 'content', 'step', 'title').length > 160);
  return items ? `${clipped ? PARTIAL : ''}<ul class="tool-trace-todos">${items}</ul>` : '';
}

/** Marks a card that shows less than the record, so the row keeps its `Full tool data` disclosure. */
export const PARTIAL = '<!--trace-partial-->';
/** A deliberately empty card: the row already says everything, so there is nothing to expand. */
export const COMPLETE = '<!--trace-complete-->';
export function excerptCard(output: string): string {
  const all = lines(output.trim());
  const pre = linesPre(all.slice(0, PREVIEW_LINES), 'Result preview');
  return pre && all.length > PREVIEW_LINES ? PARTIAL + pre : pre;
}

/** One short value: strings clipped, arrays and objects summarized, never raw nested JSON. */
export function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return clip(value, 120) || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length && value.every(item => typeof item === 'string' || typeof item === 'number')
      ? clip(value.join(', '), 120) : `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }
  const keys = Object.keys(value as object);
  return `{ ${clip(keys.join(', '), 100)} }`;
}

/** Compact key/value table for arguments and JSON results. */
export function kvTable(fields: Fields, label: string, limit = 8): string {
  const entries = Object.entries(fields).filter(([key, value]) => !key.startsWith('_') && value !== undefined && value !== '');
  if (!entries.length) return '';
  const rows = entries.slice(0, limit).map(([key, value]) => `<dt>${escape(clip(key, 40))}</dt><dd>${escape(summarizeValue(value))}</dd>`).join('');
  const more = entries.length > limit ? `<dt class="tool-trace-more">+${entries.length - limit} more</dt><dd></dd>` : '';
  const partial = entries.length > limit || entries.some(([, value]) => value !== null && typeof value === 'object' || typeof value === 'string' && value.length > 120);
  return `${partial ? PARTIAL : ''}<dl class="tool-trace-kv" aria-label="${escape(label)}">${rows}${more}</dl>`;
}

/** A JSON object as a key table, an array as a list, anything else as a text excerpt. */
const TITLE_KEYS = ['name', 'title', 'label', 'summary', 'id'];
/** One generic JSON object as a list row: its best title, then up to two other short scalars. */
function objectItem(item: Fields): ListItem {
  const key = TITLE_KEYS.find(k => typeof item[k] === 'string' && item[k]);
  const meta = Object.entries(item).filter(([k, v]) => k !== key && (typeof v === 'string' && v.length <= 80 || typeof v === 'number'))
    .slice(0, 2).map(([k, v]) => k === 'number' || k === 'id' ? `#${v}` : String(v));
  return { title: key ? String(item[key]) : summarizeValue(item), meta: meta.join(' · ') };
}
function itemList(values: unknown[]): string {
  return list(values.slice(0, LIST_ITEMS).map(item => isRecord(item) ? objectItem(item) : { title: summarizeValue(item) }), values.length);
}
/** A JSON object as a key table (arrays of objects as short item lists), an array as a list, anything else as a text excerpt. */
export function resultCard(output: string): string {
  const json = parseJson(output);
  if (Array.isArray(json)) return PARTIAL + itemList(json);
  if (!isRecord(json)) return excerptCard(output);
  const lists = Object.entries(json).filter(([, v]) => Array.isArray(v) && v.length && v.some(isRecord));
  const scalars = Object.fromEntries(Object.entries(json).filter(([k]) => !lists.some(([l]) => l === k)));
  return kvTable(scalars, 'Result') + (lists.length ? PARTIAL : '') + lists.map(([key, values]) => section(key.replace(/_/g, ' '), itemList(values as unknown[]))).join('');
}

export function section(label: string, body: string): string {
  return body ? `<section class="tool-trace-section"><h5 class="tool-trace-label">${escape(label)}</h5>${body}</section>` : '';
}

/** Arguments and result as key tables: the fallback when an MCP result is not a list of records. */
function argsCard(tool: Tool, fields: Fields, output: string): string {
  const own = pandacodeTool(tool.name);
  if (own) return pandacodeCard(own, fields, output, tool.status) ?? section('Result', resultCard(output));
  const failed = tool.status === 'failed' && output.trim() && parseJson(output) === undefined;
  return section('Arguments', kvTable(fields, 'Arguments')) + (failed ? `${output.length > 400 ? PARTIAL : ''}<p class="tool-trace-note is-error">${escape(clip(output, 400))}</p>` : section('Result', resultCard(output)));
}

function agentCard(tool: Tool, fields: Fields, output: string): string {
  const prompt = field(fields, 'prompt', 'message', 'objective', 'description') || (tool.input.trim().startsWith('{') ? '' : tool.input);
  const model = field(fields, 'model');
  const clipped = prompt.length > 400 || output.length > 600 ? PARTIAL : '';
  // Running: one compact line of model, state and prompt. Finished: the result first, the prompt one click away.
  if (tool.status === 'running') {
    // The row already shows the description; only the model adds anything while it runs.
    return model ? head(`<span class="tool-trace-route">${escape(clip(model, 40))}</span>${badge('running')}`) : '';
  }
  const top = model ? head(`<span class="tool-trace-route">${escape(clip(model, 40))}</span>`) : '';
  const result = output.trim()
    ? tool.status === 'failed' ? `<p class="tool-trace-note is-error">${escape(clipText(output, 600))}</p>` : `<p class="tool-trace-prose">${escape(clipText(output, 600))}</p>`
    : '';
  const promptBox = prompt ? `<details class="tool-trace-aside"><summary>${icon('chevron')}Prompt</summary><p class="tool-trace-prompt">${escape(clipText(prompt, 400))}</p></details>` : '';
  return clipped + top + result + promptBox;
}

// --- MCP result rows (Slack, Granola, Gmail, GitHub, Linear…) ---------------

const LIST_KEYS = ['results', 'messages', 'items', 'issues', 'pull_requests', 'pullRequests', 'pulls', 'threads', 'notes', 'meetings', 'events', 'documents', 'pages', 'files', 'records', 'data'];

/** JSON from the output, unwrapping MCP's `[{ type: 'text', text }]` content blocks. */
function outputJson(output: string): unknown {
  const value = output.trim();
  if (!/^[[{]/.test(value)) return;
  try {
    const parsed: unknown = JSON.parse(value);
    const blocks = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.content) ? parsed.content : undefined;
    if (blocks?.length && blocks.every(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) {
      return outputJson(blocks.map(block => (block as Fields).text).join('\n')) ?? parsed;
    }
    return parsed;
  } catch { return; }
}

function records(value: unknown): { items: Fields[]; collection: string } {
  if (Array.isArray(value)) return { items: value.filter(isRecord), collection: '' };
  if (!isRecord(value)) return { items: [], collection: '' };
  const key = LIST_KEYS.find(name => Array.isArray(value[name])) ?? Object.keys(value).find(name => Array.isArray(value[name]) && (value[name] as unknown[]).some(isRecord));
  return key ? { items: (value[key] as unknown[]).filter(isRecord), collection: key } : { items: [], collection: '' };
}

/** A string, or the readable name of a `{ name | display_name | login | email }` object. */
function label(item: Fields, ...keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    const named = isRecord(value) ? field(value, 'name', 'display_name', 'real_name', 'login', 'email', 'title') : text(value);
    if (named) return named;
  }
  return '';
}

function shortTime(value: string): string {
  const date = /^\d{9,10}(\.\d+)?$/.test(value) ? new Date(Number(value) * 1000) : /^\d{4}-\d\d-\d\d/.test(value) ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return clip(value, 16);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// 16px status marks: GitHub pull requests and Linear-style issue circles.
const ISSUE_MARKS: Record<string, string> = {
  done: '<circle cx="8" cy="8" r="6" fill="currentColor"/><path d="m5.4 8.1 1.8 1.8 3.4-3.6" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  canceled: '<circle cx="8" cy="8" r="6" fill="currentColor"/><path d="m6 6 4 4m0-4-4 4" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round"/>',
  progress: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6a3.4 3.4 0 0 1 0 6.8Z" fill="currentColor"/>',
  todo: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 1.6"/>',
};
function statusMark(state: string, pull: boolean): string {
  const value = state.toLowerCase();
  if (pull) {
    const tone = /merged/.test(value) ? 'merged' : /draft/.test(value) ? 'draft' : /closed/.test(value) ? 'closed' : 'open';
    return `<span class="trace-mark is-pull" data-state="${tone}">${icon(tone === 'merged' ? 'merge' : 'pull')}</span>`;
  }
  const tone = /done|complete|closed|resolved|shipped/.test(value) ? 'done' : /cancel|duplicate|wont/.test(value) ? 'canceled' : /progress|started|doing|review|active/.test(value) ? 'progress' : 'todo';
  return `<span class="trace-mark is-issue" data-state="${tone}"><svg viewBox="0 0 16 16" aria-hidden="true">${ISSUE_MARKS[tone]}</svg></span>`;
}

function mcpRow(item: Fields, collection: string, brandSvg: string | undefined): string {
  const person = label(item, 'from', 'user', 'author', 'sender', 'username', 'user_name', 'owner', 'assignee', 'creator');
  const where = label(item, 'identifier', 'channel', 'channel_name', 'repo', 'repository', 'key', 'project', 'team');
  const titled = label(item, 'title', 'name', 'subject');
  const title = titled || person || where;
  const meta = titled ? person || where : person ? where : '';
  const time = shortTime(label(item, 'ts', 'time', 'date', 'updated_at', 'updatedAt', 'created_at', 'createdAt', 'timestamp', 'start'));
  const body = label(item, 'text', 'snippet', 'body', 'summary', 'description', 'preview', 'content');
  const state = label(item, 'state', 'status');
  const pull = /pull|merge/i.test(collection) || typeof item.merged === 'boolean' || typeof item.draft === 'boolean' || /\/pull\//.test(text(item.url) || text(item.html_url));
  const unread = typeof item.unread === 'boolean' ? item.unread : typeof item.is_unread === 'boolean' ? item.is_unread : undefined;
  const mark = state ? statusMark(state, pull)
    : unread !== undefined ? `<span class="trace-mark is-unread"${unread ? ' data-unread' : ''}></span>`
    : !titled && person ? `<span class="trace-mark is-avatar">${escape(person.trim().charAt(0).toUpperCase())}</span>`
    : `<span class="trace-mark">${brandSvg ?? icon('file')}</span>`;
  if (!title) return '';
  return `<li class="trace-row"${unread ? ' data-unread' : ''}>${mark}<span class="trace-row-head"><b>${escape(clip(title, 120))}</b>${meta ? `<span class="trace-row-meta">${escape(clip(meta, 60))}</span>` : ''}</span>${time ? `<span class="trace-row-time">${escape(time)}</span>` : ''}${body ? `<span class="trace-row-body">${escape(clip(body, 200))}</span>` : ''}</li>`;
}

/** Brand-style result rows for an MCP call's JSON output; empty when the output has no list of records. */
export function mcpCard(tool: Tool): string {
  if (traceKind(tool) !== 'mcp') return '';
  const { server } = mcpParts(tool.name);
  const { items, collection } = records(outputJson(cleanOutput(tool.output)));
  const brand = brandFor(server);
  const rows = items.map(item => mcpRow(item, collection, brand?.svg)).filter(Boolean);
  if (!rows.length) return '';
  const more = rows.length - MCP_ROWS;
  return `<div class="tool-trace-card is-rows" data-trace-kind="mcp"${brand ? ` data-brand="${escape(brand.id)}"` : ''}><ul class="trace-rows">${rows.slice(0, MCP_ROWS).join('')}${more > 0 ? `<li class="tool-trace-more">+${more} more</li>` : ''}</ul></div>`;
}

function previewBody(kind: TraceKind, tool: Tool, fields: Fields, output: string): string {
  switch (kind) {
    case 'shell': return shellCard(tool, fields);
    case 'read': {
      const path = filePath(tool.input, fields);
      const all = lines(output);
      return fileCard(path, all.length ? `${all.length} ${all.length === 1 ? 'line' : 'lines'}` : '', all.slice(0, PREVIEW_LINES), all.length > PREVIEW_LINES);
    }
    case 'write': {
      const content = lines(field(fields, 'content', 'contents'));
      return fileCard(field(fields, 'file_path', 'path', 'filePath'), `New file · ${content.length} lines`, content.slice(0, PREVIEW_LINES), content.length > PREVIEW_LINES);
    }
    case 'edit': return diffCard(tool, fields);
    case 'search': return searchCard(output);
    case 'web': return webCard(output);
    case 'fetch': return fetchCard(fields, output);
    case 'todo': return todoCard(fields);
    case 'agent': return agentCard(tool, fields, output);
    case 'mcp': return argsCard(tool, fields, output);
    // The step row already names the skill and its args; only a description (tool-cards.ts) earns a card.
    case 'skill': return '';
    default: return excerptCard(output);
  }
}

/** A blocked call's card: what it would have run (the terminal every shell card uses), then why the harness refused it. */
function blockedCard(kind: TraceKind, tool: Tool, fields: Fields): string {
  const command = kind === 'shell' ? shellCommand(tool.input, fields) : '';
  const top = command ? `<div class="tc" data-kind="shell"><div class="tc-term is-blocked">${terminalHeadHtml(command)}</div></div>` : '';
  const body = (command.length > 400 ? PARTIAL : '') + top + blockedNoteHtml(tool.output, PARTIAL);
  return top ? `<div class="tool-trace-card" data-trace-kind="${kind}">${body}</div>` : card(kind, body);
}

/** The terminal head every shell outcome card shares (`$ npm test`), toned by its outcome. */
function commandHead(command: string, tone: string): string {
  return command ? `<div class="tc" data-kind="shell"><div class="tc-term ${tone}">${terminalHeadHtml(command)}</div></div>` : '';
}

/** An interrupted call's card: what it was running and anything it printed, then that it never reported. */
function interruptedCard(kind: TraceKind, tool: Tool, fields: Fields): string {
  const output = cleanOutput(withoutInterrupt(tool.output));
  const command = kind === 'shell' ? shellCommand(tool.input, fields) : '';
  const printed = lines(output.trimEnd());
  const shown = kind === 'shell' ? linesPre(printed.slice(-PREVIEW_LINES), 'Command output, last lines') : '';
  const own = kind === 'shell' ? '' : previewBody(kind, { ...tool, status: 'completed', output }, fields, output);
  const body = (printed.length > PREVIEW_LINES ? PARTIAL : '') + commandHead(command, 'is-interrupted') + shown + (own === COMPLETE ? '' : own) + INTERRUPTED_NOTE;
  return `<div class="tool-trace-card" data-trace-kind="${kind}">${body}</div>`;
}

/** A command the harness never started: the command, then the harness's own words for why. */
function unstartedCard(tool: Tool, fields: Fields): string {
  const message = exitCode(stripToolError(tool.output)).body.trim();
  return `<div class="tool-trace-card" data-trace-kind="shell">${commandHead(shellCommand(tool.input, fields), 'is-failed')}${editFailureHtml(message).replace(' tool-trace-why', '')}</div>`;
}

const COUNTED_CHECKS = /^(?:Typecheck failed|Lint found problems|Build failed)$/;
/** A failed typecheck or lint's error count above its terminal (`2 errors`), unless the row already says it. */
function errorCountHtml(trace: { verb: string; object: string }, output: string): string {
  const count = COUNTED_CHECKS.test(trace.verb) ? errorCount(output) : undefined;
  const text = count ? errorCountText(count) : '';
  return text && !trace.object.includes(text) ? `<p class="tool-trace-note is-error tool-trace-error-count">${text}</p>` : '';
}

/** Steps that report rather than run anything, so they never take the blame for an exit. */
const REPORTER = /^\(?\s*(?:cd|echo|printf|true|:|sleep|export|set)\b/;
/** `cargo clippy exited 1`: a compound that failed while its card shows only passing tests names the last step that ran
 *  something, from the command line (the exit is the compound's, so this is the likeliest step, not a certainty). */
function failedStepHtml(command: string, output: string): string {
  const { code, body } = exitCode(output);
  const summary = code ? testSummary(body) : undefined;
  if (!summary || summary.failed) return '';
  let steps: ReturnType<typeof lex> = [];
  try { steps = lex(command); } catch { return ''; }
  const ran = steps.map(step => (step.pipes[0]?.text ?? '').replace(/^\(+\s*/, '')).filter(text => text && !REPORTER.test(text));
  const last = ran[ran.length - 1];
  const label = last ? describeShell(last).label : '';
  return label && label !== 'shell' ? `<p class="tool-trace-note is-error">${escape(clip(label, 48))} exited ${code}</p>` : '';
}

/** A failed call's result without Claude Code's `<tool_use_error>` tags, so no card shows them. */
function withoutErrorTags<T extends Tool>(tool: T): T {
  return tool.status === 'failed' && tool.output.includes('tool_use_error>') ? { ...tool, output: stripToolError(tool.output) } : tool;
}

/** A command the harness never started (`Couldn't start [npm]`, or `Couldn't read [a.rs]` for a lone read). */
function neverStarted(raw: Tool, normal: Tool): boolean {
  return describeTool(raw).verb === "Couldn't start" || harnessUnstarted(shellCommand(normal.input, fieldsOf(normal.input)), normal.output) !== undefined;
}

/** A Devin edit cut at 4 KB before its new text (tool-trace-legacy.ts): what is left is only the old lines. */
const UNRECORDED = '<p class="tool-trace-note">Before (after was not recorded)</p>';

/** Structured, escaped result card for an expanded row; empty when there is nothing better than the raw record. */
export function toolPreview(raw: Tool): string {
  const normal = withReportedFailure(normalizeTool(raw));
  const kind = traceKind(normal);
  if (toolBlocked(normal)) return blockedCard(kind, normal, fieldsOf(normal.input));
  if (isInterruptedOutput(normal.status, normal.output)) return interruptedCard(kind, normal, fieldsOf(normal.input));
  if (kind === 'shell' && neverStarted(raw, normal)) return unstartedCard(normal, fieldsOf(normal.input));
  const tool = withoutErrorTags(normal);
  const fields = fieldsOf(tool.input);
  const output = cleanOutput(tool.output);
  // A card from a cut record shows less than was sent, so the row keeps its `Full tool data` disclosure.
  const cut = tool.output.length > MAX_SCAN || fields._partial === true;
  const special = specialCard(kind, tool, fields, output);
  if (special !== undefined) return card(kind, special && special !== COMPLETE && cut ? PARTIAL + special : special);
  const trace = kind === 'shell' ? describeTool(raw) : undefined;
  const shot = kind === 'mcp' ? pandacodeImage(tool.name, fields, output) : trace?.produced ?? '';
  // A failed edit or write says why it wrote nothing in its row (`· string to replace not found`); its card leads with
  // the error only when the row could not name a reason.
  const failedFile = tool.status === 'failed' && (kind === 'edit' || kind === 'write');
  const why = (failedFile && !editFailureReason(withoutInterrupt(tool.output)) ? editFailureHtml(tool.output) : '')
    + (kind === 'edit' && fields._unrecorded === true ? UNRECORDED : '');
  // A progress snapshot's row already carries its image as a thumbnail; the card holds its note and marks only.
  const cardShot = kind === 'mcp' && pandacodeTool(tool.name) === 'progress_snapshot' ? '' : shot;
  const body = why + (cardShot ? toolImageCardHtml(cardShot) : '') + previewBody(kind, tool, fields, output);
  const own = () => card(kind, body && body !== COMPLETE && cut ? PARTIAL + body : body);
  // A destructive command always opens to the whole command it ran, even with nothing printed.
  if (body === COMPLETE && trace?.destructive) { const rich = richCard(tool); if (rich) return card(kind, rich); }
  // PandaCode's own tools and subagents use the catalog's cards, which mark what they clip; a row that says it all has none.
  if (pandacodeTool(tool.name) || kind === 'agent' || body === COMPLETE) return own();
  // The rich cards (tool-cards.ts) and brand rows are excerpts that never mark what they clip, so they always keep the raw record.
  const rich = richCard(tool);
  // Brand rows for an MCP collection, else the argument/result tables; docs servers read better as rich cards (URLs).
  if (kind === 'mcp' && /docs|context7/i.test(mcpParts(tool.name).server)) return rich ? PARTIAL + card(kind, rich) : own();
  if (kind === 'mcp') { const rows = mcpCard(tool); return rows ? PARTIAL + rows : own(); }
  // A test run leads with its pass/fail summary above the terminal; an image the command wrote leads its card.
  const summary = trace ? testSummaryCard(output) : '';
  const tests = trace ? (summary ? summary + failedStepHtml(shellCommand(tool.input, fields), output) : errorCountHtml(trace, output)) : '';
  const image = shot && kind === 'shell' ? toolImageCardHtml(shot) : '';
  return rich ? PARTIAL + card(kind, why + image + tests + rich) : own();
}
