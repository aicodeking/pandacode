import type { ToolActivity } from './types';
import { brandFor } from './trace-brands.ts';
import { pandacodeTool, pandacodeTrace } from './tool-trace-pandacode.ts';
import { fieldsOf, normalizeTool } from './tool-names.ts';
import { parseFields, type Fields } from './tool-fields.ts';
import { ROW_TEXT, basename, clip, lines, strings, unwrapHarness } from './tool-text.ts';
import {
  blockedVerb, editFailureReason, isBlockedOutput, isDeniedOutput, isInterruptedOutput, unavailableToolName, withoutInterrupt,
} from './tool-trace-errors.ts';
import { exitCode, missingProgram, neverStarted, searchFoundNothing, unknownToolName, type ExitAnswer } from './tool-trace-outcome.ts';
import {
  backgroundedShell, harnessUnstarted, interruptedShell, refusedShell, signalStop, stoppedShell, timedOutShell,
} from './tool-trace-refusal.ts';
export { exitCode };
import { pandacodeImage, shellTrace, specialKind, specialTrace } from './tool-trace-intent.ts';
import { describeShell } from './shell-intent.ts';
export { parseFields, type Fields };
export { traceRowHtml } from './tool-trace-row.ts';
export { groupTallies, summarizeGroup, summarizeTools, summaryIcons } from './tool-trace-summary.ts';
export {
  COMPLETE, PARTIAL, badge, excerptCard, head, kvTable, linesPre, list, mcpCard, resultCard, searchCard, section, summarizeValue, terminalCard,
  toolPreview, type ListItem,
} from './tool-trace-cards.ts';

/** Sentence-style tool traces: `Verb [chip] object` rows, result cards and group summaries. Pure and escaped. */
export type TraceKind = 'shell' | 'read' | 'image' | 'edit' | 'write' | 'search' | 'web' | 'fetch' | 'todo' | 'agent' | 'skill' | 'mcp' | 'tool';
/** `svg` is a brand mark (trusted markup from trace-brands), the only mark drawn inside the chip. */
export type TraceChip = { icon: string; label: string; title: string; svg?: string };
/** `family` tints the row icon (PandaCode tool families, `agent`, `mcp`); `icon` overrides the kind's icon (an MCP search reads as a search).
 *  `image` is a viewed image's path (an inline thumbnail), `chips` several chips in place of `chip`, `quiet` a housekeeping row drawn faint,
 *  `destructive` a shell command that discards work (a quiet danger badge). */
export type Trace = {
  kind: TraceKind; verb: string; object: string; mono?: boolean;
  chip?: TraceChip; chips?: TraceChip[]; image?: string; quiet?: boolean; destructive?: boolean;
  added?: number; removed?: number; family?: string; icon?: string; exit?: number;
} & TraceExtras;
/** `more` is a muted `+2 more commands` after the sentence, `chipLast` puts the chip after the object (`Searched for "x" in [src]`),
 *  `risks` say why a destructive command is (highest first; the badge's tooltip), `note` is free text (a summary, a prompt)
 *  drawn after a separator as a muted quote, `title` the row's tooltip (a Bash call's own description), `blocked` a call the
 *  harness refused before it ran (`Blocked: read a.txt`, drawn quiet), `produced` an image a command wrote (its thumbnail beside the chip or object
 *  that names it, else after the sentence and before the badges; tool-trace-row.ts). */
export type TraceExtras = {
  more?: string; chipLast?: boolean; risks?: string[]; note?: string; title?: string; blocked?: boolean; produced?: string;
  /** A compound command that failed after its lead step: the verb is the lead's, the badge says `then failed`. */
  then?: boolean;
  /** Several chips read as a list (`Ran [python3] and [grep]`), not side by side. */
  joined?: boolean;
  /** A check that exited 0 (a pipe's last stage did) whose output says it failed (`Tests failed · 3 of 12`). */
  outputFailed?: boolean;
  /** Why a call wrote or ran nothing (`string to replace not found`, `disk is full`): a muted note after the sentence. */
  reason?: string;
  /** The turn ended before the call reported (`Interrupted: [npm] test`): quiet, neither a success nor a failure. */
  interrupted?: boolean;
};
export type Tool = Pick<ToolActivity, 'name' | 'status' | 'input' | 'output'>;

export const MAX_SCAN = 20_000;
const OMITTED = '[Non-text content omitted]';

