/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloneState, RecentRepo } from '../src/connect/api/projects.ts';
import type { Method } from '../src/connect/rpc.ts';
import type { DemoHost } from '../src/demo-host.ts';
import type { ConnectState } from '../src/store/index.ts';
import { ADD_PROJECT_CHOICE, canStartWith, CHAT_CHOICE, DEPLOY_CONNECT_NOTE, DEPLOY_TARGETS, deployBrief, deployChoices, deployConfirm, decodeDeployTargets, deployTaskParams, filterRepos, folderFor, parseRepoInput, projectChoices, startMethod, waitForClone } from '../src/ui/new-task-projects.ts';

const NOW = new Date(2026, 10, 9, 14, 0).getTime();

test('parseRepoInput takes owner/name and github.com links, nothing else', () => {
  for (const [input, repo] of [
    ['octo/hello', 'octo/hello'], ['  octo/hello  ', 'octo/hello'], ['octo/hello.js', 'octo/hello.js'],
    ['https://github.com/octo/hello', 'octo/hello'], ['https://github.com/octo/hello.git', 'octo/hello'],
    ['https://github.com/octo/hello/', 'octo/hello'], ['http://www.github.com/octo/hello/tree/main/src', 'octo/hello'],
    ['github.com/octo/hello/pull/3', 'octo/hello'], ['https://github.com/octo/hello?tab=readme', 'octo/hello'],
    ['git@github.com:octo/hello.git', 'octo/hello'],
  ]) assert.equal(parseRepoInput(input), repo, input);
  for (const bad of ['', 'octo', 'octo/', '/hello', 'a/b/c', 'octo/..', '-x/y', 'octo/.hidden', 'oc to/hello', 'https://gitlab.com/octo/hello',
    'file:///etc/passwd', 'git@gitlab.com:octo/hello.git', 'https://github.com/octo', '../../etc', `${'a'.repeat(101)}/b`]) {
    assert.equal(parseRepoInput(bad), null, bad);
  }
});

test('the project picker lists projects, then Chat and Add project when the host serves them', () => {
  const projects = [{ id: 'p1', name: 'app' }];
  assert.deepEqual(projectChoices(projects, { chat: true, add: true }).map(c => c.value), ['p1', CHAT_CHOICE, ADD_PROJECT_CHOICE]);
  assert.deepEqual(projectChoices(projects, { chat: false, add: false }).map(c => c.label), ['app']);
  assert.deepEqual(projectChoices([], { chat: true, add: false }), [{ value: CHAT_CHOICE, label: 'Chat (no project)' }]);
});

test('a task starts with a project or as a chat, never while starting', () => {
  const base = { deviceId: 'd', projectId: 'p', provider: 'claude', prompt: 'Hi', starting: false, chat: false };
  assert.equal(canStartWith(base), true);
  assert.equal(canStartWith({ ...base, projectId: '' }), false);
  assert.equal(canStartWith({ ...base, projectId: '', chat: true }), true);
  assert.equal(canStartWith({ ...base, prompt: '   ' }), false);
  assert.equal(canStartWith({ ...base, starting: true }), false);
  assert.equal(canStartWith({ ...base, provider: '' }), false);
  assert.equal(canStartWith({ ...base, deviceId: '' }), false);
});

test('Start stays off when this phone may not start there, and attachments stand in for words', () => {
  const base = { deviceId: 'd', projectId: 'p', provider: 'claude', prompt: 'Hi', starting: false, chat: false };
  assert.equal(canStartWith({ ...base, allowed: false }), false);
  assert.equal(canStartWith({ ...base, allowed: true }), true);
  assert.equal(canStartWith({ ...base, prompt: ' ', attachments: true }), true);
  assert.equal(canStartWith({ ...base, prompt: ' ', attachments: true, allowed: false }), false);
});

test('Start calls chat.start for a Chat, team.start for a team, else task.start', () => {
  assert.equal(startMethod({ chat: true, team: false }), 'chat.start');
  assert.equal(startMethod({ chat: false, team: true }), 'team.start');
  assert.equal(startMethod({ chat: false, team: false }), 'task.start');
});

