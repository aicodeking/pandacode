// R0108 fixture: a background service that runs beside the computer executing tasks. The workspace-kind package
// (extension.json) runs on a desktop and on a headless host; the ui-kind copy (ui-extension.json, same code) runs on a
// desktop only. Its status line names where it runs so the host projection can show it; `where` answers the same.
const os = require('node:os');

exports.service = async (panda, lifetime) => {
  const here = { platform: process.platform, host: os.hostname(), reason: lifetime.reason };
  for (const id of ['sample.executor-placement/where', 'sample.executor-placement-ui/where']) {
    try { Promise.resolve(panda.commands.register(id, async () => here)).catch(() => {}); } catch { /* the other package's command */ }
  }
  lifetime.onStop(async () => { await Promise.resolve(lifetime.setStatus({ text: 'Stopping', working: false })).catch(() => {}); });
  await lifetime.setStatus({ text: 'Beside the executor', working: false });
};
