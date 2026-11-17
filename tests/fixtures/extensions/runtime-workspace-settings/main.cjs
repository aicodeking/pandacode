// R0407 fixture: a background service that reads and changes the app's workspace settings when it is told to, by the
// command `sample.runtime-workspace-settings/control` (the browser spec and the native test drive it).
// `op` is one of:
//   list    -> panda.workspace.settings.list()
//   get     -> panda.workspace.settings.get(args.key)
//   set     -> panda.workspace.settings.set(args.key, args.value, args.revision === undefined ? undefined : { revision })
//   refuse  -> the same call as `set` or `get` (args.call), answering the refusal as `{ refused: <code>, path }` instead of throwing
//   cycle   -> reads, rewrites with the value of args.values[key] and reads again for every key; answers the three views
//   state   -> every answer and every refusal so far
// The package never names telemetry, routing, the GitHub switch, safe mode, updates, trust, pairing or remote access
// as anything but an unknown key: they are not settings, so the host answers `NotFound`.
exports.service = async (panda, lifetime) => {
  const state = { reads: 0, writes: 0, refused: [] };
  const settings = panda.workspace.settings;
  const report = () => lifetime.setStatus({ text: JSON.stringify({ reads: state.reads, writes: state.writes, refused: state.refused }) });
  const write = async (key, value, revision) => {
    await settings.set(key, value, revision === undefined ? undefined : { revision });
    state.writes += 1;
    return settings.get(key);
  };
  const run = async args => {
    switch (args.op) {
      case 'list': state.reads += 1; return settings.list();
      case 'get': state.reads += 1; return settings.get(args.key);
      case 'set': return write(args.key, args.value, args.revision);
      case 'refuse':
        try { return args.call === 'get' ? await settings.get(args.key) : await write(args.key, args.value, args.revision); } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          return { refused: code, path: error?.path ?? null };
        }
      case 'cycle': {
        const out = {};
        for (const [key, value] of Object.entries(args.values)) {
          const before = await settings.get(key);
          const after = await write(key, value, before.revision);
          out[key] = { before, after, again: await settings.get(key) };
        }
        return out;
      }
      case 'state': return state;
      default: throw new Error(`Unknown op ${args.op}`);
    }
  };
  panda.commands.register('sample.runtime-workspace-settings/control', async invocation => {
    const result = await run(invocation?.args ?? invocation ?? {});
    await report();
    return result;
  });
  await report();
};
