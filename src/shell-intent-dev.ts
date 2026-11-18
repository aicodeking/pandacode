/* Shell-intent handlers for developer tools: package managers, test runners, compilers, scripts and installers. */
import {
  NONE, argsSummary, basename, clip, desc, destroys, firstAndMore, firstAndMoreFiles, flagValue, isFlag, positionals, quoted, set, urlParts, withImage,
  type Desc, type Handler, type Recurse, type Segment, type ShellVerb,
} from './shell-intent-base.ts';
import { inlineScript, inlineText } from './shell-intent-scripts.ts';
import { SEVERITY } from './shell-intent-risk.ts';
import { editedInPlace } from './shell-intent-files.ts';

const same = (word: string) => word;
const testRun = (label: string, object = '') => desc('test', 'Ran tests', label, object);
const PLAYWRIGHT_FLAGS = set('-g', '--grep', '--grep-invert', '--project', '-c', '--config', '-j', '--workers', '--reporter', '--retries', '--repeat-each', '--timeout', '--shard', '--max-failures');
const INSTALL_SUBS = set('install', 'i', 'ci', 'add', 'isntall', 'reinstall', 'upgrade', 'sync');
const REMOVE_SUBS = set('remove', 'rm', 'uninstall', 'un');
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

function testTargets(args: string[], valueFlags: ReadonlySet<string> = NONE): string {
  const grep = flagValue(args, ['-g', '--grep', '-t', '--testNamePattern', '-k']);
  if (grep) return `"${clip(grep, 40)}"`;
  return firstAndMoreFiles(positionals(args, valueFlags).filter(arg => arg !== 'run'));
}

/** `[pattern, kind, verb]`: what a package.json script name usually does. */
const SCRIPT_KINDS: [RegExp, 'test' | 'build' | 'typecheck', ShellVerb][] = [
  [/^test\b/, 'test', 'Ran tests'], [/^build\b/, 'build', 'Built'], [/^(?:typecheck|tsc|check)\b/, 'typecheck', 'Typechecked'], [/^lint\b/, 'typecheck', 'Linted'],
];

function packageScript(pm: string, script: string, args: string[]): Desc {
  const object = firstAndMoreFiles(positionals(args));
  const match = SCRIPT_KINDS.find(([pattern]) => pattern.test(script));
  if (!match) return desc('shell', 'Ran', `${pm} run ${clip(script, 32)}`, object);
  const [, kind, verb] = match;
  // The chip is the script as run (`npm run test:release`, `pnpm run build:web`); only a bare `test` reads `npm test`.
  if (kind === 'test') return testRun(script === 'test' ? `${pm} test` : `${pm} run ${clip(script, 32)}`, object);
  return desc(kind, verb, `${pm} run ${clip(script, 32)}`, kind === 'build' ? object : '');
}

function script(program: string, args: string[], seg: Segment, recurse: Recurse): Desc {
  // `node -e`, `python -c`, `perl -ne` / `-lane` / `-0pe`: the script is inline text, not a file.
  const inline = args.some(arg => /^-(?:c|-eval|-print|[\w]*[ep])$/.test(arg)) || args.includes('-') || seg.heredoc;
  const file = positionals(args, set('-m', '-W', '-X', '-r', '--require', '--import', '--loader'))[0];
  if (inline || !file) return inlineScript(program, inlineText(args, seg), recurse, seg.heredoc && !args.some(arg => /^-(?:c|-eval|-print|[\w]*[ep])$/.test(arg)));
  const rest = args.slice(args.indexOf(file) + 1);
  return wrappedTests(clip(basename(file), 48), rest, seg, recurse) ?? desc('script', 'Ran', clip(basename(file), 48), argsSummary(positionals(rest)));
}

/** Programs that start a test run when a wrapper script is handed one (`verify.py … npx playwright test`). */
const RUNNER_STARTS = set('npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun', 'playwright', 'vitest', 'jest', 'mocha', 'pytest', 'cargo', 'go',
  'node', 'deno', 'python', 'python3', 'uv', 'uvx', 'make', 'swift', 'xcodebuild');
const MAX_WRAPPED_ARGS = 24;