// [running verb, finished verb, row icon, summary noun singular, plural]
const KINDS: Record<TraceKind, [string, string, string, string, string]> = {
  shell: ['Running', 'Ran', 'terminal', 'command', 'commands'],
  read: ['Reading', 'Read', 'file', 'file', 'files'],
  image: ['Viewing', 'Viewed', 'images', 'image', 'images'],
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
export function kindIcon(kind: TraceKind): string { return KINDS[kind][2]; }
/** A kind's [running verb, finished verb, singular noun, plural noun] for group summaries (tool-trace-summary.ts). */
export function kindNouns(kind: TraceKind): [string, string, string, string] { const [now, done, , one, many] = KINDS[kind]; return [now, done, one, many]; }
export function traceIcon(trace: Trace): string { return trace.icon ?? kindIcon(trace.kind); }

/** Like clip, but keeps line breaks for multi-line prose. */
export function clipText(value: string, limit: number): string {
  const trimmed = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > limit ? trimmed.slice(0, limit - 1) + '…' : trimmed;
}
export { basename, clip, lines };
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join(' ') : '';
}
export function field(fields: Fields, ...keys: string[]): string {
  for (const key of keys) { const value = text(fields[key]); if (value) return value; }
  return '';
}
export function cleanOutput(output: string): string { return output.trim() === OMITTED ? '' : unwrapHarness(output.slice(0, MAX_SCAN)); }


/** Any JSON value, or undefined for text. */
export function parseJson(value: string): unknown {
  const trimmed = value.slice(0, MAX_SCAN).trim();
  if (!/^[[{]/.test(trimmed)) return;
  try { return JSON.parse(trimmed); } catch { return; }
}

export function toolKind(name: string): TraceKind {
  const own = pandacodeTool(name);
  if (own) return own === 'vm_exec' ? 'shell' : 'mcp';
  const n = name.toLowerCase();
  if (/^(bash|shell|command|exec_command|local_shell|run_terminal_cmd)$/.test(n)) return 'shell';
  if (/^(read|read_file|view|readfile)$/.test(n)) return 'read';
  if (/^(edit|multiedit|multi_edit|str_replace\w*|apply_patch|patch)$/.test(n)) return 'edit';
  if (/^(write|write_file|create|create_file)$/.test(n)) return 'write';
  if (/^(grep|glob|search|find|ls|list|list_dir|codebase_search|file_search)$/.test(n)) return 'search';
  if (/^web_?search$/.test(n)) return 'web';
  if (/^(web_?fetch|fetch)$/.test(n)) return 'fetch';
  if (/^(todowrite|todo_write|update_plan)$/.test(n)) return 'todo';
  if (/^(task|agent|subagent|spawn_?agent|spawnagent)$/.test(n)) return 'agent';
  if (n === 'skill') return 'skill';
  if (n.startsWith('mcp__') || n.includes(' · ')) return 'mcp';
  return 'tool';
}

/** The kind of a recorded call: its canonical name (tool-names.ts), images it looked at, then the name's own kind. */
export function traceKind(tool: Tool): TraceKind {
  const normal = normalizeTool(tool);
  return specialKind(normal) ?? toolKind(normal.name);
}

/** Codex's plain-text command line: every line of it (a heredoc's body included) less the trailing `Working directory: …`. */
export function plainCommand(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('{') ? '' : trimmed.replace(/\n+Working directory: [^\n]*$/, '');
}

/** Codex records plain text: `/bin/zsh -lc "cmd"\nWorking directory: …`. */
export function shellCommand(input: string, fields: Fields): string {
  const command = field(fields, 'command', 'cmd') || plainCommand(input);
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped ? wrapped[2] : command).trim();
}

export function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, 60); }
}

export function editLines(fields: Fields): { old: string; new: string }[] {
  const edits = Array.isArray(fields.edits) ? fields.edits as Fields[] : [fields];
  return edits.filter(edit => edit && typeof edit === 'object')
    .map(edit => ({ old: field(edit, 'old_string', 'oldText', 'old_str', 'find'), new: field(edit, 'new_string', 'newText', 'new_str', 'content', 'replace') }));
}
/** The +/− delta: recorded counts, a patch's lines, or old/new text; nothing when unknown (a cut record), never a false +0 −0. */
function diffCounts(fields: Fields): { added?: number; removed?: number } {
  if (typeof fields._added === 'number' && typeof fields._removed === 'number') return { added: fields._added, removed: fields._removed };
  if (fields._partial === true) return {};
  const patch = lines(field(fields, 'patch', 'diff', 'input')).filter(line => !/^(\+\+\+|---|\*\*\*) /.test(line));
  if (patch.length) return { added: patch.filter(line => line.startsWith('+')).length, removed: patch.filter(line => line.startsWith('-')).length };
  const edits = editLines(fields);
  if (edits.every(edit => !edit.old && !edit.new)) return {};
  return edits.reduce((sum, edit) => ({ added: sum.added + lines(edit.new).length, removed: sum.removed + lines(edit.old).length }), { added: 0, removed: 0 });
}

