// What one run measured, derived only from its stream-json transcript, so old runs can be re-derived.

/** Dollars per million tokens, fitted to observed total_cost_usd (analyze.mjs reports the fit error). */
export const PRICES = {
  sonnet: { input: 3, write: 4, read: 0.1, output: 10 },
  opus: { input: 5, write: 10, read: 0.5, output: 25 },
};
export const LONG_CONTEXT = 150_000;
/** Token saver: the lead's marginal cost of choosing inline, the tokenSaver field it writes, at the lead model's output price. */
export const fieldUsd = (outputTokens, model = 'opus') => (outputTokens ?? 0) * PRICES[model].output / 1e6;
const priced = (tokens, per) => tokens * per / 1e6;

export const parseEvents = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

/**
 * A process can report more than one `result`: a background task's notification starts another
 * segment. Tokens, duration_ms and turns are per segment, so they add up; total_cost_usd and
 * duration_api_ms are cumulative over the process, so they are differenced.
 * `skip` drops leading segments that are not the measured work (the long-context warm turn).
 */
export function resultTotals(events, skip = 0) {
  const results = events.filter(e => e.type === 'result');
  const counted = results.slice(skip);
  const sum = get => counted.reduce((total, r) => total + (get(r) ?? 0), 0);
  const last = counted.at(-1);
  const prior = skip > 0 ? results[skip - 1] : null;
  const baseline = prior?.total_cost_usd ?? 0;
  return {
    segments: counted.length,
    subtype: last?.subtype ?? 'no-result',
    isError: !last || counted.some(r => r.is_error),
    durationMs: counted.length ? sum(r => r.duration_ms) : null,
    apiMs: last?.duration_api_ms == null ? null : last.duration_api_ms - (prior?.duration_api_ms ?? 0),
    turns: counted.length ? sum(r => r.num_turns) : null,
    costUsd: last?.total_cost_usd == null ? null : last.total_cost_usd - baseline,
    tokens: {
      input: sum(r => r.usage?.input_tokens),
      cacheRead: sum(r => r.usage?.cache_read_input_tokens),
      cacheWrite: sum(r => r.usage?.cache_creation_input_tokens),
      output: sum(r => r.usage?.output_tokens),
    },
    answer: typeof last?.result === 'string' ? last.result : '',
  };
}

/** The `tools` counter a non-explore tool call adds to. */
function toolKind(name, input) {
  if (['Read', 'Grep', 'Glob', 'ToolSearch'].includes(name)) return name;
  if (name === 'Bash') return BASH_SEARCH.test(String(input.command ?? '')) ? 'BashSearch' : 'BashOther';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'Edit';
  return ['Agent', 'Task'].includes(name) ? 'Agent' : 'other';
}

/**
 * A user event's tool results: their text joins the step that called them; explore replies are measured.
 * A refused explore call (an error result: a refused root or path, bad arguments, a harness timeout)
 * shows nothing, so neither its arguments nor its reply count toward recall credit.
 */
