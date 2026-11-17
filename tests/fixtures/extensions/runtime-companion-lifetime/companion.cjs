'use strict';
// Synthetic fixture API, not a Codex/OpenCode/Kilo companion and not an authentication protocol.
const fs = require('node:fs');
module.exports = function companion(manifestPath, expected) {
  function current() {
    try {
      const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return value.schemaVersion === 1 && value.protocol === 1 && value.taskId === expected.taskId
        && value.runId === expected.runId && value.leaseId === expected.leaseId;
    } catch { return false; }
  }
  return { current };
};
