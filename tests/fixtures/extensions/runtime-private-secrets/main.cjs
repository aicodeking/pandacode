// R0802 fixture: a service that keeps its own secrets through panda.secrets (permission `secrets.private`).
// The call goes to the native host, which scopes every key to this package; the value never leaves the service.
exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.private-secrets/store', async () => {
    await panda.secrets.set({ key: 'api-token', value: process.env.PANDA_FIXTURE_SECRET || 'fixture-value' });
    const { value } = await panda.secrets.get({ key: 'api-token' });
    const { keys } = await panda.secrets.list();
    await lifetime.setStatus({ text: `stored ${keys.length} secret(s); readable: ${value !== null}` });
    await panda.secrets.delete({ key: 'api-token' });
  });
};
