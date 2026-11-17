'use strict';
// Test-only materializer. It can write solely in one newly created directory under the test-owned root.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function prepare(root, manifest, source) {
  if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new Error('Expected a test-owned absolute root.');
  const directory = fs.mkdtempSync(path.join(root, 'companion-'));
  const descriptor = path.join(directory, 'run.json');
  const artifact = path.join(directory, 'companion.cjs');
  let handler = null;
  let failures = 0;
  let closes = 0;
  let closed = false;
  const remove = file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const resource = {
    directory, descriptor, env: { PANDACODE_COMPANION_MANIFEST: descriptor },
    attach(child) {
      let exited = child.exitCode !== null || child.signalCode !== null;
      child.once('exit', () => { exited = true; });
      handler = () => { if (!child.stdin.destroyed) child.stdin.end(); if (!exited) throw new Error('Await child exit before retrying teardown.'); };
    },
    failNextClose() { failures++; },
    get closes() { return closes; },
    close() {
      if (closed) return;
      // Withdraw first. An already loaded companion cannot authorize more fixture calls.
      let pending = false;
      try { remove(descriptor); } catch { pending = true; }
      // Always attempt cancellation, including when descriptor deletion encounters an I/O failure.
      try { if (handler) handler(); } catch { pending = true; }
      if (failures) { failures--; pending = true; }
      if (pending) throw new Error('Companion cleanup pending.');
      remove(artifact);
      try { fs.rmdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      closed = true;
      closes++;
    },
  };
  try {
    fs.writeFileSync(artifact, source, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(descriptor, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  } catch (error) { resource.close(); throw error; }
  return resource;
};
