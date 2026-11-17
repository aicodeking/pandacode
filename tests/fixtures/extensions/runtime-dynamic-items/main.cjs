// R0205 fixture: a background service that adds, changes and removes live contributions when it is told to, either by
// the command `sample.dynamic-items/control` (the browser spec) or by a signal of the canonical B1 fake daemon (the
// native test hands B1's address in PANDA_FIXTURE_B1; a signal payload is `{op, ...}`). `op` is one of:
//   add      -> register a status item and a mark scoped to taskId (when given)
//   change   -> update them: text, badge, tone, tooltip, progress, enabled and visible
//   table    -> put a table row (with a command and arguments) into the manifest view
//   remove   -> dispose the live items
//   manifest -> change the status item of this package's own manifest
//   burst    -> update `count` times in a row (the 20 per second bound applies)
//   stale    -> use a handle after it was disposed
//   state    -> what the service holds and the last answers
// A click on a live item reaches `sample.dynamic-items/open` with its arguments as `context.args`; the service counts
// each delivery, so "exactly once" is observable (also in the status line: {opened, live}).
const net = require('node:net');

exports.service = async (panda, lifetime) => {
  const live = new Map();
  const state = { opened: [], refused: [] };
  const refuse = error => { state.refused.push(String(error?.message ?? error)); return null; };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ opened: state.opened, live: [...live.keys()], refused: state.refused }) });
  const run = async args => {
    switch (args.op) {
      case 'add': {
        live.set('alert', await panda.ui.register({ kind: 'menu', id: 'sample.dynamic-items/alert', location: 'panda.status.items', command: 'sample.dynamic-items/open', args: { build: 41 }, presentation: 'status', text: '3 builds failed', tone: 'warning', tooltip: 'Three builds failed', progress: 10 }));
        if (args.taskId) live.set('mark', await panda.ui.register({ kind: 'menu', id: 'sample.dynamic-items/mark', location: 'panda.sidebar.task.marks', command: 'sample.dynamic-items/open', presentation: 'badge', badge: '3', tone: 'danger', scope: { taskId: args.taskId } }));
        return { live: [...live.keys()] };
      }
      case 'change':
        await live.get('alert')?.update({ text: '4 builds failed', badge: '4', tone: 'danger', tooltip: 'Four builds failed', progress: 80, enabled: false, visible: true });
        await live.get('mark')?.update({ badge: '4' });
        return { live: [...live.keys()] };
      case 'table':
        await panda.ui.updateView('sample.dynamic-items/board', { controls: [{ kind: 'table', label: 'Tables', columns: ['Name'], rows: [{ cells: ['tracks'], command: 'sample.dynamic-items/open', args: { table: 'tracks' } }] }] });
        return { live: [...live.keys()] };
      case 'untable':
        await panda.ui.updateView('sample.dynamic-items/board', { controls: [{ kind: 'table', label: 'Tables', columns: ['Name'], rows: [] }] });
        return { live: [...live.keys()] };
      case 'remove':
        for (const [key, item] of live) { await item.dispose(); live.delete(key); }
        return { live: [...live.keys()] };
      case 'manifest':
        await panda.ui.update('sample.dynamic-items/status', { tone: 'danger', text: 'failing' });
        return { live: [...live.keys()] };
      case 'burst':
        for (let index = 0; index < Number(args.count ?? 30); index += 1) await live.get('alert')?.update({ badge: String(index) });
        return { live: [...live.keys()] };
      case 'stale': {
        const item = live.get('alert');
        await item?.dispose(); live.delete('alert');
        await item?.update({ text: 'late' }).catch(refuse);
        await item?.dispose().catch(refuse);
        return { refused: state.refused };
      }
      case 'state': return { live: [...live.keys()], opened: state.opened, refused: state.refused };
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.dynamic-items/open', async context => { state.opened.push(context.args ?? null); void report(); return { delivered: state.opened.length }; });
  panda.commands.register('sample.dynamic-items/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });

  const address = process.env.PANDA_FIXTURE_B1 || '';
  let socket = null;
  if (address) {
    const [host, port] = address.split(':');
    socket = net.connect({ host, port: Number(port) });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.on('error', () => {});
    let buffer = '', sequence = 0, chain = Promise.resolve();
    const pending = new Map();
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        // One signal at a time, in the order they arrive.
        if (frame.event === 'signal') { chain = chain.then(() => run(frame.data?.payload ?? {})).catch(refuse).then(report); continue; }
        pending.get(frame.id)?.(); pending.delete(frame.id);
      }
    });
    const request = (op, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket.write(`${JSON.stringify({ id, op, params })}\n`); });
    await request('hello', {});
    await request('subscribe', { topic: 'signals' });
  }
  lifetime.onStop(() => { live.clear(); socket?.end(); });
  await report();
};