test('filterRepos matches every word and lists repositories not on the computer first', () => {
  const repo = (name: string, description: string, projectId: string | null = null): RecentRepo =>
    ({ repo: name, description, private: false, fork: false, archived: false, pushedAt: '', language: '', projectId });
  const repos = [repo('octo/app', 'The app', 'p1'), repo('octo/site', 'Marketing site'), repo('other/app-docs', 'Docs for the app')];
  assert.deepEqual(filterRepos(repos, '').map(r => r.repo), ['octo/site', 'other/app-docs', 'octo/app']);
  assert.deepEqual(filterRepos(repos, 'APP').map(r => r.repo), ['other/app-docs', 'octo/app']);
  assert.deepEqual(filterRepos(repos, 'octo marketing').map(r => r.repo), ['octo/site']);
  assert.deepEqual(filterRepos(repos, 'nothing'), []);
  assert.equal(folderFor('octo/hello'), 'hello');
});

test('waitForClone asks until the clone ends, the sheet closes, or it gives up', async () => {
  const replies = (...states: CloneState[]) => { let i = 0; return async () => states[i++]; };
  let clock = 0;
  const opts = (cancelled = () => false) => ({ sleep: async (ms: number) => { clock += ms; }, cancelled, now: () => clock, pollMs: 1000, giveUpMs: 5000 });
  const cloning: CloneState = { repo: 'a/b', state: 'cloning' };
  const done: CloneState = { repo: 'a/b', state: 'done', projectId: 'p', existing: false };

  assert.deepEqual(await waitForClone(done, replies(), opts()), done);
  assert.deepEqual(await waitForClone(cloning, replies(cloning, done), opts()), done);
  const failed: CloneState = { repo: 'a/b', state: 'failed', error: 'boom' };
  assert.deepEqual(await waitForClone(cloning, replies(failed), opts()), failed);
  assert.deepEqual(await waitForClone(cloning, replies({ repo: 'a/b', state: 'unknown' }), opts()), { repo: 'a/b', state: 'unknown' });
  assert.equal(await waitForClone(cloning, replies(done), opts(() => true)), null);
  clock = 0;
  const slow = await waitForClone(cloning, async () => cloning, opts());
  assert.equal(slow?.state, 'failed');
  assert.match(slow?.state === 'failed' ? slow.error : '', /keeps going on the computer/);
});

