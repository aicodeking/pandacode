// Destructive-step detection, risks, scripts and later shell-intent rules (split from shell-intent.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell, testSummary, testSummaryHtml } from '../src/shell-intent.ts';
import { readFileSync } from 'node:fs';

const pick = (intent, ...keys) => Object.fromEntries(keys.map(key => [key, intent[key]]));
const ICONS = new Set([...readFileSync('src/dom.ts', 'utf8').matchAll(/^ {2}([a-zA-Z]+): '/gm)].map(m => m[1]));

const danger = command => pick(describeShell(command), 'verb', 'label', 'object', 'destructive');

test('destructive steps are flagged', () => {
  for (const command of ['rm -r a', 'rm -rf src', 'rmdir /opt/docs', "find . -name '*.log' -delete", 'git reset --hard', 'git reset --hard HEAD~2',
    'git clean -fdx', 'git push -f', 'git push --force origin main', 'git push --force-with-lease', 'git push origin +main', 'git push origin :main',
    'git push origin --delete main', 'git branch -D main', 'git branch --delete --force x', 'git tag -d v1', 'git stash drop',
    'git stash clear', 'git checkout -- src/a.ts', 'git checkout .', 'git restore src/a.ts', 'dd if=/dev/zero of=disk.img bs=1m count=1',
    'mkfs.ext4 /dev/sdb1', 'truncate -s 0 app.log', 'shred -u secret.txt', 'kill -9 1234', 'kill -KILL 1234', 'pkill -9 -f vite', 'chmod -R 777 .',
    'chown -R me src', 'docker rm api', 'docker rmi app:latest', 'docker system prune -af', 'cp /dev/null important.txt', ': > app.log', '> app.log',
    'head -n 5 a.txt > a.txt', 'sort a.txt > ./a.txt', 'cat a.txt | sort > a.txt', 'sudo rm -rf /var/x', 'grep -rl foo . | xargs rm',
    "find . -name '*.ts' -exec rm {} \;", 'bash -c "rm -rf lib"', 'x(){ rm -rf "$1"; }; x out']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  for (const command of ['ls', 'cat a.txt', 'git status', 'git push origin main', 'git branch', 'git checkout main', 'git checkout -b topic',
    'git restore --staged a.ts', 'git stash', 'git clean -n', 'kill 1234', 'chmod +x a.sh', 'docker ps', 'cp a b', 'echo hi > notes.txt',
    'echo hi >> a.txt', 'head -n 5 a.txt > b.txt', 'git branch -d topic', 'git branch --delete x', 'git tag v1', 'npm test', 'sleep 1', 'mv a b', '']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('a destructive step leads a compound command', () => {
  assert.deepEqual(danger('cat a.txt && rm -rf lib'), { verb: 'Deleted', label: 'lib', object: '+1 more command', destructive: true });
  assert.deepEqual(pick(describeShell('ls; rm -rf ~'), 'verb', 'label', 'destructive'), { verb: 'Deleted', label: '~', destructive: true });
  assert.deepEqual(danger('git status && git reset --hard'), { verb: 'Hard-reset to', label: 'HEAD', object: '+1 more command', destructive: true });
  assert.deepEqual(danger('git reset --hard HEAD~1'), { verb: 'Hard-reset to', label: 'HEAD~1', object: '', destructive: true });
  assert.deepEqual(danger('git add . && git commit -m x && git push -f'), { verb: 'Force-pushed', label: 'git push', object: '+1 more command', destructive: true });
  assert.deepEqual(danger('npm test || rm -rf vendor'), { verb: 'Deleted', label: 'vendor', object: '+1 more command', destructive: true });
  assert.deepEqual(danger('[ -L docs ] && rm -r docs'), { verb: 'Deleted', label: 'docs', object: '', destructive: true });
  assert.equal(describeShell('cat a.txt && rm -rf lib').steps, 2);
  assert.equal(describeShell('ls | xargs rm').destructive, true);
});

test('destructive verbs say what was lost', () => {
  assert.deepEqual(danger('git branch -D main'), { verb: 'Deleted branch', label: 'main', object: '', destructive: true });
  assert.deepEqual(danger('git stash drop'), { verb: 'Dropped stash', label: 'git stash', object: '', destructive: true });
  assert.equal(describeShell('git stash clear').verb, 'Dropped all stashes');
  assert.deepEqual(danger('git checkout -- .'), { verb: 'Discarded changes in', label: '.', object: '', destructive: true });
  assert.deepEqual(danger('git checkout -- src/a.ts src/b.ts'), { verb: 'Discarded changes in', label: '2 files', object: '', destructive: true });
  assert.equal(describeShell('git restore src/a.ts').verb, 'Discarded changes in');
  assert.deepEqual(danger('git tag -d v1'), { verb: 'Deleted tag', label: 'git tag', object: 'v1', destructive: true });
  assert.deepEqual(danger('git push origin :main'), { verb: 'Deleted remote branch', label: 'git push', object: 'main', destructive: true });
  assert.deepEqual(danger('git push origin --delete main'), { verb: 'Deleted remote branch', label: 'git push', object: 'main', destructive: true });
  assert.deepEqual(danger('git push --force origin main'), { verb: 'Force-pushed', label: 'git push', object: 'origin main', destructive: true });
  assert.deepEqual(danger('head -n 5 a.txt > a.txt'), { verb: 'Overwrote', label: 'a.txt', object: '', destructive: true });
  assert.deepEqual(danger('cp /dev/null important.txt'), { verb: 'Emptied', label: 'important.txt', object: '', destructive: true });
  assert.deepEqual(danger(': > logs/app.log'), { verb: 'Emptied', label: 'app.log', object: '', destructive: true });
  assert.deepEqual(danger('> app.log'), { verb: 'Emptied', label: 'app.log', object: '', destructive: true });
  assert.deepEqual(danger('truncate -s 0 app.log'), { verb: 'Emptied', label: 'app.log', object: '', destructive: true });
  assert.equal(describeShell('git clean -fd').verb, 'Cleaned');
  assert.equal(describeShell('docker system prune -af').verb, 'Cleaned');
  assert.equal(describeShell('shred -u secret.txt').verb, 'Shredded');
  assert.equal(describeShell('mkfs.ext4 /dev/sdb1').verb, 'Formatted');
  assert.deepEqual(pick(describeShell('dd if=/dev/zero of=disk.img bs=1m'), 'verb', 'label'), { verb: 'Overwrote', label: 'disk.img' });
  assert.equal(describeShell('git push origin main').verb, 'Pushed');
  assert.equal(describeShell('git checkout main').verb, 'Switched to');
});

test('wait loops read as waiting for their condition', () => {
  assert.deepEqual(pick(describeShell('until grep -q ready server.log; do sleep 5; done'), 'kind', 'verb', 'label', 'object', 'icon'),
    { kind: 'wait', verb: 'Waited for', label: 'server.log', object: 'to contain "ready"', icon: 'clock' });
  assert.deepEqual(pick(describeShell('while ! curl -sf http://localhost:1420/health; do sleep 1; done'), 'kind', 'verb', 'label', 'object'),
    { kind: 'wait', verb: 'Waited for', label: 'localhost:1420', object: '/health responds' });
  assert.equal(describeShell('until [ -f out/done ]; do sleep 1; done').verb, 'Waited for');
  assert.equal(describeShell('while true; do curl -s http://x.dev/a; sleep 1; done').kind, 'fetch');
  assert.equal(describeShell('while read -r line; do rg "$line" src; done < list.txt').kind, 'search');
  assert.notEqual(describeShell('until false; do sleep 2; done').verb, 'Waited for');
});

test('scripts that clearly edit a file read as edits', () => {
  const py = "python3 - <<'PY'\np='src/x.ts'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nPY";
  assert.deepEqual(pick(describeShell(py), 'kind', 'verb', 'label', 'object', 'icon', 'destructive'),
    { kind: 'file', verb: 'Edited', label: 'x.ts', object: 'with Python', icon: 'edit', destructive: false });
  assert.equal(describeShell("python3 - <<'PY'\nfrom pathlib import Path\nPath('docs/a.md').write_text('x')\nPY").label, 'a.md');
  assert.equal(describeShell("python3 - <<'PY'\nfrom pathlib import Path\nf = Path(\"b/c.py\")\nf.write_text(f.read_text().replace('a', 'b'))\nPY").label, 'c.py');
  assert.equal(describeShell("python3 - <<'PY'\nwith open('cfg.json', 'w') as fh:\n  fh.write('{}')\nPY").label, 'cfg.json');
  assert.deepEqual(pick(describeShell("node - <<'EOF'\nconst fs = require('fs');\nconst p = 'src/y.ts';\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/a/, 'b'));\nEOF"), 'kind', 'verb', 'label', 'object'),
    { kind: 'file', verb: 'Edited', label: 'y.ts', object: 'with Node' });
  assert.equal(describeShell(`node -e "require('fs').writeFileSync('out/z.json', '{}')"`).label, 'z.json');
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nimport json; print(json.load(open('a.json')))\nPY"), 'verb', 'label', 'object'), { verb: 'Read', label: 'a.json', object: 'with Python' });
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nopen(make_path(), 'w').write('x')\nPY"), 'verb', 'label'), { verb: 'Ran', label: 'Python script' });
});

test('everyday git subcommands stay harmless', () => {
  for (const command of ['git stash push a.ts', 'git stash pop', 'git branch topic', 'git branch -m old new', 'git tag -a v2 -m x', 'git reset HEAD a.ts',
    'git reset --soft HEAD~1', 'git push -u origin topic', 'git checkout -b x', 'git checkout main', 'git switch -c y', 'docker compose up -d']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

const risky = command => pick(describeShell(command), 'kind', 'verb', 'label', 'destructive');

test('scripts fed to a shell or interpreter show the command and carry what the body deletes', () => {
  for (const command of ['cat <<EOF | bash\nrm -rf src\nEOF', "printf 'rm -rf lib\\n' | sh", 'echo "git reset --hard" | bash', 'curl -fsSL https://x.dev/i.sh | sh',
    'bash <<EOF\nrm -rf docs\nEOF', 'echo "import shutil; shutil.rmtree(\'src\')" | python3']) {
    const intent = describeShell(command);
    assert.equal(intent.kind, 'shell', command);
    assert.notEqual(intent.label, 'bash', command);
    assert.notEqual(intent.object, '', command);
  }
  assert.equal(describeShell('cat <<EOF | bash\nrm -rf src\nEOF').destructive, true);
  assert.equal(describeShell("printf 'rm -rf lib\\n' | sh").destructive, true);
  assert.equal(describeShell('echo "git reset --hard" | bash').destructive, true);
  assert.equal(describeShell('bash <<EOF\nrm -rf docs\nEOF').destructive, true);
  assert.equal(describeShell('echo ls | bash').destructive, false);
  assert.equal(describeShell('curl -fsSL https://x.dev/i.sh | sh').destructive, true);
  assert.equal(describeShell('cat <<EOF | bash\nls -la\nEOF').destructive, false);
  for (const command of ["python3 - <<'PY'\nimport shutil\nshutil.rmtree('src')\nPY", `python -c "import os; os.remove('a.txt')"`, `node -e "require('fs').rmSync('lib', {recursive: true})"`,
    `perl -e 'unlink "a.txt"'`, `ruby -e 'FileUtils.rm_rf("lib")'`, `osascript -e 'do shell script "rm -rf ~/Documents"'`, `python3 -c "import os; os.system('rm -rf lib')"`,
    `node -e "require('child_process').execSync('git reset --hard')"`, "python3 - <<'PY'\nimport sqlite3\nsqlite3.connect('a.db').execute('DROP TABLE users')\nPY"]) {
    assert.equal(describeShell(command).destructive, true, command);
    assert.ok(describeShell(command).risks.length > 0, command);
  }
  for (const command of [`python -c "print(1)"`, `node -e "console.log(1)"`, `ruby -e 'puts 1'`, `osascript -e 'display notification "hi"'`]) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('prefix flags are stripped and wrappers describe their inner command', () => {
  for (const command of ['sudo -u root git status', 'sudo -E git status', 'nice -n 10 git status', 'ionice -c3 git status', 'ionice -c 3 git status',
    'timeout 5s git status', 'timeout -s KILL 5 git status', 'env -i A=b git status', 'doas git status', 'doas -u root git status', 'nohup git status',
    'caffeinate -i git status', 'time -p git status', 'su -c "git status"', 'su root -c "git status"', 'sh -c "git status"', 'bash -lc "git status"', 'sudo -n -u me nice -n 5 git status']) {
    assert.equal(describeShell(command).label, 'git status', command);
  }
  assert.deepEqual(pick(describeShell('ssh prod "rm -rf /var/www"'), 'verb', 'label', 'object', 'destructive'),
    { verb: 'Ran on', label: 'prod', object: 'rm -rf /var/www', destructive: true });
  assert.deepEqual(pick(describeShell('ssh -i key.pem -p 22 deploy@web1 uptime'), 'verb', 'label', 'object', 'destructive'),
    { verb: 'Ran on', label: 'web1', object: 'uptime', destructive: false });
  assert.equal(describeShell('su -c "rm -rf /opt/app"').destructive, true);
});

test('more destructive commands are flagged', () => {
  const cases = [
    ['rsync -a --delete src/ backup/', 'Synced (deleting extras)', 'src'], ['rsync -a --delete-after a/ b/', 'Synced (deleting extras)', 'a'],
    ['git checkout -f main', 'Discarded changes in', 'working tree'], ['git switch -f main', 'Discarded changes in', 'working tree'],
    ['git switch --discard-changes main', 'Discarded changes in', 'working tree'], ['git rm a.ts', 'Deleted from git', 'a.ts'],
    ['git push --mirror backup', 'Force-pushed', 'git push'], ['git push --force=origin/main', 'Force-pushed', 'git push'],
    ['mv secrets.txt /dev/null', 'Deleted', 'secrets.txt'], ['git reset --merge', 'Reset to', 'HEAD'], ['git reset --keep HEAD~1', 'Reset to', 'HEAD~1'],
    ['git filter-branch --tree-filter x HEAD', 'Rewrote history', 'git filter-branch'], ['git filter-repo --path a', 'Rewrote history', 'git filter-repo'],
    ['git update-ref -d refs/heads/x', 'Deleted ref', 'git update-ref'], ['git reflog expire --expire=now --all', 'Expired reflog', 'git reflog'],
    ['git gc --prune=now', 'Pruned', 'git gc'], ['git worktree remove --force ../wt', 'Removed worktree', 'wt'], ['git branch -f main HEAD~3', 'Reset', 'git branch'],
    ['crontab -r', 'Deleted', 'crontab'], ['rimraf src', 'Deleted', 'src'], ['npx rimraf lib', 'Deleted', 'lib'], ['diskutil eraseDisk APFS X disk4', 'Erased', 'disk4'],
    ['kubectl delete pod api', 'Deleted', 'pod api'], ['terraform destroy -auto-approve', 'Destroyed', 'terraform'],
    ['aws s3 rm s3://bucket/dir --recursive', 'Deleted', 'bucket'], ['aws s3 rb s3://bucket --force', 'Deleted', 'bucket'],
    ['gh repo delete me/app --yes', 'Deleted', 'gh repo delete'], ['gh release delete v1', 'Deleted', 'gh release delete'],
    ['sqlite3 app.db "DROP TABLE users"', 'Changed database', 'app.db'], ['psql -d shop -c "DELETE FROM orders"', 'Changed database', 'shop'],
    ['mysql -D shop -e "TRUNCATE orders"', 'Changed database', 'shop'], ["sqlite3 app.db <<'SQL'\nDELETE FROM t;\nSQL", 'Changed database', 'app.db'],
  ];
  for (const [command, verb, label] of cases) {
    assert.deepEqual(pick(describeShell(command), 'verb', 'label', 'destructive'), { verb, label, destructive: true }, command);
    assert.ok(describeShell(command).risks.length >= 1, command);
  }
  assert.equal(describeShell('rsync -a --delete src/ backup/').object, '→ backup');
  for (const command of ['echo $(rm -rf src)', 'ls `rm -rf lib`', 'diff <(rm -rf lib) b', 'x=$(git reset --hard)']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  for (const command of ['rsync -a src/ backup/', 'git rm --cached a.ts', 'git worktree remove ../wt', 'git branch main', 'crontab -l', 'kubectl get pods',
    'terraform plan', 'aws s3 ls s3://b', 'gh release view v1', 'sqlite3 app.db "select * from t"', 'echo $(git status)', 'git gc', 'mv a.txt b.txt']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('risks list every destructive step, highest severity first, and the row leads with it', () => {
  const intent = describeShell('rm ~/a.txt && git checkout -- src/a.ts && rm -rf lib && git push -f');
  assert.equal(intent.risks.length, 4);
  assert.deepEqual(intent.risks, ['Rewrites remote history: git push -f', 'Deletes files: rm -rf lib', 'Discards uncommitted changes: git checkout -- src/a.ts', 'Deletes files: rm ~/a.txt']);
  assert.equal(intent.verb, 'Force-pushed');
  assert.deepEqual(describeShell('git status').risks, []);
  assert.deepEqual(describeShell('').risks, []);
  const root = describeShell('rm -rf lib; rm -rf ~');
  assert.deepEqual(pick(root, 'verb', 'label'), { verb: 'Deleted', label: '~' });
  assert.equal(describeShell('rm -rf src && git reset --hard').verb, 'Hard-reset to');
  assert.equal(describeShell('cat <<EOF | bash\nrm a.txt\nrm -rf ..\nEOF').risks[0], 'Deletes files: rm -rf ..');
  assert.equal(describeShell('git checkout . && rm -rf lib').verb, 'Discarded changes in');
});

test('deleting disposable scratch is not destructive', () => {
  for (const command of ['rm -rf /tmp/x', 'rm -f /private/tmp/a.png', 'rm -rf "$TMPDIR/build-1"', 'rm -rf ${TMPDIR}/x', 'T=$(mktemp -d); cp a $T; rm -rf "$T"',
    'rm -rf dist', 'rm -rf build/ out', 'rm -rf src-tauri/target', 'rm -rf node_modules', 'rm -rf .cache .next coverage', 'rm -rf test-results playwright-report',
    'find . -name __pycache__ | xargs rm -rf', 'rm -f *.pyc', 'rm .DS_Store', 'rm -rf dist/*', 'npm test || rm -rf node_modules']) {
    assert.equal(describeShell(command).destructive, false, command);
    assert.deepEqual(describeShell(command).risks, [], command);
  }
  for (const command of ['rm -rf dist ~', 'rm -rf /tmp/x /', 'rm -rf build ..', 'rm -rf dist *', 'rm -rf "$OUT/dist" /tmp/a', 'rm -rf /tmp/../etc']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  assert.deepEqual(pick(describeShell('rm -rf dist && npm run build'), 'verb', 'label', 'object'), { verb: 'Built', label: 'npm run build', object: '+1 more command' });
  assert.deepEqual(pick(describeShell('npm test || rm -rf node_modules'), 'verb', 'label', 'object'), { verb: 'Ran tests', label: 'npm test', object: '+1 more command' });
  assert.deepEqual(pick(describeShell('rm -rf /tmp/shots'), 'verb', 'label', 'destructive'), { verb: 'Deleted', label: 'shots', destructive: false });
});

test('inline scripts say what they read, query or fetch', () => {
  assert.deepEqual(pick(describeShell(`python3 -c "import json; print(json.load(open('cfg/a.json'))['x'])"`), 'kind', 'verb', 'label', 'object'),
    { kind: 'read', verb: 'Read', label: 'a.json', object: 'with Python' });
  assert.deepEqual(pick(describeShell(`node -e "console.log(require('fs').readFileSync('package.json','utf8'))"`), 'verb', 'label', 'object'),
    { verb: 'Read', label: 'package.json', object: 'with Node' });
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('data/app.db')\nprint(c.execute('select 1').fetchall())\nPY"), 'kind', 'verb', 'label', 'object'),
    { kind: 'db', verb: 'Queried', label: 'app.db', object: 'with Python' });
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nimport requests\nprint(requests.get('https://api.example.com/v1/x').json())\nPY"), 'kind', 'verb', 'label', 'object'),
    { kind: 'fetch', verb: 'Fetched', label: 'api.example.com', object: 'with Python' });
  assert.deepEqual(pick(describeShell(`python3 -c "import urllib.request as u; print(u.urlopen('http://localhost:1420/').status)"`), 'verb', 'label'),
    { verb: 'Fetched', label: 'localhost:1420' });
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'status'])\nPY"), 'verb', 'label', 'object'),
    { verb: 'Ran', label: 'Python script', object: '' });
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\n# compute\nimport math\n\nprint(math.pi * 2)\nPY"), 'verb', 'label', 'object'),
    { verb: 'Ran', label: 'Python script', object: '' });
  assert.equal(describeShell(`node -e "const x = 1; console.log(x + 1)"`).object, 'const x = 1');
});

test('noise beside work, worktrees, tmux, formatters, linters, binaries, scripts and axe', () => {
  assert.deepEqual(pick(describeShell('pwd && date && whoami && uname -a && clear && git status'), 'label', 'steps'), { label: 'git status', steps: 1 });
  assert.equal(describeShell('pwd').verb, 'Ran');
  const rows = [
    ['git worktree list', 'Listed worktrees', 'git worktree'], ['git worktree add ../wt -b x', 'Added worktree', 'wt'], ['git worktree remove ../wt', 'Removed worktree', 'wt'],
    ['tmux capture-pane -p -t dev', 'Viewed', 'tmux pane'], ['tmux send-keys -t dev "npm test" Enter', 'Sent keys to', 'tmux dev'], ['tmux new-session -d -s dev', 'Started', 'tmux session'],
    ['npx prettier --write src', 'Formatted', 'prettier'], ['black app.py', 'Formatted', 'black'], ['cargo fmt', 'Formatted', 'cargo fmt'], ['gofmt -w .', 'Formatted', 'gofmt'],
    ['ruff format .', 'Formatted', 'ruff'], ['shellcheck x.sh', 'Linted', 'shellcheck'], ['flake8 app', 'Linted', 'flake8'], ['golangci-lint run', 'Linted', 'golangci-lint'],
    ['strings app.bin', 'Inspected binary', 'app.bin'], ['file a.out', 'Inspected binary', 'a.out'], ['otool -L /usr/bin/x', 'Inspected binary', 'x'],
    ['xxd img.png', 'Inspected binary', 'img.png'], ['hexdump -C a.bin', 'Inspected binary', 'a.bin'], ['bash scripts/x.sh a', 'Ran', 'x.sh'], ['./deploy.sh', 'Ran', 'deploy.sh'],
    ['sh ./build.sh', 'Ran', 'build.sh'], ['npx axe http://localhost:1420', 'Ran accessibility check', 'localhost:1420'],
  ];
  for (const [command, verb, label] of rows) assert.deepEqual(pick(describeShell(command), 'verb', 'label'), { verb, label }, command);
  assert.equal(describeShell('prettier --check src').verb, 'Checked');
});

test('literal variables are substituted and numbered reads read as ranges', () => {
  assert.deepEqual(pick(describeShell('F=src/a.ts; sed -n 1,5p $F'), 'verb', 'label', 'object'), { verb: 'Read', label: 'a.ts', object: 'lines 1–5' });
  assert.equal(describeShell('export D=src/scenes && ls "$D"').label, 'scenes');
  assert.equal(describeShell('F=${X}/a.ts; cat $F').label, '$F');
  assert.deepEqual(pick(describeShell(`grep -n "" src/f.ts | sed -n '9,14p'`), 'verb', 'label', 'object'), { verb: 'Read', label: 'f.ts', object: 'lines 9–14' });
  assert.deepEqual(pick(describeShell('cat a.ts | head -5'), 'verb', 'label', 'object'), { verb: 'Read', label: 'a.ts', object: 'lines 1–5' });
  assert.deepEqual(pick(describeShell('nl -ba a.ts | sed -n 20,40p'), 'verb', 'label', 'object'), { verb: 'Read', label: 'a.ts', object: 'lines 20–40' });
  assert.deepEqual(pick(describeShell('sed -n 1,50p a.ts; nl -ba b.ts | sed -n 1,9p; cat c.ts; head -20 d.ts'), 'verb', 'label', 'object', 'steps'),
    { verb: 'Read', label: 'a.ts', object: '+3 files', steps: 4 });
  assert.equal(describeShell(`grep -n '"name"' package.json`).object, `for '"name"' in package.json`);
  assert.doesNotMatch(describeShell(`rg 'say "hi"' src`).object, /""/);
});

test('describeShell never throws on random input', () => {
  const alphabet = ['rm', '-rf', ' ', '|', 'bash', '"', "'", '$(', ')', '`', '<<EOF\n', '\nEOF', ';', '&&', 'ssh', 'sudo', '-u', 'x=', '$x', '/', '~', 'python3', '-c', '{', '}', '(', '\\', 'git', 'push', '-f', 'sed', '-n', '1,5p', '<(', '>'];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 2000; i++) {
    const length = next() % 24;
    const command = Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
    const intent = describeShell(command);
    assert.ok(Array.isArray(intent.risks), command);
    assert.equal(typeof intent.verb, 'string', command);
  }
  assert.ok(describeShell('bash -c "'.repeat(50)).verb);
  assert.ok(describeShell('$('.repeat(5000)).verb);
});

// ---------------------------------------------------------------- scratch rules, Codex heredocs, guards

const shellRow = (command, output) => pick(describeShell(command, output), 'verb', 'label', 'object', 'destructive');

test('Codex -lc wrappers unwrap fully: heredocs, pipes and risks read as the plain command', () => {
  // Exact Codex shapes: shlex-style double quoting (`\"`, `\\`, `\$`), sometimes with the recorded working directory.
  const py = "/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\np = Path(\\\"src/a.ts\\\")\np.write_text(p.read_text().replace(\\\"a\\\", \\\"b\\\"))\nPY\"";
  assert.deepEqual(shellRow(py), { verb: 'Edited', label: 'a.ts', object: 'with Python', destructive: false });
  assert.deepEqual(shellRow(py + '\nWorking directory: /Users/me/repo'), { verb: 'Edited', label: 'a.ts', object: 'with Python', destructive: false });
  const plain = "python3 - <<'PY'\nfrom pathlib import Path\np = Path(\"src/a.ts\")\np.write_text(p.read_text().replace(\"a\", \"b\"))\nPY";
  assert.deepEqual(shellRow(py), shellRow(plain));
  const js = "/bin/bash -lc \"node - <<'JS'\nconst fs = require('fs');\nconst p = 'src/y.ts';\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\\\\n/g, \\\"\\\\n\\\"));\nJS\"";
  assert.deepEqual(shellRow(js), { verb: 'Edited', label: 'y.ts', object: 'with Node', destructive: false });
  const rmtree = "bash -lc \"python3 - <<'PY'\nimport shutil\nshutil.rmtree('src')\nPY\"";
  assert.equal(describeShell(rmtree).destructive, true);
  assert.equal(describeShell("/bin/zsh -lc \"cat <<'EOF' | bash\nrm -rf src\nEOF\"").destructive, true);
  assert.equal(describeShell('/bin/zsh -lc "rm -rf src | tee log"').destructive, true);
  assert.equal(describeShell('/bin/zsh -lc "echo \\"\\$HOME\\" && rm -rf \\"\\$(pwd)\\""').destructive, true);
  assert.equal(describeShell('/bin/zsh -lc "git status --short"\nWorking directory: /repo').steps, 1);
});

test('scratch is only tmp for absolute and home paths; artefact names only for relative ones', () => {
  for (const command of ['rm -rf ~/build', 'rm -rf ~/Documents/out', 'rm -rf /Users/me/projects/target', 'rm -rf $HOME/dist',
    'rm -rf "$(pwd)"', 'rm -rf $(git rev-parse --show-toplevel)', 'rm -rf "$PWD"', 'TMPDIR=~ rm -rf $TMPDIR/x', 'export TMPDIR=$HOME; rm -rf "$TMPDIR/x"']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  for (const command of ['rm -rf "$(pwd)"', 'rm -rf $(git rev-parse --show-toplevel)', 'rm -rf "$PWD"']) {
    assert.equal(describeShell(`${command} && git reset --hard`).risks[0], `Deletes files: ${command}`, command);
  }
  for (const command of ['rm -rf /tmp/x', 'rm -rf /private/tmp/x', 'rm -rf /var/folders/ab/T/x', 'rm -rf "$TMPDIR/x"', 'TMPDIR=/tmp/me rm -rf $TMPDIR/x',
    'rm -rf dist', 'rm -rf src-tauri/target', 'rm -rf ./node_modules/.cache']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('relative paths resolve against the last literal cd', () => {
  assert.equal(describeShell('cd /tmp/x && rm -rf f *.jpg').destructive, false);
  assert.equal(describeShell('cd /tmp/x && rm -rf *').destructive, false);
  assert.equal(describeShell('cd /Users/me/proj && rm -rf src').destructive, true);
  assert.equal(describeShell('cd /tmp/x && cd /Users/me && rm -rf f').destructive, true);
  assert.equal(describeShell('cd "$X" && rm -rf f').destructive, true);
  assert.deepEqual(describeShell('(cd /tmp/x && rm -rf f); rm -rf g').risks, ['Deletes files: rm -rf g']);
  assert.deepEqual(describeShell('F=~/old; rm -rf $F').risks, ['Deletes files: rm -rf ~/old']);
  assert.deepEqual(pick(describeShell('cd "/Users/me/proj" && pwd && ls -la'), 'verb', 'label', 'object'), { verb: 'Listed', label: 'proj', object: '' });
});

test('wrappers that run their arguments carry what those delete', () => {
  for (const command of ['eval "rm -rf src"', 'watch rm -rf src', 'watch -n 5 "rm -rf src"', 'xargs rm -rf < list', 'parallel rm -r ::: a b',
    'xcrun simctl erase all', 'shutdown -h now', 'sudo reboot', 'halt', 'npm unpublish my-pkg', 'cat /dev/null > notes.txt', 'tee notes.txt < /dev/null']) {
    assert.equal(describeShell(command).destructive, true, command);
    assert.ok(describeShell(command).risks.length >= 1, command);
  }
  assert.deepEqual(pick(describeShell('eval "rm -rf src"'), 'verb', 'label'), { verb: 'Deleted', label: 'src' });
  assert.deepEqual(pick(describeShell('parallel rm -r ::: a b'), 'verb', 'label'), { verb: 'Deleted', label: '2 folders' });
  assert.deepEqual(pick(describeShell('cat /dev/null > notes.txt'), 'verb', 'label'), { verb: 'Emptied', label: 'notes.txt' });
  assert.deepEqual(pick(describeShell('tee notes.txt < /dev/null'), 'verb', 'label'), { verb: 'Emptied', label: 'notes.txt' });
  assert.deepEqual(pick(describeShell('reboot'), 'verb', 'label'), { verb: 'Rebooted', label: 'machine' });
  assert.deepEqual(pick(describeShell('npm unpublish my-pkg'), 'verb', 'label'), { verb: 'Unpublished', label: 'my-pkg' });
  for (const command of ['eval "ls -la"', 'watch -n 1 git status', 'shutdown -c', 'tee notes.txt', 'cat /dev/null > /tmp/x.log', 'xargs grep foo < list']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('reads, polite stops and help are not alarms', () => {
  assert.deepEqual(shellRow('dd if=disk.img bs=1m count=1'), { verb: 'Read', label: 'disk.img', object: '', destructive: false });
  assert.equal(describeShell('dd if=/dev/zero of=disk.img bs=1m').destructive, true);
  assert.deepEqual(shellRow('pkill -f vite'), { verb: 'Stopped processes matching', label: 'vite', object: '', destructive: false });
  assert.deepEqual(shellRow('killall node'), { verb: 'Stopped processes matching', label: 'node', object: '', destructive: false });
  assert.equal(describeShell('pkill -9 node').destructive, true);
  assert.equal(describeShell('killall -KILL node').destructive, true);
  assert.deepEqual(shellRow('git push --help'), { verb: 'Showed help for', label: 'git push', object: '', destructive: false });
  assert.deepEqual(shellRow('git reset --hard -h'), { verb: 'Showed help for', label: 'git reset', object: '', destructive: false });
  assert.deepEqual(shellRow('rm -h'), { verb: 'Showed help for', label: 'rm', object: '', destructive: false });
  assert.deepEqual(shellRow('rm -rf src --help'), { verb: 'Showed help for', label: 'rm', object: '', destructive: false });
  assert.deepEqual(shellRow('node --version'), { verb: 'Checked version of', label: 'node', object: '', destructive: false });
  assert.equal(describeShell('ls -h').verb, 'Listed');
  assert.equal(describeShell('df -h').verb, 'Checked disk usage');
  assert.equal(describeShell('shutdown -h now').destructive, true);
});

test('guards are noise and loop variables never become chips', () => {
  assert.deepEqual(shellRow('[ -f a ] && cargo build'), { verb: 'Built', label: 'cargo build', object: '', destructive: false });
  assert.deepEqual(shellRow('test -f Cargo.toml && cargo build'), { verb: 'Built', label: 'cargo build', object: '', destructive: false });
  assert.equal(describeShell('[ ! -e out.mp4 ] && npx remotion render').label, 'remotion');
  assert.equal(describeShell('[ -f a ]').verb, 'Checked');
  assert.deepEqual(shellRow('for p in a.ts b.ts c.ts; do cat $p; done'), { verb: 'Read', label: 'a.ts', object: '+2 files', destructive: false });
  assert.deepEqual(shellRow('for f in *.png; do sips -Z 100 "$f"; done').label.includes('$'), false);
  const unknown = describeShell('for p in $(ls); do cat "$p"; done');
  assert.doesNotMatch(unknown.label, /\$/);
  assert.equal(unknown.verb, 'Ran');
  assert.doesNotMatch(describeShell('while read -r f; do rm "$f"; done < list').label, /\$/);
  assert.deepEqual(describeShell('for f in a b; do rm -rf "$f"; done').risks, ['Deletes files: rm -rf "$f"']);
  assert.equal(describeShell('for p in $(ls); do cat $p; done').object, 'cat $p');
});

test('exactly one +N more', () => {
  const intent = describeShell('ls gen gen2; cat x');
  assert.equal((intent.object.match(/\+\d+ more/g) ?? []).length, 1, intent.object);
  assert.equal(intent.object, '+2 more');
});

test('risks read as commands with full paths and the headline never repeats its verb', () => {
  assert.deepEqual(describeShell('git reset --hard origin/main').risks, ['Discards uncommitted changes: git reset --hard origin/main']);
  assert.deepEqual(describeShell('rm -rf ~/Library/Caches/foo').risks, ['Deletes files: rm -rf ~/Library/Caches/foo']);
  const both = describeShell('git status && rm -rf ~/Library/Caches/foo && git reset --hard origin/main');
  assert.deepEqual(both.risks, ['Deletes files: rm -rf ~/Library/Caches/foo', 'Discards uncommitted changes: git reset --hard origin/main']);
  assert.equal(describeShell('git reset --hard origin/main && rm -rf /Users/me/old').risks.length, 2);
  assert.equal(describeShell('rm -rf /Users/me/old && git reset --hard').verb, 'Deleted');
  const reset = describeShell('git reset --hard origin/main');
  assert.deepEqual(pick(reset, 'verb', 'label', 'object', 'mono'), { verb: 'Hard-reset to', label: 'origin/main', object: '', mono: false });
  assert.deepEqual(pick(describeShell('git reset --hard'), 'verb', 'label'), { verb: 'Hard-reset to', label: 'HEAD' });
  assert.deepEqual(pick(describeShell('git reset --keep HEAD~1'), 'verb', 'label', 'object', 'mono'), { verb: 'Reset to', label: 'HEAD~1', object: '(keep)', mono: false });
  assert.deepEqual(describeShell('rm -rf "My Dir"').risks, ['Deletes files: rm -rf "My Dir"']);
});

test('a test step with a summary leads its compound', () => {
  const output = 'Running 12 tests\n\n  12 passed (4.2s)\n';
  assert.deepEqual(pick(describeShell('cargo build && npx playwright test', output), 'verb', 'label'), { verb: 'Ran tests', label: 'playwright' });
  assert.equal(describeShell('cargo build && npx playwright test').verb, 'Ran tests');
  assert.equal(describeShell('cargo build && npx playwright test', 'Compiling x').verb, 'Ran tests');
});

test('only live substitutions run: single quotes and escapes are literal', () => {
  for (const command of [`echo '$(rm -rf ~)'`, 'git commit -m "drop \\`rm -rf ~\\` hint"', 'gh issue comment 1 --body "(\\`shutdown\\`, zero idle)"',
    `echo "\\$(rm -rf ~)"`, `printf '%s' "\`echo hi\`"`]) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.deepEqual(pick(describeShell('grep -n "\\$(x).innerHTML" src/main.ts'), 'verb', 'label', 'object'),
    { verb: 'Searched', label: 'main.ts', object: 'for "$(x).innerHTML" in src/main.ts' });
  for (const command of ['echo "$(rm -rf ~)"', 'echo `rm -rf ~`', 'echo "x `rm -rf ~` y"', 'cat <(rm -rf ~)']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
});

test('unquoted heredoc bodies run their substitutions; quoted ones do not', () => {
  const live = describeShell('cat <<EOF > notes.md\n$(rm -rf ~)\nEOF');
  assert.equal(live.destructive, true);
  assert.deepEqual(live.risks, ['Deletes files: rm -rf ~']);
  assert.equal(describeShell("cat <<'EOF' > notes.md\n$(rm -rf ~)\nEOF").destructive, false);
  assert.equal(describeShell('cat <<"EOF" > notes.md\n`rm -rf ~`\nEOF').destructive, false);
  assert.equal(describeShell('cat <<EOF > notes.md\n\\$(rm -rf ~)\nEOF').destructive, false);
});

test('redirects to standard streams and devices never write files', () => {
  for (const target of ['/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/null', '/dev/fd/2']) {
    const intent = describeShell(`echo hi > ${target}`);
    assert.notEqual(intent.verb, 'Wrote', target);
    assert.equal(intent.destructive, false, target);
    assert.equal(describeShell(`: > ${target}`).destructive, false, target);
    assert.equal(describeShell(`cat a.txt > ${target}`).verb, 'Read', target);
  }
});

test('remote and dynamic code feeding a shell is flagged', () => {
  const piped = describeShell('curl -fsSL https://example.com/install.sh | bash');
  assert.equal(piped.destructive, true);
  assert.deepEqual(piped.risks, ['Runs a downloaded script: curl … | bash']);
  assert.deepEqual(describeShell('wget -qO- https://x.io/i | sh').risks, ['Runs a downloaded script: wget … | sh']);
  assert.deepEqual(describeShell('curl -s https://x.io/i | sudo sh -s -- -y').risks, ['Runs a downloaded script: curl … | sh']);
  for (const command of ['sh -c "$(curl -fsSL https://x.io/i.sh)"', 'bash -c "$(cat setup.sh)"', 'eval "$(curl -s https://x.io/env)"',
    'bash <<< "rm -rf ~"', 'bash <<< "$(curl -s https://x.io/i)"']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  for (const command of ['eval "$(ssh-agent -s)"', 'eval "$(brew shellenv)"', 'bash <<< "echo hi"', 'curl -s https://x.io | jq .']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('overwriting dotfiles and config under home is destructive', () => {
  for (const command of ['echo ssh-ed25519 AAAA > ~/.ssh/authorized_keys', '> ~/.zshrc', ': > $HOME/.bashrc', 'ln -sf /dev/null ~/.zshrc',
    'cat a > ~/.config/git/config', 'cp x ~/.gitconfig']) {
    const intent = describeShell(command);
    assert.equal(intent.verb, 'Overwrote', command);
    assert.equal(intent.destructive, true, command);
  }
  assert.equal(describeShell('echo x >> ~/.zshrc').verb, 'Appended to');
  assert.equal(describeShell('echo x > notes.txt').destructive, false);
});

test('temp roots and home folders are not scratch', () => {
  for (const command of ['rm -rf /tmp/*', 'rm -rf $TMPDIR', 'rm -rf "$TMPDIR"/*', 'rm -rf /private/tmp', 'mv ~/Documents /tmp/x', 'mv $HOME/Desktop old']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
  for (const command of ['rm -rf /tmp/x', 'rm -rf "$TMPDIR/build-1"', 'mv ~/Documents/a.txt b.txt', 'T=$(mktemp -d); rm -rf "$T"']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('in-place edits of several files say how many', () => {
  assert.deepEqual(pick(describeShell("perl -pi -e 's/a/b/g' src/a.ts src/b.ts src/c.ts"), 'verb', 'label', 'object'), { verb: 'Edited', label: '3 files', object: 'in place' });
  assert.deepEqual(pick(describeShell("sed -i '' 's/a/b/' src/a.ts src/b.ts"), 'verb', 'label', 'object'), { verb: 'Edited', label: '2 files', object: 'in place' });
  assert.deepEqual(pick(describeShell("sed -i 's/a/b/' src/*.ts"), 'verb', 'label', 'object'), { verb: 'Edited', label: '*.ts', object: 'in place' });
  assert.deepEqual(pick(describeShell("perl -pi -e 's/a/b/' a.ts"), 'verb', 'label'), { verb: 'Edited', label: 'a.ts' });
  assert.deepEqual(pick(describeShell("sed -i '' 's/a/b/' src/a.ts"), 'verb', 'label', 'object'), { verb: 'Edited', label: 'a.ts', object: '' });
});

test('plain deletes of named relative files are not alarms', () => {
  for (const command of ['rm a.txt', 'rm -f src/old.ts b.ts', 'rmdir docs', 'unlink x.lock', 'cd /Users/me/proj; rm a.txt', 'cd /Users/me && rm -f notes.md']) {
    const intent = describeShell(command);
    assert.equal(intent.verb, 'Deleted', command);
    assert.equal(intent.destructive, false, command);
  }
  assert.deepEqual(pick(describeShell('rm a.txt'), 'verb', 'label', 'steps'), pick(describeShell('cd /x; rm a.txt'), 'verb', 'label', 'steps'));
  for (const command of ['rm -r docs', 'rm *.ts', 'rm ../a.txt', 'rm /etc/hosts', 'rm ~/notes.txt', 'rm "$f"', 'rm -rf src', 'rm -f src/*.bak', 'shred a.txt']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
});

test('Codex apply_patch heredocs read as file edits', () => {
  const patch = (body) => `/bin/zsh -lc "apply_patch <<'PATCH'\n*** Begin Patch\n${body}*** End Patch\nPATCH"`;
  assert.deepEqual(pick(describeShell(patch('*** Update File: src/x.ts\n@@\n-a\n+b\n')), 'kind', 'verb', 'label', 'object', 'destructive'),
    { kind: 'file', verb: 'Edited', label: 'x.ts', object: '', destructive: false });
  assert.deepEqual(pick(describeShell(patch('*** Add File: docs/new.md\n+hi\n*** Update File: a.ts\n@@\n+x\n*** Update File: b.ts\n@@\n+y\n')), 'verb', 'label', 'object'),
    { verb: 'Created', label: 'new.md', object: '+2 more files' });
  const deleted = describeShell(patch('*** Delete File: src/old.ts\n'));
  assert.deepEqual(pick(deleted, 'verb', 'label', 'destructive'), { verb: 'Deleted', label: 'old.ts', destructive: false });
  assert.equal(describeShell("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: y.rs\n@@\n+z\n*** End Patch\nEOF").label, 'y.rs');
});

test('more handlers: git grep, awk, sips, npm init and view', () => {
  assert.deepEqual(pick(describeShell('git grep -n describeShell'), 'verb', 'label', 'object'), { verb: 'Searched', label: 'git grep', object: 'for "describeShell"' });
  assert.deepEqual(pick(describeShell('git grep foo -- src'), 'verb', 'label'), { verb: 'Searched', label: 'src' });
  assert.deepEqual(pick(describeShell("awk '{print $1}' data.csv"), 'verb', 'label', 'object'), { verb: 'Processed', label: 'data.csv', object: 'with awk' });
  assert.deepEqual(pick(describeShell('sips -Z 800 shot.png'), 'verb', 'label'), { verb: 'Resized image', label: 'shot.png' });
  assert.deepEqual(pick(describeShell('sips --resampleWidth 400 a.png --out b.png'), 'verb', 'label'), { verb: 'Resized image', label: 'a.png' });
  assert.deepEqual(pick(describeShell('npm init -y'), 'verb', 'label'), { verb: 'Initialized', label: 'package' });
  assert.deepEqual(pick(describeShell('npm view react version'), 'verb', 'label'), { verb: 'Looked up', label: 'react' });
  assert.equal(describeShell('grep -n "foo\\|bar" a.ts').object, 'for "foo|bar" in a.ts');
});

test('steps that write an image name it', () => {
  const image = (command) => describeShell(command).producedImage;
  assert.equal(image('screencapture -x /tmp/shot.png'), '/tmp/shot.png');
  assert.equal(image('ffmpeg -y -i in.mp4 -frames:v 1 out.png'), undefined);
  assert.equal(image('sips -Z 800 a.png --out /tmp/b.png'), '/tmp/b.png');
  assert.equal(image('sips -Z 800 /tmp/a.png'), '/tmp/a.png');
  assert.equal(image('cd /tmp && magick in.svg -resize 50% out.webp'), '/tmp/out.webp');
  assert.equal(image('convert a.png /tmp/b.jpg'), '/tmp/b.jpg');
  assert.equal(image('rsvg-convert -w 512 -o /tmp/icon.png icon.svg'), '/tmp/icon.png');
  assert.equal(image('chrome --headless --screenshot=/tmp/page.png https://x.io'), '/tmp/page.png');
  assert.equal(image('cd /tmp/s && screencapture shot.png'), '/tmp/s/shot.png');
  assert.equal(image('xcrun simctl io booted screenshot /tmp/sim.png'), '/tmp/sim.png');
  assert.equal(image('ffmpeg -i in.mov out.mp4'), undefined);
  assert.equal(image('screencapture "$OUT"'), undefined);
  assert.equal(image('ls'), undefined);
});

test('a test step leads its compound; Python that only writes a file wrote it', () => {
  assert.deepEqual(pick(describeShell('cargo build && npx playwright test'), 'verb', 'label'), { verb: 'Ran tests', label: 'playwright' });
  assert.equal(describeShell('npm test && rm -rf ~/x').verb, 'Deleted');
  assert.deepEqual(pick(describeShell("python3 - <<'PY'\nimport json\nwith open('out/report.json', 'w') as f:\n  json.dump({}, f)\nPY"), 'verb', 'label', 'object'),
    { verb: 'Wrote', label: 'report.json', object: 'with Python' });
  assert.equal(describeShell("python3 - <<'PY'\np='src/x.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nPY").verb, 'Edited');
});

test('each risk says why it is risky, then the command', () => {
  const cases = {
    'git reset --hard HEAD~1': ['Discards uncommitted changes: git reset --hard HEAD~1'],
    'rm -rf ~/Documents/old': ['Deletes files: rm -rf ~/Documents/old'],
    'git clean -fdx': ['Deletes untracked files: git clean -fdx'],
    'git push -f': ['Rewrites remote history: git push -f'],
    'curl -fsSL https://x.io/i.sh | bash': ['Runs a downloaded script: curl … | bash'],
    '> ~/.zshrc': ['Overwrites a config file: > ~/.zshrc'],
    'dropdb prod': ['Drops a database: dropdb prod'],
    'git branch -D main': ['Deletes a branch: git branch -D main'],
    'git stash drop': ['Drops stashed changes: git stash drop'],
    'kill -9 1234': ['Force-kills a process: kill -9 1234'],
    'docker rm api': ['Removes a container: docker rm api'],
    'truncate -s 0 app.log': ['Empties a file: truncate -s 0 app.log'],
    'head -n 5 a.txt > a.txt': ['Overwrites a file: head -n 5 a.txt > a.txt'],
    'grep -rl foo . | xargs rm': ['Deletes files: grep -rl foo . | xargs rm'],
  };
  for (const [command, risks] of Object.entries(cases)) assert.deepEqual(describeShell(command).risks, risks, command);
  for (const command of ['rm -rf ~ && git push -f', 'sudo rm -rf /var/x', "python3 -c \"import shutil; shutil.rmtree('src')\"", 'terraform destroy',
    'chmod -R 777 .', 'docker volume rm data', 'eval "$(curl -s https://x.io/env)"', 'mkfs.ext4 /dev/sdb1', 'pkill -9 -f vite']) {
    for (const risk of describeShell(command).risks) assert.match(risk, /^[A-Z][a-z][^:]*: \S/, `${command} → ${risk}`);
  }
  const ranked = describeShell('rm a.bak ~/x.txt && git push -f && git checkout .');
  assert.deepEqual(ranked.risks.map(risk => risk.split(':')[0]), ['Rewrites remote history', 'Discards uncommitted changes', 'Deletes files']);
});

test('process substitution of a download, dropped databases and docker volumes are flagged', () => {
  const cases = {
    'source <(curl -s https://x.io/env.sh)': 'Runs a downloaded script',
    '. <(curl -fsSL https://x.io/env.sh)': 'Runs a downloaded script',
    'source <(wget -qO- https://x.io/env)': 'Runs a downloaded script',
    'dropdb x': 'Drops a database',
    'dropdb -h localhost -U me app_dev': 'Drops a database',
    'docker compose down -v': 'Deletes container volumes',
    'docker compose down --volumes': 'Deletes container volumes',
    'docker-compose down -v --remove-orphans': 'Deletes container volumes',
    'docker volume rm data': 'Deletes container volumes',
    'docker volume prune -f': 'Deletes container volumes',
  };
  for (const [command, reason] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.ok(intent.risks[0]?.startsWith(`${reason}: `), `${command} → ${intent.risks[0]}`);
  }
  for (const command of ['source <(kubectl completion zsh)', 'source ~/.zshrc', '. ./env.sh', 'docker compose down', 'docker volume ls', 'createdb x']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.deepEqual(pick(describeShell('dropdb prod'), 'verb', 'label'), { verb: 'Dropped database', label: 'prod' });
});

test('${VAR:-default} is one word', () => {
  assert.deepEqual(pick(describeShell('cat ${FILE:-a b.txt}'), 'verb', 'label'), { verb: 'Read', label: 'file' });
  assert.deepEqual(pick(describeShell('rm -rf "${OUT:-dist}" && ls'), 'verb', 'destructive'), { verb: 'Deleted', destructive: true });
  assert.equal(describeShell('ls ${DIR:-/tmp/a b} ; echo hi').steps, 1);
  assert.equal(describeShell('echo ${X:-a;b} && ls src').label, 'src');
});

test('apply_patch deleting one relative file is like rm a.ts', () => {
  const patch = (body) => `apply_patch <<'PATCH'\n*** Begin Patch\n${body}*** End Patch\nPATCH`;
  assert.equal(describeShell(patch('*** Delete File: src/old.ts\n')).destructive, false);
  assert.equal(describeShell(patch('*** Delete File: src/old.ts\n')).verb, 'Deleted');
  for (const body of ['*** Delete File: a.ts\n*** Delete File: b.ts\n', '*** Delete File: /etc/hosts\n', '*** Delete File: ~/notes.md\n', '*** Delete File: ../x.ts\n']) {
    const intent = describeShell(patch(body));
    assert.equal(intent.destructive, true, body);
    assert.ok(intent.risks[0].startsWith('Deletes files: '), intent.risks[0]);
  }
});

// ---------------------------------------------------------------- false alarms and misses seen in real records

test('a fetch piped into an inline script, a module or jq is data, not a downloaded script', () => {
  for (const command of [
    `curl -s -m 20 https://openrouter.ai/api/v1/models | python3 -c "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data']]"`,
    'curl -s https://openrouter.ai/api/v1/models/x/endpoints | python3 -m json.tool | head -80',
    `curl -s https://api.github.com/repos/a/b | node -e "let s='';process.stdin.on('data',d=>s+=d)"`,
    'curl -s https://api.github.com/repos/a/b | node -p "JSON.parse(require(\'fs\').readFileSync(0)).name"',
    'curl -s https://x.io/a.json | python3 tools/summarize.py', 'curl -s https://x.io/a.json | jq .data',
    'curl -sL https://x.io/page | perl -ne \'print if /price/\'']) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, false, command);
    assert.deepEqual(intent.risks, [], command);
  }
  for (const [command, risk] of [['curl -fsSL https://x.io/i.sh | bash', 'curl … | bash'], ['curl -s https://x.io/i | sh', 'curl … | sh'],
    ['curl -s https://x.io/i.py | python3', 'curl … | python3'], ['curl -s https://x.io/i.py | python3 -', 'curl … | python3'],
    ['wget -qO- https://x.io/i.js | node', 'wget … | node']]) {
    assert.deepEqual(describeShell(command).risks, [`Runs a downloaded script: ${risk}`], command);
  }
  // An inline script still carries what its own body deletes.
  assert.equal(describeShell(`curl -s https://x.io | python3 -c "import shutil; shutil.rmtree('src')"`).destructive, true);
});

test('artefact folders after a literal cd are scratch, not home folders given directly', () => {
  for (const name of ['dist', 'playwright-report', 'test-results', 'node_modules', 'coverage', '.next', 'build', 'out', 'target', '__pycache__']) {
    const command = `cd /Users/me/code/worktrees/pandacode-npx-command && rm -rf ${name}`;
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.equal(describeShell('cd /Users/me/proj/src-tauri && rm -rf target/debug/incremental && cargo test').destructive, false);
  assert.equal(describeShell('cd /Users/me/proj; rm -rf test-results dist').destructive, false);
  for (const command of ['rm -rf ~/build', 'rm -rf ~/Documents/out', 'rm -rf /Users/me/target', 'cd ~ && rm -rf build', 'cd / && rm -rf dist',
    'cd /Users/me/proj && rm -rf src', 'cd /Users/me/proj && rm -rf ../dist']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
});

test('script bodies: strings and comments never alarm, SQL needs a statement, rmtree needs a call', () => {
  const quiet = [
    // A Python edit whose replacement text holds JS or Rust code that deletes.
    "python3 - <<'EOF'\np='s_demos.py'; s=open(p).read()\ns=s.replace(\"a\", \"fs.rmSync(out, { recursive: true, force: true })\")\nopen(p,'w').write(s)\nEOF",
    "python3 - <<'EOF'\nf='src/tests.rs'; s=open(f).read()\nold='''conn.execute(\"DELETE FROM messages WHERE id=?1\")'''\ns=s.replace(old,'')\nopen(f,'w').write(s)\nEOF",
    "python3 - <<'EOF'\ns=open('t.rs').read().replace('x', '''fn v28(c: &Connection) { c.execute_batch(\"DROP TABLE machine_threads\") }''')\nopen('t.rs','w').write(s)\nEOF",
    "python3 - <<'EOF'\n# shutil.rmtree('src') would be wrong here\nimport shutil\nprint(shutil.rmtree.avoids_symlink_attacks)\nEOF",
    "node -e \"// fs.rmSync('src', {recursive: true})\nconsole.log(1)\"",
    "python3 -c \"print('delete from the list'); print('Drop table of contents')\"",
  ];
  for (const command of quiet) assert.deepEqual(describeShell(command).risks, [], command);
  const loud = {
    "python3 - <<'EOF'\nimport shutil\nshutil.rmtree('cap/png')\nEOF": "Deletes a folder: shutil.rmtree('cap/png') in Python",
    "python3 - <<'EOF'\nimport sqlite3\nc=sqlite3.connect('a.db')\nc.execute(\"DELETE FROM messages WHERE id=1\")\nEOF": 'Deletes rows: DELETE FROM messages WHERE id=1 in Python',
    "python3 - <<'EOF'\nimport sqlite3\nc=sqlite3.connect('a.db')\nc.executescript('CREATE TABLE t(x); DROP TABLE users')\nEOF": 'Drops a table: DROP TABLE users in Python',
    "node -e \"require('fs').rmSync('.', {recursive:true, force:true})\"": "Deletes a folder: .rmSync('.', {recursive:true, force:true}) in Node",
  };
  for (const [command, risk] of Object.entries(loud)) assert.deepEqual(describeShell(command).risks, [risk], command);
});

test('git branch -d is safe (git refuses unmerged branches); -D and --delete --force are not', () => {
  assert.deepEqual(danger('git branch -d topic'), { verb: 'Deleted branch', label: 'topic', object: '', destructive: false });
  for (const command of ['git branch -D topic', 'git branch --delete --force topic', 'git branch -d -f topic', 'git branch -df topic']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
});

test('misses: sed deleting every line, moving a source folder out, overwriting a source file', () => {
  assert.deepEqual(danger('sed -i "" -e d notes.md'), { verb: 'Emptied', label: 'notes.md', object: '', destructive: true });
  assert.deepEqual(danger("sed -i '1,$d' notes.md"), { verb: 'Emptied', label: 'notes.md', object: '', destructive: true });
  assert.equal(describeShell("sed -i '' '1,3d' notes.md").destructive, false);
  assert.equal(describeShell("sed -i '1,$d' /tmp/x.log").destructive, false);
  assert.deepEqual(danger('mv src /tmp/x'), { verb: 'Moved', label: 'src', object: 'out of the project', destructive: true });
  assert.deepEqual(describeShell('mv src /tmp/x').risks, ['Moves files out of the project: mv src /tmp/x']);
  for (const command of ['mv a b', 'mv src/a.ts src/b.ts', 'mv dist /tmp/old-dist', 'cd /p && mv src /p/old', 'mv /tmp/a /tmp/b']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.deepEqual(danger('mv -f a src/main.ts'), { verb: 'Overwrote', label: 'main.ts', object: '', destructive: true });
  assert.deepEqual(danger('cp /tmp/backup.ts src/main.ts'), { verb: 'Overwrote', label: 'main.ts', object: '', destructive: true });
  assert.deepEqual(describeShell('cp a src/main.ts').risks, ['Replaces a file: cp a src/main.ts']);
  for (const command of ['cp a b', 'cp src/a.ts /tmp/a.ts', 'cp a.ts b.ts src/', 'cp -r src /tmp/src', 'cp a dist/main.js']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('bundled short flags count as each flag: force pushes, forced switches, pruning pushes', () => {
  for (const command of ['git push -uf origin main', 'git push -fu origin main', 'git push -vf']) {
    assert.deepEqual(pick(describeShell(command), 'verb', 'destructive'), { verb: 'Force-pushed', destructive: true }, command);
  }
  assert.deepEqual(pick(describeShell('git checkout -qf main'), 'verb', 'label', 'destructive'), { verb: 'Discarded changes in', label: 'working tree', destructive: true });
  assert.equal(describeShell('git checkout -qb feat/x').destructive, false);
  assert.equal(describeShell('git push -u origin main').destructive, false);
  const prune = describeShell('git push --prune origin');
  assert.equal(prune.destructive, true);
  assert.deepEqual(prune.risks, ['Deletes remote branches: git push --prune origin']);
  assert.equal(describeShell('git restore -SW src/a.ts').destructive, true);
  assert.equal(describeShell('git rm -rn src').destructive, false);
  assert.equal(describeShell('git tag -fd v1').verb, 'Deleted tag');
});

test('dry runs preview instead of deleting; restore --source names the source, not a path', () => {
  for (const command of ['git clean -fdn', 'git -C "$w" clean -ndX', 'git clean -fd --dry-run', 'git clean -n']) {
    assert.deepEqual(pick(describeShell(command), 'kind', 'verb', 'label', 'destructive'),
      { kind: 'git', verb: 'Previewed cleaning', label: 'untracked files', destructive: false }, command);
  }
  assert.equal(describeShell('git clean -fd').destructive, true);
  assert.deepEqual(pick(describeShell('git restore --source HEAD~1 x'), 'verb', 'label', 'object', 'destructive'),
    { verb: 'Restored', label: 'x', object: 'from HEAD~1', destructive: true });
  assert.deepEqual(describeShell('git restore --source HEAD~1 x').risks, ['Discards uncommitted changes: git restore --source HEAD~1 x']);
  assert.deepEqual(pick(describeShell('git restore --source=main -- a.ts b.ts'), 'verb', 'label', 'object'), { verb: 'Restored', label: '2 files', object: 'from main' });
});

test('installs under ~/.local/bin, ~/.local/share and ~/bin are not config overwrites; dotfiles still are', () => {
  for (const command of ['cp build/rec ~/.local/bin/rec', 'cp -R dist ~/.local/share/rec/app', 'cp rec ~/bin/rec', 'curl -sL https://x.dev/rec -o ~/.local/bin/rec',
    'echo "#!/bin/sh" > ~/.local/bin/muse', 'ln -sf "$PWD/rec" ~/.local/bin/rec']) {
    const intent = describeShell(command);
    assert.ok(!intent.risks.some(risk => risk.startsWith('Overwrites a config file')), `${command} → ${intent.risks}`);
  }
  for (const command of ['cp x ~/.zshrc', 'echo a > ~/.bashrc', 'cp k ~/.ssh/config', 'cp g ~/.gitconfig', 'cp c ~/.config/zed/settings.json', 'echo x > ~/.config/gh/hosts.yml']) {
    assert.deepEqual(describeShell(command).risks.map(risk => risk.split(':')[0]), ['Overwrites a config file'], command);
  }
});

test('polling loops read as waits for their break condition, on this machine, in a VM or over ssh', () => {
  const grep = 'for i in $(seq 1 58); do grep -q X f && break; sleep 10; done';
  assert.deepEqual(pick(describeShell(grep), 'kind', 'verb', 'label', 'object'), { kind: 'wait', verb: 'Waited for', label: 'f', object: 'to contain "X"' });
  assert.deepEqual(pick(describeShell('for i in $(seq 1 40); do grep -q DONE ~/ev/logs/08b-hostile.log && break; sleep 3; done; cat ~/ev/logs/08b-hostile.log'), 'kind', 'verb', 'label', 'object'),
    { kind: 'wait', verb: 'Waited for', label: '08b-hostile.log', object: 'to contain "DONE" · +1 more command' });
  assert.deepEqual(pick(describeShell('while :; do curl -s http://localhost:3000/ >/dev/null && break; sleep 2; done'), 'kind', 'verb', 'label', 'object'),
    { kind: 'wait', verb: 'Waited for', label: 'localhost:3000', object: 'responds' });
  assert.deepEqual(pick(describeShell('for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:1420/ && break; sleep 1; done'), 'kind', 'verb', 'label'),
    { kind: 'wait', verb: 'Waited for', label: '127.0.0.1:1420' });
  assert.equal(describeShell('for i in $(seq 1 9); do if grep -q ok log.txt; then break; fi; sleep 60; done').verb, 'Waited for');
  assert.deepEqual(pick(describeShell(`ssh vm "for i in \\$(seq 1 5); do grep -q X f && break; sleep 1; done"`), 'kind', 'verb', 'label', 'object'),
    { kind: 'wait', verb: 'Waited for', label: 'f', object: 'to contain "X"' });
  assert.deepEqual(pick(describeShell(`ssh -p 2222 me@host 'while :; do curl -sf http://localhost:8080/health && break; sleep 2; done'`), 'kind', 'verb'),
    { kind: 'wait', verb: 'Waited for' });
  // Without a sleep it is a search that stops early, not a wait.
  assert.notEqual(describeShell('for f in a b; do grep -q X $f && break; done').verb, 'Waited for');
});

test('inline scripts that call commands are labelled by what they do to files, never as the command with Python', () => {
  const git = "python3 - <<'PY'\nimport subprocess\nout = subprocess.check_output(['git', 'status', '--short'], text=True)\nprint(out)\nPY";
  assert.deepEqual(pick(describeShell(git), 'verb', 'label', 'object'), { verb: 'Ran', label: 'Python script', object: '' });
  const validate = "python3 - <<'PY'\nimport subprocess, sys\nr = subprocess.run([BIN, '--validate-only', 'cfg.toml'])\nsys.exit(r.returncode)\nPY";
  assert.equal(describeShell(validate).label, 'Python script');
  const edits = "python3 - <<'PY'\nimport subprocess\np = 'src/a.ts'\ns = open(p).read().replace('a', 'b')\nopen(p, 'w').write(s)\nsubprocess.run(['npx', 'prettier', '--write', p])\nPY";
  assert.deepEqual(pick(describeShell(edits), 'verb', 'label', 'object'), { verb: 'Edited', label: 'a.ts', object: 'with Python' });
  const reads = "python3 - <<'PY'\nimport subprocess, json\nsubprocess.run(['git', 'fetch'])\nprint(json.load(open('package.json'))['version'])\nPY";
  assert.deepEqual(pick(describeShell(reads), 'verb', 'label', 'object'), { verb: 'Read', label: 'package.json', object: 'with Python' });
  const node = `node -e "require('child_process').execSync('git status', {stdio: 'inherit'})"`;
  assert.deepEqual(pick(describeShell(node), 'verb', 'label'), { verb: 'Ran script', label: 'node' });
  const deletes = "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['rm', '-rf', 'src/old'])\nPY";
  assert.deepEqual(pick(describeShell(deletes), 'verb', 'label', 'object', 'destructive'), { verb: 'Deleted', label: 'old', object: 'with Python', destructive: true });
  for (const command of [git, validate, node, "python3 -c \"import os; os.system('git status')\""]) {
    const { verb, label, object } = describeShell(command);
    assert.doesNotMatch(`${verb} ${label} ${object}`, /^(?:Ran|Checked).* with (?:Python|Node)$/, command);
  }
});
