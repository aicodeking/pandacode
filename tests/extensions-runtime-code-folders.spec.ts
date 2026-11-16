import { test, expect, type Page } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Preview column of R0105 (code folders, the service environment and the data directory). The browser preview runs no
// package code: these check the webview mirror (src/extensions/runtime-code-folders.ts) of the native rules against the
// fixture. The real installed service (relative CJS/ESM/worker/Wasm imports, environment, data across update, rollback
// and uninstall) is the native test `runtime_code_folders::tests::installed` (feature extension-runtime-native-tests).
const root = new URL('./fixtures/extensions/runtime-code-folders/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension.json', root), 'utf8'));
const ID = 'sample.code-folders';
function files(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix)).flatMap(name => { const path = prefix ? `${prefix}/${name}` : name; return statSync(join(dir, path)).isDirectory() ? files(dir, path) : [path]; }).sort();
}
const fixtureFiles = files(fileURLToPath(root));

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionCodeFolders && (window as any).__extensionRuntimeGrants);
}

test('extensions code folders: the manifest declares up to eight folders and every fixture file is declared by them', async ({ page }) => {
  await boot(page);
  const checked = await page.evaluate(([manifest, fixtureFiles]) => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    const folders = (window as any).__extensionCodeFolders;
    const withFiles = (files: unknown) => validateContract('packages', [{ ...manifest, runtime: { ...manifest.runtime, files } }]);
    const bare = { ...manifest, runtime: { ...manifest.runtime } }; delete bare.runtime.files;
    return {
      ok: validateContract('packages', [manifest]).ok,
      upperCase: withFiles(['Lib']).ok, nested: withFiles(['lib/x']).ok, dotted: withFiles(['..']).ok, nine: withFiles(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).ok, eight: withFiles(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).ok,
      folders: folders.codeFolders(manifest),
      declared: fixtureFiles.filter((file: string) => !folders.declaredPackageFile(manifest, file)),
      undeclared: ['other/x.cjs', 'lib', 'LIB/helper.cjs', 'library/x.cjs', 'package.json'].filter((file: string) => folders.declaredPackageFile(manifest, file)),
      withoutFolders: fixtureFiles.filter((file: string) => !folders.declaredPackageFile(bare, file)),
      limits: folders.PACKAGE_LIMITS,
    };
  }, [manifest, fixtureFiles] as const);
  expect(checked).toMatchObject({ ok: true, upperCase: false, nested: false, dotted: false, nine: false, eight: true, folders: ['lib', 'wasm'], declared: [], undeclared: [] });
  expect(checked.withoutFolders, 'without runtime.files the code files are undeclared (retained refusal)').toEqual(['lib/esm.mjs', 'lib/helper.cjs', 'lib/shared.mjs', 'lib/worker.cjs', 'wasm/add.wasm']);
  expect(checked.limits).toEqual({ archive: 16 << 20, file: 8 << 20, expanded: 64 << 20, files: 1024, record: 2 * Math.ceil((16 << 20) / 3) * 4 + (1 << 20) });
});

test('extensions code folders: the service gets the user environment and a service-only data directory', async ({ page }) => {
  await boot(page);
  const answers = await page.evaluate(async id => {
    const folders = (window as any).__extensionCodeFolders;
    const ask = (caller: string, options: unknown, extra: Record<string, unknown> = {}) => folders.storageDirectory({ caller, id, granted: true, options, ...extra });
    return {
      environment: folders.serviceEnvironment({ Path: 'C:\\tools', HOME: '/home/me', NODE_OPTIONS: '--require=x', node_options: '--title=x', PANDACODE_SECRETS_FILE: '1', PandaCode_Token: 'canary' }),
      code: folders.codeDirectory('<app data>', id, 'a'.repeat(64)),
      global: await ask('service', { scope: 'global' }),
      project: await ask('service', { scope: 'project' }, { projectId: 'project-1' }),
      stale: await ask('service', { scope: 'project' }),
      activation: await ask('activation', { scope: 'global' }),
      panel: await ask('panel', { scope: 'global' }),
      revoked: await ask('service', { scope: 'global' }, { granted: false }),
      shapes: await Promise.all([{ scope: 'other' }, {}, null, { scope: 'global', path: '/etc' }].map(options => ask('service', options))),
    };
  }, ID);
  expect(answers.environment).toEqual({ Path: 'C:\\tools', HOME: '/home/me' });
  expect(answers.code).toBe(`<app data>/extension-code-v1/${ID}/${'a'.repeat(64)}`);
  expect(answers.global).toEqual({ ok: true, value: { schemaVersion: 1, path: `<app data>/extension-data-v1/${ID}/global` } });
  expect(answers.project).toEqual({ ok: true, value: { schemaVersion: 1, path: `<app data>/extension-data-v1/${ID}/project-${createHash('sha256').update('project-1').digest('hex')}` } });
  expect(answers.stale).toEqual({ ok: false, error: { code: 'StaleContext' } });
  expect(answers.activation).toEqual({ ok: false, error: { code: 'UnsupportedCapability' } });
  expect(answers.panel).toEqual({ ok: false, error: { code: 'UnsupportedCapability' } });
  expect(answers.revoked).toEqual({ ok: false, error: { code: 'PermissionDenied' } });
  expect(answers.shapes.map((answer: { error?: { code: string } }) => answer.error?.code)).toEqual(['InvalidShape', 'InvalidShape', 'InvalidShape', 'InvalidShape']);
});
