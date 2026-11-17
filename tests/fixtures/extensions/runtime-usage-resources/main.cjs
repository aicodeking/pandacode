// R0204 fixture: a background service that reads usage, limits, accounts and metrics and refreshes limits.
// The command `sample.usage-resources/control` is the only way to steer it, chosen by `args.op`:
//   query   -> panda.context.query(args.query) answered as { ok, value | code }
//   refresh -> panda.harnesses.refreshLimits({ harness: args.harness }) answered as { ok, value | code }
const answer = async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, code: error?.code ?? error?.message ?? 'HostUnavailable' }; } };
exports.service = async panda => {
  panda.commands.register('sample.usage-resources/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'query': return answer(() => panda.context.query(args.query));
      case 'refresh': return answer(() => panda.harnesses.refreshLimits(args.harness === undefined ? undefined : { harness: args.harness }));
      default: throw new Error('InvalidShape');
    }
  });
};
