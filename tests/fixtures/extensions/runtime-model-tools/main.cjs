// R0701 fixture: a background service that answers the model tools its manifest declares.
//   memory:      mode add / search / list / forget over an in-memory list (per project); the answer is the envelope
//                { content }, and a search without a hit answers { content, isError: true }.
//   slow_recall: never answers (the declaration allows 100 ms: the host gives the model a Timeout error result).
//   big_dump:    answers a result one byte past 64 KiB (LimitExceeded).
//   bare_value:  answers a bare string instead of the envelope (InvalidShape).
//   broken:      answers { content: 'it broke', isError: true }.
// Every call the service received (input and the ModelToolCall) is kept: the command `sample.memory/control` answers
// { calls } for args.op 'calls' and clears them for 'reset'.
exports.service = async (panda, lifetime) => {
  const state = { calls: [], memories: new Map() };
  const list = projectId => { if (!state.memories.has(projectId)) state.memories.set(projectId, []); return state.memories.get(projectId); };
  const tools = [
    panda.modelTools.register('sample.memory/memory', async (input, call) => {
      state.calls.push({ tool: 'memory', input, call });
      const memories = list(call.projectId);
      if (input.mode === 'add') { memories.push(input.content ?? ''); return { content: { added: memories.length } }; }
      if (input.mode === 'list') return { content: { memories: memories.slice(0, input.limit ?? 50) } };
      if (input.mode === 'forget') { const count = memories.length; memories.length = 0; return { content: { forgot: count } }; }
      const hits = memories.filter(memory => memory.includes(input.content ?? ''));
      return hits.length ? { content: { hits } } : { content: 'No memory matches.', isError: true };
    }),
    panda.modelTools.register('sample.memory/slow_recall', async (input, call) => {
      state.calls.push({ tool: 'slow_recall', input, call });
      await new Promise(resolve => setTimeout(resolve, 5_000));
      return { content: 'too late' };
    }),
    panda.modelTools.register('sample.memory/big_dump', async (input, call) => {
      state.calls.push({ tool: 'big_dump', input, call });
      return { content: 'x'.repeat(65_535) };
    }),
    panda.modelTools.register('sample.memory/bare_value', async (input, call) => {
      state.calls.push({ tool: 'bare_value', input, call });
      return 'not an envelope';
    }),
    panda.modelTools.register('sample.memory/broken', async (input, call) => {
      state.calls.push({ tool: 'broken', input, call });
      return { content: 'it broke', isError: true };
    }),
  ];
  panda.commands.register('sample.memory/control', async context => {
    const args = context.args ?? {};
    if (args.op === 'calls') return { calls: [...state.calls] };
    if (args.op === 'reset') { state.calls.length = 0; state.memories.clear(); return null; }
    throw new Error('InvalidShape');
  });
  lifetime.onStop(() => { for (const tool of tools) tool.dispose(); });
};
