import { icon } from './dom.ts';
import { brandFor } from './trace-brands.ts';
import { fieldsOf, normalizeTool } from './tool-names.ts';
import { pandacodeFamily, pandacodeTool } from './tool-trace-pandacode.ts';
import { browserScreenshot, shellSummaryNoun, specialSummaryNoun } from './tool-trace-intent.ts';
import type { Tool, TraceKind } from './tool-trace.ts';
import {
  describeTool, failedVerb, kindIcon, kindNouns, mcpAction, mcpParts, shellCommand, toolBlocked, toolDenied, toolFailed, toolInterrupted, traceIcon,
  traceKind, toolUnavailable,
} from './tool-trace.ts';

/* Folded group headers: `Ran 5 commands · 3 failed · 1 blocked · 1 denied`, and the marks beside them. Every step that ran
 * counts in the sentence; the tallies after it say how many are still going, went wrong, were blocked by a harness rule or
 * were denied by the user. Pure. */

type Noun = [string, string, string, string];
/** `count`: how many things one call stands for (`Update files` touching 2 files counts 2). */
type SummaryNoun = { key: string; noun: Noun; count?: number };
type Mode = 'past' | 'running' | 'failed';
/** `failed` is the tally after the sentence; `allFailed` a sentence that already says `Couldn't …` for every call, which
 *  then carries no tally of its own. */
export type GroupSummary = {
  sentence: string; running: number; failed: number; blocked: number; denied: number; interrupted: number; allFailed?: boolean;
  /** Failed edits and writes the sentence names (`couldn't edit 1 file`); a failure, though not tallied. */
  editsFailed?: number;
};

// A summary names at most this many verbs; the rest read as their biggest count and `and N more steps`, so it stays short.
const SUMMARY_PHRASES = 2;
// Summary phrasing: searches read as "Ran 2 searches" like the reference, the rest keep their row verb.
const SUMMARY_VERB: Partial<Record<TraceKind, [string, string]>> = { search: ['Running', 'Ran'] };
// PandaCode tool families in summaries: [running verb, finished verb, singular, plural].
const FAMILY_NOUNS: Record<string, Noun> = {
  team: ['Coordinating', 'Coordinated', 'with the team', 'with the team'],
  task: ['Making', 'Made', 'task update', 'task updates'],
  vm: ['Using', 'Used', 'the VM', 'the VM'],
  simulator: ['Using', 'Used', 'the simulator', 'the simulator'],
  design: ['Making', 'Made', 'design edit', 'design edits'],
  browser: ['Using', 'Used', 'preview tool', 'preview tools'],
  cloud: ['Running', 'Ran', 'cloud command', 'cloud commands'],
  code: ['Using', 'Used', 'code tool', 'code tools'],
  moodboard: ['Reading', 'Read', 'moodboard', 'moodboards'],
  bot: ['Making', 'Made', 'bot change', 'bot changes'],
  jev: ['Running', 'Ran', 'Jev check', 'Jev checks'],
  meta: ['Updating', 'Updated', 'task detail', 'task details'],
};
/** PandaCode tools that read better by what they made than by their family. */
const TOOL_NOUNS: Record<string, Noun> = {
  progress_snapshot: ['Posting', 'Posted', 'snapshot', 'snapshots'],
  // Begin and complete are one bookkeeping act, counted without a number.
  track_files: ['Tracking', 'Tracked', '', 'file changes'],
  title: ['Naming', 'Named', '', 'the task'],
};
const UNAVAILABLE: Noun = ['Asking for', 'Asked for', 'unavailable tool', 'unavailable tools'];
const WEB: Noun = ['Searching', 'Searched', 'search', 'searches'];
/** Nouns that read as repeats rather than counts: `Ran tests`, `Ran tests twice`, `Used the simulator 3 times`. */
const REPEATED: Record<string, string> = {
  test: 'tests', install: 'packages', simulator: 'the simulator', vm: 'the VM', team: 'with the team', web: 'the web',
};
/** Screenshots of a simulator, VM or browser count with the images an agent viewed. */
const SCREENSHOT_TOOLS = /^(?:vm_screenshot|simulator_screenshot|capture_browser|jev_screenshot)$/;

