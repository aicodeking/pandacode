import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, failedVerb, summarizeTools, toolFailed, toolPreview, traceRowHtml } from '../src/tool-trace.ts';
import { shellRunningVerb } from '../src/tool-trace-intent.ts';
import { describeShell } from '../src/shell-intent.ts';
import { renderToolActivity } from '../src/tool-activity.ts';
import { placeTip, tipLinesHtml } from '../src/tool-trace-row.ts';

// Shapes copied from real recorded tool calls (paths shortened).
const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input, null, 2), output: '', ...extra });
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const codexCommand = (command, output, status = 'failed') => tool('Command', `/bin/zsh -lc '${command}'\nWorking directory: /repo`, { status, output });
const PLAYWRIGHT_FAILED = 'Exit code: 1\nWall time: 41.2 seconds\nOutput:\nRunning 14 tests using 4 workers\n\n  1) tests/a.spec.ts:3:1 › opens › the dialog\n\n  1 failed\n    tests/a.spec.ts:3:1 › opens › the dialog\n  13 passed (40.1s)\n';

// --- 1. Failed checks say what failed, not that they never ran ---------------------------------

test('a failed test run with a summary reads `Tests failed [runner] · 1 of 14 tests`', () => {
  const trace = describeTool(codexCommand('npx playwright test', PLAYWRIGHT_FAILED));
  assert.equal(trace.verb, 'Tests failed');
  assert.equal(trace.chip?.label, 'playwright');
  assert.equal(trace.object, '· 1 of 14 tests');
  assert.equal(plain(traceRowHtml(trace)), 'Tests failed playwright · 1 of 14 tests');
});

test('a test run that exits nonzero without a summary reads `Tests failed [runner]`', () => {
  const trace = describeTool(codexCommand('npm test', 'Exit code: 1\nWall time: 3 seconds\nOutput:\nError: something broke in setup\n    at main (a.js:1:1)\n'));
  assert.equal(trace.verb, 'Tests failed');
  assert.equal(trace.object, '');
  // A completed record whose exit code is nonzero says the same; the verb already says it failed, so no exit badge.
  const completed = describeTool(codexCommand('npm test', 'Exit code: 1\nWall time: 3 seconds\nOutput:\nError: boom\n', 'completed'));
  assert.equal(completed.verb, 'Tests failed');
  assert.equal(completed.exit, undefined);
});

test('a runner that never started still reads `Couldn\'t run tests`', () => {
  assert.equal(describeTool(codexCommand('npx playwright test', 'Exit code: 127\nWall time: 0 seconds\nOutput:\nzsh:1: command not found: npx\n')).verb, "Couldn't run tests");
  assert.equal(describeTool(codexCommand('npx playwright test', 'Exit code: 1\nWall time: 0 seconds\nOutput:\n')).verb, "Couldn't run tests");
  assert.equal(describeTool(tool('Bash', { command: 'npx playwright test' }, { status: 'failed', output: '' })).verb, "Couldn't run tests");
});

test('typecheck, lint and build failures with output say so', () => {
  const output = 'Exit code: 2\nWall time: 4 seconds\nOutput:\nsrc/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n';
  assert.equal(describeTool(codexCommand('npx tsc --noEmit', output)).verb, 'Typecheck failed');
  assert.equal(describeTool(codexCommand('npx eslint src', output)).verb, 'Lint found problems');
  assert.equal(describeTool(codexCommand('npm run build', output)).verb, 'Build failed');
  assert.equal(describeTool(codexCommand('cargo build', output)).verb, 'Build failed');
  // A plain failed command keeps `Couldn't …`.
  assert.equal(describeTool(codexCommand('git push', 'Exit code: 1\nOutput:\nrejected\n')).verb, "Couldn't push");
});

// --- 2. Summaries ------------------------------------------------------------------------------

test('summaries merge entries that read the same and keep test runs apart from other commands', () => {
  const mcpTool = tool('mcp__acme__do_thing', {});
  const plainTool = tool('SomethingElse', {});
  const ls = tool('Bash', { command: 'ls src' });
  assert.equal(summarizeTools([mcpTool, plainTool, ls]), 'Used 2 tools and ran 1 command');
  const tests = tool('Bash', { command: 'npm test' });
  const make = tool('Bash', { command: 'git status' });
  assert.equal(summarizeTools([make, tests]), 'Ran tests and 1 other command');
  assert.equal(summarizeTools([tests, tests]), 'Ran tests twice');
});

// --- 3. Free text after a separator ------------------------------------------------------------

test('free-text objects render after a separator as a muted quote', () => {
  const checkpoint = describeTool(tool('mcp__pandacode_architect__pandacode_checkpoint_worker', { key: 'k1', summary: 'Reviewed image rows' }));
  assert.equal(checkpoint.verb, 'Saved checkpoint');
  assert.equal(checkpoint.note, 'Reviewed image rows');
  assert.match(traceRowHtml(checkpoint), /<span class="tool-trace-quote">· “Reviewed image rows”<\/span>/);
  const finish = describeTool(tool('mcp__pandacode_architect__pandacode_finish_team', { summary: 'done' }));
  assert.equal(plain(traceRowHtml(finish)), 'Finished team · “done”');
  const fetched = describeTool(tool('WebFetch', { url: 'https://docs.anthropic.com/en/docs', prompt: 'Summarize the tool use page' }));
  assert.equal(plain(traceRowHtml(fetched)), 'Fetched docs.anthropic.com · “Summarize the tool use page”');
  // Escaped like everything else.
  assert.doesNotMatch(traceRowHtml(describeTool(tool('WebFetch', { url: 'https://a.dev', prompt: '<img src=x>' }))), /<img/);
});

// --- 4. Destructive badge: see `the destructive badge carries an in-app tooltip` below -------------

// --- 5. Mono objects ---------------------------------------------------------------------------

test('prose objects are never mono', () => {
  const html = traceRowHtml({ kind: 'shell', verb: 'Ran', object: 'a sentence', mono: false });
  assert.match(html, /<span class="tool-trace-object">a sentence<\/span>/);
});

// --- 6. Image size once, deltas with both sides -----------------------------------------------

test('an image size shows once and an edit delta labels both sides', () => {
  const devin = tool('Read file', { file_path: '/tmp/d.png' }, { output: 'View image /tmp/d.png (1920x1080)' });
  assert.equal(describeTool(devin).object, '1920 × 1080');
  assert.doesNotMatch(toolPreview(devin), /1920 × 1080/);
  const add = traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 1, removed: 0 });
  assert.match(add, /<span class="tool-trace-delta"><ins>\+1<\/ins> <del>−0<\/del><\/span>/);
  const del = traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 0, removed: 3 });
  assert.match(del, /<span class="tool-trace-delta"><ins>\+0<\/ins> <del>−3<\/del><\/span>/);
  assert.match(traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 2, removed: 3 }), /<ins>\+2<\/ins> <del>−3<\/del>/);
  assert.doesNotMatch(traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 0, removed: 0 }), /tool-trace-delta/);
});

