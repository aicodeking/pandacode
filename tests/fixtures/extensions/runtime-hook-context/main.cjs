// R0504 fixture: a background service that answers the hooks whose returns the host applies.
//   prompt.submit: "recall: <topic>" adds context, "fix: <text>" rewrites the prompt, a prompt naming "secret" is
//                  blocked, "slow" never answers in time (the declaration says onFailure: deny), anything else
//                  returns nothing.
//   tool.after:    a completed host tool `pandacode_echo` gets its result rewritten; any other call returns nothing.
//   compaction:    phase 'before' returns instructions and a summary (the host offers no summary: the receipt says
//                  UnsupportedCapability for it); phase 'after' returns nothing.
// Every receipt the host sends back (panda.hooks.onApplied) is recorded. The command `sample.hook-context/control`
// answers { received, receipts } for args.op 'received' and clears both for 'reset'.
exports.service = async (panda, lifetime) => {
  const state = { received: [], receipts: [] };
  const hooks = [
    panda.hooks.on('prompt.submit', async turn => {
      state.received.push({ event: 'prompt.submit', text: turn.text, sinceCompaction: turn.sinceCompaction });
      if (turn.text.startsWith('recall: ')) return { context: `Remembered about ${turn.text.slice(8)}: the team uses pnpm.`, note: 'Recalled one memory' };
      if (turn.text.startsWith('fix: ')) return { prompt: turn.text.slice(5).trim() };
      if (/secret/i.test(turn.text)) return { block: { reason: 'The message names a secret.' } };
      if (turn.text === 'slow') await new Promise(resolve => setTimeout(resolve, 5_000));
      return undefined;
    }),
    panda.hooks.on('tool.after', async call => {
      state.received.push({ event: 'tool.after', name: call.tool.name, status: call.status, can: call.can });
      if (call.tool.name === 'pandacode_echo' && call.status === 'completed') return { output: { rewritten: true, original: call.output } };
      return undefined;
    }),
    panda.hooks.on('compaction', async event => {
      state.received.push({ event: 'compaction', phase: event.phase, can: event.can });
      if (event.phase === 'before') return { instructions: 'Keep the API decisions.', summary: 'A summary the host cannot use.' };
      return undefined;
    }),
    panda.hooks.on('turn.start', turn => { state.received.push({ event: 'turn.start', sinceCompaction: turn.sinceCompaction }); }),
  ];
  const applied = panda.hooks.onApplied(receipt => { state.receipts.push(receipt); });
  panda.commands.register('sample.hook-context/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'received') return { received: [...state.received], receipts: [...state.receipts] };
    if (args.op === 'reset') { state.received.length = 0; state.receipts.length = 0; return null; }
    throw new Error('InvalidShape');
  });
  lifetime.onStop(() => { for (const hook of hooks) hook.dispose(); applied.dispose(); });
};
