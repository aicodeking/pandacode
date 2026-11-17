// R0406 fixture: a background service that creates, changes and removes bots and shared channels when it is told to, by
// the command `sample.runtime-workspace-automation/control` (the browser spec and the native test drive it).
// `op` is one of:
//   bots.create    -> panda.workspace.bots.create(args.input)
//   bots.update    -> panda.workspace.bots.update(args.id, args.input)
//   bots.remove    -> panda.workspace.bots.remove(args.id)
//   channels.create / channels.update / channels.remove -> the same three calls on panda.workspace.channels
//   refuse         -> the call named by args.call (for example "bots.update") answering the refusal as
//                     `{ refused: <code>, path }` instead of throwing
//   lifecycle      -> creates a bot and a channel with it, renames and re-staffs the channel, patches the bot, removes both
//                     and answers every step (the action counts to compare with the interface's own route)
//   state          -> every answer and every refusal so far
// The package never names a project or a credential: bots and channels belong to the app's own bot workspace, and
// `workspace.manage` is the only permission the calls need. Removing asks the user first unless the user turned that off.
exports.service = async (panda, lifetime) => {
  const state = { calls: 0, refused: [], created: { bots: [], channels: [] } };
  const api = { bots: panda.workspace.bots, channels: panda.workspace.channels };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ calls: state.calls, refused: state.refused, created: state.created }) });
  const run = async (name, args) => {
    const [family, call] = name.split('.');
    const target = api[family];
    state.calls += 1;
    if (call === 'create') {
      const created = await target.create(args.input);
      state.created[family].push(created.id);
      return created;
    }
    if (call === 'update') return target.update(args.id, args.input);
    if (call === 'remove') return target.remove(args.id);
    throw new Error(`Unknown call ${name}`);
  };
  const lifecycle = async args => {
    const steps = {};
    steps.bot = await run('bots.create', { input: args.bot });
    steps.second = await run('bots.create', { input: { ...args.bot, name: `${args.bot.name} two` } });
    steps.channel = await run('channels.create', { input: { name: args.channel.name, memberIds: [steps.bot.id] } });
    steps.channelRenamed = await run('channels.update', { id: steps.channel.id, input: { name: `${args.channel.name}-2`, memberIds: [steps.bot.id, steps.second.id], leadBotId: steps.second.id } });
    steps.botPatched = await run('bots.update', { id: steps.bot.id, input: args.patch });
    steps.channelRemoved = await run('channels.remove', { id: steps.channel.id });
    steps.botRemoved = await run('bots.remove', { id: steps.bot.id });
    steps.secondRemoved = await run('bots.remove', { id: steps.second.id });
    return steps;
  };
  panda.commands.register('sample.runtime-workspace-automation/control', async invocation => {
    const args = invocation?.args ?? invocation ?? {};
    let result;
    switch (args.op) {
      case 'state': result = state; break;
      case 'lifecycle': result = await lifecycle(args); break;
      case 'refuse':
        try { result = await run(args.call, args); } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          result = { refused: code, path: error?.path ?? null };
        }
        break;
      default: result = await run(args.op, args);
    }
    await report();
    return result;
  });
  await report();
};
