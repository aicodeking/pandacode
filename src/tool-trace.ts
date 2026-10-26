import type { ToolActivity } from './types';
import { escape, icon } from './dom.ts';
import { brandFor } from './trace-brands.ts';
import { richCard } from './tool-cards.ts';

/** Sentence-style tool traces: `Verb [chip] object` rows, result cards and group summaries. Pure and escaped. */
export type TraceKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'fetch' | 'todo' | 'agent' | 'skill' | 'mcp' | 'tool';
/** `svg` is a brand mark (trusted markup from trace-brands), the only mark drawn inside the chip. */
export type TraceChip = { icon: string; label: string; title: string; svg?: string };
/** `icon` overrides the kind's row icon (an MCP search reads as a search, an MCP read as a page). */
export type Trace = { kind: TraceKind; verb: string; chip?: TraceChip; object: string; icon?: string; mono?: boolean; added?: number; removed?: number };
type Tool = Pick<ToolActivity, 'name' | 'status' | 'input' | 'output'>;
type Fields = Record<string, unknown>;

const MAX_SCAN = 20_000;
const MAX_TEXT = 140;
const LIST_ITEMS = 6;
const PREVIEW_LINES = 8;
const DIFF_LINES = 14;
const MCP_ROWS = 3;
const OMITTED = '[Non-text content omitted]';

// [running verb, finished verb, row icon, summary noun singular, plural]
const KINDS: Record<TraceKind, [string, string, string, string, string]> = {
  shell: ['Running', 'Ran', 'terminal', 'command', 'commands'],
  read: ['Reading', 'Read', 'file', 'file', 'files'],
  edit: ['Editing', 'Edited', 'edit', 'file', 'files'],
  write: ['Writing', 'Wrote', 'plus', 'file', 'files'],
  search: ['Searching', 'Searched', 'search', 'search', 'searches'],
  web: ['Searching', 'Searched', 'globe', 'search', 'searches'],
  fetch: ['Fetching', 'Fetched', 'external', 'page', 'pages'],
  todo: ['Updating', 'Updated', 'check', 'plan', 'plans'],
  agent: ['Starting', 'Started', 'bot', 'agent', 'agents'],
  skill: ['Loading', 'Loaded', 'spark', 'skill', 'skills'],
  mcp: ['Using', 'Used', 'server', 'tool', 'tools'],
  tool: ['Using', 'Used', 'command', 'tool', 'tools'],
};
// Summary phrasing: searches read as "Ran 2 searches" like the reference, the rest keep their row verb.
const SUMMARY_VERB: Partial<Record<TraceKind, [string, string]>> = { search: ['Running', 'Ran'], web: ['Running', 'Ran'] };

export function kindIcon(kind: TraceKind): string { return KINDS[kind][2]; }

function clip(value: string, limit = MAX_TEXT): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
}
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
function text(value: unknown): string { return typeof value === 'string' ? value : Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join(' ') : ''; }
function field(fields: Fields, ...keys: string[]): string {
  for (const key of keys) { const value = text(fields[key]); if (value) return value; }
  return '';
}
function lines(value: string): string[] { return value ? value.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : []; }
function cleanOutput(output: string): string { return output.trim() === OMITTED ? '' : output.slice(0, MAX_SCAN); }

export function parseFields(input: string): Fields {
  const value = input.slice(0, MAX_SCAN).trim();
  if (!value.startsWith('{')) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Fields : {};
  } catch { return {}; }
}

export function toolKind(name: string): TraceKind {
  const n = name.toLowerCase().replace(/^pandacode_architect_/, '');
  if (/^(bash|shell|command|exec_command|local_shell|run_terminal_cmd|pandacode_vm_exec)$/.test(n)) return 'shell';
  if (/^(read|read_file|view|readfile)$/.test(n)) return 'read';
  if (/^(edit|multiedit|multi_edit|str_replace\w*|apply_patch|patch)$/.test(n)) return 'edit';
  if (/^(write|write_file|create|create_file)$/.test(n)) return 'write';
  if (/^(grep|glob|search|find|ls|list|list_dir|codebase_search|file_search)$/.test(n)) return 'search';
  if (/^web_?search$/.test(n)) return 'web';
  if (/^(web_?fetch|fetch)$/.test(n)) return 'fetch';
  if (/^(todowrite|todo_write|update_plan)$/.test(n)) return 'todo';
  if (/^(task|agent)$/.test(n)) return 'agent';
  if (n === 'skill') return 'skill';
  if (n.startsWith('mcp__') || n.startsWith('pandacode_')) return 'mcp';
  return 'tool';
}

