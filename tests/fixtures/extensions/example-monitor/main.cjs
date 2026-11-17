// R1206 fixture: wraps the SHIPPED Machine monitor (examples/extensions/monitor/package) for a native crash test. The native test
// archives this file as main.cjs, the shipped main.cjs and lib/monitor.mjs under `real/`, and adds one declared command,
// `sample.monitor/crash`, which makes the process exit with code 3 (a crash the host restarts with backoff). Everything else is
// the shipped package, untouched.
exports.service = async (panda, lifetime) => {
  panda.commands.register('sample.monitor/crash', () => { setImmediate(() => process.exit(3)); return null; });
  await require('./real/main.cjs').service(panda, lifetime);
};
