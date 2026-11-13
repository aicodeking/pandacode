// Row sentences for git diffs and history, process searches, wrapper scripts, inline scripts, tidy objects and
// macOS commands that lose settings or stop everything. Shapes come from recorded Claude and Codex commands.
import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell, SHELL_VERBS } from '../src/shell-intent.ts';

const row = command => {
  const intent = describeShell(command);
  return [intent.verb, intent.label, intent.object].join(' | ');
};

test('destructive macOS and process commands carry reasons', () => {
  const cases = {
    'security delete-keychain build.keychain': /^Deletes a keychain: security delete-keychain build\.keychain$/,
    'defaults delete com.apple.dock': /^Deletes app settings: defaults delete com\.apple\.dock$/,
    'defaults delete com.apple.dock autohide': /^Deletes app settings: defaults delete com\.apple\.dock autohide$/,
    'pkill -f .': /^Stops every process: pkill -f \.$/,
    "pkill -f ''": /^Stops every process: pkill -f ''$/,
    'launchctl unload -w ~/Library/LaunchAgents/com.x.plist': /^Disables a launch service: launchctl unload -w/,
    'launchctl bootout gui/501/com.x': /^Disables a launch service: launchctl bootout gui\/501\/com\.x$/,
  };
  for (const [command, risk] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.match(intent.risks[0], risk, command);
  }
  assert.equal(row('defaults delete com.apple.dock'), 'Deleted | com.apple.dock | settings');
  assert.equal(row('security delete-keychain build.keychain'), 'Deleted | build.keychain | keychain');
  assert.equal(row('launchctl bootout gui/501/com.x'), 'Stopped | com.x | ');
});