function joinPhrases(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A PandaCode family's or a third-party MCP call's noun: searches count with searches, reads as sources. */
function mcpNoun(tool: Tool): SummaryNoun | undefined {
  const own = pandacodeTool(tool.name) ?? '';
  if (TOOL_NOUNS[own]) return { key: own, noun: TOOL_NOUNS[own] };
  if (SCREENSHOT_TOOLS.test(own) || browserScreenshot(tool.name, fieldsOf(tool.input))) return { key: 'image', noun: kindNouns('image') };
  const family = pandacodeFamily(tool.name);
  if (family && FAMILY_NOUNS[family]) return { key: family, noun: FAMILY_NOUNS[family] };
  const action = mcpAction(mcpParts(tool.name).tool);
  if (action === 'search') return { key: 'search', noun: ['Running', 'Ran', 'search', 'searches'] };
  if (action === 'read') return { key: 'source', noun: ['Reading', 'Read', 'source', 'sources'] };
  return undefined;
}

/** How one call counts: its own noun (Codex items, shell intents, PandaCode families), else its kind's. */
function summaryNoun(raw: Tool | undefined): SummaryNoun {
  const tool = raw && normalizeTool(raw);
  if (tool && toolUnavailable(tool)) return { key: 'unavailable', noun: UNAVAILABLE };
  const kind = tool ? traceKind(tool) : 'tool';
  if (kind === 'web') return { key: 'web', noun: WEB };
  const own = tool ? specialSummaryNoun(tool) : undefined;
  if (own) return own;
  const shell = kind === 'shell' && tool && !pandacodeTool(tool.name) ? shellSummaryNoun(shellCommand(tool.input, fieldsOf(tool.input))) : undefined;
  if (shell) return shell;
  const mcp = kind === 'mcp' && tool ? mcpNoun(tool) : undefined;
  if (mcp) return mcp;
  const [present, past, one, many] = kindNouns(kind);
  const [sPresent, sPast] = SUMMARY_VERB[kind] ?? [present, past];
  return { key: kind, noun: [sPresent, sPast, one, many], ...fileCount(kind, tool) };
}

/** A read or edit of several files (Codex `Update files`, Devin multi-file reads) counts each file. */
function fileCount(kind: TraceKind, tool: Tool | undefined): { count?: number } {
  if (!tool || (kind !== 'edit' && kind !== 'read')) return {};
  const files = fieldsOf(tool.input).files;
  return Array.isArray(files) && files.length > 1 ? { count: files.length } : {};
}

function verbFor(noun: Noun, mode: Mode): string {
  if (mode === 'failed') return failedVerb(noun[0]);
  return noun[mode === 'past' ? 1 : 0];
}
function lowerLead(verb: string): string { return verb.charAt(0).toLowerCase() + verb.slice(1); }

type Entry = { key: string; noun: Noun; plan: boolean; count: number };

/** Calls counted by how they read: entries with the same verb and noun merge (`Used 2 tools`, never `1 tool and 1 tool`);
 *  test runs keep their own phrase, and the commands beside them read as other commands (`Ran tests twice and 3 other commands`). */
function countEntries(tools: (Tool | undefined)[]): Entry[] {
  const nouns = tools.map(summaryNoun);
  const tests = nouns.some(own => own.key === 'test');
  const entries = new Map<string, Entry>();
  for (const own of nouns) {
    const { key, noun } = own.key === 'shell' && tests ? { key: own.key, noun: OTHER_COMMANDS } : own;
    const merge = key === 'todo' ? key : noun.join('|');
    entries.set(merge, { key, noun, plan: key === 'todo', count: (entries.get(merge)?.count ?? 0) + (own.count ?? 1) });
  }
  // `ran tests and 2 other commands`: the test runs lead the commands they are set apart from.
  const all = [...entries.values()];
  return tests ? [...all.filter(entry => entry.key === 'test'), ...all.filter(entry => entry.key !== 'test')] : all;
}
const OTHER_COMMANDS: Noun = ['Running', 'Ran', 'other command', 'other commands'];

function phraseOf({ key, noun, plan, count }: Entry): string {
  if (plan) return 'the plan';
  if (REPEATED[key]) return REPEATED[key] + (count === 2 ? ' twice' : count > 2 ? ` ${count} times` : '');
  return !noun[2] ? noun[3] : `${count} ${noun[count === 1 ? 2 : 3]}`;
}

type Group = { verb: string; entries: Entry[] };

/** Entries by how they read: one verb leads all its nouns (`ran 1 search and 3 commands`), in order of first appearance. */
function groupByVerb(entries: Entry[], mode: Mode): Group[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const verb = verbFor(entry.noun, mode);
    groups.set(verb, [...(groups.get(verb) ?? []), entry]);
  }
  return [...groups].map(([verb, members]) => ({ verb, entries: members }));
}

