import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, parseFields, summarizeTools, toolPreview, traceKind, traceRowHtml } from '../src/tool-trace.ts';
import { parseFields as sharedParseFields } from '../src/tool-fields.ts';

// Record shapes copied from the real database (role='tool' messages), home paths anonymized to /Users/me.
const record = (name, input, output = '', status = 'completed') => ({ name, status, input, output });
const json = value => JSON.stringify(value, null, 2);
// Free text a row quotes after its sentence (`note`) reads as `“…”` here.
const row = tool => { const t = describeTool(tool); return [t.verb, t.chip?.label, t.object + (t.note ? `“${t.note}”` : '')]; };
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const CUT = '\n[Preview truncated]';

// --- 1. Truncated inputs -------------------------------------------------------------------

test('a cut JSON input keeps its leading fields and is marked partial', () => {
  const input = '{"command": "cd /Users/me/PandaCode; python3 - <<\'EOF\'\\np=\'src/architect.ts\'; s=open(p).read()\\ns=s.replace(\'\'\'<strong>Workers</strong><span class=\\"architect-panel-summary\\"></spa' + CUT;
  const fields = parseFields(input);
  assert.equal(fields._partial, true);
  assert.match(fields.command, /^cd \/Users\/me\/PandaCode; python3 - <<'EOF'\np='src\/architect.ts'/);
  assert.match(fields.command, /class="architect-panel-summary"><\/spa$/);
  assert.equal(sharedParseFields, parseFields, 'one shared implementation');
  assert.deepEqual(parseFields('{"a": "b"}'), { a: 'b' }, 'whole JSON is not marked');
  assert.deepEqual(parseFields('plain text'), {});
  assert.deepEqual(parseFields('{"__proto__": {"x": 1}, "path": "/a' + CUT), { path: '/a', _partial: true });
  assert.deepEqual(parseFields('{"key": "a\\u00e9\\n\\"q\\"", "n": 12, "ok": tr' + CUT), { key: 'aé\n"q"', n: 12, _partial: true });
});

test('Claude Bash, Write and dispatch_workers with cut inputs still describe themselves', () => {
  const bash = record('Bash', '{"command": "cd /Users/me/PandaCode && npx tsc --noEmit && node --test tests/a.test.mjs && echo ' + 'x'.repeat(4000) + CUT, 'ok');
  assert.equal(traceKind(bash), 'shell');
  assert.notEqual(describeTool(bash).verb, 'Used');
  assert.ok(describeTool(bash).chip, 'the command has a program chip');

  const write = record('Write', '{"file_path": "/Users/me/Vault/setup/freeze_inputs.py", "content": "#!/usr/bin/env python3\\n\\"\\"\\"Copy benchmark inputs once.\\"\\"\\"\\nimport datetime as dt\\nimport hashlib\\nimport json\\nfor field in [\'read\',\'write\']:out[\'usage\'][\'cache_\'+field' + CUT,
    'File created successfully at: /Users/me/Vault/setup/freeze_inputs.py');
  const trace = describeTool(write);
  assert.deepEqual([trace.verb, trace.chip?.label, trace.chip?.title], ['Wrote', 'freeze_inputs.py', '/Users/me/Vault/setup/freeze_inputs.py']);
  assert.equal(trace.object, '· 6+ lines', 'a cut file says its line count is a lower bound');
  assert.match(toolPreview(write), /^<!--trace-partial-->/);

  const dispatch = record('pandacode_dispatch_workers', '{\n  "assignments": [\n    {\n      "files": [\n        "src-tauri/src/vm.rs"\n      ],\n      "key": "clippy-vm",\n      "name": "Clippy + VM idle (#2, #4)",\n      "profileId": "claude-sonnet",\n      "prompt": "Fix two GitHub issues"\n    },\n    {\n      "key": "approvals",\n      "name": "Approvals",\n      "prompt": "Full-access mode runs every approval tool without asking — including `pandacode_' + CUT);
  assert.deepEqual(row(dispatch), ['Dispatched', undefined, '2 workers']);
  assert.match(plain(toolPreview(dispatch)), /Clippy \+ VM idle/);
});