/** `python3 verify.py --base main npx playwright test a.spec.ts`, `./ci.sh cargo test`: a wrapper whose arguments run a
 * test runner reads `Ran tests [playwright] via verify.py`. */
export function wrappedTests(wrapper: string, args: string[], seg: Segment, recurse: Recurse): Desc | undefined {
  const limit = Math.min(args.length, MAX_WRAPPED_ARGS);
  for (let i = 0; i < limit; i++) {
    if (!RUNNER_STARTS.has(basename(args[i]))) continue;
    const inner = recurse(args.slice(i), { ...seg, heredoc: false, body: '' });
    if (inner?.kind === 'test') return testRun(inner.label, `via ${wrapper}`);
  }
  return undefined;
}

const PM_OTHER = /^(?:view|info|ls|list|outdated|why|publish|version|init|create|update|up|upgrade|audit|config|link|pack|cache)$/;

const packageManager: Handler = (pm, args, seg, recurse) => {
  const rest = positionals(args, set('--prefix', '-C', '--dir', '--filter', '-F', '-w', '--workspace', '--cwd'));
  const [sub = '', ...more] = rest;
  const after = args.slice(args.indexOf(sub) + 1);
  if (!sub) return pm === 'yarn' || pm === 'bun' ? desc('install', 'Installed', pm) : undefined;
  if (INSTALL_SUBS.has(sub)) return desc('install', 'Installed', pm, firstAndMore(more, same));
  if (REMOVE_SUBS.has(sub)) return desc('install', 'Removed', pm, firstAndMore(more, same));
  if (sub === 'init' || sub === 'create') return desc('install', 'Initialized', 'package', firstAndMore(more, same));
  if (/^(?:view|info|show|v)$/.test(sub) && more[0]) return desc('install', 'Looked up', clip(more[0], 48), clip(more.slice(1).join(' '), 40));
  if (sub === 'unpublish') return destroys(desc('install', 'Unpublished', clip(more[0] ?? 'package', 48), '', 'trash'), SEVERITY.tree);
  if (['test', 't', 'tst'].includes(sub)) return testRun(`${pm} test`, firstAndMore(more));
  if (sub === 'run' || sub === 'run-script') return more[0] ? packageScript(pm, more[0], args.slice(args.indexOf(more[0]) + 1)) : undefined;
  if (['exec', 'dlx', 'x'].includes(sub)) return recurse(after, seg);
  if (sub === 'workspace' && more[0]) return packageManager(pm, args.slice(args.indexOf(more[0]) + 1), seg, recurse);
  if (pm === 'bun' && (SCRIPT_FILE.test(sub) || sub.includes('/'))) return script(pm, args, seg, recurse);
  if (pm !== 'npm' && !PM_OTHER.test(sub)) return packageScript(pm, sub, after);
  return desc('shell', 'Ran', `${pm} ${clip(sub, 24)}`, firstAndMore(more, same));
};

const npx: Handler = (_program, args, seg, recurse) => {
  const words = args.filter((arg, i) => !(isFlag(arg) && i === 0) && arg !== '--yes' && arg !== '-y');
  return recurse(words, seg);
};

const JS_TESTS = set('vitest', 'jest', 'mocha', 'ava');
const TYPECHECKERS = set('tsc', 'vue-tsc', 'svelte-check', 'mypy', 'pyright');
const LINTERS = set('eslint', 'biome', 'oxlint', 'ruff', 'stylelint', 'shellcheck', 'flake8', 'pylint', 'rubocop', 'swiftlint', 'markdownlint',
  'markdownlint-cli2', 'hadolint', 'golangci-lint', 'tflint', 'yamllint', 'actionlint', 'standard', 'xo');
const FORMATTERS = set('prettier', 'black', 'gofmt', 'goimports', 'rustfmt', 'swiftformat', 'swift-format', 'isort', 'clang-format', 'shfmt', 'autopep8',
  'yapf', 'dprint', 'stylua', 'ktlint', 'mix');

