import { defineConfig } from 'vite';
// ES-module workers: the diff highlighter worker (@pierre/diffs) imports Shiki chunks.
export default defineConfig({ clearScreen: false, server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } }, build: { target: 'es2022', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', 'agents-dock': 'agents-dock.html' } } }, worker: { format: 'es' } });
