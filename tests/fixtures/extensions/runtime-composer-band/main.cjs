// R1001 fixture: a background service that puts a live, task-scoped segment in the composer band
// (`panda.composer.band`, `ui.presentation`) and changes it when it is told to, either by the command
// `sample.band-usage/control` (the browser spec) or by a signal of the canonical B1 fake daemon (the native test hands
// B1's address in PANDA_FIXTURE_B1; a signal payload is `{op, ...}`). `op` is one of:
//   task      -> register a segment scoped to `taskId` (shown only while that task is in view)
//   progress  -> update the manifest segment and the scoped one: text, tone and the bar (`value`, 0 to 100)
//   remove    -> dispose the scoped segment
//   state     -> what the service holds, the clicks it received and the last refusals
// A click on the segment or on one of its buttons reaches its command; the service counts each delivery so "exactly once"
// is observable (also in the status line: {clicks, live}).
const net = require('node:net');

exports.service = async (panda, lifetime) => {
  const live = new Map();
  const state = { clicks: [], refused: [] };
  const refuse = error => { state.refused.push(String(error?.message ?? error)); return null; };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ clicks: state.clicks, live: [...live.keys()], refused: state.refused }) });
  const run = async args => {
    switch (args.op) {
      case 'task':
        live.set('scoped', await panda.ui.register({ kind: 'menu', id: 'sample.band-usage/task-band', location: 'panda.composer.band', command: 'sample.band-usage/open', presentation: 'status', text: 'This task: 0%', tone: 'info', progress: 0, scope: { taskId: args.taskId } }));
        return { live: [...live.keys()] };
      case 'progress': {
        const value = Math.max(0, Math.min(100, Number(args.value ?? 0)));
        const tone = value >= 90 ? 'danger' : value >= 70 ? 'warning' : 'info';
        await panda.ui.update('sample.band-usage/band', { text: `Usage ${value}%`, tone, progress: value });
        await live.get('scoped')?.update({ text: `This task: ${value}%`, tone, progress: value });
        return { live: [...live.keys()], value };
      }
      case 'remove':
        for (const [key, item] of live) { await item.dispose(); live.delete(key); }
        return { live: [...live.keys()] };
      case 'state': return { live: [...live.keys()], clicks: state.clicks, refused: state.refused };
      default: throw new Error('InvalidShape');
    }
  };
  for (const name of ['open', 'pause', 'resume', 'reset']) panda.commands.register(`sample.band-usage/${name}`, async () => { state.clicks.push(name); void report(); return { delivered: state.clicks.length }; });
  panda.commands.register('sample.band-usage/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });

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