/** Formatter options that take a separate value (`rustfmt --edition 2021`, `prettier --print-width 100`, `black -l 100`). */
const FORMAT_VALUES = set('--config', '-c', '--edition', '--config-path', '--emit', '--color', '--print-width', '--tab-width', '--parser',
  '--ignore-path', '--plugin', '--trailing-comma', '--end-of-line', '--log-level', '--cache-location', '--stdin-filepath', '--quote-props',
  '--arrow-parens', '--prose-wrap', '-l', '--line-length', '-t', '--target-version', '--include', '--exclude', '--extend-exclude',
  '--force-exclude', '--profile', '--settings-path', '--style', '--assume-filename', '-i', '-ln', '--indent', '--indent-width',
  '--column-width', '--swiftversion', '--rules', '--disable', '--enable', '--max-line-length', '--select', '--ignore', '--python-version');

/** `prettier --write`, `black`, `ruff format`, `biome format`; `--check` only checks. Option values are never targets. */
function formatted(program: string, args: string[]): Desc {
  const checks = args.some(arg => /^(?:--check|-c|-l|--list-different|-d|--diff|--dry-run)$/.test(arg)) && !args.includes('--write');
  const valued = checks ? new Set([...FORMAT_VALUES].filter(flag => flag !== '-c' && flag !== '-l')) : FORMAT_VALUES;
  const targets = firstAndMoreFiles(positionals(args, valued).filter(arg => !/^(?:format|fmt|check|\d+)$/.test(arg)), same);
  return desc('typecheck', checks ? 'Checked' : 'Formatted', program, targets);
}

function linted(program: string, args: string[]): Desc {
  if ((program === 'ruff' || program === 'biome') && args[0] === 'format') return formatted(program, args);
  return desc('typecheck', 'Linted', program, firstAndMoreFiles(positionals(args).filter(arg => !/^(?:check|run|lint)$/.test(arg))));
}
const formatter: Handler = (program, args) => formatted(program, args);
const linter: Handler = (program, args) => linted(program, args);

/** `playwright screenshot https://x out.png`: a captured page. */
function playwrightScreenshot(args: string[]): Desc {
  const [url = '', file] = positionals(args.slice(1), set('--device', '--viewport-size', '--wait-for-selector', '--wait-for-timeout', '-b', '--browser', '--color-scheme'));
  return withImage(desc('media', 'Captured screenshot', file ? clip(basename(file), 48) : clip(urlParts(url)?.[0] ?? 'page', 48), '', 'camera'), file);
}

const jsTool: Handler = (program, args) => {
  if (program === 'playwright' && args[0] === 'screenshot') return playwrightScreenshot(args);
  if (program === 'playwright') return args[0] === 'test' ? testRun('playwright', testTargets(args.slice(1), PLAYWRIGHT_FLAGS)) : desc('shell', 'Ran', `playwright ${args[0] ?? ''}`.trim());
  if (JS_TESTS.has(program)) return testRun(program, testTargets(args, set('-c', '--config', '--reporter', '-t')));
  if (TYPECHECKERS.has(program)) return desc('typecheck', 'Typechecked', program);
  if (LINTERS.has(program)) return linted(program, args);
  if ((program === 'vite' || program === 'tauri' || program === 'next') && args[0] === 'build') return desc('build', 'Built', `${program} build`);
  // `vite preview`, `next start`: serves a finished build until stopped.
  if ((program === 'vite' && args[0] === 'preview') || (program === 'next' && args[0] === 'start')) return desc('process', 'Started preview server', `${program} ${args[0]}`, '', 'server');
  // `vite`, `vite --host`, `vite dev`, `next dev`: a dev server that keeps running.
  const serves = program === 'vite' ? !args[0] || args[0].startsWith('-') || args[0] === 'dev' || args[0] === 'serve' : program === 'next' && args[0] === 'dev';
  return serves ? desc('process', 'Started dev server', program, '', 'server') : undefined;
};

const CARGO_FLAGS = set('-p', '--package', '--test', '--bin', '--features', '-F', '--manifest-path', '-j', '--jobs', '--target', '--example');

