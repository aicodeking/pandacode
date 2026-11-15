/* Token saver: per-thread guidance that makes agents spend fewer tokens. Packs are
 * short, benchmarked or well-understood instructions sent as a folded context block
 * with a message — only when they change, and as an occasional reminder — so every
 * harness gets them and they don't cost more than they save.
 *
 * Caveman Full is caveman-micro (MIT, kuba-guzik/caveman-micro), the 85-token distillation
 * of Caveman (Apache-2.0, JuliusBrussee/caveman); Lite and Ultra and the exceptions follow
 * Caveman's own rules. Savings figures are the projects' published benchmarks or estimates. */
import { t } from './i18n.ts';

export type PackId = 'caveman' | 'lean-code' | 'quiet-tools' | 'rtk';
export type Level = 'lite' | 'full' | 'ultra';
export type Pack = { id: PackId; title: string; summary: string; saves: string; source: string; needs?: 'rtk' };
export type ThreadSaver = { packs: PackId[]; level: Level; sentKey?: string; turns?: number; /** When the current configuration was last sent, for measured usage. */ changedAt?: number };
type Store = { defaults: ThreadSaver | null; threads: Record<string, ThreadSaver> };

export const PACKS: Pack[] = [
  { id: 'caveman', title: 'Caveman', summary: 'Terse replies: answer first, no filler, every technical fact kept.', saves: '15–65% of replies', source: 'caveman · caveman-micro benchmarks' },
  { id: 'lean-code', title: 'Lean code', summary: 'Least code that works: reuse what exists, no speculative extras, diffs not whole files.', saves: '~20–40% of code output (est.)', source: 'YAGNI, as in ponytail and Chisle' },
  { id: 'quiet-tools', title: 'Quiet tools', summary: 'Targeted searches, line ranges, quiet flags, no re-reading files.', saves: '~20–50% of tool input (est.)', source: 'context hygiene' },
  { id: 'rtk', title: 'RTK compression', summary: 'Runs commands through rtk, which compresses their output before the agent reads it.', saves: '60–90% of command output', source: 'rtk-ai/rtk', needs: 'rtk' },
];
export const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: 'lite', label: t('Lite'), hint: t('Brief, normal grammar') },
  { id: 'full', label: t('Full'), hint: t('Caveman voice') },
  { id: 'ultra', label: t('Ultra'), hint: t('Telegraphic') },
];

const CAVEMAN: Record<Level, string> = {
  lite: 'Answer first. No greeting, preamble, recap, or offers of further help. Short sentences in normal grammar. Keep every technical detail, path, number and error exact.',
  full: [
    'Respond like smart caveman. Cut all filler, keep technical substance.',
    '- Drop articles (a, an, the), filler (just, really, basically, actually).',
    '- Drop pleasantries (sure, certainly, happy to).',
    '- No hedging. Fragments fine. Short synonyms.',
    '- Technical terms stay exact. Code blocks unchanged.',
    '- Pattern: [thing] [action] [reason]. [next step].',
  ].join('\n'),
  ultra: [
    'Telegraphic. Answer first, then reason, then next step. Drop articles, connectives and pleasantries.',
    '- One point per line; lists over prose. Code, diffs and commands over explanation.',
    '- No text between routine tool calls; one line per phase, one result line at the end.',
    '- Never drop not/never/no/only. Code, paths, numbers and errors stay verbatim.',
  ].join('\n'),
};
const EXCEPTIONS = 'Use plain full sentences for security warnings, irreversible actions, ordered steps, questions to the user, and anything written to files, commits, PRs or docs.';
const GUIDANCE: Record<Exclude<PackId, 'caveman'>, string> = {
  'lean-code': 'Write the least code that fully solves the task. Reuse existing helpers, the standard library and platform features before adding code or dependencies. No speculative abstractions, options or unrequested features. No new comments or docs unless asked. In chat, show changed lines with minimal context, not whole files.',
  'quiet-tools': 'Keep tool output small. Search with targeted patterns (rg -n pattern path, rg -l) instead of listing or dumping trees. Read only the line ranges you need; do not re-read a file you already read unless it changed. Use quiet flags (git --no-pager, -q, --silent) and cap long output with head or tail. Run the tests closest to the change before the full suite.',
  rtk: 'rtk is installed and compresses command output. Prefix shell commands with rtk: rtk git status, rtk git diff, rtk git log, rtk ls, rtk read <file>, rtk grep <pattern>, rtk find, and test runners such as rtk npm test or rtk cargo test. If rtk rejects a command, run it plainly.',
};

