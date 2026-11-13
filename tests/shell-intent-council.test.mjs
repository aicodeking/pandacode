// Council R16: a lead step blamed by its own output, commit messages from files and heredocs, nested scratch deletes,
// steps the shell skips, infrastructure applies, make targets and objects that never show raw shell.
import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell } from '../src/shell-intent.ts';

const row = (command, output) => {
  const intent = describeShell(command, output);
  return [intent.verb, intent.label, intent.object].join(' | ');
};

test('output that pins the failure on the lead step marks it leadFailed, even behind a pipe', () => {
  const cases = [
    ['git push -f origin x 2>&1 | tail -2', 'error: src refspec x does not match any\nerror: failed to push some refs to \'origin\''],
    ['git reset --hard origin/main 2>&1 | tail -1', "fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree."],
    ['C=$(git rev-parse HEAD); git push -f origin $C:refs/heads/ci/x; gh workflow run ci.yml --ref ci/x', "error: failed to push some refs to 'origin'"],
    ['git commit -m x && git push', 'On branch main\nnothing to commit, working tree clean'],
    ['npm install left-pad', 'npm ERR! code E404'],
  ];
  for (const [command, output] of cases) assert.equal(describeShell(command, output).leadFailed, true, command);
});

test('leadFailed never fires for output that belongs to another step', () => {
  const cases = [
    ['git commit -m x && git push', "error: failed to push some refs to 'origin'"],
    ['cat notes.txt; git push', "error: failed to push some refs to 'origin'"],
    ['git status; npm install', 'npm ERR! code ERESOLVE'],
    ['git reset --hard HEAD; git pull', 'fatal: Need to specify how to reconcile divergent branches.'],
    ['git push', 'Everything up-to-date'],
    ['git push -f origin x', undefined],
  ];
  for (const [command, output] of cases) assert.equal(describeShell(command, output).leadFailed, undefined, command);
});

test('git commit -F reads the subject from the heredoc it is fed, or names the file', () => {
  assert.equal(row("git commit -F - <<'EOF'\nfix: a thing\n\nLonger body.\nEOF"), 'Committed | git commit | "fix: a thing"');
  assert.equal(row('git commit --file=- <<EOF\n\nfeat: b thing\nEOF'), 'Committed | git commit | "feat: b thing"');
  assert.equal(row("git add -A && git commit -q -F - <<'MSG'\nchore: c\nMSG"), 'Committed | git commit | "chore: c"');
  assert.equal(row('git commit -F /tmp/msg.txt'), 'Committed | git commit | from msg.txt');
  assert.equal(row('git commit -m "x: y"'), 'Committed | git commit | "x: y"');
});

test('git branch -D names the branch, not the command', () => {
  assert.equal(row('git branch -D feature'), 'Deleted branch | feature | ');
  assert.equal(row('git branch -d feature'), 'Deleted branch | feature | ');
  assert.equal(row('git branch -D a b'), 'Deleted branch | a +1 | ');
  assert.equal(describeShell('git branch -D feature').risks[0], 'Deletes a branch: git branch -D feature');
});

