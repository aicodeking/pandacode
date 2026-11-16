// Demo answers for the `admin` feature group (src/connect/api/admin.ts). See ./index.ts.
// Each demo bot gets channels, a waiting pairing, a held message, schedules and memories; the computer has two
// local VMs, a cloud sandbox and agent, and one link request. Changes live for the demo session only.
import type { BotDetail, BotMemory, CloudAgent, CloudMachine, MachinesList, RoutingStatus } from '../store/admin.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A 1×1 PNG, standing in for a VM's screen. */
const DEMO_FRAME = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Per device and bot, made on first use; replaced (never edited in place) on every change. */
let details: Record<string, BotDetail> = {};
let machines: Record<string, MachinesList> = {};

function seedDetail(ctx: DemoContext, botId: string): BotDetail {
  const bot = ctx.state.bots[ctx.deviceId]?.find(b => b.id === botId);
  if (!bot) throw new Error('That bot no longer exists.');
  const now = ctx.host.now();
  return {
    bot: {
      id: bot.id, name: bot.name, role: 'Keeps the release train moving', avatar: bot.avatar ?? '', color: '', provider: 'claude', model: 'Claude Sonnet',
      mode: 'ask', paused: bot.paused, heartbeatMinutes: 60, nextHeartbeatAt: now + 23 * MIN, projectId: bot.projectId,
    },
    channels: [
      { id: `${botId}-tg`, kind: 'telegram', label: '', enabled: true, status: 'connected', identity: `@${bot.name.toLowerCase().replace(/\W+/g, '')}_bot` },
      { id: `${botId}-slack`, kind: 'slack', label: 'Team Slack', enabled: true, status: 'connected', identity: 'pandacode' },
      { id: `${botId}-web`, kind: 'web', label: '', enabled: false, status: 'stopped', identity: '' },
    ],
    pairings: [
      { channelId: `${botId}-tg`, senderId: '81422', senderName: 'Sam Rivera', status: 'pending', code: '4821', createdAt: now - 4 * MIN },
      { channelId: `${botId}-slack`, senderId: 'U02X', senderName: 'You', status: 'approved', code: '1190', createdAt: now - 9 * 24 * HOUR },
    ],
    rules: [{ id: `${botId}-r1`, pattern: 'npm test*', decision: 'allow', createdAt: now - 5 * 24 * HOUR }],
    schedules: [
      { id: `${botId}-s1`, botId, title: 'Morning triage', prompt: 'Triage new issues and post a summary.', kind: 'weekdays', intervalMinutes: null, timeOfDay: '09:00', nextRunAt: now + 14 * HOUR, lastRunAt: now - 10 * HOUR, enabled: true, createdBy: 'user' },
      { id: `${botId}-s2`, botId, title: 'Check CI', prompt: 'Check CI on main and tell me if it is red.', kind: 'interval', intervalMinutes: 120, timeOfDay: null, nextRunAt: now + 47 * MIN, lastRunAt: now - 73 * MIN, enabled: true, createdBy: 'agent' },
    ],
    memories: [
      { id: `${botId}-m1`, content: 'The team ships on Thursdays; avoid merging big changes on Wednesday evening.', source: 'user', createdAt: now - 12 * 24 * HOUR },
      { id: `${botId}-m2`, content: 'Use pnpm, never npm, in the web repo.', source: 'agent', createdAt: now - 3 * 24 * HOUR },
    ],
    failovers: [{ botId, sessionId: bot.desktopSession ?? `bot-${botId}`, cause: 'limit', provider: 'claude', model: 'Claude Sonnet', target: { provider: 'codex', model: 'GPT-5' }, resetsAt: now + 2 * HOUR }],
    truncated: false,
  };
}

function detailOf(ctx: DemoContext, botId: string): BotDetail {
  const key = `${ctx.deviceId}/${botId}`;
  const found = details[key] ?? seedDetail(ctx, botId);
  details = { ...details, [key]: found };
  return found;
}

function saveDetail(ctx: DemoContext, botId: string, change: (detail: BotDetail) => BotDetail) {
  const key = `${ctx.deviceId}/${botId}`;
  details = { ...details, [key]: change(detailOf(ctx, botId)) };
}

