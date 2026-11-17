// Fixture service of slice R0704: `sample.ask/ask` asks one question through panda.models.call and returns the answer.
// `context.prompt` is the prompt (default `#reply four`, which the scripted harness B5 answers with `four`); `context.signal`
// style cancellation is exercised by the spec through `cancel`.
exports.service = async panda => {
  const pending = new Map();
  panda.commands.register('sample.ask/ask', async (context = {}) => {
    const controller = new AbortController();
    if (typeof context.id === 'string') pending.set(context.id, controller);
    try {
      return await panda.models.call({ prompt: context.prompt ?? '#reply four', timeoutMs: context.timeoutMs, signal: controller.signal });
    } finally {
      if (typeof context.id === 'string') pending.delete(context.id);
    }
  });
  panda.commands.register('sample.ask/cancel', async (context = {}) => { pending.get(context.id)?.abort(); return { cancelled: pending.has(context.id) }; });
};
