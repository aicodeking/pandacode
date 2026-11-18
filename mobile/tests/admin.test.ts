/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentLine, botCadence, chosenCloud, cloudChoice, cloudHarnessRefusal, cloudProviderOf, cloudTaskForm, RUN_HERE, runOnChoices, cloudStartBlock, cloudStartIssue, cloudStartParams, harnessLabel, initialCloudForm, normalizeTargets, channelLine, channelTone, failoverLine, linkChoices, memoryError, normalizeDetail, pendingCount, pendingPairings, readFrame,
  routingLine, scheduleLine, sortVms, stageTone, untilText, vmLine, withMemory, withoutFailover, withoutMemory, withoutPairing,
  type BotChannel, type BotDetail, type CloudTargets, type BotSchedule, type FramePage, type MachinesList, type VmStatus,
} from '../src/store/admin.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const detail = (extra: Partial<BotDetail> = {}): BotDetail => normalizeDetail({
  bot: { id: 'b', name: 'Bob', role: '', avatar: '', color: '', provider: 'claude', model: 'Sonnet', mode: 'ask', paused: false, heartbeatMinutes: 60, nextHeartbeatAt: null, projectId: 'p' },
  ...extra,
});
const channel = (extra: Partial<BotChannel> = {}): BotChannel => ({ id: 'c', kind: 'telegram', label: '', enabled: true, status: 'connected', identity: '@bob_bot', ...extra });
const schedule = (extra: Partial<BotSchedule> = {}): BotSchedule => ({
  id: 's', botId: 'b', title: 'T', prompt: 'P', kind: 'interval', intervalMinutes: 120, timeOfDay: null, nextRunAt: NOW + 47 * MIN, lastRunAt: null, enabled: true, createdBy: 'user', ...extra,
});
const vm = (extra: Partial<VmStatus> = {}): VmStatus => ({ name: 'dev', running: true, attached: true, os: 'linux', memoryMb: 8192, cpus: 4, sizeGb: 20, desktop: null, desktopError: null, ...extra });

test('a partial bot detail becomes empty lists; no bot is an error', () => {
  const d = detail();
  assert.deepEqual([d.channels, d.pairings, d.rules, d.schedules, d.memories, d.failovers], [[], [], [], [], [], []]);
  assert.equal(d.truncated, false);
  assert.throws(() => normalizeDetail({}), /no bot/);
  assert.throws(() => normalizeDetail(null));
});

test('pending pairings come newest first and count with held messages', () => {
  const d = detail({
    pairings: [
      { channelId: 'c', senderId: '1', senderName: 'A', status: 'pending', code: '1', createdAt: 1 },
      { channelId: 'c', senderId: '2', senderName: 'B', status: 'approved', code: '2', createdAt: 2 },
      { channelId: 'c', senderId: '3', senderName: 'C', status: 'pending', code: '3', createdAt: 3 },
    ],
    failovers: [{ botId: 'b', sessionId: 's', cause: 'limit', provider: 'claude', model: 'Sonnet', target: { provider: 'codex', model: 'GPT-5' }, resetsAt: null }],
  });
  assert.deepEqual(pendingPairings(d).map(p => p.senderId), ['3', '1']);
  assert.equal(pendingCount(d), 3);
  const without = withoutPairing(d, 'c', '1');
  assert.equal(pendingPairings(without).length, 1);
  assert.equal(d.pairings.length, 3, 'the original is untouched');
  assert.equal(withoutFailover(d, 's').failovers.length, 0);
});

test('channel tones and lines', () => {
  assert.equal(channelTone(channel()), 'success');
  assert.equal(channelTone(channel({ enabled: false })), 'muted');
  assert.equal(channelTone(channel({ status: 'connecting' })), 'running');
  assert.equal(channelTone(channel({ status: 'error: bad token' })), 'danger');
  assert.equal(channelTone(channel({ status: 'waiting' })), 'warning');
  assert.equal(channelLine(channel()), 'Telegram · @bob_bot · Connected');
  assert.equal(channelLine(channel({ enabled: false, identity: '' })), 'Telegram · Off');
});