function machinesOf(ctx: DemoContext): MachinesList {
  const found = machines[ctx.deviceId] ?? {
    vms: {
      supported: true, installed: true, vms: [
        { name: 'ubuntu-dev', running: true, attached: true, os: 'linux', memoryMb: 8192, cpus: 4, sizeGb: 22, desktop: null, desktopError: null },
        { name: 'sequoia-test', running: false, attached: false, os: 'darwin', memoryMb: 16384, cpus: 6, sizeGb: 54, desktop: null, desktopError: null },
      ],
    },
    orchestration: { enabled: true, links: [{ deviceId: 'demo-linux', name: 'Build box', platform: 'linux', online: true, access: 'ask' }] },
    pending: [{ requestId: 'link-1', sessionId: 'perf', machine: 'MacBook Air', reason: 'Run the sidebar benchmark on a slower machine.' }],
    devices: ctx.state.devices.filter(d => d.id !== ctx.deviceId).map(d => ({ id: d.id, name: d.name, platform: d.platform ?? '', online: !!d.online })),
  };
  machines = { ...machines, [ctx.deviceId]: found };
  return found;
}

function botIdOf(params: any): string {
  const id = String(params?.botId ?? '');
  if (!id) throw new Error('Missing botId.');
  return id;
}

export const handlers: DemoHandlers = {
  'bot.detail': (ctx, params) => detailOf(ctx, botIdOf(params)),
  'bot.remember': (ctx, params) => {
    const botId = botIdOf(params);
    const content = String(params?.content ?? '').trim();
    if (!content) throw new Error('A memory needs some text.');
    const memory: BotMemory = { id: `m-${ctx.host.now().toString(36)}`, content, source: 'user', createdAt: ctx.host.now() };
    saveDetail(ctx, botId, d => ({ ...d, memories: [...d.memories, memory] }));
    return { memory };
  },
  'bot.forget': (ctx, params) => {
    const botId = botIdOf(params);
    if (!detailOf(ctx, botId).memories.some(m => m.id === params?.memoryId)) throw new Error('That memory was already removed.');
    saveDetail(ctx, botId, d => ({ ...d, memories: d.memories.filter(m => m.id !== params.memoryId) }));
    return {};
  },
  'bot.runSchedule': (ctx, params) => {
    const botId = botIdOf(params);
    if (!detailOf(ctx, botId).schedules.some(s => s.id === params?.scheduleId)) throw new Error('This schedule no longer exists.');
    saveDetail(ctx, botId, d => ({ ...d, schedules: d.schedules.map(s => (s.id === params.scheduleId ? { ...s, lastRunAt: ctx.host.now() } : s)) }));
    return {};
  },
  'bot.pairingDecide': (ctx, params) => {
    const botId = botIdOf(params);
    const { channelId, senderId, decision } = params ?? {};
    if (!['approved', 'blocked', 'removed'].includes(decision)) throw new Error('Approve, block or remove the sender.');
    saveDetail(ctx, botId, d => ({
      ...d,
      pairings: decision === 'removed'
        ? d.pairings.filter(p => !(p.channelId === channelId && p.senderId === senderId))
        : d.pairings.map(p => (p.channelId === channelId && p.senderId === senderId ? { ...p, status: decision } : p)),
    }));
    return {};
  },
  'bot.failoverDecide': (ctx, params) => {
    if (!['send', 'wait'].includes(params?.action)) throw new Error('Choose Send or Wait.');
    const key = Object.keys(details).find(k => k.startsWith(`${ctx.deviceId}/`) && details[k].failovers.some(f => f.sessionId === params.sessionId));
    if (!key) throw new Error('This message is no longer on hold.');
    details = { ...details, [key]: { ...details[key], failovers: details[key].failovers.filter(f => f.sessionId !== params.sessionId) } };
    if (params.action === 'send') ctx.reply(params.sessionId);
    return {};
  },
  'machines.list': ctx => machinesOf(ctx),
  'cloud.machines': (): { machines: CloudMachine[]; errors: string[] } => ({
    machines: [{ id: 'daytona:sbx-41', provider: 'daytona', name: 'agent-sandbox', state: 'running', os: 'linux', desktop: true, detail: '4 vCPU · 8 GB' }],
    errors: [],
  }),
  'cloudAgents.list': (ctx): { agents: CloudAgent[] } => {
    const task = ctx.state.tasks[ctx.deviceId]?.tasks[0];
    return task
      ? { agents: [{ sessionId: task.sessionId, title: task.title, status: 'running', updatedAt: ctx.host.now() - 2 * MIN, cloud: { provider: 'daytona', label: 'Daytona', machine: 'daytona:sbx-41', stage: 'running', detail: null } }] }
      : { agents: [] };
  },
  // Vercel and Cloudflare are signed in; the rest show the desktop's hint (Railway with its own note).
  'deploy.targets': () => ({
    targets: [
      { id: 'vercel', connected: true }, { id: 'cloudflare', connected: true },
      { id: 'railway', connected: false, note: 'Sign in to Railway in Settings → Agents → Cloud sandboxes.' },
      { id: 'netlify', connected: false }, { id: 'aws', connected: false }, { id: 'gcloud', connected: false },
    ],
  }),
  'cloudAgents.targets': () => ({
    providers: [{ provider: 'daytona', label: 'Daytona', ready: true }, { provider: 'e2b', label: 'E2B', ready: false }],
    harnesses: ['claude', 'glm', 'mimo', 'codex', 'opencode'],
  }),
  'cloudAgents.start': (ctx, params) => {
    if (params?.provider !== 'daytona') throw new Error('Connect E2B in Settings → Cloud first.');
    if (!String(params?.prompt ?? '').trim()) throw new Error('Write a message under 128 KiB first.');
    const task = ctx.state.tasks[ctx.deviceId]?.tasks.find(t => t.projectId === params.projectId) ?? ctx.state.tasks[ctx.deviceId]?.tasks[0];
    if (!task) throw new Error('That project is no longer on this computer.');
    ctx.reply(task.sessionId);
    return { sessionId: task.sessionId, projectId: task.projectId };
  },
  'routing.status': (): { routing: RoutingStatus } => ({ routing: { enabled: true, mode: 'balanced', minP: 0.5, profiler: 'ready', error: null } }),
  'vm.frame': (ctx, params) => {
    if (!machinesOf(ctx).vms.vms.some(vm => vm.name === params?.name && vm.running)) throw new Error('Start the VM first.');
    return { frameId: 'demo-frame', mime: 'image/png', total: DEMO_FRAME.length, offset: 0, data: DEMO_FRAME, done: true };
  },
  'vm.start': (ctx, params) => setRunning(ctx, String(params?.name ?? ''), true),
  'vm.stop': (ctx, params) => setRunning(ctx, String(params?.name ?? ''), false),
  'orchestration.respond': (ctx, params) => {
    const list = machinesOf(ctx);
    const request = list.pending.find(p => p.requestId === params?.requestId);
    if (!request) throw new Error('This link request was already answered.');
    const device = params.accept ? list.devices.find(d => d.id === params.deviceId) : undefined;
    if (params.accept && !device) throw new Error('Unknown computer.');
    const links = device
      ? [...list.orchestration.links.filter(l => l.deviceId !== device.id), { deviceId: device.id, name: device.name, platform: device.platform, online: device.online, access: params.access }]
      : list.orchestration.links;
    const next = { ...list, pending: list.pending.filter(p => p !== request), orchestration: { ...list.orchestration, links } };
    machines = { ...machines, [ctx.deviceId]: next };
    return { orchestration: next.orchestration };
  },
};

function setRunning(ctx: DemoContext, name: string, running: boolean) {
  const list = machinesOf(ctx);
  if (!list.vms.vms.some(vm => vm.name === name)) throw new Error('Unknown VM.');
  const vms = { ...list.vms, vms: list.vms.vms.map(vm => (vm.name === name ? { ...vm, running, attached: running } : vm)) };
  machines = { ...machines, [ctx.deviceId]: { ...list, vms } };
  return { vms };
}
