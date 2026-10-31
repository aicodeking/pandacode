// Tool traces as the desktop draws them (src/tool-trace.ts, src/tool-activity.ts, src/subagents.ts):
// a kind per tool, a one-line sentence, edit diffs, todo lists and subagent snapshots. Pure (tested in node).
import type { ToolActivity } from '../connect/types.ts';
import { ownSentence, ownTool, type WorkerNames } from './pandacode-tools.ts';

export type TraceKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'fetch' | 'todo' | 'agent' | 'skill' | 'mcp' | 'tool';
/** `own`: one of PandaCode's own tools (`dispatch_workers`, `title`…), for its icon and card. */
export interface Trace { kind: TraceKind; verb: string; chip: string; object: string; added?: number; removed?: number; own?: string }
export type DiffLine = { kind: 'add' | 'del'; text: string };
export interface Todo { text: string; status: 'pending' | 'in_progress' | 'completed' | (string & {}) }
export interface Subagent {
  id: string; name: string; prompt: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
  response: string; tools: ToolActivity[]; startedAt: number; updatedAt: number;
}
type Fields = Record<string, unknown>;

const MAX_SCAN = 20_000;
const MAX_CHIP = 60;
const MAX_OBJECT = 120;
export const DIFF_LINES = 14;

// [running verb, finished verb]
const VERBS: Record<TraceKind, [string, string]> = {
  shell: ['Running', 'Ran'], read: ['Reading', 'Read'], edit: ['Editing', 'Edited'], write: ['Writing', 'Wrote'],
  search: ['Searching', 'Searched'], web: ['Searching', 'Searched'], fetch: ['Fetching', 'Fetched'], todo: ['Updating', 'Updated'],
  agent: ['Starting', 'Started'], skill: ['Loading skill', 'Loaded skill'], mcp: ['Using', 'Used'], tool: ['Using', 'Used'],
};

const clip = (value: string, limit: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
export const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const field = (fields: Fields, ...keys: string[]) => keys.map(k => text(fields[k])).find(Boolean) ?? '';
const lines = (value: string) => (value ? value.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : []);

/** The tool's JSON input as an object ({} for plain text). */
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

const filePath = (input: string, fields: Fields) =>
  field(fields, 'file_path', 'path', 'filePath', 'target_file') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');

function edits(fields: Fields): { old: string; new: string }[] {
  const list = Array.isArray(fields.edits) ? fields.edits as Fields[] : [fields];
  return list.filter(e => e && typeof e === 'object').map(e => ({ old: field(e, 'old_string', 'oldText', 'old_str'), new: field(e, 'new_string', 'newText', 'new_str', 'content') }));
}

/** The edit's removed then added lines, as the desktop's diff card shows them. */
export function diffLines(fields: Fields): DiffLine[] {
  return edits(fields).flatMap(e => [
    ...lines(e.old).map(l => ({ kind: 'del' as const, text: l.slice(0, 300) })),
    ...lines(e.new).map(l => ({ kind: 'add' as const, text: l.slice(0, 300) })),
  ]);
}

/** TodoWrite `todos` or Codex `update_plan` `plan`. */
export function todosOf(fields: Fields): Todo[] {
  const list = Array.isArray(fields.todos) ? fields.todos : Array.isArray(fields.plan) ? fields.plan : [];
  return (list as Fields[]).filter(t => t && typeof t === 'object').slice(0, 30)
    .map(t => ({ text: clip(field(t, 'content', 'step', 'title'), 200), status: field(t, 'status') || 'pending' }))
    .filter(t => t.text);
}

const domain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, MAX_CHIP); } };

export function mcpParts(name: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? { server: mcp[1], tool: mcp[2] } : { server: 'PandaCode', tool: name.replace(/^pandacode_architect_/, '').replace(/^pandacode_/, '') };
}

