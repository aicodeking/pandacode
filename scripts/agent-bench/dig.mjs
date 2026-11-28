#!/usr/bin/env node
// Reads causes out of transcripts: `node dig.mjs <errors|sizes|seen|edits|empty> --runs dirA,dirB [--task id]`.
// Output can hold transcript text and local paths, so it stays out of the repo.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mentions, normalize, parseEvents } from './metrics.mjs';

let args;
let runs;
const uses = run => run.events.filter(e => e.type === 'assistant').flatMap(e => (e.message?.content ?? []).filter(b => b.type === 'tool_use'));
const results = run => new Map(run.events.filter(e => e.type === 'user').flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : [])).filter(b => b.type === 'tool_result').map(b => [b.tool_use_id, b]));
const body = result => (typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? ''));
const exploreCalls = run => { const by = results(run); return uses(run).filter(u => u.name.endsWith('pandacode_explore')).map(u => ({ input: u.input, result: by.get(u.id) })); };

/** Each model request in order, with the tool calls it made and their results. */
export function stepsOf(events) {
  const by = new Map();
  const steps = [];
  for (const event of events) {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      const id = event.message.id;
      if (!steps.length || steps.at(-1).id !== id) steps.push({ id, uses: [] });
      for (const block of content.filter(b => b.type === 'tool_use')) { const use = { name: block.name, input: block.input ?? {}, result: null }; by.set(block.id, use); steps.at(-1).uses.push(use); }
    }
    for (const block of event.type === 'user' ? content : []) if (block.type === 'tool_result' && by.has(block.tool_use_id)) by.get(block.tool_use_id).result = block;
  }
  return steps;
}
export const kindOf = use => (use.name.endsWith('pandacode_explore') ? 'explore' : use.name);
const replyText = result => (typeof result?.content === 'string' ? result.content : (result?.content ?? []).map(part => part.text ?? '').join(''));

/** Where one run's steps went: see the `steps` command. */
export function stepCauses(steps, gold, answerFiles) {
  const out = { steps: steps.length, kinds: {}, afterAnswerHeld: 0, afterExploreHeld: 0, rejected: [], truncated: 0, omitted: 0, reAsks: 0, readsShown: 0, readsShownBody: 0, readsSpan: 0, reads: 0 };
  const needed = gold.filter(path => answerFiles.includes(path));
  let shown = '';
  let explored = '';
  const asked = new Set();
  let heldAt = -1;
  let exploreHeldAt = -1;
  steps.forEach((step, i) => {
    const kinds = step.uses.length ? [...new Set(step.uses.map(kindOf))].join('+') : 'answer';
    out.kinds[kinds] = (out.kinds[kinds] ?? 0) + 1;
    for (const use of step.uses) {
      const text = replyText(use.result);
      if (kindOf(use) === 'Read') {
        out.reads++;
        const path = normalize(use.input.file_path ?? '');
        if (mentions(explored, path)) out.readsShown++;
        // A body the reply already printed: a `read` item for the path, or numbered lines from it.
        if (explored.includes(`"path":"${path}"`)) out.readsShownBody++;
        // A Read starting at a span the reply printed as `@ name A-B` or `A-B name`.
        if (use.input.offset && new RegExp(`(@ \\S+ |\\n|\\\\n)${use.input.offset}-\\d`).test(explored)) out.readsSpan++;
      }
      if (kindOf(use) === 'explore') {
        if (use.result?.is_error) out.rejected.push(text.slice(0, 90));
        if (text.includes('"truncated":true')) out.truncated++;
        if (/"omitted_(files|lines)"/.test(text)) out.omitted++;
        for (const pattern of [].concat(use.input.search ?? [], use.input.symbols ?? [])) { if (asked.has(pattern)) out.reAsks++; asked.add(pattern); }
        explored += `\n${text}`;
      }
      shown += `\n${text}`;
    }
    if (heldAt < 0 && needed.length && needed.every(path => mentions(shown, path))) heldAt = i;
    if (exploreHeldAt < 0 && needed.length && needed.every(path => mentions(explored, path))) exploreHeldAt = i;
  });
  // Steps after the one whose results first named every gold file the answer gives, not counting the answer.
  if (heldAt >= 0) out.afterAnswerHeld = steps.length - 1 - heldAt - 1;
  if (exploreHeldAt >= 0) out.afterExploreHeld = steps.length - 1 - exploreHeldAt - 1;
  return out;
}

