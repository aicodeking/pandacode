// Command guard (sample.guard): the service. One browser-safe ES module besides its analyser: everything that touches
// the machine (files, home folder, time) comes in as `io`, so the Node tests, the preview and the installed service run
// the same file. main.cjs is the installed `io`.
//
// What it does (docs/extensions/examples/guard.md):
//   tool.before  analyse the shell command (or the path of a write/edit); deny with a reason and a rule id, rewrite a plain
//                `git push --force` to `--force-with-lease` where the call allows it, or return nothing. It never approves.
//   tool.after   a shell call that reached the guard only afterwards ("activity") raises one notice and the status says so.
//   status item  `Guard <level>` and the number of denials; the "Guard log" table; "Explain a command"; an audit file.
import { LEVELS, POLICY_PATH, analyze, checkWritePath, higher, readPolicy, redact, rewriteForcePush } from './analyzer.mjs';

export const IDS = {
  status: 'sample.guard/level', view: 'sample.guard/log', explain: 'sample.guard/explain', page: 'sample.guard/policy',
  before: 'sample.guard/before', after: 'sample.guard/after',
};
const LOG_ROWS = 50;
const COLUMNS = ['Time', 'Verdict', 'Rule', 'Command'];
const SHOWN = 120;
const NOTE_MAX = 400;