// --- 2. Legacy Codex imageView and webSearch --------------------------------------------------

test('legacy Codex imageView and webSearch read as images and web searches', () => {
  const view = record('imageView', '');
  assert.equal(traceKind(view), 'image');
  assert.deepEqual(row(view), ['Viewed image', undefined, '']);
  const trace = describeTool(view);
  assert.equal(trace.image, undefined, 'no path, no thumbnail');
  assert.doesNotMatch(traceRowHtml(trace), /tool-image-thumb/);
  assert.equal(summarizeTools([view, view]), 'Viewed 2 images');
  assert.equal(toolPreview(view), '<!--trace-complete-->');

  const search = record('webSearch', '');
  assert.equal(traceKind(search), 'web');
  assert.deepEqual(row(search), ['Searched the web', undefined, '']);
  assert.equal(toolPreview(search), '<!--trace-complete-->');
});

// --- 3. Devin `Ran …` rows whose input is the output ------------------------------------------

test('Devin Ran rows name programs from the title and show the input as output', () => {
  const grep = record('Ran grep', 'worktrees.css:7:@container composer (max-width:560px){.composer-context .composer-local{display:none}.composer-context.\u001b[0mc\u001b[0m\nomposer-context-compact{gap:10px}}');
  const trace = describeTool(grep);
  assert.deepEqual([trace.kind, trace.verb, trace.chips?.map(c => c.label), trace.object], ['shell', 'Ran', ['grep'], '']);
  const card = toolPreview(grep);
  assert.match(card, /worktrees\.css:7/);
  assert.doesNotMatch(card, /\u001b/);

  const two = describeTool(record('Ran python3, rg', 'ok anchor\nok ship\n56:class Shot:'));
  assert.deepEqual(two.chips?.map(c => c.label), ['python3', 'rg']);
  const where = describeTool(record('Ran cargo, grep in ./src-tauri', 'error[E0433]: failed to resolve', 'error[E0433]: failed to resolve'));
  assert.deepEqual([where.chips?.map(c => c.label), where.object], [['cargo', 'grep'], 'in ./src-tauri']);
  assert.match(plain(traceRowHtml(where)), /^Ran cargo and grep in \.\/src-tauri$/);

  // A real command in JSON stays a command.
  const git = record('Ran git', '{\n  "command": "git status --short",\n  "workdir": "/Users/me/PandaCode"\n}');
  assert.equal(describeTool(git).chip?.label, 'git status');
  assert.equal(describeTool(git).chips, undefined);
  // JSON that is not a command is output too.
  const rect = describeTool(record('Ran mkdir, cp, node', '{"composer":{"x":235,"y":702.9375}}\na-new-task.png'));
  assert.deepEqual(rect.chips?.map(c => c.label), ['mkdir', 'cp', 'node']);
});

// --- 4. Devin Edit file and the edit delta ---------------------------------------------------------

test('Devin Edit file: file chip from the first line, real counts, no false +0 −0', () => {
  const edit = record('Edit file', '/Users/me/PandaOrchestrator/panda_router/model/__init__.py\n--- Before\n"""Panda Router task-profiler model."""\n\nHEAD_ORDER = ["category", "difficulty"]\n\n+++ After\n"""Panda Router task-profiler model."""\n\nHEAD_ORDER = ["category", "difficulty"]\n\n\ndef __getattr__(name):\n    raise AttributeError(name)\n');
  const trace = describeTool(edit);
  // Two blank lines and the new function: four added lines after the shared head.
  assert.deepEqual([trace.kind, trace.verb, trace.chip?.label, trace.added, trace.removed], ['edit', 'Edited', '__init__.py', 4, 0]);
  assert.match(traceRowHtml(trace), /<span class="tool-trace-delta"><ins>\+4<\/ins> <del>−0<\/del><\/span>/);

  const cut = record('Edit file', '/Users/me/videos/.work/s_refresh.py\n--- Before\n"""Refresher."""\nfrom core import *\ndef W(p, end=False): return tx.at(p, end=end)' + CUT);
  const partial = describeTool(cut);
  assert.deepEqual([partial.chip?.label, partial.added, partial.removed], ['s_refresh.py', undefined, undefined]);
  assert.doesNotMatch(traceRowHtml(partial), /tool-trace-delta/);
  // An edit without any old or new text never claims +0 −0.
  const bare = describeTool(record('Edit', json({ file_path: '/Users/me/a.ts' })));
  assert.doesNotMatch(traceRowHtml(bare), /tool-trace-delta/);
});

