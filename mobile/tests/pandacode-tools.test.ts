/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentsOf, imageOf, ownTool } from '../src/store/pandacode-tools.ts';
import { describeTool, traceText } from '../src/store/trace.ts';

const A = 'mcp__pandacode_architect__pandacode_';
const line = (name: string, input: unknown, status: 'running' | 'completed' = 'completed', names?: Record<string, string>) =>
  traceText(describeTool({ name, status, input: JSON.stringify(input) }, undefined, names));

test('own tools are recognised however the harness names them', () => {
  assert.equal(ownTool(`${A}dispatch_workers`), 'dispatch_workers');
  assert.equal(ownTool('pandacode_title'), 'title');
  assert.equal(ownTool('mcp__pandacode__pandacode_simulator_screenshot'), 'simulator_screenshot');
  assert.equal(ownTool('mcp__github__get_issue'), undefined);
  assert.equal(ownTool('Bash'), undefined);
});

test('team tools read as sentences, with worker names when the team is known', () => {
  const names = { w1: 'GPT-6' };
  assert.equal(line(`${A}dispatch_workers`, { assignments: [{}, {}, {}] }), 'Dispatched 3 workers');
  assert.equal(line(`${A}dispatch_workers`, { assignments: [{}] }, 'running'), 'Dispatching 1 worker');
  assert.equal(line(`${A}followup_worker`, { workerId: 'w1', prompt: 'x' }, 'completed', names), 'Asked GPT-6 for a follow-up');
  assert.equal(line(`${A}followup_worker`, { workerId: 'zz' }), 'Asked a worker for a follow-up');
  assert.equal(line(`${A}finish_team`, { summary: 'done' }), 'Finished the team');
  assert.equal(line(`${A}send_team_message`, { recipient: 'w1', message: 'hi' }, 'completed', names), 'Messaged GPT-6');
  assert.equal(line(`${A}send_team_message`, { recipient: 'architect', message: 'hi' }), 'Messaged the architect');
  assert.equal(line(`${A}read_team_mailbox`, {}), 'Read the team mailbox');
  assert.equal(line(`${A}cancel_worker`, { workerId: 'w1' }, 'completed', names), 'Cancelled GPT-6');
  assert.equal(line(`${A}read_worker`, { workerId: 'w1' }, 'completed', names), 'Checked on GPT-6');
  assert.equal(line(`${A}checkpoint_worker`, { summary: 's' }), 'Saved a checkpoint');
});

test('title, change tracking, simulator, VM and design tools', () => {
  assert.equal(line(`${A}title`, { title: 'Mobile agents view' }), 'Renamed thread to “Mobile agents view”');
  assert.equal(line(`${A}track_files`, { action: 'begin', paths: ['a', 'b', 'c', 'd'] }), 'Tracked 4 files');
  assert.equal(line(`${A}track_files`, { action: 'complete', paths: ['a'] }), 'Recorded 1 changed file');
  assert.equal(line(`${A}simulator_screenshot`, {}), 'Took a simulator screenshot');
  assert.equal(line(`${A}simulator_control`, { action: 'tap', x: 200, y: 618 }), 'Tapped (200, 618)');
  assert.equal(line(`${A}simulator_control`, { action: 'swipe', x: 1, y: 2, endX: 3, endY: 4 }, 'running'), 'Swiping (1, 2) → (3, 4)');
  assert.equal(line(`${A}simulator_control`, { action: 'type', text: 'hello' }), 'Typed “hello”');
  assert.equal(line(`${A}simulator_control`, { action: 'tap_label', label: 'Inbox' }), 'Tapped “Inbox”');
  assert.equal(line(`${A}simulator_manage`, { action: 'launch', bundleId: 'com.x' }), 'Launched com.x');
  assert.equal(line(`${A}simulator_manage`, { action: 'appearance', appearance: 'dark' }), 'Switched to dark mode');
  assert.equal(line(`${A}vm_control`, { action: 'click', x: 5, y: 6 }), 'Clicked (5, 6)');
  assert.equal(line(`${A}vm_manage`, { action: 'start', name: 'dev' }), 'Started VM dev');
  assert.equal(line(`${A}design_write`, { name: 'Home' }), 'Drew artboard “Home”');
  assert.equal(line(`${A}preview_file`, { path: 'out/index.html' }), 'Previewed index.html');
});

test('unknown own tools and other servers fall back to server › tool with an argument hint', () => {
  assert.equal(line(`${A}something_new`, {}), 'Used PandaCode › something new');
  assert.equal(line('mcp__linear__create_issue', { description: 'Fix login' }), 'Used linear › create issue Fix login');
});

test('dispatch assignments and screenshot images', () => {
  const [a] = assignmentsOf({ assignments: [{ key: 'k', name: 'Tests', prompt: 'p', provider: 'codex', model: 'gpt-6', files: ['tests', 3], readOnly: true, dependsOn: ['w1'] }] });
  assert.deepEqual(a, { key: 'k', name: 'Tests', prompt: 'p', provider: 'codex', model: 'gpt-6', profileId: '', files: ['tests'], readOnly: true, dependsOn: ['w1'] });
  const png = 'iVBORw0KGgo' + 'A'.repeat(120);
  assert.equal(imageOf(`{"type":"image","data":"${png}"}`), `data:image/png;base64,${png}`);
  assert.equal(imageOf('[Non-text content omitted]'), undefined);
});
