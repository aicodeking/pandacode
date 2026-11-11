import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
// Compile every module, including the shared pure modules under mobile/, with the desktop tsconfig's target (the only field Vite would read from it): Vite only skips the nearest tsconfig (mobile's extends Expo, absent from desktop installs) when tsconfigRaw is a string.
const { target } = JSON.parse(readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8')).compilerOptions;
const tsconfigRaw = JSON.stringify({ compilerOptions: { target } });
// Vite expands this dynamic asset URL to eager imports of every icon in development, too.
// Keep native browser URL resolution in dev (the package files are already served there);
// production still uses Vite's unchanged hashed-asset emission and URL rewriting.
const fileIconsPath = fileURLToPath(new URL('./src/file-icons.ts', import.meta.url)).replaceAll('\\', '/');
const devFileIcons = {
  name: 'dev-file-icon-urls',
  apply: 'serve' as const,
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.replaceAll('\\', '/') !== fileIconsPath) return;
    return source.replace('new URL(`../node_modules/material-icon-theme/icons/${file}`, import.meta.url)',
      'new URL(/* @vite-ignore */ `../node_modules/material-icon-theme/icons/${file}`, import.meta.url)');
  },
};
// ES-module workers: the diff highlighter worker (@pierre/diffs) imports Shiki chunks.
export default defineConfig({ clearScreen: false, plugins: [devFileIcons], esbuild: { tsconfigRaw }, server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } }, build: { target: 'es2022', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', 'agents-dock': 'agents-dock.html' } } }, worker: { format: 'es' } });
