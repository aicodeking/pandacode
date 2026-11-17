'use strict';
// One synthetic process/run; stdout is JSONL only. EOF closes its handlers and exits naturally.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const [taskId, runId] = process.argv.slice(2);
const manifestPath = process.env.PANDACODE_COMPANION_MANIFEST;
let companion = null;
let loaded = 0;
if (manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.taskId === taskId && manifest.runId === runId && manifest.protocol === 1 && manifest.schemaVersion === 1) {
      companion = require(path.join(path.dirname(manifestPath), 'companion.cjs'))(manifestPath, manifest);
      loaded++;
    }
  } catch { /* A withdrawn descriptor leaves the fixture's normal approval path available. */ }
}
function frame(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
frame({ type: 'ready', loaded, ordinaryApprovals: true });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  if (line === 'probe') frame({ type: 'probe', loaded, current: companion?.current() ?? false, ordinaryApprovals: true });
});
lines.on('close', () => { companion = null; frame({ type: 'closed', handlers: 0 }); });
