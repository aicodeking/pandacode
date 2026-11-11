import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
// Compile every module, including the shared pure modules under mobile/, with the desktop tsconfig's target (the only field Vite would read from it): Vite only skips the nearest tsconfig (mobile's extends Expo, absent from desktop installs) when tsconfigRaw is a string.
const { target } = JSON.parse(readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8')).compilerOptions;
const tsconfigRaw = JSON.stringify({ compilerOptions: { target } });
// ES-module workers: the diff highlighter worker (@pierre/diffs) imports Shiki chunks.
export default defineConfig({ clearScreen: false, esbuild: { tsconfigRaw }, server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } }, build: { target: 'es2022', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', 'agents-dock': 'agents-dock.html' } } }, worker: { format: 'es' } });
