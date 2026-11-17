// Project memory (sample.memory): the installed service. The logic is lib/memory.mjs; this file only gives it a store.
// The store is one JSON file in the package's data directory (`panda.storage.directory`, permission `storage.private`),
// rewritten atomically, so the memories survive a restart and an update of the service (the host keeps the directory
// across disable, update and rollback, and removes it with "remove own data"). A real package could hold a SQLite file
// there instead; the scorer would then be an embedding model.
const fs = require('node:fs');
const path = require('node:path');

function fileStore(directory) {
  const file = path.join(directory, 'memories.json');
  return {
    file,
    async load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
      } catch { return { nextId: 1, items: [] }; }
    },
    async save(data) {
      fs.mkdirSync(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, nextId: data.nextId, items: data.items }));
      fs.renameSync(temporary, file);
    },
  };
}

exports.fileStore = fileStore;
exports.service = async (panda, lifetime) => {
  const { path: directory } = await panda.storage.directory({ scope: 'global' });
  const { run } = await import('./lib/memory.mjs');
  await run(panda, lifetime, fileStore(directory));
};