test('harmless relatives of those commands stay harmless', () => {
  for (const command of ['defaults read com.apple.dock', 'defaults write com.apple.dock autohide -bool true', 'security find-identity -v',
    'pkill -f vite', 'launchctl list', 'launchctl unload ~/Library/LaunchAgents/x.plist', 'launchctl kickstart -k gui/501/com.x']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.equal(row('launchctl list'), 'Listed | launchctl services | ');
  assert.equal(row('defaults read com.apple.dock'), 'Read | com.apple.dock | settings');
});

test('git diff names the range and the paths, never its display flags', () => {
  assert.equal(row('git diff --no-ext-diff --unified=3 main...HEAD -- src/a.ts src/b.ts'), 'Diffed | main...HEAD | · 2 files');
  assert.equal(row('git diff main...HEAD -- src-tauri/src/providers.rs'), 'Diffed | main...HEAD | · providers.rs');
  assert.equal(row('git diff --stat --color main...HEAD'), 'Diffed | main...HEAD | ');
  assert.equal(row('git diff --name-only main...HEAD'), 'Listed changed files | main...HEAD | ');
  assert.equal(row('git diff --name-only'), 'Listed changed files | git diff | ');
  assert.equal(row('git diff -U5 HEAD~1'), 'Diffed | HEAD~1 | ');
  assert.equal(row('git diff src/main.ts src/styles.css'), 'Diffed | git diff | · 2 files');
  assert.equal(row('git diff --cached'), 'Diffed | git diff | staged');
  assert.equal(row('git diff'), 'Diffed | git diff | ');
});

test('git show and git log keep only the revision, range or count', () => {
  assert.equal(row('git show 390ec22 --stat'), 'Showed | 390ec22 | ');
  assert.equal(row('git show --stat --oneline v0.3.12'), 'Showed | v0.3.12 | ');
  assert.equal(row('git show 390ec22 -- src tests'), 'Showed | 390ec22 | · 2 files');
  assert.equal(row("git log --format='%h %s' -5 --stat"), 'Viewed history | git log | last 5');
  assert.equal(row('git log --format=%s origin/main..HEAD'), 'Viewed history | git log | origin/main..HEAD');
  assert.equal(row('git log --oneline --graph -n 20 main..feature'), 'Viewed history | git log | main..feature · last 20');
  assert.equal(row('git log --pretty=format:%H --stat'), 'Viewed history | git log | ');
});

test('ps piped into grep names what it looked for', () => {
  assert.equal(row('ps aux | grep vite'), 'Checked processes matching | vite | ');
  assert.equal(row("ps aux | grep -E 'vite|playwright' | grep -v grep | head"), 'Checked processes matching | vite|playwright | ');
  assert.equal(row('ps aux | grep "[d]uo-helper"'), 'Checked processes matching | [d]uo-helper | ');
  assert.equal(row('ps aux'), 'Checked processes | ps | ');
});

test('objects drop redirections, escapes and curl formats', () => {
  assert.equal(row('foo bar 2>&1'), 'Ran | foo | bar');
  assert.equal(row('foo bar >/dev/null 2>&1'), 'Ran | foo | bar');
  assert.equal(row('foo bar &>/dev/null'), 'Ran | foo | bar');
  assert.equal(row('foo bar 2>/dev/null'), 'Ran | foo | bar');
  assert.equal(row('./scripts/x.sh a b 2>&1'), 'Ran | x.sh | a b');
  assert.equal(row('foo "a\\nb"'), 'Ran | foo | a b');
  assert.equal(row("foo -w '%{http_code}' x"), 'Ran | foo | -w x');
  const raw = describeShell('lsof -i :1420 | xargs kill 2>/dev/null');
  assert.equal(raw.object, '-i :1420 | xargs kill');
});

test('long argument tails read in words, never +N', () => {
  assert.equal(row('look.sh sp a b c d e f g h i'), 'Ran | look.sh | sp and 9 more args');
  assert.equal(row('bash look.sh sp a b c d e f g h i'), 'Ran | look.sh | sp and 9 more args');
  assert.equal(row('python3 tool.py one two'), 'Ran | tool.py | one two');
  assert.doesNotMatch(describeShell('python3 tool.py --base main a b c d e f g h').object, /\+\d/);
});

test('wrapper scripts that run a test runner read as the tests', () => {
  assert.equal(row('python3 verify.py --base main npx playwright test tests/a.spec.ts'), 'Ran tests | playwright | via verify.py');
  assert.equal(row('node run.mjs -- vitest run'), 'Ran tests | vitest | via run.mjs');
  assert.equal(row('./scripts/ci.sh cargo test -p core'), 'Ran tests | cargo test | via ci.sh');
  assert.equal(row('bash retry.sh 3 npm test'), 'Ran tests | npm test | via retry.sh');
  assert.equal(describeShell('python3 verify.py npx playwright test').kind, 'test');
});

test('inline Python and Node scripts read as scripts, naming the file they touch', () => {
  assert.equal(row("python3 - <<'EOF'\nimport json\nprint(1)\nEOF"), 'Ran | Python script | ');
  assert.equal(row("node - <<'EOF'\nconst x = 1\nconsole.log(x)\nEOF"), 'Ran | Node script | ');
  assert.equal(row("python3 <<'EOF'\nimport sys\nfor i in range(3): print(i)\nEOF"), 'Ran | Python script | ');
  assert.equal(row("python3 - <<'EOF'\np='tests/ui.spec.ts'; s=open(p).read()\nprint(s[:10])\nEOF"), 'Read | ui.spec.ts | with Python');
  assert.equal(row("python3 - <<'EOF'\nopen('out.txt', 'w').write('x')\nEOF"), 'Wrote | out.txt | with Python');
  assert.equal(describeShell("python3 - <<'EOF'\nprint(1)\nEOF").kind, 'script');
});

test('every new verb is a SHELL_VERB', () => {
  for (const verb of ['Listed changed files', 'Checked processes matching']) assert.ok(SHELL_VERBS.includes(verb), verb);
});

// ---------------------------------------------------------------- misreads, system files, handlers (recorded shapes)

test('Python reads only bare open( or a Path receiver, never a method named open', () => {
  assert.equal(row("python3 - <<'EOF'\nfrom pathlib import Path\np = Path('a.bin')\nwith p.open('rb') as f:\n  print(f.read(4))\nEOF"), 'Read | a.bin | with Python');
  assert.equal(row("python3 - <<'EOF'\nwith Path('data.json').open() as f: print(f.read())\nEOF"), 'Read | data.json | with Python');
  assert.equal(row("python3 - <<'EOF'\nimport json\nd = json.load(open('cfg.json'))\nEOF"), 'Read | cfg.json | with Python');
  // `tarfile.open('x.tar')`, `Image.open(n)`, `f.open('rb')` on an unknown receiver: not a read of a file named by the mode.
  for (const command of ["python3 -c \"import tarfile; t=tarfile.open('x.tar'); print(t)\"", "python3 - <<'EOF'\nwith f.open('rb') as h: pass\nEOF",
    "python3 - <<'EOF'\nfrom PIL import Image\nim=Image.open('a.png')\nEOF"]) {
    const intent = describeShell(command);
    assert.notEqual(intent.label, 'rb', command);
    assert.ok(!(intent.verb === 'Read' && /^(?:rb|x\.tar|a\.png)$/.test(intent.label)), `${command} → ${row(command)}`);
  }
});

test('a poll loop on a substitution waits for its value', () => {
  const run = describeShell('cd /r && until [ "$(gh run view 39827503624 --json status -q .status)" = completed ]; do sleep 25; done');
  assert.deepEqual([run.kind, run.verb, run.label, run.object], ['wait', 'Waited for', 'run 39827503624', 'to be completed']);
  assert.equal(row('until [ "$(gh run view 3 --json status -q .status)" = completed ]; do sleep 20; done; gh run view 3 --json conclusion'),
    'Waited for | run 3 | to be completed · +1 more command');
  assert.equal(row('until [ "$(curl -s localhost:3000/health)" = ok ]; do sleep 1; done'), 'Waited for | curl -s localhost:3000/health | to be ok');
  assert.equal(row('while [ "$(cat status)" != done ]; do sleep 2; done'), 'Waited for | cat status | to be done');
  assert.equal(row('until [[ $(kubectl get pod x -o jsonpath={.status.phase}) == Running ]]; do sleep 5; done').split(' | ')[0], 'Waited for');
  // A substitution that deletes still carries its risk.
  assert.equal(describeShell('until [ "$(rm -rf ~/x; echo y)" = y ]; do sleep 1; done').destructive, true);
});

test('recursive deletes count folders; plain deletes count files', () => {
  assert.equal(row('rm -rf node_modules dist'), 'Deleted | 2 folders | ');
  assert.equal(row('rm -rf /tmp/x /tmp/y'), 'Deleted | 2 folders | ');
  assert.equal(row('rm a.txt b.txt'), 'Deleted | 2 files | ');
  assert.equal(row('rm -f /tmp/a.log /tmp/b.log'), 'Deleted | 2 files | ');
  assert.equal(row('rm -rf tests/tmp-a.spec.ts tmp-b.config.ts'), 'Deleted | 2 files | ');
  assert.equal(row('rm -rf /tmp/r24-shots tests/tmp-r24.spec.ts'), 'Deleted | 2 items | ');
  assert.equal(row('rm -rf .cache .next'), 'Deleted | 2 folders | ');
  assert.match(describeShell('rm -rf a b c').risks[0], /^Deletes files: rm -rf a b c$/);
});

test('writes into system paths overwrite a system file and appends append to one', () => {
  const cases = {
    'echo "127.0.0.1 x" > /etc/hosts': 'Overwrites a system file: echo "127.0.0.1 x" > /etc/hosts',
    'echo x | sudo tee /etc/hosts': 'Overwrites a system file: sudo tee /etc/hosts',
    'echo x | sudo tee -a /etc/fstab': 'Appends to a system file: sudo tee -a /etc/fstab',
    'echo x >> /etc/fstab': 'Appends to a system file: echo x >> /etc/fstab',
    'sudo cp hosts /etc/hosts': 'Overwrites a system file: sudo cp hosts /etc/hosts',
    'sudo mv x /usr/local/bin/x': 'Overwrites a system file: sudo mv x /usr/local/bin/x',
    ': > /etc/motd': 'Overwrites a system file: : > /etc/motd',
    'curl -s https://x.io/p > /private/etc/paths': 'Overwrites a system file: curl -s https://x.io/p > /private/etc/paths',
    'sudo cp a.plist /Library/LaunchDaemons/a.plist': 'Overwrites a system file: sudo cp a.plist /Library/LaunchDaemons/a.plist',
    'cat x > /System/Library/x.conf': 'Overwrites a system file: cat x > /System/Library/x.conf',
    'cp tool /bin/tool': 'Overwrites a system file: cp tool /bin/tool',
    'cp tool /sbin/tool': 'Overwrites a system file: cp tool /sbin/tool',
  };
  for (const [command, risk] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.equal(intent.risks[0], risk, command);
  }
  assert.equal(row('echo x > /etc/hosts'), 'Overwrote | hosts | ');
  // Reading them, or writing under home or /tmp, is not this alarm.
  for (const command of ['cat /etc/hosts', 'cp /etc/hosts /tmp/hosts', 'echo x > ~/Library/Logs/a.log', 'echo x > /tmp/etc/hosts', 'ls /usr/local/bin']) {
    assert.ok(!describeShell(command).risks.some(risk => risk.startsWith('Overwrites a system file')), command);
  }
});

test('diff, curl headers, dev servers and git plumbing read as what they do', () => {
  assert.equal(row('diff a.txt b.txt'), 'Compared | a.txt | and b.txt');
  assert.equal(row('diff -u src/a.ts src/b.ts | head -40'), 'Compared | a.ts | and b.ts');
  assert.equal(row('diff -r a/ b/'), 'Compared | a | and b');
  assert.equal(row('diff <(git show HEAD:package.json) package.json'), 'Compared | git show HEAD:package.json | and package.json');
  assert.equal(row("curl -s -H 'Accept: application/json' https://api.github.com/repos/a/b"), 'Fetched | api.github.com | /repos/a/b');
  assert.equal(row(`set -a; source ~/.vibe/.env; set +a; curl -s https://api.mistral.ai/v1/models -H "Authorization: Bearer $K" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d)"`),
    'Fetched | api.mistral.ai | /v1/models');
  assert.equal(row("curl -s -H 'x-vf-client: web' http://127.0.0.1:4827/api/ideas | python3 -m json.tool | cut -c1-200 | head -70"), 'Fetched | 127.0.0.1:4827 | /api/ideas');
  // A local script, or one that writes, is not a reader.
  assert.equal(describeShell('curl -s https://x.io/a.json | python3 tools/summarize.py').raw, true);
  assert.equal(describeShell(`curl -s https://x.io/a | python3 -c "open('o.txt','w').write('x')"`).raw, true);
  assert.equal(row('vite --host'), 'Started dev server | vite | ');
  assert.equal(row('npx vite --host 127.0.0.1 --port 1421 --strictPort'), 'Started dev server | vite | ');
  assert.equal(row('npx vite'), 'Started dev server | vite | ');
  assert.equal(row('vite build'), 'Built | vite build | ');
  assert.equal(row('git check-ignore -v node_modules dist'), 'Checked ignore rules | git check-ignore | -v node_modules dist');
  assert.equal(row('git merge-base HEAD origin/main'), 'Found merge base | git merge-base | HEAD origin/main');
  assert.equal(row('git ls-files src'), 'Listed tracked files | git ls-files | src');
  for (const verb of ['Compared', 'Started dev server', 'Checked ignore rules', 'Found merge base', 'Listed tracked files']) assert.ok(SHELL_VERBS.includes(verb), verb);
});

test('loops around media and disk tools describe the body', () => {
  assert.equal(row('for k in a b c d; do ffmpeg -y -loglevel error -i room_$k.mp4 -frames:v 1 /tmp/r_$k.jpg; done'), 'Encoded | 4 files | with ffmpeg');
  assert.equal(row('for f in *.mp4; do ffmpeg -y -i "$f" -frames:v 1 "${f%.mp4}.jpg"; done'), 'Encoded | files | with ffmpeg');
  assert.equal(row('for d in */; do du -sh "$d"; done'), 'Checked disk usage | folders | ');
  assert.equal(row('for d in a b; do du -sh $d; done'), 'Checked disk usage | 2 folders | ');
  assert.equal(row('for p in a.ts b.ts c.ts; do cat $p; done'), 'Read | a.ts | +2 files');
});

test('the recorder\'s [Preview truncated] tail never reaches a pattern or object', () => {
  for (const command of ['grep -rn "foo" src\n[Preview truncated]', "rg -n 'bar[Preview truncated]", 'git commit -m "Fix it\n[Preview truncated]',
    "python3 - <<'EOF'\ns=1\n[Preview truncated]"]) {
    const intent = describeShell(command);
    assert.doesNotMatch(`${intent.label} ${intent.object}`, /Preview truncated/, command);
  }
  assert.equal(row('grep -rn "foo" src\n[Preview truncated]'), 'Searched | src | for "foo" in src');
});

test('option values are not files, probes are not stops, and gh/git sentences name their subject', () => {
  const cases = {
    'rustfmt --edition 2021 src/main.rs': 'Formatted | rustfmt | src/main.rs',
    'prettier --write --print-width 100 a.ts': 'Formatted | prettier | a.ts',
    'black --line-length 100 app.py': 'Formatted | black | app.py',
    'kill -0 1234': 'Checked | process 1234 | is running',
    'gh pr create --title "Fix tool rows" --body-file /tmp/body.md': 'Created | PR | “Fix tool rows”',
    'gh pr create --base main --title "Fix it" --body "Long body text"': 'Created | PR | “Fix it”',
    'git checkout -b topic': 'Created branch | topic | ',
    'git switch -c topic': 'Created branch | topic | ',
    'git stash push -u -m "wip tool rows"': 'Stashed | changes | · “wip tool rows”',
    'git merge-base --is-ancestor main HEAD': 'Checked | main | is an ancestor of HEAD',
  };
  for (const [command, sentence] of Object.entries(cases)) assert.equal(row(command), sentence, command);
  assert.equal(describeShell('kill -0 1234').destructive, false);
  assert.equal(row('while kill -0 1234 2>/dev/null; do sleep 1; done'), 'Waited for | process 1234 | to exit');
  assert.equal(describeShell('git checkout -b topic').destructive, false);
});

test('handlers for mkdir, AXe, expo lint, rev-parse, ln -s and tmux send-keys', () => {
  const cases = {
    'mkdir -p src/a/b': 'Created folder | src/a/b | ',
    'mkdir a b c': 'Created folder | a | +2 more',
    'axe tap -x 120 -y 640 --udid ABC-123': 'Tapped | on simulator | at 120, 640',
    'axe tap --label Continue --udid ABC': 'Tapped | on simulator | “Continue”',
    'axe swipe --start-x 10 --start-y 600 --end-x 10 --end-y 100 --udid ABC': 'Swiped | on simulator | ',
    'axe type "hello world" --udid ABC': 'Typed | on simulator | “hello world”',
    'axe describe-ui --udid ABC': 'Inspected | simulator UI | ',
    'axe screenshot --output shot.png --udid ABC': 'Captured simulator screenshot | shot.png | ',
    'expo lint': 'Linted | expo | ',
    'npx expo lint': 'Linted | expo | ',
    'git rev-parse HEAD': 'Resolved | HEAD | ',
    'git rev-parse --show-toplevel': 'Resolved | repo root | ',
    'git rev-parse --abbrev-ref HEAD': 'Resolved | HEAD | branch name',
    'axe press home --udid ABC': 'Pressed | on simulator | home',
    'axe button lock --udid ABC': 'Pressed | on simulator | lock',
    'ln -s ../shared/config.json config.json': 'Symlinked | config.json | → ../shared/config.json',
    'ln ../shared/config.json config.json': 'Linked | config.json | → ../shared/config.json',
    'tmux send-keys -t dev "npm test" Enter': 'Sent keys to | tmux dev | npm test Enter',
  };
  for (const [command, sentence] of Object.entries(cases)) assert.equal(row(command), sentence, command);
  assert.equal(describeShell('npx axe http://localhost:1420').verb, 'Ran accessibility check');
  assert.equal(describeShell('ln -sf /dev/null ~/.zshrc').destructive, true);
  for (const verb of ['Created folder', 'Created branch', 'Tapped', 'Swiped', 'Typed', 'Pressed', 'Resolved', 'Linked', 'Symlinked']) assert.ok(SHELL_VERBS.includes(verb), verb);
});

test('file counts are the same whether the files are read in one step or several', () => {
  for (const command of ['cat a b c', 'cat a b; cat c', 'cat a; cat b; cat c']) assert.equal(row(command), 'Read | a | +2 files', command);
  assert.equal(row('cat a b; cat a'), 'Read | a | +1 file');
});

test('recorded shapes of the new rows', () => {
  const cases = {
    "/bin/zsh -lc 'rustfmt --edition 2021 src-tauri/src/capabilities.rs'\nWorking directory: /Users/me/repo": 'Formatted | rustfmt | src-tauri/src/capabilities.rs',
    'axe type --udid $U -- "wifi"': 'Typed | on simulator | “wifi”',
    'axe tap -x 95 -y 408 --udid $U 2>&1 | tail -1': 'Tapped | on simulator | at 95, 408',
    'git rev-parse HEAD origin/main': 'Resolved | HEAD | +1 more',
    'git rev-parse --abbrev-ref @{u}': 'Resolved | @{u} | branch name',
    'ln -s $PWD/node_modules /tmp/pc-base/node_modules': 'Symlinked | node_modules | → $PWD/node_modules',
    'git merge-base --is-ancestor 2b537b0 origin/main && echo on-main': 'Checked | 2b537b0 | is an ancestor of origin/main',
    'git checkout -b fix/issues-oct-22': 'Created branch | fix/issues-oct-22 | ',
  };
  for (const [command, sentence] of Object.entries(cases)) assert.equal(row(command), sentence, command);
  assert.equal(row('cd "$(dirname "$0")/.." || exit 1\nwhile kill -0 73734 2>/dev/null; do sleep 20; done\npython3 setup/run_batch.py --finish-on'), 'Waited for | process 73734 | to exit · +1 more command');
});

// --- Final shell round: redirected filters, cut and jq, git untrack and rebase, home deletes, counted files -------

test('a filter or reader whose output goes to a file reads as writing that file; searches and listings keep `→ file`', () => {
  assert.equal(row("sed 's#a#b#g' run.sh > run2.sh"), 'Wrote | run2.sh | ');
  assert.equal(row("awk '{print $1}' a.txt > b.txt"), 'Wrote | b.txt | ');
  assert.equal(row('sort -u names.txt | uniq > out/names.txt'), 'Wrote | names.txt | ');
  assert.equal(row("jq '.a' in.json >> log.json"), 'Appended to | log.json | ');
  assert.equal(row('cat a.txt > /dev/null'), 'Read | a.txt | ');
  assert.equal(describeShell('rg -n foo src > results.txt').object, 'for "foo" in src → results.txt');
  assert.equal(describeShell('head -n 5 a.txt > a.txt').verb, 'Overwrote');
});

test('cut reads its file and jq queries its JSON file', () => {
  assert.equal(row('cut -d, -f1 data.csv'), 'Read | data.csv | ');
  assert.equal(row('cut -c1-150 < /tmp/x/log.txt'), 'Read | log.txt | ');
  assert.equal(row("jq '.scripts' package.json"), 'Queried | package.json | ');
  assert.equal(row("jq -r --arg k v '.[$k]' a.json b.json"), 'Queried | a.json | +1 file');
  assert.equal(row("jq -n '1+1'"), "Ran | jq | -n '1+1'");
});

test('git rm --cached untracks, and a rebase reads `Rebased onto X` with a low risk', () => {
  const untracked = describeShell('git rm -r --cached .');
  assert.equal(row('git rm -r --cached .'), 'Untracked | files | in git');
  assert.equal(untracked.destructive, false);
  assert.equal(row('git rm --cached a.ts'), 'Untracked | a.ts | in git');
  for (const [command, target] of [['git rebase -i HEAD~3', 'HEAD~3'], ['git rebase main', 'main'], ['git rebase --onto main topic', 'main']]) {
    const intent = describeShell(command);
    assert.equal(row(command), `Rebased onto | ${target} | `, command);
    assert.deepEqual(intent.risks, [`Rewrites local history: ${command}`], command);
  }
  assert.equal(describeShell('git rebase --continue').destructive, false);
});

test('a delete under home names the path as written', () => {
  assert.equal(describeShell('rm ~/.config/app').label, '~/.config/app');
  assert.equal(describeShell('rm -rf $HOME/.cache/x').label, '$HOME/.cache/x');
  assert.equal(describeShell('rm src/a.ts').label, 'a.ts');
});

test('extra lint, format and test targets that are files count as files', () => {
  assert.equal(row('npx eslint a.ts b.ts'), 'Linted | eslint | a.ts +1 file');
  assert.equal(row('npx prettier --write a.ts b.ts c.ts'), 'Formatted | prettier | a.ts +2 files');
  assert.equal(row('npx playwright test a.spec.ts b.spec.ts'), 'Ran tests | playwright | a.spec.ts +1 file');
  assert.equal(row('cargo test foo bar'), 'Ran tests | cargo test | foo +1');
});

test('commands and arguments as written are mono, so their quotes never curl', () => {
  for (const command of ['node "a b.js" | tee x.log', 'foo "x y"', 'e "a b" (c)']) assert.equal(describeShell(command).mono, true, command);
  assert.equal(describeShell('git commit -m "wip"').mono, false);
});

// ---------------------------------------------------------------- poll loops, verbs, subshell pipes, loop nouns (recorded shapes)

test('a poll loop that waits for a test log reads as the wait and carries the summary', () => {
  const failing = 'test result: FAILED. 96 passed; 2 failed; 2 ignored; 0 measured; 0 filtered out; finished in 3.1s\n';
  const passing = 'test result: ok. 164 passed; 0 failed; 9 ignored; 0 measured; 1321 filtered out; finished in 38.59s\n';
  const shapes = [
    'F=/private/tmp/x/tasks/b1.output; until grep -q "test result" $F; do sleep 5; done; cat $F',
    'f=/private/tmp/x/tasks/b2.output; for i in $(seq 1 55); do grep -q "test result" $f && break; sleep 10; done; cat $f',
    'for i in $(seq 1 55); do grep -q "test result" /tmp/t.log 2>/dev/null && tail -c 3000 /tmp/t.log | tr -d \'\\0\' | tail -30 && break; sleep 10; done',
  ];
  for (const command of shapes) {
    const intent = describeShell(command, failing);
    assert.equal(intent.verb, 'Waited for', command);
    assert.match(intent.object, /^to contain "test result"/, command);
    assert.deepEqual(intent.check, { kind: 'test', failed: true, waited: true }, command);
    assert.deepEqual(describeShell(command, passing).check, { kind: 'test', failed: false, waited: true }, command);
    assert.equal(describeShell(command, 'ready\n').check, undefined, command);
  }
});

test('renamed branches, applied stashes, remote deletes and emptied secrets', () => {
  assert.equal(row('git branch -m main'), 'Renamed branch to | main | ');
  assert.equal(row('git branch -m old new'), 'Renamed branch to | new | from old');
  const forced = describeShell('git branch -M main');
  assert.equal([forced.verb, forced.label].join(' | '), 'Renamed branch to | main');
  assert.deepEqual(forced.risks, ['Overwrites a branch: git branch -M main']);
  assert.equal(describeShell('git branch -m main').destructive, false);
  assert.equal(row('git stash pop'), 'Applied stash | git stash | ');
  assert.equal(row('git stash apply stash@{1}'), 'Applied stash | git stash | stash@{1}');
  for (const command of ['curl -X DELETE https://api.x.com/v1/a', 'curl -s --request DELETE https://api.x.com/v1/a']) {
    const intent = describeShell(command);
    assert.equal([intent.verb, intent.label, intent.object].join(' | '), 'Sent DELETE to | api.x.com | /v1/a', command);
    assert.deepEqual(intent.risks, [`Deletes a remote resource: ${command}`]);
  }
  for (const command of ['printf "" > .env', 'echo -n > .env', ': > .env', '> .env', 'printf "" > .env.local', ': > certs/server.pem', ': > id.key']) {
    const intent = describeShell(command);
    assert.equal(intent.verb, 'Emptied', command);
    assert.equal(intent.destructive, true, command);
    assert.match(intent.risks[0], /^Empties a secrets file: /, command);
  }
  assert.equal(describeShell(': > notes.txt').risks[0], 'Empties a file: : > notes.txt');
  assert.equal(describeShell('printf "" > /tmp/.env').destructive, false);
  assert.equal(row('echo -n hi > a.txt'), 'Wrote | a.txt | ');
  for (const command of ['builtin rm -rf src', 'command rm -rf src']) {
    const intent = describeShell(command);
    assert.equal([intent.verb, intent.label].join(' | '), 'Deleted | src', command);
    assert.equal(intent.destructive, true, command);
  }
  for (const verb of ['Renamed branch to', 'Applied stash', 'Sent DELETE to']) assert.ok(SHELL_VERBS.includes(verb), verb);
});

test('a `;` inside a piped subshell never leaks into the row', () => {
  const intent = describeShell('(printf a; sleep 8) | timeout 15 dsh --x 2>/tmp/e.err | head -c 600 ; head -c 1500 /tmp/e.err');
  assert.equal([intent.verb, intent.label, intent.object].join(' | '), 'Ran | dsh | --x 2>/tmp/e.err · +1 more command');
  const raw = describeShell('(cd a; ls) | xargs echo');
  assert.ok(!/\)/.test(raw.object), raw.object);
  // What the subshell feeds a shell is still read.
  assert.equal(describeShell('(echo a; echo "rm -rf ~") | sh').destructive, true);
});

