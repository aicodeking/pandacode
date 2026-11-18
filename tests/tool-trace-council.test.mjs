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
  assert.equal(row(tool('SendMessage', { to: 'worker-1', message: 'Allow one fixture line', summary: 'Allow one fixture line in host.rs' })), 'Messaged worker-1 · “Allow one fixture line in host.rs”');
  assert.equal(row(tool('PushNotification', { message: 'Taste demo needs sign-in', status: 'proactive' })), 'Sent notification “Taste demo needs sign-in”');
  assert.equal(row(tool('ScheduleWakeup', { delaySeconds: 300, reason: 'check the batch' })), 'Scheduled wake-up in 5m · “check the batch”');
  assert.equal(row(tool('ListAgents', {})), 'Listed agents');
  assert.equal(row(tool('activate_skill', { name: 'code-review-and-quality', arguments: 'Read-only review' })), 'Loaded skill code-review-and-quality · “Read-only review”');
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
  assert.match(card, /tool-trace-badge is-quiet">exit 143/);
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

// --- Round 17: quoted free text, search outcomes, test tallies, errors a completed call reported, MCP card labels ------

test('free text a harness tool carries reads after a separator, quoted and never mono', () => {
  const skill = traceRowHtml(describeTool(tool('activate_skill', { name: 'code-review-and-quality', arguments: 'Read-only review' })));
  assert.doesNotMatch(skill, /is-mono/);
  assert.match(skill, /tool-trace-quote/);
});

test('Claude Grep and Glob say what they found', () => {
  assert.equal(row(tool('Grep', { pattern: 'zzz', path: '/repo/src' }, { output: 'No files found' })), 'Searched for “zzz” in src · no matches');
  assert.equal(row(tool('Glob', { pattern: '**/*.css' }, { output: 'No files found' })), 'Found files matching “**/*.css” · no matches');
  assert.equal(row(tool('Grep', { pattern: 'x' }, { output: 'Found 3 files\na.ts\nb.ts\nc.ts' })), 'Searched for “x” · 3 files');
  assert.equal(row(tool('Grep', { pattern: 'x' }, { output: 'Found 1 file\na.ts' })), 'Searched for “x” · 1 file');
  const card = plain(toolPreview(tool('Grep', { pattern: 'zzz', path: '/repo/src', glob: '*.ts' }, { output: 'No files found' })));
  assert.doesNotMatch(card, /No files found/);
});

test('an error a completed call reported is a failure', () => {
  const mcpJson = tool('mcp__github__create_issue', { title: 'x' }, { output: '{"isError":true,"content":[{"type":"text","text":"Bad credentials"}]}' });
  const mcpText = tool('mcp__github__create_issue', { title: 'x' }, { output: 'MCP error -32603: Internal error' });
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { output: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
  const write = tool('Write', { file_path: '/repo/a.ts', content: 'b' }, { output: '<tool_use_error>File has not been read yet.</tool_use_error>' });
  for (const record of [mcpJson, mcpText, edit, write]) {
    assert.equal(toolFailed(record), true, record.name);
    assert.match(row(record), /^Couldn't /, record.name);
  }
  assert.match(plain(toolPreview(edit)), /Not applied/);
  assert.equal(toolFailed(tool('mcp__github__create_issue', { title: 'x' }, { output: '{"isError":false,"ok":1}' })), false);
});

test('an MCP card labels its arguments and result like every other card, and only when it has both', () => {
  const card = toolPreview(tool('mcp__docs__lookup', { id: 'A-1', state: 'Done' }, { output: '{"id":"A-1","state":"Done"}' }));
  assert.match(card, /<h5 class="tool-trace-label">Arguments<\/h5><dl class="tc-kv tc-kv-input"/);
  assert.match(card, /<h5 class="tool-trace-label">Result<\/h5><dl class="tc-kv tc-kv-output"/);
  assert.doesNotMatch(card, /tc-label|Input/);
  const lone = toolPreview(tool('mcp__docs__list', {}, { output: '{"id":"A-1","state":"Done"}' }));
  assert.match(lone, /tc-kv-output/);
  assert.doesNotMatch(lone, /tool-trace-label|tc-label/);
});

// --- Round 16 -----------------------------------------------------------------------------------------------

test('only an error at the start of an edit, write or read result marks it failed', () => {
  const snippet = 'The file /repo/a.ts has been updated. Here is the result of running `cat -n`:\n  1\tconst tag = "<tool_use_error>";';
  const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, { output: snippet });
  assert.equal(toolFailed(edit), false);
  assert.doesNotMatch(row(edit), /^Couldn't/);
  const read = tool('Read', { file_path: '/repo/nope.ts' }, { output: '<tool_use_error>File does not exist.</tool_use_error>' });
  assert.equal(toolFailed(read), true);
  assert.match(row(read), /^Couldn't read/);
  assert.equal(toolFailed(tool('Read', { file_path: '/repo/a.ts' }, { output: '1\tconst tag = "<tool_use_error>";' })), false);
});

test('a failed test row says the tally once, without an exit badge', () => {
  const record = bash('npm test', 'Exit code 1\n# tests 131\n# pass 127\n# fail 4', 'completed');
  assert.equal(row(record), 'Tests failed npm test · 4 of 131 tests');
  assert.doesNotMatch(traceRowHtml(describeTool(record)), /exit 1/);
});

test('both message tools say Messaged', () => {
  const team = tool('mcp__pandacode_architect__pandacode_send_team_message', { recipient: 'worker-2', key: 'k', message: 'hi there' });
  assert.equal(row(team), 'Messaged worker-2 · “hi there”');
  assert.equal(row(tool('SendMessage', { to: 'worker-1', message: 'hi there' })), 'Messaged worker-1 · “hi there”');
});

test('a plain object keeps its appended tally in its own span; prose without one is never split', () => {
  const html = traceRowHtml({ kind: 'search', verb: 'Searched for', object: '“x” · 3 files', tally: '3 files' });
  assert.match(html, /<span class="tool-trace-object">“x”<\/span><span class="tool-trace-object is-tally"> · 3 files<\/span>/);
  assert.doesNotMatch(traceRowHtml({ kind: 'search', verb: 'Searched for', object: '“x · y”' }), /is-tally/);
});

test('a read that never started says it could not read the file', () => {
  const record = tool('Command', "/bin/zsh -lc 'cat src/subagent_state.rs'\nWorking directory: /repo",
    { status: 'failed', output: 'Exit code: -1\nFailed to create unified exec process: No such file or directory (os error 2)' });
  const trace = describeTool(record);
  assert.equal(row(record), "Couldn't read subagent_state.rs");
  assert.equal(trace.chip?.label, 'subagent_state.rs');
});

// --- Round 23: cards agree with their rows -----------------------------------------------------------------

test('a search that found nothing has a quiet exit badge and a calm terminal, like its row', () => {
  const record = bash('rg -n "nope" src', 'Exit code 1\n', 'failed');
  assert.equal(toolFailed(record), false);
  const card = toolPreview(record);
  assert.match(card, /class="tool-trace-badge is-quiet">exit 1</);
  assert.doesNotMatch(card, /is-failed/);
});

test('exit badges in cards are the one right-aligned pill', () => {
  const failed = toolPreview(bash('git push', 'Exit code 1\nrejected'));
  assert.match(failed, /class="tool-trace-badge is-failed">exit 1</);
  assert.doesNotMatch(failed, /tc-badge/);
  const signal = toolPreview(tool('Command', "/bin/zsh -lc 'node server.mjs'\nWorking directory: /repo", { status: 'failed', output: 'Exit code: 143\nlistening' }));
  assert.match(signal, /class="tool-trace-badge is-quiet">exit 143</);
});

test('a failed edit labels its diff `Not applied` in the sentence-case section label', () => {
  const edit = tool('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, { status: 'failed', output: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
  const card = toolPreview(edit);
  assert.match(card, /<h5 class="tool-trace-label">Not applied<\/h5>/);
  assert.doesNotMatch(card, /tc-label/);
});

test('an unknown-tool failure card is a calm error section, not a filled alert box', () => {
  const card = toolPreview(tool('Tool', { tool: 'frobnicate' }, { status: 'failed', output: "Unknown tool 'frobnicate'" }));
  assert.doesNotMatch(card, /class="tc-failed"|role="alert"/);
  assert.match(card, /<h5 class="tool-trace-label">Error<\/h5>/);
  assert.match(card, /Unknown tool &#39;frobnicate&#39;|Unknown tool 'frobnicate'/);
});

test('a progress snapshot shows its image once: in the row, not again in the card', () => {
  const snap = tool('pandacode_progress_snapshot', { image: 'shots/a.png', note: 'Dock spacing', title: 'Dock' }, { output: '{"iteration":1,"saved":{"kind":"image"}}' });
  assert.match(traceRowHtml(describeTool(snap)), /data-tool-image="shots\/a\.png"/);
  assert.doesNotMatch(toolPreview(snap), /tool-image-card/);
});

test('a literal ` · ` in quoted prose stays in the object; only an appended tally gets its own span', () => {
  const html = traceRowHtml(describeTool(tool('Grep', { pattern: 'a · b', path: 'src' }, { output: 'No files found' })));
  assert.doesNotMatch(html, /is-tally">[^<]*b”/);
  assert.match(html, /is-tally">[^<]*no matches</);
  const prose = traceRowHtml(describeTool(bash('rg -n "a · b" src', 'Exit code 1\n', 'failed')));
  assert.doesNotMatch(prose, /is-tally">[^<]*b”/);
  assert.match(prose, /no matches/);
});

// --- MCP rows: honest verbs and destructive calls; config writes; failures a lead step did not cause --------------

const mcpRow = (name, input = {}, extra = {}) => plain(traceRowHtml(describeTool(tool(name, input, extra))));

test('an MCP tool whose name changes anything never reads as a search or a read', () => {
  // A deleting one also carries the destructive badge.
  assert.equal(mcpRow('mcp__x__lookup_delete'), 'Used x lookup delete destructive');
  assert.equal(mcpRow('mcp__x__find_and_replace'), 'Used x find and replace');
  assert.equal(mcpRow('mcp__x__get_or_create_and_delete'), 'Used x get or create and delete destructive');
  assert.equal(mcpRow('mcp__x__runQuery'), 'Used x runQuery');
  // Plain reads and searches keep their verbs.
  assert.equal(mcpRow('mcp__github__list_issues'), 'Read the GitHub issues');
  assert.equal(mcpRow('mcp__slack__search_messages', { query: 'deploy' }), 'Searched Slack for “deploy”');
});

test('a destructive MCP call carries the destructive badge and says why', () => {
  for (const name of ['mcp__github__delete_repository', 'mcp__filesystem__delete_file', 'mcp__db__drop_table', 'mcp__s3__purge_bucket']) {
    const trace = describeTool(tool(name, {}));
    assert.equal(trace.destructive, true, name);
    assert.ok(trace.risks?.length, name);
  }
  assert.match(traceRowHtml(describeTool(tool('mcp__github__delete_repository', { repo: 'x' }))), /is-danger[^>]*>destructive</);
  assert.equal(describeTool(tool('mcp__github__list_issues', {})).destructive, undefined);
  assert.equal(describeTool(tool('mcp__notes__undelete_note', {})).destructive, undefined);
});

test('MCP SQL that drops or deletes is destructive and never reads `Searched`', () => {
  const drop = describeTool(tool('mcp__db__query', { query: 'DROP TABLE users' }));
  assert.equal(drop.destructive, true);
  assert.doesNotMatch(drop.verb, /^Searched/);
  assert.deepEqual(drop.risks, ['Drops a table: DROP TABLE users']);
  assert.equal(describeTool(tool('mcp__pg__execute', { sql: 'DELETE FROM sessions' })).destructive, true);
  assert.equal(describeTool(tool('mcp__pg__run', { statement: 'truncate logs' })).destructive, true);
  assert.equal(describeTool(tool('mcp__pg__run', { sql: 'ALTER TABLE users DROP COLUMN email' })).destructive, true);
  const select = describeTool(tool('mcp__db__query', { query: 'SELECT * FROM users' }));
  assert.equal(select.destructive, undefined);
  assert.equal(select.verb, 'Searched');
});

test('a Write to a config or system path carries the shell’s risk', () => {
  const zshrc = describeTool(tool('Write', { file_path: '~/.zshrc', content: 'x' }));
  assert.equal(zshrc.destructive, true);
  assert.deepEqual(zshrc.risks, ['Overwrites a config file: ~/.zshrc']);
  assert.equal(describeTool(tool('Write', { file_path: '/Users/me/.ssh/authorized_keys', content: 'x' })).destructive, true);
  assert.deepEqual(describeTool(tool('Write', { file_path: '/etc/hosts', content: 'x' })).risks, ['Overwrites a system file: /etc/hosts']);
  assert.equal(describeTool(tool('Write', { file_path: '/repo/src/a.ts', content: 'x' })).destructive, undefined);
  // A failed write changed nothing.
  assert.equal(describeTool(tool('Write', { file_path: '/etc/hosts', content: 'x' }, { status: 'failed', output: 'EACCES' })).destructive, undefined);
});

test('a third-party MCP screenshot shows its image: `Took a screenshot [thumb] shot.png`', () => {
  const shot = describeTool(tool('mcp__puppeteer__puppeteer_screenshot', { name: 'shot' }, { output: 'Screenshot saved: /tmp/shot.png' }));
  assert.equal(shot.image, '/tmp/shot.png');
  assert.equal(shot.verb, 'Took a screenshot');
  assert.equal(mcpRow('mcp__puppeteer__puppeteer_screenshot', { name: 'shot' }, { output: 'Screenshot saved: /tmp/shot.png' }), 'Took a screenshot shot.png');
});

test('a compound whose later step failed keeps its lead verb neutral and marks the tally failed', () => {
  const trace = describeTool(tool('Bash', { command: "sed -n '3130,3220p' src/main.ts; grep -n foo src/a.ts; ls nope" }, { status: 'failed', output: 'Exit code 2\nline\nls: nope: No such file or directory' }));
  const html = traceRowHtml(trace);
  assert.match(html, /class="tool-trace-verb is-lead"/);
  assert.match(html, /class="tool-trace-more-steps is-failed"/);
  // A failure pinned on the lead keeps the plain (red) verb.
  assert.doesNotMatch(traceRowHtml(describeTool(tool('Bash', { command: 'cat nope.txt' }, { status: 'failed', output: 'Exit code 1\ncat: nope.txt: No such file or directory' }))), /is-lead/);
});