// --- 7. Team messages --------------------------------------------------------------------------

test('team messages name the worker, else say it is a worker, else read `Sent team message`', () => {
  const send = (input, output = '') => describeTool(tool('mcp__pandacode_architect__pandacode_send_team_message', input, { output }));
  const named = send({ recipient: '9b326e2a-1111-4222-8333-944445555666', message: 'hi', workerName: 'Rows' });
  assert.deepEqual([named.verb, named.chip?.label], ['Messaged', 'Rows']);
  const id = send({ recipient: '9b326e2a-1111-4222-8333-944445555666', message: 'hi' });
  assert.deepEqual([id.verb, id.chip?.label, id.chip?.title], ['Messaged worker', '9b326e2a', '9b326e2a-1111-4222-8333-944445555666']);
  const none = send({ key: 'k', message: 'MiniMax run status' });
  assert.deepEqual([none.verb, none.chip], ['Sent team message', undefined]);
  // The answer names the architect it went to.
  const answered = send({ key: 'k', message: 'x' }, '{"duplicate":false,"mailbox":{"messages":[]},"messageId":1,"recipient":"architect","saved":true}');
  assert.deepEqual([answered.verb, answered.chip?.label], ['Messaged', 'architect']);
});

// --- 8. Unmapped titles ------------------------------------------------------------------------

test('Devin skills, Kimi stops and waits, and opencode shell titles map to their rows', () => {
  const skill = describeTool(tool('Invoked skill hyperframes', { skill: 'hyperframes' }));
  assert.deepEqual([skill.verb, skill.chip?.label], ['Loaded skill', 'hyperframes']);
  const stop = describeTool(tool('Stopping task bash-m4s6yce7', { reason: 'Review complete', task_id: 'bash-m4s6yce7' }, { output: 'Wall time: 2042.406 seconds\ntask_id: bash-m4s6yce7\nstatus: killed\nreason: Review complete' }));
  assert.deepEqual([stop.verb, stop.chip?.label], ['Stopped background task', 'bash-m4s6yce7']);
  const wait = describeTool(tool('Waiting up to 90s for task bash-ht6kkd9j', { task_id: 'bash-ht6kkd9j', timeout: 90 }, { output: 'wait_status: completed\ntask_id: bash-ht6kkd9j\nwaited_ms: 0' }));
  assert.equal(plain(traceRowHtml(wait)), 'Waited up to 90s');
  const progress = describeTool(tool('Waiting 1m 29s / 1m 30s · 1 background task still running', { task_id: 'bash-hpziy681', timeout: 90 }));
  assert.equal(plain(traceRowHtml(progress)), 'Waited up to 90s');
  const opencode = describeTool(tool('git status --porcelain=v2 --branch 2>/dev/null | head -50', { command: 'git status --porcelain=v2 --branch 2>/dev/null | head -50', workdir: '/repo' }));
  assert.equal(opencode.kind, 'shell');
  assert.notEqual(opencode.verb, 'Used');
  assert.equal(describeTool(tool('pwd && ls -la', { command: 'pwd && ls -la', cwd: '/repo' })).kind, 'shell');
  // A title that merely starts with a word stays a tool.
  assert.equal(describeTool(tool('make a plan', {})).kind, 'tool');
});

// --- 9. Claude Bash description ----------------------------------------------------------------

test('a Claude Bash description becomes the row tooltip', () => {
  const trace = describeTool(tool('Bash', { command: 'npm test', description: 'Run unit tests' }));
  assert.equal(trace.title, 'Run unit tests');
  assert.match(traceRowHtml(trace), /^<span class="tool-trace-verb" title="Run unit tests">/);
  assert.match(renderToolActivity({ id: 'b', ...tool('Bash', { command: 'npm test', description: 'Run unit tests' }, { output: 'ok' }) }, 'k'), /<summary title="Run unit tests">/);
});

// --- Verbs the shell worker adds ---------------------------------------------------------------

test('new shell verbs have running and failed forms', () => {
  for (const [past, running, failed] of [
    ['Hard-reset', 'Hard-resetting', "Couldn't hard-reset"], ['Stopped', 'Stopping', "Couldn't stop"], ['Showed', 'Showing', "Couldn't show"],
    ['Waited', 'Waiting', "Couldn't wait"], ['Reverted', 'Reverting', "Couldn't revert"], ['Amended', 'Amending', "Couldn't amend"],
    ['Unstaged', 'Unstaging', "Couldn't unstage"], ['Cleared', 'Clearing', "Couldn't clear"], ['Paused', 'Pausing', "Couldn't pause"],
    ['Resumed', 'Resuming', "Couldn't resume"], ['Enabled', 'Enabling', "Couldn't enable"], ['Disabled', 'Disabling', "Couldn't disable"],
    ['Hard-reset to', 'Hard-resetting to', "Couldn't hard-reset to"], ['Rebooted', 'Rebooting', "Couldn't reboot"], ['Unpublished', 'Unpublishing', "Couldn't unpublish"],
    ['Created', 'Creating', "Couldn't create"], ['Linked', 'Linking', "Couldn't link"], ['Stashed', 'Stashing', "Couldn't stash"],
    ['Resolved', 'Resolving', "Couldn't resolve"], ['Tapped', 'Tapping', "Couldn't tap"], ['Pressed', 'Pressing', "Couldn't press"],
    ['Scrolled', 'Scrolling', "Couldn't scroll"], ['Swiped', 'Swiping', "Couldn't swipe"], ['Typed', 'Typing', "Couldn't type"],
    ['Pinged', 'Pinging', "Couldn't ping"], ['Traced', 'Tracing', "Couldn't trace"], ['Unstashed', 'Unstashing', "Couldn't unstash"],
    ['Symlinked', 'Symlinking', "Couldn't symlink"], ['Resolved conflicts in', 'Resolving conflicts in', "Couldn't resolve conflicts in"],
  ]) {
    assert.equal(shellRunningVerb(past), running, past);
    assert.equal(failedVerb(running), failed, past);
  }
});

// --- Codex multi-line commands -----------------------------------------------------------------