// --- 5. Codex legacy Update files -------------------------------------------------------------

test('Codex Update files reads as an edit with a diff', () => {
  const update = record('Update files', 'update /Users/me/pc/src-tauri/src/ssh_hosts/probe.rs\nupdate /Users/me/pc/src-tauri/src/ssh_hosts/tests.rs',
    '/Users/me/pc/src-tauri/src/ssh_hosts/probe.rs\n@@ -209,3 +209,3 @@\n     let claude_facts=if matches!(provider,"claude") {\n-        format!(r#"{program} auth status"#\n+        format!(r#"{program} auth status | tr -d"#\n/Users/me/pc/src-tauri/src/ssh_hosts/tests.rs\n@@ -1,2 +1,3 @@\n use super::*;\n+use std::fs;\n');
  const trace = describeTool(update);
  assert.deepEqual([trace.kind, trace.verb, trace.chip?.label, trace.object, trace.added, trace.removed], ['edit', 'Edited', 'probe.rs', '+1 more file', 2, 1]);
  const card = plain(toolPreview(update));
  assert.match(card, /probe\.rs/);
  assert.match(card, /tr -d/);
  assert.match(card, /tests\.rs/);

  const add = record('Update files', 'add /Users/me/tv/themes/orange-pop/README.md', '/Users/me/tv/themes/orange-pop/README.md\n# Orange Pop (personal TV)\n\nOrange sky with cream clouds.\n');
  const added = describeTool(add);
  assert.deepEqual([added.chip?.label, added.added, added.removed], ['README.md', 3, 0]);
  assert.match(plain(toolPreview(add)), /Orange sky/);

  const cut = describeTool(record('Update files', 'update /Users/me/pc/a.rs', '/Users/me/pc/a.rs\n@@ -1,2 +1,2 @@\n-a\n+b' + CUT));
  assert.deepEqual([cut.chip?.label, cut.added], ['a.rs', undefined]);
  // Every file an update touched counts: two updated, one added.
  assert.equal(summarizeTools([update, add]), 'Edited 3 files');
});

// --- 6. Team tools and GitHub fetches -------------------------------------------------------------

test('finish_team shows its summary and team_notes reads by action', () => {
  const finish = record('pandacode_finish_team', json({ summary: 'Performance round on top of the earlier orchestrator redesign; all uncommitted.\n\nMeasured before → after:\n- 50 KB streamed reply: 13.7 s → 2.3 s.' }));
  assert.deepEqual(row(finish), ['Finished team', undefined, '“Performance round on top of the earlier orchestrator redesign; all uncommitted.”']);

  const set = record('pandacode_team_notes', json({ action: 'set', key: 'boat-host-contract', value: 'From the module/gateway worker.' }), '{"saved":true}');
  assert.deepEqual(row(set), ['Saved team note', 'boat-host-contract', '']);
  assert.match(plain(toolPreview(set)), /From the module\/gateway worker\./);
  const get = record('pandacode_team_notes', json({ action: 'get', key: 'council-4-findings' }), '{"found":true,"note":{"author":"architect","key":"council-4-findings","value":"Three findings."}}');
  assert.deepEqual(row(get), ['Read team note', 'council-4-findings', '']);
  assert.match(plain(toolPreview(get)), /Three findings\./);
  assert.deepEqual(row(record('pandacode_team_notes', json({ action: 'list' }), '{"notes":[]}')), ['Read team notes', undefined, '']);
  const devin = record('Called pandacode_team_notes from pandacode_architect', json({ action: 'get', key: 'k1' }));
  assert.deepEqual(row(devin), ['Read team note', 'k1', '']);
  const failed = describeTool(record('pandacode_team_notes', json({ action: 'set', key: 'big', value: 'x' }), 'A note value must be under 1024 bytes.', 'failed'));
  assert.equal(failed.verb, "Couldn't save team note");
});