const cargo: Handler = (_program, args) => {
  const [sub = '', ...rest] = positionals(args.slice(0, args.includes('--') ? args.indexOf('--') : args.length), CARGO_FLAGS);
  const object = firstAndMore(rest, same);
  if (sub === 'test' || sub === 'nextest' || sub === 't') return testRun('cargo test', firstAndMore(rest.filter(arg => arg !== 'run'), same));
  if (sub === 'check' || sub === 'clippy' || sub === 'c') return desc('typecheck', sub === 'clippy' ? 'Linted' : 'Typechecked', `cargo ${sub === 'c' ? 'check' : sub}`);
  if (sub === 'build' || sub === 'b') return desc('build', 'Built', 'cargo build');
  if (sub === 'fmt') return desc('typecheck', args.includes('--check') ? 'Checked' : 'Formatted', 'cargo fmt');
  if (sub === 'add' || sub === 'install') return desc('install', 'Installed', 'cargo', object);
  return desc('shell', 'Ran', `cargo ${clip(sub, 24)}`.trim(), object);
};

const goTool: Handler = (_program, args) => {
  const [sub = '', ...rest] = positionals(args, set('-run', '-tags', '-o', '-count', '-timeout'));
  const object = firstAndMore(rest, same);
  // `go test ./...`: every package, which is what `go test` means; only a narrower pattern is worth naming.
  if (sub === 'test') return testRun('go test', rest.length === 1 && rest[0] === './...' ? '' : object);
  if (sub === 'build') return desc('build', 'Built', 'go build');
  if (sub === 'vet') return desc('typecheck', 'Typechecked', 'go vet');
  if (sub === 'fmt') return desc('typecheck', 'Formatted', 'go fmt', object);
  if (sub === 'get' || sub === 'install') return desc('install', 'Installed', 'go', object);
  return desc('shell', 'Ran', `go ${clip(sub, 24)}`.trim(), object);
};

const installer: Handler = (program, args) => {
  const [sub = '', ...rest] = positionals(args, set('-r', '--requirement', '-t', '--target'));
  const requirements = flagValue(args, ['-r', '--requirement']);
  const object = requirements ? basename(requirements) : firstAndMore(rest, same);
  if (INSTALL_SUBS.has(sub)) return desc('install', 'Installed', program, object);
  if (REMOVE_SUBS.has(sub)) return desc('install', 'Removed', program, object);
  return desc('shell', 'Ran', `${program} ${clip(sub, 24)}`.trim(), firstAndMore(rest, same));
};

const UV_RUN_FLAGS = set('--with', '--python', '-p', '--project', '--directory', '--from', '--package', '--env-file', '--extra', '--group');

/** `uv run pytest`, `uv pip install`, `uv tool run x`, `uvx ruff`. */
const uv: Handler = (program, args, seg, recurse) => {
  if (program === 'uvx') {
    const [command] = positionals(args, UV_RUN_FLAGS);
    return command ? recurse(args.slice(args.indexOf(command)), seg) : undefined;
  }
  const [sub = '', next = ''] = positionals(args, UV_RUN_FLAGS);
  const after = args.slice(args.indexOf(sub) + 1);
  if (sub === 'run' || (sub === 'tool' && next === 'run')) {
    const runArgs = sub === 'tool' ? after.slice(after.indexOf('run') + 1) : after;
    const [command] = positionals(runArgs, UV_RUN_FLAGS);
    return command ? recurse(runArgs.slice(runArgs.indexOf(command)), seg) : undefined;
  }
  if (sub === 'pip') return installer('pip', after, seg, recurse);
  if (sub === 'lock') return desc('install', 'Locked', 'uv');
  return installer(program, args, seg, recurse);
};

/** Make targets that build: none (the default goal), `all`, `build*`, `release`, `dist`, … */
const MAKE_BUILDS = /^(?:|all|build[\w:-]*|release|dist|compile|bundle|install|package|app|debug)$/;

const make: Handler = (_program, args) => {
  const target = positionals(args, set('-C', '-f', '--file', '--directory')).filter(arg => !/^\d+$/.test(arg) && !arg.includes('='))[0] ?? '';
  if (/^test/.test(target)) return testRun(`make ${target}`);
  if (target === 'clean') return desc('build', 'Cleaned', 'make clean');
  // `make deploy`, `make run`: a target that is not a build is only run, named as given.
  return MAKE_BUILDS.test(target) ? desc('build', 'Built', `make ${target}`.trim()) : desc('shell', 'Ran', `make ${clip(target, 32)}`);
};

