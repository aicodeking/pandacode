// R0410 fixture: a background service that enumerates the guests (virtual machines, simulators, the browser guest), sends
// scripted input and control and takes captures, driven by the command `sample.runtime-guests/control` (the panel button of
// the acceptance, the browser spec and the native test). `args.op` is one of:
//   list      -> panda.guests.list()                              answers { kinds: [{ kind, supported, reason? }], guests: [{ id, kind, name, state, interactive }] }
//   capture   -> panda.guests.capture(id)                         answers { path, mime, bytes, width?, height? }: the image is a file in this package's data directory
//   input     -> panda.guests.input(id, input)                    the input the built-in panel takes for the kind
//   control   -> panda.guests.control(id, action)                 vm: start | stop | suspend; simulator: boot | shutdown | light | dark; browser: back | forward | reload | stop
//   script    -> list, then for every interactive guest: capture, one scripted input and a read of the capture's size; answers { kinds, captures }
//   refuse    -> any of the above as `args.call` with `args.options`, answering { refused: <code>, path, ids } instead of throwing
//   state     -> what the service holds: every refusal so far
// The package never deletes a guest (there is no such call) and never names a credential.
const fs = require('node:fs');
const SCRIPT_INPUT = {
  vm: { action: 'click', x: 10, y: 10 },
  simulator: { kind: 'tap', x: 20, y: 20 },
  browser: { action: 'read' },
};
exports.service = async (panda, lifetime) => {
  const state = { refused: [] };
  const report = () => lifetime.setStatus({ text: JSON.stringify({ refused: state.refused }) });
  const calls = {
    list: () => panda.guests.list(),
    capture: options => panda.guests.capture(options.id),
    input: options => panda.guests.input(options.id, options.input),
    control: options => panda.guests.control(options.id, options.action),
  };
  const script = async () => {
    const found = await panda.guests.list();
    const captures = [];
    for (const guest of found.guests) {
      if (!guest.interactive) continue;
      const shot = await panda.guests.capture(guest.id);
      // The answer is a path in this package's own data directory: the bytes are read from the file, never from the channel.
      captures.push({ id: guest.id, path: shot.path, mime: shot.mime, bytes: shot.bytes, onDisk: fs.existsSync(shot.path) ? fs.statSync(shot.path).size : -1 });
      await panda.guests.input(guest.id, SCRIPT_INPUT[guest.kind]);
    }
    return { kinds: found.kinds, captures };
  };
  const run = async args => {
    if (args.op === 'state') return state;
    if (args.op === 'script') return script();
    if (args.op === 'refuse') {
      try { return await calls[args.call](args.options ?? {}); } catch (error) {
        const code = String(error?.code ?? error?.message ?? error);
        state.refused.push(code);
        return { refused: code, path: error?.path ?? '$', ids: Array.isArray(error?.ids) ? error.ids : [] };
      }
    }
    if (!calls[args.op]) throw new Error('InvalidShape');
    return calls[args.op](args.options ?? {});
  };
  panda.commands.register('sample.runtime-guests/control', async context => { const answer = await run(context.args ?? {}); void report(); return answer ?? null; });
};