test('codex_apps github.fetch of raw files and contents names the file and repo', () => {
  const raw = record('codex_apps · github.fetch', json({ url: 'https://raw.githubusercontent.com/pingdotgg/t3code/09a54f01bc0ae83865347a965ced50f8c8ec2953/apps/server/src/mcp/handlers.ts' }), 'Action completed.\n{\n  "content": "import {\\n  BrowserNavigationTarget,\\n} from \\"./x\\";\\n"\n}');
  assert.deepEqual(row(raw), ['Fetched', 'GitHub', 'apps/server/src/mcp/handlers.ts from pingdotgg/t3code']);
  assert.match(plain(toolPreview(raw)), /BrowserNavigationTarget/);
  const contents = record('codex_apps · github.fetch', json({ url: 'https://api.github.com/repos/aicodeking/pandacode/contents/src/main.ts?ref=main' }));
  assert.deepEqual(row(contents), ['Fetched', 'GitHub', 'src/main.ts from aicodeking/pandacode']);
  const blob = record('codex_apps · github.fetch', json({ url: 'https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md' }));
  assert.deepEqual(row(blob), ['Fetched', 'GitHub', 'docs/user/outside-agents.md from pingdotgg/t3code']);
  const other = record('codex_apps · github.fetch', json({ url: 'https://github.com/sandbox-quantum/switch' }));
  assert.deepEqual(row(other), ['Fetched', 'GitHub', 'sandbox-quantum/switch']);
});

// --- 7. Summaries and wording ------------------------------------------------------------------------

test('summaries count generated images and agent waits by their own verbs', () => {
  const made = record('Generate image', json({ revisedPrompt: 'a panda' }), '/Users/me/.codex/generated_images/a.png');
  assert.equal(summarizeTools([made, made]), 'Generated 2 images');
  assert.equal(summarizeTools([made, record('imageView', '')]), 'Generated 1 image and viewed 1 image');
  const wait = record('Agent · wait', json({ receiverThreadIds: ['a', 'b'] }));
  const send = record('Agent · sendInput', json({ receiverThreadIds: ['a'], prompt: 'go on' }));
  assert.equal(summarizeTools([wait, wait]), 'Waited for agents');
  assert.equal(summarizeTools([send, wait]), 'Messaged agents and waited for agents');
  assert.equal(summarizeTools([record('Agent · spawnAgent', json({ prompt: 'x' }))]), 'Started 1 agent');
  assert.equal(describeTool(record('Agent · resumeAgent', json({ receiverThreadIds: ['a'] }), '', 'failed')).verb, "Couldn't resume agent");
});

test('review wording, one image size format and an inline BashOutput badge', () => {
  assert.deepEqual(row(record('Review', json({ review: 'current changes' }))), ['Started review', undefined, 'of current changes']);
  const devin = record('Read file', json({ file_path: '/tmp/d.png' }), 'View image /tmp/d.png (1920x1080)');
  assert.equal(describeTool(devin).object, '1920 × 1080');
  // Said once, in the row.
  assert.doesNotMatch(toolPreview(devin), /1920 × 1080/);
  const check = record('BashOutput', json({ bash_id: 'f50fcf' }), '<status>running</status>\n\n<stdout>\nbuilding…\nok 12\n</stdout>');
  assert.match(toolPreview(check), /<div class="tool-trace-card-head"><span class="tool-trace-chip"[^>]*><b>f50fcf<\/b><\/span><span class="tool-trace-badge is-live">running<\/span><\/div>/);
});

test('everything stays escaped', () => {
  const evil = record('Ran <img src=x>', '<script>alert(1)</script>');
  const html = traceRowHtml(describeTool(evil)) + toolPreview(evil);
  assert.doesNotMatch(html, /<script>|<img src/);
  const update = record('Update files', 'update /tmp/<b>.ts', '/tmp/<b>.ts\n@@ -1 +1 @@\n-<i>\n+<u>');
  assert.doesNotMatch(traceRowHtml(describeTool(update)) + toolPreview(update), /<b>\.ts|<i>|<u>/);
});
