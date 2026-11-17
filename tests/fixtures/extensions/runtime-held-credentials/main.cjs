// R0805 fixture: a background service that uses credentials PandaCode holds without ever reading them.
// It names a declared connection and an operation; the host attaches the held credential the user granted for that
// item (`credentials.use`), writes the use to the package's activity list and returns only the adapter's answer.
// The same service asks the host to switch the active account of a harness (`panda.harnesses.switchAccount`) and
// reads the `accounts` resource to see the new `active` flags and revision. No call here can return a credential.
exports.service = async (panda, lifetime) => {
  const finish = async resource => {
    const started = await panda.connections.start(resource);
    let state = started;
    while (state.state === 'running') state = await panda.connections.poll({ ...resource, request: started.request });
    return state;
  };
  panda.commands.register('sample.held-credentials/use', async invocation => {
    const name = invocation?.args?.connection ?? 'provider';
    const operation = invocation?.args?.operation ?? 'get';
    const state = await finish({ connection: `sample.held-credentials/${name}`, operation });
    await lifetime.setStatus({ text: state.state === 'completed' ? `status ${state.response.status}` : `failed: ${state.error}` });
  });
  panda.commands.register('sample.held-credentials/switch', async invocation => {
    await panda.harnesses.switchAccount({ harness: invocation?.args?.harness ?? 'claude', account: invocation?.args?.account ?? 'default' });
    const accounts = await panda.context.query({ resource: 'accounts', harness: invocation?.args?.harness ?? 'claude' });
    const active = accounts.items.find(item => item.active);
    await lifetime.setStatus({ text: `active ${active ? active.id : 'none'}` });
  });
};
