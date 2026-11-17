// R0503 fixture: a background service that observes every hook event this slice delivers and records what it sees,
// in order. It also tries to attach `save.before`, which its manifest does not declare (the host answers
// UnknownReference), and returns a decision from `tool.before`, which the host never reads (observe only).
// The command `sample.hook-observer/control` is the only way to look at or steer it, chosen by `args.op`:
//   received -> every payload seen so far as { event, hookId?, payload } and the refusals of registration
//   off      -> dispose the handler of args.event
//   on       -> attach args.event again
//   state    -> which events are attached and how many handlers ran at once (must stay 1)
//   input    -> panda.hooks.input(args) (the complete serialization of a large tool input)
//   reset    -> forget what was received
const EVENTS = ['turn.start', 'prompt.submit', 'tool.before', 'tool.after', 'turn.finish', 'turn.fail', 'task.idle', 'compaction'];
exports.service = async (panda, lifetime) => {
  const state = { received: [], refused: {}, active: 0, overlap: 0 };
  const attached = new Map();
  const handler = event => async payload => {
    state.active += 1; state.overlap = Math.max(state.overlap, state.active);
    try {
      state.received.push({ event, payload });
      // An observer that tries to decide: the host never awaits or reads this.
      if (event === 'tool.before') return { decision: 'approve', reason: 'an observer cannot approve' };
    } finally { state.active -= 1; }
  };
  const attach = event => {
    if (attached.has(event)) return;
    const hook = panda.hooks.on(event, handler(event));
    attached.set(event, hook);
    hook.ready.catch(error => { state.refused[event] = error.code ?? error.message; attached.delete(event); });
  };
  EVENTS.forEach(attach);
  attach('save.before');
  panda.commands.register('sample.hook-observer/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'received': return { received: [...state.received], refused: { ...state.refused } };
      case 'off': { const hook = attached.get(args.event); if (hook) { hook.dispose(); attached.delete(args.event); } return { attached: [...attached.keys()] }; }
      case 'on': attach(args.event); return { attached: [...attached.keys()] };
      case 'state': return { attached: [...attached.keys()], overlap: state.overlap, received: state.received.length };
      case 'input': return await panda.hooks.input({ callId: args.callId, cursor: args.cursor ?? 0 });
      case 'reset': state.received.length = 0; state.overlap = 0; return { received: 0 };
      default: throw new Error('InvalidShape');
    }
  });
  lifetime.onStop(() => { for (const hook of attached.values()) hook.dispose(); attached.clear(); });
};
