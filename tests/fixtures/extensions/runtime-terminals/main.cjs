// R0409 fixture: a background service that lists, reads and operates terminals, driven by the command
// `sample.runtime-terminals/control` (the panel button of the acceptance, the browser spec and the native test).
// `args.op` is one of:
//   list     -> panda.terminals.list({ projectId? })                        answers [{ id, title, cwd, projectId, taskId, kind, running, exitCode }]
//   read     -> panda.terminals.read({ terminalId, cursor? })               one 64 KiB page { data, cursor, nextCursor, dropped, exited, exitCode }
//   readAll  -> every page of one terminal in order; answers { pages, bytes, text, dropped }
//   open     -> panda.terminals.open({ projectId, taskId?, cols?, rows? })  answers { id, projectId, taskId }; the shell is inert until written to
//   write    -> panda.terminals.write({ terminalId, data })                 sends input (for example 'echo ready\r')
//   close    -> panda.terminals.close({ terminalId })
//   watch    -> panda.terminals.onOutput({ terminalId, cursor? }, handler)  keeps every coalesced chunk with its arrival time
//   chunks   -> the chunks a `watch` received so far, and whether it ended
//   unwatch  -> disposes a `watch`
//   refuse   -> any of the above as `args.call` with `args.options`, answering { refused: <code>, path, ids } instead of throwing
//   state    -> what the service holds: the watches and every refusal so far
// The package never names a credential and has no way to read a secret.
exports.service = async (panda, lifetime) => {
  const state = { refused: [], watches: new Map() };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused, watches: [...state.watches.keys()] }) });
  const calls = {
    list: options => panda.terminals.list(options),
    read: options => panda.terminals.read(options),
    open: options => panda.terminals.open(options),
    write: options => panda.terminals.write(options),
    close: options => panda.terminals.close(options),
  };
  const readAll = async options => {
    let cursor = options.cursor ?? 0, pages = 0, bytes = 0, dropped = 0, text = '';
    for (;;) {
      const page = await panda.terminals.read({ terminalId: options.terminalId, cursor });
      pages += 1; bytes += Buffer.byteLength(page.data); dropped += page.dropped; text += page.data;
      if (page.nextCursor === cursor || page.data === '') return { pages, bytes, text, dropped, exited: page.exited };
      cursor = page.nextCursor;
    }
  };
  const watch = async options => {
    const entry = { chunks: [], ended: false, startedAt: Date.now() };
    entry.subscription = panda.terminals.onOutput({ terminalId: options.terminalId, cursor: options.cursor }, chunk => {
      entry.chunks.push({ at: Date.now() - entry.startedAt, cursor: chunk.cursor, nextCursor: chunk.nextCursor, data: chunk.data, dropped: chunk.dropped, exited: chunk.exited });
      if (chunk.exited) entry.ended = true;
    });
    state.watches.set(options.terminalId, entry);
    return { watching: options.terminalId };
  };
  const run = async args => {
    if (args.op === 'state') return { refused: state.refused, watches: [...state.watches.keys()] };
    if (args.op === 'readAll') return readAll(args.options);
    if (args.op === 'watch') return watch(args.options);
    if (args.op === 'chunks') { const entry = state.watches.get(args.options.terminalId); return entry ? { chunks: entry.chunks, ended: entry.ended } : { chunks: [], ended: false }; }
    if (args.op === 'unwatch') { const entry = state.watches.get(args.options.terminalId); entry?.subscription.dispose(); state.watches.delete(args.options.terminalId); return { unwatched: true }; }
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
  panda.commands.register('sample.runtime-terminals/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
