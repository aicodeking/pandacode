// R0703 fixture: a background service that answers the package's model tools. The tool servers are declared in the
// manifest and attached by the host; this service never sees a held credential (there is no `credentials.read`).
//   recall:   answers { content: { echo: input } }.
//   quiet:    answers { content: 'quiet' } and is declared without a prompt.
//   big_dump: answers a result one byte past 64 KiB (the host never delivers it).
exports.service = async panda => {
  const tools = [
    panda.modelTools.register('sample.parity/recall', async input => ({ content: { echo: input } })),
    panda.modelTools.register('sample.parity/quiet', async () => ({ content: 'quiet' })),
    panda.modelTools.register('sample.parity/big_dump', async () => ({ content: 'x'.repeat(65_535) })),
  ];
  return { dispose: () => Promise.all(tools).then(registered => registered.forEach(tool => tool && tool.dispose && tool.dispose())) };
};
