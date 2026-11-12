exports.activate = async (panda, context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(context.testRoot, 'trusted-canary.txt');
  fs.writeFileSync(file, 'ordinary-account-only');
  if (fs.readFileSync(file, 'utf8') !== 'ordinary-account-only') throw new Error('File failed');
  const response = await fetch(context.testEndpoint);
  if (await response.text() !== 'loopback-only') throw new Error('Network failed');
  const helper = execFileSync(process.execPath, ['-e', 'process.stdout.write("owned-helper")'], { encoding: 'utf8', timeout: 1000, windowsHide: true });
  if (helper !== 'owned-helper') throw new Error('Helper failed');
  const database = new DatabaseSync(':memory:');
  if (database.prepare('SELECT 7 AS n').get().n !== 7) throw new Error('Native SQLite failed');
  database.close();
  await panda.ui.showDialog({ title: 'Trusted native access verified', fields: [], successMessage: 'File, loopback, helper and native SQLite succeeded' });
};