const COMMANDS = {
  /** Where each AFTER step went, per run and summed: kinds, steps after the replies held the answer's gold, rejections, re-asks, reads of files a reply showed. */
  steps() {
    const sum = { runs: 0, steps: 0, kinds: {}, afterAnswerHeld: 0, afterExploreHeld: 0, rejected: [], truncated: 0, omitted: 0, reAsks: 0, reads: 0, readsShown: 0, readsShownBody: 0, readsSpan: 0 };
    for (const run of runs) {
      if (!run.record.gold) continue;
      const files = run.record.grade?.files ?? [];
      const row = stepCauses(stepsOf(run.events), run.record.gold, files);
      sum.runs++;
      for (const [key, value] of Object.entries(row)) {
        if (key === 'kinds') for (const [kind, n] of Object.entries(value)) sum.kinds[kind] = (sum.kinds[kind] ?? 0) + n;
        else if (Array.isArray(value)) sum[key].push(...value);
        else sum[key] += value;
      }
      if (args.verbose) console.log(run.name, JSON.stringify({ ...row, kinds: undefined }), Object.entries(row.kinds).map(([k, n]) => `${k}:${n}`).join(' '));
    }
    console.log(JSON.stringify(sum, null, 1));
  },
  /** Answer files outside gold, per run, and whether an explore reply (or any tool) showed them first. */
  extras() {
    const sum = {};
    for (const run of runs) {
      if (!run.record.gold) continue;
      const steps = stepsOf(run.events);
      const explored = steps.flatMap(s => s.uses).filter(u => kindOf(u) === 'explore').map(u => replyText(u.result)).join('\n');
      const other = steps.flatMap(s => s.uses).filter(u => kindOf(u) !== 'explore').map(u => replyText(u.result) + JSON.stringify(u.input)).join('\n');
      const extra = (run.record.grade?.files ?? []).filter(path => !run.record.gold.includes(path));
      const arm = run.name.split('__').at(-1);
      const key = `${run.record.task} ${arm}`;
      sum[key] ??= { runs: 0, files: 0, extras: 0, viaExplore: 0, viaOther: 0, precision: 0, list: [] };
      const row = sum[key];
      row.runs++; row.files += run.record.grade?.files?.length ?? 0; row.extras += extra.length; row.precision += run.record.grade?.precision ?? 0;
      row.viaExplore += extra.filter(path => mentions(explored, path)).length;
      row.viaOther += extra.filter(path => !mentions(explored, path) && mentions(other, path)).length;
      row.list.push(...extra);
    }
    for (const [key, row] of Object.entries(sum).sort()) console.log(key.padEnd(34), JSON.stringify({ ...row, precision: +(row.precision / row.runs).toFixed(3), list: [...new Set(row.list)] }));
  },
  /** Explore errors, with the argument shape that caused each. */
  errors() {
    const count = {};
    for (const run of runs) {
      for (const { input, result } of exploreCalls(run)) {
        if (!result?.is_error) continue;
        const text = body(result).slice(0, 80);
        count[text] = (count[text] ?? 0) + 1;
        console.log(run.name, JSON.stringify(input).slice(0, 160), '→', text);
      }
    }
    console.log(count);
  },
  /** The largest explore results and what asked for them. */
  sizes() {
    const all = runs.flatMap(run => exploreCalls(run).map(({ input, result }) => [body(result).length, run.record.task, JSON.stringify(input).slice(0, 150)]));
    for (const row of all.sort((a, b) => b[0] - a[0]).slice(0, 10)) console.log(row.join('  '));
  },
  /** Which gold files any tool showed, per run. */
  seen() {
    for (const run of runs) {
      if (!run.record.gold) continue;
      const text = uses(run).map(u => JSON.stringify(u.input)).join('\n') + [...results(run).values()].map(body).join('\n');
      console.log(run.name, Object.fromEntries(run.record.gold.map(path => [path, text.includes(path) || text.includes(path.split('/').slice(-2).join('/'))])));
    }
  },
  /** Native edits, and whether anything was read with the Read tool first. */
  edits() {
    let edits = 0;
    let refused = 0;
    let withoutRead = 0;
    for (const run of runs) {
      const by = results(run);
      const read = new Set();
      for (const use of uses(run)) {
        if (use.name === 'Read') read.add(use.input.file_path);
        if (!['Edit', 'Write', 'MultiEdit'].includes(use.name)) continue;
        edits++;
        if (/has not been read/.test(body(by.get(use.id)))) refused++;
        else if (!read.has(use.input.file_path)) withoutRead++;
      }
    }
    console.log({ runs: runs.length, edits, refused, withoutRead });
  },
  /** Searches empty inside their glob that listed hits outside it, and whether the agent then used one. */
  outside() {
    let empty = 0;
    let listed = 0;
    let used = 0;
    for (const run of runs) {
      const later = [];
      const calls = exploreCalls(run);
      const answer = String(run.record.answer ?? '');
      calls.forEach(({ input }) => later.push(JSON.stringify(input)));
      calls.forEach(({ result }, i) => {
        const text = body(result).replaceAll('\\"', '"');
        for (const match of text.matchAll(/"outside_glob":\{"files":(\d+),"first":\[([^\]]*)\]/g)) {
          listed++;
          const paths = [...match[2].matchAll(/"([^"]+)"/g)].map(m => m[1]);
          const rest = later.slice(i + 1).join('\n') + answer + uses(run).filter(u => !u.name.endsWith('pandacode_explore')).map(u => JSON.stringify(u.input)).join('\n');
          if (paths.some(path => rest.includes(path))) used++;
        }
        if (/"matches":0\b/.test(text)) empty++;
      });
    }
    console.log({ runs: runs.length, emptySearchesInResults: empty, outsideGlobListings: listed, followedUp: used });
  },
  /** Searches that returned nothing, and whether a glob was what narrowed them. */
  empty() {
    let searches = 0;
    let empty = 0;
    let globbed = 0;
    for (const run of runs) {
      for (const { input, result } of exploreCalls(run)) {
        if (!input.search) continue;
        searches++;
        if (!/"?matches\\?"?:\s*0\b/.test(body(result))) continue;
        empty++;
        if (input.glob) globbed++;
        console.log(run.record.task, JSON.stringify(input).slice(0, 140));
      }
    }
    console.log({ searches, empty, globbed });
  },
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const parsed = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2/runs/D') }, task: { type: 'string' }, model: { type: 'string', default: 'sonnet' },
  arm: { type: 'string' }, verbose: { type: 'boolean' },
} });
args = parsed.values;
runs = args.runs.split(',').flatMap(dir => readdirSync(dir).flatMap(name => {
  const stream = join(dir, name, 'stream.jsonl');
  if (!existsSync(stream) || !name.includes(`__${args.model}__`) || (args.task && !name.includes(args.task)) || (args.arm && !name.endsWith(`__${args.arm}`))) return [];
  return [{ name, record: JSON.parse(readFileSync(join(dir, name, 'run.json'), 'utf8')), events: parseEvents(readFileSync(stream, 'utf8')) }];
}));
  const command = parsed.positionals[0];
  if (!COMMANDS[command]) throw new Error(`commands: ${Object.keys(COMMANDS).join(', ')}`);
  COMMANDS[command]();
}
