import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell, testSummary, testSummaryHtml } from '../src/shell-intent.ts';
import { readFileSync } from 'node:fs';

const pick = (intent, ...keys) => Object.fromEntries(keys.map(key => [key, intent[key]]));
const ICONS = new Set([...readFileSync('src/dom.ts', 'utf8').matchAll(/^ {2}([a-zA-Z]+): '/gm)].map(m => m[1]));

test('reads: sed ranges, cat, head, tail, nl, bat', () => {
  assert.deepEqual(pick(describeShell('sed -n 210,222p tests/voice-input.spec.ts'), 'kind', 'verb', 'label', 'object', 'icon'),
    { kind: 'read', verb: 'Read', label: 'voice-input.spec.ts', object: 'lines 210–222', icon: 'file' });
  assert.equal(describeShell("sed -n '5p' a.ts").object, 'line 5');
  assert.equal(describeShell("sed -n '1,40p' src/a.ts").label, 'a.ts');
  assert.deepEqual(pick(describeShell('cat src/main.ts'), 'kind', 'label', 'object'), { kind: 'read', label: 'main.ts', object: '' });
  assert.equal(describeShell('cat a.ts b.ts c.ts').object, '+2 files');
  assert.deepEqual(pick(describeShell('head -50 f.txt'), 'kind', 'label', 'object'), { kind: 'read', label: 'f.txt', object: 'first 50 lines' });
  assert.equal(describeShell('head -n 20 f.txt').object, 'first 20 lines');
  assert.deepEqual(pick(describeShell('tail -n 30 logs/app.log'), 'kind', 'label', 'object'), { kind: 'read', label: 'app.log', object: 'last 30 lines' });
  assert.equal(describeShell('nl -ba src/x.rs').label, 'x.rs');
  assert.equal(describeShell('bat README.md').kind, 'read');
});

test('cd preludes and shell wrappers are stripped', () => {
  const intent = describeShell('cd /Users/me/code/worktrees/x && npx tsc --noEmit');
  assert.deepEqual(pick(intent, 'kind', 'verb', 'label', 'steps', 'icon'), { kind: 'typecheck', verb: 'Typechecked', label: 'tsc', steps: 1, icon: 'check' });
  assert.equal(describeShell('cd x; git status').label, 'git status');
  assert.equal(describeShell('/bin/zsh -lc "cd /repo && git status --short"').label, 'git status');
  assert.equal(describeShell("bash -c 'sleep 5'").kind, 'wait');
  assert.equal(describeShell('FOO=1 CI=true npm test').kind, 'test');
  assert.equal(describeShell('cd /repo').kind, 'shell');
});

test('compound commands describe the first step and count the rest', () => {
  const intent = describeShell('cd /x; sed -n 210,222p tests/a.ts; grep -n foo src/b.ts | head');
  assert.equal(intent.kind, 'read');
  assert.equal(intent.label, 'a.ts');
  assert.equal(intent.steps, 2);
  assert.equal(intent.object, 'lines 210–222 · +1 more command');
  const three = describeShell('git status && git diff --stat || git log -1');
  assert.equal(three.steps, 3);
  assert.match(three.object, /\+2 more commands$/);
  assert.match(three.title, /git diff --stat/);
});

test('quotes are respected when splitting', () => {
  const intent = describeShell(`rg -n "a; b && c" src`);
  assert.equal(intent.steps, 1);
  assert.equal(intent.object, 'for "a; b && c" in src');
  assert.equal(describeShell(`git commit -m 'fix: x; y && z'`).object, '"fix: x; y && z"');
  assert.equal(describeShell(`grep -n "it's" a.ts`).steps, 1);
});

test('heredocs are scripts and their bodies are not split', () => {
  const intent = describeShell("python3 - <<'PY'\nimport json; print(1)\nx = 1 && 2\nPY");
  assert.deepEqual(pick(intent, 'kind', 'verb', 'label', 'steps'), { kind: 'script', verb: 'Ran', label: 'Python script', steps: 1 });
  const after = describeShell("node - <<EOF\nconsole.log(1); process.exit(0)\nEOF\nnpm run lint");
  assert.equal(after.kind, 'script');
  assert.equal(after.steps, 2);
  assert.equal(describeShell(`node -e "console.log(1)"`).kind, 'script');
  assert.equal(describeShell('python3 scripts/gen.py').label, 'gen.py');
  const wrote = describeShell("cat > notes/a.md <<'EOF'\nhello; world\nEOF");
  assert.deepEqual(pick(wrote, 'verb', 'label', 'icon', 'steps'), { verb: 'Wrote', label: 'a.md', icon: 'edit', steps: 1 });
});

test('searches', () => {
  assert.deepEqual(pick(describeShell('rg -n pattern src'), 'kind', 'verb', 'label', 'object', 'icon'),
    { kind: 'search', verb: 'Searched', label: 'src', object: 'for "pattern" in src', icon: 'search' });
  assert.equal(describeShell('grep -rn --include=*.ts foo .').object, 'for "foo" in .');
  assert.equal(describeShell('rg -e needle -g "*.rs"').object, 'for "needle"');
  assert.equal(describeShell('ag thing lib').kind, 'search');
  assert.equal(describeShell('grep -n foo src/b.ts | head -5').kind, 'search');
});

test('listings', () => {
  assert.deepEqual(pick(describeShell('ls -la src/scenes'), 'kind', 'verb', 'label', 'icon'), { kind: 'list', verb: 'Listed', label: 'scenes', icon: 'folder' });
  assert.equal(describeShell('ls').label, '.');
  const find = describeShell("find src -name '*.ts' | wc -l");
  assert.deepEqual(pick(find, 'kind', 'label', 'object'), { kind: 'list', label: 'src', object: 'matching *.ts' });
  assert.equal(describeShell('tree -L 2 docs').label, 'docs');
  assert.equal(describeShell('fd spec tests').object, 'matching spec');
});

test('test runners', () => {
  const cases = [
    ['npm test', 'npm test'], ['npm run test:release', 'npm run test:release'], ['node --test tests/a.test.mjs', 'node:test'],
    ['npx playwright test tests/a.spec.ts', 'playwright'], ['npx vitest run', 'vitest'], ['jest --ci', 'jest'],
    ['cargo test codex', 'cargo test'], ['pytest -q tests', 'pytest'], ['python -m pytest', 'pytest'], ['go test ./...', 'go test'],
    ['pnpm test', 'pnpm test'],
  ];
  for (const [command, label] of cases) {
    const intent = describeShell(command);
    assert.equal(intent.kind, 'test', command);
    assert.equal(intent.verb, 'Ran tests', command);
    assert.equal(intent.label, label, command);
  }
  assert.equal(describeShell('npx playwright test tests/a.spec.ts tests/b.spec.ts').object, 'a.spec.ts +1 file');
  assert.equal(describeShell('npx playwright test -g "opens the menu"').object, '"opens the menu"');
  assert.equal(describeShell('cargo test codex').object, 'codex');
  assert.equal(describeShell('cd src-tauri && cargo test --lib codex -- --nocapture').object, 'codex');
});

test('typecheck, build and install', () => {
  assert.equal(describeShell('cargo check').kind, 'typecheck');
  assert.equal(describeShell('cargo clippy --all-targets').label, 'cargo clippy');
  assert.equal(describeShell('npx eslint src').verb, 'Linted');
  for (const [command, label] of [['npm run build', 'npm run build'], ['cargo build --release', 'cargo build'], ['npx vite build', 'vite build']]) {
    const intent = describeShell(command);
    assert.deepEqual(pick(intent, 'kind', 'verb', 'label'), { kind: 'build', verb: 'Built', label }, command);
  }
  for (const [command, label, object] of [['npm install', 'npm', ''], ['npm i -D vite', 'npm', 'vite'], ['pip install requests rich', 'pip', 'requests +1'], ['brew install jq', 'brew', 'jq']]) {
    const intent = describeShell(command);
    assert.deepEqual(pick(intent, 'kind', 'verb', 'label', 'object', 'icon'), { kind: 'install', verb: 'Installed', label, object, icon: 'download' }, command);
  }
  assert.deepEqual(pick(describeShell('npm run dev'), 'kind', 'label'), { kind: 'shell', label: 'npm run dev' });
});

test('git and github', () => {
  assert.deepEqual(pick(describeShell('git status'), 'kind', 'verb', 'label', 'icon'), { kind: 'git', verb: 'Checked', label: 'git status', icon: 'branch' });
  assert.equal(describeShell('git diff --stat').object, '');
  assert.equal(describeShell('git log --oneline -5').object, 'last 5');
  assert.deepEqual(pick(describeShell('git commit -m "feat: add thing"'), 'verb', 'label', 'object'), { verb: 'Committed', label: 'git commit', object: '"feat: add thing"' });
  assert.equal(describeShell('git -C /repo status').label, 'git status');
  assert.deepEqual(pick(describeShell('gh pr view 12'), 'kind', 'verb', 'label', 'object', 'icon'),
    { kind: 'github', verb: 'Viewed', label: 'gh pr view', object: '#12', icon: 'github' });
});

test('wait, fetch, db and fallback', () => {
  assert.deepEqual(pick(describeShell('sleep 30'), 'kind', 'verb', 'label', 'object', 'icon'), { kind: 'wait', verb: 'Waited', label: '30s', object: '30s', icon: 'clock' });
  assert.equal(describeShell('sleep 2m').object, '2m');
  const fetch = describeShell('curl -s https://api.github.com/repos/x/y | jq .name');
  assert.deepEqual(pick(fetch, 'kind', 'verb', 'label', 'object', 'icon'), { kind: 'fetch', verb: 'Fetched', label: 'api.github.com', object: '/repos/x/y', icon: 'globe' });
  assert.equal(describeShell('curl -H "Accept: x" -X POST http://localhost:1420/api').label, 'localhost:1420');
  assert.equal(describeShell('wget https://example.com/a.tgz').label, 'example.com');
  assert.deepEqual(pick(describeShell(`sqlite3 ~/data/app.db 'select * from threads limit 5'`), 'kind', 'verb', 'label', 'object'),
    { kind: 'db', verb: 'Queried', label: 'app.db', object: 'select * from threads limit 5' });
  assert.equal(describeShell('psql -c "select 1"').kind, 'db');
  assert.deepEqual(pick(describeShell('/usr/local/bin/uname -a'), 'kind', 'verb', 'label', 'object', 'icon'), { kind: 'shell', verb: 'Ran', label: 'uname', object: '-a', icon: 'terminal' });
});

const row = command => pick(describeShell(command), 'kind', 'verb', 'label', 'object');

test('pipes into non-filters fall back to the raw command', () => {
  for (const command of ['cat a.ts | sh', 'cat a.ts | bash', 'cat a.ts | zsh -s', 'cat a.ts | tee b.ts',
    'cat x.py | python3', 'cat a.js | node', 'ls | sudo rm -rf', 'grep foo a | sort -o out.txt', "rg foo | sed -i 's/a/b/' x"]) {
    const intent = describeShell(command);
    // The raw command, chipped by its leading program (never the generic `shell` when one is named).
    const program = command.split(' ')[0];
    assert.deepEqual(pick(intent, 'kind', 'verb', 'label', 'icon', 'raw'), { kind: 'shell', verb: 'Ran', label: program, icon: 'terminal', raw: true }, command);
    // The chip names the program, so the text after it starts at its arguments.
    assert.equal(intent.object, command.slice(program.length + 1), command);
  }
  for (const command of ['grep -n foo a.ts | head -5', 'rg foo | sort | uniq -c | wc -l', 'cat a.json | jq .x', "ls | awk '{print $1}' | column -t",
    "grep x f | cut -d: -f1 | tr a b | sed 's/a/b/' | nl | fold | tail -3 | less", 'rg foo | rg -v bar | grep baz | cat']) {
    assert.notEqual(describeShell(command).kind, 'shell', command);
  }
});

test('a pipe into xargs rm leads with the deletion', () => {
  assert.deepEqual(pick(describeShell('grep -rl foo . | xargs rm'), 'verb', 'label', 'object', 'destructive'),
    { verb: 'Deleted', label: 'files', object: 'listed by grep -rl foo .', destructive: true });
});

test('find with actions is not a listing', () => {
  assert.deepEqual(pick(describeShell("find . -name '*.orig' -delete"), 'kind', 'verb', 'label', 'object', 'icon'),
    { kind: 'file', verb: 'Deleted', label: 'files', object: 'matching *.orig', icon: 'trash' });
  for (const command of ["find . -name '*.ts' -exec rm {} \;", 'find src -type f -execdir chmod 644 {} +', 'find . -ok rm {} \;', 'find . -fprint out.txt']) {
    assert.equal(describeShell(command).kind, 'shell', command);
    assert.equal(describeShell(command).verb, 'Ran', command);
  }
});

test('output redirects, substitutions and value flags', () => {
  assert.equal(describeShell('rg -n foo src > results.txt').object, 'for "foo" in src → results.txt');
  assert.equal(describeShell('grep foo a.ts | sort >> out/hits.txt').object, 'for "foo" in a.ts → hits.txt');
  assert.equal(describeShell('ls -la src > /tmp/listing.txt').object, '→ listing.txt');
  assert.equal(describeShell('rg foo src 2>&1').object, 'for "foo" in src');
  assert.equal(describeShell('rg foo src >/dev/null 2>&1').object, 'for "foo" in src');
  assert.equal(describeShell('rg foo src 2> err.log').object, 'for "foo" in src');
  for (const command of ['cat <(git show HEAD:a.ts)', 'cat $(git ls-files)', 'cat `ls *.md`', 'rg foo $(git diff --name-only)', 'ls "$(pwd)/x"']) {
    const intent = describeShell(command);
    assert.equal(intent.kind, 'shell', command);
    assert.equal(`${intent.label} ${intent.object}`, command, command);
  }
  assert.equal(describeShell('rg --pre pdftotext needle docs').object, 'for "needle" in docs');
  assert.equal(describeShell('rg -g "*.ts" -t ts needle src').object, 'for "needle" in src');
  assert.equal(describeShell('rg --type-add "web:*.html" -t web -m 3 -A 2 -B 1 -C 4 --max-count 5 x src').object, 'for "x" in src');
  assert.equal(describeShell('rg -f patterns.txt src').object, 'for patterns from patterns.txt in src');
  assert.equal(describeShell('grep -T foo a.ts').object, 'for "foo" in a.ts');
  assert.equal(describeShell('grep -A 3 -e foo a.ts').object, 'for "foo" in a.ts');
});

test('main step skips noise', () => {
  assert.deepEqual(pick(describeShell('git add -A && git commit -m "fix: thing"'), 'kind', 'verb', 'label', 'object', 'steps'),
    { kind: 'git', verb: 'Committed', label: 'git commit', object: '"fix: thing"', steps: 1 });
  assert.equal(describeShell('git add -A').verb, 'Staged');
  assert.deepEqual(row('sleep 10 && curl -s http://localhost:1420/health'), { kind: 'fetch', verb: 'Fetched', label: 'localhost:1420', object: '/health · after 10s' });
  assert.deepEqual(row('set -e; export A=1; mkdir -p out; echo start; npm test'), { kind: 'test', verb: 'Ran tests', label: 'npm test', object: '' });
  assert.equal(describeShell('true && ls src').label, 'src');
  assert.equal(describeShell('sleep 30').kind, 'wait');
  assert.equal(describeShell('echo hi').verb, 'Ran');
  assert.deepEqual(row('echo hello > notes.txt'), { kind: 'file', verb: 'Wrote', label: 'notes.txt', object: '' });
  assert.deepEqual(row('echo hello >> notes.txt'), { kind: 'file', verb: 'Appended to', label: 'notes.txt', object: '' });
  const commit = describeShell(`git add . && git commit -m "$(cat <<'EOF'\nfeat: add the thing\n\nBody\nEOF\n)"`);
  assert.deepEqual(pick(commit, 'verb', 'object'), { verb: 'Committed', object: '"feat: add the thing"' });
});

test('loops, conditionals and groups classify their body', () => {
  assert.deepEqual(row('for f in a.ts b.ts; do cat "$f"; done'), { kind: 'read', verb: 'Read', label: 'a.ts', object: '+1 file' });
  assert.equal(describeShell('for f in *.spec.ts; do npx playwright test "$f"; done').kind, 'test');
  assert.equal(describeShell('while true; do curl -s http://x.dev/a; sleep 1; done').kind, 'fetch');
  assert.equal(describeShell('while read -r line; do rg "$line" src; done < list.txt').kind, 'search');
  assert.equal(describeShell('(cd src && ls)').label, 'src');
  assert.equal(describeShell('( cd src; git status )').label, 'git status');
  assert.equal(describeShell('{ git status; git log -1; }').label, 'git status');
  assert.equal(describeShell('if [ -f a.ts ]; then cat a.ts; fi').verb, 'Read');
  for (const command of ['for x in 1 2; do sleep 1; done', 'until false; do sleep 2; done']) assert.notEqual(describeShell(command).label, 'for', command);
});

test('plurals', () => {
  assert.equal(describeShell('cat a.ts b.ts').object, '+1 file');
  assert.equal(describeShell("sed -n '1,5p' a.ts b.ts").object, 'lines 1–5 · +1 file');
  assert.equal(describeShell("sed -n '1,5p' a.ts b.ts c.ts").object, 'lines 1–5 · +2 files');
  assert.equal(describeShell('ls a b').object, '+1 path');
  assert.equal(describeShell('rm a.ts b.ts c.ts').label, '3 files');
});

test('git verbs', () => {
  assert.equal(describeShell('git diff HEAD~1').verb, 'Diffed');
  assert.equal(describeShell('git show HEAD').verb, 'Showed');
  assert.equal(describeShell('git status').verb, 'Checked');
  assert.equal(describeShell('git push origin main').verb, 'Pushed');
  assert.deepEqual(pick(describeShell('git log --oneline -5'), 'verb', 'object'), { verb: 'Viewed history', object: 'last 5' });
});

test('everyday programs', () => {
  const cases = [
    ['rm -rf node_modules', 'file', 'Deleted', 'node_modules', '', 'trash'],
    ['rm a.ts b.ts', 'file', 'Deleted', '2 files', '', 'trash'],
    ['mv src/a.ts src/b.ts', 'file', 'Moved', 'a.ts', '→ b.ts', 'move'],
    ['cp -r assets/ dist/assets', 'file', 'Copied', 'assets', '→ assets', 'copy'],
    ['cp a.ts b.ts out/', 'file', 'Copied', '2 files', '→ out', 'copy'],
    ['kill -9 1234', 'process', 'Stopped', 'process', '1234', 'stop'],
    ['pkill -f vite', 'process', 'Stopped processes matching', 'vite', '', 'stop'],
    ['ps aux', 'process', 'Checked processes', 'ps', '', 'activity'],
    ['lsof -i :1420', 'process', 'Checked open files', 'lsof', 'on :1420', 'activity'],
    ['pgrep -f node', 'process', 'Checked processes', 'pgrep', 'matching node', 'activity'],
    ['ffmpeg -y -i in.mov -vf scale=640:-1 out/clip.mp4', 'media', 'Encoded', 'clip.mp4', 'from in.mov', 'play'],
    ['ffprobe -v error -show_entries format=duration media/a.mp4', 'media', 'Probed', 'a.mp4', '', 'play'],
    ['xcrun simctl boot "iPhone 16"', 'system', 'Booted simulator', 'simctl boot', 'iPhone 16', 'phone'],
    ['xcrun simctl io booted screenshot shot.png', 'system', 'Captured simulator screenshot', 'simctl io', 'shot.png', 'phone'],
    ['xcrun simctl list devices', 'system', 'Listed simulators', 'simctl list', 'devices', 'phone'],
    ['screencapture -x /tmp/shot.png', 'media', 'Captured screenshot', 'shot.png', '', 'camera'],
    ['shasum -a 256 dist/app.dmg', 'file', 'Hashed', 'app.dmg', '', 'lock'],
    ['md5 a.bin', 'file', 'Hashed', 'a.bin', '', 'lock'],
    ['test -f dist/app.js', 'file', 'Checked', 'app.js', 'exists', 'file'],
    ['[ -d node_modules ]', 'file', 'Checked', 'node_modules', 'exists', 'file'],
    ['[[ -e a.ts ]]', 'file', 'Checked', 'a.ts', 'exists', 'file'],
    ['wc -l src/main.ts', 'read', 'Counted lines in', 'main.ts', '', 'file'],
    ['wc -l < src/main.ts', 'read', 'Counted lines in', 'main.ts', '', 'file'],
    ['open https://example.com/docs', 'system', 'Opened', 'example.com', '/docs', 'external'],
    ['open dist/index.html', 'system', 'Opened', 'index.html', '', 'external'],
    ['open -a Safari', 'system', 'Opened', 'Safari', '', 'external'],
    ['du -sh node_modules', 'system', 'Checked disk usage', 'node_modules', '', 'monitor'],
    ['df -h', 'system', 'Checked disk usage', 'df', '', 'monitor'],
    ['which node', 'system', 'Located', 'node', '', 'search'],
    ['command -v rg', 'system', 'Located', 'rg', '', 'search'],
    ['chmod +x scripts/run.sh', 'file', 'Made executable', 'run.sh', '', 'lock'],
    ['chmod 644 a.txt', 'file', 'Set permissions', 'a.txt', '644', 'lock'],
    ['tar -xzf release.tgz -C out', 'file', 'Extracted', 'release.tgz', '', 'archive'],
    ['tar czf dist.tar.gz dist', 'file', 'Archived', 'dist.tar.gz', '', 'archive'],
    ['unzip -q pkg.zip -d out', 'file', 'Extracted', 'pkg.zip', '→ out', 'archive'],
    ['zip -r site.zip public', 'file', 'Archived', 'site.zip', '', 'archive'],
    ['docker ps -a', 'system', 'Listed containers', 'docker ps', '', 'server'],
    ['docker run --rm -p 8080:80 -e A=1 nginx:latest', 'system', 'Ran container', 'docker run', 'nginx:latest', 'server'],
    ['docker compose up -d', 'system', 'Started', 'docker compose up', '', 'server'],
    ['docker logs -f api', 'system', 'Viewed logs of', 'docker logs', 'api', 'server'],
    ['docker build -t app .', 'build', 'Built', 'docker build', '.', 'spark'],
    ['make release', 'build', 'Built', 'make release', '', 'spark'],
    ['make clean', 'build', 'Cleaned', 'make clean', '', 'spark'],
    ['uv sync', 'install', 'Installed', 'uv', '', 'download'],
    ['uv add httpx', 'install', 'Installed', 'uv', 'httpx', 'download'],
    ['uv pip install -r requirements.txt', 'install', 'Installed', 'pip', 'requirements.txt', 'download'],
    ['pip uninstall -y requests', 'install', 'Removed', 'pip', 'requests', 'download'],
    ['pnpm remove lodash', 'install', 'Removed', 'pnpm', 'lodash', 'download'],
    ['yarn workspace web build', 'build', 'Built', 'yarn run build', '', 'spark'],
    ['bun scripts/gen.ts', 'script', 'Ran', 'gen.ts', '', 'command'],
  ];
  for (const [command, kind, verb, label, object, icon] of cases) {
    assert.deepEqual(pick(describeShell(command), 'kind', 'verb', 'label', 'object', 'icon'), { kind, verb, label, object, icon }, command);
  }
  assert.equal(describeShell('uv run pytest -q tests').kind, 'test');
  assert.equal(describeShell('uvx ruff check src').verb, 'Linted');
  assert.equal(describeShell('bun test').kind, 'test');
  assert.equal(describeShell('rm $(git ls-files -d)').kind, 'shell');
  assert.equal(describeShell("kill $(lsof -ti :1420)").kind, 'process');
  for (const [command] of cases) assert.ok(ICONS.has(describeShell(command).icon), command);
});

test('never throws, bounds input and only uses real icons', () => {
  for (const input of ['', '   ', ';;&&||', '"unterminated', "'x", '<<EOF', 'a |', '\\', 'x'.repeat(100_000), null, undefined, 42]) {
    const intent = describeShell(input);
    assert.ok(ICONS.has(intent.icon), String(intent.icon));
    assert.ok(intent.title.length <= 20_000);
    assert.equal(typeof intent.verb, 'string');
  }
  const samples = ['cat a', 'rg x', 'ls', 'npm test', 'tsc', 'npm run build', 'npm i', 'git status', 'gh pr list', 'sleep 1', 'curl https://a.b', 'node -e 1', 'sqlite3 a.db', 'echo hi', 'sed -i s/a/b/ f'];
  for (const sample of samples) assert.ok(ICONS.has(describeShell(sample).icon), sample);
});

test('parses node:test output', () => {
  const summary = testSummary('Exit code: 1\nnot ok 3 - parses things\n# tests 13\n# pass 12\n# fail 1\n# skipped 2\n# duration_ms 1234.5\n');
  assert.deepEqual(summary, { runner: 'node:test', passed: 12, failed: 1, skipped: 2, durationMs: 1235, failures: ['parses things'] });
  const spec = testSummary('\x1b[31m✖ breaks (1.2ms)\x1b[39m\nℹ pass 4\nℹ fail 1\nℹ skipped 0\nℹ duration_ms 50\n');
  assert.deepEqual(spec, { runner: 'node:test', passed: 4, failed: 1, skipped: 0, durationMs: 50, failures: ['breaks'] });
});

test('parses playwright output', () => {
  const output = [
    'Running 15 tests using 4 workers',
    '  ✘  3 [chromium] › tests/a.spec.ts:10:5 › opens the menu (1.2s)',
    '  ✘  4 [chromium] › tests/a.spec.ts:10:5 › opens the menu (retry #1) (1.3s)',
    '  2 failed',
    '    [chromium] › tests/a.spec.ts:10:5 › opens the menu',
    '    [chromium] › tests/b.spec.ts:3:1 › closes',
    '  1 skipped',
    '  12 passed (34.5s)',
  ].join('\n');
  assert.deepEqual(testSummary(output), {
    runner: 'playwright', passed: 12, failed: 2, skipped: 1, durationMs: 34500,
    failures: ['tests/a.spec.ts:10:5 › opens the menu', 'tests/b.spec.ts:3:1 › closes'],
  });
  assert.equal(testSummary('  40 passed (1.5m)').durationMs, 90000);
});

test('parses vitest and jest output', () => {
  const vitest = testSummary(' FAIL  tests/a.test.ts > math > adds\n Test Files  1 failed | 4 passed (5)\n      Tests  3 failed | 40 passed | 2 skipped (45)\n   Duration  2.31s\n');
  assert.deepEqual(vitest, { runner: 'vitest', passed: 40, failed: 3, skipped: 2, durationMs: 2310, failures: ['tests/a.test.ts > math > adds'] });
  const jest = testSummary('  ● math › adds\n\nTests:       1 failed, 2 skipped, 40 passed, 43 total\nTime:        2.5 s\n');
  assert.deepEqual(jest, { runner: 'jest', passed: 40, failed: 1, skipped: 2, durationMs: 2500, failures: ['math › adds'] });
});

test('parses cargo test output and sums result lines', () => {
  const output = [
    '---- codex::tests::parses stdout ----',
    'test result: FAILED. 45 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.34s',
    'test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s',
  ].join('\n');
  assert.deepEqual(testSummary(output), { runner: 'cargo', passed: 50, failed: 1, skipped: 1, durationMs: 2440, failures: ['codex::tests::parses'] });
});

test('parses pytest and go test output', () => {
  const pytest = testSummary('FAILED tests/test_a.py::test_x - assert 1 == 2\n==== 3 failed, 10 passed, 1 skipped in 1.20s ====\n');
  assert.deepEqual(pytest, { runner: 'pytest', passed: 10, failed: 3, skipped: 1, durationMs: 1200, failures: ['tests/test_a.py::test_x'] });
  const go = testSummary('--- FAIL: TestParse (0.00s)\nFAIL\nFAIL\texample.com/a\t0.20s\nok  \texample.com/b\t0.10s\n');
  assert.deepEqual(go, { runner: 'go', passed: 1, failed: 1, skipped: 0, durationMs: 300, failures: ['TestParse'] });
});

test('unknown output has no summary and never throws', () => {
  for (const input of ['', 'hello world', 'Exit code: 0\n', null, undefined, 'x'.repeat(500_000)]) assert.equal(testSummary(input), undefined);
});

test('summary html is escaped and uses only flex-grow inline styles', () => {
  const html = testSummaryHtml({ runner: 'play<wright>', passed: 12, failed: 2, skipped: 1, durationMs: 34500, failures: ['a <b> & "c"'] });
  assert.match(html, /^<div class="tool-test-summary"/);
  assert.match(html, /class="tool-test-pass">12 passed/);
  assert.match(html, /class="tool-test-fail">2 failed/);
  assert.match(html, /class="tool-test-skip">1 skipped/);
  assert.match(html, /<span class="tool-test-meter"[^>]*><span class="tool-test-meter-pass" style="flex-grow:12"><\/span><span class="tool-test-meter-fail" style="flex-grow:2"><\/span><span class="tool-test-meter-skip" style="flex-grow:1"><\/span><\/span>/);
  assert.match(html, /34\.5s/);
  assert.match(html, /a &lt;b&gt; &amp; &quot;c&quot;/);
  assert.match(html, /play&lt;wright&gt;/);
  for (const style of html.matchAll(/style="([^"]*)"/g)) assert.match(style[1], /^flex-grow:\d+$/);
  const clean = testSummaryHtml({ runner: 'cargo', passed: 3, failed: 0, skipped: 0, failures: [] });
  assert.doesNotMatch(clean, /tool-test-fail|tool-test-failures|tool-test-duration/);
});

test('shell functions: definitions are not rows, calls read as the body or as the function', () => {
  const shot = describeShell('U=ABC; s(){ sleep 1.5; xcrun simctl io $U screenshot /tmp/a/$1.png >/dev/null 2>&1; }; s one; s two');
  assert.deepEqual(pick(shot, 'verb', 'label'), { verb: 'Captured simulator screenshot', label: 'simctl io' });
  const tap = describeShell('t(){ axe tap -x $1 -y $2 --udid $U >/dev/null; sleep 0.35; }; t 44 664; t 198 664');
  assert.equal(tap.object, '44 664 · +1 more command');
  assert.deepEqual(pick(tap, 'verb', 'label'), { verb: 'Tapped', label: 'on simulator' });
  assert.equal(describeShell('g() { gh api "repos/$1/contents/$2"; }\ng a/b src/x.rs').verb, 'Called');
  assert.deepEqual(pick(describeShell('function build_all {\n  ./x.sh "$@"\n}\nbuild_all a b'), 'verb', 'label'), { verb: 'Ran', label: 'x.sh' });
  // A body that says nothing useful reads as the function itself.
  assert.deepEqual(pick(describeShell('ps() { return 1; }; ps'), 'verb', 'label', 'object'), { verb: 'Ran', label: 'ps', object: 'shell function' });
  assert.deepEqual(pick(describeShell('q(){ "$@"; }; q a; q b'), 'verb', 'label', 'object'), { verb: 'Ran', label: 'q', object: 'shell function · +1 more command' });
});

test('test brackets, variable programs and array assignments never become chips', () => {
  assert.deepEqual(pick(describeShell('for i in $(seq 1 17); do s=$(gh run view 4 --json status -q .status); [ "$s" = completed ] && break; sleep 30; done'), 'verb', 'label'),
    { verb: 'Viewed', label: 'gh run view' });
  assert.deepEqual(pick(describeShell('[[ -n "$X" ]] || exit 1; npm test'), 'kind', 'label'), { kind: 'test', label: 'npm test' });
  assert.deepEqual(pick(describeShell('[ "$a" = b ]'), 'verb', 'label'), { verb: 'Checked', label: 'condition' });
  assert.deepEqual(pick(describeShell('"$BIN" --version'), 'label', 'object'), { label: '$BIN', object: '' });
  assert.equal(describeShell('${FFMPEG} -i a.mov b.mp4').label, '$FFMPEG');
  assert.equal(describeShell('args=(); args+=(-i a.png); ffmpeg "${args[@]}" out.mp4').label, 'out.mp4');
  assert.equal(describeShell('$(which node) a.js').label, 'shell');
  assert.equal(describeShell('`which node` a.js').label, 'shell');
  // `$(…)` inside double quotes may hold quotes of its own.
  assert.deepEqual(pick(describeShell('for f in *.png; do echo "$f $(python3 -c "print(1)")"; done; ls -la'), 'verb', 'label'), { verb: 'Listed', label: '.' });
});

test('chips never show expansion syntax: braces expand, ${…} and $(…) are tidied, URIs name the file', () => {
  assert.deepEqual(pick(describeShell('cp ../t/{thumb2.html,render.mjs} .'), 'verb', 'label', 'object'), { verb: 'Copied', label: '2 files', object: '→ .' });
  assert.deepEqual(pick(describeShell('wc -l src/{a,b,c}.rs'), 'label', 'object'), { label: 'a.rs', object: '+2 files' });
  assert.equal(describeShell("jq '{a,b}' x.json").label, 'x.json');
  assert.equal(describeShell('ls "{a,b}"').label, '{a,b}');
  assert.equal(describeShell('ffmpeg -i a.mp4 -frames:v 1 f_$(printf %04d $t).jpg').label, 'f_….jpg');
  assert.equal(describeShell('ffmpeg -i a.mp4 -frames:v 1 ${k}_sheet.jpg').label, '$k_sheet.jpg');
  assert.equal(describeShell('sed -n 1,5p ${f%:*}').label, '$f');
  assert.equal(describeShell('sqlite3 -readonly "file:$DB?mode=ro" "select 1"').label, '$DB');
  assert.equal(describeShell('sqlite3 "file:kingcode.sqlite3?mode=ro" "select 1"').label, 'kingcode.sqlite3');
  assert.deepEqual(pick(describeShell('P=$((20000 + RANDOM % 20000)); lsof -i :$P'), 'verb', 'label'), { verb: 'Checked open files', label: 'lsof' });
  assert.deepEqual(pick(describeShell('for s in a b; do f(){ git log -1 "$1"; }; f $s; done'), 'verb', 'label', 'object'), { verb: 'Viewed history', label: 'git log', object: 'a' });
});

test('inline perl scripts and brace lists after a variable prefix', () => {
  assert.deepEqual(pick(describeShell("perl -ne 'print \"$1\\n\" if /x/' a.txt"), 'verb', 'label'), { verb: 'Ran script', label: 'perl' });
  assert.deepEqual(pick(describeShell("perl -i -pe 's/a/b/' a.txt"), 'verb', 'label'), { verb: 'Edited', label: 'a.txt' });
  assert.deepEqual(pick(describeShell("perl -Ilib -e 'print 1'"), 'verb', 'label'), { verb: 'Ran script', label: 'perl' });
  assert.equal(describeShell('cp $W/{a.gb,b.gb} out/').label, '2 files');
});

test('an unknown local program reads as Ran [program] with its arguments as code', () => {
  assert.deepEqual(pick(describeShell('e await p.goto(1)'), 'verb', 'label', 'object', 'mono'), { verb: 'Ran', label: 'e', object: 'await p.goto(1)', mono: true });
  assert.deepEqual(pick(describeShell('./e'), 'verb', 'label', 'object'), { verb: 'Ran', label: 'e', object: '' });
  assert.deepEqual(pick(describeShell('./e run --fast'), 'verb', 'label', 'object', 'mono'), { verb: 'Ran', label: 'e', object: 'run --fast', mono: true });
  assert.equal(describeShell('e "a b" (c)').object, '"a b" (c)');
});

test('simulator subcommands each read with their own verb', () => {
  const sim = command => pick(describeShell(command), 'verb', 'label', 'object');
  assert.deepEqual(sim('xcrun simctl spawn booted log stream'), { verb: 'Spawned on simulator', label: 'simctl spawn', object: 'log stream' });
  assert.deepEqual(sim('xcrun simctl terminate booted com.x.app'), { verb: 'Stopped app on simulator', label: 'simctl terminate', object: 'com.x.app' });
  assert.deepEqual(sim('xcrun simctl launch booted com.x.app'), { verb: 'Launched on simulator', label: 'simctl launch', object: 'com.x.app' });
  assert.equal(describeShell('xcrun simctl launch booted com.x && xcrun simctl terminate booted com.x').object, 'com.x · +1 more command');
  assert.deepEqual(sim('xcrun simctl spawn booted defaults read com.x'), { verb: 'Spawned on simulator', label: 'simctl spawn', object: 'defaults read com.x' });
});

test('a row never carries two +N counts', () => {
  for (const command of ['cat a.md README.md; ls x', 'grep foo a.ts b.ts c.ts; ls', 'ls gen gen2; cat x', 'cat a b c d; npm test; ls', 'chmod 644 a b c; ls', 'docker rm a b; ls']) {
    const object = describeShell(command).object;
    assert.ok((object.match(/\+\d+/g) ?? []).length <= 1, `${command} → ${object}`);
  }
  assert.deepEqual(pick(describeShell('cat README.md b.md; ls x'), 'label', 'object'), { label: 'README.md', object: '+2 more' });
  assert.equal(describeShell('cat README.md b.md').object, '+1 file');
  assert.deepEqual(pick(describeShell('chmod 644 a b c; ls'), 'label', 'object'), { label: 'a', object: '644 · +3 more' });
  assert.deepEqual(pick(describeShell('grep foo a.ts b.ts c.ts; ls'), 'label', 'object'), { label: 'a.ts', object: 'for "foo" in a.ts · +3 more' });
});

test('globs read as files matching the pattern', () => {
  const row = command => pick(describeShell(command), 'verb', 'label', 'object');
  assert.deepEqual(row('ls bench/*.md'), { verb: 'Listed', label: 'files', object: 'matching bench/*.md' });
  assert.deepEqual(row('cat bench/*.md'), { verb: 'Read', label: 'files', object: 'matching bench/*.md' });
  assert.deepEqual(row('wc -l bench/*.md'), { verb: 'Counted lines in', label: 'files', object: 'matching bench/*.md' });
  assert.deepEqual(row('cat a.md'), { verb: 'Read', label: 'a.md', object: '' });
});

test('a scratch delete before reading the same file leads the row', () => {
  assert.deepEqual(pick(describeShell('rm -f /tmp/x.json && cat /tmp/x.json'), 'verb', 'label'), { verb: 'Deleted', label: 'x.json' });
  assert.deepEqual(pick(describeShell('rm -f /tmp/y.json && cat /tmp/x.json'), 'verb', 'label'), { verb: 'Read', label: 'x.json' });
});

// ---------------------------------------------------------------- shapes from real records

test('rg --files lists files, in paths and matching globs or a piped pattern', () => {
  assert.deepEqual(row('rg --files'), { kind: 'list', verb: 'Listed', label: 'files', object: '' });
  assert.deepEqual(row('rg --files src-tauri/src'), { kind: 'list', verb: 'Listed', label: 'files', object: 'in src-tauri/src' });
  assert.deepEqual(row("rg --files -g 'AGENTS.md' -g 'package.json' -g '*.ts'"), { kind: 'list', verb: 'Listed', label: 'files', object: 'matching AGENTS.md +2' });
  assert.deepEqual(row("rg --files src -g '*.ts'"), { kind: 'list', verb: 'Listed', label: 'files', object: 'in src matching *.ts' });
  assert.deepEqual(row("rg --files src-tauri/src | sort | rg 'code.?search|lib\\.rs'"), { kind: 'list', verb: 'Listed', label: 'files', object: 'in src-tauri/src matching code.?search|lib\\.rs' });
  assert.deepEqual(row('rg --files src | grep -i shell | head'), { kind: 'list', verb: 'Listed', label: 'files', object: 'in src matching shell' });
  assert.deepEqual(row('rg --files src tests'), { kind: 'list', verb: 'Listed', label: 'files', object: 'in src +1' });
});

test('[[ … ]] is one test: its && and || never split steps', () => {
  const command = "until [ $SECONDS -ge $end ]; do read -r R st c < <(gh run list -L 1); [[ $st == completed && $c != cancelled ]] && break; sleep 20; done";
  const intent = describeShell(command);
  assert.notEqual(intent.label, '$c');
  assert.doesNotMatch(intent.object, /cancelled \]\]/);
  assert.deepEqual(row('[[ -f a && -n "$b" ]] && npm test'), { kind: 'test', verb: 'Ran tests', label: 'npm test', object: '' });
  assert.equal(describeShell('[[ a < b || -z "$c" ]]').label, 'condition');
});

test('cargo test binaries read as cargo tests with their filter', () => {
  assert.deepEqual(row('target/debug/deps/pandacode_lib-0123456789abcdef tool_images'), { kind: 'test', verb: 'Ran tests', label: 'cargo', object: 'tool_images' });
  assert.deepEqual(row('cd src-tauri && ./pandacode_lib-a1b2c3d4e5f60718 slash_commands --nocapture --test-threads 1'), { kind: 'test', verb: 'Ran tests', label: 'cargo', object: 'slash_commands' });
  assert.deepEqual(row('src-tauri/target/debug/deps/pandacode_lib-a1b2c3d4e5f60718'), { kind: 'test', verb: 'Ran tests', label: 'cargo', object: '' });
});

test('a wait before the real step is noted; a quiet fetch used as a check reads as one', () => {
  assert.deepEqual(row('sleep 45 && tail -n 20 /tmp/x.log'), { kind: 'read', verb: 'Read', label: 'x.log', object: 'last 20 lines · after 45s' });
  assert.deepEqual(row('sleep 2; npx playwright test a.spec.ts'), { kind: 'test', verb: 'Ran tests', label: 'playwright', object: 'a.spec.ts · after 2s' });
  assert.deepEqual(row('sleep 30'), { kind: 'wait', verb: 'Waited', label: '30s', object: '30s' });
  assert.deepEqual(row('if curl -s http://127.0.0.1:1732/health; then echo up; fi'), { kind: 'fetch', verb: 'Checked', label: '127.0.0.1:1732', object: '/health responds' });
  assert.deepEqual(row('curl -sf 127.0.0.1:1732 >/dev/null && echo ok'), { kind: 'fetch', verb: 'Checked', label: '127.0.0.1:1732', object: 'responds' });
  assert.deepEqual(row('curl -s -o /dev/null -w "%{http_code}" http://localhost:1420/'), { kind: 'fetch', verb: 'Checked', label: 'localhost:1420', object: 'responds' });
  assert.deepEqual(row('curl -s http://127.0.0.1:1732/health'), { kind: 'fetch', verb: 'Fetched', label: '127.0.0.1:1732', object: '/health' });
  assert.deepEqual(row('curl -s -X POST -d x http://127.0.0.1:1732/a >/dev/null'), { kind: 'fetch', verb: 'Fetched', label: '127.0.0.1:1732', object: '/a' });
});

test('an opaque command is chipped by its program, never the generic shell', () => {
  const intent = describeShell("lsof -i :1420 | awk '{print $2}' | xargs kill");
  assert.deepEqual(pick(intent, 'verb', 'label', 'raw'), { verb: 'Ran', label: 'lsof', raw: true });
  assert.equal(describeShell("find . -name '*.ts' -exec wc -l {} +").label, 'find');
  assert.equal(describeShell('FOO=1 sudo cat a | bash').label, 'cat');
  assert.equal(describeShell("env | grep -i claude | sed 's/=.*//'").label, 'env');
  assert.equal(describeShell('npm test').raw, undefined);
});

test('one count per row: a file count and a command count merge, never "and 1 more +1 more command"', () => {
  for (const command of ['cat a.ts b.ts; ls', 'sed -n 1,5p a.ts b.ts; git status', 'cat a.ts b.ts c.ts && wc -l d.ts']) {
    const { verb, label, object } = describeShell(command);
    const sentence = `${verb} ${label} ${object}`;
    assert.doesNotMatch(sentence, /and \d+ more/, sentence);
    assert.ok((sentence.match(/\+\d+/g) ?? []).length <= 1, sentence);
  }
  assert.deepEqual(pick(describeShell('cat a.ts b.ts; ls'), 'verb', 'label', 'object'), { verb: 'Read', label: 'a.ts', object: '+2 more' });
});

test('a raw fallback never repeats its program after the chip', () => {
  assert.deepEqual(pick(describeShell('gh api repos/x | python3 -c "import sys"'), 'verb', 'label', 'object', 'raw'),
    { verb: 'Ran', label: 'gh', object: 'api repos/x | python3 -c "import sys"', raw: true });
  assert.deepEqual(pick(describeShell('lsof -ti :1420 | xargs kill'), 'label', 'object'), { label: 'lsof', object: '-ti :1420 | xargs kill' });
  assert.deepEqual(pick(describeShell('/usr/bin/find . -name "*.log" -exec cat {} \\;'), 'label', 'object'), { label: 'find', object: '. -name "*.log" -exec cat {} \\;' });
  for (const command of ['gh run list --json x | python3 -c "import json,sys"', 'cd /x && git log --oneline | tee log.txt', 'sudo lsof -i :80 | xargs kill']) {
    const { label, object } = describeShell(command);
    assert.ok(!object.startsWith(`${label} `) && !object.startsWith(`${label}\n`), `${command} → [${label}] ${object}`);
  }
});

test('with output, the chipped test runner is the one whose summary is in it', () => {
  const cargo = 'running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s\n';
  const node = '# tests 4\n# pass 4\n# fail 0\n# duration_ms 120\n';
  const playwright = 'Running 12 tests\n\n  12 passed (4.2s)\n';
  assert.equal(describeShell('npm test; cargo test', cargo).label, 'cargo test');
  assert.equal(describeShell('cargo test && npm test', node).label, 'npm test');
  assert.equal(describeShell('npx vitest run && npx playwright test', playwright).label, 'playwright');
  assert.equal(describeShell('npm test; cargo test').label, 'npm test');
  // Several runners in the output: the first test step leads and the card shows its own summary label.
  assert.equal(describeShell('npx playwright test; cargo test', `${playwright}\n${cargo}`).label, 'playwright');
  assert.equal(describeShell('git status && cargo test', node).label, 'cargo test');
});