/** A group's parts: its verb leads the first noun, the rest follow on their own (`ran 1 search`, `3 commands`). */
function groupParts({ verb, entries }: Group): string[] {
  const [first, ...rest] = entries.map(phraseOf);
  return [`${lowerLead(verb)} ${first}`, ...rest];
}

/** What the sentence leaves out: named in full when that is at most one step more than its biggest entry (`viewed 2 images
 *  and fetched 1 page`), else its biggest entry by name and a count of the rest (`and 2 more steps`), never a `+N more page`
 *  fragment or `and N other steps` hung on a verb. */
function hiddenParts(hidden: Group[]): { parts: string[]; more: number } {
  const all = hidden.flatMap(group => group.entries.map(entry => ({ verb: group.verb, entry })));
  if (all.length <= 2 || hidden.length === 1) return { parts: hidden.flatMap(groupParts), more: 0 };
  const biggest = all.reduce((best, next) => next.entry.count > best.entry.count ? next : best);
  const more = all.filter(item => item !== biggest).reduce((sum, item) => sum + item.entry.count, 0);
  return { parts: groupParts({ verb: biggest.verb, entries: [biggest.entry] }), more };
}

/** `read 1 file, ran 1 search and 3 commands`: merged by verb, at most two verbs then what is hidden, then any `extra`
 *  clauses (failed edits). Every part joins with a comma and only the last with `and` (`ran tests, 4 searches, 2 other
 *  commands and read 9 files`); what stays hidden is that last part (`…, wrote 2 files and 2 more steps`). The plan and
 *  agent waits read without a count. */
function sentenceOf(tools: (Tool | undefined)[], mode: Mode, extra: string[] = []): string {
  const groups = groupByVerb(countEntries(tools), mode);
  const shown = groups.slice(0, SUMMARY_PHRASES);
  const { parts, more } = hiddenParts(groups.slice(SUMMARY_PHRASES));
  const tail = more > 0 ? [`${more} more ${more === 1 ? 'step' : 'steps'}`] : [];
  return joinPhrases([...shown.flatMap(groupParts), ...parts, ...extra, ...tail]);
}

/** Past tense once anything finished, else present tense while calls run, else `Couldn't …`. */
function modeOf(finished: number, running: number, failed: number): Mode {
  return finished > 0 ? 'past' : running > 0 ? 'running' : failed > 0 ? 'failed' : 'past';
}

/** Row verbs that are a check's finding, not a failure to run it. */
const CHECK_OUTCOME = /^(?:Tests failed|Typecheck failed|Lint found problems|Build failed)$/;

/** `Blocked 2 calls`, `Denied 1 call`, `Blocked 1 call · 1 denied`: a group of nothing but refusals. */
function refusedOnly(blocked: number, denied: number): GroupSummary {
  const [verb, count, rest] = blocked ? ['Blocked', blocked, denied] : ['Denied', denied, 0];
  return { sentence: `${verb} ${count} ${count === 1 ? 'call' : 'calls'}`, running: 0, failed: 0, blocked: 0, denied: rest, interrupted: 0 };
}

/** `Interrupted 2 calls`: a group whose every call the turn cut off. */
function interruptedOnly(count: number, blocked: number, denied: number): GroupSummary {
  return { sentence: `Interrupted ${count} ${count === 1 ? 'call' : 'calls'}`, running: 0, failed: 0, blocked, denied, interrupted: 0 };
}

