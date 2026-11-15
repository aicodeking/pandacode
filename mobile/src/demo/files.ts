// Demo answers for the `files` feature group (src/connect/api/files.ts): a small, made-up checkout
// that every demo project shares, so the browser, viewer and search have something to show, and
// edits saved from the phone (files.write) for the rest of the session. See ./index.ts.
import { EDIT_LIMIT, fileName, isImagePath, utf8Length } from '../store/files.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f4efe6"/><circle cx="18" cy="16" r="9" fill="#222"/><circle cx="46" cy="16" r="9" fill="#222"/><ellipse cx="22" cy="32" rx="7" ry="9" fill="#222"/><ellipse cx="42" cy="32" rx="7" ry="9" fill="#222"/><circle cx="22" cy="31" r="2.5" fill="#fff"/><circle cx="42" cy="31" r="2.5" fill="#fff"/><ellipse cx="32" cy="44" rx="4" ry="3" fill="#222"/></svg>';

/** Path → contents; folders are implied by the paths. */
export const DEMO_FILES: Readonly<Record<string, string>> = {
  'README.md': '# {project}\n\nThe demo checkout PandaCode shows on the phone.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n\nTests run with `npm test`.\n',
  'package.json': '{\n  "name": "{project}",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "node --test"\n  }\n}\n',
  'src/index.ts': "// Entry point: starts the upload queue and the HTTP server.\nimport { startQueue } from './upload.ts';\nimport { serve } from './server.ts';\n\nconst PORT = 5173;\n\nexport async function main() {\n  const queue = await startQueue({ retries: 3 });\n  serve({ port: PORT, queue });\n}\n\nvoid main();\n",
  'src/upload.ts': "// Uploads with retry. The retry timer used real time, which made the test flaky.\nexport interface QueueOptions { retries: number }\n\nexport async function startQueue(options: QueueOptions) {\n  let attempts = 0;\n  return {\n    async upload(file: string) {\n      while (attempts < options.retries) {\n        attempts += 1;\n        // TODO: back off between attempts\n        if (await send(file)) return true;\n      }\n      return false;\n    },\n  };\n}\n\nasync function send(file: string): Promise<boolean> {\n  return file.length > 0;\n}\n",
  'src/server.ts': "import { createServer } from 'node:http';\n\nexport function serve({ port }: { port: number; queue: unknown }) {\n  createServer((_req, res) => res.end('ok')).listen(port);\n}\n",
  'tests/upload.test.ts': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { startQueue } from '../src/upload.ts';\n\ntest('uploads a file', async () => {\n  const queue = await startQueue({ retries: 3 });\n  assert.equal(await queue.upload('a.png'), true);\n});\n",
  'docs/relay-protocol.md': '# Relay protocol\n\nFrames are JSON, sealed with XChaCha20-Poly1305.\n\n- Each request carries `ts` and a fresh `nonce`.\n- The relay forwards ciphertext only.\n',
  'assets/logo.svg': LOGO,
  '.pandacode/recipes/ship-it.json': '{\n  "name": "ship-it",\n  "description": "Test, review and commit",\n  "steps": []\n}\n',
};

const projectName = (ctx: DemoContext, params: { projectId?: string; sessionId?: string }) => {
  const list = ctx.state.tasks[ctx.deviceId];
  const id = params.sessionId ? list?.tasks.find(t => t.sessionId === params.sessionId)?.projectId : params.projectId;
  if (!id) throw new Error('Choose a project or a task.');
  return list?.projects.find(p => p.id === id)?.name ?? id;
};

/** Files saved in the demo this session, by `device/project/path`; replaced, never mutated in place. */
let saved: ReadonlyMap<string, string> = new Map();
const savedKey = (ctx: DemoContext, project: string, path: string) => `${ctx.deviceId}/${project}/${path}`;

/** Clears demo edits (tests). */
export function resetDemoEdits(): void { saved = new Map(); }

