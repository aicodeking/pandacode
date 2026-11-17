// R0403 fixture: a background service that edits composer drafts and reads attachments, driven by the command
// `sample.runtime-tasks-drafts/control` (the panel button of the acceptance, the browser spec and the native test).
// `args.op` is one of:
//   get      -> panda.tasks.draft.get(target)                   answers { text, attachments, revision }
//   set      -> panda.tasks.draft.set({ ...target, text, revision? })      replaces the draft (one undo step); never sends
//   insert   -> panda.tasks.draft.insert({ ...target, text })              inserts at the caret (one undo step); never sends
//   suggest  -> panda.tasks.draft.suggest({ ...target, text })             ghost text; never becomes the draft by itself
//   attach   -> panda.tasks.draft.attach({ ...target, path })              answers { id }
//   detach   -> panda.tasks.draft.detach({ ...target, attachmentId })
//   read     -> panda.tasks.attachments.read({ taskId, attachmentId, cursor? })   one 256 KiB page
//   readAll  -> every page of one attachment in order; answers { bytes, pages, digest } (a sum of the decoded bytes)
//   refuse   -> any of the above as `args.call` with `args.options`, answering { refused: <code>, path, ids } instead of throwing
//   state    -> what the service holds: every refusal so far
// `target` is `{ windowId }` or `{ taskId }`. The package has no call that sends a message and never names a credential.
exports.service = async (panda, lifetime) => {
  const state = { refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused }) });
  const calls = {
    get: options => panda.tasks.draft.get(options),
    set: options => panda.tasks.draft.set(options),
    insert: options => panda.tasks.draft.insert(options),
    suggest: options => panda.tasks.draft.suggest(options),
    attach: options => panda.tasks.draft.attach(options),
    detach: options => panda.tasks.draft.detach(options),
    read: options => panda.tasks.attachments.read(options),
  };
  const readAll = async options => {
    let cursor = options.cursor ?? 0, pages = 0, bytes = 0, digest = 0;
    for (;;) {
      const page = await panda.tasks.attachments.read({ taskId: options.taskId, attachmentId: options.attachmentId, cursor });
      const decoded = Buffer.from(page.data, 'base64');
      for (const byte of decoded) digest = (digest + byte) % 1000003;
      bytes += decoded.length; pages += 1;
      if (page.nextCursor === null) return { bytes, pages, digest, total: page.bytes };
      cursor = page.nextCursor;
    }
  };
  const run = async args => {
    if (args.op === 'state') return state;
    if (args.op === 'readAll') return readAll(args.options);
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
  panda.commands.register('sample.runtime-tasks-drafts/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
