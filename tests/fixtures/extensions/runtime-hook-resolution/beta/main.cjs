// R0506 fixture: the second of two packages in one tool.before chain.
//   tool.before: "rm -rf" is denied with a reason; "pnpm " becomes "yarn " (rewrite: it sees the input as Alpha left
//                it, so the order decides the result); anything else returns nothing.
// The command `sample.hook-beta/control` answers { received, receipts } for args.op 'received' and clears both for
// 'reset'.
exports.service = async (panda, lifetime) => {
  const state = { received: [], receipts: [] };
  const hook = panda.hooks.on('tool.before', async call => {
    const command = typeof call.input?.command === 'string' ? call.input.command : '';
    state.received.push({ callId: call.callId, command });
    if (command.includes('rm -rf')) return { decision: 'deny', reason: 'rm -rf is not allowed' };
    if (command.startsWith('pnpm ') && call.can.includes('rewriteInput')) return { decision: 'rewrite', input: { ...call.input, command: `yarn ${command.slice(5)}` } };
    return undefined;
  });
  const applied = panda.hooks.onApplied(receipt => { state.receipts.push(receipt); });
  panda.commands.register('sample.hook-beta/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'received') return { received: [...state.received], receipts: [...state.receipts] };
    if (args.op === 'reset') { state.received.length = 0; state.receipts.length = 0; return null; }
    throw new Error('InvalidShape');
  });
  lifetime.onStop(() => { hook.dispose(); applied.dispose(); });
};
