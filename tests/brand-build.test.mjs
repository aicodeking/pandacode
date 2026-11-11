import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';

// The desktop bundle imports the mobile app's pure brand motion modules. Their nearest tsconfig
// (mobile/tsconfig.json) extends expo/tsconfig.base, which the desktop `npm ci` never installs.
// Build a fixture holding the real modules and the real mobile tsconfig but no Expo, so the
// failure reproduces even when this checkout has mobile/node_modules.
const repo = fileURLToPath(new URL('..', import.meta.url));
const modules = ['src/ui/brand/geometry.ts', 'src/ui/brand/motion-curves.ts', 'src/ui/brand/panda-motion.ts', 'src/ui/splash/timeline.ts'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pandacode-brand-build-'));
  await cp(join(repo, 'tsconfig.json'), join(root, 'tsconfig.json'));
  await cp(join(repo, 'mobile/tsconfig.json'), join(root, 'mobile/tsconfig.json'));
  for (const file of modules) await cp(join(repo, 'mobile', file), join(root, 'mobile', file));
  await writeFile(join(root, 'entry.ts'), [
    ...modules.map((file, i) => `import * as m${i} from './mobile/${file}';`),
    'class Field { value = 1; }',
    `export default [${modules.map((_, i) => `m${i}`).join(', ')}, new Field()];`,
  ].join('\n'));
  return root;
}

const bundle = (root, esbuild) => build({
  root, configFile: false, logLevel: 'silent', esbuild,
  build: { write: false, minify: false, target: 'es2022', lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: 'entry' } },
});

test('desktop build compiles the shared mobile motion modules without Expo installed', async () => {
  const root = await fixture();
  try {
    await assert.rejects(bundle(root, undefined), /expo\/tsconfig\.base/, 'fixture must reproduce the missing Expo base config');
    const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(repo, 'vite.config.ts'));
    const [{ output }] = await bundle(root, config.esbuild);
    const code = output.find(chunk => chunk.type === 'chunk').code;
    assert.match(code, /const PANDA_SIZE/);
    // ES2022 class-field semantics from the desktop tsconfig are kept (no constructor assignment).
    assert.match(code, /class Field \{\s*value = 1;/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
