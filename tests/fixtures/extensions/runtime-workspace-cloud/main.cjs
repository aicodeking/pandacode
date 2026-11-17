// R0406C fixture: a background service that manages moodboards and already configured cloud machines, driven by the command
// `sample.runtime-workspace-cloud/control` (the panel button of the acceptance, the browser spec and the native test).
// `args.op` is one of:
//   moodboards.create      -> panda.workspace.moodboards.create({ projectId, name })           answers the board
//   moodboards.rename      -> panda.workspace.moodboards.rename(boardId, name)                 answers the board
//   moodboards.remove      -> panda.workspace.moodboards.remove(boardId)                       irreversible: the host confirms by default
//   moodboards.addImage    -> panda.workspace.moodboards.addImage(boardId, { name, dataUrl })  answers the board with its images
//   moodboards.removeImage -> panda.workspace.moodboards.removeImage(boardId, imageId)
//   cloud.provision        -> panda.workspace.cloud.provision({ provider, name })              a provider the user already connected
//   cloud.sync | retry | open | stop -> panda.workspace.cloud.<op>(machineId)
//   cloud.remove           -> panda.workspace.cloud.remove(machineId)                          irreversible: the host confirms by default
//   refuse                 -> any of the above as `args.call` (for example "cloud.remove") with `args.args`, answering
//                             { refused: <code>, path, ids } instead of throwing
//   state                  -> every refusal so far
// The package has no call that connects a provider, pairs a machine, grants remote access or names a credential.
exports.service = async (panda, lifetime) => {
  const state = { refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused }) });
  const { moodboards, cloud } = panda.workspace;
  const calls = {
    'moodboards.create': args => moodboards.create(args[0]),
    'moodboards.rename': args => moodboards.rename(args[0], args[1]),
    'moodboards.remove': args => moodboards.remove(args[0]),
    'moodboards.addImage': args => moodboards.addImage(args[0], args[1]),
    'moodboards.removeImage': args => moodboards.removeImage(args[0], args[1]),
    'cloud.provision': args => cloud.provision(args[0]),
    'cloud.sync': args => cloud.sync(args[0]),
    'cloud.retry': args => cloud.retry(args[0]),
    'cloud.open': args => cloud.open(args[0]),
    'cloud.stop': args => cloud.stop(args[0]),
    'cloud.remove': args => cloud.remove(args[0]),
  };
  const run = async args => {
    if (args.op === 'state') return state;
    if (args.op === 'refuse') {
      try { return await calls[args.call](args.args ?? []); } catch (error) {
        const code = String(error?.code ?? error?.message ?? error);
        state.refused.push(code);
        return { refused: code, path: error?.path ?? '$', ids: Array.isArray(error?.ids) ? error.ids : [] };
      }
    }
    if (!calls[args.op]) throw new Error('InvalidShape');
    return calls[args.op](args.args ?? []);
  };
  panda.commands.register('sample.runtime-workspace-cloud/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
