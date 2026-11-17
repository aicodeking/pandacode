// R0804 fixture: a background service that asks the host to run its declared connections (`panda.connections`).
// It names a connection and an operation, never an address, a header or a credential: the host builds the request,
// attaches the package secret `api-key`, and returns the parsed JSON answer in `response.body`.
exports.service = async (panda, lifetime) => {
  const resource = { connection: 'sample.connection-adapters/usage', operation: 'get' };
  panda.commands.register('sample.connection-adapters/usage', async () => {
    const started = await panda.connections.start({ ...resource, query: { window: '5h' } });
    let state = started;
    while (state.state === 'running') state = await panda.connections.poll({ ...resource, request: started.request });
    await lifetime.setStatus({ text: state.state === 'completed' ? `status ${state.response.status}` : `failed: ${state.error}` });
  });
  panda.commands.register('sample.connection-adapters/report', async () => {
    const started = await panda.connections.start({ connection: 'sample.connection-adapters/report', operation: 'send', body: { range: { from: '2026-01-01' } } });
    await panda.connections.cancel({ connection: 'sample.connection-adapters/report', operation: 'send', request: started.request });
  });
};