export function inputHint(input: string): string {
  const fields = parseFields(input);
  const value = input.trim().startsWith('{')
    ? field(fields, 'command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'url', 'pattern', 'description')
    : input.trim().split('\n', 1)[0] ?? '';
  return clip(value, MAX_OBJECT);
}

/** `Ran [npm] test -- upload`, `Edited [auth.ts] +4 −1`, `Dispatched 3 workers`: the row's sentence. */
export function describeTool(tool: Pick<ToolActivity, 'name' | 'status' | 'input'>, fields = parseFields(tool.input), names?: WorkerNames): Trace {
  const kind = toolKind(tool.name);
  const verb = VERBS[kind][tool.status === 'running' ? 0 : 1];
  const own = kind === 'mcp' ? ownTool(tool.name) : undefined;
  const sentence = own ? ownSentence(own, fields, tool.status === 'running', names) : undefined;
  if (sentence) return { kind, ...sentence, chip: '', own };
  const base = { kind, verb };
  switch (kind) {
    case 'shell': {
      const [program = '', ...rest] = shellCommand(tool.input, fields).split(/\s+/);
      return { ...base, chip: basename(program), object: clip(rest.join(' '), MAX_OBJECT) || (program ? '' : clip(field(fields, 'description'), MAX_OBJECT)) };
    }
    case 'read': case 'write': {
      const content = field(fields, 'content', 'contents');
      return { ...base, chip: basename(filePath(tool.input, fields)), object: kind === 'write' && content ? `${lines(content).length} lines` : '' };
    }
    case 'edit': {
      const diff = diffLines(fields);
      return { ...base, chip: basename(filePath(tool.input, fields)), object: '', added: diff.filter(d => d.kind === 'add').length, removed: diff.filter(d => d.kind === 'del').length };
    }
    case 'search': {
      const where = field(fields, 'path', 'directory', 'target_directory');
      const pattern = field(fields, 'pattern', 'query', 'glob', 'regex') || (tool.input.trim().startsWith('{') ? '' : tool.input.trim());
      return { ...base, chip: where ? basename(where) : 'workspace', object: pattern ? `for ${clip(pattern, 80)}` : '' };
    }
    case 'web': return { ...base, chip: 'Web', object: field(fields, 'query', 'q') ? `for ${clip(field(fields, 'query', 'q'), MAX_OBJECT)}` : inputHint(tool.input) };
    case 'fetch': { const url = field(fields, 'url'); return { ...base, chip: url ? domain(url) : '', object: clip(field(fields, 'prompt'), 90) }; }
    case 'todo': { const n = todosOf(fields).length; return { ...base, chip: '', object: n ? `the plan · ${n} ${n === 1 ? 'step' : 'steps'}` : 'the plan' }; }
    case 'agent': return { ...base, chip: field(fields, 'subagent_type', 'agent') || 'agent', object: clip(field(fields, 'description', 'prompt'), 90) };
    case 'skill': return { ...base, chip: field(fields, 'skill', 'name', 'command'), object: '' };
    case 'mcp': {
      const { server, tool: t } = mcpParts(tool.name);
      const name = (own ?? t).replace(/_/g, ' ');
      return { ...base, chip: own ? `PandaCode › ${name}` : `${server} › ${name}`, object: inputHint(tool.input), ...(own ? { own } : {}) };
    }
    default: return { ...base, chip: tool.name || 'Tool', object: inputHint(tool.input) };
  }
}

/** The trace as one plain line: `Dispatched 3 workers`, `Ran npm test`. */
export const traceText = (t: Trace) => [t.verb, t.chip, t.object].filter(Boolean).join(' ');

/** A shell result's exit code (Codex `Exit code: N` or JSON `exitCode`) and the rest. */
export function exitCode(output: string): { code?: number; body: string } {
  const codex = /^Exit code: (-?\d+)\n?/.exec(output);
  if (codex) return { code: Number(codex[1]), body: output.slice(codex[0].length).replace(/^Wall time:.*\n?/, '').replace(/^Output:\n?/, '') };
  const json = parseFields(output);
  if (typeof json.exitCode === 'number') return { code: json.exitCode, body: [text(json.stdout), text(json.stderr)].filter(Boolean).join('\n') };
  return { body: output };
}

/** A stored tool message: the desktop's versioned `tool_activity` record, or older plain JSON. */
export function parseToolMessage(content: string): ToolActivity {
  try {
    const t = JSON.parse(content);
    if (t && typeof t === 'object') {
      return { id: String(t.id ?? ''), name: String(t.name ?? t.title ?? 'Tool').slice(0, 256), status: t.status === 'failed' ? 'failed' : t.status === 'running' ? 'running' : 'completed', input: String(t.input ?? ''), output: String(t.output ?? '') };
    }
  } catch { /* plain text below */ }
  const [name, ...rest] = content.split('\n');
  return { id: '', name: name.slice(0, 256) || 'Tool', status: 'completed', input: '', output: rest.join('\n') };
}

const SUB_STATUS = ['running', 'waiting', 'completed', 'failed', 'stopped'];
const TOOL_STATUS = ['running', 'completed', 'failed'];

/** A subagent snapshot from a `subagent` event or a host snapshot; undefined when malformed (as decode() in src/subagents.ts). */
export function decodeSubagent(value: unknown): Subagent | undefined {
  if (!value || typeof value !== 'object') return;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !SUB_STATUS.includes(a.status as string)) return;
  const tools = (Array.isArray(a.tools) ? a.tools : []).slice(-16)
    .filter((t): t is ToolActivity => !!t && typeof t.id === 'string' && typeof t.name === 'string' && TOOL_STATUS.includes(t.status))
    .map(t => ({ id: t.id.slice(0, 512), name: t.name.slice(0, 256), status: t.status, input: String(t.input ?? '').slice(0, 4096), output: String(t.output ?? '').slice(0, 8192) }));
  return {
    id: a.id.slice(0, 512), name: a.name.slice(0, 256), prompt: String(a.prompt ?? '').slice(0, 4096), status: a.status as Subagent['status'],
    response: String(a.response ?? '').slice(0, 65_536), tools, startedAt: Number(a.startedAt) || 0, updatedAt: Number(a.updatedAt) || 0,
  };
}