export function filePath(input: string, fields: Fields): string {
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

/** `mcp__server__tool` (Claude) and `server · tool` (Codex); PandaCode's own server reads as PandaCode. */
export function mcpParts(name: string): { server: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^(.+?) · (.+)$/.exec(name);
  if (mcp && !/^pandacode(_|$)/i.test(mcp[1])) return { server: mcp[1], tool: mcp[2] };
  if (mcp) return { server: 'PandaCode', tool: mcp[2].replace(/^pandacode_/, '') };
  return { server: 'MCP', tool: name };
}

/** `settled` marks a verb that already reads as the outcome (`Tests failed`), which a failure must not rewrite to `Couldn't …`. */
type Parts = Omit<Trace, 'kind' | 'verb'> & { verb?: string; settled?: boolean };
/** One kind's row parts. `failed` asks for the present-tense verb, which describeTool turns into `Couldn't …`. */
type Describe = (call: { kind: TraceKind; name: string; input: string; fields: Fields; failed: boolean; output: string; status?: Tool['status'] }) => Parts;
const tense = (failed: boolean, present: string, past: string) => failed ? present : past;
const plural = (count: number, one: string) => `${count} ${count === 1 ? one : one + 's'}`;

function describeShellRow({ name, input, fields, failed, output, status }: Parameters<Describe>[0]): Parts {
  const command = shellCommand(input, fields);
  const program = command.split(/\s/, 1)[0] ?? '';
  // A VM command names its machine, so identical commands on different machines stay apart.
  const target = /vm_exec$/.test(name) ? field(fields, 'name', 'vm', 'id') : '';
  const where = (target ? ` · on ${target}` : '') + (fields.run_in_background === true ? ' · in background' : '');
  const raw = field(fields, 'command', 'cmd') || plainCommand(input);
  // The output picks a compound's test step, and a nonzero exit lets a failed test run read `Tests failed`, not `Couldn't run tests`.
  const { code, body } = exitCode(output);
  const nonzero = failed || (code !== undefined && code !== 0);
  const description = field(fields, 'description');
  // Devin's `workdir`, Codex's `Working directory:` line: where a relative image the command wrote lives.
  const cwd = field(fields, 'workdir', 'cwd') || (/\nWorking directory: ([^\n]+)\s*$/.exec(input)?.[1] ?? '').trim();
  const intent = shellTrace(command, failed, where, raw, { output: body, nonzero, description, code, inspect: status === 'completed' && !nonzero, cwd });
  const title = description ? { title: description } : {};
  if (intent) return { ...intent, ...title };
  if (!program) return { object: description + where };
  const chip = { icon: 'terminal', label: basename(program), title: command };
  // Claude's own description says more than raw arguments; the card keeps the command.
  if (description) return { chip, object: where, note: clip(description, ROW_TEXT), ...title };
  return { chip, object: clip(command.slice(program.length), ROW_TEXT) + where, mono: true, ...title };
}

/** `lines 12–36`, `+1 more file`: what a read names beyond its first file. */
function readObject(fields: Fields): string {
  const more = Array.isArray(fields.files) ? fields.files.length - 1 : 0;
  if (more > 0) return `+${more} more ${more === 1 ? 'file' : 'files'}`;
  // Devin's `Read lines 871, 873, 1025 in …` names lines that are no one range.
  if (typeof fields._lines === 'string' && fields._lines) return `lines ${fields._lines}`;
  // Kimi records its range as `line_offset` and `n_lines`.
  const offset = fields.offset ?? fields.line_offset;
  const limit = fields.limit ?? fields.n_lines;
  return typeof offset === 'number' && typeof limit === 'number' && offset > 1 ? `lines ${offset}–${offset + limit - 1}` : '';
}

function describeFile({ kind, input, fields }: Parameters<Describe>[0]): Parts {
  const path = filePath(input, fields);
  // A record cut before its path (or with none) still says what it did: `Wrote a file`.
  if (!path) return { object: 'a file' };
  if (kind === 'read') return { chip: fileChip(path), object: readObject(fields) };
  const content = field(fields, 'content', 'contents');
  const count = lines(content).length;
  const more = fields._partial === true ? '+' : '';
  // `· 46+ lines`: a count after a separator, so it never runs into the file name or reads as a +/− delta.
  return { chip: fileChip(path), object: content ? `· ${count}${more} ${count === 1 && !more ? 'line' : 'lines'}` : '' };
}

/** Legacy Codex `Update files` that only created or only deleted files (tool-trace-legacy.ts's `_action`). */
const EDIT_ACTIONS: Record<string, [string, string]> = { add: ['Creating', 'Created'], delete: ['Deleting', 'Deleted'] };

function describeEdit({ fields, failed }: Parameters<Describe>[0]): Parts {
  const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
  const more = Array.isArray(fields.files) ? fields.files.length - 1 : 0;
  const action = typeof fields._action === 'string' ? EDIT_ACTIONS[fields._action] : undefined;
  const verb = action ? { verb: tense(failed, action[0], action[1]) } : {};
  return { ...verb, chip: fileChip(path), object: more > 0 ? `+${more} more ${more === 1 ? 'file' : 'files'}` : '', ...diffCounts(fields) };
}

/** Where a search looked: its folder or file, its `paths` (one by name, more as `N paths`), else its `include` filter. */
function searchPlace(fields: Fields): TraceChip | undefined {
  const one = field(fields, 'path', 'directory', 'target_directory', 'dir_path');
  if (one) return { icon: 'folder', label: basename(one) || one, title: one };
  const paths = strings(fields.paths);
  if (paths.length > 1) return { icon: 'folder', label: `${paths.length} paths`, title: paths.join(', ') };
  if (paths.length === 1) return { icon: 'folder', label: basename(paths[0]) || paths[0], title: paths[0] };
  const include = field(fields, 'include', 'file_pattern');
  return include ? { icon: 'folder', label: clip(include, 40), title: include } : undefined;
}
/** `“pattern”`, without adding quotes to a pattern that has its own. */
export function quotedPattern(pattern: string, limit = ROW_TEXT): string {
  const shown = clip(pattern, limit);
  return /["“”]/.test(pattern) ? shown : `“${shown}”`;
}

/** `Searched for "x" in [src]`, `Found files matching *.ts in [src]`, `Listed [folder]`: one wording for every provider. */
function describeSearch({ name, fields, failed }: Parameters<Describe>[0]): Parts {
  const lower = name.toLowerCase();
  // A directory listing names its folder; there is nothing it searched for.
  if (/^(ls|list|list_dir)$/.test(lower)) {
    const where = field(fields, 'path', 'directory', 'target_directory');
    const more = Array.isArray(fields.paths) ? fields.paths.length - 1 : 0;
    const chip = { icon: 'folder', label: where ? basename(where) : 'workspace', title: where || 'workspace' };
    return { verb: tense(failed, 'Listing', 'Listed'), chip, object: more > 0 ? `+${more} more ${more === 1 ? 'folder' : 'folders'}` : '', icon: 'folder' };
  }
  const place = searchPlace(fields);
  const pattern = field(fields, 'pattern', 'query', 'glob', 'regex');
  const glob = /glob|^find$|file_search/.test(lower);
  const what = !pattern ? '' : glob ? `files matching ${quotedPattern(pattern)}` : `for ${quotedPattern(pattern)}`;
  const object = [what, place ? 'in' : ''].filter(Boolean).join(' ');
  return { ...(glob ? { verb: tense(failed, 'Finding', 'Found') } : {}), chip: place, chipLast: true, object, icon: 'search' };
}

/** A web query always reads inside curly quotes, its own quotes kept (`for “tauri "drag drop" macos”`). */
function webQuote(query: string): string {
  const whole = /^["“]([^"“”]*)["”]$/.exec(query.trim());
  return `“${clip(whole ? whole[1] : query, ROW_TEXT)}”`;
}
/** `/path?q=1` of a URL, '' for a site's root. */
function urlPath(url: string): string {
  try { const { pathname, search } = new URL(url); return pathname === '/' && !search ? '' : clip(pathname + search, ROW_TEXT); } catch { return ''; }
}
const urlChip = (url: string): TraceChip => ({ icon: 'globe', label: domain(url), title: url, svg: brandFor(url)?.svg });

/** Codex's `action` on a web_search: `Opened [example.com] /path`, `Searched [example.com] for “foo”`; undefined for a search. */
function webAction(action: Fields, failed: boolean): Parts | undefined {
  const url = field(action, 'url');
  const type = field(action, 'type');
  const others = typeof action.others === 'number' && action.others > 0 ? { more: `+${action.others} more` } : {};
  if (url && type === 'openPage') return { verb: tense(failed, 'Opening', 'Opened'), chip: urlChip(url), object: urlPath(url), icon: 'external', ...others };
  const clicks = typeof action.clicks === 'number' ? action.clicks : 0;
  if (type === 'click' && clicks) return { verb: tense(failed, 'Following', 'Followed'), object: plural(clicks, 'link'), icon: 'external' };
  if (!url || type !== 'findInPage') return undefined;
  const pattern = field(action, 'pattern');
  return { verb: tense(failed, 'Searching', 'Searched'), chip: urlChip(url), object: pattern ? `for ${webQuote(pattern)}` : '', icon: 'search' };
}

function describeWeb({ fields, failed }: Parameters<Describe>[0]): Parts {
  const action = fields.action && typeof fields.action === 'object' && !Array.isArray(fields.action) ? fields.action as Fields : {};
  const acted = webAction(action, failed);
  if (acted) return acted;
  const queries = strings(action.queries);
  // Codex's legacy `webSearch` items kept no query.
  const query = field(fields, 'query', 'q') || field(action, 'query') || queries[0] || '';
  const extra = queries.length - 1;
  const more = extra > 0 ? { more: `+${extra} more ${extra === 1 ? 'query' : 'queries'}` } : {};
  return { verb: tense(failed, 'Searching the web', 'Searched the web'), object: query ? `for ${webQuote(query)}` : '', ...more };
}

function describeFetch({ fields }: Parameters<Describe>[0]): Parts {
  const url = field(fields, 'url');
  return { chip: url ? { icon: 'globe', label: domain(url), title: url, svg: brandFor(url)?.svg } : undefined, object: '', note: clip(field(fields, 'prompt'), ROW_TEXT) };
}

function describeTodo({ fields }: Parameters<Describe>[0]): Parts {
  const todos = Array.isArray(fields.todos) ? fields.todos.length : Array.isArray(fields.plan) ? fields.plan.length : 0;
  return { object: todos ? `the plan · ${plural(todos, 'step')}` : 'the plan' };
}

function describeAgent({ input, fields }: Parameters<Describe>[0]): Parts {
  const type = field(fields, 'subagent_type', 'agent_type', 'agent', 'name');
  const what = field(fields, 'description', 'objective', 'prompt', 'message') || (input.trim().startsWith('{') ? '' : input);
  return { family: 'agent', chip: { icon: 'bot', label: type || 'agent', title: type || 'agent' }, object: clip(what, ROW_TEXT) };
}

function describeSkill({ fields, failed }: Parameters<Describe>[0]): Parts {
  const skill = field(fields, 'skill', 'name', 'command');
  const chip = skill ? { icon: 'spark', label: skill, title: skill } : undefined;
  return { verb: tense(failed, 'Loading skill', 'Loaded skill'), chip, object: clip(field(fields, 'args', 'arguments'), ROW_TEXT), mono: true };
}

function describeMcp({ name, fields, failed, output }: Parameters<Describe>[0]): Parts {
  const own = pandacodeTool(name);
  if (own) return pandacodeTrace(own, fields, output, failed) ?? { family: 'pandacode', chip: { icon: 'server', label: 'PandaCode', title: name }, object: own.replace(/_/g, ' ') };
  const { server, tool } = mcpParts(name);
  const brand = brandFor(server);
  const chip = { icon: 'server', label: brand?.label ?? server, title: name, svg: brand?.svg };
  const action = mcpAction(tool);
  const query = clip(field(fields, 'query', 'q', 'search', 'filter'), ROW_TEXT);
  if (action === 'search') return { verb: tense(failed, 'Searching', 'Searched'), family: 'mcp', icon: 'search', chip, object: `for ${query ? webQuote(query) : mcpNoun(tool)}` };
  if (action === 'read') return { verb: tense(failed, 'Reading the', 'Read the'), family: 'mcp', icon: 'file', chip, object: query || mcpNoun(tool) };
  return { family: 'mcp', chip, object: tool.replace(/_/g, ' ') };
}

const DESCRIBE: Partial<Record<TraceKind, Describe>> = {
  shell: describeShellRow, read: describeFile, write: describeFile, edit: describeEdit, search: describeSearch, web: describeWeb,
  fetch: describeFetch, todo: describeTodo, agent: describeAgent, skill: describeSkill, mcp: describeMcp,
};

function describeFields(kind: TraceKind, tool: Tool, fields: Fields, failed: boolean, output: string): Parts {
  const { name, input, status } = tool;
  const describe = DESCRIBE[kind];
  return describe ? describe({ kind, name, input, fields, failed, output, status }) : { chip: { icon: 'command', label: name || 'Tool', title: name || 'Tool' }, object: inputHint(input) };
}

export function inputHint(input: string): string {
  const fields = fieldsOf(input);
  const value = input.trim().startsWith('{')
    ? field(fields, 'command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'url', 'pattern', 'description')
    : input.trim().split('\n', 1)[0] ?? '';
  return clip(value, ROW_TEXT);
}

// `-ing` stems that need their `e` back, doubled `l`s that English does not double, and stems whose double letter is their own (`add`).
const E_STEMS = [
  'prob', 'encod', 'locat', 'eras', 'rebas', 'clon', 'creat', 'sav', 'mov', 'renam', 'nam', 'archiv', 'queu', 'remov', 'resolv', 'writ',
  'overwrit', 'truncat', 'typ', 'us', 'clos', 'captur', 'prepar', 'schedul', 'choos', 'updat', 'restor', 'tak', 'manag', 'delet', 'execut',
  'leav', 'receiv', 'shar', 'describ', 'stag', 'pars', 'messag', 'coordinat', 'delegat', 'navigat', 'swip', 'generat', 'validat',
  'complet', 'configur', 'chang', 'replac', 'enabl', 'disabl', 'invok', 'provid', 'decid', 'merg', 'serv', 'mak', 'giv', 'hid', 'guid',
  'analyz', 'summariz', 'resum', 'upgrad', 'profil', 'resiz', 'expir', 'prun', 'rewrit', 'purg', 'wip', 'revok', 'unstag', 'paus',
  'initializ', 'measur', 'compil', 'decod', 'rotat', 'compar', 'optimiz', 'transcod', 'migrat', 'terminat', 'simulat', 'trac',
];
const E_STEM = new RegExp(`^(${E_STEMS.join('|')})$`, 'i');
const LL_STEM: Record<string, string> = { add: 'add', cancell: 'cancel', controll: 'control', labell: 'label', modell: 'model', travell: 'travel', signall: 'signal' };
/** `Creating task` → `Couldn't create task`; failure-first wording for failed rows. */
export function failedVerb(running: string): string {
  const [first = '', ...rest] = running.split(' ');
  const match = /^(.*?)ing$/i.exec(first);
  if (!match) return `Couldn't ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
  const [, prefix, word] = /^(.*-)?(.*)$/.exec(match[1].toLowerCase()) ?? [];
  let stem = word ?? '';
  if (LL_STEM[stem]) stem = LL_STEM[stem];
  else if (/([bdgmnpt])\1$/.test(stem)) stem = stem.slice(0, -1);
  else if (E_STEM.test(stem)) stem += 'e';
  return ["Couldn't", (prefix ?? '') + stem, ...rest].join(' ');
}

/** One ` · ` between counts and notes: no doubled or trailing separators; a leading one stays (the row joins it to its
 *  chip). Split on the separator, never a `\s*·\s*` pattern, which backtracks over long whitespace runs. */
function tidySeparators(object: string): string {
  if (!object.includes('·')) return object.trimStart();
  const [first, ...rest] = object.split('·');
  const kept = rest.map(part => part.trim()).filter(Boolean);
  const lead = first.trim();
  if (!lead) return kept.length ? `· ${kept.join(' · ')}` : '';
  return [lead, ...kept].join(' · ');
}

/** How a call was refused before it ran: a harness rule (`Blocked: …`) or the user (`Denied: …`). */
type Refusal = 'Blocked' | 'Denied' | undefined;
function refusalOf(tool: Tool): Refusal {
  if (!isBlockedOutput(tool.status, tool.output)) return undefined;
  return isDeniedOutput(tool.status, tool.output) ? 'Denied' : 'Blocked';
}

/** The finished verb: `Couldn't …` for a failure (unless the verb is already its outcome), `Blocked: …`/`Denied: …` for a refusal. */
function rowVerb(verb: string, failed: boolean, settled: boolean | undefined, refusal: Refusal): string {
  if (refusal) return settled && verb.startsWith(refusal) ? verb : blockedVerb(failedVerb(verb), refusal);
  return failed && !settled ? failedVerb(verb) : verb;
}

/** `Interrupted: read a.ts`: the call's own words after the lead, like a refusal's. A call that recorded no input was cut
 *  before it said what it would do: `Interrupted before it ran`. */
function interruptedVerb(verb: string, settled: boolean | undefined, input: string): string {
  if (!EMPTY_INPUT.test(input)) return settled && verb.startsWith('Interrupted') ? verb : blockedVerb(failedVerb(verb), 'Interrupted');
  return 'Interrupted before it ran';
}
const EMPTY_INPUT = /^\s*(?:\{\s*\})?\s*$/;

/** A search that exited 1 having found nothing (`none`), or a compound whose last step did (`tail`): not a failure. */
function foundNothing(tool: Tool, kind: TraceKind): ExitAnswer | undefined {
  if (kind !== 'shell' || tool.status === 'running') return undefined;
  const { code, body } = exitCode(cleanOutput(tool.output));
  return searchFoundNothing(shellCommand(tool.input, fieldsOf(tool.input)), code, body);
}

const EXIT_TAIL: Record<ExitAnswer, string> = { none: ' · no matches', tail: '', differ: ' · differ', changes: ' · changes' };

/** A command the shell never started (no output at all, a full disk, a missing program): `Couldn't run [cat a.txt]`, not
 *  what the command would have done. */
function unstartedShell(tool: Tool, fields: Fields): Parts | undefined {
  const command = shellCommand(tool.input, fields);
  if (!neverStarted(cleanOutput(tool.output), command)) return undefined;
  // A lone step that already reads as running something (`Ran tests`) says `Couldn't run tests [playwright]` by itself.
  // A lone test run keeps that wording even when its runner was not found; any other missing program reads `Couldn't start [x]`.
  const intent = command ? describeShell(command) : undefined;
  const lone = intent !== undefined && intent.steps === 1;
  const wrapped = describeShell(command, exitCode(cleanOutput(tool.output)).body).missing !== undefined;
  const missing = lone && intent.kind === 'test' && !wrapped ? undefined : missingShell(command, tool.output);
  if (missing) return missing;
  if (lone && intent.verb.startsWith('Ran')) return undefined;
  const { code } = exitCode(cleanOutput(tool.output));
  const chip = command ? { icon: 'terminal', label: clip(command, 48), title: command } : undefined;
  return { verb: "Couldn't run", settled: true, chip, object: '', icon: 'terminal', ...(code ? { exit: code } : {}) };
}

/** `Couldn't start [timeout]`: the shell could not find the command's program, whatever exit a pipe reported. A failure,
 *  with no exit badge (a pipe's 0 or the shell's 127 says nothing more). */
function missingShell(command: string, output: string): Parts | undefined {
  const body = exitCode(cleanOutput(output)).body;
  const name = missingProgram(command, body);
  if (!name) return undefined;
  // A missing wrapper (`timeout 600 cargo test`) names what it would have run: `Couldn't start [timeout] (not installed) · cargo test`.
  const intent = describeShell(command, body);
  if (intent.missing === name) {
    const inner = intent.label && intent.label !== 'shell' ? ` · ${intent.label}` : '';
    return { verb: "Couldn't start", settled: true, chip: { icon: 'terminal', label: name, title: command }, object: `(not installed)${inner}`, icon: 'terminal', outputFailed: true };
  }
  return { verb: "Couldn't start", settled: true, chip: { icon: 'terminal', label: name, title: command }, object: '', icon: 'terminal', outputFailed: true };
}

/** A call of a tool the session does not have: `Unavailable tool: [bash]`, quiet (Claude Code); Devin's `Tool` that asked
 *  for one: `Couldn't use [X] (unknown tool)`. */
function unknownTool(tool: Tool): Parts | undefined {
  const missing = unavailableToolName(tool.status, tool.output);
  if (missing) return { verb: 'Unavailable tool:', settled: true, chip: { icon: 'command', label: missing, title: missing }, object: '', quiet: true };
  const name = unknownToolName(tool.name, tool.output);
  // `pandacode_send_team_message` reads `send_team_message`, as PandaCode's own tools do everywhere; the tooltip keeps the name.
  return name ? { verb: "Couldn't use", settled: true, chip: { icon: 'command', label: name.replace(/^pandacode_(?=\w)/, ''), title: name }, object: '(unknown tool)' } : undefined;
}

/** A shell call whose outcome is its row: refused (`Denied: npm install …`), interrupted, stopped by a signal, or never started. */
function shellOutcome(tool: Tool, fields: Fields, failed: boolean, refusal: Refusal): Parts | undefined {
  const command = shellCommand(tool.input, fields);
  if (refusal) return refusedShell(command, tool.output, refusal);
  if (isInterruptedOutput(tool.status, tool.output)) return interruptedShell(command);
  if (!failed) return stoppedShell(tool, command) ?? backgroundedShell(command, cleanOutput(tool.output)) ?? missingShell(command, tool.output);
  return timedOutShell(command, tool.output) ?? harnessUnstarted(command, tool.output) ?? unstartedShell(tool, fields);
}

function partsOf(kind: TraceKind, tool: Tool, fields: Fields, failed: boolean, refusal: Refusal, output: string): Parts {
  const own = unknownTool(tool) ?? (kind === 'shell' ? shellOutcome(tool, fields, failed, refusal) : undefined);
  const parts = own ?? specialTrace(kind, tool, fields, failed, output) ?? describeFields(kind, tool, fields, failed, output);
  // Nothing was written by a failed edit, so it claims no +/− delta but says why; nothing ran in a denied call, so it carries no risk.
  const { added, removed, destructive, risks, ...rest } = parts;
  const file = failed && (kind === 'edit' || kind === 'write');
  const delta = file ? { reason: editFailureReason(withoutInterrupt(tool.output)) || undefined } : { added, removed };
  return { ...rest, ...defined({ ...delta, ...(refusal === 'Denied' ? {} : { destructive, risks }) }) };
}

/** The entries whose value is set, so a row never carries `added: undefined`. */
function defined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

const WORKING_TREE = 'the working tree';
/** A chip of only `.` names the folder the agent stands in. */
function placeChip(chip: TraceChip | undefined): TraceChip | undefined {
  return chip && /^\.\/?$/.test(chip.label) ? { ...chip, label: WORKING_TREE } : chip;
}
/** A shell row's quoted prose reads with curly quotes (`to contain “ready”`), like every other row's; code (a mono object)
 *  keeps the quotes it was written with, and text that already has curly quotes (a pattern quoting itself) is left alone. */
function proseQuotes(object: string, kind: TraceKind, mono: boolean | undefined): string {
  if (kind !== 'shell' || mono) return object;
  // A search's pattern shows exactly as searched: only the quotes around it curl (`for “a|"b"” in src`).
  const pattern = SEARCH_OBJECT.exec(object);
  if (pattern) return `${pattern[1]} “${pattern[3]}”${pattern[4]}`;
  return /[“”]/.test(object) ? object : object.replace(/"([^"\n]*)"/g, '“$1”');
}
const SEARCH_OBJECT = /^(for|matching) (["'])([^\n]*?)\2((?: in(?: [^\n]*)?)?(?: · [^\n]*)?)$/;

/** The row, its card, the group summary and its icons each describe the same record; a recent record is described once.
 *  Keyed by every field the trace reads, so a record that changes (a call finishing) is described again. */
type CachedTrace = { name: string; status: string; output: string; trace: Trace };
const TRACE_CACHE = new Map<string, CachedTrace[]>();
const TRACE_CACHE_SIZE = 64;

export function describeTool(raw: Tool): Trace {
  const hits = TRACE_CACHE.get(raw.input) ?? [];
  const hit = hits.find(entry => entry.name === raw.name && entry.status === raw.status && entry.output === raw.output);
  if (hit) return hit.trace;
  const trace = Object.freeze(traceOf(raw));
  if (TRACE_CACHE.size >= TRACE_CACHE_SIZE && !TRACE_CACHE.has(raw.input)) TRACE_CACHE.delete(TRACE_CACHE.keys().next().value as string);
  TRACE_CACHE.set(raw.input, [...hits.slice(-3), { name: raw.name, status: raw.status, output: raw.output, trace }]);
  return trace;
}

function traceOf(raw: Tool): Trace {
  const tool = normalizeTool(raw);
  const kind = traceKind(tool);
  const nothing = foundNothing(tool, kind);
  const interrupted = isInterruptedOutput(tool.status, tool.output);
  const failed = tool.status === 'failed' && !nothing && !interrupted && !signalStop(tool, kind) && !toolUnavailable(tool);
  const refusal = refusalOf(tool);
  const fields = fieldsOf(tool.input);
  // A refusal's text says nothing about what the call did, so the row reads as if it had no output; a search that found
  // nothing reads without its exit code.
  const cleaned = refusal ? '' : cleanOutput(interrupted ? withoutInterrupt(tool.output) : tool.output);
  const output = nothing ? exitCode(cleaned).body : cleaned;
  // Rows read as finished sentences even while they run (the shimmer marks the running step); a failed row leads with `Couldn't …`.
  // An interrupted call asks for the present tense too: `Interrupted: write a.ts`.
  const { settled, produced, ...described } = partsOf(kind, tool, fields, failed || interrupted, refusal, output);
  const shot = kind === 'mcp' ? pandacodeImage(tool.name, fields, output) : '';
  // A VM command's image lives in the VM, so there is no thumbnail to show.
  const inVm = kind === 'shell' && pandacodeTool(tool.name) === 'vm_exec';
  const verb = described.verb ?? KINDS[kind][failed || interrupted ? 0 : 1];
  // A program that never started (`Couldn't start [pnpm]`) has no answer of its own: the shell's 127 is no badge.
  const unstarted = described.verb === "Couldn't start";
  const code = refusal || interrupted || unstarted ? undefined : !failed && exitFailed(tool, kind, nothing) ? exitCode(cleanOutput(tool.output)).code : described.exit;
  const object = tidySeparators(described.object) + EXIT_TAIL[nothing ?? 'tail'];
  const chips = described.chips ? { chips: described.chips.map(chip => placeChip(chip) ?? chip) } : {};
  return {
    ...described, ...chips, ...(described.chip ? { chip: placeChip(described.chip) } : {}), ...(inVm ? { family: 'vm' } : {}), ...(shot ? { image: shot } : {}), kind,
    verb: interrupted ? interruptedVerb(verb, settled, tool.input) : rowVerb(verb, failed, settled, refusal), object: proseQuotes(object.replace(/^ · /, described.chip || described.chips?.length ? '· ' : ''), kind, described.mono),
    ...(refusal ? { icon: 'shield', blocked: true } : interrupted ? { icon: 'stop', quiet: true, interrupted: true } : {}), ...(code !== undefined ? { exit: code } : {}),
    ...(produced && !inVm && tool.status === 'completed' && code === undefined ? { produced } : {}),
  };
}

/** A call of a tool the session does not have (`No such tool available: X`): quiet, never a failure. */
export function toolUnavailable(tool: Tool): boolean { return unavailableToolName(tool.status, tool.output) !== ''; }

/** A call the harness refused before it ran (`<tool_use_error>Blocked: …`). */
export function toolBlocked(tool: Tool): boolean { return isBlockedOutput(tool.status, tool.output); }

/** A completed shell (or cloud CLI) call whose exit code is nonzero, a search's `no matches` aside. */
function exitFailed(tool: Tool, kind: TraceKind, nothing: ExitAnswer | undefined): boolean {
  if (tool.status !== 'completed' || nothing || signalStop(tool, kind)) return false;
  if (kind !== 'shell' && pandacodeTool(tool.name) !== 'cloud_cli') return false;
  const { code } = exitCode(cleanOutput(tool.output));
  return code !== undefined && code !== 0;
}

/** A failed call, a command that exited nonzero, or a check whose output says it failed though it exited 0. A search
 *  that found nothing and a command stopped by a signal (exit 143/137) are not failures. */
export function toolFailed(tool: Tool): boolean {
  if (isInterruptedOutput(tool.status, tool.output) || toolUnavailable(tool)) return false;
  const normal = normalizeTool(tool);
  const kind = traceKind(normal);
  if (tool.status === 'failed') return !foundNothing(normal, kind) && !signalStop(normal, kind);
  if (exitFailed(normal, kind, foundNothing(normal, kind))) return true;
  return tool.status === 'completed' && kind === 'shell' && describeTool(tool).outputFailed === true;
}

/** A call the turn ended before it reported (`Interrupted: …`): quiet, tallied apart, never a failure. */
export function toolInterrupted(tool: Tool): boolean { return isInterruptedOutput(tool.status, tool.output) && !toolBlocked(tool); }

/** A call the user turned down (`Denied: …`), as opposed to one a harness rule blocked. */
export function toolDenied(tool: Tool): boolean { return isDeniedOutput(tool.status, tool.output); }
