// Command guard (sample.guard): the installed service. The guard's logic is lib/guard.mjs (with lib/analyzer.mjs); this file
// is only what touches the machine: the package's data directory, the policy and audit files, the home and temp folders.
// PANDA_GUARD_TEST=1 turns on the `guard-test sleep|throw` commands the fake-agent tests use.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const io = panda => ({
  home: os.homedir(),
  temp: [...new Set([os.tmpdir(), '/tmp', '/var/tmp'])],
  now: () => new Date(),
  testCommands: process.env.PANDA_GUARD_TEST === '1',
  async dataDir() {
    const answer = await panda.storage.directory({ scope: 'global' });
    fs.mkdirSync(answer.path, { recursive: true });
    return answer.path;
  },
  async readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  },
  async appendLine(file, line) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  },
});

exports.service = async (panda, lifetime) => {
  const { run } = await import('./lib/guard.mjs');
  await run(panda, lifetime, io(panda));
};