export const subagentActive = (a: Subagent) => a.status === 'running' || a.status === 'waiting';

/** The subagent's title: its name unless that is a path or a generic word, else its prompt's first line. */
export function subagentName(a: Subagent): string {
  const name = a.name.trim();
  return name && !/[\\/]/.test(name) && !/^(?:subagent|agent)$/i.test(name) ? name : clip(a.prompt.split('\n', 1)[0] ?? '', 60) || 'Subagent';
}

// Summary nouns per kind: [singular, plural]
const NOUNS: Record<TraceKind, [string, string]> = {
  shell: ['command', 'commands'], read: ['file', 'files'], edit: ['file', 'files'], write: ['file', 'files'], search: ['search', 'searches'],
  web: ['search', 'searches'], fetch: ['page', 'pages'], todo: ['plan', 'plans'], agent: ['agent', 'agents'], skill: ['skill', 'skills'], mcp: ['tool', 'tools'], tool: ['tool', 'tools'],
};
const joinPhrases = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** `Ran 3 commands, read 2 files and edited 1 file` (present tense while any runs; failures appended), as the desktop's tool groups. */
export function summarizeTools(tools: readonly Pick<ToolActivity, 'name' | 'status'>[]): string {
  const running = tools.some(t => t.status === 'running');
  const failed = tools.filter(t => t.status === 'failed').length;
  const counts = new Map<string, Map<TraceKind, number>>();
  for (const tool of tools) {
    const kind = toolKind(tool.name);
    const verb = (kind === 'search' || kind === 'web' ? ['Running', 'Ran'] : VERBS[kind])[running ? 0 : 1];
    const key = kind === 'web' ? 'search' : kind;
    const nouns = counts.get(verb) ?? new Map<TraceKind, number>();
    counts.set(verb, nouns.set(key, (nouns.get(key) ?? 0) + 1));
  }
  const sentence = joinPhrases([...counts].map(([verb, nouns]) => `${verb.toLowerCase()} ${joinPhrases([...nouns].map(([kind, n]) => (kind === 'todo' ? 'the plan' : `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`)))}`));
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + (running ? '…' : '') + (failed ? ` · ${failed} failed` : '');
}

export type Run<T> = { kind: 'tools'; items: T[] } | { kind: 'item'; item: T };

/** Consecutive tool calls grouped (at most `max` each), other entries between them, as groupToolRuns on the desktop. */
export function groupRuns<T>(entries: readonly T[], isTool: (entry: T) => boolean, max = 5): Run<T>[] {
  const runs: Run<T>[] = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (!isTool(entry)) runs.push({ kind: 'item', item: entry });
    else if (last?.kind === 'tools' && last.items.length < max) runs[runs.length - 1] = { kind: 'tools', items: [...last.items, entry] };
    else runs.push({ kind: 'tools', items: [entry] });
  }
  return runs;
}