/** Codex records plain text: `/bin/zsh -lc "cmd"\nWorking directory: …`. */
export function shellCommand(input: string, fields: Fields): string {
  const command = field(fields, 'command', 'cmd') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped ? wrapped[2] : command).trim();
}

function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, 60); }
}

function editLines(fields: Fields): { old: string; new: string }[] {
  const edits = Array.isArray(fields.edits) ? fields.edits as Fields[] : [fields];
  return edits.filter(edit => edit && typeof edit === 'object')
    .map(edit => ({ old: field(edit, 'old_string', 'oldText', 'old_str'), new: field(edit, 'new_string', 'newText', 'new_str', 'content') }));
}
function diffCounts(fields: Fields): { added: number; removed: number } {
  return editLines(fields).reduce((sum, edit) => ({ added: sum.added + lines(edit.new).length, removed: sum.removed + lines(edit.old).length }), { added: 0, removed: 0 });
}

function filePath(input: string, fields: Fields): string {
  return field(fields, 'file_path', 'path', 'filePath', 'target_file') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');
}

function fileChip(path: string): TraceChip | undefined {
  return path ? { icon: 'file', label: basename(path), title: path } : undefined;
}

const MCP_VERB = '(search|find|query|lookup|get|list|read|fetch|retrieve|view|show|load)';
/** What an MCP tool does, from its name: `search_messages` searches, `list_issues` reads. */
export function mcpAction(tool: string): 'search' | 'read' | undefined {
  if (/(^|_)(search|find|query|lookup)(_|$)/i.test(tool)) return 'search';
  if (new RegExp(`(^|_)${MCP_VERB}(_|$)`, 'i').test(tool)) return 'read';
  return;
}
function mcpNoun(tool: string): string {
  return tool.replace(new RegExp(`^.*?${MCP_VERB}_`, 'i'), '').replace(/_/g, ' ');
}

function mcpParts(name: string): { server: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  // PandaCode's own MCP server (`mcp__pandacode_architect__pandacode_title`) reads as PandaCode.
  if (mcp && !/^pandacode(_|$)/i.test(mcp[1])) return { server: mcp[1], tool: mcp[2] };
  if (mcp) return { server: 'PandaCode', tool: mcp[2].replace(/^pandacode_/, '') };
  const local = name.replace(/^pandacode_architect_/, '').replace(/^pandacode_/, '');
  return { server: 'PandaCode', tool: local };
}

/** `Dispatched 2 workers`-style verbs for PandaCode's own tools; undefined keeps the generic `Used [server] tool`. */
function pandacodeTrace(tool: string, fields: Fields): Partial<Trace> | undefined {
  const workers = Array.isArray(fields.workers) ? fields.workers.length : Array.isArray(fields.tasks) ? fields.tasks.length : 0;
  if (tool === 'dispatch_workers') return { verb: 'Dispatched', object: workers ? `${workers} ${workers === 1 ? 'worker' : 'workers'}` : 'workers' };
  if (tool === 'title') return { verb: 'Named', object: field(fields, 'title') ? `the task “${clip(field(fields, 'title'), 60)}”` : 'the task' };
  return;
}

