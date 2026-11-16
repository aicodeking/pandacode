// R0201 fixture: a background service whose owned commands share one state and talk to the host while other
// commands run. Every behaviour is chosen by `context.args.op` of the dispatched command.
//   state      -> the shared state (how many commands ran, which ones are in flight)
//   delay      -> resolves after args.ms
//   ask        -> one context query to the host (the host's fake answers after args.hostMs), then returns it
//   two        -> two concurrent context queries (args.first / args.second host delays); returns the resolve order
//   big        -> returns a string of args.size characters
//   hang       -> never settles
//   flood      -> args.count concurrent context events requests; returns how many were served or refused, by code
// At start, before any command, the service makes one context query: the host refuses it as stale (state.startup).
exports.service = async (panda, lifetime) => {
  const state = { ran: 0, inFlight: 0, peak: 0, order: [], startup: 'pending' };
  await panda.context.query({}).then(() => { state.startup = 'served'; }, error => { state.startup = error.message; });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const enter = tag => { state.ran += 1; state.inFlight += 1; state.peak = Math.max(state.peak, state.inFlight); state.order.push(`start:${tag}`); };
  const leave = tag => { state.inFlight -= 1; state.order.push(`end:${tag}`); };
  const handle = async context => {
    const args = context.args ?? {};
    enter(args.tag ?? args.op);
    try {
      switch (args.op) {
        case 'state': return { ...state, order: [...state.order] };
        case 'delay': await wait(args.ms ?? 0); return { tag: args.tag, ran: state.ran, commandId: context.commandId };
        case 'ask': { const answer = await panda.context.query({ hostMs: args.hostMs ?? 0, tag: args.tag }); return { tag: args.tag, ran: state.ran, answer }; }
        case 'two': {
          const resolved = [];
          const one = (tag, hostMs) => panda.context.query({ hostMs, tag }).then(() => { resolved.push(tag); });
          await Promise.all([one('first', args.first ?? 0), one('second', args.second ?? 0)]);
          return { resolved, ran: state.ran };
        }
        case 'big': return 'x'.repeat(args.size ?? 0);
        case 'hang': await new Promise(() => {}); return null;
        case 'flood': {
          const outcomes = {};
          await Promise.all(Array.from({ length: args.count ?? 0 }, () => panda.context.events({ hostMs: args.hostMs ?? 0 }).then(
            () => { outcomes.ok = (outcomes.ok ?? 0) + 1; },
            error => { outcomes[error.message] = (outcomes[error.message] ?? 0) + 1; })));
          return outcomes;
        }
        default: throw new Error('InvalidShape');
      }
    } finally { leave(args.tag ?? args.op); }
  };
  panda.commands.register('sample.duplex-channel/echo', handle);
  panda.commands.register('sample.duplex-channel/other', async context => ({ other: true, ran: state.ran, args: context.args }));
  lifetime.onStop(() => {});
};
