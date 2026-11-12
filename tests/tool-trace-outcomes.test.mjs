import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, summarizeTools, toolFailed, toolPreview, traceRowHtml } from '../src/tool-trace.ts';
import { renderToolActivity, renderToolGroup } from '../src/tool-activity.ts';
import { describeShell } from '../src/shell-intent.ts';

// Shapes copied from real recorded tool calls (kingcode.sqlite3, paths shortened): Claude Code writes a failed
// Bash call as status `failed` with `Exit code N` leading its output; Codex as `Exit code: N` with `Wall time` and `Output:`.
const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input, null, 2), output: '', ...extra });
const bash = (command, output, status = 'failed') => tool('Bash', { command }, { status, output });
const codex = (command, output, status = 'completed') => tool('Command', `/bin/zsh -lc '${command}'\nWorking directory: /repo`, { status, output });
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const row = trace => plain(traceRowHtml(trace));

// --- 1. A failed compound keeps what its lead step did ------------------------------------------

test('a failed compound keeps its finished lead verb and adds the exit badge', () => {
  const trace = describeTool(bash("sed -n '3130,3220p' src/main.ts; grep -n foo src/a.ts; ls nope", 'Exit code 2\nline\nls: nope: No such file or directory'));
  assert.equal(trace.verb, 'Read');
  assert.equal(trace.exit, 2);
  assert.equal(row(trace), 'Read main.ts lines 3130–3220 +2 more commands exit 2');
  assert.match(traceRowHtml(trace), /class="tool-trace-badge is-failed" title="Then failed with exit 2"/);
  // Still a failure: red, and counted.
  assert.equal(toolFailed(bash("sed -n '1,2p' a.ts; ls nope", 'Exit code 1\nls: nope')), true);
});