const KEY = 'pandacode.tokenSaver';
/** Guidance is restated this many messages after it was last sent, so long threads keep it. */
export const REMIND_EVERY = 8;
export const HEADER = 'Response style (PandaCode token saver';

function read(): Store {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && typeof value === 'object') return { defaults: value.defaults ?? null, threads: value.threads ?? {} };
  } catch { /* Start fresh. */ }
  return { defaults: null, threads: {} };
}
function write(store: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* This session keeps it. */ }
}
const valid = (packs: unknown): PackId[] => Array.isArray(packs) ? PACKS.map(pack => pack.id).filter(id => packs.includes(id)) : [];

/** A thread's saver; a new thread starts from the saved default, if any. */
export function threadSaver(sessionId: string): ThreadSaver {
  const store = read(), saved = store.threads[sessionId] ?? store.defaults ?? { packs: [], level: 'full' };
  return { ...saved, packs: valid(saved.packs), level: LEVELS.some(level => level.id === saved.level) ? saved.level : 'full', changedAt: typeof saved.changedAt === 'number' ? saved.changedAt : undefined };
}
export function updateThread(sessionId: string, patch: Partial<Pick<ThreadSaver, 'packs' | 'level'>>): ThreadSaver {
  const store = read(), next = { ...threadSaver(sessionId), ...patch };
  write({ ...store, threads: { ...store.threads, [sessionId]: next } });
  return next;
}
export function defaults(): ThreadSaver | null { return read().defaults; }
export function setDefaults(value: ThreadSaver | null): void {
  write({ ...read(), defaults: value && { packs: valid(value.packs), level: value.level } });
}

/** The guidance for a set of packs, or an explicit switch-off. */
export function guidance(packs: PackId[], level: Level, available: { rtk: boolean }): string {
  const active = packs.filter(id => id !== 'rtk' || available.rtk);
  if (!active.length) return `${HEADER}): off. Answer in your normal style again.`;
  const lines = active.map(id => id === 'caveman' ? CAVEMAN[level] : GUIDANCE[id]);
  if (active.includes('caveman')) lines.push(EXCEPTIONS);
  return `${HEADER}, applies to this whole thread until changed; reader pays per token):\n${lines.join('\n\n')}`;
}

/**
 * The block to append to an outgoing message, or '' when nothing needs saying: guidance
 * goes out when it changes, on a thread's first message, and every REMIND_EVERY messages.
 */
export function contextFor(sessionId: string, available: { rtk: boolean }): string {
  const saver = threadSaver(sessionId);
  const active = saver.packs.filter(id => id !== 'rtk' || available.rtk);
  const key = active.length ? `${active.join(',')}:${saver.level}` : '';
  const turns = (saver.turns ?? 0) + 1;
  const changed = key !== (saver.sentKey ?? '');
  const due = Boolean(key) && (changed || turns >= REMIND_EVERY);
  const store = read();
  write({ ...store, threads: { ...store.threads, [sessionId]: { ...saver, sentKey: key, turns: due || changed ? 0 : turns, ...(changed && { changedAt: Date.now() }) } } });
  if (!changed && !due) return '';
  return `\n\n${guidance(saver.packs, saver.level, available)}`;
}

/** Rough combined share of tokens saved, for the meter: savings compound, they don't add. */
export function estimate(packs: PackId[], level: Level, available: { rtk: boolean }): number {
  const share: Record<PackId, number> = { caveman: level === 'lite' ? 0.12 : level === 'full' ? 0.25 : 0.35, 'lean-code': 0.12, 'quiet-tools': 0.15, rtk: 0.2 };
  const kept = packs.filter(id => id !== 'rtk' || available.rtk).reduce((left, id) => left * (1 - share[id]), 1);
  return Math.round((1 - kept) * 100);
}

/** Share of the context window at which the panel offers to tighten a thread's saver. */
export const CONTEXT_TIGHTEN_AT = 0.75;

/** What Tighten applies in one click: packs to add, and Ultra when the level is below it. */
export type Tighten = { addPacks: PackId[]; level?: Level };

/** The tightening to offer once a thread's context is mostly full, or null when nothing is left or the window is unknown. */
export function suggestion(packs: PackId[], level: Level, usage: { usedTokens: number; contextWindow?: number | null } | null | undefined): Tighten | null {
  if (!usage?.contextWindow || usage.usedTokens / usage.contextWindow < CONTEXT_TIGHTEN_AT) return null;
  const addPacks = (['caveman', 'quiet-tools'] as PackId[]).filter(id => !packs.includes(id));
  const nextLevel = level !== 'ultra' ? 'ultra' as Level : undefined;
  if (!addPacks.length && !nextLevel) return null;
  return { addPacks, ...(nextLevel && { level: nextLevel }) };
}
