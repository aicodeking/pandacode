// R0105 fixture: a background service whose code spans declared code folders (`runtime.files`: lib, wasm).
// It loads a CommonJS module, an ES module (which imports another), a worker thread and a WebAssembly module by
// relative path from its code directory, reads its environment, asks for its data directory, and writes what it
// found to `<data directory>/probe.json`, keeping the count of runs across updates, rollbacks and reinstalls.
const { join } = require('node:path');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { Worker } = require('node:worker_threads');

exports.service = async (panda, lifetime) => {
  const helper = require('./lib/helper.cjs');
  const esm = await import('./lib/esm.mjs');
  const worker = await new Promise((resolve, reject) => {
    const thread = new Worker(join(__dirname, 'lib', 'worker.cjs'), { workerData: 20 });
    thread.once('message', resolve); thread.once('error', reject);
  });
  const wasm = await WebAssembly.instantiate(readFileSync(join(__dirname, 'wasm', 'add.wasm')));
  const global = await panda.storage.directory({ scope: 'global' });
  let project;
  try { await panda.storage.directory({ scope: 'project' }); project = 'answered'; } catch (error) { project = error.message; }
  const file = join(global.path, 'probe.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  writeFileSync(file, JSON.stringify({
    generation: helper.generation, cjs: helper.name, esm: esm.name, worker, wasm: wasm.instance.exports.add(19, 23),
    dirname: __dirname, cwd: process.cwd(), reason: lifetime.reason,
    env: { path: Boolean(process.env.PATH), nodeOptions: process.env.NODE_OPTIONS ?? null, credential: process.env.PANDACODE_FIXTURE_CREDENTIAL ?? null, user: process.env.PANDA_FIXTURE_USER ?? null },
    storage: { schemaVersion: global.schemaVersion, path: global.path, project },
    previous: previous && { generation: previous.generation, runs: previous.runs },
    runs: (previous?.runs ?? 0) + 1,
  }));
  await lifetime.setStatus({ text: `probe generation ${helper.generation}` });
};

// A short activation of the same package (its code runs without the code directory).
exports.activate = panda => {
  panda.commands.register('sample.code-folders/probe', () => {});
};
