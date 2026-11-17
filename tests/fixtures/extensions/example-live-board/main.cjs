// R1201 fixture: wraps the SHIPPED Work board (examples/extensions/live-board/package) for the native crash test. The native
// test archives this file as main.cjs, the shipped main.cjs and lib/board.mjs under `real/`, and adds one declared command,
// `sample.live-board/crash`, which makes the process exit with code 3 (a crash the host restarts with backoff and parks
// after five in ten minutes). Everything else is the shipped package, untouched.
exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.live-board/crash', () => { setImmediate(() => process.exit(3)); return null; });
  await require('./real/main.cjs').service(panda, lifetime);
};
