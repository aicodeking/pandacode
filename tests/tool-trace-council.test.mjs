import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, toolFailed, toolPreview, traceRowHtml } from '../src/tool-trace.ts';

// Council round 15: exit-1 results, Codex web_run, rare harness tools, separators and quoting, wording, cards.
// Input shapes copied from real recorded calls (kingcode.sqlite3), values shortened.
const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input, null, 2), output: '', ...extra });
const bash = (command, output, status = 'failed') => tool('Bash', { command }, { status, output });
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const row = record => plain(traceRowHtml(describeTool(record)));

// --- 1. Exit 1 that is a normal answer -----------------------------------------------------------------------

test('a compound whose last stage is a zero grep -c is not a failure', () => {
  const record = bash('npx tsc && echo OK; npm test | grep x; cargo test | grep -cE y', 'Exit code 1\nOK\n0');
  assert.equal(toolFailed(record), false);
  assert.doesNotMatch(row(record), /^Couldn't|exit 1/);
});

test('diff, cmp and git diff --exit-code/--quiet exit 1 means they differ, not a failure', () => {
  const diff = bash('diff a.txt b.txt', 'Exit code 1\n1c1\n< a\n---\n> b');
  assert.equal(toolFailed(diff), false);
  assert.equal(row(diff), 'Compared a.txt and b.txt · differ');
  const cmp = bash('cmp a.bin b.bin', 'Exit code 1\na.bin b.bin differ: byte 1, line 1');
  assert.equal(toolFailed(cmp), false);
  assert.equal(row(cmp), 'Compared a.bin and b.bin · differ');
  const quiet = bash('git diff --quiet src', 'Exit code 1');
  assert.equal(toolFailed(quiet), false);
  assert.match(row(quiet), /^Diffed .* · changes$/);
  const exitCode = bash('git diff --exit-code', 'Exit code 1\ndiff --git a/x b/x');
  assert.equal(toolFailed(exitCode), false);
  assert.match(row(exitCode), /^Diffed .* · changes$/);
  // Exit 2 is trouble.
  assert.equal(toolFailed(bash('diff a.txt nope', 'Exit code 2\ndiff: nope: No such file or directory')), true);
});

// --- 2. Codex search_service.web_run ------------------------------------------------------------------------

const webRun = input => tool('codex_apps · search_service.web_run', input);

test('Codex web_run reads as a web search, open or click', () => {
  assert.equal(row(webRun({ response_length: 'medium', system2_search_query: [{ q: 'tauri updater' }, { q: 'tauri signing' }] })), 'Searched the web for “tauri updater” +1 more query');
  assert.equal(row(webRun({ open: [{ ref_id: 'https://switchagents.ai' }, { ref_id: 'https://docs.switchagents.ai/rooms' }], response_length: 'short' })), 'Opened switchagents.ai +1 more');
  assert.equal(row(webRun({ click: [{ id: 18, ref_id: 'turn1view1' }, { id: 19, ref_id: 'turn1view1' }, { id: 20, ref_id: 'turn1view1' }, { id: 21, ref_id: 'turn1view1' }] })), 'Followed 4 links');
  assert.equal(row(webRun({ click: [{ id: 57, ref_id: 'turn5view0' }] })), 'Followed 1 link');
  assert.equal(describeTool(webRun({ click: [{ id: 1 }] })).kind, 'web');
});

// --- 3. Rare harness tools ------------------------------------------------------------------------------------

test('rare harness tools say what they did', () => {
  assert.equal(row(tool('Monitor', { command: 'tail -f server.log', description: 'Wait for screenshot runs', timeout_ms: '600000' })), 'Watched tail -f server.log');
  assert.equal(row(tool('SendMessage', { to: 'worker-1', message: 'Allow one fixture line', summary: 'Allow one fixture line in host.rs' })), 'Messaged worker-1 Allow one fixture line in host.rs');
  assert.equal(row(tool('PushNotification', { message: 'Taste demo needs sign-in', status: 'proactive' })), 'Sent notification “Taste demo needs sign-in”');
  assert.equal(row(tool('ScheduleWakeup', { delaySeconds: 300, reason: 'check the batch' })), 'Scheduled wake-up in 5m check the batch');
  assert.equal(row(tool('ListAgents', {})), 'Listed agents');
  assert.equal(row(tool('activate_skill', { name: 'code-review-and-quality', arguments: 'Read-only review' })), 'Loaded skill code-review-and-quality Read-only review');
});

// --- 4. Separators, overflow and quoting -----------------------------------------------------------------------

test('a trailing count follows a separator', () => {
  assert.equal(row(tool('pandacode_design_write', { name: 'Login.html', html: 'a\nb\nc\nd' })), 'Wrote artboard Login · 4 lines');
});

test('a refusal whose command had more steps ends with +N more, never a bare …', () => {
  assert.equal(row(tool('Bash', { command: 'sleep 60 && cat a.txt' }, { status: 'failed', output: '<tool_use_error>Blocked: sleep 60 followed by: cat a.txt. Use Monitor.</tool_use_error>' })), 'Blocked: sleep 60 +1 more command');
  assert.equal(row(tool('Bash', { command: 'npm install left-pad; npm test; ls' }, { status: 'failed', output: "The user doesn't want to proceed with this tool use. The tool use was rejected." })), 'Denied: npm install left-pad +2 more commands');
});

test('search patterns read curly-quoted everywhere', () => {
  assert.equal(row(tool('pandacode_code_search', { query: 'renderToolActivity' })), 'Searched code for “renderToolActivity”');
  assert.equal(row(tool('Glob', { pattern: '**/*.css' })), 'Found files matching “**/*.css”');
});

test('a local preview carries a chip like a file preview', () => {
  const html = traceRowHtml(describeTool(tool('pandacode_open_browser', { url: 'http://127.0.0.1:1420/' })));
  assert.match(html, /tool-trace-chip/);
  assert.equal(plain(html), 'Opened preview :1420');
});

test('status badges are lowercase words', () => {
  const output = JSON.stringify({ devices: [{ name: 'iPhone 17', udid: 'A', state: 'Booted', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0' }, { name: 'iPad', udid: 'B', state: 'Shutdown', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0' }] });
  const card = toolPreview(tool('pandacode_simulator_devices', {}, { output }));
  assert.match(card, />booted</);
  assert.match(card, />shut down</);
  assert.match(card, /iOS 26\.0/);
  assert.doesNotMatch(card, /iOS-26-0/);
});

// --- 5. Wording ------------------------------------------------------------------------------------------------

test('a backgrounded command reads neutral: what it was doing, never a pass or failure', () => {
  const record = tool('Bash', { command: 'npx tsc --noEmit' }, { output: 'Command did not complete within its 2m timeout and was moved to the background with ID: b1.' });
  assert.equal(row(record), 'Moved to background · Typechecking tsc');
  assert.equal(toolFailed(record), false);
});

test('design comments read `Read open design comments`', () => {
  assert.equal(row(tool('pandacode_design_comments', { status: 'open' }, { output: JSON.stringify({ comments: [{ id: 'c1', text: 'x' }] }) })), 'Read open design comments · 1 comment');
});

test('a missing wrapper names the command it would have run', () => {
  const record = bash('timeout 600 cargo test --lib', 'Exit code 127\n(eval):1: command not found: timeout');
  assert.match(row(record), /^Couldn't start timeout \(not installed\) · cargo test/);
});

// --- 6. Cards --------------------------------------------------------------------------------------------------

test('an unknown tool card is never titled `Failed Tool`', () => {
  const card = toolPreview(tool('Tool', { tool: 'frobnicate' }, { status: 'failed', output: "Unknown tool 'frobnicate'" }));
  assert.doesNotMatch(card, /Failed Tool/);
});

test('a failed edit card does not repeat its reason as the first line', () => {
  const record = tool('Edit', { file_path: 'src/design.tsx', old_string: 'a', new_string: 'b' }, { status: 'failed', output: '<tool_use_error>String to replace not found in file.\nString: a</tool_use_error>' });
  assert.match(row(record), /string to replace not found/i);
  const card = plain(toolPreview(record));
  assert.doesNotMatch(card, /^String to replace not found/i);
});

// --- Council round 16: lead failures, backgrounded commands, produced images, tails, signal badges, cards ---------

const BACKGROUND = 'Command did not complete within its 2m timeout and was moved to the background (ID: b1). Output is being written to /tmp/b1.log';

test('a lead step whose output shows it failed reads Couldn\'t, counts as failed and drops the destructive badge', () => {
  const push = bash('git push -f origin x 2>&1 | tail -2', 'error: src refspec x does not match any\nerror: failed to push some refs', 'completed');
  const trace = describeTool(push);
  assert.equal(row(push), "Couldn't force-push origin x");
  assert.equal(toolFailed(push), true);
  assert.equal(trace.destructive, undefined);
  assert.match(trace.title ?? '', /Rewrites remote history/);
  const commit = bash('git commit -m x && git push', 'Exit code 1\nOn branch main\nnothing to commit, working tree clean');
  assert.match(row(commit), /^Couldn't commit “x” \+1 more command/);
});

test('a backgrounded command says what it was doing, like a timed-out one', () => {
  assert.equal(row(bash('cd /repo && npx playwright test a.spec.ts', BACKGROUND, 'completed')), 'Moved to background · Running tests playwright a.spec.ts');
  assert.equal(row(bash('until grep -q DONE s.log; do sleep 2; done', BACKGROUND, 'completed')), 'Moved to background · Waiting for s.log to contain “DONE”');
  const trace = describeTool(bash('npm run build && npm test', BACKGROUND, 'completed'));
  assert.match(trace.verb, /^Moved to background · Running tests/);
  assert.equal(toolFailed(bash('npm run build', BACKGROUND, 'completed')), false);
});

test('an image a later step wrote reads as a separate output; one the chip names becomes its thumbnail', () => {
  const sheet = bash("sed -i 's/a/b/' s_panda.py && python3 s_panda.py && ffmpeg -y -i /tmp/x.mp4 -frames:v 1 /tmp/r1_sheet.jpg && ls", 'ok', 'completed');
  assert.match(row(sheet), /^Edited s_panda\.py · wrote r1_sheet\.jpg \+\d more commands$/);
  const frame = traceRowHtml(describeTool(bash('ffmpeg -y -ss 2 -i /r/s_tips_1.mp4 -frames:v 1 /r/k16.png', '', 'completed')));
  assert.equal((frame.match(/k16\.png/g) ?? []).filter(Boolean).length > 0, true);
  assert.doesNotMatch(plain(frame), /k16\.png.*k16\.png/);
  assert.doesNotMatch(frame, /tool-image-name/);
});

test('one tail form: a separator before +N more after a tally, and every overflow says more', () => {
  assert.match(row(bash('npm test 2>&1 | tail -3; npm run lint', '# pass 119\n# fail 0', 'completed')), /· 119 passed · \+1 more command$/);
  assert.equal(row(bash('cat a.ts b.ts c.ts', 'x', 'completed')), 'Read a.ts +2 more files');
  assert.equal(row(bash('cat a.ts b.ts', 'x', 'completed')), 'Read a.ts +1 more file');
  assert.equal(row(bash('ls src tests', 'x', 'completed')), 'Listed src +1 more path');
  assert.equal(row(bash('cat a.ts b.ts && ls src', 'x', 'completed')), 'Read a.ts +1 more file · +1 more command');
});

test('a signal exit is a neutral badge on the card', () => {
  const card = toolPreview(tool('Command', "/bin/zsh -lc 'node server.mjs'\nWorking directory: /repo", { status: 'failed', output: 'Exit code: 143\nlistening' }));
  assert.match(card, /tc-badge is-quiet">exit 143/);
});

test('a failed compound whose tests passed names the step that failed', () => {
  const record = bash('npx tsc --noEmit && echo TSC_OK; (cd src-tauri && cargo test --lib 2>&1 | grep "test result"; cargo clippy 2>&1 | grep -cE "^(warning|error)")',
    'Exit code 1\nTSC_OK\ntest result: ok. 80 passed; 0 failed; 0 ignored; 0 measured; 2204 filtered out; finished in 7.39s\n3');
  assert.match(plain(toolPreview(record)), /cargo clippy exited 1/);
});

test('a failed edit card labels its diff Not applied', () => {
  const edit = tool('Edit', { file_path: '/repo/a.tsx', old_string: 'const a = 1;', new_string: 'const a = 2;' }, { status: 'failed', output: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
  assert.match(plain(toolPreview(edit)), /Not applied/);
});

test('round 16 wording: docs search, typecheck card, places, tool-name chips, OpenCode writes, CommandCode kills', () => {
  const docs = tool('docs · search', { query: 'lifetimes' }, { output: 'Three results\n1. The Book: Validating references\n2. Nomicon: Lifetimes' });
  assert.equal(row(docs), 'Searched docs for “lifetimes”');
  const docsCard = toolPreview(docs);
  assert.doesNotMatch(docsCard, /<dt>query<\/dt>/);
  assert.match(docsCard, /1\. The Book: Validating references\n2\. Nomicon/);
  const tsc = bash('npx tsc --noEmit', 'Exit code 2\nsrc/a.ts(3,1): error TS2322: x\nsrc/b.ts(4,1): error TS2304: y');
  assert.equal(row(tsc), 'Typecheck failed tsc · 2 errors');
  assert.doesNotMatch(toolPreview(tsc), /tool-trace-error-count/);
  assert.doesNotMatch(traceRowHtml(describeTool(tool('Ran grep, rg, sed in ./src', 'src/a.ts:1:x'))), /is-mono/);
  const unknown = describeTool(tool('Tool', '', { status: 'failed', output: "Unknown tool 'pandacode_send_team_message'. This tool is not available." }));
  assert.equal(unknown.chip?.label, 'send_team_message');
  assert.equal(unknown.chip?.title, 'pandacode_send_team_message');
  assert.equal(row(tool('/Users/me/proj/src/a.ts', { content: 'hi', filePath: '/Users/me/proj/src/a.ts' })), 'Wrote a.ts · 1 line');
  assert.equal(row(tool('Kill: abc123', '')), 'Stopped background task abc123');
});
