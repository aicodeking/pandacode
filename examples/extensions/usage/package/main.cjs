// Usage band (sample.usage): the installed service. The logic is lib/usage.mjs, one browser-safe module that the browser
// preview runs as well; this file only supplies what a browser cannot: the daily ledger on disk, in the package's own data
// directory (`storage.private`). Nothing here reads a credential: the usage API is a declared connection the host runs.
const fs = require('node:fs/promises');
const path = require('node:path');

function fileLedger(panda) {
  let file = null;
  const locate = async () => {
    if (file) return file;
    const { path: directory } = await panda.storage.directory({ scope: 'global' });
    await fs.mkdir(directory, { recursive: true });
    file = path.join(directory, 'ledger.json');
    return file;
  };
  return {
    async read() {
      try { const rows = JSON.parse(await fs.readFile(await locate(), 'utf8')); return Array.isArray(rows) ? rows : []; } catch { return []; }
    },
    async write(rows) {
      const target = await locate();
      const temporary = `${target}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(rows), 'utf8');
      await fs.rename(temporary, target);
    },
  };
}

exports.service = async (panda, lifetime) => {
  const { run } = await import('./lib/usage.mjs');
  await run(panda, lifetime, { ledger: fileLedger(panda) });
};