const contents = (path: string, project: string, ctx?: DemoContext) => {
  const edited = ctx ? saved.get(savedKey(ctx, project, path)) : undefined;
  if (edited !== undefined) return edited;
  const text = DEMO_FILES[path];
  if (text === undefined) throw new Error('No such file or directory (os error 2)');
  return text.replaceAll('{project}', project);
};

/** A stand-in for the host's SHA-256 version: 64 hex characters from two FNV-1a passes. */
export function demoHash(text: string): string {
  const pass = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  return [0x811c9dc5, 0x01000193, 0x2545f491, 0x9e3779b9, 0x7f4a7c15, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f].map(pass).join('');
}

/** The demo checkout's entries directly in `folder`: folders first, then by name. */
export function demoListing(folder: string): { name: string; path: string; dir: boolean }[] {
  const prefix = folder ? `${folder}/` : '';
  const seen = new Map<string, boolean>();
  for (const path of Object.keys(DEMO_FILES)) {
    if (!path.startsWith(prefix)) continue;
    const [first, ...rest] = path.slice(prefix.length).split('/');
    seen.set(first, (seen.get(first) ?? false) || rest.length > 0);
  }
  return [...seen].map(([name, dir]) => ({ name, path: prefix + name, dir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export const handlers: DemoHandlers = {
  'projects.list': ctx => ({
    projects: (ctx.state.tasks[ctx.deviceId]?.projects ?? []).map((p, i) => ({ id: p.id, name: p.name, path: `~/code/${p.name}`, repo: p.repo, chat: false, addedOrder: i })),
  }),
  'files.list': (ctx, p) => {
    projectName(ctx, p);
    const path = typeof p.path === 'string' ? p.path : '';
    const entries = demoListing(path);
    if (path && !entries.length) throw new Error('No such file or directory (os error 2)');
    return { path, entries, truncated: false };
  },
  'files.read': (ctx, p) => {
    const path = String(p.path ?? '');
    if (isImagePath(path)) return { kind: 'image', path };
    const text = contents(path, projectName(ctx, p), ctx);
    return { kind: 'text', path, text, offset: 0, total: utf8Length(text), done: true, hash: demoHash(text) };
  },
  'files.write': (ctx, p) => {
    const project = projectName(ctx, p);
    const path = String(p.path ?? '');
    if (isImagePath(path)) throw new Error('Only text files can be edited on the phone.');
    const current = contents(path, project, ctx);
    if (p.baseHash !== demoHash(current)) throw new Error('Changed on the computer since you opened it.');
    const text = typeof p.text === 'string' ? p.text : '';
    if (utf8Length(text) > EDIT_LIMIT || text.includes('\0')) throw new Error('Only text up to 64 KB can be saved.');
    saved = new Map([...saved, [savedKey(ctx, project, path), text]]);
    return { path, hash: demoHash(text), total: utf8Length(text) };
  },
  'files.image': (ctx, p) => {
    const path = String(p.path ?? '');
    const data = btoa(contents(path, projectName(ctx, p)));
    return { mime: 'image/svg+xml', total: data.length, offset: 0, data, done: true };
  },
  'files.search': (ctx, p) => {
    projectName(ctx, p);
    const query = String(p.query ?? '').toLowerCase();
    const entries = Object.keys(DEMO_FILES).filter(path => path.toLowerCase().includes(query)).map(path => ({ name: fileName(path), path, dir: false }));
    return { entries };
  },
  'files.grep': (ctx, p) => {
    const project = projectName(ctx, p);
    const query = String(p.query ?? '');
    const needle = p.matchCase ? query : query.toLowerCase();
    const files = Object.keys(DEMO_FILES).filter(path => !isImagePath(path)).flatMap(path => {
      const matches = contents(path, project, ctx).split('\n').flatMap((text, i) => {
        const at = (p.matchCase ? text : text.toLowerCase()).indexOf(needle);
        return at < 0 ? [] : [{ line: i + 1, text, ranges: [[at, at + query.length]] }];
      });
      return matches.length ? [{ path, matches }] : [];
    });
    return { files, truncated: false };
  },
};
