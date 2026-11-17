// R0306: stages the fixture packages for one installed run. The placeholders get this run's values (B1's address,
// test-owned log files and the fake agent's path), JSON-escaped so a Windows path stays valid in JSON and in a
// JavaScript string, and each package becomes a stored ZIP the installed app's `extensions_install` reads.
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

export const ROOT = fileURLToPath(new URL('./', import.meta.url));
/** The packages of the run, in install order, with the grants the user gives them in the scenario. */
export const PACKAGES = Object.freeze([
  { key: 'board', id: 'sample.windows-panels', dir: join(ROOT, 'packages/board'), grants: ['runtime.service', 'ui.richViews', 'tasks.start', 'events.workspace'] },
  { key: 'twin', id: 'sample.windows-panels-twin', dir: join(ROOT, 'packages/twin'), grants: ['ui.richViews'] },
  { key: 'agent', id: 'sample.windows-panels-agent', dir: join(ROOT, 'packages/agent'), grants: [] },
  // R0301's legacy inline fixture, reused unchanged: its title heartbeats are the inline signals qualified here.
  { key: 'inline', id: 'sample.rich-mount', dir: join(ROOT, '../runtime-rich-mount'), grants: ['ui.richViews'], skip: ['declarative'] },
  // R1001's rich band segment, reused unchanged: a native panel inside the composer band.
  { key: 'band', id: 'sample.band-rich', dir: join(ROOT, '../runtime-composer-band/rich'), grants: ['ui.richViews', 'ui.presentation'] },
]);
export const PLACEHOLDERS = Object.freeze({ b1: '__B1_ADDRESS__', serviceLog: '__SERVICE_LOG__', fakeAgent: '__FAKE_AGENT__', agentLog: '__AGENT_LOG__' });
const TEXT = new Set(['.json', '.cjs', '.mjs', '.js', '.html', '.css', '.svg']);

/** Every file of a package folder, `relative path -> bytes`, sorted. */
export function packageFiles(definition) {
  const files = new Map();
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && definition.skip?.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) files.set(`${prefix}${entry.name}`, readFileSync(join(directory, entry.name)));
    }
  };
  walk(definition.dir, '');
  return files;
}

/** Replaces the placeholders in text files. Throws for a value that a JavaScript string or JSON could not carry. */
export function substitute(files, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value || /['"\r\n\0`]/.test(value)) throw new Error(`Unusable staging value for ${name}.`);
  }
  const out = new Map();
  for (const [path, bytes] of files) {
    if (!TEXT.has(extname(path))) { out.set(path, bytes); continue; }
    let text = bytes.toString('utf8');
    for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) if (values[name] !== undefined) text = text.replaceAll(placeholder, JSON.stringify(values[name]).slice(1, -1));
    const left = Object.values(PLACEHOLDERS).find(placeholder => text.includes(placeholder));
    if (left) throw new Error(`${path} still holds ${left}.`);
    out.set(path, Buffer.from(text, 'utf8'));
  }
  return out;
}

/** A stored (uncompressed) ZIP with MS-DOS attributes 0, so the installer's validator sees plain files. */
export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The central directory of a ZIP written by `zip` (names, sizes, CRCs): the offline check of the writer. */
export function readZip(buffer) {
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('No end of central directory.');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad central entry.');
    const size = buffer.readUInt32LE(at + 24), length = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + length);
    const start = local + 30 + buffer.readUInt16LE(local + 26);
    const data = buffer.subarray(start, start + size);
    entries.push({ name, size, crc: buffer.readUInt32LE(at + 16), data, external: buffer.readUInt32LE(at + 38), madeBy: buffer.readUInt16LE(at + 4) });
    at += 46 + length;
  }
  return entries;
}

/** Every package of the run as `{ ...definition, manifest, archive bytes }`. */
export function stagePackages(values) {
  return PACKAGES.map(definition => {
    const files = substitute(packageFiles(definition), values);
    return { ...definition, manifest: JSON.parse(files.get('extension.json').toString('utf8')), bytes: zip(files) };
  });
}