function describeFields(kind: TraceKind, name: string, input: string, fields: Fields): Omit<Trace, 'kind' | 'verb'> & { verb?: string } {
  switch (kind) {
    case 'shell': {
      const command = shellCommand(input, fields);
      const [program = '', ...rest] = command.split(/\s+/);
      return program ? { chip: { icon: 'terminal', label: basename(program), title: command }, object: clip(rest.join(' ')), mono: true } : { object: field(fields, 'description') };
    }
    case 'read': case 'write': {
      const path = filePath(input, fields);
      const content = field(fields, 'content', 'contents');
      const count = lines(content).length;
      return { chip: fileChip(path), object: kind === 'write' && content ? `${count} ${count === 1 ? 'line' : 'lines'}` : '' };
    }
    case 'edit': {
      const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
      return { chip: fileChip(path), object: '', ...diffCounts(fields) };
    }
    case 'search': {
      const where = field(fields, 'path', 'directory', 'target_directory');
      const pattern = field(fields, 'pattern', 'query', 'glob', 'regex');
      const glob = /glob|ls|list/.test(name.toLowerCase());
      return { chip: { icon: glob ? 'folder' : 'search', label: where ? basename(where) : 'workspace', title: where || 'workspace' }, object: pattern ? `${glob ? 'for files matching' : 'for'} ${clip(pattern, 80)}` : '' };
    }
    case 'web': return { chip: { icon: 'globe', label: 'Web', title: 'Web search' }, object: field(fields, 'query', 'q') ? `for ${clip(field(fields, 'query', 'q'))}` : '' };
    case 'fetch': {
      const url = field(fields, 'url');
      return { chip: url ? { icon: 'globe', label: domain(url), title: url, svg: brandFor(url)?.svg } : undefined, object: clip(field(fields, 'prompt'), 90) };
    }
    case 'todo': {
      const todos = Array.isArray(fields.todos) ? fields.todos.length : Array.isArray(fields.plan) ? fields.plan.length : 0;
      return { object: todos ? `the plan · ${todos} ${todos === 1 ? 'step' : 'steps'}` : 'the plan' };
    }
    case 'agent': {
      const type = field(fields, 'subagent_type', 'agent');
      return { chip: { icon: 'bot', label: type || 'agent', title: type || 'agent' }, object: clip(field(fields, 'description', 'prompt'), 90) };
    }
    case 'skill': {
      const skill = field(fields, 'skill', 'name', 'command');
      return { verb: 'Loaded skill', chip: skill ? { icon: 'spark', label: skill, title: skill } : undefined, object: clip(field(fields, 'args', 'arguments'), 80), mono: true };
    }
    case 'mcp': {
      const { server, tool } = mcpParts(name);
      const own = server === 'PandaCode' ? pandacodeTrace(tool, fields) : undefined;
      if (own) return { chip: { icon: 'server', label: 'PandaCode', title: name }, object: '', ...own };
      const brand = brandFor(server);
      const chip = { icon: 'server', label: brand?.label ?? server, title: name, svg: brand?.svg };
      const action = mcpAction(tool);
      const query = clip(field(fields, 'query', 'q', 'search', 'filter'), 80);
      if (action === 'search') return { verb: 'Searched', icon: 'search', chip, object: `for ${query || mcpNoun(tool)}` };
      if (action === 'read') return { verb: 'Read the', icon: 'file', chip, object: query || mcpNoun(tool) };
      return { chip, object: tool.replace(/_/g, ' ') };
    }
    default: return { chip: { icon: 'command', label: name || 'Tool', title: name || 'Tool' }, object: inputHint(input) };
  }
}

