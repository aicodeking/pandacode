// Harnesses that record a human title (`Ran git`, `Reading src/a.ts`, `Called x from s`)
// instead of the tool name. normalizeTool maps them to the canonical names the trace
// classifier (`toolKind` in tool-trace.ts) understands, with a JSON input to match.

import { PARTIAL_KEY, isCut, parseFields, withoutCut, type Fields } from './tool-fields.ts';
import { devinEditCall, devinWriteCall, ranCall, stripAnsi, updateFilesCall, type LegacyCall } from './tool-trace-legacy.ts';

/** One row is described, summarized and carded from the same input several times a frame; a recent input's fields are
 *  parsed once. The fields are shared, so callers treat them as read-only (they never write to them). */
const FIELD_CACHE = new Map<string, Fields>();
const FIELD_CACHE_SIZE = 32;
export function fieldsOf(input: string): Fields {
  const hit = FIELD_CACHE.get(input);
  if (hit) return hit;
  const fields = parseFields(input);
  if (FIELD_CACHE.size >= FIELD_CACHE_SIZE) FIELD_CACHE.delete(FIELD_CACHE.keys().next().value as string);
  FIELD_CACHE.set(input, fields);
  return fields;
}

type ToolLike = { name: string; input: string; output: string; status: string };
/** `output` replaces the record's output (a Devin `Ran` row whose input holds the output). */
type Canonical = LegacyCall;
type Rule = [RegExp, (match: RegExpExecArray, fields: Fields, tool: ToolLike) => Canonical];

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIEW_IMAGE = /^View image (.+?)(?: \(\d+x\d+\))?\s*$/m;
const ABSOLUTE = /^(?:\/|[A-Za-z]:\\)/;

function str(fields: Fields, ...keys: string[]): string {
  for (const key of keys) if (typeof fields[key] === 'string' && fields[key]) return fields[key] as string;
  return '';
}

function shell(command: string, fields: Fields, raw: string): Canonical {
  return { name: 'Bash', fields: str(fields, 'command', 'cmd') ? fields : { command: raw.trim() || command.trim() } };
}

function file(name: string, path: string, fields: Fields): Canonical {
  const filePath = str(fields, 'file_path', 'path', 'filePath') || path.trim();
  return { name, fields: filePath ? { ...fields, file_path: filePath } : fields };
}

function image(path: string, fields: Fields): Canonical {
  return { name: 'ViewImage', fields: { path: str(fields, 'path', 'file_path', 'image_path') || path.trim() } };
}

function todos(fields: Fields): Canonical {
  const list = Array.isArray(fields.todos) ? fields.todos : [];
  const mapped = list.map(item => {
    if (!item || typeof item !== 'object') return item;
    const { title, status, ...rest } = item as Fields;
    const content = typeof rest.content === 'string' ? rest.content : title;
    return { status: status === 'done' ? 'completed' : status, ...rest, content };
  });
  return { name: 'TodoWrite', fields: { ...fields, todos: mapped } };
}

function devinRead(fields: Fields, tool: ToolLike): Canonical {
  const view = VIEW_IMAGE.exec(tool.output);
  return view ? image(view[1] ?? '', fields) : file('Read', '', fields);
}

function shellOutput(fields: Fields): Canonical {
  const id = str(fields, 'shell_id', 'bash_id', 'id');
  return { name: 'BashOutput', fields: id ? { ...fields, shell_id: id } : fields };
}

/** A title-named call: JSON fields win; otherwise the title's own fields, and a plain-text input (Devin, Command Code) is the result. */
function titled(name: string, own: Fields, fields: Fields, tool: ToolLike): Canonical {
  if (tool.input.trim().startsWith('{')) return { name, fields: { ...own, ...fields } };
  const text = tool.input.trim() ? stripAnsi(withoutCut(tool.input)) : '';
  const cut = isCut(tool.input) && !tool.output.trim() ? { [PARTIAL_KEY]: true } : {};
  return { name, fields: { ...own, ...cut }, ...(tool.output.trim() || !text ? {} : { output: text }) };
}

