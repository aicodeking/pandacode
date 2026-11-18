// API-backed provider with a fake endpoint (no live inference, no personal credential).
// The service owns `panda.connections`: it names a declared connection and an operation and never an address, a
// header or the credential. The host builds the request, attaches the package secret `api-key` as `x-api-key`, runs it
// and returns the parsed JSON answer. The provider handler turns that answer into streamed provider events.
const PROVIDER = 'sample.upstream-api/chat';
const CONNECTION = 'sample.upstream-api/chat-api'; // not the provider's id: ids are unique across contributions
const FAKE_KEY = 'tok-fake-upstream-api-key'; // a canary: this package never reads a real credential
const WAIT_MS = 5000;

let bridge = null; // set by the service while it runs; the provider handler has no `panda` of its own

async function finish(panda, resource) {
  const started = await panda.connections.start(resource);
  let state = started;
  while (state.state === 'running') state = await panda.connections.poll({ connection: resource.connection, operation: resource.operation, request: started.request });
  return state;
}

function failure(state) {
  // `error` is the host's stable code text (PermissionDenied, Timeout, NotFound, ...): never a remote diagnostic.
  return new Error(state.error || `The fake API answered ${state.response?.status ?? 'nothing'}`);
}

exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.upstream-api/setup', async () => {
    const { keys } = await panda.secrets.list();
    if (!keys.includes('api-key')) await panda.secrets.set({ key: 'api-key', value: FAKE_KEY });
    await lifetime.setStatus({ text: 'fake API key stored' });
  });
  bridge = {
    async complete(model, prompt) {
      const state = await finish(panda, { connection: CONNECTION, operation: 'complete', body: { model, stream: false, messages: [{ role: 'user', content: prompt }] } });
      if (state.state !== 'completed') throw failure(state);
      if (state.response.status !== 200) throw new Error(`The fake API answered ${state.response.status}`);
      return state.response.body;
    },
  };
  await lifetime.setStatus({ text: 'fake chat API ready' });
  lifetime.onStop(() => { bridge = null; });
};

async function ready() {
  const until = Date.now() + WAIT_MS;
  while (!bridge && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  if (!bridge) throw new Error('HostUnavailable: the package service is not running; enable the package and its service');
  return bridge;
}

exports.providers = {
  [PROVIDER]: async (run, core) => {
    if (run.model !== 'fixture-small' || run.mode !== 'ask') throw new Error('UnsupportedCapability: fixture-small in Standard mode only');
    const api = await ready();
    await core.emit({ kind: 'session', id: run.resumeId || 'fake-api-conversation' });
    const answer = await api.complete(run.model, [run.instructions, run.prompt].filter(Boolean).join('\n\n'));
    // The adapter returns the whole answer: the stream is the fake service's own chunk list, replayed in order.
    for (const chunk of Array.isArray(answer.chunks) ? answer.chunks : []) await core.emit({ kind: 'text', text: String(chunk) });
    if (answer.usage) await core.emit({ kind: 'usage', usedTokens: Number(answer.usage.total) || 0, contextWindow: 8000 });
  },
};