function toolResults(event, toolStep, stepText, exploreIds, explore, exploreInput) {
  for (const block of event.message?.content ?? []) {
    if (block.type !== 'tool_result') continue;
    const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    const owner = toolStep.get(block.tool_use_id);
    const refused = exploreIds.has(block.tool_use_id) && block.is_error;
    if (owner && !refused) stepText.get(owner).push(...(exploreInput.has(block.tool_use_id) ? [exploreInput.get(block.tool_use_id)] : []), body);
    if (!exploreIds.has(block.tool_use_id)) continue;
    explore.resultChars.push(body.length);
    if (block.is_error) explore.errors.push(body.slice(0, 80));
    if (/truncated\\?"?:\s*true|\\?"omitted/.test(body)) explore.truncated++;
    if (/matches\\?"?:\s*0\b/.test(body)) explore.emptySearch++;
  }
}

const BASH_SEARCH = /\b(rg|grep|ag|find|ls|cat|head|tail|sed|awk|tree|git (grep|log|ls-files))\b/;
const EXPLORE_KINDS = ['search', 'symbols', 'outline', 'read', 'tests_for'];

/** Metrics from the stream-json events. `skip` is the number of leading result segments to leave out. */
export function metrics(text, { skip = 0 } = {}) {
  const events = parseEvents(text);
  let from = 0;
  for (let seen = 0, i = 0; i < events.length && seen < skip; i++) {
    if (events[i].type === 'result') { seen++; from = i + 1; }
  }
  const init = events.find(e => e.type === 'system' && e.subtype === 'init') ?? {};
  const tools = { explore: 0, Read: 0, Grep: 0, Glob: 0, BashSearch: 0, BashOther: 0, Edit: 0, Agent: 0, ToolSearch: 0, other: 0 };
  const steps = new Map();     // message id → usage: one model request, however many tool calls it made
  const stepText = new Map();  // message id → the tool input and output that followed it
  const toolStep = new Map();
  const explore = { args: [], resultChars: [], errors: [], truncated: 0, singleKind: 0, emptySearch: 0 };
  const exploreIds = new Set();
  const exploreInput = new Map();  // explore call id → its arguments, shown only once its result is not an error
  let lastText = '';
  let firstToolIsExplore = null;
  let parallelCalls = 0;
  for (const event of events.slice(from)) {
    if (event.type === 'assistant') {
      const id = event.message?.id;
      const main = !event.parent_tool_use_id;
      if (main && id) {
        steps.set(id, event.message.usage ?? steps.get(id) ?? {});
        if (!stepText.has(id)) stepText.set(id, []);
      }
      let calls = 0;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && main) lastText = block.text;
        if (block.type !== 'tool_use') continue;
        calls++;
        const input = block.input ?? {};
        const name = block.name;
        const isExplore = name.endsWith('pandacode_explore');
        if (main && id) { toolStep.set(block.id, id); if (isExplore) exploreInput.set(block.id, JSON.stringify(input)); else stepText.get(id).push(JSON.stringify(input)); }
        if (isExplore) {
          tools.explore++;
          exploreIds.add(block.id);
          explore.args.push(input);
          if (EXPLORE_KINDS.filter(kind => input[kind] !== undefined).length === 1) explore.singleKind++;
          firstToolIsExplore ??= true;
          continue;
        }
        firstToolIsExplore ??= false;
        tools[toolKind(name, input)]++;
      }
      if (calls > 1) parallelCalls += calls - 1;
    }
    if (event.type === 'user') toolResults(event, toolStep, stepText, exploreIds, explore, exploreInput);
  }
  const totals = resultTotals(events, skip);
  const stepUsage = [...steps.values()];
  const count = steps.size;
  return {
    ...totals,
    steps: count,
    apiMsPerStep: count && totals.apiMs != null ? totals.apiMs / count : null,
    nonApiMs: totals.durationMs != null && totals.apiMs != null ? totals.durationMs - totals.apiMs : null,
    firstStep: { cacheRead: stepUsage[0]?.cache_read_input_tokens ?? 0, cacheWrite: stepUsage[0]?.cache_creation_input_tokens ?? 0 },
    laterWrites: stepUsage.slice(1).map(u => u.cache_creation_input_tokens ?? 0),
    stepUsage: stepUsage.map(u => ({ read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, input: u.input_tokens ?? 0 })),
    stepText: [...stepText.values()].map(parts => parts.join('\n')),
    tools, parallelCalls, exploreAdopted: tools.explore > 0, firstToolIsExplore, explore,
    answer: totals.answer || lastText,
    init: { model: init.model, version: init.claude_code_version, tools: init.tools, mcp: init.mcp_servers, plugins: init.plugins?.map(p => p.source ?? p.name), skills: init.skills, slash: init.slash_commands?.length, agents: init.agents },
    hookEvents: events.filter(e => e.type === 'system' && /hook/.test(e.subtype ?? '')).map(e => e.hook_name ?? e.subtype),
  };
}

export const priceOf = model => PRICES[model] ?? PRICES.sonnet;
/** Cost without the run's opening cache write, which is the same in every arm and hides the rest. */
export const costBeyondFirstWrite = (m, model) => (m.costUsd == null ? null : m.costUsd - priced(m.firstStep.cacheWrite, priceOf(model).write));
/**
 * What the run would cost deep in a thread: 150k tokens already cached and warm, so the opening write
 * becomes a read and every step re-reads the context. This is arithmetic on measured steps, not a run.
 */
export function costAtLongContext(m, model) {
  const p = priceOf(model);
  const reads = m.tokens.cacheRead + m.firstStep.cacheWrite + m.steps * LONG_CONTEXT;
  return priced(reads, p.read) + priced(m.tokens.cacheWrite - m.firstStep.cacheWrite, p.write) + priced(m.tokens.input, p.input) + priced(m.tokens.output, p.output);
}

/** A path counts as mentioned by its full form or, since tools print paths relative to a `cd`, its tail. */
export function mentions(text, path) {
  if (text.includes(path)) return true;
  const parts = path.split('/');
  return parts.length > 2 && text.includes(parts.slice(-2).join('/'));
}

