import test from 'node:test';
import assert from 'node:assert/strict';

// The pure parts of cloud agents in the webview: "Run on" choices, harness support and stage text.
const { SETUP_CHOICE, busyStage, cloudChoice, cloudItems, cloudProvider, harnessRefusal, stageText } = await import('../src/cloud-agents.ts');

test('cloud choices round-trip and never collide with this computer or Connect devices', () => {
  assert.equal(cloudProvider(cloudChoice('e2b')), 'e2b');
  assert.equal(cloudProvider('local'), undefined);
  assert.equal(cloudProvider('dev-studio'), undefined);
});

test('the Cloud section lists connected providers only, then setup', () => {
  const items = cloudItems([{ provider: 'e2b', label: 'E2B', ready: true }, { provider: 'modal', label: 'Modal', ready: false }], cloudChoice('e2b'));
  assert.deepEqual(items.map(item => [item.id, item.label, Boolean(item.selected)]), [
    ['cloud:e2b', 'Cloud · E2B', true],
    [SETUP_CHOICE, 'Set up cloud providers…', false],
  ]);
  // Nothing connected: setup alone.
  assert.deepEqual(cloudItems([{ provider: 'modal', label: 'Modal', ready: false }], 'local').map(item => item.id), [SETUP_CHOICE]);
  assert.deepEqual(cloudItems([], 'local').map(item => item.id), [SETUP_CHOICE]);
});

test('only Claude Code relays, Codex and OpenCode run in the cloud', () => {
  for (const id of ['claude', 'glm', 'mimo', 'codex', 'opencode']) assert.equal(harnessRefusal(id, id), '');
  assert.match(harnessRefusal('kimi', 'Kimi'), /^Kimi can’t run on a cloud machine yet\. Choose Claude Code, GLM, MiMo, Codex or OpenCode\.$/);
});

test('stages read as short phrases; busy ones spin', () => {
  assert.equal(stageText('installing', null, 'codex'), 'Installing Codex');
  assert.equal(stageText('installing', null, 'glm'), 'Installing Claude Code');
  assert.equal(stageText('error', 'E2B refused the key', 'claude'), 'Error: E2B refused the key');
  assert.equal(stageText('reconnecting', null, 'claude'), 'Reconnecting…');
  assert.equal(busyStage('uploading'), true);
  assert.equal(busyStage('ready'), false);
  assert.equal(busyStage('error'), false);
});
