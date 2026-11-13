// The default local packaging path carries the verified trusted runtime on Windows x64.
// This prepares build resources only; it never installs or launches the application.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTrustedRuntime } from './extensions-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
const targetFlag = options.findIndex(arg => ['--target', '-t'].includes(arg));
const target = targetFlag >= 0 ? options[targetFlag + 1] : options.find(arg => arg.startsWith('--target=') || arg.startsWith('-t='))?.split('=')[1];
const informational = options.some(arg => ['--help', '-h', '--version', '-V'].includes(arg));
const resources = informational ? {} : stageTrustedRuntime({ ...(target ? { target } : {}) });
const config = Object.keys(resources).length ? ['--config', JSON.stringify({ bundle: { resources } })] : [];
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...config, ...args], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
