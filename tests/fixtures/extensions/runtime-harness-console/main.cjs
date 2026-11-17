// R0408 fixture: a background service that opens harness consoles and runs command-center actions, driven by the command
// `sample.runtime-harness-console/control` (the panel button of the acceptance, the browser spec and the native test).
// `args.op` is one of:
//   open     -> panda.harnesses.console.open({ taskId } | { harness, projectId })      answers null
//   list     -> panda.harnesses.commands.list({ harness })                              answers [{ id, title }]
//   run      -> panda.harnesses.commands.run({ taskId, command, arguments? })           answers null
//   runFirst -> lists the harness's commands, then runs the first one whose id is `args.options.command` on `taskId`
//   refuse   -> any of the above as `args.call` with `args.options`, answering { refused: <code>, path, ids } instead of throwing
//   state    -> what the service holds: every refusal so far
// The package names no credential and has no call that types into a terminal: a console is opened for the user.
exports.service = async (panda, lifetime) => {
  const state = { refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused }) });
  const calls = {
    open: options => panda.harnesses.console.open(options),
    list: options => panda.harnesses.commands.list(options),
    run: options => panda.harnesses.commands.run(options),
  };
  const run = async args => {
    if (args.op === 'state') return state;
    if (args.op === 'runFirst') {
      const commands = await calls.list({ harness: args.options.harness });
      const found = commands.find(command => command.id === args.options.command);
      if (!found) return { missing: args.options.command, listed: commands.map(command => command.id) };
      await calls.run({ taskId: args.options.taskId, command: found.id, ...(args.options.arguments !== undefined ? { arguments: args.options.arguments } : {}) });
      return { ran: found.id };
    }
    if (args.op === 'refuse') {
      try { return await calls[args.call](args.options); } catch (error) {
        const code = String(error?.code ?? error?.message ?? error);
        state.refused.push(code);
        return { refused: code, path: error?.path ?? '$', ids: Array.isArray(error?.ids) ? error.ids : [] };
      }
    }
    if (!calls[args.op]) throw new Error('InvalidShape');
    return calls[args.op](args.options);
  };
  panda.commands.register('sample.runtime-harness-console/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
