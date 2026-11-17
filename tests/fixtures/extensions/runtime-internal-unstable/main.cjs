// R1301 fixture: a background service that uses the unstable internal interface, driven by the command
// `sample.runtime-internal-unstable/control` (the panel button of the acceptance, the browser spec and the native test).
// `args.op` is one of:
//   info    -> panda.internal.invoke('internal.info')                      answers the inert host description (stability: 'unstable')
//   echo    -> panda.internal.invoke('internal.echo', args.payload)        answers { echo }, and the host raises `internal.echoed`
//   listen  -> panda.internal.listen('internal.echoed', handler)           keeps every event it receives
//   events  -> the events a `listen` received so far
//   unlisten-> disposes the `listen`
//   refuse  -> any invoke as `args.command` with `args.payload`, answering { refused: <code>, path } instead of throwing
//   state   -> what the service holds: the listener and every refusal so far
// The package never names a credential and has no way to read a secret; no reference package depends on these calls.
exports.service = async (panda, lifetime) => {
  const state = { refused: [], events: [], listener: null };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused, events: state.events.length, listening: state.listener !== null }) });
  const run = async args => {
    if (args.op === 'info') return panda.internal.invoke('internal.info');
    if (args.op === 'echo') return panda.internal.invoke('internal.echo', args.payload ?? {});
    if (args.op === 'listen') {
      state.listener?.dispose();
      state.listener = panda.internal.listen(args.event ?? 'internal.echoed', payload => { state.events.push(payload); });
      return { listening: true };
    }
    if (args.op === 'events') return { events: state.events };
    if (args.op === 'unlisten') { state.listener?.dispose(); state.listener = null; return { listening: false }; }
    if (args.op === 'state') return { refused: state.refused, events: state.events.length, listening: state.listener !== null };
    if (args.op === 'refuse') {
      try { return await panda.internal.invoke(args.command, args.payload); } catch (error) {
        const code = String(error?.code ?? error?.message ?? error);
        state.refused.push(code);
        return { refused: code, path: error?.path ?? '$' };
      }
    }
    throw new Error('InvalidShape');
  };
  panda.commands.register('sample.runtime-internal-unstable/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
