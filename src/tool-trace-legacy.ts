import { PARTIAL_KEY, isCut, withoutCut, type Fields } from './tool-fields.ts';
import { lines as splitLines, stripAnsi } from './tool-text.ts';

export { stripAnsi };

/* Records older harness versions saved in their own shapes, mapped to canonical calls for tool-names.ts:
 * Devin's `Ran grep, rg in ./dir` (the input holds the command's output, not the command), Devin's plain-text
 * `Edit file` (`path\n--- Before\n…\n+++ After\n…`) and Codex's `Update files` (`update <path>` lines in, a diff
 * per file out). Counts are only given when the record holds the whole change; a cut record never claims `+0 −0`. Pure. */

type ToolLike = { name: string; input: string; output: string };
/** A canonical call; `output` replaces the record's output when set. */
export type LegacyCall = { name: string; fields: Fields; output?: string };

// Titles and file lines are split with string searches, never a lazy group before `\s+…`, which backtracks over whitespace.
const RAN_LEAD = /^Ran\s+/;
const RAN_WHERE = /\sin\s/;
const BEFORE_AFTER = /^--- Before\n([\s\S]*?)\n+\+\+\+ After\n([\s\S]*)$/;
const FILE_LINE = /^(update|add|delete|move)\s(.*)$/;
const ARROW = /\s(?:→|->)\s/;
const ACTIONS: Record<string, string> = { update: 'Update', move: 'Update', add: 'Add', delete: 'Delete' };

function hasCommand(fields: Fields): boolean {
  return ['command', 'cmd'].some(key => typeof fields[key] === 'string' && fields[key] !== '');
}

/** Lines added and removed between two snippets, around their shared first and last lines. */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before), b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  return { added: b.length - pre - post, removed: a.length - pre - post };
}

/** `Ran python3, rg in ./src` → its programs and where they ran. */
function ranTitle(title: string): { programs: string[]; where: string } {
  const lead = RAN_LEAD.exec(title);
  if (!lead) return { programs: [], where: '' };
  const rest = title.slice(lead[0].length);
  const at = rest.search(RAN_WHERE);
  const where = at < 0 ? '' : rest.slice(at + 1).replace(/^in\s/, '').trim();
  const named = at < 0 || !where ? rest : rest.slice(0, at);
  return { programs: named.split(',').map(name => name.trim()).filter(Boolean), where };
}

/** `Ran python3, rg in ./src`: a JSON `command` stays a command; otherwise the programs come from the title and the input is output. */
export function ranCall(tool: ToolLike, fields: Fields): LegacyCall {
  if (hasCommand(fields)) return { name: 'Bash', fields };
  const { programs, where } = ranTitle(tool.name.trim());
  const shown = tool.output.trim() ? tool.output : withoutCut(tool.input);
  const cut = isCut(tool.output.trim() ? tool.output : tool.input);
  return {
    name: 'Bash',
    fields: { _programs: programs, ...(where ? { _where: where } : {}), ...(cut ? { [PARTIAL_KEY]: true } : {}) },
    output: stripAnsi(withoutCut(shown)),
  };
}

const BEFORE_LEAD = '--- Before';

/** A record cut at 4 KB before its new text still shows where it edited: the old lines it kept, as unchanged context in a
 *  patch for the diff card. No counts: the change itself was cut off. */
function cutRegion(path: string, rest: string[]): { patch?: string } {
  if (rest[0] !== BEFORE_LEAD) return {};
  const before = rest.slice(1);
  const end = before.indexOf('+++ After');
  const kept = (end < 0 ? before : before.slice(0, end)).filter((line, index, all) => line || index < all.length - 1);
  return kept.length ? { patch: [`*** Update File: ${path}`, ...kept.map(line => ` ${line}`)].join('\n') } : {};
}