const shorten = (text, max = SHOWN) => { const one = String(text).replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
const COVERAGE_WORDS = { everyCall: 'every call', askedCalls: 'only the calls the harness asks about', escalationsOnly: 'only sandbox escalations' };

export async function run(panda, lifetime, io) {
  const state = {
    level: 'standard', userRules: [], denials: 0, rewrites: 0, calls: 0, degraded: false, unchecked: new Set(),
    notEnforced: null, log: [], received: [], refused: [], dataDir: null,
  };
  const disposers = [];
  let stopped = false;
  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error).slice(0, 40)); if (state.refused.length > 3) state.refused.shift(); return null; };
  const guard = work => (...args) => { void Promise.resolve().then(() => work(...args)).catch(refuse); };
  const dispose = handle => { if (typeof handle === 'function') handle(); else handle?.dispose?.(); };

  // ---- policy: the settings page, the user's file and the project's file, read on every call -----------------------

  const dir = async () => { state.dataDir ??= await io.dataDir().catch(() => null); return state.dataDir; };
  // The custom rules of the settings page are the `rules` array of a policy file, as text; invalid text is "degraded".
  const settingsRules = text => {
    let rules;
    try { rules = JSON.parse(text.trim() || '[]'); } catch { return { ok: false, rules: [] }; }
    return Array.isArray(rules) ? readPolicy(JSON.stringify({ rules })) : { ok: false, rules: [] };
  };
  const readSettings = async () => {
    const page = await panda.settings.get({ page: IDS.page }).catch(refuse);
    if (!page) return;
    const values = page.values ?? {};
    state.level = LEVELS.includes(String(values.level).trim()) ? String(values.level).trim() : 'standard';
    const parsed = settingsRules(String(values.rules ?? '[]'));
    state.settingsOk = parsed.ok;
    state.userRules = parsed.ok ? parsed.rules : [];
  };
  /** Level, rules and health for one call: settings, then the user's policy file, then the project's, which can raise the level but never lower it. */
  const policyFor = async root => {
    let level = state.level, rules = [...state.userRules], ok = state.settingsOk !== false;
    const folder = await dir();
    const files = [folder ? `${folder}/policy.json` : null, root ? `${root}/${POLICY_PATH}` : null].filter(Boolean);
    for (const file of files) {
      const text = await io.readText(file).catch(() => null);
      const policy = readPolicy(text);
      if (!policy.ok) { ok = false; continue; }
      if (policy.level) level = higher(level, policy.level);
      rules = rules.concat(policy.rules);
    }
    state.degraded = !ok;
    return { level, rules };
  };

  // ---- what the user sees --------------------------------------------------------------------------------------------

  let last = '';
  const render = async () => {
    const level = state.level;
    const text = state.notEnforced ? state.notEnforced : `Guard ${level}${state.denials ? ` · ${state.denials} denied` : ''}`;
    const tone = state.notEnforced || state.degraded ? 'warning' : 'neutral';
    const tooltip = state.degraded
      ? 'degraded: a policy file or custom rule is not valid, so the defaults apply.'
      : `Level ${level}. ${state.denials} denied, ${state.rewrites} rewritten in this run of the application.`;
    const status = { text: state.degraded && !state.notEnforced ? `Guard ${level} · degraded` : text, tone, tooltip };
    const view = {
      text: `${state.denials} denied, ${state.rewrites} rewritten since the application started. Newest first, at most ${LOG_ROWS}.`,
      controls: [{ kind: 'table', label: 'Decisions', columns: COLUMNS, rows: state.log.slice(0, LOG_ROWS) }],
    };
    const signature = JSON.stringify([status, view]);
    if (signature === last) return;
    last = signature;
    await Promise.resolve(panda.ui.update(IDS.status, status)).catch(refuse);
    await Promise.resolve(panda.ui.updateView(IDS.view, view)).catch(refuse);
    report();
  };
  const report = () => {
    const body = { level: state.level, denials: state.denials, rewrites: state.rewrites, calls: state.calls, degraded: state.degraded, notEnforced: state.notEnforced, refused: state.refused };
    void Promise.resolve(lifetime.setStatus({ text: JSON.stringify(body).slice(0, 200) })).catch(() => undefined);
  };

  const record = async (verdict, rule, command, extra = {}) => {
    const clean = redact(shorten(command, 400));
    state.log.unshift([io.now().toISOString().slice(11, 19), verdict, rule ?? '-', shorten(clean)]);
    if (state.log.length > LOG_ROWS) state.log.length = LOG_ROWS;
    const folder = await dir();
    if (folder) await io.appendLine(`${folder}/audit.jsonl`, JSON.stringify({ at: io.now().toISOString(), verdict, rule, command: clean, ...extra })).catch(refuse);
    await render();
  };

  // ---- the decision --------------------------------------------------------------------------------------------------

  const dialectOf = call => call.dialect ?? (/^[A-Za-z]:[\\/]/.test(String(call.cwd ?? call.projectRoot ?? '')) ? 'powershell' : 'posix');
  const contextOf = async call => {
    const root = String(call.projectRoot ?? call.cwd ?? '');
    const policy = await policyFor(root);
    return { cwd: String(call.cwd ?? root), root, home: io.home, temp: io.temp, level: policy.level, rules: policy.rules, escapes: dialectOf(call) === 'posix' };
  };
  const commandOf = input => {
    if (typeof input?.command === 'string') return input.command;
    if (Array.isArray(input?.command) && input.command.every(part => typeof part === 'string')) return input.command.join(' ');
    return typeof input?.cmd === 'string' ? input.cmd : null;
  };
  const refusal = (rule, reason, command) => ({ decision: 'deny', reason: `Denied by Command guard [${rule}]: ${reason} Command: ${shorten(redact(command ?? ''), 160)}`.slice(0, 1000) });

  /** The `tool.before` handler. Nothing returned means no decision: the normal prompt, or the harness's own flow. */
  const before = async call => {
    state.calls += 1;
    const kind = call.tool?.kind;
    if (kind !== 'shell' && kind !== 'write' && kind !== 'edit') return null;
    const context = await contextOf(call);
    if (kind !== 'shell') {
      const path = call.input?.file_path ?? call.input?.path ?? call.input?.filePath;
      const hit = checkWritePath(path, context);
      if (!hit) return null;
      state.denials += 1;
      await record('deny', hit.rule, `${kind} ${path}`);
      return refusal(hit.rule, hit.reason, `${kind} ${path}`);
    }
    // A command too large to carry whole is never judged by its preview: padding would hide the end of it.
    if (call.inputComplete === false) {
      state.denials += 1;
      await record('deny', 'analysis.input-incomplete', '(input larger than the hook can carry)');
      return refusal('analysis.input-incomplete', 'The command is too large to analyse whole.', '(large input)');
    }
    const command = commandOf(call.input);
    // Test commands: a handler that sleeps past its budget and one that throws (never shipped as a rule, only when the host hands them in).
    if (io.testCommands && typeof command === 'string' && command.startsWith('guard-test ')) {
      if (command.startsWith('guard-test sleep')) await new Promise(resolve => setTimeout(resolve, Number(command.split(' ')[2]) * 1000 || 1000));
      if (command.startsWith('guard-test throw')) throw new Error('InvalidShape');
      return null;
    }
    const result = analyze(command, context);
    if (result.verdict === 'allow') { await record('pass', null, command); return null; }
    if (result.rewritable && Array.isArray(call.can) && call.can.includes('rewriteInput')) {
      const next = rewriteForcePush(command);
      if (next) {
        state.rewrites += 1;
        await record('rewrite', result.rule, `${command} -> ${next}`, { original: redact(command), rewritten: redact(next) });
        return {
          decision: 'rewrite',
          input: { ...call.input, command: next },
          reason: `Command guard: ${result.reason}`,
          note: shorten(`Command guard rewrote the arguments: original "${redact(command)}" became "${redact(next)}".`, NOTE_MAX),
        };
      }
    }
    state.denials += 1;
    await record('deny', result.rule, command, { steps: result.steps.length });
    return refusal(result.rule, result.reason, command);
  };

  // ---- coverage: what the guard can actually see -------------------------------------------------------------------

  const coverageOf = async (harness, mode) => {
    try {
      const report = await panda.harnesses.list({ harness });
      const cell = report?.harnesses?.[0]?.hooks?.toolBefore?.[mode];
      return cell ? { coverage: cell.coverage, source: cell.source ?? null, can: cell.can ?? [] } : null;
    } catch (error) { refuse(error); return null; }
  };

  /** The `tool.after` handler: a shell call that was never seen before it ran is reported once per harness and mode. */
  const after = async call => {
    if (call.tool?.kind !== 'shell' || call.source !== 'activity') return;
    const harness = String(call.harness ?? 'harness'), mode = String(call.mode ?? 'default');
    const command = commandOf(call.input) ?? '';
    const context = await contextOf(call);
    const result = command ? analyze(command, context) : null;
    await record('ran-unchecked', result?.rule ?? null, command || '(command not available)');
    const key = `${harness}:${mode}`;
    if (state.unchecked.has(key)) return;
    state.unchecked.add(key);
    const found = await coverageOf(harness, mode);
    state.notEnforced = `not enforced for ${harness} in ${mode} mode`;
    state.coverage = found;
    const words = found && COVERAGE_WORDS[found.coverage] ? ` The harness shows the guard ${COVERAGE_WORDS[found.coverage]} in this mode.` : '';
    await Promise.resolve(panda.ui.notify({ key: `unchecked-${key}`, title: 'Command guard', text: `A command ran without a check on ${harness} (${mode} mode).${words}`, tone: 'warning' })).catch(refuse);
    last = '';
    await render();
  };

  // ---- explain -------------------------------------------------------------------------------------------------------

  const explain = async invocation => {
    let command = typeof invocation?.args?.command === 'string' ? invocation.args.command : null;
    if (command === null) {
      const answer = await panda.ui.showDialog({ title: 'Explain a command', fields: [{ id: 'command', label: 'Command line', kind: 'text', required: true }], confirmLabel: 'Explain' }).catch(refuse);
      if (!answer || answer.status !== 'confirmed') return { status: answer?.status ?? 'refused' };
      command = String(answer.values?.command ?? '');
    }
    const context = await contextOf({ projectRoot: invocation?.args?.projectRoot ?? invocation?.projectRoot ?? '/', cwd: invocation?.args?.cwd ?? invocation?.projectRoot ?? '/' });
    const result = analyze(command, context);
    const summary = result.verdict === 'allow' ? 'Allowed: no rule matched.' : `Denied by ${result.rule}: ${result.reason}`;
    await Promise.resolve(panda.ui.showDialog({
      title: 'Guard verdict',
      fields: [{ id: 'verdict', label: 'Verdict', kind: 'text', value: summary }, { id: 'steps', label: 'Steps of the analysis', kind: 'textarea', value: result.steps.join('\n') || '(nothing to analyse)', rows: 6 }],
      confirmLabel: 'Close',
    })).catch(refuse);
    return { status: 'explained', verdict: result.verdict, rule: result.rule, steps: result.steps };
  };

  // ---- wiring --------------------------------------------------------------------------------------------------------

  const command = (id, handler) => { try { disposers.push(panda.commands.register(id, handler)); } catch (error) { refuse(error); } };
  command(IDS.explain, explain);
  const hooks = [];
  try { hooks.push(panda.hooks.on('tool.before', before)); } catch (error) { refuse(error); }
  try { hooks.push(panda.hooks.on('tool.after', guard(after))); } catch (error) { refuse(error); }
  try { disposers.push(panda.events.on('settings.changed', guard(async () => { await readSettings(); last = ''; await render(); }))); } catch (error) { refuse(error); }

  lifetime.onStop(() => {
    stopped = true;
    for (const handle of [...hooks, ...disposers.splice(0).reverse()]) { try { dispose(handle); } catch { /* the host disposes the rest */ } }
  });

  await readSettings();
  await render();
  return { state, before, after, explain, stopped: () => stopped };
}
