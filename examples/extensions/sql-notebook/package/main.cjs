// SQL notebook (sample.sql-notebook): the installed service.
//
// The notebook's own logic is lib/notebook.mjs, one browser-safe module that tests run as well. This file is only the
// transport to the disk: it resolves a project-relative database path under the project folder, lists the .db, .sqlite
// and .sqlite3 files of that folder (two levels deep), and hands the driver of lib/driver.cjs (one short-lived Node
// process per query, so a statement can always be stopped) to the logic. PANDA_FIXTURE_B6 names the test-owned project folder a test hands in; without it the service
// uses its working folder, which the host sets to the project folder.
const fs = require('node:fs');
const path = require('node:path');
const { createDriver } = require('./lib/driver.cjs');

const EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
const fail = (code, message) => Object.assign(new Error(message ?? code), { code });
const root = () => path.resolve(process.env.PANDA_FIXTURE_B6 || process.cwd());

/** A project-relative path below the project folder; anything that leaves it, or is not a regular file, is refused. */
function resolve(_projectId, relative) {
  if (typeof relative !== 'string' || !relative || /^[\\/]|^[a-zA-Z]:|\\/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('InvalidShape', 'That is not a path inside the project.');
  const base = root();
  const file = path.resolve(base, ...relative.split('/'));
  if (path.relative(base, file).startsWith('..')) throw fail('InvalidShape', 'That is not a path inside the project.');
  let stat;
  try { stat = fs.statSync(file); } catch { throw fail('NotFound', 'The database file is not in the project.'); }
  if (!stat.isFile()) throw fail('NotFound', 'The database file is not in the project.');
  return file;
}

function listDatabases() {
  const base = root();
  const found = [];
  const walk = (folder, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (entry.isFile() && EXTENSIONS.some(extension => entry.name.toLowerCase().endsWith(extension))) found.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  walk(base, 0);
  return found.sort().slice(0, 200);
}

exports.service = async (panda, lifetime) => {
  const driver = createDriver();
  lifetime.onStop(() => driver.stopAll());
  const { run } = await import('./lib/notebook.mjs');
  await run(panda, lifetime, { driver, resolve, listDatabases });
};
