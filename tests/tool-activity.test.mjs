import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeToolActivity, groupToolRuns, renderToolActivity, renderToolGroup, renderToolStatus } from '../src/tool-activity.ts';
import { toolPreview } from '../src/tool-trace.ts';

const activity = {
  id: 'call-1', name: 'Bash', status: 'completed',
  input: '{"command":"npm run test"}', output: '12 tests passed\nFinished in 0.4s',
};
const stored = value => JSON.stringify({ type: 'tool_activity', version: 1, ...value });

test('decodes only supported, bounded tool records', () => {
  assert.deepEqual(decodeToolActivity(stored(activity)), activity);
  assert.equal(decodeToolActivity(stored({ ...activity, id: 'x'.repeat(293) }))?.id.length, 293);
  for (const value of [
    'Bash', '{}', '{', JSON.stringify(activity),
    stored({ ...activity, status: 'unknown' }),
    stored({ ...activity, input: {} }),
    stored({ ...activity, output: 'x'.repeat(20_001) }),
    stored({ ...activity, id: 'x'.repeat(513) }),
    stored({ ...activity, name: 'x'.repeat(257) }),
    JSON.stringify({ ...activity, type: 'tool_activity', version: 2 }),
    ' '.repeat(100_001),
  ]) assert.equal(decodeToolActivity(value), undefined);
});