test('bot schedule cadence and next run', () => {
  assert.equal(botCadence(schedule()), 'Every 2 h');
  assert.equal(botCadence(schedule({ intervalMinutes: 60 })), 'Every hour');
  assert.equal(botCadence(schedule({ intervalMinutes: 1440 })), 'Every day');
  assert.equal(botCadence(schedule({ intervalMinutes: 45 })), 'Every 45 min');
  assert.equal(botCadence(schedule({ kind: 'daily', timeOfDay: '09:00' })), 'Daily at 09:00');
  assert.equal(botCadence(schedule({ kind: 'weekdays', timeOfDay: null })), 'Weekdays');
  assert.equal(botCadence(schedule({ kind: 'once' })), 'Once');
  assert.equal(scheduleLine(schedule(), NOW), 'Every 2 h · next in 47 min');
  assert.equal(scheduleLine(schedule({ enabled: false }), NOW), 'Every 2 h · Off');
  assert.equal(untilText(NOW - MIN, NOW), 'due');
  assert.equal(untilText(NOW + 3 * 60 * MIN, NOW), 'in 3 h');
  assert.equal(untilText(NOW + 50 * 60 * MIN, NOW), 'in 2 d');
  assert.equal(untilText(null, NOW), '');
});

test('held messages explain themselves', () => {
  const ask = { botId: 'b', sessionId: 's', cause: 'limit', provider: 'claude', model: 'Sonnet', target: { provider: 'codex', model: 'GPT-5' }, resetsAt: NOW + 120 * MIN };
  assert.equal(failoverLine(ask, NOW), 'Sonnet hit its usage limit (resets in 2 h). Send it with GPT-5 instead?');
  assert.equal(failoverLine({ ...ask, cause: 'provider-error' }, NOW), 'Sonnet is not answering. Send it with GPT-5 instead?');
});

test('memories are added once, removed by id and checked before sending', () => {
  const memory = { id: 'm', content: 'x', source: 'user', createdAt: 1 };
  const once = withMemory(withMemory(detail(), memory), memory);
  assert.equal(once.memories.length, 1);
  assert.equal(withoutMemory(once, 'm').memories.length, 0);
  assert.match(memoryError('   '), /Write something/);
  assert.match(memoryError('x'.repeat(2001)), /2000/);
  assert.equal(memoryError('🐼'.repeat(2000)), '', 'counted in characters, not UTF-16 units');
  assert.equal(memoryError('Uses pnpm'), '');
});

test('VMs: running first, then by name; lines say what matters', () => {
  assert.deepEqual(sortVms([vm({ name: 'b', running: false }), vm({ name: 'c' }), vm({ name: 'a', running: false })]).map(v => v.name), ['c', 'a', 'b']);
  assert.equal(vmLine(vm()), 'Running · Linux · 4 CPUs · 8 GB');
  assert.equal(vmLine(vm({ running: false, os: 'darwin', memoryMb: 512, cpus: 0 })), 'Stopped · macOS · 512 MB');
  assert.equal(vmLine(vm({ desktop: 'installing' })).startsWith('Adding a desktop'), true);
});

test('cloud agents and routing read as one line', () => {
  const agent = { sessionId: 's', title: 'T', status: 'running', updatedAt: 0, cloud: { provider: 'daytona', label: 'Daytona', machine: null, stage: 'syncing', detail: 'Pulling changes' } };
  assert.equal(agentLine(agent), 'Daytona · Syncing · Pulling changes');
  assert.equal(stageTone('error'), 'danger');
  assert.equal(stageTone('who-knows'), 'muted');
  assert.equal(routingLine({ enabled: true, mode: 'balanced', minP: 0.5, profiler: 'ready', error: null }), 'Balanced · min. confidence 50% · ready');
  assert.equal(routingLine({ enabled: false, mode: 'balanced', minP: 0.5, profiler: '', error: null }), 'Off');
  assert.equal(routingLine({ enabled: true, mode: 'balanced', minP: 0.5, profiler: '', error: 'Download failed' }), 'Download failed');
});

test('link choices put the computer the agent named first, then online ones', () => {
  const list: MachinesList = {
    vms: { supported: true, installed: true, vms: [] }, orchestration: { enabled: true, links: [] }, pending: [],
    devices: [{ id: '1', name: 'Zed', platform: '', online: true }, { id: '2', name: 'Air', platform: '', online: false }, { id: '3', name: 'Box', platform: '', online: false }],
  };
  assert.deepEqual(linkChoices(list, { requestId: 'r', sessionId: 's', machine: 'box', reason: '' }).map(d => d.id), ['3', '1', '2']);
  assert.deepEqual(linkChoices(list, { requestId: 'r', sessionId: 's', machine: null, reason: '' }).map(d => d.id), ['1', '2', '3']);
  assert.equal(list.devices[0].id, '1', 'the list is not sorted in place');
});

