// R0402 fixture: a background service that talks to a task when it is told to, by the command
// `sample.runtime-tasks-messages/control` (the panel button of the acceptance, the browser spec and the native test).
// `op` is one of:
//   message   -> panda.tasks.message(taskId, { text, attachments?, delivery? }); answers `{ id, delivery }`
//   refuse    -> the same call, answering the refusal as `{ refused: <code>, path, ids }` instead of throwing
//   note      -> panda.tasks.note(taskId, { text, forModel? }); answers `{ id }`
//   queue     -> panda.tasks.queue.<action>: list | update | remove | reorder | sendNow | resume, with `args.entryId`,
//                `args.text`, `args.revision` and `args.entryIds` as the action takes them
//   follow-up -> "send, queue, edit, reorder": a message to the task, a second one (queued when the task runs), an edit of
//                the second with the revision just read, then the queue reordered; answers the list at the end
//   state     -> what the service holds: every answer and every refusal so far
// The package never names a credential and never stops, starts or reconfigures a task: it holds tasks.message only.
exports.service = async (panda, lifetime) => {
  const state = { answers: [], refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ answers: state.answers.length, refused: state.refused }) });
  const keep = answer => { state.answers.push(answer); return answer; };
  const queue = async args => {
    const { taskId, entryId } = args;
    switch (args.action) {
      case 'list': return panda.tasks.queue.list(taskId);
      case 'update': return panda.tasks.queue.update(taskId, entryId, args.revision === undefined ? { text: args.text } : { text: args.text, revision: args.revision });
      case 'remove': return panda.tasks.queue.remove(taskId, entryId);
      case 'reorder': return panda.tasks.queue.reorder(taskId, args.entryIds);
      case 'sendNow': return panda.tasks.queue.sendNow(taskId, entryId);
      case 'resume': return panda.tasks.queue.resume(taskId);
      default: throw new Error('InvalidShape');
    }
  };
  const run = async args => {
    switch (args.op) {
      case 'message': return keep(await panda.tasks.message(args.taskId, args.message));
      case 'note': return keep(await panda.tasks.note(args.taskId, args.note));
      case 'queue': return keep(await queue(args));
      case 'refuse':
        try { return keep(await run(args.inner)); } catch (error) {
          const code = String(error?.code ?? error?.message ?? error);
          state.refused.push(code);
          return { refused: code, path: error?.path ?? null, ids: Array.isArray(error?.ids) ? error.ids : [] };
        }
      case 'follow-up': {
        const { taskId } = args;
        const first = await panda.tasks.message(taskId, { text: 'first follow-up' });
        const second = await panda.tasks.message(taskId, { text: 'second follow-up' });
        const listed = await panda.tasks.queue.list(taskId);
        const entry = listed.entries.find(row => row.id === second.id);
        if (entry) await panda.tasks.queue.update(taskId, entry.id, { text: 'second follow-up, edited', revision: listed.revision });
        const ids = (await panda.tasks.queue.list(taskId)).entries.map(row => row.id).reverse();
        if (ids.length > 1) await panda.tasks.queue.reorder(taskId, ids);
        return keep({ first, second, queue: await panda.tasks.queue.list(taskId) });
      }
      case 'state': return state;
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.runtime-tasks-messages/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });
};
