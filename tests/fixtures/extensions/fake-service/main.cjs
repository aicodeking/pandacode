// No startup request. Host-owned UI obtains the invocation-scoped opaque handle first.
exports.activate = panda => {
  panda.commands.register('sample.fake-service/request', async () => {
    const resource = { connection: 'sample.fake-service/api', operation: 'summary' };
    const status = await panda.connections.status(resource);
    if (status.state !== 'connected') return;
    let request = await panda.connections.start({ ...resource, credential: status.credential });
    while (request.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 25));
      request = await panda.connections.poll({ ...resource, request: request.request });
    }
    if (request.error) throw new Error(request.error);
    await panda.ui.showDialog({ title: 'Sanitized service summary', fields: [], successMessage: `Accepted ${request.response.accepted}; count ${request.response.count}` });
  });
};