test('a VM frame is joined from pages of one frame', async () => {
  const pages = (data: string, size: number, frameId = 'f') => (offset: number): FramePage =>
    ({ frameId, mime: 'image/jpeg', total: data.length, offset, data: data.slice(offset, offset + size), done: offset + size >= data.length });
  const seen: Array<[number, string | undefined]> = [];
  const page = pages('AAAABBBBCC==', 4);
  const uri = await readFrame(async (offset, frameId) => { seen.push([offset, frameId]); return page(offset); });
  assert.equal(uri, 'data:image/jpeg;base64,AAAABBBBCC==');
  assert.deepEqual(seen, [[0, undefined], [4, 'f'], [8, 'f']]);

  let first = true;
  await assert.rejects(readFrame(async offset => { const p = pages('AAAABBBB', 4, first ? 'f' : 'g')(offset); first = false; return p; }), /changed/);
  await assert.rejects(readFrame(async offset => pages('A'.repeat(400), 4)(offset), 3), /too large/);
});

test('cloud targets drop malformed entries and never invent readiness', () => {
  const targets = normalizeTargets({ providers: [{ provider: 'e2b', label: 'E2B', ready: true }, { provider: '' }, null, { provider: 'daytona', ready: 'yes' }], harnesses: ['claude', 3, ''] });
  assert.deepEqual(targets, { providers: [{ provider: 'e2b', label: 'E2B', ready: true }, { provider: 'daytona', label: 'daytona', ready: false }], harnesses: ['claude'] });
  assert.deepEqual(normalizeTargets(null), { providers: [], harnesses: [] });
});

test('a cloud start form picks a connected provider and says why it cannot start', () => {
  const targets: CloudTargets = { providers: [{ provider: 'e2b', label: 'E2B', ready: false }, { provider: 'daytona', label: 'Daytona', ready: true }], harnesses: ['codex', 'claude'] };
  const form = initialCloudForm(targets, [{ id: 'p1' }]);
  assert.deepEqual(form, { provider: 'daytona', harness: 'claude', projectId: 'p1', prompt: '' });
  assert.equal(cloudStartIssue(form, targets, 'Studio'), 'Write what the agent should do.');
  assert.equal(cloudStartIssue({ ...form, prompt: 'Fix CI', provider: 'e2b' }, targets, 'Studio'), 'Connect E2B in Settings → Cloud on Studio first.');
  assert.equal(cloudStartIssue({ ...form, prompt: 'Fix CI', projectId: '' }, targets, 'Studio'), 'Add a project on Studio first.');
  assert.equal(cloudStartIssue({ ...form, prompt: 'Fix CI', harness: 'kimi' }, targets, 'Studio'), 'Pick an agent.');
  assert.match(cloudStartIssue(form, { ...targets, providers: [] }, 'Studio') ?? '', /Connect a cloud provider/);
  assert.equal(cloudStartIssue({ ...form, prompt: 'Fix CI' }, targets, 'Studio'), null);
  assert.deepEqual(cloudStartParams({ ...form, prompt: '  Fix CI \n' }, 's1'), { startId: 's1', projectId: 'p1', provider: 'daytona', harness: 'claude', model: 'default', prompt: 'Fix CI' });
  assert.equal(harnessLabel('opencode'), 'OpenCode');
  assert.equal(harnessLabel('new'), 'new');
});

test('starting a cloud agent also waits on the Full access switch', () => {
  assert.equal(cloudStartBlock(null, false), 'switch');
  assert.equal(cloudStartBlock(null, true), null);
  assert.equal(cloudStartBlock(null, undefined), null, 'unknown hosts stay enabled');
  assert.equal(cloudStartBlock('access', false), 'access');
});

test('Run on lists this computer, then connected cloud providers only', () => {
  const targets: CloudTargets = { providers: [{ provider: 'e2b', label: 'E2B', ready: false }, { provider: 'daytona', label: 'Daytona', ready: true }], harnesses: ['claude', 'codex', 'opencode'] };
  assert.deepEqual(runOnChoices(targets), [{ value: RUN_HERE, label: 'This computer' }, { value: 'cloud:daytona', label: 'Cloud · Daytona' }]);
  assert.deepEqual(runOnChoices(null), [{ value: RUN_HERE, label: 'This computer' }]);
  assert.equal(cloudProviderOf(cloudChoice('daytona')), 'daytona');
  assert.equal(cloudProviderOf(RUN_HERE), undefined);
  assert.equal(cloudProviderOf('cloud:'), undefined);
  assert.deepEqual(chosenCloud(targets, 'cloud:daytona'), { provider: 'daytona', label: 'Daytona', ready: true });
  assert.equal(chosenCloud(targets, 'cloud:e2b'), null, 'a provider no longer connected runs here');
  assert.equal(chosenCloud(targets, RUN_HERE), null);
  assert.equal(chosenCloud(null, 'cloud:daytona'), null);
});

