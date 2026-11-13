import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, failedVerb, summarizeTools, toolFailed, toolPreview, traceKind, traceRowHtml } from '../src/tool-trace.ts';
import { renderToolActivity } from '../src/tool-activity.ts';
import { githubTarget, listedTools, shellRunningVerb } from '../src/tool-trace-intent.ts';
import { SHELL_VERBS } from '../src/shell-intent.ts';

// Shapes copied from real recorded tool calls (paths shortened).
const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input, null, 2), output: '', ...extra });
// Free text a row quotes after its sentence (`note`) reads as `“…”` here.
const row = record => { const trace = describeTool(record); return [trace.verb, trace.chip?.label, trace.object + (trace.note ? `“${trace.note}”` : '')]; };
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('images: Claude Read of a png, Codex View image, Kimi media and Devin read the same', () => {
  const claude = tool('Read', { file_path: '/private/tmp/claude-501/shots/css-app.png' }, { output: '[Non-text content omitted]' });
  const codex = tool('View image', { path: '/tmp/fx1.png' });
  const kimi = tool('Reading media: /Users/me/a.webp', '');
  const devin = tool('Read file', { file_path: '/tmp/d.png' }, { output: 'View image /tmp/d.png (1920x1080)' });
  for (const record of [claude, codex, kimi, devin]) assert.equal(traceKind(record), 'image', record.name);
  const trace = describeTool(claude);
  assert.deepEqual([trace.kind, trace.verb, trace.image, trace.chip], ['image', 'Viewed', '/private/tmp/claude-501/shots/css-app.png', undefined]);
  assert.equal(describeTool({ ...codex, status: 'failed' }).verb, "Couldn't view");
  assert.equal(describeTool(devin).object, '1920 × 1080');
  const html = traceRowHtml(trace);
  assert.match(html, /^<span class="tool-trace-verb">Viewed<\/span><span class="tool-trace-image"><button type="button" class="tool-image-thumb" data-tool-image="\/private\/tmp\/claude-501\/shots\/css-app\.png"/);
  assert.match(html, /<span class="tool-image-name">css-app\.png<\/span>/);
  // The card is the larger preview; the raw `[Non-text content omitted]` record is not offered.
  const activity = renderToolActivity({ id: 'i', ...claude }, 'k');
  assert.match(activity, /class="tool-image-card"/);
  assert.doesNotMatch(activity, /tool-trace-raw/);
  // The row names the size; the card does not repeat it.
  assert.doesNotMatch(toolPreview(devin), /1920 × 1080/);
  assert.equal(summarizeTools([claude, codex, devin]), 'Viewed 3 images');
  // A text file stays a read.
  assert.equal(traceKind(tool('Read', { file_path: 'src/a.ts' })), 'read');
});

test('image paths and names are escaped inside the row sentence', () => {
  const html = traceRowHtml(describeTool(tool('Read', { file_path: '/tmp/"><img src=x onerror=alert(1)>.png' })));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-tool-image="\/tmp\/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\.png"/);
});

test('PandaCode screenshots and progress snapshots show the image they carry', () => {
  const snapshot = tool('pandacode_progress_snapshot', { image: 'test-results/skill-manager-820-dark.png', note: 'Project installs now carry folder labels', title: 'Skills page clarity' }, { output: '{"iteration":1,"saved":{"kind":"image"}}' });
  const trace = describeTool(snapshot);
  assert.equal(trace.image, 'test-results/skill-manager-820-dark.png');
  assert.doesNotMatch(toolPreview(snapshot), /tool-image-card/);
  const shot = tool('pandacode_simulator_screenshot', { udid: 'A1' }, { output: 'Saved screenshot to /tmp/sim/shot-1.png (1179x2556)' });
  assert.equal(describeTool(shot).image, '/tmp/sim/shot-1.png');
  // Beside a chip the thumbnail drops its file name.
  assert.match(traceRowHtml(describeTool(shot)), /tool-trace-image is-compact/);
});

test('shell commands read as what they did', () => {
  const cases = [
    [tool('Bash', { command: "sed -n '210,222p' tests/voice-input.spec.ts; rg -n foo src; ls" }), ['Read', 'voice-input.spec.ts', 'lines 210–222']],
    [tool('Command', '/bin/zsh -lc "rg -n \\"foo\\" src"\nWorking directory: /repo'), ['Searched', 'src', 'for “foo” in']],
    [tool('Bash', { command: 'PW_PORT=1431 npx playwright test tests/a.spec.ts' }), ['Ran tests', 'playwright', 'a.spec.ts']],
    [tool('Bash', { command: 'sleep 30' }), ['Waited', undefined, '30s']],
    [tool('Bash', { command: 'git status --short' }), ['Checked', 'git status', '']],
    [tool('Bash', { command: 'cd /repo && npx tsc --noEmit' }), ['Typechecked', 'tsc', '']],
    [tool('pandacode_vm_exec', { name: 'vm', command: 'uname -a' }), ['Ran', 'uname', '· on vm']],
  ];
  for (const [record, expected] of cases) assert.deepEqual(row(record), expected, record.input);
  const sed = traceRowHtml(describeTool(cases[0][0]));
  assert.equal(plain(sed), 'Read voice-input.spec.ts lines 210–222 +2 more commands');
  // Shell reads count with file reads, shell searches with searches.
  assert.equal(summarizeTools([cases[0][0], tool('Read', { file_path: 'a.ts' }), cases[1][0], tool('Grep', { pattern: 'x' })]), 'Read 2 files and ran 2 searches');
  // A compound that fails keeps its lead step's verb and says it then failed; a lone step keeps `Couldn't …`.
  assert.equal(describeTool({ ...cases[0][0], status: 'failed', output: 'Exit code 1' }).verb, 'Read');
  assert.equal(describeTool({ ...cases[0][0], status: 'failed', output: 'Exit code 1' }).then, true);
  // With no output at all it never started, so it says nothing of what its steps would have done.
  assert.equal(describeTool({ ...cases[0][0], status: 'failed' }).verb, "Couldn't run");
  const exit = tool('Command', 'npm test', { output: 'Exit code: 1\nOutput:\nfail' });
  assert.equal(describeTool(exit).exit, undefined);
  assert.ok(toolFailed(exit));
});