/** The sentence says what got done (`Ran 2 commands`): a failed or interrupted call is never a done verb, only a tally
 *  (a check that ran and found failures, `Tests failed`, did run). At most two phrases then what is hidden; a refused call
 *  never ran, so it is only `· 1 blocked` (a harness rule) or `· 1 denied` (the user). Only a live turn has running calls:
 *  a saved record stuck at `running` counts as finished. With nothing done, failures read `Couldn't …`. */
export function summarizeGroup(tools: (Tool | undefined)[], options: { live?: boolean } = {}): GroupSummary {
  const ran = tools.filter(tool => !(tool && toolBlocked(tool)));
  const denied = tools.filter(tool => tool && toolDenied(tool)).length;
  const blocked = tools.length - ran.length - denied;
  if (!ran.length) return refusedOnly(blocked, denied);
  const checked = (tool: Tool) => CHECK_OUTCOME.test(describeTool(tool).verb);
  const failedTools = ran.filter(tool => tool && toolFailed(tool));
  const broken = failedTools.filter(tool => tool && !checked(tool));
  const interrupted = ran.filter(tool => tool && toolInterrupted(tool)).length;
  const done = ran.filter(tool => !(tool && (broken.includes(tool) || toolInterrupted(tool))));
  const running = options.live ? done.filter(tool => tool?.status === 'running').length : 0;
  if (!done.length && !broken.length) return interruptedOnly(interrupted, blocked, denied);
  const mode = modeOf(done.length - running, running, broken.length);
  // `Couldn't run 1 command` already says every call failed; a `· 1 failed` after it would say it twice.
  const allFailed = mode === 'failed';
  // Failed edits and writes are named in the sentence (`… and couldn't edit 1 file`), not just tallied.
  const edits = allFailed ? [] : broken.filter(tool => tool && FILE_KINDS.has(traceKind(normalizeTool(tool))));
  const failedClauses = edits.length ? [lowerLead(sentenceOf(edits, 'failed'))] : [];
  const sentence = sentenceOf(allFailed ? broken : done, mode, failedClauses) + (mode === 'running' ? '…' : '');
  const upper = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return { sentence: upper, running: mode === 'past' ? running : 0, failed: allFailed ? 0 : failedTools.length - edits.length, blocked, denied, interrupted, allFailed, editsFailed: edits.length };
}

const FILE_KINDS = new Set<TraceKind>(['edit', 'write']);

/** A group's tallies after its sentence, in order: `[2, 'running']`, `[1, 'failed']`, then the calls that never finished:
 *  `[1, 'blocked']` when only one kind stopped, else one `[3, 'stopped']` so the sentence keeps its room; zero counts dropped. */
export function groupTallies({ running, failed, blocked, denied, interrupted }: GroupSummary): [number, string][] {
  const stops: [number, string][] = ([[blocked, 'blocked'], [denied, 'denied'], [interrupted, 'interrupted']] as [number, string][]).filter(([count]) => count > 0);
  const stopped: [number, string][] = stops.length > 1 ? [[stops.reduce((sum, [count]) => sum + count, 0), 'stopped']] : stops;
  return ([[running, 'running'], [failed, 'failed']] as [number, string][]).filter(([count]) => count > 0).concat(stopped);
}

/** The group sentence with its state counts: `Ran 5 commands · 1 running · 3 failed · 3 stopped`. */
export function summarizeTools(tools: (Tool | undefined)[], options: { live?: boolean } = {}): string {
  const summary = summarizeGroup(tools, options);
  return summary.sentence + groupTallies(summary).map(([count, word]) => ` · ${count} ${word}`).join('');
}

/** Up to `limit` distinct marks for the folded header: brand logos for MCP servers, else the row's line icon. */
export function summaryIcons(tools: (Tool | undefined)[], limit = 3): string[] {
  const marks = new Map<string, string>();
  for (const tool of tools) {
    const kind = tool ? traceKind(tool) : 'tool';
    const brand = tool && kind === 'mcp' && !pandacodeTool(tool.name) ? brandFor(mcpParts(tool.name).server) : undefined;
    const name = tool ? traceIcon(describeTool(tool)) : kindIcon('tool');
    const id = brand ? 'brand:' + brand.id : name;
    if (!marks.has(id)) marks.set(id, brand?.svg ?? icon(name));
  }
  return [...marks.values()].slice(0, limit);
}