const LINE_LIST = /^lines (\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*) in\s+/;

/** The first part's lines: one range as offset and limit, a list (`871, 873, 1025`, `38-48, 108-119`) as `_lines`. */
function readLines(first: string): Fields {
  const list = LINE_LIST.exec(first)?.[1];
  if (!list) return {};
  const range = /^(\d+)-(\d+)$/.exec(list);
  if (range) return { offset: Number(range[1]), limit: Number(range[2]) - Number(range[1]) + 1 };
  return { _lines: list.split(/,\s*/).map(item => item.replace('-', '–')).join(', ') };
}

/** `./a.ts, lines 50-90 in ./b.ts`: each path a Devin read title names, the first one's lines. */
function readTitle(rest: string): Fields {
  const parts = rest.split(/,\s+(?=(?:lines \d|last \d|\.{0,2}\/|~\/|[A-Za-z]:\\))/);
  const paths = parts.map(part => part.replace(LINE_LIST, '').replace(/^last \d+ lines in\s+/, '').trim()).filter(Boolean);
  return { file_path: paths[0] ?? '', ...readLines(parts[0] ?? ''), ...(paths.length > 1 ? { files: paths } : {}) };
}

/** `./a, ./b` → the first folder, and every folder when there are more. */
function listTitle(rest: string): Fields {
  const paths = rest.split(/,\s+/).map(path => path.trim()).filter(Boolean);
  return { path: paths[0] ?? '', ...(paths.length > 1 ? { paths } : {}) };
}

/** Command Code's `Read:` with a `paths` list and no single file. */
function readPaths(path: string, fields: Fields): Canonical {
  const paths = Array.isArray(fields.paths) ? fields.paths.filter((item): item is string => typeof item === 'string' && item !== '') : [];
  if (str(fields, 'file_path', 'path') || path.trim() || !paths.length) return file('Read', path, fields);
  return { name: 'Read', fields: { ...fields, file_path: paths[0], ...(paths.length > 1 ? { files: paths } : {}) } };
}

/** Command Code's `Shell: cmd` (cut with `...` past a length); its plain-text input is the output. */
function titleShell(command: string, fields: Fields, tool: ToolLike): Canonical {
  if (str(fields, 'command', 'cmd')) return { name: 'Bash', fields };
  const clipped = /(?:\.\.\.|…)$/.test(command.trim());
  const own = { command: command.trim().replace(/(?:\.\.\.|…)$/, '').trimEnd(), ...(clipped ? { [PARTIAL_KEY]: true } : {}) };
  return titled('Bash', own, {}, tool);
}

/** Muse's `bash_input`: a terminate stops the session's shell, anything else reads it. */
function bashInput(fields: Fields): Canonical {
  const id = typeof fields.session_id === 'number' || typeof fields.session_id === 'string' ? String(fields.session_id) : '';
  return { name: fields.terminate === true ? 'KillShell' : 'BashOutput', fields: id ? { ...fields, shell_id: id } : fields };
}

const NOT_ELLIPSIS = (value: string) => value.trim().replace(/…$/, '');

/** Kimi's `Waiting up to 90s for task …` / `Waiting 1m 29s / 1m 30s · …`: a wait on a background task, up to its timeout. */
function kimiWait(upTo: string, fields: Fields): Canonical {
  const timeout = typeof fields.timeout === 'number' && fields.timeout > 0 ? `${fields.timeout}s` : '';
  return { name: 'sleep', fields: { ...fields, upTo: upTo || timeout } };
}

