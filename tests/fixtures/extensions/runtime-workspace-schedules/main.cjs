// R0406B fixture: a background service that manages recipes and wake-ups when it is told to, by the command
// `sample.runtime-workspace-schedules/control` (the browser spec and the native test drive it).
// `op` is one of:
//   recipes.list    -> panda.workspace.recipes.list(args.options)
//   recipes.save    -> panda.workspace.recipes.save(args.recipe)
//   recipes.remove  -> panda.workspace.recipes.remove(args.recipeId)
//   recipes.run     -> panda.workspace.recipes.run(args.recipeId, args.options)
//   wakeups.list    -> panda.workspace.wakeups.list(args.options)
//   wakeups.create  -> panda.workspace.wakeups.create(args.input)
//   wakeups.update  -> panda.workspace.wakeups.update(args.wakeupId, args.input)
//   wakeups.remove  -> panda.workspace.wakeups.remove(args.wakeupId)
//   refuse          -> the call named by args.call (for example `recipes.run`) with the same arguments, answering the
//                      refusal as `{ refused: <code>, path, ids }` instead of throwing
//   state           -> every refusal so far
// The package never names pairing, cloud sign-in or access approval: they are the user's, and no call here reaches them.
exports.service = async (panda, lifetime) => {
  const state = { calls: 0, refused: [] };
  const recipes = panda.workspace.recipes;
  const wakeups = panda.workspace.wakeups;
  const report = () => lifetime.setStatus({ text: JSON.stringify({ calls: state.calls, refused: state.refused }) });
  const calls = {
    'recipes.list': args => recipes.list(args.options),
    'recipes.save': args => recipes.save(args.recipe),
    'recipes.remove': args => recipes.remove(args.recipeId),
    'recipes.run': args => recipes.run(args.recipeId, args.options),
    'wakeups.list': args => wakeups.list(args.options),
    'wakeups.create': args => wakeups.create(args.input),
    'wakeups.update': args => wakeups.update(args.wakeupId, args.input),
    'wakeups.remove': args => wakeups.remove(args.wakeupId),
  };
  const run = async args => {
    if (args.op === 'state') return state;
    if (args.op === 'refuse') {
      try { state.calls += 1; return await calls[args.call](args); } catch (error) {
        const code = String(error?.code ?? error?.message ?? error);
        state.refused.push(code);
        return { refused: code, path: error?.path ?? null, ids: error?.ids ?? [] };
      }
    }
    const call = calls[args.op];
    if (!call) throw new Error(`Unknown op ${args.op}`);
    state.calls += 1;
    return call(args);
  };
  panda.commands.register('sample.runtime-workspace-schedules/control', async invocation => {
    const result = await run(invocation?.args ?? invocation ?? {});
    await report();
    return result;
  });
  await report();
};