test('the demo starts chats, lists repositories and clones', async () => {
  const { demoCall } = await import('../src/demo-host.ts');
  let state = {
    devices: [{ id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { studio: { tasks: [], projects: [{ id: 'pandacode', name: 'pandacode', repo: null }], loadedAt: 0 } },
    messages: {}, live: {}, outdated: {}, sent: {}, bots: {},
  } as unknown as ConnectState;
  const later: (() => void)[] = [];
  const host: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: run => { later.push(run); }, now: () => NOW };
  const call = (method: string, params: object = {}) => demoCall(host, 'studio', method as Method, params) as Promise<any>;

  const { sessionId, projectId } = await call('chat.start', { prompt: 'Explain closures', provider: 'claude', model: 'default' });
  const chat = state.tasks.studio.tasks.find(t => t.sessionId === sessionId);
  assert.equal(chat?.chat, true);
  assert.equal(chat?.projectId, projectId);
  assert.equal(state.tasks.studio.projects.find(p => p.id === projectId)?.name, 'Chat');
  await assert.rejects(call('chat.start', { prompt: ' ', provider: 'claude', model: 'default' }), /Write a message/);

  const repos: RecentRepo[] = (await call('projects.recentRepos')).repos;
  assert.equal(repos.find(r => r.repo === 'pandacode-app/pandacode')?.projectId, 'pandacode');
  assert.equal(repos.find(r => r.repo === 'pandacode-app/relay')?.projectId, null);

  assert.deepEqual(await call('projects.clone', { repo: 'https://github.com/pandacode-app/pandacode' }), { repo: 'pandacode-app/pandacode', state: 'done', projectId: 'pandacode', existing: true });
  await assert.rejects(call('projects.clone', { repo: '../../etc' }), /owner\/name/);
  assert.deepEqual(await call('projects.cloneStatus', { repo: 'octo/never' }), { repo: 'octo/never', state: 'unknown' });

  assert.equal((await call('projects.clone', { repo: 'pandacode-app/brand', name: 'brand-kit' })).state, 'cloning');
  later.forEach(run => run());
  const status: CloneState = await call('projects.cloneStatus', { repo: 'pandacode-app/brand' });
  assert.equal(status.state, 'done');
  const added = state.tasks.studio.projects.find(p => p.repo === 'pandacode-app/brand');
  assert.equal(added?.name, 'brand-kit');
  assert.equal((await call('projects.recentRepos')).repos.find((r: RecentRepo) => r.repo === 'pandacode-app/brand').projectId, added?.id);
});

test('a chat start sends one startId per draft and follows a lost reply', async () => {
  const { startChatOnce } = await import('../src/connect/api/projects.ts');
  const { TIMED_OUT } = await import('../src/connect/rpc.ts');
  const sent: { startId?: string }[] = [];
  let ids = 0;
  let fail: string | null = TIMED_OUT;
  const deps = {
    start: async (params: { startId?: string }) => { sent.push(params); if (fail) throw new Error(fail); return { sessionId: 'c1', projectId: 'chats' }; },
    status: async () => ({ state: 'unknown' as const }),
    canPoll: () => true,
    sleep: async () => undefined,
    now: () => 0,
    uuid: () => `id-${++ids}`,
  };
  const chat = { prompt: 'Hi', provider: 'claude', model: 'default' };
  // The host never got it: sent again under the same id, then the lost reply is reported.
  await assert.rejects(startChatOnce(deps, 'dev', chat), new RegExp(TIMED_OUT));
  assert.deepEqual(sent.map(p => p.startId), ['id-1', 'id-1', 'id-1']);
  // The retry of the same draft keeps the id, so the host starts one chat.
  fail = null;
  assert.equal((await startChatOnce(deps, 'dev', chat)).sessionId, 'c1');
  assert.equal(sent.at(-1)?.startId, 'id-1');
  // The host answered a failure: the next tap is a new start.
  fail = 'No such model.';
  await assert.rejects(startChatOnce(deps, 'dev', chat), /No such model/);
  fail = null;
  await startChatOnce(deps, 'dev', chat);
  assert.deepEqual(sent.slice(-2).map(p => p.startId), ['id-2', 'id-3']);
});

test('Deploy offers the desktop targets and starts a project task with its brief', () => {
  assert.deepEqual(DEPLOY_TARGETS.map(t => t.id), ['vercel', 'cloudflare', 'railway', 'netlify', 'aws', 'gcloud']);
  for (const t of DEPLOY_TARGETS) {
    const brief = deployBrief(t.id);
    assert.match(brief, /^Deploy this project to /);
    assert.match(brief, /pandacode_cloud_cli tool/);
    assert.match(brief, /Finish with the live URL/);
  }
  assert.match(deployBrief('vercel'), /With tool "vercel": run `deploy --yes` for a preview/);
  const task = { projectId: 'p1', provider: 'codex', model: 'gpt-5', mode: 'auto', effort: 'high' };
  assert.deepEqual(deployTaskParams(task, 'railway'), { projectId: 'p1', prompt: deployBrief('railway'), provider: 'codex', model: 'gpt-5', mode: 'auto', effort: 'high', worktree: false });
  assert.deepEqual(deployTaskParams({ projectId: 'p1', provider: 'claude', model: '', mode: '', effort: null }, 'aws'),
    { projectId: 'p1', prompt: deployBrief('aws'), provider: 'claude', model: 'default', mode: 'ask', worktree: false });
  assert.equal(deployTaskParams({ ...task, chat: true }, 'aws'), null, 'a Chat has no project to deploy');
  assert.equal(deployTaskParams({ ...task, botId: 'b1' }, 'aws'), null);
  assert.equal(deployTaskParams(undefined, 'aws'), null);
});

test('deploy.targets disables unconnected targets with the desktop note; an older host offers them all', () => {
  const states = decodeDeployTargets({ targets: [
    { id: 'vercel', connected: true }, { id: 'aws', connected: false }, { id: 'gcloud', connected: false, note: '  Sign in to gcloud first.  ' },
    { id: 'heroku', connected: false }, null, { connected: true }, { id: 'netlify', connected: 'yes' },
  ] });
  assert.deepEqual(states, [{ id: 'vercel', connected: true }, { id: 'aws', connected: false }, { id: 'gcloud', connected: false, note: 'Sign in to gcloud first.' }, { id: 'netlify', connected: false }]);
  assert.deepEqual(decodeDeployTargets(null), []);
  assert.deepEqual(decodeDeployTargets({ targets: 'no' }), []);
  const notes = Object.fromEntries(deployChoices(states).map(c => [c.id, c.note]));
  assert.deepEqual(notes, { vercel: undefined, cloudflare: undefined, railway: undefined, netlify: DEPLOY_CONNECT_NOTE, aws: DEPLOY_CONNECT_NOTE, gcloud: 'Sign in to gcloud first.' });
  assert.ok(deployChoices(null).every(c => c.note === undefined && c.description));
});

test('a deploy asks first, naming the target, project and computer', () => {
  const vercel = DEPLOY_TARGETS[0];
  assert.deepEqual(deployConfirm(vercel, 'site', 'Mac'), { title: 'Deploy to Vercel?', message: 'Preview first, then production. A new task ships site with Mac’s signed-in CLI.' });
  assert.match(deployConfirm(vercel, '', '').message, /ships this project with the computer’s signed-in CLI/);
});

test('New task keeps Chat, Team and Add project listed when access blocks them, with the reason', async () => {
  const { parseHello } = await import('../src/connect/api/hello.ts');
  const { menuGate } = await import('../src/ui/menu-gate.ts');
  const caps = parseHello({ protocol: 2, appVersion: '0.4.0', methods: ['chat.start', 'team.start', 'projects.clone'], access: 'control', methodAccess: { 'chat.start': 'full', 'team.start': 'full', 'projects.clone': 'full' } })!;
  for (const method of ['chat.start', 'team.start', 'projects.clone']) {
    const gate = menuGate(caps, method, 'Mac');
    assert.equal(gate.shown, true, method);
    assert.match(gate.note ?? '', /^Needs Full access/, method);
  }
  const chat = menuGate(caps, 'chat.start', 'Mac');
  assert.deepEqual(projectChoices([{ id: 'p1', name: 'app' }], { chat: chat.shown, add: true }).map(c => c.value), ['p1', CHAT_CHOICE, ADD_PROJECT_CHOICE]);
});

test('a start whose first message did not go reports why; one that went (or an older host) reports nothing', async () => {
  const { unsentStartError, unsentStartNotice, unsentFields } = await import('../src/connect/start-retry.ts');
  assert.equal(unsentStartError({ sent: true }), null);
  assert.equal(unsentStartError({}), null);
  assert.equal(unsentStartError(null), null);
  assert.equal(unsentStartError({ sent: false, error: ' The agent is offline. ' }), 'The agent is offline.');
  assert.equal(unsentStartError({ sent: false }), 'The computer did not say why.');
  assert.equal(unsentStartError({ sent: false, error: 42 }), 'The computer did not say why.');
  const notice = unsentStartNotice('The agent is offline.');
  assert.equal(notice.title, 'Message not sent');
  assert.equal(notice.tone, 'danger');
  assert.equal(notice.body, 'The task was created but your message didn’t send: The agent is offline. Send it again from the task.');
  assert.deepEqual(unsentFields({ sent: true, error: 'x' }), {});
  assert.deepEqual(unsentFields({ sent: false, error: 'busy' }), { sent: false, error: 'busy' });
});

test('a followed start carries sent: false from task.startStatus, and a direct reply keeps it', async () => {
  const { followStart } = await import('../src/connect/start-retry.ts');
  const { LOST } = await import('../src/connect/rpc.ts');
  const base = { canPoll: () => true, sleep: async () => undefined, now: () => 0, maxMs: 60_000 };
  const followed = await followStart({
    ...base,
    start: async () => { throw new Error(LOST); },
    status: async () => ({ state: 'done' as const, sessionId: 's1', sent: false, error: 'Harness crashed' }),
  });
  assert.deepEqual(followed, { sessionId: 's1', worktree: undefined, note: undefined, sent: false, error: 'Harness crashed' });
  const went = await followStart({ ...base, start: async () => { throw new Error(LOST); }, status: async () => ({ state: 'done' as const, sessionId: 's2' }) });
  assert.equal(went.sent, undefined);
  const direct = await followStart({ ...base, start: async () => ({ sessionId: 's3', sent: false, error: 'No model' }), status: async () => ({ state: 'unknown' as const }) });
  assert.equal(direct.sent, false);
  assert.equal(direct.error, 'No model');
});