test('a test run leads its card with the pass/fail summary', () => {
  const output = 'Exit code: 1\nOutput:\n  ✘  3 [chromium] › tests/a.spec.ts:10:1 › opens the viewer (1.2s)\n\n  1 failed\n  12 passed (8.4s)\n';
  const run = tool('Command', '/bin/zsh -lc "npx playwright test"\nWorking directory: /repo', { output });
  const html = toolPreview(run);
  assert.match(html, /<div class="tool-test-summary" data-status="fail">/);
  assert.ok(html.indexOf('tool-test-summary') < html.indexOf('tc-term'), 'summary sits above the terminal');
  assert.match(html, /tool-test-pass">12 passed</);
  assert.match(html, /tool-test-fail">1 failed</);
  assert.equal(summarizeTools([tool('Bash', { command: 'npm test' }), tool('Bash', { command: 'ls' })]), 'Ran tests and 1 other command');
  assert.equal(summarizeTools([tool('Bash', { command: 'npm test' }), tool('Bash', { command: 'npx vitest' })]), 'Ran tests twice');
});

test('background shells, tool loading, compaction and waits', () => {
  const check = tool('BashOutput', { bash_id: 'f50fcf' }, { output: '<status>running</status>\n\n<stdout>\nbuilding…\nok 12\n</stdout>' });
  assert.deepEqual(row(check), ['Checked background shell', 'f50fcf', '']);
  assert.deepEqual(row(tool('Read shell', { shell_id: '0110ab', timeout: 200000 })), ['Checked background shell', '0110ab', '']);
  const checkCard = toolPreview(check);
  assert.match(checkCard, /tool-trace-badge is-live">running</);
  assert.match(checkCard, /ok 12/);
  assert.doesNotMatch(checkCard, /&lt;stdout&gt;/);

  const stop = tool('TaskStop', { task_id: 'bfrl0bmxm' }, { output: '{"message":"Successfully stopped task: bfrl0bmxm (npx playwright test --reporter=line)","task_id":"bfrl0bmxm","task_type":"local_bash"}' });
  assert.deepEqual(row(stop), ['Stopped background task', 'bfrl0bmxm', '']);
  assert.match(toolPreview(stop), /tool-trace-command">npx playwright test --reporter=line</);
  const missing = tool('KillShell', { shell_id: 'x1' }, { status: 'failed', output: 'No shell found with ID: x1' });
  assert.equal(describeTool(missing).verb, "Couldn't stop background task");
  assert.match(toolPreview(missing), /tool-trace-inline tool-trace-note is-error">No shell found/);

  const load = tool('ToolSearch', { query: 'select:mcp__pandacode_architect__pandacode_send_team_message,mcp__pandacode_architect__pandacode_checkpoint_worker,mcp__pandacode_architect__pandacode_track_files,mcp__pandacode_architect__pandacode_team_directory', max_results: 4 }, { output: '[Non-text content omitted]' });
  const loaded = describeTool(load);
  assert.equal(loaded.verb, 'Loaded tools');
  assert.deepEqual(loaded.chips.map(chip => chip.label), ['send_team_message', 'checkpoint_worker', 'track_files']);
  assert.equal(loaded.object, '+1 more tool');
  assert.match(renderToolActivity({ id: 't', ...load }, 'k'), /data-static/);
  assert.deepEqual(row(tool('ToolSearch', { query: 'slack send', max_results: 5 })), ['Searched tools', undefined, 'for “slack send”']);

  const compact = tool('Compact context', '', { output: 'Conversation context compacted.' });
  assert.deepEqual(row(compact), ['Compacted context', undefined, '']);
  assert.match(renderToolActivity({ id: 'c', ...compact }, 'k'), /data-static data-tool-quiet|data-tool-quiet[^>]*data-static/);

  assert.deepEqual(row(tool('sleep', { durationMs: 30000 })), ['Waited', undefined, '30s']);
  assert.match(renderToolActivity({ id: 's', ...tool('sleep', { durationMs: 90000 }) }, 'k'), /data-static/);
});

test('skills and MCP listings', () => {
  assert.deepEqual(row(tool('read_skill', '{"name":"code-review-and-quality"}', { output: '<read-skill-result name="code-review-and-quality" status="ok">' })), ['Loaded skill', 'code-review-and-quality', '']);
  const listing = tool('Listed MCP tools for linear', { server_name: 'linear' }, { output: JSON.stringify({ tools: [{ name: 'list_issues' }, { name: 'create_issue' }, { name: 'get_team' }] }) });
  const trace = describeTool(listing);
  assert.equal(trace.verb, 'Listed 3 tools from');
  assert.equal(trace.chip.label, 'Linear');
  assert.match(toolPreview(listing), /list_issues[\s\S]*create_issue/);
  assert.deepEqual(listedTools('- alpha: does a\n- beta (b)\n'), ['alpha', 'beta']);
});

test('Codex web search, JS REPL and GitHub fetch', () => {
  const web = tool('web_search', { query: 'tauri updater signing' }, { output: 'Links:\n[{"title":"Updater","url":"https://v2.tauri.app/plugin/updater/"}]\n' });
  assert.deepEqual([describeTool(web).kind, ...row(web)], ['web', 'Searched the web', undefined, 'for “tauri updater signing”']);

  const repl = tool('node_repl · js', { title: 'Check focus states', code: "const page = await browser.newPage();\nawait page.goto('http://127.0.0.1:5317/');\nreturn page.title();" }, { output: "{ title: 'Vault' }" });
  assert.deepEqual(row(repl), ['Ran JS:', undefined, 'Check focus states']);
  const replCard = toolPreview(repl);
  assert.match(replCard, /aria-label="JavaScript">const page = await browser\.newPage\(\);/);
  assert.match(replCard, /Result[\s\S]*\{ title: &#39;Vault&#39; \}/);
  const untitled = tool('cua_repl · js', { code: "await pg2.locator('#vault-path').fill('/tmp/x');" }, { output: 'js execution timed out; kernel reset, rerun your request' });
  assert.deepEqual(row(untitled), ['Ran JS:', undefined, "await pg2.locator('#vault-path').fill('/tmp/x');"]);

  const pulls = [{ number: 339, title: 'Fix the dock', state: 'open', user: { login: 'octo' }, html_url: 'https://github.com/aicodeking/pandacode/pull/339' }, { number: 338, title: 'Docs', state: 'open', draft: true, user: { login: 'mona' } }];
  const fetch = tool('codex_apps · github.fetch', { url: 'https://api.github.com/repos/aicodeking/pandacode/pulls?state=open&sort=created' }, { output: JSON.stringify({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { content: JSON.stringify(pulls) } }) });
  const trace = describeTool(fetch);
  assert.deepEqual([trace.verb, trace.chip.label, trace.object], ['Fetched', 'GitHub', 'pulls for aicodeking/pandacode']);
  assert.match(trace.chip.svg, /brand-icon/);
  const card = toolPreview(fetch);
  assert.match(card, /#339 Fix the dock[\s\S]*open · octo[\s\S]*#338 Docs[\s\S]*draft · mona/);

  const search = tool('codex_apps · github.fetch', { url: 'https://api.github.com/search/issues?q=repo%3Aaicodeking%2Fpandacode%20is%3Aissue%20is%3Aopen&per_page=1' }, { output: 'Action completed.\n' + JSON.stringify({ content: JSON.stringify({ total_count: 44, items: [{ number: 342, title: 'Crash on start', state: 'open' }] }) }) });
  assert.deepEqual(row(search), ['Searched', 'GitHub', 'issues matching is:issue is:open in aicodeking/pandacode']);
  assert.match(toolPreview(search), /#342 Crash on start[\s\S]*\+43 more/);
  assert.equal(githubTarget('https://api.github.com/repos/o/r/pulls/12/files').object, 'pull #12 files in o/r');
});

test('Codex agent collaboration calls read as what they did', () => {
  const spawn = tool('Agent · spawnAgent', { prompt: 'Audit the sidebar drag code for leaks', model: 'gpt-5.5-codex', reasoningEffort: 'high' }, { output: '019a-thread-1: running' });
  assert.equal(traceKind(spawn), 'agent');
  assert.deepEqual(row(spawn), ['Spawned agent', 'gpt-5.5-codex', '“Audit the sidebar drag code for leaks”']);
  const spawnCard = toolPreview(spawn);
  assert.match(spawnCard, /tool-trace-route">gpt-5\.5-codex</);
  assert.match(spawnCard, /tool-trace-card-meta">high</);
  assert.match(spawnCard, /Audit the sidebar drag code[\s\S]*tool-trace-badge is-live">running</);
  assert.equal(describeTool({ ...spawn, status: 'failed' }).verb, "Couldn't spawn agent");

  const wait = tool('Agent · wait', { receiverThreadIds: ['019a-thread-1', '019a-thread-2'] }, { output: '019a-thread-1: completed — Found two leaks in pointer-drag.ts\n019a-thread-2: running' });
  assert.deepEqual(row(wait), ['Waited for 2 agents', undefined, '']);
  const waitCard = toolPreview(wait);
  assert.match(waitCard, /<ul class="tool-trace-list">/);
  assert.match(waitCard, /Found two leaks in pointer-drag\.ts<\/span><span class="tool-trace-item-meta">019a-thread-1<\/span><span class="tool-trace-badge">completed</);
  assert.match(waitCard, /019a-thread-2<\/span><span class="tool-trace-badge is-live">running</);

  const send = tool('Agent · sendInput', { prompt: 'Also check the dock', receiverThreadIds: ['019a-thread-1'] });
  assert.deepEqual(row(send), ['Sent input to agent', undefined, '“Also check the dock”']);
  assert.deepEqual(row(tool('Agent · sendMessage', { prompt: 'hi', receiverThreadIds: ['a', 'b'] })), ['Sent message to 2 agents', undefined, '“hi”']);
  assert.deepEqual(row(tool('Agent · followupTask', { prompt: 'Now fix it', receiverThreadIds: ['a'] })), ['Sent follow-up to agent', undefined, '“Now fix it”']);
  assert.deepEqual(row(tool('Agent · resumeAgent', { receiverThreadIds: ['a'] })), ['Resumed agent', undefined, '']);
  assert.equal(describeTool(tool('Agent · resumeAgent', { receiverThreadIds: ['a'] }, { status: 'failed' })).verb, "Couldn't resume agent");
  assert.deepEqual(row(tool('Agent · closeAgent', { receiverThreadIds: ['a', 'b', 'c'] })), ['Closed 3 agents', undefined, '']);
  assert.deepEqual(row(tool('Agent · interruptAgent', { receiverThreadIds: ['a'] })), ['Interrupted agent', undefined, '']);
  assert.deepEqual(row(tool('Agent · listAgents', '', { output: 'a: running\nb: completed' })), ['Listed 2 agents', undefined, '']);
  // An unknown collaboration tool stays a generic MCP-style row; Claude's own `Agent` tool is untouched.
  assert.equal(traceKind(tool('Agent · somethingNew', {})), 'mcp');
  assert.equal(traceKind(tool('Agent', { prompt: 'x' })), 'agent');
  // A group summary counts spawns as started agents and waits or messages by their own verbs.
  assert.equal(summarizeTools([spawn, spawn]), 'Started 2 agents');
  assert.equal(summarizeTools([spawn, wait, send]), 'Started 1 agent, waited for agents and messaged agents');
});

test('Codex sub-agent activity names its agent and model', () => {
  const sub = tool('Sub-agent', { agentPath: 'agents/reviewer', kind: 'review', model: 'gpt-5.5-mini' });
  assert.equal(traceKind(sub), 'agent');
  assert.deepEqual(row(sub), ['Ran sub-agent', 'reviewer', 'review · gpt-5.5-mini']);
  assert.deepEqual(row(tool('Sub-agent', { kind: 'explorer' })), ['Ran sub-agent', 'explorer', '']);
  assert.match(renderToolActivity({ id: 'sa', ...sub }, 'k'), /data-static/);
});

test('Codex image generation shows the saved image with its revised prompt', () => {
  const made = tool('Generate image', { revisedPrompt: 'A red panda coding at night, <warm> light' }, { output: '/Users/me/.codex/generated/img-1.png' });
  assert.equal(traceKind(made), 'image');
  const trace = describeTool(made);
  assert.deepEqual([trace.verb, trace.image, trace.object], ['Generated image', '/Users/me/.codex/generated/img-1.png', '']);
  assert.match(traceRowHtml(trace), /^<span class="tool-trace-verb">Generated image<\/span><span class="tool-trace-image"><button type="button" class="tool-image-thumb" data-tool-image="\/Users\/me\/\.codex\/generated\/img-1\.png"/);
  const card = toolPreview(made);
  assert.match(card, /class="tool-image-card"/);
  assert.match(card, /tool-image-card-meta">A red panda coding at night, &lt;warm&gt; light</);
  assert.equal(summarizeTools([made]), 'Generated 1 image');
  // A relative path is not served; a failure records its type.
  assert.equal(describeTool(tool('Generate image', {}, { output: 'img.png' })).image, undefined);
  const refused = tool('Generate image', { revisedPrompt: 'x' }, { output: 'content_policy' });
  assert.deepEqual(row(refused), ["Couldn't generate image", undefined, 'content_policy']);
  assert.match(toolPreview(refused), /Prompt[\s\S]*is-error">content_policy</);
  assert.equal(describeTool({ ...refused, status: 'failed' }).verb, "Couldn't generate image");
});

test('Codex plans and reviews show their text', () => {
  const plan = tool('Plan', '', { output: '1. Read the dock\n2. Fix the leak\n3. Add a test' });
  assert.equal(traceKind(plan), 'todo');
  assert.deepEqual(row(plan), ['Updated the plan', undefined, '']);
  assert.match(toolPreview(plan), /aria-label="Plan">1\. Read the dock\n2\. Fix the leak\n3\. Add a test</);
  assert.equal(summarizeTools([plan]), 'Updated the plan');

  const start = tool('Review', { review: 'current changes against main' });
  assert.deepEqual(row(start), ['Started review', undefined, 'of current changes against main']);
  assert.match(renderToolActivity({ id: 'r', ...start }, 'k'), /data-static/);
  const done = tool('Review', '', { output: '## No blocking issues\nThe dock change is safe.' });
  assert.deepEqual(row(done), ['Finished review', undefined, '“No blocking issues”']);
  assert.match(toolPreview(done), /aria-label="Review">## No blocking issues\nThe dock change is safe\.</);
});

// The bare infinitive of each past-tense lead word, written out by hand as the oracle for `Couldn't …`.
const BASE = {
  Tapped: 'tap', Swiped: 'swipe', Typed: 'type', Pressed: 'press', Resolved: 'resolve', Symlinked: 'symlink',
  Ran: 'run', Reran: 'rerun', Read: 'read', Counted: 'count', Searched: 'search', Listed: 'list', Edited: 'edit', Wrote: 'write',
  Appended: 'append', Deleted: 'delete', Moved: 'move', Copied: 'copy', Changed: 'change', Made: 'make', Set: 'set', Hashed: 'hash',
  Checked: 'check', Extracted: 'extract', Archived: 'archive', Compressed: 'compress', Typechecked: 'typecheck', Linted: 'lint',
  Built: 'build', Cleaned: 'clean', Installed: 'install', Removed: 'remove', Locked: 'lock', Waited: 'wait', Fetched: 'fetch',
  Queried: 'query', Called: 'call', Stopped: 'stop', Started: 'start', Restarted: 'restart', Inspected: 'inspect', Signed: 'sign',
  Viewed: 'view', Probed: 'probe', Encoded: 'encode', Captured: 'capture', Opened: 'open', Located: 'locate', Diffed: 'diff',
  Showed: 'show', Committed: 'commit', Pushed: 'push', Pulled: 'pull', Switched: 'switch', Staged: 'stage', Stashed: 'stash',
  Merged: 'merge', Rebased: 'rebase', Reset: 'reset', Restored: 'restore', Tagged: 'tag', Cloned: 'clone', 'Cherry-picked': 'cherry-pick',
  Created: 'create', Commented: 'comment', Closed: 'close', Reopened: 'reopen', Reviewed: 'review', Watched: 'watch', Booted: 'boot',
  Shut: 'shut', Erased: 'erase', Uninstalled: 'uninstall', Launched: 'launch', Recorded: 'record', Sent: 'send', Added: 'add', Applied: 'apply',
  'Force-pushed': 'force-push', Overwrote: 'overwrite', Emptied: 'empty', Discarded: 'discard', Dropped: 'drop',
  Truncated: 'truncate', Shredded: 'shred', Formatted: 'format', Synced: 'sync', Downloaded: 'download', Uploaded: 'upload',
  Converted: 'convert', Renamed: 'rename', Linked: 'link', Generated: 'generate', Updated: 'update', Upgraded: 'upgrade', Published: 'publish',
  Deployed: 'deploy', Validated: 'validate', Profiled: 'profile', Benchmarked: 'benchmark', Served: 'serve', Mounted: 'mount', Exported: 'export',
  Imported: 'import', Resized: 'resize', Unzipped: 'unzip', Zipped: 'zip', Tested: 'test', Previewed: 'preview', Bumped: 'bump',
  Destroyed: 'destroy', Expired: 'expire', Pruned: 'prune', Rewrote: 'rewrite', Purged: 'purge', Wiped: 'wipe', Killed: 'kill',
  Revoked: 'revoke', Unlinked: 'unlink', 'Hard-reset': 'hard-reset', Rebooted: 'reboot', Unpublished: 'unpublish', Untracked: 'untrack',
  Processed: 'process', Initialized: 'initialize', Looked: 'look', Measured: 'measure', Rendered: 'render', Compiled: 'compile',
  Decoded: 'decode', Cropped: 'crop', Rotated: 'rotate', Compared: 'compare', Optimized: 'optimize', Transcoded: 'transcode',
  Trimmed: 'trim', Verified: 'verify', Migrated: 'migrate', Spawned: 'spawn', Terminated: 'terminate', Seeded: 'seed',
  Unmounted: 'unmount', Loaded: 'load', Unloaded: 'unload', Flushed: 'flush', Ejected: 'eject', Attached: 'attach', Detached: 'detach',
  Forked: 'fork', Scheduled: 'schedule', Simulated: 'simulate', Printed: 'print', Found: 'find',
};

test('every verb describeShell can emit has a running form and a grammatical failed form', () => {
  assert.ok(SHELL_VERBS.length > 80);
  for (const verb of SHELL_VERBS) {
    const [lead, ...rest] = verb.split(' ');
    assert.ok(BASE[lead], `no oracle for ${verb}`);
    const running = shellRunningVerb(verb);
    assert.match(running, /^[A-Z][a-z-]*ing(?: |$)/, verb);
    assert.equal(running.split(' ').slice(1).join(' '), rest.join(' '), verb);
    if (verb !== 'Ran') assert.notEqual(running, 'Running', verb);
    assert.equal(failedVerb(running), ["Couldn't", BASE[lead], ...rest].join(' '), verb);
  }
});

test('failed shell rows lead with what could not be done', () => {
  // A failure that ran prints its exit code; one with no output at all never started (`Couldn't run …`).
  const failed = command => describeTool(tool('Bash', { command }, { status: 'failed', output: 'Exit code 1' })).verb;
  assert.equal(failed('rm -rf build'), "Couldn't delete");
  assert.equal(failed('ffprobe a.mp4'), "Couldn't probe");
  assert.equal(failed('git commit -m "x"'), "Couldn't commit");
  assert.equal(failed('xcrun simctl boot booted'), "Couldn't boot simulator");
  assert.equal(failed('test -f a.txt'), "Couldn't check");
  assert.equal(failed('wc -l a.ts'), "Couldn't count lines in");
  assert.equal(failed('docker run alpine'), "Couldn't run container");
  assert.equal(failed('git cherry-pick abc'), "Couldn't cherry-pick");
});

test('shell objects are mono when they are commands, paths or patterns, plain when they are prose', () => {
  const mono = command => describeTool(tool('Bash', { command })).mono ?? false;
  for (const command of ['node scripts/x.mjs data/a.json', 'mv a.ts src/b.ts', 'chmod 755 run.sh', 'kill 123', 'lsof -i :3000',
    'open https://example.com/docs', 'sqlite3 a.db "select 1"', 'curl https://api.x.dev/v1/items', 'git diff main -- src/a.ts', 'docker logs api'])
    assert.equal(mono(command), true, command);
  for (const command of ['cat a.ts', 'sed -n 1,20p a.ts', 'rg foo src', 'test -f a.txt', 'pgrep -f vite', 'ffmpeg -i a.mov b.mp4',
    'git commit -m "Fix it"', 'git log -5', 'gh pr view 12', 'sleep 5', 'npm test', 'find . -name "*.tmp" -delete'])
    assert.equal(mono(command), false, command);
});

test('title-named tools read as their canonical rows, never `Used <title>`', () => {
  const cases = [
    [tool("Search for 'fn open_external_url'", 'lib.rs\nfile:///Users/me/p/lib.rs'), ['Searched', undefined, 'for “fn open_external_url”']],
    [tool('Searched for profile in ./src-tauri/Cargo.toml', '70:[profile.release]'), ['Searched', 'Cargo.toml', 'for “profile” in']],
    [tool('Find files matching `**/*connect*`', 'connect.ts'), ['Found', undefined, 'files matching “**/*connect*”']],
    [tool('Listed ./data/cache', 'a.jpg\nb.jpg'), ['Listed', 'cache', '']],
    [tool('Listed ./a/check, ./a/check/assets', 'x'), ['Listed', 'check', '+1 more folder']],
    [tool('Wrote ./tests/test_serve.py', '/Users/me/P/tests/test_serve.py\n--- Before\n\n+++ After\nimport json\nimport sqlite3\n'), ['Wrote', 'test_serve.py', '· 2 lines']],
    [tool('Read ./src/mirror.rs', '     1  //! Mirrors'), ['Read', 'mirror.rs', '']],
    [tool('Read lines 12-36 in ./src/palette.ts', '12 a'), ['Read', 'palette.ts', 'lines 12–36']],
    [tool('Read ./a/starts.json, lines 1-30 in ./a/snap.mjs', '{'), ['Read', 'starts.json', '+1 more file']],
    [tool('Fetched https://help.openai.com/en/articles/1', { url: 'https://help.openai.com/en/articles/1' }, { output: 'Fetched 1840 characters' }), ['Fetched', 'help.openai.com', '']],
    [tool('Kill shell', { shell_id: '4323f2' }), ['Stopped background task', '4323f2', '']],
    [tool('Searched web for Arch-Router 1.5B', { query: 'Arch-Router 1.5B', num_results: 4 }), ['Searched the web', undefined, 'for “Arch-Router 1.5B”']],
    [tool("Searching for 'paintLive' in src/main.ts", { path: 'src/main.ts', pattern: 'paintLive', output_mode: 'content' }), ['Searched', 'main.ts', 'for “paintLive” in']],
    [tool('Searching **/*', { path: '/Users/me/runs/project', pattern: '**/*' }), ['Found', 'project', 'files matching “**/*” in']],
    [tool('Invoke skill verification-before-completion', { skill: 'verification-before-completion' }), ['Loaded skill', 'verification-before-completion', '']],
    [tool('Fetching: https://matharena.ai', { url: 'https://matharena.ai' }), ['Fetched', 'matharena.ai', '']],
    [tool('Edit: /Users/me/p/bench.mjs', { file_path: '/Users/me/p/bench.mjs', old_string: 'a', new_string: 'b' }), ['Edited', 'bench.mjs', '']],
    [tool('Write: /Users/me/p/x.rs', { file_path: '/Users/me/p/x.rs', content: 'a\nb\nc' }), ['Wrote', 'x.rs', '· 3 lines']],
    [tool('List: /Users/me/p/scripts/release', { path: '/Users/me/p/scripts/release', exclude: [] }), ['Listed', 'release', '']],
    [tool('Search: pub fn healthy', { path: 'src-tauri/src/model_health.rs', pattern: 'pub fn healthy' }), ['Searched', 'model_health.rs', 'for “pub fn healthy” in']],
    [tool('shell_output', { id: 's2clkkkt', block: true }), ['Checked background shell', 's2clkkkt', '']],
    [tool('bash_input', '{"session_id":7,"terminate":true}'), ['Stopped background task', '7', '']],
    [tool('bash_input', '{"session_id":8}'), ['Checked background shell', '8', '']],
  ];
  for (const [record, expected] of cases) assert.deepEqual(row(record), expected, record.name);
  const background = describeTool(tool('Starting background: cargo test --…', { command: 'cargo test --lib storage::', description: 'Run Rust storage unit tests' }));
  assert.deepEqual([background.verb, background.chip?.label, background.object], ['Ran tests', 'cargo test', 'storage:: · in background']);
  const shell = describeTool(tool('Shell: node --check scripts/bench/memory.mjs', 'ok', { output: '' }));
  assert.equal(shell.kind, 'shell');
  assert.notEqual(shell.verb, 'Used');
  // No row repeats its title after a generic verb.
  for (const [record] of cases) assert.doesNotMatch(plain(traceRowHtml(describeTool(record))), /^(Used|Using) /, record.name);
});

test('only image-capturing PandaCode tools get a thumbnail', () => {
  const mailbox = tool('pandacode_read_team_mailbox', { afterId: 0, limit: 20 }, { output: JSON.stringify({ messages: [{ id: 136, sender: 'w1', message: 'Raw caps in /Users/me/cap/png/sw_home_0.png have the banner baked in', createdAt: 1 }] }) });
  assert.equal(describeTool(mailbox).image, undefined);
  assert.doesNotMatch(toolPreview(mailbox), /tool-image-card/);
  const report = tool('pandacode_read_worker', { workerId: 'a5d9a188-1d4f-42eb-a422-ea9fdc8ebbef' }, { output: JSON.stringify({ id: 'a5d9a188-1d4f-42eb-a422-ea9fdc8ebbef', status: 'done', summary: 'Saved /tmp/shots/after.png', files: ['/tmp/shots/after.png'] }) });
  assert.equal(describeTool(report).image, undefined);
  const subs = tool('pandacode_sub_workers', { action: 'read', workerId: 'a5d9a188-1d4f-42eb-a422-ea9fdc8ebbef' }, { output: '{"status":"done","response":"see /tmp/x.png"}' });
  assert.equal(describeTool(subs).image, undefined);
  const sent = tool('pandacode_send_team_message', { recipient: 'architect', message: 'Shot at /tmp/a.png', key: 'k' }, { output: '{"saved":true}' });
  assert.equal(describeTool(sent).image, undefined);
  // An idea sketch carries no image, so its snapshot row has none.
  const idea = tool('pandacode_progress_snapshot', { svg: '<svg/>', title: 'Plan: dock' }, { output: '{"iteration":6,"saved":{"kind":"idea","title":"Plan: dock"}}' });
  assert.equal(describeTool(idea).image, undefined);
});

test('PandaCode team rows name workers by name or a short id, never a raw UUID', () => {
  const id = '8c1fda4d-7e29-4b70-966f-86517e8a5282';
  const sent = describeTool(tool('pandacode_send_team_message', { recipient: id, message: 'hi', key: 'k' }, { output: JSON.stringify({ recipient: id, saved: true, duplicate: false }) }));
  assert.deepEqual([sent.verb, sent.chip?.label, sent.chip?.title], ['Messaged worker', '8c1fda4d', id]);
  assert.equal(describeTool(tool('pandacode_send_team_message', { recipient: 'architect', message: 'hi' })).chip?.label, 'architect');
  const read = describeTool(tool('pandacode_read_worker', { workerId: id }, { output: JSON.stringify({ id, status: 'done' }) }));
  assert.deepEqual([read.verb, read.chip?.label, read.chip?.title, read.object], ['Read', undefined, undefined, "worker 8c1fda4d's report"]);
  const named = describeTool(tool('pandacode_read_worker', { workerId: id }, { output: JSON.stringify({ id, name: 'Rows: titles', status: 'done' }) }));
  assert.deepEqual([named.chip?.label, named.chip?.title], ['Rows: titles', id]);
  const follow = describeTool(tool('mcp__pandacode_architect__pandacode_followup_worker', { workerId: id, prompt: 'Third round', key: 'k' }, { output: JSON.stringify({ queued: true, workerId: id }) }));
  assert.deepEqual([follow.verb, follow.chip?.label, follow.note], ['Followed up with', '8c1fda4d', 'Third round']);
  const cancel = describeTool(tool('pandacode_cancel_worker', { workerId: id, reason: 'Stopped by a restart' }, { output: JSON.stringify({ abandoned: true, status: 'stopped', workerId: id }) }));
  assert.deepEqual([cancel.verb, cancel.chip?.label], ['Cancelled', '8c1fda4d']);
  const devin = describeTool(tool('Called pandacode_send_team_message from pandacode_architect', { recipient: id, message: 'hi' }));
  assert.equal(devin.chip?.label, '8c1fda4d');
});

test('PandaCode sub workers, progress snapshots and model routing', () => {
  const id = 'ac959d34-1ecf-4794-b642-70fd17bdaf59';
  const list = tool('pandacode_sub_workers', { action: 'list' }, { output: JSON.stringify({ maxRounds: 8, round: 3, status: 'waiting', workers: [{ id, name: 'Scene audit', status: 'running', summary: 'audit r5 PASS' }] }) });
  assert.deepEqual(row(list), ['Checked sub-workers', undefined, '· 1 worker']);
  assert.match(toolPreview(list), /Scene audit/);
  const read = tool('pandacode_sub_workers', { action: 'read', workerId: id }, { output: JSON.stringify({ id, status: 'running', response: 'Running s_train settled r7', files: ['a.py'] }) });
  assert.deepEqual(row(read), ['Read', undefined, "sub-worker ac959d34's report"]);
  assert.match(toolPreview(read), /Running s_train settled r7/);
  const failed = tool('pandacode_sub_workers', { action: 'read', workerId: id }, { status: 'failed', output: 'Worker does not belong to this team.' });
  assert.deepEqual(row(failed), ["Couldn't read", undefined, "sub-worker ac959d34's report"]);
  assert.match(toolPreview(failed), /Worker does not belong to this team\./);
  const follow = tool('pandacode_sub_workers', { action: 'followup', workerId: id, key: 'k', prompt: 'Keep the rubric unchanged.' }, { output: 'Wait for this worker to settle before following up.' });
  assert.deepEqual(row(follow), ['Followed up with sub-worker', 'ac959d34', '“Keep the rubric unchanged.”']);
  const cancel = tool('pandacode_sub_workers', { action: 'cancel', workerId: id, reason: 'Router picked a forbidden harness' }, { output: JSON.stringify({ abandoned: true, status: 'stopped', workerId: id }) });
  assert.deepEqual(row(cancel), ['Cancelled sub-worker', 'ac959d34', '“Router picked a forbidden harness”']);

  const snap = describeTool(tool('pandacode_progress_snapshot', { image: 'videos/thumb/infinite.png', note: 'Wide UI panel', title: 'INFINITE CONTEXT thumbnail' }, { output: '{"iteration":1,"saved":{"kind":"image","title":"INFINITE CONTEXT thumbnail"}}' }));
  assert.deepEqual([snap.verb, snap.image, snap.object], ['Posted progress snapshot', 'videos/thumb/infinite.png', 'INFINITE CONTEXT thumbnail']);
  assert.match(traceRowHtml(snap), /Posted progress snapshot<\/span><span class="tool-trace-image is-compact">.*INFINITE CONTEXT thumbnail/);

  const tasks = [{ files: 0, text: 'Audit Devin usage in the last 28 days' }, { files: 2, text: 'Operate the Traycer GUI' }];
  const routed = { profiler: 'onnx', tasks: [
    { category: 'analysis', difficulty: 4, pick: { model: 'gpt-6-luna', name: 'GPT-6-Luna · Codex', pSuccess: 0.89, provider: 'codex' }, alternatives: [] },
    { category: 'implementation', difficulty: 6, pick: { model: 'sonnet', name: 'Claude Sonnet 5.5 · Claude Code', pSuccess: 0.21, provider: 'claude' }, alternatives: [] },
  ] };
  const route = tool('pandacode_route_models', { tasks }, { output: JSON.stringify(routed) });
  assert.deepEqual(row(route), ['Previewed model routing', undefined, '· 2 tasks']);
  const card = toolPreview(route);
  assert.match(card, /Audit Devin usage in the last 28 days/);
  assert.match(card, /GPT-6-Luna · Codex/);
  assert.match(card, /Claude Sonnet 5\.5 · Claude Code/);
  // A wake's inbox rides along on the answer; the picks still come from `tasks`.
  const withInbox = tool('pandacode_route_models', { tasks: tasks.slice(0, 1) }, { output: JSON.stringify({ inbox: { newest: [], unread: 0 }, ...routed, tasks: routed.tasks.slice(0, 1) }) });
  assert.deepEqual(row(withInbox), ['Previewed model routing', undefined, '· GPT-6-Luna · Codex']);
});

test('Codex GitHub app calls read from their own tool name', () => {
  const app = (name, input, output = 'Action completed. {}') => tool(`codex_apps · github.${name}`, input, { output });
  assert.deepEqual(row(app('fetch_workflow_run_jobs', { repo_full_name: 'aicodeking/pandacode', run_id: 42462913784 })), ['Fetched', 'GitHub', 'workflow run jobs for aicodeking/pandacode']);
  assert.deepEqual(row(app('fetch_workflow_job_logs', { job_id: 128675895811, repo_full_name: 'aicodeking/pandacode' })), ['Fetched', 'GitHub', 'workflow job logs for aicodeking/pandacode']);
  assert.deepEqual(row(app('fetch_issue', { issue_number: 342, repository_full_name: 'aicodeking/pandacode' })), ['Fetched', 'GitHub', 'issue #342 in aicodeking/pandacode']);
  assert.deepEqual(row(app('fetch_issue_comments', { issue_number: 331, repo_full_name: 'aicodeking/pandacode' })), ['Fetched', 'GitHub', 'issue comments #331 in aicodeking/pandacode']);
  assert.deepEqual(row(app('fetch_pr', { pr_number: 138, repo_full_name: 'aicodeking/pandacode' })), ['Fetched', 'GitHub', 'PR #138 in aicodeking/pandacode']);
  assert.deepEqual(row(app('fetch_file', { path: 'apps/server/src/tools.ts', ref: '8e6a732', repository_full_name: 'pingdotgg/t3code' })), ['Fetched', 'GitHub', 'tools.ts from pingdotgg/t3code']);
  assert.deepEqual(row(app('get_pr_diff', { format: 'patch', pr_number: 332, repo_full_name: 'aicodeking/pandacode' })), ['Fetched', 'GitHub', 'PR diff #332 in aicodeking/pandacode']);
  assert.deepEqual(row(app('search_issues', { query: 'repo:aicodeking/pandacode is:issue is:open', topn: 100 })), ['Searched', 'GitHub', 'issues for repo:aicodeking/pandacode is:issue is:open']);
  assert.deepEqual(row(app('list_pull_request_reviews', { pr_number: 337, repo_full_name: 'aicodeking/pandacode' })), ['Listed', 'GitHub', 'pull request reviews #337 in aicodeking/pandacode']);
  assert.deepEqual(row(app('search_branches', { query: 'main', owner: 'aicodeking', repo_name: 'pandacode' })), ['Searched', 'GitHub', 'branches for main in aicodeking/pandacode']);
  const failed = describeTool({ ...app('fetch_issue', { issue_number: 1, repo_full_name: 'a/b' }), status: 'failed' });
  assert.equal(failed.verb, "Couldn't fetch");
  // The URL form keeps its own row.
  assert.deepEqual(row(app('fetch', { url: 'https://api.github.com/repos/pingdotgg/t3code/git/ref/heads/main' })).slice(0, 2), ['Fetched', 'GitHub']);
});

test('a destructive shell intent carries a quiet danger badge', async () => {
  const shellIntent = await import('../src/shell-intent.ts');
  const intent = shellIntent.describeShell('git push --force origin main');
  const trace = describeTool(tool('Bash', { command: 'git push --force origin main' }));
  assert.equal(Boolean(trace.destructive), Boolean(intent.destructive));
  if ('destructive' in intent) assert.equal(trace.destructive, true);
  assert.match(traceRowHtml(trace), intent.destructive ? /is-danger" tabindex="0" role="note" data-trace-badge aria-label="Destructive: [^"]+" data-trace-risks="[^"]+" data-trace-tip="[^"]+">destructive</ : /^(?!.*is-danger)/);
  const html = traceRowHtml({ kind: 'shell', verb: 'Force-pushed', chip: { icon: 'git', label: 'main', title: 'git push --force origin main' }, object: '', destructive: true });
  assert.match(html, /<span class="tool-trace-badge is-danger" tabindex="0" role="note" data-trace-badge aria-label="Destructive: (?:[^"]+: )?git push --force origin main" data-trace-risks="[^"]+" data-trace-tip="(?:[^"]+: )?git push --force origin main">destructive<\/span>$/);
  assert.doesNotMatch(traceRowHtml({ kind: 'shell', verb: 'Ran', object: '' }), /is-danger/);
});

test('verbs the shell worker adds have running and failed forms', () => {
  const cases = [
    ['Force-pushed', 'Force-pushing', "Couldn't force-push"], ['Overwrote', 'Overwriting', "Couldn't overwrite"],
    ['Emptied', 'Emptying', "Couldn't empty"], ['Discarded changes in', 'Discarding changes in', "Couldn't discard changes in"],
    ['Dropped stash', 'Dropping stash', "Couldn't drop stash"], ['Reset', 'Resetting', "Couldn't reset"],
    ['Deleted branch', 'Deleting branch', "Couldn't delete branch"], ['Deleted tag', 'Deleting tag', "Couldn't delete tag"],
    ['Deleted remote branch', 'Deleting remote branch', "Couldn't delete remote branch"], ['Waited for', 'Waiting for', "Couldn't wait for"],
    ['Edited with Python', 'Editing with Python', "Couldn't edit with Python"],
  ];
  for (const [past, running, failed] of cases) {
    assert.equal(shellRunningVerb(past), running, past);
    assert.equal(failedVerb(running), failed, past);
  }
});

// --- Rows: summary counts, search wording, polish -------------------------------------------------

test('group summaries count what got done; failures are only tallies', () => {
  const ok = tool('Bash', { command: 'ls' });
  const bad = tool('Bash', { command: 'ls missing' }, { output: 'Exit code: 1\nOutput:\nno such file' });
  assert.equal(summarizeTools([ok, ok, bad, bad, bad]), 'Ran 2 commands · 3 failed');
  assert.equal(summarizeTools([ok, { ...ok, status: 'running' }], { live: true }), 'Ran 2 commands · 1 running');
  assert.equal(summarizeTools([ok, { ...ok, status: 'running' }, { ...ok, status: 'failed' }], { live: true }), 'Ran 2 commands · 1 running · 1 failed');
  assert.equal(summarizeTools([{ ...ok, status: 'running' }, { ...ok, status: 'failed' }], { live: true }), 'Running 1 command… · 1 failed');
  assert.equal(summarizeTools([{ ...ok, status: 'failed' }, { ...ok, status: 'failed' }]), "Couldn't run 2 commands");
});

test('searches read one way from every provider: `Searched for “x” in [where]`, globs `Found files matching`', () => {
  const words = record => { const t = describeTool(record); return [t.verb, t.object, t.chip?.label]; };
  // Claude
  assert.deepEqual(words(tool('Grep', { pattern: 'pandacode_', path: 'src-tauri/src' })), ['Searched', 'for “pandacode_” in', 'src']);
  assert.deepEqual(words(tool('Grep', { pattern: 'TODO' })), ['Searched', 'for “TODO”', undefined]);
  assert.deepEqual(words(tool('Glob', { pattern: '*.ts', path: 'src' })), ['Found', 'files matching “*.ts” in', 'src']);
  // muse: `paths` and `include` name where it looked.
  assert.deepEqual(words(tool('search', { pattern: 'PandaCode', paths: ['src/a.ts'], output_mode: 'files_with_matches' })), ['Searched', 'for “PandaCode” in', 'a.ts']);
  assert.deepEqual(words(tool('search', { pattern: 'x', paths: ['src', 'tests', 'docs'] })), ['Searched', 'for “x” in', '3 paths']);
  assert.equal(describeTool(tool('search', { pattern: 'x', paths: ['src', 'docs'] })).chip.title, 'src, docs');
  assert.deepEqual(words(tool('search', { pattern: 'x', include: '*.rs' })), ['Searched', 'for “x” in', '*.rs']);
  // Kimi: the pattern leads, the folder follows.
  assert.deepEqual(words(tool('Searching **/*', { path: '/Users/me/runs/project', pattern: '**/*', head_limit: 200 })), ['Found', 'files matching “**/*” in', 'project']);
  // Devin titles, one of them already quoting a pattern that contains quotes.
  assert.deepEqual(words(tool('Searched for localStorage|classic in ./src/palette.ts', '7: saved')), ['Searched', 'for “localStorage|classic” in', 'palette.ts']);
  const quoted = describeTool(tool('Searched for “name”: "pandacode_[a-z_]+" in /tmp/x/content.txt', '"name": "pandacode_a"'));
  assert.equal(quoted.object, 'for “name”: "pandacode_[a-z_]+" in');
  assert.ok(!quoted.object.includes('""'));
  assert.deepEqual(words(tool("Search for 'PandaConnect'", { path: '/Users/me/PandaCode', query: 'PandaConnect' })), ['Searched', 'for “PandaConnect” in', 'PandaCode']);
  // Command Code globs.
  assert.deepEqual(words(tool('Glob: scripts/bench/**/*', { path: '/Users/me/PandaCode', pattern: 'scripts/bench/**/*' })), ['Found', 'files matching “scripts/bench/**/*” in', 'PandaCode']);
  // The place comes after the pattern in the sentence; failures keep `Couldn't`.
  const html = traceRowHtml(describeTool(tool('Grep', { pattern: 'a', path: 'src' })));
  assert.ok(html.indexOf('tool-trace-object') < html.indexOf('tool-trace-chip'));
  assert.equal(describeTool(tool('Grep', { pattern: 'a', path: 'src' }, { status: 'failed' })).verb, "Couldn't search");
  assert.equal(describeTool(tool('Glob', { pattern: 'a' }, { status: 'failed' })).verb, "Couldn't find");
});

test('`+N more commands` is muted text of its own, outside the mono object', () => {
  const trace = describeTool(tool('Bash', { command: 'git add . && git commit -m "x" && git push' }));
  assert.equal(trace.more, '+1 more command');
  assert.ok(!trace.object.includes('more'));
  const html = traceRowHtml(trace);
  assert.match(html, /<span class="tool-trace-more-steps">\+1 more command<\/span>/);
  assert.ok(!/is-mono[^<]*more/.test(html));
  const bare = describeTool(tool('Bash', { command: 'npm test && npm run lint && npx tsc' }));
  assert.equal(bare.object, '');
  assert.equal(bare.more, '+2 more commands');
});

test('the destructive badge says why, and new shell verbs have running and failed forms', () => {
  const trace = describeTool(tool('Bash', { command: 'rm -rf src && npm run build' }));
  assert.equal(trace.destructive, true);
  const risks = (trace.risks?.length ? trace.risks.join('; ') : 'rm -rf src && npm run build').replace(/&/g, '&amp;');
  assert.ok(traceRowHtml(trace).includes(`aria-label="Destructive: ${risks}" data-trace-risks="`));
  assert.ok(traceRowHtml(trace).includes(`data-trace-tip="${risks}">destructive<`));
  for (const [verb, running, failed] of [
    ['Synced', 'Syncing', "Couldn't sync"], ['Linted', 'Linting', "Couldn't lint"], ['Inspected', 'Inspecting', "Couldn't inspect"],
    ['Changed directory', 'Changing directory', "Couldn't change directory"], ['Added', 'Adding', "Couldn't add"], ['Sent', 'Sending', "Couldn't send"],
    ['Queried', 'Querying', "Couldn't query"], ['Fetched', 'Fetching', "Couldn't fetch"], ['Formatted', 'Formatting', "Couldn't format"],
    ['Edited with Python', 'Editing with Python', "Couldn't edit with Python"], ['Read with Python', 'Reading with Python', "Couldn't read with Python"],
    ['Downloaded', 'Downloading', "Couldn't download"], ['Renamed', 'Renaming', "Couldn't rename"], ['Deployed', 'Deploying', "Couldn't deploy"],
  ]) {
    assert.equal(shellRunningVerb(verb), running, verb);
    assert.equal(failedVerb(running), failed, verb);
  }
  for (const lead of Object.keys(BASE)) assert.equal(failedVerb(shellRunningVerb(lead)), `Couldn't ${BASE[lead]}`, lead);
});

test('progress snapshots: titled rows show only the thumbnail and title; marks show label and tone', () => {
  const snap = tool('pandacode_progress_snapshot', {
    title: 'Live window', image: '/tmp/shots/live.png',
    annotations: [{ type: 'box', label: 'YouTube running live', tone: 'success', x: 0.2, y: 0.2, w: 0.7, h: 0.7 }, { type: 'box', label: 'Key path', tone: 'warning' }],
  }, { output: JSON.stringify({ iteration: 8 }) });
  const html = traceRowHtml(describeTool(snap));
  assert.match(html, /tool-trace-image is-compact/);
  assert.match(html, /title="\/tmp\/shots\/live\.png"/);
  assert.match(html, /tool-trace-object">Live window</);
  const card = toolPreview(snap);
  assert.ok(!/>box</.test(card));
  assert.match(card, /data-mark-tone="success"[^>]*><\/span>YouTube running live/);
  assert.match(card, /data-mark-tone="warning"/);
  // Untitled, the thumbnail keeps its file name.
  assert.doesNotMatch(traceRowHtml(describeTool(tool('pandacode_progress_snapshot', { image: '/tmp/shots/live.png' }))), /is-compact/);
});

test('Codex sleep without a duration waits briefly; a cut team directory still lists its members', () => {
  assert.deepEqual(row(tool('sleep', '')), ['Waited', undefined, 'briefly']);
  assert.deepEqual(row(tool('sleep', { durationMs: 2000 })), ['Waited', undefined, '2s']);
  const workers = [
    { files: ['src-tauri/src/skill_manager.rs'], id: '2d5b8341-ce5e-4483-b0f6-9f4771c161cc', name: 'Skill manager native backend', readOnly: false, status: 'completed' },
    { files: ['src/skill-manager.ts'], id: '66b55ef0-6e23-49bb-bc79-c5ddc925951f', name: 'Skill manager UI', readOnly: false, status: 'running' },
    { files: ['src/skill-manager.ts', 'src/skill-manager-add.ts'], id: 'cbc3bc33-9fb9-4a15-9fd6-a9f3445c8eab', name: 'Skills add flow', status: 'comp' },
  ];
  const full = JSON.stringify({ architect: { id: 'architect', status: 'waiting' }, nextOffset: null, workers });
  const cut = tool('pandacode_team_directory', {}, { output: full.slice(0, full.indexOf('"status":"comp"') + 12) });
  const card = toolPreview(cut);
  assert.match(card, /tool-trace-roster/);
  assert.match(card, /Skill manager native backend/);
  assert.match(card, /Skill manager UI/);
  assert.match(card, /trace-partial/);
  assert.match(describeTool(cut).object, /teammates/);
});