test('a cloud New task refuses harnesses a cloud machine cannot run and sends the draft as the desktop does', () => {
  const targets: CloudTargets = { providers: [], harnesses: ['claude', 'codex', 'opencode'] };
  assert.equal(cloudHarnessRefusal('codex', targets, 'Codex'), null);
  assert.equal(cloudHarnessRefusal('kimi', targets, 'Kimi'), 'Kimi can’t run on a cloud machine yet. Choose Claude Code, Codex or OpenCode.');
  assert.equal(cloudHarnessRefusal('kimi', null, 'Kimi'), 'Kimi can’t run on a cloud machine yet. Choose another agent.');
  const form = cloudTaskForm({ provider: 'daytona', harness: 'codex', projectId: 'p1', prompt: ' Ship it ', model: 'gpt-5', mode: 'auto', effort: 'high' });
  assert.deepEqual(cloudStartParams(form, 's2'), { startId: 's2', projectId: 'p1', provider: 'daytona', harness: 'codex', model: 'gpt-5', prompt: 'Ship it', mode: 'auto', effort: 'high' });
  const plain = cloudTaskForm({ provider: 'daytona', harness: 'claude', projectId: 'p1', prompt: 'x', model: '', mode: '' });
  assert.deepEqual(cloudStartParams(plain, 's3'), { startId: 's3', projectId: 'p1', provider: 'daytona', harness: 'claude', model: 'default', prompt: 'x' });
});

// The cloud start form (ui/admin/CloudAgentStart.tsx) and New task's Run on cloud keep a start id
// only while the host may have the start; startCloudAgent follows a lost reply with task.startStatus.
test('a cloud start keeps its id after a lost reply and takes a fresh one after a host answer', async () => {
  const { keepsStartId } = await import('../src/connect/start-retry.ts');
  const { LOST, TIMED_OUT } = await import('../src/connect/rpc.ts');
  assert.equal(keepsStartId(new Error(TIMED_OUT)), true);
  assert.equal(keepsStartId(new Error(LOST)), true);
  assert.equal(keepsStartId(new Error('Bot workspaces cannot be used for remote tasks.')), false);
  assert.equal(keepsStartId(new Error('The computer sent no task.')), false);
});

test('a cloud start whose reply is lost polls task.startStatus under the same start id', async () => {
  const { followStart } = await import('../src/connect/start-retry.ts');
  const { TIMED_OUT } = await import('../src/connect/rpc.ts');
  const sent: string[] = [];
  let clock = 0;
  const reply = await followStart({
    start: async () => { sent.push('cloudAgents.start'); throw new Error(TIMED_OUT); },
    status: async () => { sent.push('task.startStatus'); return { state: 'done', sessionId: 'cloud-1' }; },
    canPoll: () => true,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    maxMs: 60_000,
  });
  assert.equal(reply.sessionId, 'cloud-1');
  assert.deepEqual(sent, ['cloudAgents.start', 'task.startStatus']);
});

test('a cloud agent start keeps the project the host named, even when its reply was lost', async () => {
  const { startCloudAgentWith } = await import('../src/connect/api/admin.ts');
  const { LOST } = await import('../src/connect/rpc.ts');
  const form = { provider: 'daytona', harness: 'claude', projectId: 'form-project', prompt: 'Fix CI' };
  const base = { canPoll: () => true, sleep: async () => undefined, now: () => 0 };
  const sent: Record<string, unknown>[] = [];
  // Lost reply: the followed task.startStatus names the project the host used.
  const lost = await startCloudAgentWith({
    ...base,
    start: async params => { sent.push(params); throw new Error(LOST); },
    status: async startId => ({ state: 'done' as const, sessionId: `s-${startId}`, projectId: 'cloud-project' }),
  }, form, 'k1');
  assert.deepEqual(lost, { sessionId: 's-k1', projectId: 'cloud-project' });
  assert.equal(sent[0]?.startId, 'k1');
  // An older host's status names none: the form's project stands.
  const older = await startCloudAgentWith({
    ...base,
    start: async () => { throw new Error(LOST); },
    status: async () => ({ state: 'done' as const, sessionId: 's2' }),
  }, form, 'k2');
  assert.equal(older.projectId, 'form-project');
  // The direct reply's project wins too.
  const direct = await startCloudAgentWith({
    ...base,
    start: async () => ({ sessionId: 's3', projectId: 'direct-project' }),
    status: async () => { throw new Error('not asked'); },
  }, form, 'k3');
  assert.deepEqual(direct, { sessionId: 's3', projectId: 'direct-project' });
});
