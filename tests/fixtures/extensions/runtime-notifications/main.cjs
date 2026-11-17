// R0207 fixture: a background service that raises, replaces and withdraws notices when it is told to, either by the
// command `sample.runtime-notifications/control` (the browser spec) or by a signal of the canonical B1 fake daemon (the
// native test hands B1's address in PANDA_FIXTURE_B1; a signal payload is `{op, ...}`). `op` is one of:
//   alert    -> notify key `build` ("3 builds failed", danger)
//   replace  -> notify key `build` again ("4 builds failed"): one notice, replaced
//   withdraw -> withdraw key `build`
//   burst    -> notify `count` distinct keys in a row (6 per minute are shown, the rest merge)
//   stale    -> withdraw a key that is already gone and report the refusal
//   state    -> what the service holds and the last answers
// Every answer is kept in the status line so the native test can read what the host replied.
const net = require('node:net');

exports.service = async (panda, lifetime) => {
  const state = { answers: [], refused: [] };
  const refuse = error => { state.refused.push(String(error?.message ?? error)); return null; };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ answers: state.answers, refused: state.refused }) });
  const run = async args => {
    switch (args.op) {
      case 'alert':
        state.answers.push(await panda.ui.notify({ key: 'build', title: 'Builds', text: '3 builds failed', tone: 'danger' }));
        return state.answers.at(-1);
      case 'replace':
        state.answers.push(await panda.ui.notify({ key: 'build', title: 'Builds', text: '4 builds failed', tone: 'danger' }));
        return state.answers.at(-1);
      case 'withdraw':
        await panda.ui.withdraw('build');
        return { withdrawn: true };
      case 'burst': {
        const merged = [];
        for (let index = 0; index < Number(args.count ?? 9); index += 1) merged.push((await panda.ui.notify({ key: `alert-${index}`, text: `alert ${index}` })).merged);
        state.answers.push({ merged });
        return { merged };
      }
      case 'stale':
        await panda.ui.withdraw('build').catch(refuse);
        return { refused: state.refused };
      case 'state': return { answers: state.answers, refused: state.refused };
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.runtime-notifications/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });

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
  lifetime.onStop(() => { socket?.end(); });
  await report();
};
