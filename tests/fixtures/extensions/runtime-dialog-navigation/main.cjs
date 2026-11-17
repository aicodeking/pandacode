// R0206 fixture: a background service that asks the user a question and reveals host locations when it is told to,
// either by the command `sample.dialog-navigation/control` (the browser spec) or by a signal of the canonical B1 fake
// daemon (the native test hands B1's address in PANDA_FIXTURE_B1; a signal payload is `{op, ...}`). `op` is one of:
//   ask      -> panda.ui.showDialog(dialog) and keep the answer
//   twice    -> two dialogs at once: the first waits, the second must answer Conflict
//   reveal   -> panda.ui.reveal(target); a refusal is recorded, never thrown
//   state    -> what the service holds: answers and refusals
const net = require('node:net');

const DIALOG = { title: 'Pick a name', fields: [{ id: 'name', label: 'Name', kind: 'text', required: true }, { id: 'sure', label: 'Sure', kind: 'switch' }], successMessage: 'Answered' };

exports.service = async (panda, lifetime) => {
  const state = { answers: [], refused: [], waiting: 0 };
  const refuse = error => { state.refused.push(String(error?.code ?? error?.message ?? error)); return null; };
  const report = () => lifetime.setStatus({ text: JSON.stringify(state) });
  const run = async args => {
    switch (args.op) {
      case 'ask': {
        state.waiting += 1; void report();
        const answer = await panda.ui.showDialog(args.dialog ?? DIALOG).catch(refuse);
        state.waiting -= 1;
        if (answer) state.answers.push(answer);
        return { answer };
      }
      case 'twice': {
        state.waiting += 1; void report();
        const first = panda.ui.showDialog(DIALOG).catch(refuse);
        const second = await panda.ui.showDialog(DIALOG).catch(refuse);
        const answer = await first;
        state.waiting -= 1;
        if (answer) state.answers.push(answer);
        return { second, answer };
      }
      case 'reveal': return { revealed: await panda.ui.reveal(args.target).catch(refuse) };
      case 'state': return state;
      default: throw new Error('InvalidShape');
    }
  };
  panda.commands.register('sample.dialog-navigation/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer; });

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
        // A dialog waits for the user: signals do not queue behind it.
        if (frame.event === 'signal') { void run(frame.data?.payload ?? {}).catch(refuse).then(report); continue; }
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