test('a real node --version compound never reads `Couldn\'t check version of node`', () => {
  const trace = describeTool(bash('node --version; mkdir -p /tmp/bb && cd /tmp/bb && curl -fsSLO https://example.com/install.sh && shasum -a 256 install.sh', 'Exit code 22\nv22.22.3\ncurl: (22) The requested URL returned error: 404'));
  assert.doesNotMatch(trace.verb, /^Couldn't/);
  assert.equal(trace.exit, 22);
});

test('a failed compound with no exit code says `failed`', () => {
  const trace = describeTool(bash("sed -n '1,2p' a.ts; ls nope", 'ls: nope: No such file or directory'));
  assert.equal(trace.verb, 'Read');
  assert.match(row(trace), / failed$/);
});

test('only a single-step command reads `Couldn\'t …`', () => {
  assert.equal(describeTool(bash('ls missing-dir', 'Exit code 1\nls: missing-dir: No such file or directory')).verb, "Couldn't list");
  assert.equal(describeTool(bash('ls missing-dir', 'Exit code 1\nls: missing-dir: No such file or directory')).exit, undefined);
});

// --- 2. grep exiting 1 with nothing printed found nothing --------------------------------------

test('grep, rg and git grep exiting 1 with empty output read `no matches`, not a failure', () => {
  for (const command of ['grep -rn "zzz" src', 'rg zzz src']) {
    const call = bash(command, 'Exit code 1');
    const trace = describeTool(call);
    assert.equal(row(trace), 'Searched for “zzz” in src · no matches', command);
    assert.equal(trace.exit, undefined);
    assert.equal(toolFailed(call), false, command);
    assert.doesNotMatch(renderToolActivity({ id: 'g', ...call }, 'k'), /data-tool-failed/);
  }
  assert.match(row(describeTool(bash('git grep zzz', 'Exit code 1\n'))), /^Searched for “zzz” · no matches$/);
  assert.equal(toolFailed(codex('rg zzz src', 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\n')), false);
  assert.equal(summarizeTools([bash('rg zzz src', 'Exit code 1'), bash('ls', '', 'completed')]), 'Ran 1 search and 1 command');
});

test('a grep that printed an error, or exited 2, still failed', () => {
  assert.equal(toolFailed(bash('grep -rn zzz nope', 'Exit code 2\ngrep: nope: No such file or directory')), true);
  assert.equal(toolFailed(bash('grep -rn zzz src', 'Exit code 1\ngrep: warning: something')), true);
});

test('a compound whose last step is a grep that found nothing is not a failure', () => {
  const call = bash('cat a.ts; grep -n zzz src/a.ts', 'Exit code 1\nhello');
  assert.equal(toolFailed(call), false);
  const trace = describeTool(call);
  assert.equal(trace.verb, 'Read');
  assert.equal(trace.exit, undefined);
  assert.equal(toolFailed(bash('git log --oneline | grep zzz', 'Exit code 1')), false);
  // `a && grep`: the 1 may be the first step's.
  assert.equal(toolFailed(bash('npm run build && grep -n zzz dist/a.js', 'Exit code 1\nbuild failed')), true);
});

// --- 3. Blocked calls name what was blocked ----------------------------------------------------

const BLOCKED_OUTPUT = '<tool_use_error>Blocked: sleep 60 followed by: cat /tmp/r19-tsc.txt. To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true.</tool_use_error>';
const blocked = tool('Bash', { command: 'sleep 60; cat /tmp/r19-tsc.txt', description: 'Read typecheck output' }, { status: 'failed', output: BLOCKED_OUTPUT });

test('a blocked shell call names what was blocked, with a quiet shield icon', () => {
  const trace = describeTool(blocked);
  assert.equal(trace.verb, 'Blocked:');
  assert.equal(trace.blocked, true);
  assert.equal(row(trace), 'Blocked: sleep 60 +1 more command');
  assert.equal(trace.icon, 'shield');
  assert.equal(trace.mono, true);
});

test('a blocked card uses the terminal style and its reason starts at a sentence', () => {
  const card = toolPreview(blocked);
  assert.match(card, /<div class="tc-term is-blocked"><div class="tc-term-head"><span class="tc-dollar" aria-hidden="true">\$<\/span><code class="tc-command">sleep 60; cat \/tmp\/r19-tsc\.txt<\/code>/);
  assert.match(card, /<p class="tool-trace-note is-blocked">To wait for a condition, use Monitor/);
  assert.doesNotMatch(card, /followed by|Blocked:|tool_use_error/);
  // A reason with no command in it is capitalised as a sentence.
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { status: 'failed', output: '<tool_use_error>Blocked: the file is outside the workspace.</tool_use_error>' });
  assert.match(toolPreview(edit), /tool-trace-note is-blocked">The file is outside the workspace\.<\/p>/);
});

test('blocked calls stay out of the sentence and show only as `· N blocked`', () => {
  const ls = tool('Bash', { command: 'ls src' });
  const failed = tool('Bash', { command: 'git push' }, { status: 'failed', output: 'rejected' });
  assert.equal(summarizeTools([ls, blocked]), 'Ran 1 command · 1 blocked');
  assert.equal(summarizeTools([ls, blocked, failed]), 'Ran 1 command · 1 failed · 1 blocked');
  assert.equal(summarizeTools([blocked, blocked]), 'Blocked 2 calls');
});

// --- 5. Destructive rows ------------------------------------------------------------------------

test('`git clean` reads `Cleaned untracked files [git clean -fdx]` and opens to its full command', () => {
  const call = bash('git clean -fdx', '', 'completed');
  const trace = describeTool(call);
  assert.equal(row(trace), 'Cleaned untracked files git clean -fdx destructive');
  assert.equal(trace.chipLast, true);
  const html = renderToolActivity({ id: 'c', ...call }, 'k');
  assert.match(html, /^<details/);
  assert.match(html, /<code class="tc-command">git clean -fdx<\/code>/);
});

test('a destructive row with empty output is still expandable', () => {
  const html = renderToolActivity({ id: 'p', ...bash('git push --force origin main', '', 'completed') }, 'k');
  assert.match(html, /^<details/);
  assert.match(html, /git push --force origin main/);
});

// --- 6. One thumbnail placement ----------------------------------------------------------------

test('a produced image the sentence names sits right after that name; a viewed one right after the verb', (t) => {
  if (!describeShell('screencapture -x /tmp/shot-after.png').producedImage) { t.skip('describeShell does not name produced images yet'); return; }
  const html = traceRowHtml(describeTool(bash('screencapture -x /tmp/shot-after.png', '', 'completed')));
  const chipEnd = html.indexOf('</span>', html.indexOf('tool-trace-chip'));
  assert.ok(html.indexOf('tool-trace-produced is-compact') < html.indexOf('tool-trace-chip'), html);
  const viewed = traceRowHtml(describeTool(tool('Read', { file_path: '/tmp/a.png' }, { output: '[Non-text content omitted]' })));
  assert.ok(viewed.indexOf('tool-trace-image') > viewed.indexOf('tool-trace-verb'));
});

test('a VM command that writes an image shows no thumbnail (the file is in the VM)', (t) => {
  if (!describeShell('screencapture -x /tmp/shot.png').producedImage) { t.skip('describeShell does not name produced images yet'); return; }
  const vm = tool('mcp__pandacode_architect__pandacode_vm_exec', { name: 'macos-vm', command: 'screencapture -x /tmp/shot.png' }, { output: JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(describeTool(vm).produced, undefined);
  assert.doesNotMatch(toolPreview(vm), /data-tool-image/);
});

// --- 7. Deltas, error counts, unknown tools ----------------------------------------------------

test('a delta always labels both sides, never a bare `+1` beside `+1 more file`', () => {
  const html = traceRowHtml({ kind: 'edit', verb: 'Edited', object: '+1 more file', chip: { icon: 'file', label: 'a.rs', title: 'a.rs' }, added: 1, removed: 0 });
  assert.match(html, /<span class="tool-trace-delta"><ins>\+1<\/ins> <del>−0<\/del><\/span>/);
  assert.match(traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 0, removed: 3 }), /<ins>\+0<\/ins> <del>−3<\/del>/);
  assert.doesNotMatch(traceRowHtml({ kind: 'edit', verb: 'Edited', object: '', added: 0, removed: 0 }), /tool-trace-delta/);
});

test('typecheck and lint failures count their errors in the row and the card', () => {
  const tsc = bash('npx tsc --noEmit', "Exit code 2\nsrc/a.ts(3,1): error TS2322: Type 'x' is not assignable.\nsrc/b.ts(4,1): error TS2304: Cannot find name 'y'.");
  assert.equal(row(describeTool(tsc)), 'Typecheck failed tsc · 2 errors');
  // The row says `2 errors`; the card does not repeat it.
  assert.doesNotMatch(toolPreview(tsc), /tool-trace-error-count/);
  const one = bash('npx tsc --noEmit', 'Exit code 2\nsrc/a.ts(3,1): error TS2322: nope\n\nFound 1 error in src/a.ts:3');
  assert.match(row(describeTool(one)), /· 1 error$/);
  const eslint = bash('npx eslint src', 'Exit code 1\n/repo/src/a.ts\n  3:1  error  no-unused-vars\n\n✖ 4 problems (3 errors, 1 warning)');
  assert.match(row(describeTool(eslint)), /^Lint found problems .* · 3 errors$/);
  const clippy = bash('cargo clippy -- -D warnings', 'Exit code 101\nerror: unused variable: `x`\n --> src/a.rs:1:5\nerror: could not compile `app` (lib) due to 1 previous error');
  assert.match(row(describeTool(clippy)), /· 1 error$/);
});

test('Devin `Tool` calls that named an unknown tool read `Couldn\'t use X (unknown tool)`', () => {
  const call = tool('Tool', '', { status: 'failed', output: "Unknown tool 'pandacode_send_team_message'. This tool is not available." });
  assert.equal(row(describeTool(call)), "Couldn't use send_team_message (unknown tool)");
  assert.equal(row(describeTool({ ...call, status: 'completed' })), "Couldn't use send_team_message (unknown tool)");
});

// --- 8. Claude-shaped exits read like Codex's ---------------------------------------------------

// Recorded (kingcode.sqlite3): a Claude Bash compound whose last stage is a counting grep; status `failed`, `Exit code 1`.
const COMPOUND = 'cd /repo; npx tsc --noEmit && echo TSC_OK; npx vite build >/dev/null 2>&1 && echo BUILT; npm test 2>&1 | grep -E "^# (pass|fail)"; '
  + 'PW_WORKERS=2 npx playwright test tests/a.spec.ts 2>&1 | tail -2; (cd src-tauri && cargo test --lib tool_ 2>&1 | grep "test result"; cargo clippy --lib --tests 2>&1 | grep -cE "^(warning|error)")';
const COMPOUND_OUT = 'Exit code 1\nTSC_OK\nBUILT\n# pass 502\n# fail 0\n\n  16 passed (1.8m)\ntest result: ok. 80 passed; 0 failed; 0 ignored; 0 measured; 2204 filtered out; finished in 7.39s\n0';

test('a Claude failure gets the Codex card header: an `exit N` pill and no `Exit code N` line', () => {
  for (const output of ['Exit code 2\nboom', 'boom\nExit code 2']) {
    const card = toolPreview(bash('make build', output));
    assert.match(card, />exit 2</, output);
    assert.doesNotMatch(plain(card), /Exit code/, output);
    assert.equal(plain(card), plain(toolPreview(codex('make build', 'Exit code: 2\nWall time: 1 seconds\nOutput:\nboom', 'failed'))));
  }
});

test('a compound whose closing grep -c counted 0 exited 1 by answering, not failing', () => {
  const record = bash(COMPOUND, COMPOUND_OUT);
  assert.equal(toolFailed(record), false);
  assert.equal(describeTool(record).exit, undefined);
});

test('a failed compound whose tests passed shows the exit badge and counts as failed', () => {
  // Its closing count found 3 warnings, so the 1 is the check's failure.
  const record = bash(COMPOUND, COMPOUND_OUT.replace(/0$/, '3'));
  const trace = describeTool(record);
  assert.equal(trace.exit, 1);
  assert.equal(trace.verb, 'Ran tests');
  assert.ok(toolFailed(record));
  assert.equal(summarizeTools([record]), "Couldn't run tests");
  assert.equal(summarizeTools([record, tool('Read', { file_path: '/repo/a.ts' })]), 'Read 1 file · 1 failed');
  // The chip names the runner whose summary the card shows.
  const card = toolPreview(record);
  const runner = /tool-test-runner">([^<]+)</.exec(card)?.[1];
  assert.equal(runner, 'cargo');
  assert.match(trace.chip?.label ?? '', /^cargo\b/);
  assert.match(row(trace), /exit 1$/);
});

test('a search that found nothing is drawn as finished, not failed', () => {
  const html = renderToolActivity({ id: 's', ...bash('rg "zzzNeverThere" src', 'Exit code 1') }, 'k');
  assert.match(html, /data-tool-status="completed"/);
  assert.doesNotMatch(html, /data-tool-failed/);
  assert.match(renderToolActivity({ id: 'f', ...bash('make', 'Exit code 2\nboom') }, 'k'), /data-tool-status="failed" [^>]*data-tool-failed/);
});

// --- 9. Summary wording ------------------------------------------------------------------------

test('test runs and simulator use read without a count of 1', () => {
  const tests = tool('Bash', { command: 'npm test' });
  assert.equal(summarizeTools([tests]), 'Ran tests');
  assert.equal(summarizeTools([tests, tests, tests]), 'Ran tests 3 times');
  const sim = tool('mcp__pandacode_architect__pandacode_simulator_control', { action: 'tap', x: 1, y: 2 });
  assert.equal(summarizeTools([sim]), 'Used the simulator');
  assert.equal(summarizeTools([tests, sim, sim]), 'Ran tests and used the simulator twice');
});

test('a group that failed throughout says it once', () => {
  assert.equal(summarizeTools([bash('python x.py', 'Exit code 1\nx')]), "Couldn't run 1 command");
  assert.equal(summarizeTools([bash('python x.py', 'Exit code 1\nx'), bash('ls', '', 'completed')]), 'Ran 1 command · 1 failed');
  // Tests that ran and failed did run: the sentence says so and the tally says they failed (the row reads `Tests failed`).
  assert.equal(summarizeTools([bash('npm test', 'Exit code 1\nnot ok 1')]), 'Ran tests · 1 failed');
});

test('a write keeps its line count apart, and a worker report reads as a possessive', () => {
  const write = describeTool(tool('Write', { file_path: '/repo/src/a.ts', content: 'a\nb' }));
  assert.equal(row(write), 'Wrote a.ts · 2 lines');
  const report = describeTool(tool('mcp__pandacode_architect__pandacode_read_worker', { workerId: '2118342a-5ee0-4ea8-bf02-5783aafa915b' }, { output: '{}' }));
  assert.equal(row(report), "Read worker 2118342a's report");
});

// --- 10. Produced thumbnails -------------------------------------------------------------------

test('a produced image the sentence does not name sits after the sentence, before the badges', () => {
  const trace = { kind: 'shell', verb: 'Ran', object: 'make shots', mono: true, produced: '/tmp/out/shot.png', exit: 1, then: true };
  const html = traceRowHtml(trace);
  assert.ok(html.indexOf('tool-trace-produced') > html.indexOf('tool-trace-object'), html);
  assert.ok(html.indexOf('tool-trace-produced') < html.indexOf('tool-trace-badge'), html);
  const named = traceRowHtml({ kind: 'shell', verb: 'Captured screenshot', object: '', chip: { icon: 'image', label: 'shot.png', title: 'x' }, more: '+1 more command', produced: '/tmp/shot.png' });
  assert.ok(named.indexOf('tool-trace-produced is-compact') < named.indexOf('tool-trace-chip'), named);
  assert.ok(named.indexOf('tool-trace-produced') < named.indexOf('tool-trace-more-steps'), named);
});

// --- Denials, failed edits, commands that never started, the failing stage ----------------------

const DENIED = 'Permission to use Bash with command rm -rf old-site has been denied.';
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

test('a permission denial is refused, not failed: `Denied: rm -rf old-site`, quiet and tallied as denied', () => {
  for (const output of [DENIED, REJECTED, `<tool_use_error>${DENIED}</tool_use_error>`, 'User refused permission to run this command.', 'User rejected the tool call.']) {
    const call = bash('rm -rf old-site', output);
    const trace = describeTool(call);
    assert.equal(row(trace), 'Denied: rm -rf old-site', output);
    assert.equal(trace.blocked, true);
    assert.equal(summarizeTools([call]), 'Denied 1 call');
    assert.match(summarizeTools([call, bash('git status', 'ok', 'completed')]), /^Ran 1 command · 1 denied$/);
    assert.match(renderToolActivity({ id: 'd', ...call }, 'k'), /data-tool-blocked/);
    assert.doesNotMatch(renderToolActivity({ id: 'd', ...call }, 'k'), /data-tool-failed/);
  }
  // A token another service rejected is a real failure, not the user saying no.
  const search = tool('web_search', { query: 'x' }, { status: 'failed', output: 'Search failed: Stored token for "kimi-code" was rejected; re-login required.' });
  assert.notEqual(describeTool(search).blocked, true);
});

test('a failed edit shows no delta and reads `Couldn\'t edit a.ts`', () => {
  const edit = tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b\nc' }, { status: 'failed', output: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' });
  const trace = describeTool(edit);
  assert.equal(row(trace), "Couldn't edit a.ts · file has not been read yet");
  assert.equal(trace.added, undefined);
  const disk = tool('Edit', { file_path: '/r/kimi_models.rs', old_string: 'a', new_string: 'b' }, { status: 'failed', output: "ENOSPC: no space left on device, open '/r/kimi_models.rs.tmp.3884.3b7fb64ed2c7'" });
  assert.equal(row(describeTool(disk)), "Couldn't edit kimi_models.rs · no space left on device");
});

test('a command that never started reads `Couldn\'t run …`, never what it would have done', () => {
  assert.equal(row(describeTool(bash('cat a.txt', ''))), "Couldn't run cat a.txt");
  assert.equal(row(describeTool(bash('cat a.txt', "ENOSPC: no space left on device, open '/private/tmp/claude-501/tasks/b8ppubumd.output'"))), "Couldn't run cat a.txt");
  assert.equal(row(describeTool(bash('npm run build && npm test', 'No space left on device'))), "Couldn't run npm run build && npm test");
  // The shell could not find its program: nothing started.
  assert.equal(row(describeTool(bash('foo --bar', 'Exit code 127\n(eval):1: command not found: foo'))), "Couldn't start foo");
  // A read that ran and failed still says so.
  assert.equal(row(describeTool(bash('cat nope.txt', 'Exit code 1\ncat: nope.txt: No such file or directory'))), "Couldn't read nope.txt");
});

test('a failed compound names the stage its output blames, and says tests only when a runner printed', () => {
  const build = bash('npm run build && npm test', 'Exit code 1\n> app@1.0.0 build\n> tsc && vite build\n\nsrc/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n');
  assert.equal(describeTool(build).verb, 'Build failed');
  assert.match(row(describeTool(build)), /^Build failed .*1 error/);
  assert.equal(describeTool(bash('npm run build && npm test', 'Exit code 1\nnpm ERR! code ELIFECYCLE\nbuild failed')).verb, 'Build failed');
  assert.equal(describeTool(bash('npx tsc --noEmit && npm test', 'Exit code 2\nsrc/a.ts(1,7): error TS2322: x\n')).verb, 'Typecheck failed');
  assert.equal(describeTool(bash('npx eslint . && npm test', 'Exit code 1\n✖ 3 problems (3 errors, 0 warnings)\n')).verb, 'Lint found problems');
  assert.equal(describeTool(bash('npm ci && npm test', 'Exit code 1\nsomething odd happened')).verb, "Couldn't run tests");
  // A runner that printed keeps the test label.
  assert.equal(describeTool(bash('npm run build && npm test', 'Exit code 1\n> vitest run\n\n RUN  v3.2.7 /r\n\n ❯ src/model.test.ts (8 tests | 2 failed) 9ms\n')).verb, 'Tests failed');
  assert.equal(describeTool(bash('npm test', 'Exit code 1\nError: something broke in setup\n    at main (a.js:1:1)\n')).verb, 'Tests failed');
});

// --- Piped checks, diffs in terminals, refusals, image reads, summary wording ------------------
// Shapes from real records: a piped run exits 0 (the pipe's last stage) while its output shows the failure.

const PW_PIPED = 'tests/tmp-r24-dividers.spec.ts:3:3 › dividers 1200 dark forced\n1200 dark forced 0px|1px\n  3 failed\n    tests/tmp-r24-dividers.spec.ts:3:3 › dividers 820 light plain ──────\n    tests/tmp-r24-dividers.spec.ts:3:3 › dividers 820 light contrast ──────\n    tests/tmp-r24-dividers.spec.ts:3:3 › dividers 820 light forced ──────\n  9 passed (1.5m)';

test('a piped test run that exited 0 but printed failures reads `Tests failed`, red and counted, with no exit badge', () => {
  const pw = bash('cd /r; PW_PORT=1561 npx playwright test -c tmp-r24.config.ts --reporter=line 2>&1 | grep -v "^\\s*$" | tail -20', PW_PIPED, 'completed');
  const trace = describeTool(pw);
  assert.equal(trace.verb, 'Tests failed');
  assert.equal(trace.exit, undefined);
  assert.equal(row(trace), 'Tests failed playwright · 3 of 12 tests');
  assert.equal(toolFailed(pw), true);
  assert.match(renderToolActivity({ id: 'p', ...pw }, 'k'), /data-tool-failed/);
  assert.doesNotMatch(traceRowHtml(trace), /exit 0|then failed/);
  const node = bash('npm test 2>&1 | tail -8', 'not ok 5 - auto-detect on a model\n# pass 4\n# fail 1', 'completed');
  assert.equal(row(describeTool(node)), 'Tests failed npm test · 1 of 5 tests');
  const cargo = bash('cargo test 2>&1 | grep "test result"', 'test result: FAILED. 10 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.52s', 'completed');
  assert.equal(row(describeTool(cargo)), 'Tests failed cargo test · 2 of 12 tests');
  const codexRun = codex('npx playwright test | tail -3', 'Exit code: 0\nWall time: 3.1 seconds\nOutput:\n  1 failed\n  4 passed (3.0s)');
  assert.equal(row(describeTool(codexRun)), 'Tests failed playwright · 1 of 5 tests');
  assert.equal(toolFailed(codexRun), true);
  const ls = bash('ls src', 'a.ts', 'completed');
  assert.equal(summarizeTools([pw, ls]), 'Ran tests and 1 other command · 1 failed');
});

test('a piped typecheck that printed errors reads `Typecheck failed tsc · N errors`; passing pipes stay as they were', () => {
  const tsc = bash('npx tsc --noEmit 2>&1 | head -5', "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(2,1): error TS2304: Cannot find name 'x'.", 'completed');
  assert.equal(row(describeTool(tsc)), 'Typecheck failed tsc · 2 errors');
  assert.equal(toolFailed(tsc), true);
  const passed = bash('node --test tests/ssh-hosts.test.mjs 2>&1 | tail -8', '# tests 29\n# pass 29\n# fail 0', 'completed');
  assert.equal(describeTool(passed).verb, 'Ran tests');
  assert.equal(toolFailed(passed), false);
  assert.equal(describeTool(bash('npx tsc --noEmit | head', '', 'completed')).verb, 'Typechecked');
});

const DIFF_OUT = 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n tail\n';

test('`git diff` and `git show` output opens in the coloured diff card, not plain terminal text', () => {
  for (const command of ['git diff src/a.ts', 'git show HEAD -- src/a.ts', 'git diff --cached | head -40']) {
    const card = toolPreview(bash(command, DIFF_OUT, 'completed'));
    assert.match(card, /class="tc-diff-file"/, command);
    assert.match(card, /data-sign="add"[^]*new line/, command);
    assert.match(card, /data-sign="del"[^]*old line/, command);
    assert.match(card, /class="tc-command">/, command);
  }
  // Text that is no diff keeps the terminal.
  assert.doesNotMatch(toolPreview(bash('git diff --stat', ' src/a.ts | 2 +-\n 1 file changed', 'completed')), /tc-diff-file/);
});

const PERSISTED = '<persisted-output>\nOutput too large (29.9KB). Full output saved to: /Users/me/.claude/projects/p/tool-results/b1.txt\n\nPreview (first 2KB):\nfirst line\nsecond line\n</persisted-output>';

test('harness wrappers like `<persisted-output>` never reach a card', () => {
  for (const call of [bash('cat big.log', PERSISTED, 'completed'), tool('Read', { file_path: '/r/big.log' }, { output: PERSISTED }), tool('Grep', { pattern: 'x' }, { output: PERSISTED })]) {
    const card = toolPreview(call);
    assert.doesNotMatch(card, /persisted-output|Output too large|Preview \(first/, call.name);
    assert.match(card, /first line/, call.name);
  }
});

const BLOCKED_25 = "<tool_use_error>Blocked: sleep 25 followed by: cat /private/tmp/t/b0kjp5z3w.output tail -3 cut -c1-150 cd /Users/me/videos python3 -c \"\nimport json\nprint(1)\". To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.</tool_use_error>";

test('refused rows name the refused command and never claim it ran', () => {
  const blockedRun = bash("sleep 25; cat /private/tmp/t/b0kjp5z3w.output | tail -3 | cut -c1-150; cd /Users/me/videos && python3 -c \"\nimport json\nprint(1)\"", BLOCKED_25);
  const trace = describeTool(blockedRun);
  assert.equal(row(trace), 'Blocked: sleep 25 +3 more commands');
  assert.equal(trace.exit, undefined);
  assert.doesNotMatch(traceRowHtml(trace), /then failed|after \d|exit \d/);
  const denied = bash('npm install left-pad', 'Permission to use Bash with command npm install left-pad has been denied.');
  assert.equal(row(describeTool(denied)), 'Denied: npm install left-pad');
  assert.equal(describeTool(denied).mono, true);
  const compound = bash('npm install && npm run build', "The user doesn't want to proceed with this tool use. The tool use was rejected.");
  assert.equal(row(describeTool(compound)), 'Denied: npm install +1 more command');
  const exited = bash('git push --force', 'Exit code 1\nUser rejected the tool call.');
  assert.doesNotMatch(traceRowHtml(describeTool(exited)), /exit 1|then failed/);
});

test('a lone kind of stop tallies by name (`· 1 denied`); blocked and denied together read `· 2 stopped`', () => {
  const blockedRun = bash('sleep 60; cat a.txt', BLOCKED_OUTPUT);
  const denied = bash('rm -rf old-site', DENIED);
  const ls = bash('ls src', 'a.ts', 'completed');
  assert.equal(summarizeTools([ls, denied]), 'Ran 1 command · 1 denied');
  assert.equal(summarizeTools([ls, blockedRun, denied]), 'Ran 1 command · 2 stopped');
  assert.equal(summarizeTools([denied, denied]), 'Denied 2 calls');
  assert.equal(summarizeTools([blockedRun, denied]), 'Blocked 1 call · 1 denied');
  const html = renderToolGroup([{ key: 'a', content: { id: 'a', ...ls } }, { key: 'b', content: { id: 'b', ...denied } }]);
  assert.match(html, /tool-group-status is-blocked"> · 1 denied/);
});

test('a `read_image` call (DeepSeek, OpenCode) reads as a viewed image with its thumbnail and size', () => {
  const real = tool('read_image', { file_path: '/r/shots/redirect.png' }, { output: '<path>/r/shots/redirect.png</path>\n<type>image</type>\n<content>\nimage/png image, 1280x775 px, 80361 bytes\n</content>\n[Non-text content omitted]' });
  const trace = describeTool(real);
  assert.deepEqual([trace.kind, trace.image, trace.object], ['image', '/r/shots/redirect.png', '1280 × 775']);
  const short = describeTool(tool('read_image', { path: '/r/a.png' }, { output: 'image/png 1280x775' }));
  assert.deepEqual([short.kind, short.image, short.object], ['image', '/r/a.png', '1280 × 775']);
});

test('summaries keep a test run\'s own phrase beside other commands', () => {
  const t = bash('npm test', '# pass 3\n# fail 0', 'completed');
  const others = ['ls', 'git status', 'pwd'].map(command => bash(command, 'x', 'completed'));
  assert.equal(summarizeTools([t, t, ...others]), 'Ran tests twice and 3 other commands');
  assert.equal(summarizeTools([t, others[0]]), 'Ran tests and 1 other command');
  assert.equal(summarizeTools([t, t]), 'Ran tests twice');
});

test('package installs read `Installed packages [npm]`; verbs never repeat in the chip', () => {
  const install = describeTool(bash('npm install', '', 'completed'));
  assert.deepEqual([install.verb, install.chip?.label], ['Installed packages', 'npm']);
  assert.equal(summarizeTools([bash('npm install', '', 'completed')]), 'Installed packages');
  assert.equal(row(describeTool(bash('npm install react zod', '', 'completed'))), 'Installed npm react +1 more package');
  assert.equal(row(describeTool(bash('git diff', '', 'completed'))), 'Diffed the working tree');
  assert.equal(row(describeTool(bash('git diff main...HEAD', '', 'completed'))), 'Diffed main...HEAD');
  assert.equal(row(describeTool(bash('gh pr view 12', '', 'completed'))), 'Viewed PR #12');
  assert.equal(row(describeTool(bash('gh run watch 123456', '', 'completed'))), 'Watched run #123456');
});

test('every `+N` has a noun and one ` · ` separates counts', () => {
  assert.equal(row(describeTool(tool('ToolSearch', { query: 'select:A,B,C,D,E' }))), 'Loaded tools A B C +2 more tools');
  const searched = describeTool(bash('grep -rn "BEGIN OPENSSH" src-tauri/src/ssh_hosts/ src/ssh-host*.ts src/preview.ts tests/ssh-hosts* docs/a.md', '', 'completed'));
  assert.match(searched.object, /\+4 more paths$/);
  const hidden = summarizeTools([tool('Read', { file_path: '/a' }), tool('Edit', { file_path: '/b', old_string: 'a', new_string: 'b' }), tool('Write', { file_path: '/c', content: 'x' }), tool('WebFetch', { url: 'https://x.dev' })]);
  // A single leftover step is named, never folded into a `+1 more step` tail.
  assert.equal(hidden, 'Read 1 file, edited 1 file, wrote 1 file and fetched 1 page');
  assert.equal(row(describeTool(tool('Write', {}))), 'Wrote a file');
  assert.equal(row(describeTool(tool('Write', ''))), 'Wrote a file');
});

test('a failed compound reads the same everywhere: its lead verb and an exit badge', () => {
  const trace = describeTool(bash("sed -n '1,2p' a.ts; ls nope", 'ls: nope: No such file or directory'));
  assert.equal(trace.verb, 'Read');
  assert.match(traceRowHtml(trace), /tool-trace-badge is-failed"[^>]*>failed<\/span>$/);
});

test('a produced image the sentence does not name comes before `+N more`, without repeating its path', () => {
  const html = traceRowHtml({ kind: 'shell', verb: 'Ran', object: 'make shots', mono: true, more: '+1 more command', produced: '/tmp/out/shot.png' });
  assert.ok(html.indexOf('tool-trace-produced') < html.indexOf('tool-trace-more-steps'), html);
  const named = traceRowHtml({ kind: 'shell', verb: 'Wrote', object: '/tmp/out/shot.png', mono: true, produced: '/tmp/out/shot.png' });
  assert.equal((plain(named).match(/shot\.png/g) ?? []).length, 1, named);
});

test('search patterns show exactly as searched, only their wrapper quotes curl', () => {
  assert.equal(describeTool(bash("grep -rn 'HostKeyUnknown|\"hostKeyUnknown\"' src", '', 'completed')).object, 'for “HostKeyUnknown|"hostKeyUnknown"” in');
  assert.equal(describeTool(bash('rg -n "foo" src', '', 'completed')).object, 'for “foo” in');
  // The place is a chip after the phrase, like Grep's.
  assert.equal(describeTool(bash('rg -n "foo" src', '', 'completed')).chip?.label, 'src');
  // Code stays as written.
  const mono = describeTool(bash('node -e "console.log(\\"hi\\")"', '', 'completed'));
  assert.doesNotMatch(mono.object, /[“”]/);
});

test('Devin `Failed to call X from S` is that MCP call failing; Kimi `Searching: q` is a web search', () => {
  const devin = tool('Failed to call send_message from slack', { channel: 'C1', text: 'hi' }, { status: 'failed', output: "Failed to connect to MCP server 'slack'. Please try again." });
  const trace = describeTool(devin);
  assert.equal(trace.kind, 'mcp');
  assert.match(row(trace), /^Couldn't use Slack send message$/);
  const kimi = tool('Searching: VIA macro SS_DELAY_CODE encode delay buf…', { query: 'VIA macro SS_DELAY_CODE encode delay buffer' }, { status: 'failed', output: 'Search failed: Stored token for "kimi-code" was rejected; re-login required.' });
  const web = describeTool(kimi);
  assert.equal(web.kind, 'web');
  assert.equal(row(web), "Couldn't search the web for “VIA macro SS_DELAY_CODE encode delay buffer”");
});

test('a command stopped by a signal (exit 143/137) reads `Stopped … (terminated)`, neutral', () => {
  const vite = codex('npx vite --config web/vite.config.ts --port 5439', 'Exit code: 143\n\n  VITE v8.3.6  ready in 343 ms\n', 'failed');
  const trace = describeTool(vite);
  assert.equal(row(trace), 'Stopped vite (terminated)');
  assert.equal(toolFailed(vite), false);
  assert.equal(row(describeTool(bash('node server.mjs', 'Exit code 137\nlistening on 3000'))), 'Stopped server.mjs (killed)');
  // A timeout is still a failure.
  assert.equal(toolFailed(bash('sleep 900', 'Exit code 143\nCommand timed out after 10m 0s')), true);
});

test('a group of failed test runs says the tests ran, then tallies the failure', () => {
  const run = bash('npm test 2>&1 | tail -3', '# pass 4\n# fail 1', 'completed');
  assert.equal(summarizeTools([run]), 'Ran tests · 1 failed');
  assert.equal(summarizeTools([bash('git push', 'Exit code 1\nrejected')]), "Couldn't run 1 command");
});

test('a chip that moves its object in never carries the object\'s separator; a stopped server\'s card is neutral', () => {
  assert.equal(describeTool(bash('git diff src/tool-text.ts', '', 'completed')).chip?.label, 'tool-text.ts');
  const card = toolPreview(codex('node server.mjs', 'Exit code: 143\nlistening on 3000\n', 'failed'));
  assert.match(card, /class="tool-trace-badge is-quiet">exit 143</);
  assert.doesNotMatch(card, /tc-term is-failed|is-failed/);
});

// --- 9. Interruptions, unstarted commands, failed edits and refusals say what happened -----------
// Shapes copied from kingcode.sqlite3: PandaCode appends its own marker when a turn ends before a tool reported.

const INTERRUPTED = '\n\n[PandaCode was interrupted before this tool reported a result.]';
const TURN_ENDED = '\n\n[The turn ended before this tool reported a result.]';
const USER_INTERRUPT = '[Request interrupted by user for tool use]';

test('an interrupted call is quiet, not failed: `Interrupted: [npm] test`, tallied as `· N interrupted`', () => {
  const npm = bash('npm test', INTERRUPTED);
  const trace = describeTool(npm);
  assert.equal(row(trace), 'Interrupted: npm test');
  assert.equal(trace.chip?.label, 'npm');
  assert.equal(trace.object, 'test');
  assert.equal(trace.quiet, true);
  assert.equal(trace.interrupted, true);
  assert.equal(trace.exit, undefined);
  assert.equal(toolFailed(npm), false);
  const push = bash('git push --force', USER_INTERRUPT);
  assert.equal(row(describeTool(push)), 'Interrupted: git push --force');
  assert.equal(toolFailed(push), false);
  // Output printed before the marker (a dev server) still reads as interrupted.
  const vite = tool('bash', { command: 'npx vite --port 1653' }, { status: 'failed', output: '\n  VITE v7.3.6  ready in 272 ms\n' + INTERRUPTED });
  assert.match(row(describeTool(vite)), /^Interrupted: npx vite/);
  for (const output of [TURN_ENDED]) assert.equal(toolFailed(bash('cargo build', output)), false);
  const html = renderToolActivity({ id: 'i', ...npm }, 'k');
  assert.match(html, /data-tool-interrupted/);
  assert.doesNotMatch(html, /data-tool-failed|is-failed/);
  const ls = bash('ls src', 'a.ts', 'completed');
  // An interrupted call never got done: only its tally says it.
  assert.equal(summarizeTools([ls, npm]), 'Ran 1 command · 1 interrupted');
  assert.equal(summarizeTools([npm, push]), 'Interrupted 2 calls');
  assert.match(renderToolGroup([{ key: 'a', content: { id: 'a', ...ls } }, { key: 'b', content: { id: 'b', ...npm } }]), /tool-group-status is-blocked"> · 1 interrupted/);
});

test('interrupted non-shell calls read `Interrupted: write a.ts`, and the card says it never reported', () => {
  const write = tool('Write', { file_path: '/r/a.ts', content: 'x' }, { status: 'failed', output: TURN_ENDED });
  assert.equal(row(describeTool(write)), 'Interrupted: write a.ts · 1 line');
  const card = toolPreview(bash('npm test', INTERRUPTED));
  assert.match(card, /tool-trace-note is-interrupted">Interrupted before it reported a result\.</);
  assert.doesNotMatch(card, /PandaCode was interrupted|is-failed/);
});

const UNIFIED_EXEC = 'Exit code: -1\nFailed to create unified exec process: No such file or directory (os error 2)';
const NOT_STARTED = "The command was not started: this computer's disk is full (ENOSPC), so the file that captures command output could not be created. Nothing ran. If this is the user's own computer, tell them before deleting anything to make room.";

test('a command the harness never started reads `Couldn\'t start [program] …` with the intent\'s chip', () => {
  const cat = tool('Command', "/bin/zsh -lc 'cat src-tauri/src/subagent_state.rs'\nWorking directory: /repo", { status: 'failed', output: UNIFIED_EXEC });
  const trace = describeTool(cat);
  // A lone read says what it could not do.
  assert.equal(row(trace), "Couldn't read subagent_state.rs");
  assert.equal(trace.chip?.label, 'subagent_state.rs');
  assert.match(toolPreview(cat), /tool-trace-note is-error">Failed to create unified exec process/);
  assert.equal(trace.exit, undefined);
  const compound = tool('Command', `/bin/zsh -lc "sed -n '1,120p' src/a.rs && rg -n 'x' src/a.rs"\nWorking directory: /repo`, { status: 'failed', output: UNIFIED_EXEC });
  assert.equal(row(describeTool(compound)), "Couldn't start sed -n '1,120p' src/a.rs +1 more command");
  const build = bash('npm run build', NOT_STARTED);
  assert.equal(row(describeTool(build)), "Couldn't start npm run build · disk is full");
  assert.match(toolPreview(build), /tool-trace-note is-error">The command was not started: this computer&#39;s disk is full/);
});

test('a failed edit or write says why in its row and above its intended diff', () => {
  const cases = [
    ['<tool_use_error>String to replace not found in file.\nString: const a = 1;</tool_use_error>', 'string to replace not found'],
    ["ENOSPC: no space left on device, open '/r/design.tsx.tmp.3884.3b7fb64ed2c7'", 'no space left on device'],
    ['<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', 'file has not been read yet'],
    ['<tool_use_error>Found 2 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true.</tool_use_error>', '2 matches of the string to replace'],
    ['<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>', 'file changed since it was read'],
    ["Tool 'edit' validation failed: String not found in file. The old_string was not found in '/r/design.tsx'", 'string to replace not found'],
  ];
  for (const [output, reason] of cases) {
    const edit = tool('Edit', { file_path: '/r/design.tsx', old_string: 'const a = 1;', new_string: 'const a = 2;' }, { status: 'failed', output });
    const trace = describeTool(edit);
    assert.equal(row(trace), `Couldn't edit design.tsx · ${reason}`, output);
    assert.equal(trace.reason, reason);
    assert.equal(trace.added, undefined);
  }
  const edit = tool('Edit', { file_path: '/r/design.tsx', old_string: 'const a = 1;', new_string: 'const a = 2;' }, { status: 'failed', output: '<tool_use_error>String to replace not found in file.\nString: const a = 1;</tool_use_error>' });
  assert.match(traceRowHtml(describeTool(edit)), /<span class="tool-trace-reason">· string to replace not found<\/span>/);
  const card = toolPreview(edit);
  // The row already says why, so the card shows only the change it meant to make.
  assert.doesNotMatch(card, /tool-trace-why/);
  assert.match(card, /const a = 2;/);
  assert.doesNotMatch(card, /tool_use_error/);
  const write = tool('Write', { file_path: '/r/a.ts', content: 'x' }, { status: 'failed', output: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' });
  assert.equal(row(describeTool(write)), "Couldn't write a.ts · 1 line · file has not been read yet");
});

test('refused shell rows chip their program like other shell rows and draw in the warning tone', () => {
  const denied = bash('npm install left-pad', 'Permission to use Bash with command npm install left-pad has been denied.');
  const trace = describeTool(denied);
  assert.deepEqual([trace.verb, trace.chip?.label, trace.object, trace.mono], ['Denied:', 'npm', 'install left-pad', true]);
  assert.equal(describeTool(bash('sleep 60; cat a.txt', BLOCKED_OUTPUT)).chip?.label, 'sleep');
  assert.equal(row(describeTool(bash('sleep 60; cat a.txt', BLOCKED_OUTPUT))), 'Blocked: sleep 60 +1 more command');
});

test('a refusal card strips harness boilerplate and shows a one-line reason', () => {
  const card = toolPreview(bash('rm -rf old-site', REJECTED));
  assert.match(card, /tool-trace-note is-blocked">The user doesn&#39;t want to proceed with this tool use\.<\/p>/);
  assert.doesNotMatch(card, /STOP what you are doing|new_string was NOT written/);
  const blockedCard = toolPreview(bash('sleep 60; cat a.txt', BLOCKED_25));
  assert.match(blockedCard, /tool-trace-note is-blocked">To wait for a condition, use Monitor with an until-loop \(e\.g\. `until &lt;check&gt;; do sleep 2; done`\)\.<\/p>/);
  assert.doesNotMatch(blockedCard, /run_in_background|Do not chain/);
  assert.match(toolPreview(bash('rm -rf old-site', DENIED)), /tool-trace-note is-blocked">Permission to use Bash was denied\.<\/p>/);
});

test('a Devin `Edit file` cut before its new text still shows the edited region in a diff card', () => {
  const before = Array.from({ length: 40 }, (_, n) => `const line${n} = ${n};`).join('\n');
  const cut = tool('Edit file', `/r/src/main.ts\n--- Before\n${before}\n[Preview truncated]`);
  const trace = describeTool(cut);
  assert.equal(row(trace), 'Edited main.ts');
  assert.equal(trace.added, undefined);
  const card = toolPreview(cut);
  assert.match(card, /tc-diff/);
  assert.match(card, /const line0 = 0;/);
  const whole = tool('Edit file', '/r/a.py\n--- Before\nA = 1\n\n+++ After\nA = 1\n\ndef f():\n    return A\n');
  assert.deepEqual([describeTool(whole).added, describeTool(whole).removed], [3, 0]);
  assert.match(toolPreview(whole), /data-sign="add"/);
});

// --- A failing check anywhere in a compound leads ----------------------------------------------------------------

test('a typecheck or test that failed leads its compound even when it is not first, and says so through `check`', () => {
  const tsc = describeShell('ln -s a b && npx tsc --noEmit 2>&1 | head', "src/a.ts(3,1): error TS2345: Argument of type 'x'");
  assert.equal(tsc.verb, 'Typechecked');
  assert.deepEqual(tsc.check, { kind: 'typecheck', failed: true });
  const rust = describeShell('cd src-tauri && cargo fmt && cargo check 2>&1 | tail', 'error[E0308]: mismatched types\n --> src/a.rs:1:5');
  assert.equal(rust.verb, 'Typechecked');
  assert.equal(rust.check?.failed, true);
  const tests = describeShell('npx tsc --noEmit && node --test tests/a.test.mjs | tail -5', '# tests 3\n# pass 2\n# fail 1');
  assert.equal(tests.kind, 'test');
  assert.deepEqual(tests.check, { kind: 'test', failed: true });
  // Nothing failed: the first real step leads as before, and the check (if any) has not failed.
  const clean = describeShell('ln -s a b && npx tsc --noEmit', '');
  assert.equal(clean.verb, 'Symlinked');
  assert.notEqual(clean.check?.failed, true);
  // A dangerous step still leads over a failing check.
  assert.equal(describeShell('rm -rf ~/x; npx tsc --noEmit', 'a.ts(1,1): error TS1: x').verb, 'Deleted');
  assert.equal(describeShell('rm -rf ~/x; npx tsc --noEmit', 'a.ts(1,1): error TS1: x').check, undefined);
  const row = plain(traceRowHtml(describeTool(bash('ln -s a b && npx tsc --noEmit 2>&1 | head', "src/a.ts(3,1): error TS2345: x\nsrc/b.ts(1,1): error TS2322: y", 'completed'))));
  assert.match(row, /^Typecheck failed tsc · 2 errors/);
});

test('a test run piped to tail keeps the runner named in the command as its chip', () => {
  assert.equal(describeShell('npm test 2>&1 | tail -5', '# tests 3\n# pass 3\n# fail 0').label, 'npm test');
});

// --- A pipe's exit 0 hides a failure the output prints (real completed records, kingcode.sqlite3) ----------------

test('a completed build piped to tail that printed its failure reads `Build failed`', () => {
  const vite = describeTool(bash('npm run build 2>&1 | tail -5', 'vite v7.1.2 building for production...\nerror during build:\n[vite]: Rollup failed to resolve import "x" from "src/a.ts".', 'completed'));
  assert.equal(vite.verb, 'Build failed');
  const cargo = describeTool(bash('cd src-tauri && cargo build 2>&1 | tail -3', 'error[E0425]: cannot find value `x` in this scope\n --> src/a.rs:1:5\nerror: could not compile `pandacode` (lib) due to 2 previous errors', 'completed'));
  assert.equal(cargo.verb, 'Build failed');
  assert.match(cargo.object, /2 errors/);
  assert.equal(toolFailed(bash('npm run build 2>&1 | tail -5', 'error during build:\nx', 'completed')), true);
  // A build that passed stays `Built`.
  assert.equal(describeTool(bash('npm run build 2>&1 | tail -2', 'dist/index.html  0.4 kB\n✓ built in 1.2s', 'completed')).verb, 'Built');
});

test('a completed test run whose output says tests failed reads `Tests failed`', () => {
  const mocha = describeTool(bash('npx mocha 2>&1 | tail -4', '  5 passing (2s)\n  2 failing\n\n  1) a\n', 'completed'));
  assert.equal(mocha.verb, 'Tests failed');
  assert.match(mocha.object, /2 of 7 tests/);
  // node:test printed a clean summary first, Playwright's failures came after it.
  const both = describeTool(bash('npm test; npx playwright test 2>&1 | tail -6', '# pass 178\n# fail 0\n  1 failed\n    tests/ui.spec.ts:1165:1 › finds projects\n  192 passed (4.8m)', 'completed'));
  assert.equal(both.verb, 'Tests failed');
  assert.doesNotMatch(both.object, /178 passed/);
  const vitest = describeTool(bash('(npx vitest run 2>&1 | tail -4)', ' FAIL  server/a.test.ts > reports both errors\n Test Files  7 failed | 29 passed (36)', 'completed'));
  assert.equal(vitest.verb, 'Tests failed');
  // Tests that never compiled: the build failed, named by the runner's step.
  const compile = describeTool(bash('cd src-tauri && cargo test --lib remote 2>&1 | tail -3', 'error[E0716]: temporary value dropped while borrowed\n   --> src/remote.rs:272:21\nerror: could not compile `pandacode` (lib test) due to 2 previous errors', 'completed'));
  assert.equal(row(compile), 'Build failed cargo test remote · 2 errors');
  assert.equal(toolFailed(bash('npx mocha | tail -2', '  5 passing\n  2 failing', 'completed')), true);
  assert.equal(describeTool(bash('npx mocha | tail -2', '  7 passing (2s)', 'completed')).verb, 'Ran tests');
});

// --- A command whose program the shell could not find never started -------------------------------------------

test('a completed command whose short output says its lead program was not found reads `Couldn\'t start`, a missing wrapper naming what it wraps', () => {
  const timeout = describeTool(bash('timeout 120 lldb -p 29568 --batch -o "detach" 2>&1 | tail -5', '(eval):1: command not found: timeout', 'completed'));
  assert.equal(row(timeout), "Couldn't start timeout (not installed) · lldb");
  assert.equal(toolFailed(bash('timeout 120 lldb -p 1 2>&1 | tail -5', '(eval):1: command not found: timeout', 'completed')), true);
  const claude = describeTool(bash("claude --version; claude --help | grep -iE 'sandbox'", '(eval):1: command not found: claude\n(eval):1: command not found: claude', 'completed'));
  assert.equal(row(claude), "Couldn't start claude");
  assert.equal(row(describeTool(bash('claude -p hi | head', 'zsh: command not found: claude', 'completed'))), "Couldn't start claude");
  assert.equal(row(describeTool(bash('cd /repo && ./x --all | tail -3', 'bash: ./x: No such file or directory', 'completed'))), "Couldn't start x");
  assert.equal(row(describeTool(bash('cd /repo && PW_PORT=1455 timeout 540 npx playwright test 2>&1 | tail', '(eval):1: command not found: timeout', 'completed'))), "Couldn't start timeout (not installed) · playwright");
  // Its card shows the command and the shell's words.
  assert.match(toolPreview(bash('claude -p hi | head', 'zsh: command not found: claude', 'completed')), /command not found: claude/);
  // A failed call that names its missing program reads the same, with no exit badge.
  const failed = describeTool(bash('foo --bar', 'Exit code 127\nzsh: command not found: foo'));
  assert.equal(row(failed), "Couldn't start foo");
});

test('a missing file another program names, or a later step\'s missing program, is no unstarted command', () => {
  assert.equal(describeTool(bash('ls node_modules/ 2>&1 | head -2; rm -f node_modules; ls', 'ls: node_modules/: No such file or directory\nprobe.mjs\nvia_fixture.js', 'completed')).verb, 'Listed');
  assert.notEqual(describeTool(bash("cat > a.mjs <<'EOF'\nrun()\nEOF\ntimeout 5 node a.mjs", '(eval):14: command not found: timeout', 'completed')).verb, "Couldn't start");
  // Output beyond the error: the command ran.
  assert.notEqual(describeTool(bash('timeout 9 node a.mjs | tail', '2\n       5\n(eval):6: command not found: timeout\nmore\nlines', 'completed')).verb, "Couldn't start");
});

// --- grep -c found nothing ----------------------------------------------------------------------------------------

test('a counting grep that exits 1 printing 0 found no matches', () => {
  const claude = describeTool(bash('grep -c foo a.txt', 'Exit code 1\n0'));
  assert.match(row(claude), /no matches$/);
  assert.equal(claude.exit, undefined);
  assert.equal(toolFailed(bash('grep -c foo a.txt', 'Exit code 1\n0')), false);
  assert.equal(toolFailed(codex('grep -c foo a.txt b.txt', 'Exit code: 1\nWall time: 0 seconds\nOutput:\na.txt:0\nb.txt:0\n')), false);
  // A count with an error (exit 2) still failed.
  assert.equal(toolFailed(bash('grep -c foo nope.txt', 'Exit code 2\ngrep: nope.txt: No such file or directory')), true);
});

test('a capture whose output says it failed reads `Couldn\'t capture screenshot`, counts as failed, and shows no thumbnail', () => {
  // Real shape: Claude Code's Bash call exits 0 because `echo` ran last; the output carries the failure.
  const shot = bash('screencapture -x /tmp/full.png; echo sc=$?', 'could not create image from display\nsc=1', 'completed');
  const trace = describeTool(shot);
  assert.match(trace.verb, /^Couldn't capture screenshot/);
  assert.equal(trace.produced, undefined);
  assert.equal(toolFailed(shot), true);
  assert.match(renderToolActivity({ id: 'sc', ...shot }, 'k'), /data-tool-failed/);
  assert.doesNotMatch(traceRowHtml(trace), /tool-trace-produced/);
});
