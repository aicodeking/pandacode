import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileIconId, fileIconUrl } from '../src/file-icons.ts';
import { createServer } from 'vite';

test('files and folders get the Material Icon Theme icon VS Code would show', () => {
  for (const [name, isDir, expected] of [
    ['Start-SzG-Collector-v22.exe', false, 'exe'], ['SzDuilibEx.dll', false, 'dll'], ['SzG-Technical-Overview.md', false, 'markdown'],
    ['更新日志.txt', false, 'document'], ['package.json', false, 'nodejs'], ['types.d.ts', false, 'typescript-def'], ['App.TSX', false, 'react_ts'],
    ['no-extension', false, 'file'], ['.gitignore', false, 'git'],
    ['json', true, 'folder-json'], ['lua', true, 'folder-lua'], ['Bin', true, 'folder-dist'], ['SzG-Appendices', true, 'folder'],
  ]) assert.equal(fileIconId(name, isDir), expected, name);
});

test('names matching Object.prototype keys fall back to the defaults instead of throwing', () => {
  for (const name of ['constructor', '__proto__', 'tostring', 'a.constructor', 'hasownproperty']) {
    assert.equal(fileIconId(name, true), 'folder', name);
    assert.equal(fileIconId(name, false), 'file', name);
    assert.ok(fileIconUrl(name, false));
  }
});

test('the light theme uses light variants where they exist and dark icons otherwise', () => {
  assert.equal(fileIconId('page.jinja', false, true), 'jinja_light');
  assert.equal(fileIconId('page.jinja', false, false), 'jinja');
  assert.equal(fileIconId('app.exe', false, true), 'exe');
});

test('every resolved icon points at a shipped SVG', () => {
  for (const [name, isDir] of [['a.exe', false], ['x.unknown', false], ['src', true], ['Login', true]]) {
    assert.ok(existsSync(fileURLToPath(fileIconUrl(name, isDir))), name);
  }
});

test('README files take their extension icon, never the info circle that reads as a warning', () => {
  assert.equal(fileIconId('README.md', false), 'markdown');
  assert.equal(fileIconId('readme.md', false, true), 'markdown');
  assert.equal(fileIconId('README', false), 'file');
});

test('development resolves file icons without eagerly importing the entire asset library', async () => {
  // noDiscovery is not part of Vite's optimizer hash. A partial unit-test graph
  // must never be accepted as the application's complete dependency cache.
  const cacheDir = fileURLToPath(new URL('../node_modules/.cache/pandacode-file-icons-test', import.meta.url)).replaceAll('\\', '/');
  const server = await createServer({ cacheDir, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    assert.equal(server.config.cacheDir, cacheDir, 'the unit server must not overwrite the app dependency optimizer cache');
    assert.ok(server.config.server.watch.ignored.includes('**/.zvec-grep/**'), 'development must not watch the externally locked workspace index');
    for (const directory of ['playwright-report', 'test-results', '_work']) {
      assert.ok(server.config.server.watch.ignored.includes(`**/${directory}/**`), `development must not watch generated ${directory} artifacts`);
    }
    const transformed = await server.transformRequest('/src/file-icons.ts');
    assert.ok(transformed);
    assert.match(transformed.code, /new URL\(\s*\/\* @vite-ignore \*\//);
    assert.equal((transformed.code.match(/icons\/[^"'`\s]+\?import/g) ?? []).length, 0);
    assert.ok(transformed.code.includes('../node_modules/material-icon-theme/icons/${file}'));
  } finally { await server.close(); }
});