test('loops over files count files, never bare items', () => {
  assert.equal(row('for f in isolation.py a.py b.py c.py d.py e.py; do cat $f; done'), 'Read | isolation.py | +5 files');
  assert.equal(row('for u in https://a.com/x https://b.com/y; do curl -s $u; done'), 'Fetched | a.com | /x · 2 URLs');
  assert.equal(row('for n in 1 2 3; do echo $n > out.txt; done'), 'Wrote | out.txt | ');
});

const parts = (intent, ...keys) => Object.fromEntries(keys.map(key => [key, intent[key]]));

test('package scripts chip the script they ran, never `run` or a generic `npm test`', () => {
  const cases = {
    'npm run build': 'Built | npm run build | ', 'bun run build': 'Built | bun run build | ', 'npm run lint': 'Linted | npm run lint | ',
    'npm run typecheck': 'Typechecked | npm run typecheck | ', 'npm run test:release': 'Ran tests | npm run test:release | ',
    'pnpm run test:e2e a.spec.ts': 'Ran tests | pnpm run test:e2e | a.spec.ts', 'pnpm run build:web': 'Built | pnpm run build:web | ',
    'yarn run lint:fix': 'Linted | yarn run lint:fix | ', 'bun run typecheck:all': 'Typechecked | bun run typecheck:all | ',
    'npm test': 'Ran tests | npm test | ', 'npm run test': 'Ran tests | npm test | ',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(row(command), expected, command);
});

test('a destructive step after a failed `&&` step did not run', () => {
  const failing = 'not ok 1 - adds\n# tests 3\n# pass 2\n# fail 1\n';
  const tests = describeShell('npm test && git push --force', failing);
  assert.deepEqual(parts(tests, 'verb', 'label', 'destructive', 'notRun'), { verb: 'Ran tests', label: 'npm test', destructive: false, notRun: true });
  assert.deepEqual(tests.check, { kind: 'test', failed: true });
  assert.deepEqual(tests.risks, ['Rewrites remote history: git push --force']);
  const commit = describeShell('git commit -m x && git push -f', 'On branch main\nnothing to commit, working tree clean\n');
  assert.deepEqual(parts(commit, 'verb', 'destructive', 'notRun'), { verb: 'Committed', destructive: false, notRun: true });
  const fetched = describeShell('git fetch && git reset --hard origin/main', "fatal: unable to access 'https://github.com/a/b/': Could not resolve host\n");
  assert.deepEqual(parts(fetched, 'verb', 'destructive', 'notRun'), { verb: 'Fetched', destructive: false, notRun: true });
  // A nonzero exit with failing output says the same.
  assert.equal(describeShell('npm test && git push --force', failing, { nonzero: true }).notRun, true);
});

test('a destructive step that could have run keeps its badge', () => {
  const passing = '# tests 3\n# pass 3\n# fail 0\n';
  for (const [command, output] of [
    ['npm test && git push --force', passing], ['npm test && git push --force', ''], ['npm test; git push --force', 'not ok 1\n# fail 1\n'],
    ['npm test || git push --force', 'not ok 1\n# fail 1\n'], ['git push --force && npm test', 'not ok 1\n# fail 1\n'],
  ]) {
    const intent = describeShell(command, output);
    assert.equal(intent.destructive, true, command);
    assert.equal(intent.verb, 'Force-pushed', command);
    assert.equal(intent.notRun, undefined, command);
  }
});

test('a check only fails on output it can be blamed for', () => {
  const status = 'panda-agentd 0.2.0\nerror:   pair start: POST /v1/pair/start: 404 Not Found\n';
  assert.deepEqual(describeShell('go vet ./... && ./agentd status', status).check, { kind: 'typecheck', failed: false });
  assert.deepEqual(describeShell('go vet ./...', 'vet: ./main.go:12:2: unreachable code\n').check, { kind: 'typecheck', failed: true });
  assert.deepEqual(describeShell('go vet ./...', '# pandaos/agentd\n./main.go:12:2: x declared and not used\n').check, { kind: 'typecheck', failed: true });
  assert.deepEqual(describeShell('npx tsc --noEmit', 'src/a.ts(1,2): error TS2345: no\n').check, { kind: 'typecheck', failed: true });
  assert.deepEqual(describeShell('npx tsc --noEmit && node x.js', 'error: something unrelated\n').check, { kind: 'typecheck', failed: false });
  assert.deepEqual(describeShell('cargo check', 'error: could not compile `app` (lib) due to 2 previous errors\n').check, { kind: 'typecheck', failed: true });
  assert.deepEqual(describeShell('mypy src', 'src/a.py:3: error: Incompatible types\nFound 1 error in 1 file\n').check, { kind: 'typecheck', failed: true });
});

test('device files are never destructive targets', () => {
  assert.deepEqual(parts(describeShell('dd if=x of=/dev/null'), 'verb', 'label', 'object', 'destructive'), { verb: 'Read', label: 'x', object: 'with dd', destructive: false });
  for (const command of ['cp /dev/null /dev/null', 'truncate -s 0 /dev/null', 'rm -f /dev/null', 'dd if=/dev/zero of=/dev/null bs=1m count=10', 'truncate -s 0 /dev/stdout', 'cp a.txt /dev/stderr']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  assert.equal(describeShell('dd if=a.img of=/dev/disk4').destructive, true);
  assert.equal(describeShell('truncate -s 0 notes.txt').destructive, true);
});

test('container execs carry the inner command and its risks', () => {
  for (const command of ['docker exec c rm -rf /app', 'docker exec -it -u root c sh -c "rm -rf /app"', 'kubectl exec pod -- rm -rf /app', 'kubectl exec -n ns -it pod -c app -- rm -rf /app']) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.match(intent.risks[0], /rm -rf \/app/, command);
  }
  assert.equal(describeShell('docker exec c ls /app').destructive, false);
});

test('tag listings, leading assignments and long hashes', () => {
  assert.equal(row('git tag -l v0.3.29'), 'Listed | tags | matching v0.3.29');
  assert.equal(row('git tag --list'), 'Listed | tags | ');
  assert.equal(row('git tag'), 'Listed | tags | ');
  assert.equal(row('git tag -n'), 'Listed | tags | ');
  assert.equal(describeShell('git tag v1').verb, 'Tagged');
  assert.equal(row('rid=$(cat /tmp/rid); gh run view $rid --json status'), 'Viewed | gh run view | $rid');
  assert.equal(describeShell('s=$(gh run view 4 --json status)').label, 'gh run view');
  assert.equal(row('git show 0123456789abcdef0123456789abcdef01234567'), 'Showed | 0123456 | ');
  assert.equal(row('git checkout 0123456789abcdef0123456789abcdef01234567'), 'Switched to | git checkout | 0123456');
});

test('a function body with Rust-like text is not a row of its own', () => {
  const intent = describeShell('f() { let x: Vec<u8> = vec![]; println!("{}", x.len()); }; f');
  assert.equal(intent.label, 'f');
  assert.equal(intent.object, 'shell function');
});

test('a wait whose log shows a test summary keeps the wait apart from the check', () => {
  const intent = describeShell('for i in $(seq 1 58); do grep -q "^DONE" /tmp/final2.log && break; sleep 10; done; tail -5 /tmp/final2.log', '  3 failed\n  870 passed (2m)\n');
  assert.deepEqual(parts(intent, 'verb', 'label'), { verb: 'Waited for', label: 'final2.log' });
  assert.match(intent.object, /^to contain "\^DONE"/);
  assert.deepEqual(intent.check, { kind: 'test', failed: true, waited: true });
});

test('a failure printed by a later step never marks an earlier destructive step as not run', () => {
  const failing = 'not ok 1 - adds\n# tests 3\n# pass 2\n# fail 1\n';
  for (const command of ['cd /repo && git worktree remove --force /tmp/pc-base; npx playwright test', 'git fetch && git reset --hard origin/main; npm test']) {
    const intent = describeShell(command, failing, { nonzero: true });
    assert.equal(intent.destructive, true, command);
    assert.equal(intent.notRun, undefined, command);
  }
  // `cd` printing nothing it can be blamed for leaves a later delete in place.
  assert.equal(describeShell('cd /repo && rm -rf ~/x', 'fatal: unrelated\n').notRun, undefined);
});

test('a nonzero exit alone never proves a destructive step was skipped', () => {
  assert.equal(describeShell('D=.work/p && rm -rf $D/hi && node .work/snap.mjs', 'Traceback (most recent call last):\n', { nonzero: true }).notRun, undefined);
  for (const [command, output] of [
    ['cd ~/proj && rm -rf ~/Documents/old', 'rm: /Users/x/Documents/old/locked: Permission denied\n'],
    ['git pull && rm -rf ~/cache', 'Already up to date.\nrm: x: Operation not permitted\n'],
    ['ls && rm -rf ~/Documents/old', 'Exit code 1'],
    ['npm test && git push --force', ''],
  ]) {
    const intent = describeShell(command, output, { nonzero: true });
    assert.equal(intent.destructive, true, command);
    assert.equal(intent.notRun, undefined, command);
    assert.ok(intent.risks.length, command);
  }
  assert.equal(describeShell('cd ~/proj && rm -rf ~/Documents/old', 'rm: x: Permission denied\n', { nonzero: true }).verb, 'Deleted');
  assert.equal(describeShell('git pull && rm -rf ~/cache', 'Already up to date.\nrm: x: Operation not permitted\n', { nonzero: true }).verb, 'Deleted');
  // The deleter's own error line proves it ran, whatever an earlier step printed.
  assert.equal(describeShell('npm test && rm -rf ~/x', 'not ok 1\n# fail 1\nrm: ~/x/a: Permission denied\n', { nonzero: true }).notRun, undefined);
});

test('status no-ops, touches and /dev/null reads never lead real work', () => {
  assert.equal(describeShell('uptime && cargo build').verb, 'Built');
  assert.equal(describeShell('uptime; git status').label, 'git status');
  assert.deepEqual(parts(describeShell('touch src/lib.rs && cargo clippy --all-targets -- -D warnings'), 'verb', 'label'), { verb: 'Linted', label: 'cargo clippy' });
  assert.equal(describeShell('sed -n 1p /dev/null; grep -rn foo src').verb, 'Searched');
});

test('labels keep `..`, drop `.` and never show an unresolved variable', () => {
  assert.equal(row('rm -rf ../sibling'), 'Deleted | ../sibling | ');
  assert.equal(row('find . -name "*.ts" -delete'), 'Deleted | files | matching *.ts');
  assert.equal(row("find src -name '*.ts' -delete"), 'Deleted | files | matching *.ts in src');
  const variable = describeShell('rm -rf $D');
  assert.deepEqual(parts(variable, 'verb', 'label', 'destructive', 'title'), { verb: 'Deleted', label: 'files', destructive: true, title: 'rm -rf $D' });
  assert.ok(!describeShell('ls $d').label.includes('$'));
  assert.ok(!/\$d/.test(row('for d in $(ls); do ls $d; done')));
  assert.equal(row('lsof -p 123 -a -d cwd'), 'Checked open files | lsof | ');
  assert.equal(row('sleep 3 && lsof -i :3000'), 'Checked open files | lsof | on :3000 · after 3s');
  assert.equal(row('go test ./...'), 'Ran tests | go test | ');
  assert.equal(row('go test ./pkg/...'), 'Ran tests | go test | ./pkg/...');
  assert.ok(SHELL_VERBS.includes('Checked open files'));
});

test('a missing wrapper program keeps the inner command and names the wrapper', () => {
  for (const output of ['zsh: command not found: timeout\n', 'bash: timeout: command not found\n', 'timeout: command not found\n']) {
    const intent = describeShell('timeout 60 cargo test', output, { nonzero: true });
    assert.deepEqual(parts(intent, 'verb', 'label', 'missing'), { verb: 'Ran tests', label: 'cargo test', missing: 'timeout' }, output);
  }
  assert.equal(describeShell('timeout 60 cargo test', 'test result: ok. 3 passed; 0 failed\n').missing, undefined);
  assert.equal(describeShell('cargo test', 'zsh: command not found: timeout\n').missing, undefined);
});

test('loop counters and inline code never read as item counts', () => {
  assert.ok(!/items?\b/.test(row('for i in 1 2 3 4; do git show HEAD~$i --stat; done')));
  assert.equal(row('python3 -c "x = 1 +4"; ls'), 'Ran script | python3 | x = 1 +4 · +1 more command');
});