/** Devin's plain-text `Edit file`; undefined for a JSON input (the caller's usual file rule). */
export function devinEditCall(tool: ToolLike): LegacyCall | undefined {
  if (tool.input.trim().startsWith('{')) return undefined;
  const [first = '', ...rest] = withoutCut(tool.input).split('\n');
  const path = first.trim();
  const match = isCut(tool.input) ? null : BEFORE_AFTER.exec(rest.join('\n'));
  // Cut before `+++ After`: the record never got to the change itself (the card says so).
  const unrecorded = rest.includes('+++ After') ? {} : { _unrecorded: true };
  if (!match) return { name: 'Edit', fields: { file_path: path, ...cutRegion(path, rest), [PARTIAL_KEY]: true, ...unrecorded } };
  const before = match[1], after = match[2].replace(/\n$/, '');
  const { added, removed } = lineDelta(before, after);
  return { name: 'Edit', fields: { file_path: path, old_string: before, new_string: after, _added: added, _removed: removed } };
}

/** Devin's plain-text `Wrote ./path` (`/abs/path\n--- Before\n\n+++ After\n<content>`); undefined for a JSON input. */
export function devinWriteCall(tool: ToolLike): LegacyCall | undefined {
  if (tool.input.trim().startsWith('{') || !tool.input.trim()) return undefined;
  const [first = '', ...rest] = withoutCut(tool.input).split('\n');
  const after = /^--- Before\n[\s\S]*?\n*\+\+\+ After\n([\s\S]*)$/.exec(rest.join('\n'));
  const content = (after?.[1] ?? '').replace(/\n+$/, '');
  return { name: 'Write', fields: { file_path: first.trim(), content, ...(isCut(tool.input) || !after ? { [PARTIAL_KEY]: true } : {}) } };
}

type FileEntry = { action: string; path: string; from?: string };

function fileEntries(input: string): FileEntry[] {
  return splitLines(withoutCut(input)).flatMap(line => {
    const match = FILE_LINE.exec(line.trim());
    const rest = match?.[2].trim() ?? '';
    if (!match || !rest) return [];
    const arrow = ARROW.exec(rest);
    const to = arrow ? rest.slice(arrow.index + arrow[0].length).trim() : '';
    return [to ? { action: match[1], path: to, from: rest.slice(0, arrow?.index).trim() } : { action: match[1], path: rest }];
  });
}

/** The output's per-file sections as a `*** Update File:` patch, with its added and removed line counts. */
function filePatch(entries: FileEntry[], output: string): { patch: string; added: number; removed: number; files: number } {
  const out: string[] = [];
  let current: FileEntry | undefined, added = 0, removed = 0, files = 0;
  for (const line of splitLines(output)) {
    const entry = entries.find(item => line.trim() === item.path || line.trim() === item.from);
    if (entry) { current = entry; files++; out.push(`*** ${ACTIONS[entry.action] ?? 'Update'} File: ${entry.path}`); continue; }
    if (!current) continue;
    const sign = current.action === 'add' ? '+' : current.action === 'delete' ? '-' : '';
    const body = sign + line;
    if (/^\+/.test(body)) added++;
    else if (/^-/.test(body)) removed++;
    out.push(body);
  }
  return { patch: out.join('\n'), added, removed, files };
}

/** `_action: 'add'` (or `'delete'`) when every file was only created (or only deleted), so the row reads `Created x`. */
function soleAction(entries: FileEntry[]): { _action?: 'add' | 'delete' } {
  const [first] = entries;
  if (!first || (first.action !== 'add' && first.action !== 'delete')) return {};
  return entries.every(entry => entry.action === first.action) ? { _action: first.action } : {};
}

/** Codex's legacy `Update files`: an edit of the first file (+N more), its diff as a patch, counts from the diff. */
export function updateFilesCall(tool: ToolLike): LegacyCall {
  const entries = fileEntries(tool.input);
  const { patch, added, removed, files } = filePatch(entries, stripAnsi(withoutCut(tool.output)));
  const known = files > 0 && !isCut(tool.output) && !isCut(tool.input);
  return {
    name: 'apply_patch',
    fields: {
      file_path: entries[0]?.path ?? '', files: entries.map(entry => entry.path), patch, ...soleAction(entries),
      ...(known ? { _added: added, _removed: removed } : { [PARTIAL_KEY]: true }),
    },
  };
}
