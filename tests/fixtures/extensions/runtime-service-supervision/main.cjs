// R0106 fixture: a background service whose crashes are scripted by the test.
//   command sample.service-supervision/crash -> the process exits with code 3 (a crash: the host restarts it with
//                                               backoff and parks it after five crashes in ten minutes)
//   command sample.service-supervision/state -> { reason, restarts, pid }
//   PANDA_FIXTURE_MODE=hang                  -> the service function never settles (a slow start)
//   PANDA_FIXTURE_HELPER=1                   -> owns a helper process, to prove that no process survives a crash
// Its status line carries the start reason, `lifetime.restarts` and the host and helper process ids.
exports.service = async (panda, lifetime) => {
  const helper = process.env.PANDA_FIXTURE_HELPER === '1'
    ? require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    : null;
  panda.commands.register('sample.service-supervision/crash', () => { setImmediate(() => process.exit(3)); return null; });
  panda.commands.register('sample.service-supervision/state', () => ({ reason: lifetime.reason, restarts: lifetime.restarts, pid: process.pid }));
  await lifetime.setStatus({ text: JSON.stringify({ reason: lifetime.reason, restarts: lifetime.restarts, host: process.pid, helper: helper ? helper.pid : null }) });
  if (process.env.PANDA_FIXTURE_MODE === 'hang') return new Promise(() => {});
};