test('a Codex heredoc reads from its whole command, not its first line', () => {
  const heredoc = tool('Command', "/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('src/a.ts').read_text())\nPY\"\nWorking directory: /repo", { output: 'Exit code: 0\nOutput:\nconst a = 1;\n' });
  const trace = describeTool(heredoc);
  assert.notEqual(`${trace.verb} ${trace.chip?.label}`, 'Ran script python3');
  assert.doesNotMatch(trace.chip?.title ?? '', /Working directory/);
  assert.match(trace.chip?.title ?? '', /PY$/);
  // A real record (path shortened): Python editing a file in place.
  const edit = tool('Command', "/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\np=Path('src/a.ts')\ns=p.read_text().replace('row.get::<_, u64>(4)?', 'row.get::<_, i64>(4)?',1)\np.write_text(s)\nPY\"\nWorking directory: /repo", { output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\n' });
  const edited = describeTool(edit);
  assert.equal(plain(traceRowHtml(edited)), 'Edited a.ts with Python');
  // The card still shows the command itself, clipped as before.
  assert.match(toolPreview(edit), /python3 - &lt;&lt;&#39;PY&#39;/);
  assert.doesNotMatch(toolPreview(edit), /Working directory/);
});

test('a compound whose output has a test summary leads with its test step', () => {
  const run = codexCommand('cargo build && npx playwright test', 'Exit code: 0\nOutput:\n  14 passed (40.1s)\n', 'completed');
  assert.equal(describeTool(run).verb, 'Ran tests');
});

// --- Blocked calls -----------------------------------------------------------------------------

// A real record (paths shortened): Claude Code refuses a `sleep` chained before other work.
const BLOCKED_OUTPUT = '<tool_use_error>Blocked: sleep 60 followed by: cat /tmp/r19-tsc.txt. To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.</tool_use_error>';
const blockedRead = tool('Bash', { command: 'sleep 60; cat /tmp/r19-tsc.txt', description: 'Read typecheck output' }, { status: 'failed', output: BLOCKED_OUTPUT });

test('a blocked call reads `Blocked: <what was blocked>`, quiet, with the reason in its card', () => {
  const trace = describeTool(blockedRead);
  assert.deepEqual([trace.verb, trace.chip?.label, trace.blocked], ['Blocked:', 'sleep', true]);
  assert.equal(plain(traceRowHtml(trace)), 'Blocked: sleep 60 +1 more command');
  const card = toolPreview(blockedRead);
  assert.match(card, /<p class="tool-trace-note is-blocked">To wait for a condition/);
  assert.doesNotMatch(card, /Blocked:/);
  assert.doesNotMatch(card, /tool_use_error|is-error/);
  const html = renderToolActivity({ id: 'b', ...blockedRead }, 'k');
  assert.match(html, /data-tool-blocked/);
  assert.doesNotMatch(html, /data-tool-failed/);
  // Any other kind reads the same way.
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { status: 'failed', output: '<tool_use_error>Blocked: the file is outside the workspace.</tool_use_error>' });
  assert.equal(describeTool(edit).verb, 'Blocked: edit');
});

test('every failed card drops the `<tool_use_error>` tags', () => {
  const stale = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { status: 'failed', output: '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>' });
  assert.equal(describeTool(stale).verb, "Couldn't edit");
  assert.doesNotMatch(toolPreview(stale), /tool_use_error/);
  const missing = tool('mcp__acme__do_thing', { a: 1 }, { status: 'failed', output: '<tool_use_error>Error: No such tool available: mcp__acme__do_thing</tool_use_error>' });
  assert.doesNotMatch(toolPreview(missing), /tool_use_error/);
  assert.match(toolPreview(missing), /<p class="tool-trace-note is-error">Error: No such tool available: mcp__acme__do_thing<\/p>/);
});

test('summaries count blocked calls apart from failures', () => {
  const ls = tool('Bash', { command: 'ls src' });
  const failed = tool('Bash', { command: 'git push' }, { status: 'failed', output: 'rejected' });
  assert.equal(summarizeTools([ls, blockedRead]), 'Ran 1 command · 1 blocked');
  assert.equal(summarizeTools([ls, blockedRead, failed]), 'Ran 1 command · 1 failed · 1 blocked');
  assert.equal(summarizeTools([blockedRead, blockedRead]), 'Blocked 2 calls');
});

// --- Destructive badge tooltip -----------------------------------------------------------------

test('the destructive badge carries an in-app tooltip, not a native title', () => {
  const html = traceRowHtml({ kind: 'shell', verb: 'Deleted', chip: { icon: 'file', label: 'src', title: 'rm -rf src' }, object: '', destructive: true, risks: ['Deleted src'] });
  assert.match(html, /<span class="tool-trace-badge is-danger" tabindex="0" role="note" data-trace-badge aria-label="Destructive: Deleted src" data-trace-risks="\[&quot;Deleted src&quot;\]" data-trace-tip="Deleted src">destructive<\/span>$/);
  assert.doesNotMatch(html, /tool-trace-badge[^>]* title=/);
});

// --- Summaries ---------------------------------------------------------------------------------

const panda = (name, input = {}, extra = {}) => tool(`mcp__pandacode_architect__pandacode_${name}`, input, extra);

test('summaries: snapshots, screenshots as images, files an update touched, and what is hidden', () => {
  assert.equal(summarizeTools([panda('progress_snapshot', { title: 'a' }), panda('progress_snapshot', { title: 'b' })]), 'Posted 2 snapshots');
  const shots = [panda('simulator_screenshot', { udid: 'A1' }), panda('vm_screenshot', { name: 'mac' }), panda('capture_browser'), tool('View image', { path: '/tmp/a.png' })];
  assert.equal(summarizeTools(shots), 'Viewed 4 images');
  const update = tool('Update files', 'update /repo/src/a.ts\nupdate /repo/src/b.ts', { output: '/repo/src/a.ts\n-old\n+new\n/repo/src/b.ts\n+added\n' });
  assert.equal(summarizeTools([update]), 'Edited 2 files');
  const ls = tool('Bash', { command: 'ls src' });
  const read = tool('Read', { file_path: '/repo/a.ts' });
  const grep = tool('Grep', { pattern: 'x' });
  const fetch = tool('WebFetch', { url: 'https://a.dev' });
  assert.equal(summarizeTools([ls, read, ...Array(12).fill(grep)]), 'Ran 1 command, 12 searches and read 1 file');
  // Same verbs share one phrase; what stays hidden is named by its biggest group.
  assert.equal(summarizeTools([read, grep, ls, ls, ls]), 'Read 1 file, ran 1 search and 3 commands');
  assert.equal(summarizeTools([ls, read, grep, grep, grep, fetch, fetch]), 'Ran 1 command, 3 searches, read 1 file and fetched 2 pages');
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' });
  const todo = tool('TodoWrite', { todos: [] });
  assert.equal(summarizeTools([read, edit, todo, fetch, fetch, fetch]), 'Read 1 file, edited 1 file, updated the plan and fetched 3 pages');
});

test('a summary never ends in a `+N more <noun>` fragment: the remainder reads "and N more steps"', () => {
  const read = tool('Read', { file_path: '/repo/a.ts' });
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' });
  const fetch = tool('WebFetch', { url: 'https://a.dev' });
  const team = tool('mcp__pandacode__pandacode_send_team_message', { to: 'x', message: 'hi' });
  const write = tool('Write', { file_path: '/repo/b.ts', content: 'x' });
  const many = [read, edit, write, ...Array(12).fill(team), fetch];
  const sentence = summarizeTools(many);
  assert.doesNotMatch(sentence, /\+\d|other steps?/);
  assert.match(sentence, / and 2 more steps$/);
  // One hidden group is named as a phrase of its own.
  assert.equal(summarizeTools([read, edit, fetch]), 'Read 1 file, edited 1 file and fetched 1 page');
});

// --- Wording -----------------------------------------------------------------------------------

test('screenshots read `Took a screenshot of [Simulator]`; Claude in Chrome `Took a screenshot`', () => {
  const sim = describeTool(panda('simulator_screenshot', {}));
  assert.equal(plain(traceRowHtml(sim)), 'Took a screenshot of Simulator');
  assert.equal(describeTool(panda('simulator_screenshot', {}, { status: 'failed' })).verb, "Couldn't take a screenshot of");
  const chrome = describeTool(tool('mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 3 }));
  assert.equal(plain(traceRowHtml(chrome)), 'Took a screenshot');
  assert.equal(summarizeTools([tool('mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 3 })]), 'Viewed 1 image');
});

test('`git status --short` leaves no loose flag beside its chip', () => {
  const trace = describeTool(tool('Bash', { command: 'git status --short' }));
  assert.equal(plain(traceRowHtml(trace)), 'Checked git status');
  assert.doesNotMatch(traceRowHtml(trace), /is-mono/);
});

test('counts and notes use one ` · ` separator, never two in a row', () => {
  const rows = [
    tool('Bash', { command: 'npm test', run_in_background: true }),
    panda('vm_exec', { name: 'mac', command: 'ls' }),
    panda('read_team_mailbox', {}, { output: '{"messages":[]}' }),
    panda('list_tasks', { archived: true }, { output: '{"tasks":[{"id":"1","title":"a"}]}' }),
    panda('team_directory', {}, { output: '{"workers":[{"id":"1","name":"a"}]}' }),
    panda('bot_schedule', { title: 'Ping', kind: 'daily', timeOfDay: '09:00' }),
    panda('schedule_wakeup', { inMinutes: 30, note: 'check' }),
    tool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }),
    tool('Bash', { command: 'npx playwright test' }, { status: 'failed', output: 'Exit code: 1\nOutput:\n  1 failed\n  13 passed (40.1s)\n' }),
  ];
  for (const record of rows) {
    const text = plain(traceRowHtml(describeTool(record)));
    assert.doesNotMatch(text, /·\s*·|·\s*$|^\S+\s+·\s*·/, text);
    assert.doesNotMatch(text, /\s{2,}/, text);
  }
});

// --- Claude Bash description as the row's object -----------------------------------------------

test('a generic shell row quotes its Bash description; the card keeps the raw command', () => {
  const record = tool('Bash', { command: 'python3 -c "print(1)" | weird', description: 'Check python works' }, { output: '1' });
  const trace = describeTool(record);
  assert.equal(trace.note, 'Check python works');
  assert.equal(trace.object, '');
  // The raw-command fallback is chipped by its program (shell worker's `raw` intent), never the generic `shell`.
  assert.equal(plain(traceRowHtml(trace)), 'Ran python3 · “Check python works”');
  assert.match(toolPreview(record), /python3 -c &quot;print\(1\)&quot; \| weird/);
  // A described intent keeps its own sentence.
  assert.equal(describeTool(tool('Bash', { command: 'ls src', description: 'List src' })).note, undefined);
});

// --- Images a command wrote --------------------------------------------------------------------

test('a completed command that wrote an image shows its thumbnail beside its name and in the card', t => {
  // `producedImage` comes from the shell worker's describeShell; until it reaches the intent there is nothing to draw.
  if (!describeShell('screencapture -x /tmp/shot.png').producedImage) { t.skip('describeShell does not name produced images yet'); return; }
  const record = tool('Bash', { command: 'screencapture -x /tmp/shot.png' });
  const trace = describeTool(record);
  assert.equal(trace.produced, '/tmp/shot.png');
  const html = traceRowHtml(trace);
  assert.match(html, /<span class="tool-trace-produced(?: is-compact)?">.*data-tool-image="\/tmp\/shot\.png"/);
  assert.ok(html.indexOf('tool-trace-produced') < html.indexOf('tool-trace-chip'), html);
  assert.match(toolPreview(record), /class="tool-image-card"/);
  // Not when it failed.
  assert.equal(describeTool(tool('Bash', { command: 'screencapture -x /tmp/shot.png' }, { status: 'failed', output: 'denied' })).produced, undefined);
});

// --- Devin line lists --------------------------------------------------------------------------

test('Devin `Read lines 871, 873, 1025` keeps its line numbers', () => {
  const lines = describeTool(tool('Read lines 871, 873, 1025 in ./src-tauri/src/superagent/engine_tests.rs', ''));
  assert.equal(plain(traceRowHtml(lines)), 'Read engine_tests.rs lines 871, 873, 1025');
  assert.equal(lines.chip?.title, './src-tauri/src/superagent/engine_tests.rs');
  const ranges = describeTool(tool('Read lines 38-48, 108-119 in ./docs/agent-reference.md', ''));
  assert.equal(plain(traceRowHtml(ranges)), 'Read agent-reference.md lines 38–48, 108–119');
});

// --- New shell verbs ---------------------------------------------------------------------------

test('verbs the shell worker added have running and failed forms', () => {
  for (const [past, running, failed] of [
    ['Processed', 'Processing', "Couldn't process"], ['Resized', 'Resizing', "Couldn't resize"],
    ['Initialized', 'Initializing', "Couldn't initialize"], ['Looked up', 'Looking up', "Couldn't look up"],
    ['Created', 'Creating', "Couldn't create"], ['Wrote', 'Writing', "Couldn't write"],
    ['Measured', 'Measuring', "Couldn't measure"], ['Rendered', 'Rendering', "Couldn't render"],
    ['Compiled', 'Compiling', "Couldn't compile"], ['Decoded', 'Decoding', "Couldn't decode"],
    ['Cropped', 'Cropping', "Couldn't crop"], ['Rotated', 'Rotating', "Couldn't rotate"],
    ['Compared', 'Comparing', "Couldn't compare"], ['Optimized', 'Optimizing', "Couldn't optimize"],
    ['Transcoded', 'Transcoding', "Couldn't transcode"], ['Trimmed', 'Trimming', "Couldn't trim"],
    ['Verified', 'Verifying', "Couldn't verify"], ['Migrated', 'Migrating', "Couldn't migrate"],
  ]) {
    assert.equal(shellRunningVerb(past), running, past);
    assert.equal(failedVerb(running), failed, past);
  }
});

// --- Wording from recorded calls -----------------------------------------------------------------

test('summaries: tracking file changes reads as what it did', () => {
  const begin = tool('mcp__pandacode_architect__pandacode_track_files', { action: 'begin', paths: ['a'] });
  assert.equal(plain(traceRowHtml(describeTool(begin))), 'Tracked changes to 1 file');
  assert.equal(summarizeTools([begin]), 'Tracked file changes');
  assert.equal(summarizeTools([begin, tool('mcp__pandacode_architect__pandacode_track_files', { action: 'complete', paths: ['a'] })]), 'Tracked file changes');
});

test('Kimi reads name their line range', () => {
  const read = tool('Reading src/token-saver-panel.ts', { path: 'src/token-saver-panel.ts', line_offset: 45, n_lines: 45 });
  assert.equal(plain(traceRowHtml(describeTool(read))), 'Read token-saver-panel.ts lines 45–89');
  const whole = tool('Reading src/a.ts', { path: 'src/a.ts', line_offset: 1, n_lines: 145 });
  assert.equal(plain(traceRowHtml(describeTool(whole))), 'Read a.ts');
});

test('team messages, cut follow-ups, questions and plan mode read as sentences', () => {
  const sent = tool('pandacode_send_team_message', { message: 'Thanks', to: 'Rows' });
  assert.equal(plain(traceRowHtml(describeTool(sent))), 'Messaged Rows · “Thanks”');
  const cut = tool('pandacode_followup_worker', '{\n  "files": [],\n  "key": "round8-fixes",\n  "prompt": "Council round 8: Correctness 7, Security 8');
  assert.equal(plain(traceRowHtml(describeTool(cut))), 'Followed up with a worker · “Council round 8: Correctness 7, Security 8”');
  const queued = { ...cut, output: '{"queued":true,"workerId":"00551630-7bc1-4444-85da-76e0e4067947"}' };
  assert.equal(describeTool(queued).chip?.label, '00551630');
  const ask = tool('AskUserQuestion', { questions: [{ header: 'Close how', question: 'How should I close these?', multiSelect: false, options: [] }, { question: 'Second?' }] });
  assert.equal(plain(traceRowHtml(describeTool(ask))), 'Asked you a question · “How should I close these?”');
  assert.equal(describeTool({ ...ask, status: 'failed', output: 'Ask the user in your response.' }).verb, "Couldn't ask you a question");
  const plan = tool('Requesting to enter plan mode', {}, { output: 'Plan mode is now active.' });
  assert.equal(plain(traceRowHtml(describeTool(plan))), 'Entered plan mode');
  const capture = tool('Begin file change capture for link shortener API work', { description: 'Begin file change capture for link shortener API work', prompt: 'Begin a file change capture for this task.' });
  assert.equal(plain(traceRowHtml(describeTool(capture))), 'Started tracking file changes');
});

test('a command that wrote an image: chip, then its thumb, then `+N more` last', t => {
  if (!describeShell('screencapture -x /tmp/shot.png').producedImage) { t.skip('describeShell does not name produced images yet'); return; }
  const html = traceRowHtml(describeTool(tool('Bash', { command: 'screencapture -x /tmp/shot.png && ls && git status' })));
  assert.equal((html.match(/shot\.png</g) ?? []).length, 1, html);
  assert.ok(html.indexOf('tool-trace-produced') < html.indexOf('tool-trace-more-steps'), html);
  assert.match(html, /tool-trace-produced is-compact/);
});

test('the destructive tooltip lists each `reason: command` on its own line, wrapping only between words', () => {
  const risks = ['Deleted files: rm -rf src --no-preserve-root', 'Force-pushed: git push -f'];
  const html = traceRowHtml({ kind: 'shell', verb: 'Deleted', object: '', destructive: true, risks });
  assert.match(html, /aria-label="Destructive: Deleted files: rm -rf src --no-preserve-root; Force-pushed: git push -f"/);
  assert.ok(html.includes(`data-trace-risks="${JSON.stringify(risks).replace(/"/g, '&quot;')}"`), html);
  const W = word => `<span class="tool-trace-tip-word">${word}</span>`;
  assert.equal(tipLinesHtml(risks),
    `<span class="tool-trace-tip-line"><span class="tool-trace-tip-reason">Deleted files</span><code>${['rm', '-rf', 'src', '--no-preserve-root'].map(W).join(' ')}</code></span>`
    + `<span class="tool-trace-tip-line"><span class="tool-trace-tip-reason">Force-pushed</span><code>${['git', 'push', '-f'].map(W).join(' ')}</code></span>`);
  // A bare command (no prose reason) is all code; a colon inside a command is no reason.
  assert.equal(tipLinesHtml(['rm -rf src']), `<span class="tool-trace-tip-line"><code>${['rm', '-rf', 'src'].map(W).join(' ')}</code></span>`);
  assert.doesNotMatch(tipLinesHtml(['git push origin :main']), /tip-reason/);
  assert.match(tipLinesHtml(['Deleted: rm /a/' + 'x'.repeat(60)]), /tool-trace-tip-word is-long/);
});

test('the tooltip sits below its badge, flips above when the space below is short, and stays on screen', () => {
  const badge = { top: 100, bottom: 120, left: 300, right: 380 };
  assert.deepEqual(placeTip(badge, { width: 200, height: 60 }, { width: 800, height: 600 }), { top: 126, left: 300, above: false });
  assert.deepEqual(placeTip({ ...badge, top: 520, bottom: 540 }, { width: 200, height: 60 }, { width: 800, height: 600 }), { top: 454, left: 300, above: true });
  assert.deepEqual(placeTip({ ...badge, left: 700, right: 780 }, { width: 200, height: 60 }, { width: 800, height: 600 }), { top: 126, left: 592, above: false });
});

test('new shell verbs: spawned, terminated, seeded, unmounted and friends', () => {
  for (const [past, running, failed] of [
    ['Spawned', 'Spawning', "Couldn't spawn"], ['Stopped app', 'Stopping app', "Couldn't stop app"],
    ['Dropped database', 'Dropping database', "Couldn't drop database"], ['Terminated', 'Terminating', "Couldn't terminate"],
    ['Seeded', 'Seeding', "Couldn't seed"], ['Unmounted', 'Unmounting', "Couldn't unmount"], ['Loaded', 'Loading', "Couldn't load"],
    ['Unloaded', 'Unloading', "Couldn't unload"], ['Flushed', 'Flushing', "Couldn't flush"], ['Ejected', 'Ejecting', "Couldn't eject"],
    ['Attached', 'Attaching', "Couldn't attach"], ['Detached', 'Detaching', "Couldn't detach"], ['Forked', 'Forking', "Couldn't fork"],
    ['Scheduled', 'Scheduling', "Couldn't schedule"], ['Simulated', 'Simulating', "Couldn't simulate"], ['Printed', 'Printing', "Couldn't print"],
  ]) {
    assert.equal(shellRunningVerb(past), running, past);
    assert.equal(failedVerb(running), failed, past);
  }
});

// --- Waits keep their subject, polish, team gists, legacy shapes ---------------------------------

const bashRow = command => describeTool(tool('Bash', { command }));
const chipOf = trace => trace.chip?.label;

test('a polling wait names what it waited for as a chip; `responds` is prose', () => {
  const host = bashRow('until curl -s localhost:1420 >/dev/null; do sleep 1; done');
  assert.equal(plain(traceRowHtml(host)), 'Waited for localhost:1420 responds');
  assert.equal(chipOf(host), 'localhost:1420');
  assert.equal(host.mono, false);
  const log = bashRow('until grep -q ready server.log; do sleep 1; done');
  assert.equal(plain(traceRowHtml(log)).replace(/&quot;/g, '"'), 'Waited for server.log to contain “ready”');
  assert.equal(chipOf(log), 'server.log');
  const file = bashRow('until [ -f x ]; do sleep 1; done');
  assert.equal(chipOf(file), 'x');
  assert.match(plain(traceRowHtml(file)), /^Waited for x to exist/);
  assert.equal(plain(traceRowHtml(bashRow('sleep 30'))), 'Waited 30s');
});

test('`.` reads as the working tree, never as a chip of one dot', () => {
  assert.equal(plain(traceRowHtml(bashRow('ls .'))), 'Listed the working tree');
  assert.equal(plain(traceRowHtml(bashRow('git add .'))), 'Staged git add the working tree');
  assert.equal(plain(traceRowHtml(describeTool(tool('Grep', { pattern: 'x', path: '.' })))).replace(/&quot;/g, '"'), 'Searched for “x” in the working tree');
  assert.match(plain(traceRowHtml(bashRow('rg foo .'))), /in the working tree$/);
});

test('quoted prose uses curly quotes; mono code keeps straight ones', () => {
  assert.equal(bashRow('rg "foo bar" src').object, 'for “foo bar” in');
  assert.equal(describeTool(tool('ToolSearch', { query: 'slack' })).object, 'for “slack”');
  const code = bashRow('git commit -m "Fix it"');
  if (code.mono) assert.doesNotMatch(code.object, /[“”]/);
});

test('a check that expects no answer reads `· not responding`', () => {
  assert.equal(plain(traceRowHtml(bashRow('! curl -s localhost:1420'))), 'Checked localhost:1420 · not responding');
  assert.equal(plain(traceRowHtml(bashRow('if curl -s localhost:1420; then exit 1; fi'))), 'Checked localhost:1420 · not responding');
  assert.equal(bashRow('curl -sf localhost:1420/health >/dev/null').object, '/health responds');
});

test('Devin `Ran python3, grep` separates its program chips', () => {
  const two = describeTool({ name: 'Ran python3, grep', status: 'completed', input: 'out', output: '' });
  assert.equal(plain(traceRowHtml(two)), 'Ran python3 and grep');
  assert.match(traceRowHtml(two), /<\/span><span class="tool-trace-join">and<\/span><span class="tool-trace-chip"/);
  const three = describeTool({ name: 'Ran python3, grep, rg in ./src', status: 'completed', input: 'out', output: '' });
  assert.equal(plain(traceRowHtml(three)), 'Ran python3 , grep and rg in ./src');
  const four = describeTool({ name: 'Ran a, b, c, d', status: 'completed', input: 'out', output: '' });
  assert.equal(plain(traceRowHtml(four)), 'Ran a , b , c +1 more program');
});

test('a team message carries the gist of what it said', () => {
  const message = 'Please check the regex hang in tool-trace-intent and report back when the perf test passes, with timings for each hostile input';
  const sent = describeTool(tool('mcp__pandacode_architect__pandacode_send_team_message', { to: 'Rows', message }));
  assert.equal(sent.chip?.label, 'Rows');
  // Kept whole: the row's CSS ellipsizes it to the room there is.
  assert.equal(sent.note, message);
  assert.match(plain(traceRowHtml(sent)), /^Messaged Rows · “Please check/);
});

test('Codex legacy `Update files` that only add or only delete read `Created` / `Deleted`', () => {
  const add = describeTool({ name: 'Update files', status: 'completed', input: 'add src/new.ts', output: 'src/new.ts\nline1\nline2\n' });
  assert.equal(plain(traceRowHtml(add)), 'Created new.ts +2 −0');
  const del = describeTool({ name: 'Update files', status: 'completed', input: 'delete src/old.ts', output: 'src/old.ts\nline1\n' });
  assert.equal(plain(traceRowHtml(del)), 'Deleted old.ts +0 −1');
  const mixed = describeTool({ name: 'Update files', status: 'completed', input: 'add src/new.ts\nupdate src/a.ts', output: 'src/new.ts\nx\nsrc/a.ts\n-a\n+b\n' });
  assert.equal(mixed.verb, 'Edited');
});

test('Muse `edit_file` with find/replace counts its lines', () => {
  const trace = describeTool(tool('edit_file', { path: 'src/a.ts', find: 'a\nb', replace: 'c' }));
  assert.deepEqual([trace.verb, trace.chip?.label, trace.added, trace.removed], ['Edited', 'a.ts', 1, 2]);
});

// --- Summaries --------------------------------------------------------------------------------

const PATCH = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n+more\n*** End Patch\nEOF";
const patchCall = tool('Command', `/bin/zsh -lc "${PATCH}"\nWorking directory: /repo`);

test('a Codex apply_patch shell row counts as an edited file with its delta', () => {
  const trace = describeTool(patchCall);
  assert.deepEqual([trace.verb, trace.chip?.label, trace.added, trace.removed], ['Edited', 'a.ts', 2, 1]);
  assert.equal(summarizeTools([patchCall, patchCall, tool('Bash', { command: 'git status' })]), 'Edited 2 files and ran 1 command');
});

test('summaries never say `and` twice, and say `twice` for two test runs', () => {
  const test1 = tool('Bash', { command: 'npm test' });
  assert.equal(summarizeTools([test1, test1]), 'Ran tests twice');
  assert.equal(summarizeTools([test1, test1, test1]), 'Ran tests 3 times');
  const mixed = [
    tool('Bash', { command: 'rg foo src' }), tool('Bash', { command: 'git status' }), tool('Read', { file_path: '/a.ts' }),
    tool('mcp__github__get_issue', { q: 'x' }), tool('Edit', { file_path: '/b.ts', old_string: 'a', new_string: 'b' }),
  ];
  for (let size = 2; size <= mixed.length; size++) {
    const sentence = summarizeTools(mixed.slice(0, size));
    assert.ok((sentence.match(/ and /g) ?? []).length <= 1, sentence);
  }
});

// --- Rows round: timeouts, compound checks, summaries that follow outcomes, quiet unavailable tools -----------------

const bashRun = (command, output, status = 'completed', extra = {}) => tool('Bash', { command, ...extra }, { status, output });

test('a compound whose check failed leads with it: `Typecheck failed [tsc] · 2 errors`, red and counted', t => {
  const command = 'npx tsc --noEmit; npm test';
  const output = 'src/a.ts(1,1): error TS2322: x\nsrc/b.ts(2,1): error TS2345: y\nFound 2 errors in 2 files.\n# pass 3\n# fail 0';
  const check = describeShell(command, output).check;
  if (!check) { t.skip('ShellIntent.check has not landed yet'); return; }
  const record = bashRun(command, output);
  const trace = describeTool(record);
  assert.equal(trace.verb, 'Typecheck failed');
  assert.match(plain(traceRowHtml(trace)), /^Typecheck failed tsc · 2 errors/);
  assert.equal(toolFailed(record), true);
  assert.match(toolPreview(record), /2 errors/);
});

test('a timed-out wait reads `Timed out after 5m · Waiting for …`, without exit 143 and apart from Stopped', () => {
  // Claude Code: status failed, `Exit code 143` then `Command timed out after 5m 0s`.
  const record = bashRun('sleep 1; until grep -q "ready" /tmp/x/server.log; do sleep 2; done', 'Exit code 143\nCommand timed out after 5m 0s', 'failed');
  const trace = describeTool(record);
  const row = plain(traceRowHtml(trace));
  assert.match(row, /^Timed out after 5m · Waiting for server\.log/);
  assert.doesNotMatch(row, /exit 143|Stopped|Couldn't/);
  assert.equal(trace.exit, undefined);
  assert.equal(toolFailed(record), true);
  assert.match(plain(traceRowHtml(describeTool(bashRun('npm run dev', 'Exit code 143\nCommand timed out after 1m 30s', 'failed')))), /^Timed out after 1m 30s · Running/);
  // A real stop (no timeout text) still reads Stopped.
  assert.match(plain(traceRowHtml(describeTool(bashRun('node server.mjs', 'Exit code 143\n', 'failed')))), /^Stopped/);
});

test('a command moved to the background reads `Moved to background · <what it was doing>`, neither passed nor failed', () => {
  const output = 'Command did not complete within its 120s timeout and was moved to the background (ID: b1). Output is being written to: /tmp/b1.output. You will be notified when it completes.';
  const record = bashRun('npm run build', output);
  const row = plain(traceRowHtml(describeTool(record)));
  assert.equal(row, 'Moved to background · Building npm run build');
  assert.equal(toolFailed(record), false);
});

test('a passing test run shows its counts: `Ran tests [cargo test] · 152 passed`', () => {
  const trace = describeTool(bashRun('cargo test', 'running 152 tests\ntest result: ok. 152 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.84s'));
  assert.equal(plain(traceRowHtml(trace)), 'Ran tests cargo test · 152 passed');
});

test('summaries follow outcomes: failed calls are never done verbs; naming and web searches read as themselves', () => {
  const read = tool('Read', { file_path: '/repo/a.ts' });
  const bash = bashRun('ls', '');
  assert.equal(summarizeTools([bash, { ...read, status: 'failed', output: 'File does not exist.' }]), 'Ran 1 command · 1 failed');
  assert.equal(summarizeTools([bashRun('python x.py', 'Exit code 1\nx', 'failed'), bash]), 'Ran 1 command · 1 failed');
  const title = tool('mcp__pandacode_architect__pandacode_title', { title: 'Fix rows' });
  const web = tool('WebSearch', { query: 'tauri updater' });
  assert.equal(summarizeTools([title]), 'Named the task');
  assert.equal(summarizeTools([web, web]), 'Searched the web twice');
  assert.equal(summarizeTools([web, title]), 'Searched the web and named the task');
});

test('web searches quote their query: `Searched the web for “tauri updater”`', () => {
  assert.equal(plain(traceRowHtml(describeTool(tool('WebSearch', { query: 'tauri updater' })))), 'Searched the web for “tauri updater”');
});

test('`No such tool available: X` reads `Unavailable tool: X`, quiet and never failed', () => {
  const record = tool('bash', { command: 'ls' }, { status: 'failed', output: '<tool_use_error>Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead.</tool_use_error>' });
  const trace = describeTool(record);
  assert.equal(plain(traceRowHtml(trace)), 'Unavailable tool: bash');
  assert.equal(trace.quiet, true);
  assert.equal(toolFailed(record), false);
  assert.equal(summarizeTools([record]), 'Asked for 1 unavailable tool');
});

test('Kimi reads show their range; Devin edits cut before `+++ After` label their text Before', () => {
  const path = '/repo/src/model.ts';
  const kimi = tool(`Reading ${path}`, { path, line_offset: 213, n_lines: 210 }, { output: '213\tx' });
  assert.equal(plain(traceRowHtml(describeTool(kimi))), 'Read model.ts lines 213–422');
  const devin = tool('Edit file', `/repo/src/a.css\n--- Before\n.a { color: red; }\n${'x'.repeat(4000)}`);
  assert.match(plain(toolPreview(devin)), /Before \(after was not recorded\)/);
});

test('row objects keep their full text up to the safety cap; CSS ellipsizes, never a JS `…`', () => {
  const long = 'a'.repeat(150);
  const trace = describeTool(tool('Grep', { pattern: long, path: 'src' }));
  assert.ok(trace.object.includes(long), trace.object);
  const agent = describeTool(tool('Task', { subagent_type: 'Explore', description: 'b'.repeat(200) }));
  assert.ok(!agent.object.endsWith('…'), agent.object);
  assert.ok(describeTool(tool('Task', { description: 'c'.repeat(1000) })).object.length <= 400);
});

test('new shell verbs have running and failed forms', () => {
  assert.equal(shellRunningVerb('Untracked'), 'Untracking');
  assert.equal(failedVerb(shellRunningVerb('Untracked')), "Couldn't untrack");
});

// --- Polish: refused images, interrupted empties, counts, devices -----------------------------------------------

test('a denied or failed image read shows its name, never a thumbnail', () => {
  const missing = describeTool(tool('Read', { file_path: '/tmp/flint-thumb/v1.png' }, { status: 'failed', output: 'File does not exist. Note: your current working directory is /repo.' }));
  assert.equal(missing.image, undefined);
  assert.equal(missing.chip?.label, 'v1.png');
  assert.doesNotMatch(traceRowHtml(missing), /tool-image-thumb/);
  const denied = describeTool(tool('Read', { file_path: '/tmp/a.png' }, { status: 'failed', output: "<tool_use_error>The user doesn't want to proceed with this tool use.</tool_use_error>" }));
  assert.equal(denied.image, undefined);
  assert.equal(plain(traceRowHtml(denied)), 'Denied: view a.png');
});

test('an interrupted call with no input reads `Interrupted before it ran`', () => {
  for (const name of ['Bash', 'Write']) {
    const trace = describeTool(tool(name, '{}', { status: 'failed', output: '\n\n[PandaCode was interrupted before this tool reported a result.]' }));
    assert.equal(trace.verb, 'Interrupted before it ran', name);
  }
});

test('counts and tallies after a mono object are never mono', () => {
  const html = traceRowHtml({ kind: 'shell', verb: 'Diffed', chip: { icon: 'git', label: 'git diff', title: 'git diff main' }, object: 'main · 10 files', mono: true });
  assert.match(html, /<span class="tool-trace-object is-mono">main<\/span><span class="tool-trace-object is-tally"> · 10 files<\/span>/);
  assert.match(traceRowHtml({ kind: 'shell', verb: 'Diffed', object: '· 10 files', mono: true }), /<span class="tool-trace-object">· 10 files<\/span>/);
});

test('a bare `+N` count names its noun by kind', () => {
  assert.match(bashRow('kill 31851 31848').object, /\+1 more process\b/);
  assert.match(bashRow('node --test tests/a.test.mjs tests/b.test.mjs').object, /\+1 more file\b/);
  assert.doesNotMatch(bashRow('node --test tests/a.test.mjs tests/b.test.mjs').object, /item/);
});

test('a simulator screenshot names its device from the output', () => {
  const shot = describeTool(panda('simulator_screenshot', {}, { output: 'iPhone Duo (iOS 27.1, CDDA7229-AE26-426A-ADCC-56D9BCA29920). Screen 951×669 points; image pixels are points.' }));
  assert.equal(shot.chip?.label, 'iPhone Duo');
});

test('a failed typecheck card lists its counted `error TS` lines first', () => {
  const output = 'Exit code 2\n> tsc --noEmit\n\nsrc/a.ts(3,1): error TS2345: Argument\n  more context\nsrc/b.ts(1,1): error TS2322: Type\nnpm notice done';
  const card = toolPreview(tool('Bash', { command: 'npm run typecheck' }, { status: 'failed', output }));
  const pre = /<pre class="tc-term-out"[^>]*>([\s\S]*?)<\/pre>/.exec(card)?.[1] ?? '';
  assert.match(pre, /^src\/a\.ts\(3,1\): error TS2345: Argument\nsrc\/b\.ts\(1,1\): error TS2322: Type\n/);
});

test('a running or failed form exists for the newer shell verbs', () => {
  for (const [verb, failed] of [['Applied stash', "Couldn't apply stash"], ['Renamed branch to', "Couldn't rename branch to"], ['Sent DELETE to', "Couldn't send DELETE to"]]) {
    assert.equal(failedVerb(shellRunningVerb(verb)), failed);
  }
});

test('the `+N more commands` tail gives way only after the object, and the image name is a hairline chip', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('../src/tool-trace.css', import.meta.url), 'utf8');
  const more = /\.tool-trace-more-steps\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(more, /^flex:0 \d+ auto;min-width:0;overflow:hidden;text-overflow:ellipsis/);
  const shrink = (rule) => Number(/flex:0 (\d+) auto/.exec(rule)?.[1]);
  const object = /\n\.tool-trace-object\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(shrink(object) > shrink(more), 'the object shrinks before the `+N more` tail');
  const name = /\.tool-trace-image>\.tool-image-name\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(name, /border:1px solid var\(--ds-[\w-]+\)/);
  assert.match(name, /display:block;/);
  const chip = /\n\.tool-trace-chip\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.equal(/border:[^;]+/.exec(name)?.[0], /border:[^;]+/.exec(chip)?.[0]);
});

// --- Script chips, subshells, trusted checks, steps that never ran -------------------------------------------------

const bash = (command, output = '', status = 'completed') => tool('Bash', { command }, { status, output });

test('`<pm> run <script>` keeps its chip and drops the run word', () => {
  for (const [command, verb] of [['npm run build', 'Built'], ['npm run lint', 'Linted'], ['pnpm run build', 'Built'], ['yarn run lint', 'Linted'], ['bun run build', 'Built']]) {
    const trace = describeTool(bash(command));
    assert.equal(trace.verb, verb, command);
    assert.equal(trace.chip?.label, command, command);
    assert.doesNotMatch(trace.object, /\brun\b/, command);
  }
});

test('a subshell step chips its intent, not the whole command', () => {
  const trace = describeTool(bash('cd /x && (cargo build | tail -5)', 'Finished dev'));
  assert.equal(trace.verb, 'Built');
  assert.equal(trace.chip?.label, 'cargo build');
});

test('a passing check is trusted over a later step printing `error:`', () => {
  const trace = describeTool(bash('go vet ./... && echo error: nope', 'error: nope\n'));
  assert.notEqual(trace.verb, 'Typecheck failed');
  assert.equal(trace.outputFailed, undefined);
});

test('a wait whose log shows failed tests keeps the wait and tallies the check apart', () => {
  const command = 'for i in $(seq 1 58); do grep -q "^DONE" /tmp/final2.log && break; sleep 10; done; tail -5 /tmp/final2.log';
  const trace = describeTool(bash(command, '  3 failed\n  870 passed (2m)\n'));
  assert.equal(trace.verb, 'Waited for');
  assert.equal(trace.chip?.label, 'final2.log');
  assert.match(trace.object, /^to contain “\^DONE” · 3 of 873 tests failed$/);
});

test('a destructive step after failed tests never ran: the tests lead, the badge goes, the risk stays in the tooltip', () => {
  const trace = describeTool(bash('npm test && git push --force', '# tests 1\n# pass 0\n# fail 1\n', 'failed'));
  assert.equal(trace.verb, 'Tests failed');
  assert.match(trace.object, /· 1 of 1 tests$/);
  assert.equal(trace.destructive, undefined);
  assert.deepEqual(trace.risks, ['Rewrites remote history: git push --force']);
  assert.match(trace.title ?? '', /git push --force/);
  const html = traceRowHtml(trace);
  assert.doesNotMatch(plain(html), /Force-pushed|destructive/);
});
