// R0202 fixture: a background service that listens to every workspace event and records what it sees, in order.
// The command `sample.workspace-events/control` is the only way to look at or steer it, chosen by `args.op`:
//   received -> every envelope seen so far (and how many handlers run at once, which must stay 1)
//   pause    -> the handlers wait (a consumer that cannot keep up)
//   resume   -> the handlers go on
//   off      -> dispose the listener of args.kind
//   on       -> listen to args.kind again
//   state    -> which kinds the service listens to and how many times subscribing was refused
//   reset    -> forget what was received
const KINDS = [
  'task.created', 'task.removed', 'task.shown', 'task.stopped', 'task.idle', 'task.compacted',
  'turn.started', 'turn.finished', 'turn.failed', 'project.opened', 'project.closed', 'settings.changed', 'app.focus', 'gap',
];
exports.service = async (panda, lifetime) => {
  const state = { received: [], active: 0, overlap: 0, paused: false };
  let release = () => {};
  let gate = Promise.resolve();
  const disposables = new Map();
  const handler = async event => {
    state.active += 1; state.overlap = Math.max(state.overlap, state.active);
    try { await gate; state.received.push(event); } finally { state.active -= 1; }
  };
  const listen = kind => { if (!disposables.has(kind)) disposables.set(kind, panda.events.on(kind, handler)); };
  KINDS.forEach(listen);
  panda.commands.register('sample.workspace-events/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'received': return { received: [...state.received], overlap: state.overlap };
      case 'pause': if (!state.paused) { state.paused = true; gate = new Promise(resolve => { release = resolve; }); } return { paused: true };
      case 'resume': state.paused = false; release(); return { paused: false };
      case 'off': { const one = disposables.get(args.kind); if (one) { one.dispose(); disposables.delete(args.kind); } return { listening: [...disposables.keys()] }; }
      case 'on': listen(args.kind); return { listening: [...disposables.keys()] };
      case 'state': return { listening: [...disposables.keys()], paused: state.paused, received: state.received.length };
      case 'reset': state.received.length = 0; state.overlap = 0; return { received: 0 };
      default: throw new Error('InvalidShape');
    }
  });
  lifetime.onStop(() => { for (const one of disposables.values()) one.dispose(); disposables.clear(); });
};