const appleBuild: Handler = (program, args) => {
  const sub = positionals(args, set('-scheme', '-project', '-workspace', '-destination', '-configuration', '-sdk', '--package-path', '-c'))[0] ?? '';
  if (sub === 'test') return testRun(program === 'swift' ? 'swift test' : 'xcodebuild');
  if (program === 'swift' && sub !== 'build') return desc('shell', 'Ran', `swift ${clip(sub, 24)}`.trim());
  return desc('build', 'Built', program === 'swift' ? 'swift build' : 'xcodebuild');
};

const node: Handler = (program, args, seg, recurse) => {
  if (args.includes('--test')) return testRun('node:test', firstAndMore(positionals(args)));
  return script(program, args, seg, recurse);
};

const python: Handler = (program, args, seg, recurse) => {
  const module = flagValue(args, ['-m']);
  if (module === 'pytest' || module === 'unittest') return testRun(module, testTargets(args.slice(args.indexOf(module) + 1)));
  if (module === 'pip') return installer('pip', args.slice(args.indexOf(module) + 1), seg, recurse);
  if (module) return desc('script', 'Ran', `${program} -m ${clip(module, 24)}`);
  return script(program, args, seg, recurse);
};

const deno: Handler = (program, args, seg, recurse) => args[0] === 'test' ? testRun('deno test', firstAndMore(args.slice(1))) : script(program, args.slice(args[0] === 'run' ? 1 : 0), seg, recurse);
const shellScript: Handler = (program, args, seg, recurse) => script(program, args, seg, recurse);

/** `perl -pi -e 's/a/b/' *.ts`: edited in place; any other perl runs its script. */
const perl: Handler = (program, args, seg, recurse) => {
  // `-pi`, `-i.bak`, `-0pie`: lowercase bundles only (`-Ilib` adds an include path).
  if (!args.some(arg => /^-[0-9a-z]*i/.test(arg))) return script(program, args, seg, recurse);
  const code = args.findIndex(arg => /^-[0-9a-z]*e$/.test(arg));
  const files = positionals(args.filter((_, i) => code < 0 || i !== code + 1));
  return editedInPlace(files, 'perl');
};
const pytest: Handler = (_program, args) => testRun('pytest', testTargets(args));

/** `bash x.sh a`: the script file (a fed or inline shell is handled by shell-intent.ts). */
const shellFile: Handler = (_program, args, seg, recurse) => {
  const [file, ...rest] = positionals(args, set('-o', '-O', '+o', '+O'));
  if (!file) return undefined;
  const after = args.slice(args.indexOf(file) + 1);
  return wrappedTests(clip(basename(file), 48), after, seg, recurse) ?? desc('script', 'Ran', clip(basename(file), 48), argsSummary(rest));
};

const AXE_VALUES = set('--udid', '-x', '-y', '--tags', '--rules', '--save', '--dir', '--label', '--id', '--output', '--duration', '--delta',
  '--start-x', '--start-y', '--end-x', '--end-y', '--pre-delay', '--post-delay', '--direction', '--keycode', '--button', '--text');

/** `axe http://…` (axe-core) checks accessibility; AXe's simulator subcommands (`axe tap -x 1 -y 2`) say what they did. */
const axe: Handler = (_program, args) => {
  const [target = '', ...rest] = positionals(args, AXE_VALUES);
  if (/^(?:https?:\/\/|localhost|file:|[\w.-]+\.html?$)/.test(target)) {
    return desc('test', 'Ran accessibility check', clip(urlParts(target)?.[0] ?? basename(target), 48), '', 'check');
  }
  return axeSimulator(target, rest, args);
};

const onSimulator = (verb: ShellVerb, object = '') => desc('system', verb, 'on simulator', object, 'phone');