/** Programs whose name opens an opencode title that is the command itself (`git status | head`, `pwd && ls -la`). */
const SHELL_TITLE = /^(?:pwd|ls|cat|git|npm|npx|node|pnpm|yarn|bun|deno|rm|mkdir|rmdir|chmod|cp|mv|touch|grep|rg|find|sed|awk|head|tail|echo|cd|python3?|pip3?|cargo|rustc|go|curl|wget|make|docker|gh|jq|wc|sort|uniq|diff|tsc|kill|ps|lsof|which|sleep|tar|unzip|du|df|open|xcrun|swift|ruby|uv|env|test)\s/;
/** Shell syntax or a flag, so `make a plan` (a title that merely starts with a program) stays a tool. */
const SHELL_SYNTAX = /[|&;<>$`]|\s--?\w|\//;
function shellTitle(title: string, fields: Fields): Canonical | undefined {
  if (!SHELL_TITLE.test(title) || !(str(fields, 'command', 'cmd') || SHELL_SYNTAX.test(title))) return undefined;
  return shell(title, fields, '');
}

const RULES: Rule[] = [
  [/^Ran\s+\S/, (_m, f, t) => ranCall(t, f)],
  [/^Running:\s*(.*?)…?$/s, (m, f, t) => shell(m[1] ?? '', f, t.input)],
  [/^bash$/, (_m, f, t) => shell('', f, t.input)],
  [/^Read file$/, (_m, f, t) => devinRead(f, t)],
  [/^(?:Reading media:\s*|View image\s*)(.*)$/s, (m, f) => image(m[1] ?? '', f)],
  // DeepSeek's and OpenCode's `read_image` ({ path } or { file_path }).
  [/^read_image$/, (_m, f) => image('', f)],
  [/^(?:Reading\s+|Read:\s*)(.*)$/s, (m, f) => readPaths(m[1] ?? '', f)],
  [/^Read\s+(?!file$|shell$)(.+)$/s, (m, f, t) => titled('Read', readTitle(m[1] ?? ''), f, t)],
  [/^read_file$/, (_m, f) => file('Read', '', f)],
  [/^(?:Writing\s+(.+)|Write:\s*(.+)|Write file|write_file)$/s, (m, f) => file('Write', /\.\.\.$/.test(m[2] ?? '') ? '' : m[1] ?? m[2] ?? '', f)],
  [/^Wrote\s+(.+)$/s, (m, f, t) => devinWriteCall(t) ?? file('Write', m[1] ?? '', f)],
  [/^Edit:\s*(.+)$/s, (m, f) => file('Edit', m[1] ?? '', f)],
  [/^(?:Editing\s+(.+)|Edit file|edit_file)$/s, (m, f, t) => (m[0] === 'Edit file' ? devinEditCall(t) : undefined) ?? file('Edit', m[1] ?? '', f)],
  [/^Update files$/, (_m, _f, t) => updateFilesCall(t)],
  [/^imageView$/, () => ({ name: 'ViewImage', fields: {} })],
  [/^(?:Updating todo list|write_todos)$/, (_m, f) => todos(f)],
  [/^Called\s+(\S+)\s+from\s+(\S+)$/, (m, f) => ({ name: `mcp__${m[2]}__${m[1]}`, fields: f })],
  // Devin's title for a call to the same tool that failed (the record's status says so).
  [/^Failed to call\s+(\S+)\s+from\s+(\S+)$/, (m, f) => ({ name: `mcp__${m[2]}__${m[1]}`, fields: f })],
  // Kimi's web search (`Searching: <query>…`): a grep when it carries a pattern instead.
  [/^Searching:\s*(.*)$/s, (m, f, t) => str(f, 'pattern') ? titled('Grep', {}, f, t) : titled('WebSearch', { query: NOT_ELLIPSIS(m[1] ?? '') }, f, t)],
  [/^Listed MCP tools for\s+(\S+)$/, (m, f) => ({ name: 'ListMcpTools', fields: { server: str(f, 'server_name', 'server') || m[1] } })],
  [/^(?:Read shell|BashOutput)$/, (_m, f) => shellOutput(f)],
  [/^shell_output$/, (_m, f) => shellOutput(f)],
  [/^bash_input$/, (_m, f) => bashInput(f)],
  [/^Kill shell$/, (_m, f) => ({ name: 'KillShell', fields: f })],
  // Command Code's `Kill: <id>` stops a background shell.
  [/^Kill:\s*(\S+)$/, (m, f) => ({ name: 'KillShell', fields: { ...f, shell_id: str(f, 'shell_id') || (m[1] ?? '') } })],
  [/^Shell:\s*(.+)$/s, (m, f, t) => titleShell(m[1] ?? '', f, t)],
  [/^Starting background:\s*(.+)$/s, (m, f) => ({ name: 'Bash', fields: { ...(str(f, 'command', 'cmd') ? f : { command: NOT_ELLIPSIS(m[1] ?? '') }), run_in_background: true } })],
  [/^Searched web for\s+(.+)$/s, (m, f, t) => titled('WebSearch', { query: (m[1] ?? '').trim() }, f, t)],
  // A long pattern's title is cut before its closing quote.
  [/^Search for '(.*?)'?$/s, (m, f, t) => titled('Grep', { pattern: m[1] ?? '' }, f, t)],
  [/^Searched for (.+) in (\S.*)$/s, (m, f, t) => titled('Grep', { pattern: m[1] ?? '', path: (m[2] ?? '').trim() }, f, t)],
  [/^Searching for '(.*)'(?: in (\S.*))?$/s, (m, f, t) => titled('Grep', { pattern: m[1] ?? '', ...(m[2] ? { path: m[2].trim() } : {}) }, f, t)],
  [/^Search:\s*(.+)$/s, (m, f, t) => titled('Grep', { pattern: m[1] ?? '' }, f, t)],
  [/^Searching\s+(.+)$/s, (m, f, t) => titled('Glob', { pattern: m[1] ?? '' }, f, t)],
  [/^Find files matching `(.*)`$/s, (m, f, t) => titled('Glob', { pattern: m[1] ?? '' }, { ...f, ...(str(f, 'query') && !str(f, 'pattern') ? { pattern: str(f, 'query') } : {}) }, t)],
  [/^Find$/, (_m, f, t) => titled('Glob', {}, f, t)],
  [/^Glob:\s*(.+)$/s, (m, f, t) => titled('Glob', { pattern: (m[1] ?? '').trim() }, f, t)],
  [/^Listed\s+(?!MCP tools for\s)(.+)$/s, (m, f, t) => titled('LS', listTitle(m[1] ?? ''), f, t)],
  [/^List:\s*(.+)$/s, (m, f, t) => titled('LS', { path: (m[1] ?? '').trim() }, f, t)],
  [/^(?:Fetched\s+|Fetching:\s*)(\S+)$/s, (m, f, t) => titled('WebFetch', { url: NOT_ELLIPSIS(m[1] ?? '') }, f, t)],
  [/^Invoked? skill\s+(\S+)$/, (m, f, t) => titled('Skill', { skill: m[1] ?? '' }, f, t)],
  // OpenCode's `Loaded skill: name`.
  [/^Loaded skill:\s*(\S+)$/, (m, f) => ({ name: 'Skill', fields: { ...f, skill: str(f, 'name', 'skill') || m[1] || '' } })],
  [/^Stopping task\s+(\S+)$/, (m, f) => ({ name: 'TaskStop', fields: { ...f, task_id: str(f, 'task_id') || m[1] } })],
  [/^Waiting up to (\S+) for task\s/, (m, f) => kimiWait(m[1] ?? '', f)],
  [/^Waiting [\dhms ]+\/ [\dhms ]+· \d+ background tasks? still running$/, (_m, f) => kimiWait('', f)],
  // Gemini CLI's `activate_skill` (`{ name, arguments }`).
  [/^activate_skill$/, (_m, f) => ({ name: 'Skill', fields: { skill: str(f, 'name', 'skill'), args: str(f, 'arguments', 'args') } })],
  [/^read_skill$/, (_m, f) => ({ name: 'Skill', fields: { skill: str(f, 'name', 'skill') } })],
  [/^search$/, (_m, f) => ({ name: 'Grep', fields: f })],
  [/^(?:web_search|webSearch)$/, (_m, f) => ({ name: 'WebSearch', fields: f })],
  [/(?:^|[\s.])web_run$/, (_m, f) => webRun(f)],
  [/^Requesting to enter plan mode$/, (_m, f) => ({ name: 'EnterPlanMode', fields: f })],
  [/^Begin (?:a )?file change capture\b/i, (_m, f) => ({ name: 'BeginFileCapture', fields: f })],
];

/** Codex's `search_service.web_run` (`{ search_query | system2_search_query: [{ q }] }`, `{ open: [{ ref_id }] }`, `{ click: […] }`)
 *  as the web search action it took, in the shape of Codex's own `web_search` items. */
function webRun(fields: Fields): Canonical {
  const list = (key: string): Fields[] => (Array.isArray(fields[key]) ? (fields[key] as unknown[]) : []).filter((item): item is Fields => Boolean(item) && typeof item === 'object');
  const queries = [...list('search_query'), ...list('system2_search_query')].map(item => str(item, 'q')).filter(Boolean);
  if (queries.length) return { name: 'WebSearch', fields: { action: { type: 'search', queries } } };
  const urls = list('open').map(item => str(item, 'ref_id')).filter(url => /^https?:\/\//.test(url));
  if (urls.length) return { name: 'WebSearch', fields: { action: { type: 'openPage', url: urls[0], others: urls.length - 1 } } };
  const clicks = list('click').length;
  return { name: 'WebSearch', fields: clicks ? { action: { type: 'click', clicks } } : {} };
}

/** OpenCode names a call by its title: a write by its file (`src/index.html` with `{ content }`), a subagent by its
 *  description (`{ description, prompt, subagent_type }`), its plan by its size (`6 todos`). */
const FILE_TITLE = /^[^\s]{0,400}\.[A-Za-z0-9]{1,10}$/;
function openCodeTitle(title: string, fields: Fields): Canonical | undefined {
  if (str(fields, 'subagent_type') && str(fields, 'prompt')) return { name: 'Task', fields };
  if (/^\d+ todos?$/.test(title) && Array.isArray(fields.todos)) return todos(fields);
  // The title may be the file's own (home) path, which the row shows by name only.
  const path = str(fields, 'file_path', 'path', 'filePath');
  if (FILE_TITLE.test(title) && typeof fields.content === 'string' && (!path || path === title)) return file('Write', title, fields);
  return undefined;
}

function canonical(tool: ToolLike): Canonical | undefined {
  const fields = fieldsOf(tool.input);
  for (const [pattern, build] of RULES) {
    const match = pattern.exec(tool.name.trim());
    if (match) return build(match, fields, tool);
  }
  return openCodeTitle(tool.name.trim(), fields) ?? shellTitle(tool.name.trim(), fields);
}

/** A copy of `tool` under its canonical name and JSON input; unknown names return `tool` itself. */
export function normalizeTool<T extends ToolLike>(tool: T): T {
  const result = canonical(tool);
  if (!result) return tool;
  const input = JSON.stringify(result.fields);
  const output = result.output ?? tool.output;
  if (result.name === tool.name && output === tool.output && (input === tool.input || input === JSON.stringify(fieldsOf(tool.input)))) return tool;
  return { ...tool, name: result.name, input, output };
}

/** The absolute path Codex saved a generated image to (its record's output; a failure records its type instead), else ''. */
export function generatedImagePath(tool: ToolLike): string {
  const path = tool.name === 'Generate image' ? tool.output.trim() : '';
  return IMAGE.test(path) && ABSOLUTE.test(path) && !path.includes('\n') ? path : '';
}

/** The image path a tool looked at (ViewImage, Read of an image file) or generated, else ''. */
export function imagePathOf(tool: ToolLike): string {
  const generated = generatedImagePath(tool);
  if (generated) return generated;
  const normal = normalizeTool(tool);
  const fields = fieldsOf(normal.input);
  const path = normal.name === 'ViewImage' ? str(fields, 'path')
    : normal.name === 'Read' ? str(fields, 'file_path') : '';
  return IMAGE.test(path) ? path : '';
}
