// R0505 fixture: a background service that decides tool calls before they run (a small destructive-command guard).
//   tool.before: a shell command containing "rm -rf" is denied with a reason; reads and searches are approved; a
//                command starting with "curl " asks the user (network access); a command starting with "npm " is
//                rewritten to "pnpm " (the host applies it only where the payload's `can` lists rewriteInput, and
//                says so in the receipt otherwise); "explode" throws (the declaration says onFailure: ask); anything
//                else returns nothing, so the normal behaviour continues.
// Every call it saw and every receipt the host sends back (panda.hooks.onApplied) is recorded. The command
// `sample.hook-guard/control` answers { received, receipts } for args.op 'received' and clears both for 'reset'.
exports.service = async (panda, lifetime) => {
  const state = { received: [], receipts: [] };
  const hook = panda.hooks.on('tool.before', async call => {
    const command = typeof call.input?.command === 'string' ? call.input.command : '';
    state.received.push({ callId: call.callId, kind: call.tool.kind, source: call.source, coverage: call.coverage, can: call.can, command });
    if (command.includes('rm -rf')) return { decision: 'deny', reason: 'rm -rf outside the project' };
    if (call.tool.kind === 'read' || call.tool.kind === 'search') return { decision: 'approve', note: 'Reads are safe' };
    if (command.startsWith('curl ')) return { decision: 'ask', reason: 'network access' };
    if (command.startsWith('npm ')) return { decision: 'rewrite', input: { ...call.input, command: `pnpm ${command.slice(4)}` } };
    if (command === 'explode') throw new Error('InvalidShape');
    return undefined;
  });
  const applied = panda.hooks.onApplied(receipt => { state.receipts.push(receipt); });
  panda.commands.register('sample.hook-guard/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'received') return { received: [...state.received], receipts: [...state.receipts] };
    if (args.op === 'reset') { state.received.length = 0; state.receipts.length = 0; return null; }
    throw new Error('InvalidShape');
  });
  lifetime.onStop(() => { hook.dispose(); applied.dispose(); });
};
