// R0506 fixture: the first of two packages in one tool.before chain.
//   tool.before: "npm " becomes "pnpm " (rewrite); "slow" answers after 5 s, past its 1 s budget (the host times it
//                out, applies onFailure: deny and sends a Timeout receipt for the late answer); "explode" throws;
//                "bad" returns an invalid decision; anything else returns nothing.
// The command `sample.hook-alpha/control` answers { received, receipts } for args.op 'received' and clears both for
// 'reset'.
exports.service = async (panda, lifetime) => {
  const state = { received: [], receipts: [] };
  const hook = panda.hooks.on('tool.before', async call => {
    const command = typeof call.input?.command === 'string' ? call.input.command : '';
    state.received.push({ callId: call.callId, command });
    if (command === 'slow') { await new Promise(resolve => setTimeout(resolve, 5000)); return { decision: 'deny', reason: 'too late' }; }
    if (command === 'explode') throw new Error('Boom');
    if (command === 'bad') return { decision: 'maybe' };
    if (command.startsWith('npm ') && call.can.includes('rewriteInput')) return { decision: 'rewrite', input: { ...call.input, command: `pnpm ${command.slice(4)}` } };
    return undefined;
  });
  const applied = panda.hooks.onApplied(receipt => { state.receipts.push(receipt); });
  panda.commands.register('sample.hook-alpha/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'received') return { received: [...state.received], receipts: [...state.receipts] };
    if (args.op === 'reset') { state.received.length = 0; state.receipts.length = 0; return null; }
    throw new Error('InvalidShape');
  });
  lifetime.onStop(() => { hook.dispose(); applied.dispose(); });
};