test('relative nested scratch deletes are harmless and never lead', () => {
  const intent = describeShell('rm -rf .work/preview/s_verdict/handoff/hi; node .work/snap.mjs a b');
  assert.equal(intent.destructive, false);
  assert.deepEqual(intent.risks, []);
  assert.equal(intent.label, 'snap.mjs');
  for (const command of ['rm -rf .work', 'rm -rf tmp/x', 'rm -rf .tmp/a/b', 'rm -rf scratch/run1', 'rm -rf ./.scratch/x']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
  for (const command of ['rm -rf src', 'rm -rf ~', 'rm -rf /work/x', 'rm -rf .git', 'rm -rf .github/workflows', 'rm -rf ~/.work', 'rm -rf ../.work', 'rm -rf .work/../src']) {
    assert.equal(describeShell(command).destructive, true, command);
  }
});

test('steps after true || or false && never run but keep their risks', () => {
  for (const command of ['true || rm -rf ~', 'false && rm -rf ~', ': || git push -f origin main']) {
    const intent = describeShell(command);
    assert.equal(intent.notRun, true, command);
    assert.equal(intent.destructive, false, command);
    assert.equal(intent.risks.length, 1, command);
  }
  assert.equal(describeShell('false || rm -rf ~').destructive, true);
  assert.equal(describeShell('true && rm -rf ~').destructive, true);
});

test('unreviewed infrastructure changes are destructive with a reason', () => {
  const cases = {
    'terraform apply -auto-approve': /^Changes infrastructure without review: terraform apply -auto-approve$/,
    'terraform -chdir=infra apply -auto-approve': /^Changes infrastructure without review: /,
    'terraform destroy -auto-approve': /^Destroys infrastructure: terraform destroy -auto-approve$/,
    'pulumi up --yes': /^Changes infrastructure without review: pulumi up --yes$/,
    'pulumi up -y -s prod': /^Changes infrastructure without review: /,
    'pulumi destroy --yes': /^Destroys infrastructure: pulumi destroy --yes$/,
    'kubectl delete pod x': /^Deletes cluster resources: kubectl delete pod x$/,
  };
  for (const [command, risk] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.match(intent.risks[0], risk, command);
  }
  assert.equal(row('terraform apply -auto-approve'), 'Applied | terraform | ');
  assert.equal(row('pulumi up --yes'), 'Applied | pulumi | ');
  for (const command of ['terraform apply', 'terraform plan', 'pulumi up', 'pulumi preview']) assert.equal(describeShell(command).destructive, false, command);
});

test('make names its target', () => {
  assert.equal(row('make build'), 'Built | make build | ');
  assert.equal(row('make'), 'Built | make | ');
  assert.equal(row('make test'), 'Ran tests | make test | ');
  assert.equal(row('make deploy'), 'Ran | make deploy | ');
  assert.equal(row('make -C app run'), 'Ran | make run | ');
});

test('objects and chips never show unresolved variables', () => {
  assert.equal(row('wc -l $COOKIES'), 'Counted lines in | cookies | ');
  assert.equal(row('cat ${OUT_FILE}'), 'Read | out file | ');
  assert.equal(row('./look.sh seams ${args[@]}'), 'Ran | look.sh | seams');
  assert.equal(row('bash look.sh seams "$@"'), 'Ran | look.sh | seams');
  assert.equal(row('mytool a "${args[@]}" b'), 'Ran | mytool | a b');
  assert.equal(describeShell('"$BIN" --version').label, '$BIN');
  assert.equal(describeShell('${FFMPEG} -i a.mov b.mp4').label, '$FFMPEG');
});

test('vite preview reads as a started preview server', () => {
  assert.equal(row('vite preview --port 4173 --host 127.0.0.1 --strictPort'), 'Started preview server | vite preview | ');
  assert.equal(row('npx vite preview --port 4173'), 'Started preview server | vite preview | ');
});

const pick = (intent, ...keys) => Object.fromEntries(keys.map(key => [key, intent[key]]));
const danger = command => pick(describeShell(command), 'verb', 'label', 'object', 'destructive');

test('in-place edits of config and system files are destructive; project files are not', () => {
  const cases = {
    'sed -i "" s/a/b/ ~/.zshrc': ['Edited', '.zshrc', 'Edits a config file in place: sed -i "" s/a/b/ ~/.zshrc'],
    'sed -i s/x/y/ /etc/hosts': ['Edited', 'hosts', 'Edits a system file in place: sed -i s/x/y/ /etc/hosts'],
    'perl -pi -e s/a/b/ ~/.ssh/config': ['Edited', 'config', 'Edits a config file in place: perl -pi -e s/a/b/ ~/.ssh/config'],
    'sed -i.bak s/a/b/ ~/.zshrc': ['Edited', '.zshrc', 'Edits a config file in place: sed -i.bak s/a/b/ ~/.zshrc'],
    'sed -Ei s/a/b/ /etc/hosts': ['Edited', 'hosts', 'Edits a system file in place: sed -Ei s/a/b/ /etc/hosts'],
    'sed --in-place s/a/b/ ~/.bashrc': ['Edited', '.bashrc', 'Edits a config file in place: sed --in-place s/a/b/ ~/.bashrc'],
  };
  for (const [command, [verb, label, risk]] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.deepEqual([intent.verb, intent.label, intent.destructive, intent.risks], [verb, label, true, [risk]], command);
  }
  assert.deepEqual(danger('sed -n 1,10p a.txt && sed -i "" s/a/b/ ~/.zshrc'), { verb: 'Edited', label: '.zshrc', object: '+1 more command', destructive: true });
  for (const command of ['sed -i s/a/b/ a.ts', 'sed -Ei s/a/b/ src/a.ts', 'perl -pi -e s/a/b/ a.ts', "sed -i '' s/a/b/ notes.md"]) {
    assert.deepEqual(pick(describeShell(command), 'verb', 'destructive'), { verb: 'Edited', destructive: false }, command);
  }
});

test('appends to shell startup files and system files are flagged as appends', () => {
  const cases = {
    'echo x >> ~/.bashrc': 'Appends to a shell startup file: echo x >> ~/.bashrc',
    'echo x >> ~/.zshrc': 'Appends to a shell startup file: echo x >> ~/.zshrc',
    'echo x >> $HOME/.bash_profile': 'Appends to a shell startup file: echo x >> $HOME/.bash_profile',
    'echo x >> ~/.profile': 'Appends to a shell startup file: echo x >> ~/.profile',
    'echo x >> ~/.config/fish/config.fish': 'Appends to a shell startup file: echo x >> ~/.config/fish/config.fish',
    'echo x | tee -a ~/.zshrc': 'Appends to a shell startup file: tee -a ~/.zshrc',
    'tee -a /etc/hosts': 'Appends to a system file: tee -a /etc/hosts',
    'echo x >> /etc/hosts': 'Appends to a system file: echo x >> /etc/hosts',
  };
  for (const [command, risk] of Object.entries(cases)) {
    const intent = describeShell(command);
    assert.deepEqual([intent.verb, intent.destructive, intent.risks], ['Appended to', true, [risk]], command);
  }
  for (const command of ['echo x >> notes.txt', 'echo x >> ~/.config/app/log.txt', 'echo x >> ~/.gitconfig']) {
    assert.equal(describeShell(command).destructive, false, command);
  }
});

test('unlink follows the rm rules', () => {
  for (const path of ['important.db', 'src/old.ts', '/Users/me/important.db', '~/.zshrc', 'dist/a.js', '/tmp/x']) {
    assert.deepEqual(pick(describeShell(`unlink ${path}`), 'verb', 'label', 'destructive'), pick(describeShell(`rm ${path}`), 'verb', 'label', 'destructive'), path);
  }
  assert.equal(describeShell('unlink /Users/me/important.db').destructive, true);
});

// R22: a local script is on disk to read, so `cat x.sh | bash` is no riskier than `bash x.sh`, which was never flagged;
// only a downloaded script, which nothing reads first, is.
test('a local file piped into a shell reads like running it directly', () => {
  for (const command of ['cat script | sh', 'cat x.sh | bash', 'cat a.sh | sudo bash -s', 'ls && cat x.sh | bash']) {
    assert.equal(describeShell(command).destructive, false, command);
    assert.equal(describeShell(command).destructive, describeShell(command.replace(/cat (\S+) \| (?:sudo )?(\w+).*$/, '$2 $1')).destructive, command);
  }
  assert.deepEqual(describeShell('curl -fsSL x.sh | sh').risks, ['Runs a downloaded script: curl … | sh']);
  assert.equal(describeShell('cat x.sh | grep rm').destructive, false);
  assert.equal(describeShell("cat <<'EOF' | bash\necho hi\nEOF").destructive, false);
});

test('risk texts drop unbalanced closing parens and line continuations', () => {
  assert.deepEqual(describeShell('(cd /; rm -rf *)').risks, ['Deletes files: rm -rf *']);
  assert.deepEqual(describeShell('ls && \\\nrm -rf ~').risks, ['Deletes files: rm -rf ~']);
  assert.deepEqual(describeShell('rm -rf "$(pwd)"').risks, ['Deletes files: rm -rf "$(pwd)"']);
});