/** AXe (iOS simulator automation): `tap`, `swipe`, `type`, `press`/`key`/`button`, `describe-ui`, `screenshot`. */
function axeSimulator(sub: string, rest: string[], args: string[]): Desc | undefined {
  if (sub === 'tap') {
    const x = flagValue(args, ['-x']), y = flagValue(args, ['-y']), label = flagValue(args, ['--label', '--id']);
    return onSimulator('Tapped', label ? quoted(label) : x && y ? `at ${clip(x, 12)}, ${clip(y, 12)}` : '');
  }
  if (sub === 'swipe' || sub === 'gesture') return onSimulator('Swiped', sub === 'gesture' ? clip(rest[0] ?? '', 30) : '');
  if (sub === 'type') {
    const text = flagValue(args, ['--text']) ?? rest.join(' ');
    return onSimulator('Typed', text ? quoted(text, 40) : '');
  }
  if (/^(?:press|key|key-sequence|key-combo|button)$/.test(sub)) return onSimulator('Pressed', clip(rest.join(' ') || flagValue(args, ['--button', '--keycode']) || sub, 30));
  if (sub === 'describe-ui') return desc('system', 'Inspected', 'simulator UI', '', 'phone');
  if (sub === 'screenshot') return desc('system', 'Captured simulator screenshot', clip(basename(flagValue(args, ['--output']) ?? rest[0] ?? 'simulator'), 48), '', 'camera');
  return undefined;
}

/** `expo lint`, `npx expo lint`: Expo's ESLint run. */
const expo: Handler = (_program, args) => positionals(args)[0] === 'lint' ? desc('typecheck', 'Linted', 'expo', firstAndMoreFiles(positionals(args).slice(1))) : undefined;

/** Values of libtest's own options (`--test-threads 1`, `--skip x`). */
const LIBTEST_VALUES = set('--test-threads', '--skip', '--format', '--color', '-Z', '--logfile', '--report-time', '--shuffle-seed');

/** `target/debug/deps/pandacode_lib-0123456789abcdef tool_images`: a cargo test binary run directly, with its filter. */
export const cargoTestBinary: Handler = (_program, args) => testRun('cargo', clip(positionals(args, LIBTEST_VALUES)[0] ?? '', 60));

/** `<crate>-<16 hex>`, as cargo names a test binary. */
export const isTestBinary = (program: string) => /^[A-Za-z_][\w]*-[0-9a-f]{16}$/.test(program);

export const DEV_HANDLERS: Record<string, Handler> = {
  npm: packageManager, pnpm: packageManager, yarn: packageManager, bun: packageManager, npx, pnpx: npx, bunx: npx,
  playwright: jsTool, vitest: jsTool, jest: jsTool, mocha: jsTool, ava: jsTool, tsc: jsTool, 'vue-tsc': jsTool, 'svelte-check': jsTool,
  eslint: jsTool, biome: jsTool, oxlint: jsTool, ruff: jsTool, stylelint: jsTool, mypy: jsTool, pyright: jsTool, vite: jsTool, tauri: jsTool, next: jsTool,
  cargo, go: goTool, make, gmake: make, pytest, 'py.test': pytest, xcodebuild: appleBuild, swift: appleBuild,
  pip: installer, brew: installer, 'apt-get': installer, apt: installer, gem: installer, poetry: installer, uv, uvx: uv,
  node, deno, python, ruby: shellScript, perl, php: shellScript, tsx: shellScript, 'ts-node': shellScript, osascript: shellScript,
  shellcheck: linter, flake8: linter, pylint: linter, rubocop: linter, swiftlint: linter, markdownlint: linter, 'markdownlint-cli2': linter,
  hadolint: linter, 'golangci-lint': linter, tflint: linter, yamllint: linter, actionlint: linter,
  prettier: formatter, black: formatter, gofmt: formatter, goimports: formatter, rustfmt: formatter, swiftformat: formatter, 'swift-format': formatter,
  isort: formatter, 'clang-format': formatter, shfmt: formatter, autopep8: formatter, yapf: formatter, dprint: formatter, stylua: formatter,
  sh: shellFile, bash: shellFile, zsh: shellFile, dash: shellFile, ksh: shellFile, fish: shellFile, axe, expo,
};