test('renders the command and recorded output with a stable disclosure key', () => {
  // A rich card is an excerpt, so the raw record stays one click away; a PandaCode card that shows everything drops it.
  assert.match(renderToolActivity(stored(activity), 'short'), /tool-trace-raw/);
  assert.ok(!renderToolActivity({ ...activity, name: 'pandacode_vm_list', input: '{}', output: '{"vms":[]}' }, 'own').includes('tool-trace-raw'));
  const long = { ...activity, output: activity.output + '\n' + Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') };
  const html = renderToolActivity(stored(long), 'message-5');
  assert.match(html, /data-tool-key="message-5"/);
  assert.match(html, /data-tool-status="completed"/);
  assert.match(html, /tool-trace-verb">Ran<\/span><span class="tool-trace-chip" title="npm run test">/);
  assert.match(html, /tool-trace-object is-mono">run test</);
  assert.match(html, /data-tool-kind="shell" data-tool-name="Bash"/);
  assert.ok(html.includes(toolPreview(long).replace('<!--trace-partial-->', '')));
  assert.match(html, /<div class="tool-trace-frame"><div class="tool-trace-card"[\s\S]*<\/div><details class="tool-trace-raw"><summary aria-label="Raw input and output"[\s\S]*<\/details><\/div><\/div><\/details>$/);
  assert.doesNotMatch(html, /Raw input\/output/);
  assert.match(html, /data-tool-section="input"/);
  assert.match(html, /data-tool-section="output"/);
  assert.match(html, /12 tests passed\nFinished in 0.4s/);
});

test('tool payloads and keys cannot introduce HTML or delegated actions', () => {
  const unsafe = '<button data-action="commit">do it</button>';
  const html = renderToolActivity({ ...activity, name: unsafe, input: unsafe, output: unsafe }, 'x" onclick="bad');
  assert.ok(!html.includes('<button'));
  assert.ok(!html.includes('data-tool-key="x" onclick='));
  assert.match(html, /&lt;button data-action=&quot;commit&quot;&gt;/);
});

test('legacy disclosures avoid repeating their summary as the expanded body', () => {
  const html = renderToolActivity('Read src/main.ts\nexport const answer = 42;', 'old-1');
  assert.equal(html.match(/Read src\/main.ts/g)?.length, 1);
  assert.match(html, /tool-activity-legacy-body/);
  assert.match(html, /export const answer = 42;/);
  assert.match(renderToolActivity('Read src/main.ts', 'old-2'), /Details were not recorded for this earlier tool call\./);
});

test('status events have no empty disclosure and empty tool output is explained', () => {
  const html = renderToolStatus('Connected <script>');
  assert.ok(!html.includes('<details'));
  assert.match(html, /Connected &lt;script&gt;/);
  assert.match(renderToolActivity({ ...activity, input: '', output: '', status: 'running' }, 'live'), /Waiting for tool details/);
  // A silent successful command is explained by the row itself: a plain line, nothing to expand.
  const silent = renderToolActivity({ ...activity, output: '' }, 'done');
  assert.ok(!silent.includes('tool-activity-note'));
  assert.ok(!silent.includes('<details'));
  // A running card shows its own placeholder, so no second "waiting" line jumps away when output lands.
  assert.doesNotMatch(renderToolActivity({ ...activity, output: '', status: 'running' }, 'live'), /Waiting for output/);
  assert.match(renderToolActivity({ ...activity, output: '', status: 'failed' }, 'bad'), /No output was recorded/);
});

test('a failed call says so once (red icon + card badge), and a card-less record shows its raw sections open', () => {
  const failed = renderToolActivity({ ...activity, status: 'failed', output: 'boom' }, 'f');
  assert.doesNotMatch(failed, /tool-activity-status/);
  assert.match(failed, /tc-badge is-failed/);
  assert.match(renderToolActivity({ ...activity, name: 'odd_tool', input: 'x', output: '' }, 'o'), /<details class="tool-trace-raw" open>/);
});

test('groups at most five consecutive calls without crossing narratives or statuses', () => {
  const tools = Array.from({ length: 7 }, (_, i) => ({ key: `call-${i}`, role: 'tool' }));
  const intro = { role: 'assistant', text: 'Inspecting the project' };
  const update = { role: 'assistant', text: 'Found the issue' };
  const status = { role: 'status', text: 'Context compacted' };
  const entries = [intro, ...tools.slice(0, 6), update, tools[6], status, tools[0]];
  const runs = groupToolRuns(entries, entry => entry.role === 'tool' ? entry.key : undefined);
  assert.deepEqual(runs.map(run => run.kind === 'tools' ? run.items.length : run.item.text),
    ['Inspecting the project', 5, 1, 'Found the issue', 1, 'Context compacted', 1]);
  assert.equal(runs[1].key, 'call-0');
  assert.equal(runs[2].key, 'call-5');
  assert.deepEqual(runs.flatMap(run => run.kind === 'tools' ? run.items : [run.item]), entries);
  assert.deepEqual(groupToolRuns([], () => undefined), []);
});

test('group summaries count calls, expose running/failure states and escape tool keys', () => {
  const html = renderToolGroup([
    { key: 'x" onclick="bad', content: { ...activity, status: 'running' } },
    { key: 'read', content: stored({ ...activity, id: 'read', name: 'Read', status: 'failed' }) },
  ]);
  // Completed calls lead; the running one and the failure are counted apart.
  assert.match(html, /tool-group-label">Ran 1 command</);
  assert.match(html, /tool-group-status has-failure"> · 1 failed</);
  const live = renderToolGroup([{ key: 'run', content: { ...activity, status: 'running' } }, { key: 'read', content: stored({ ...activity, id: 'read', name: 'Read', status: 'failed' }) }], false, true);
  assert.match(live, /tool-group-label">Running 1 command…</);
  assert.match(live, /tool-group-status has-failure"> · 1 failed</);
  assert.match(html, /tool-group-status has-failure"> · 1 failed</);
  assert.match(html, /tool-trace-stack/);
  assert.ok(!html.includes('data-tool-group-key="group:x" onclick='));
  assert.equal(html.match(/class="tool-activity tool-trace"/g)?.length, 2);
  assert.match(renderToolGroup([{ key: 'legacy', content: 'Read README.md' }]), /tool-group-label">Used 1 tool</);
  assert.match(renderToolGroup([{ key: 'a', content: activity }, { key: 'b', content: activity }]), /tool-group-label">Ran 2 commands</);
  assert.equal(renderToolGroup([]), '');
});

test('Codex image views expose a safe image preview action', () => {
  const html = renderToolActivity({ ...activity, name:'view_image', input:JSON.stringify({path:'output/scene "one".png'}), output:'' }, 'image-1');
  assert.match(html, /data-action="view-tool-image"/);
  assert.match(html, /data-path="output\/scene &quot;one&quot;\.png"/);
  assert.match(html, /data-tool-image="call-1"/);
});