/** Tokens priced per step up to and including the step whose tools first showed every gold file. */
export function costToFullRecall(m, gold, model) {
  const p = priceOf(model);
  const remaining = new Set(gold);
  let cost = 0;
  for (let i = 0; i < m.stepUsage.length; i++) {
    const u = m.stepUsage[i];
    cost += priced(u.read, p.read) + priced(u.write, p.write) + priced(u.input, p.input);
    for (const path of [...remaining]) if (mentions(m.stepText[i] ?? '', path)) remaining.delete(path);
    if (!remaining.size) return { reached: true, steps: i + 1, costUsd: cost };
  }
  return { reached: false, steps: null, costUsd: null };
}

/**
 * The last ```json block (or bare {"files":…}) in the answer. Only blocks opened as ```json count:
 * a bare-fence pattern pairs an earlier block's closing fence with the next opening one.
 */
export function parseAnswer(text) {
  const value = String(text);
  const fenced = [...value.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).reverse();
  const start = value.lastIndexOf('{"files"');
  const bare = start >= 0 ? [value.slice(start, value.lastIndexOf('}') + 1)] : [];
  for (const candidate of [...fenced, ...bare]) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value.files)) return value;
    } catch { /* next candidate */ }
  }
  return null;
}
export const normalize = path => String(path).trim().replace(/^.*\/repo\//, '').replace(/^\.\//, '').replace(/:\d.*$/, '').replace(/#.*$/, '');

/**
 * Answer files against gold. `credit` also gives half a point for a gold file that any tool call or
 * tool result mentioned without the answer listing it, measured the same way in every arm.
 */
export function gradeLocalization(metric, gold) {
  const answer = parseAnswer(metric.answer);
  const files = [...new Set((answer?.files ?? []).map(normalize))];
  const hits = gold.filter(file => files.includes(file));
  const shown = (metric.stepText ?? []).join('\n');
  const seenOnly = gold.filter(file => !files.includes(file) && mentions(shown, file));
  return {
    answered: Boolean(answer), files, functions: answer?.functions ?? [],
    recall: hits.length / gold.length,
    precision: files.length ? hits.length / files.length : 0,
    credit: (hits.length + seenOnly.length / 2) / gold.length,
    seenOnly,
  };
}

/**
 * A review's findings, one text each, so a rubric item can't borrow words from another finding: the
 * items of a fenced json `findings` array (file, line, issue), plus each top-level numbered or bulleted
 * item or heading in the prose, with its indented or wrapped continuation, up to a blank line.
 */
export function splitFindings(answer) {
  const text = String(answer ?? '');
  const units = [];
  for (const m of text.matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)) {
    try {
      const value = JSON.parse(m[1]);
      if (Array.isArray(value?.findings)) units.push(...value.findings.map(f => (typeof f === 'string' ? f : [f?.file, f?.line, f?.issue].filter(x => x != null).join(' '))));
    } catch { /* not json */ }
  }
  let current = null;
  const close = () => { if (current) units.push(current); current = null; };
  for (const line of text.replace(/```[\s\S]*?```/g, '').split('\n')) {
    if (/^ ?(\d+[.)]|[-*•]|#{1,6})\s/.test(line)) { close(); current = line; } else if (!line.trim()) close(); else if (current !== null) current += ` ${line.trim()}`;
  }
  close();
  return units;
}

/** The string entries of `key` in the last fenced json block that has it as an array. */
export function jsonField(answer, key) {
  const blocks = [...String(answer ?? '').matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).reverse();
  for (const block of blocks) {
    try { const value = JSON.parse(block); if (Array.isArray(value?.[key])) return value[key].map(String); } catch { /* next */ }
  }
  return [];
}

/**
 * A report against its rubric: an item counts when one unit of the answer matches all of its
 * case-insensitive regexes (`line`) and none of its `not` regexes (the post-hoc strict rubrics use
 * `not` to refuse negations and wrong values). Units are lines, or for a review its findings (lines
 * if it has none). Deterministic and fixed before any run (token saver benchmark).
 */
export function scoreRubric(answer, rubric, kind = null) {
  const findings = kind === 'review' ? splitFindings(answer) : [];
  const lines = findings.length ? findings : String(answer ?? '').split('\n');
  const hit = rubric.filter(item => {
    const patterns = item.line.map(source => new RegExp(source, 'i'));
    const refused = (item.not ?? []).map(source => new RegExp(source, 'i'));
    // `field` (post-hoc strict rubrics): the units are the entries of that array in the answer's JSON block.
    const units = item.field ? jsonField(answer, item.field) : lines;
    return units.some(unit => patterns.every(pattern => pattern.test(unit)) && !refused.some(pattern => pattern.test(unit)));
  }).map(item => item.id);
  return { hits: hit, missed: rubric.map(item => item.id).filter(id => !hit.includes(id)), recall: rubric.length ? hit.length / rubric.length : 0 };
}
