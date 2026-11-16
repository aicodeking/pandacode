// R0203 fixture: a background service that reads its own settings page and the content resources of a task.
// The command `sample.content-resources/control` is the only way to look at or steer it, chosen by `args.op`:
//   settings -> panda.settings.get({ page: args.page }) answered as { ok, value | code }
//   query    -> panda.context.query(args.query) answered as { ok, value | code }
//   changes  -> every settings.changed event seen so far, and the revision read after each one
//   reset    -> forget what was seen
const PAGE = 'sample.content-resources/preferences';
const answer = async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, code: error?.code ?? error?.message ?? 'HostUnavailable' }; } };
exports.service = async panda => {
  const seen = [];
  panda.events.on('settings.changed', async event => {
    // The notice carries only the page and the revision: the service reads the values again.
    const reread = await answer(() => panda.settings.get({ page: event.page }));
    seen.push({ page: event.page, revision: event.revision, reread });
  });
  panda.commands.register('sample.content-resources/control', async context => {
    const args = context.args ?? {};
    switch (args.op) {
      case 'settings': return answer(() => panda.settings.get({ page: args.page ?? PAGE }));
      case 'query': return answer(() => panda.context.query(args.query));
      case 'changes': return { seen: [...seen] };
      case 'reset': seen.length = 0; return { seen: 0 };
      default: throw new Error('InvalidShape');
    }
  });
};