export function inputHint(input: string): string {
  const fields = parseFields(input);
  const value = input.trim().startsWith('{')
    ? field(fields, 'command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'url', 'pattern', 'description')
    : input.trim().split('\n', 1)[0] ?? '';
  return clip(value, 96);
}

export function describeTool(tool: Tool): Trace {
  const kind = toolKind(tool.name);
  const fields = parseFields(tool.input);
  const described = describeFields(kind, tool.name, tool.input, fields);
  // Rows read as finished sentences even while they run, like the reference; the shimmer marks the running step.
  return { ...described, kind, verb: described.verb ?? KINDS[kind][1] };
}

/** One escaped sentence for a row's summary: verb, chip, object and edit delta. */
export function traceRowHtml(trace: Trace): string {
  // Only a brand mark rides inside the chip; a line icon would repeat the row's own kind icon.
  const chip = trace.chip ? `<span class="tool-trace-chip" title="${escape(trace.chip.title)}">${trace.chip.svg ?? ''}<b>${escape(trace.chip.label)}</b></span>` : '';
  const object = trace.object ? `<span class="tool-trace-object${trace.mono ? ' is-mono' : ''}">${escape(trace.object)}</span>` : '';
  const delta = trace.added !== undefined ? `<span class="tool-trace-delta"><ins>+${trace.added}</ins> <del>−${trace.removed ?? 0}</del></span>` : '';
  return `<span class="tool-trace-verb">${escape(trace.verb)}</span>${chip}${object}${delta}`;
}

function joinPhrases(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

type SummaryPart = { verb: [string, string]; key: string; nouns: [string, string] };
/** MCP searches count with searches and MCP reads as sources: `Ran 2 searches and read 3 sources`. */
function summaryPart(tool: Tool | undefined): SummaryPart {
  const kind = tool ? toolKind(tool.name) : 'tool';
  const action = tool && kind === 'mcp' ? mcpAction(mcpParts(tool.name).tool) : undefined;
  if (action === 'search') return { verb: ['Running', 'Ran'], key: 'search', nouns: ['search', 'searches'] };
  if (action === 'read') return { verb: ['Reading', 'Read'], key: 'source', nouns: ['source', 'sources'] };
  const [run, done, , one, many] = KINDS[kind];
  return { verb: SUMMARY_VERB[kind] ?? [run, done], key: kind === 'web' ? 'search' : kind, nouns: [one, many] };
}

// A summary names at most this many counts; the rest read as `and N more`, so it stays one line.
const SUMMARY_CLAUSES = 2;
/** `Ran 3 commands, read 2 files and 1 more`. Present tense only for a live turn with a call still running
 * (a saved record can be stuck at `running`); failures are appended after ` · `. */
export function summarizeTools(tools: (Tool | undefined)[], options: { live?: boolean } = {}): string {
  const running = Boolean(options.live) && tools.some(tool => tool?.status === 'running');
  const failed = tools.filter(tool => tool?.status === 'failed').length;
  const clauses = new Map<string, { verb: string; count: number; nouns: [string, string] }>();
  for (const tool of tools) {
    const part = summaryPart(tool);
    const verb = part.verb[running ? 0 : 1], id = `${verb}:${part.key}`;
    clauses.set(id, { verb, count: (clauses.get(id)?.count ?? 0) + 1, nouns: part.key === 'todo' ? ['the plan', 'the plan'] : part.nouns });
  }
  const shown = [...clauses.values()].slice(0, SUMMARY_CLAUSES);
  const rest = tools.length - shown.reduce((sum, clause) => sum + clause.count, 0);
  const byVerb = new Map<string, string[]>();
  for (const { verb, count, nouns: [one, many] } of shown) byVerb.set(verb, [...byVerb.get(verb) ?? [], one === 'the plan' ? one : `${count} ${count === 1 ? one : many}`]);
  const phrases = [...byVerb].map(([verb, nouns]) => `${verb.toLowerCase()} ${joinPhrases(nouns)}`);
  const sentence = rest > 0 ? `${phrases.join(', ')} and ${rest} more ${rest === 1 ? 'step' : 'steps'}` : joinPhrases(phrases);
  return (sentence.charAt(0).toUpperCase() + sentence.slice(1)) + (running ? '…' : '') + (failed ? ` · ${failed} failed` : '');
}

/** Up to `limit` distinct marks for the folded header: brand logos for MCP servers, else the kind's line icon. */
export function summaryIcons(tools: (Tool | undefined)[], limit = 3): string[] {
  const marks = new Map<string, string>();
  for (const tool of tools) {
    const kind = tool ? toolKind(tool.name) : 'tool';
    const brand = tool && kind === 'mcp' ? brandFor(mcpParts(tool.name).server) : undefined;
    const id = brand ? 'brand:' + brand.id : kindIcon(kind);
    if (!marks.has(id)) marks.set(id, brand?.svg ?? icon(kindIcon(kind)));
  }
  return [...marks.values()].slice(0, limit);
}

// --- Cards ---------------------------------------------------------------

function card(kind: TraceKind, body: string): string { return body ? `<div class="tool-trace-card" data-trace-kind="${kind}">${body}</div>` : ''; }
function head(main: string, meta = ''): string {
  return `<div class="tool-trace-card-head">${main}${meta ? `<span class="tool-trace-card-meta">${escape(meta)}</span>` : ''}</div>`;
}
function linesPre(value: string[], label: string): string {
  return value.length ? `<pre class="tool-trace-lines" tabindex="0" aria-label="${escape(label)}">${escape(value.map(line => line.slice(0, 400)).join('\n'))}</pre>` : '';
}
function list(items: { title: string; meta?: string; hint?: string }[], total = items.length): string {
  if (!items.length) return '';
  const rows = items.slice(0, LIST_ITEMS).map(item => `<li><span class="tool-trace-item-title"${item.hint ? ` title="${escape(item.hint)}"` : ''}>${escape(clip(item.title, 120))}</span>${item.meta ? `<span class="tool-trace-item-meta">${escape(clip(item.meta, 80))}</span>` : ''}</li>`).join('');
  const more = total - Math.min(items.length, LIST_ITEMS);
  return `<ul class="tool-trace-list">${rows}${more > 0 ? `<li class="tool-trace-more">+${more} more</li>` : ''}</ul>`;
}

function exitCode(output: string): { code?: number; body: string } {
  const codex = /^Exit code: (-?\d+)\n?/.exec(output);
  if (codex) return { code: Number(codex[1]), body: output.slice(codex[0].length).replace(/^Wall time:.*\n?/, '').replace(/^Output:\n?/, '') };
  const json = parseFields(output);
  if (typeof json.exitCode === 'number') return { code: json.exitCode, body: [text(json.stdout), text(json.stderr)].filter(Boolean).join('\n') };
  return { body: output };
}

function shellCard(tool: Tool, fields: Fields): string {
  const command = shellCommand(tool.input, fields);
  const { code, body } = exitCode(cleanOutput(tool.output));
  const failed = code !== undefined ? code !== 0 : tool.status === 'failed';
  const badge = code !== undefined || tool.status === 'failed'
    ? `<span class="tool-trace-badge${failed ? ' is-failed' : ''}">${escape(code !== undefined ? `exit ${code}` : 'failed')}</span>` : '';
  const tail = lines(body.trimEnd()).slice(-PREVIEW_LINES);
  return command ? `${head(`<code class="tool-trace-command">${escape(clip(command, 400))}</code>${badge}`)}${linesPre(tail, 'Command output, last lines')}` : '';
}

function fileCard(path: string, meta: string, preview: string[]): string {
  return path ? `${head(`<span class="tool-trace-chip" title="${escape(path)}">${icon('file')}<b>${escape(basename(path))}</b></span>`, meta)}${linesPre(preview, 'File preview')}` : '';
}

function diffCard(tool: Tool, fields: Fields): string {
  const rows: string[] = [];
  for (const edit of editLines(fields)) {
    for (const line of lines(edit.old)) rows.push(`<del>- ${escape(line.slice(0, 300))}</del>`);
    for (const line of lines(edit.new)) rows.push(`<ins>+ ${escape(line.slice(0, 300))}</ins>`);
  }
  const shown = rows.slice(0, DIFF_LINES).join('\n');
  const more = rows.length > DIFF_LINES ? `<p class="tool-trace-more">+${rows.length - DIFF_LINES} more lines</p>` : '';
  const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
  // The row already shows the +/− delta.
  return (path ? fileCard(path, '', []) : '') + (shown ? `<pre class="tool-trace-diff" tabindex="0" aria-label="Edit preview">${shown}</pre>${more}` : '');
}

function searchCard(output: string): string {
  const found = lines(output).map(line => line.trim()).filter(line => line && !/^Found \d+ (files?|matches?)/i.test(line) && !/^No (files|matches) found/i.test(line));
  if (!found.length) return output.trim() ? `<p class="tool-trace-note">${escape(clip(output, 200))}</p>` : '';
  return list(found.slice(0, LIST_ITEMS).map(line => {
    const [path, ...match] = line.split(':');
    const meta = match.length && /^\d+$/.test(match[0] ?? '') ? match.slice(1).join(':') : match.join(':');
    return { title: basename(path), meta: [path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', meta].filter(Boolean).join(' · '), hint: line };
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
  if (results.length) return list(results.map(result => ({ title: result.title, meta: domain(result.url), hint: result.url })), results.length);
  return excerptCard(output);
}

function fetchCard(fields: Fields, output: string): string {
  const url = field(fields, 'url');
  const prompt = field(fields, 'prompt');
  const top = url ? head(`<span class="tool-trace-chip" title="${escape(url)}">${icon('globe')}<b>${escape(domain(url))}</b></span>`) : '';
  return top + (prompt ? `<p class="tool-trace-prompt">${escape(clip(prompt, 240))}</p>` : '') + (output.trim() ? `<p class="tool-trace-note">${escape(clip(output, 600))}</p>` : '');
}

function todoCard(fields: Fields): string {
  const todos = (Array.isArray(fields.todos) ? fields.todos : Array.isArray(fields.plan) ? fields.plan : []) as Fields[];
  const items = todos.filter(todo => todo && typeof todo === 'object').slice(0, 12).map(todo => {
    const status = field(todo, 'status');
    return `<li data-status="${escape(status)}">${icon(status === 'completed' ? 'check' : status === 'in_progress' ? 'activity' : 'circle')}<span>${escape(clip(field(todo, 'content', 'step', 'title'), 160))}</span></li>`;
  }).join('');
  return items ? `<ul class="tool-trace-todos">${items}</ul>` : '';
}

function excerptCard(output: string): string {
  return linesPre(lines(output.trim()).slice(0, PREVIEW_LINES), 'Result preview');
}

// --- MCP result rows (Slack, Granola, Gmail, GitHub, Linear…) ---------------

const LIST_KEYS = ['results', 'messages', 'items', 'issues', 'pull_requests', 'pullRequests', 'pulls', 'threads', 'notes', 'meetings', 'events', 'documents', 'pages', 'files', 'records', 'data'];
const isRecord = (value: unknown): value is Fields => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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
  if (toolKind(tool.name) !== 'mcp') return '';
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
      return fileCard(path, all.length ? `${all.length} ${all.length === 1 ? 'line' : 'lines'}` : '', all.slice(0, PREVIEW_LINES));
    }
    case 'write': {
      const content = lines(field(fields, 'content', 'contents'));
      return fileCard(field(fields, 'file_path', 'path', 'filePath'), `New file · ${content.length} lines`, content.slice(0, PREVIEW_LINES));
    }
    case 'edit': return diffCard(tool, fields);
    case 'search': return searchCard(output);
    case 'web': return webCard(output);
    case 'fetch': return fetchCard(fields, output);
    case 'todo': return todoCard(fields);
    // The step row already names the skill and its args; only a description (tool-cards.ts) earns a card.
    case 'skill': return '';
    default: return excerptCard(output);
  }
}

/** Structured, escaped result card for an expanded row; empty when there is nothing better than the raw record. */
export function toolPreview(tool: Tool): string {
  const kind = toolKind(tool.name);
  // Every kind shares the card chrome; the rich card (tool-cards.ts) fills it when it has something.
  // PandaCode's own tools (workers, prompts, models) and docs servers (URLs) read better as rich cards than brand rows.
  const rich = () => card(kind, richCard(tool) || previewBody(kind, tool, parseFields(tool.input), cleanOutput(tool.output)));
  return richFirst(tool.name) ? rich() || mcpCard(tool) : mcpCard(tool) || rich();
}
function richFirst(name: string): boolean {
  if (toolKind(name) !== 'mcp') return false;
  const { server } = mcpParts(name);
  return server === 'PandaCode' || /docs|context7/i.test(server);
}
