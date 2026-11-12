// describeShell and testSummary stay fast on hostile input: no regex backtracks catastrophically and long compounds are bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell, testSummary } from '../src/shell-intent.ts';

const BUDGET_MS = 50;
const range = (count, map) => Array.from({ length: count }, (_, i) => map(i));

/** Each shape at full size; a small copy warms the JIT first so the budget measures growth, not compilation. */
const HOSTILE = {
  'dashes': n => '-'.repeat(n * 10),
  'ls with a dash run': n => `ls ${'-'.repeat(n * 10)}`,
  'nested parens': n => '('.repeat(n * 2),
  'balanced parens': n => `${'('.repeat(n * 2)}${')'.repeat(n * 2)}`,
  'double quotes': n => '"'.repeat(n * 2),
  'single quotes': n => "'".repeat(n * 2),
  'open substitutions': n => '$('.repeat(n * 2),
  'quoted substitutions': n => `echo ${'"$('.repeat(n * 2)}`,
  'backticks': n => '`'.repeat(n * 2),
  'parameters': n => '${'.repeat(n * 2),
  'brace lists': n => `echo ${'{a,'.repeat(n * 2)}`,
  'long command': n => `curl ${'x'.repeat(n * 40)}`,
  'long word list': n => `echo ${'a '.repeat(n * 20)}`,
  'flag bundle': n => `rm ${'-a-b-c'.repeat(n * 4)}`,
  'many flag tokens': n => `git log ${range(n, i => `-a-b-c${i}`).join(' ')}`,
  'heredocs': n => range(n, i => `cat <<E${i}\nx\nE${i}`).join('\n'),
  'pending heredocs': n => `cat ${'<<EOF '.repeat(n)}\n${'EOF\n'.repeat(n)}`,
  'python opens': n => `python3 - <<EOF\n${'open("'.repeat(n)}\nEOF`,
  'python system calls': n => `python3 -c "${"os.system('".repeat(n)}"`,
  'python argv lists': n => `python3 -c 'subprocess.run([${'"a",'.repeat(n * 2)}'`,
  'script screenshots': n => `node -e "${'p.screenshot({ a, '.repeat(n)}"`,
  'script saves': n => `python3 -c "${"im.save('".repeat(n)}"`,
  'git commit file heredoc': n => `git commit -F - <<EOF\n${'\n'.repeat(n * 4)}x\nEOF`,
  'sql drops': n => `sqlite3 a.db "${'DROP '.repeat(n * 2)}"`,
  'dollars': n => `echo ${'$'.repeat(n * 10)}`,
  'variables': n => `F=a; ${'echo $F'.repeat(n)}`,
  'semicolons': n => ';'.repeat(n * 10),
  'pipes': n => `cat a${' | grep x'.repeat(n)}`,
  'and chains': n => `true${' && ls'.repeat(n)}`,
  'newline steps': n => 'ls\n'.repeat(n * 4),
  'blank lines': n => `ls${'\n'.repeat(n * 10)}x`,
  'trailing blanks then Working directory': n => `ls${'\n'.repeat(n * 10)}Working directory: /x${' '.repeat(n * 10)}y`,
  'trailing slashes': n => `cd a${'/'.repeat(n * 10)}x && ls`,
  'trailing spaces before done': n => `for f in a; do cat $f${' '.repeat(n * 10)}x`,
  'test brackets': n => `[[ ${'[[ '.repeat(n * 2)}`,
  'backslashes': n => `echo ${'\\'.repeat(n * 10)}`,
  'function-like words': n => `${'a'.repeat(n * 2)} ${'a'.repeat(n * 2)}`,
  'git diff paths': n => `git diff main...HEAD -- ${range(n, i => `src/f${i}.ts`).join(' ')}`,
  'redirections': n => `foo ${'2>&1 '.repeat(n * 2)}`,
  'curl formats': n => `curl -w '${'%{'.repeat(n * 2)}' https://e.com`,
  'escaped newlines': n => `foo "${'\\n'.repeat(n * 4)}"`,
  'ps grep': n => `ps aux | grep ${'v'.repeat(n * 10)}`,
  'wrapper script args': n => `python3 verify.py ${'a '.repeat(n * 4)}npx playwright test`,
};

const SIZE = 5000;
const RUNS = 7;

/** The best of a few runs: a GC pause or a JIT tier-up is noise, a superlinear regex or loop is not. */
function fastest(run) {
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

for (const [name, build] of Object.entries(HOSTILE)) {
  test(`describeShell finishes under ${BUDGET_MS} ms: ${name}`, () => {
    for (const size of [50, 500, 500]) describeShell(build(size), build(size));
    const command = build(SIZE);
    assert.equal(typeof describeShell(command).verb, 'string');
    const elapsed = fastest(() => describeShell(command));
    assert.ok(elapsed < BUDGET_MS, `${name}: ${elapsed.toFixed(1)} ms for ${command.length} chars`);
  });
}

test('a 200 KB command and 5,000 heredocs stay within budget', () => {
  const huge = `echo ${'x'.repeat(200_000)}`;
  const heredocs = range(5000, i => `cat <<EOF${i}\nline\nEOF${i}`).join('\n');
  for (const command of [huge, heredocs]) {
    describeShell(command.slice(0, 20_000));
    const elapsed = fastest(() => describeShell(command));
    assert.ok(elapsed < BUDGET_MS, `${command.slice(0, 40)}: ${elapsed.toFixed(1)} ms`);
  }
});

test('hostile test output parses within budget', () => {
  const outputs = {
    'blank lines': '\n'.repeat(200_000),
    'digits': '1'.repeat(200_000),
    'spaced Tests line': `Tests ${' '.repeat(100_000)}x`,
    'spaced failure line': `● ${' '.repeat(100_000)}x\n`,
    'blank lines then Duration': `${'\n'.repeat(100_000)} Tests 1 passed (1)\n${'\n'.repeat(50_000)}`,
    'tabs': `${'\t'.repeat(100_000)}\n`,
  };
  for (const [name, output] of Object.entries(outputs)) {
    testSummary(output.slice(0, 10_000));
    const elapsed = fastest(() => { testSummary(output); describeShell('npm test', output); });
    assert.ok(elapsed < BUDGET_MS * 2, `${name}: ${elapsed.toFixed(1)} ms`);
  }
});

test('a compound too long to check reads as the raw command, still naming the risks it found', () => {
  const intent = describeShell(`rm -rf ~/src; ${'ls; '.repeat(3000)}`);
  assert.equal(intent.raw, true);
  assert.equal(intent.destructive, true);
  assert.match(intent.risks[0], /rm -rf ~\/src/);
});

test('a variable doubled over and over stays fast and its rm -rf stays destructive', () => {
  const doubled = k => `A=xxxxxxxxxx; ${'A=$A$A; '.repeat(k)}rm -rf $A`;
  describeShell(doubled(5));
  const command = doubled(40);
  const elapsed = fastest(() => describeShell(command));
  assert.ok(elapsed < BUDGET_MS, `doubled: ${elapsed.toFixed(1)} ms`);
  const intent = describeShell(command);
  assert.equal(intent.destructive, true);
  assert.equal(intent.verb, 'Deleted');
  assert.ok(intent.label.length < 200, intent.label.slice(0, 80));
});

test('many variables each under the cap share one expansion budget', () => {
  const names = range(5, i => `V${i}`);
  const words = range(400, i => `$${names[i % names.length]}`).join(' ');
  const command = `${names.map(name => `${name}=${'y'.repeat(3000)}`).join('; ')}; echo ${words}; rm -rf $V0`;
  describeShell(command);
  const elapsed = fastest(() => describeShell(command));
  assert.ok(elapsed < BUDGET_MS, `wide: ${elapsed.toFixed(1)} ms`);
  assert.equal(describeShell(command).destructive, true);
});

test('long pipelines, and-chains and newline runs stay within budget', () => {
  for (const [name, command] of [['a|', 'a|'.repeat(4096)], ['a&&', 'a&&'.repeat(5462)], ['x\\n', 'x\n'.repeat(2048)], ['python stages', 'python3 -c "open(\'a\',\'w\')"|'.repeat(300)]]) {
    describeShell(command.slice(0, 500), command.slice(0, 500));
    const elapsed = fastest(() => describeShell(command, command));
    assert.ok(elapsed < BUDGET_MS, `${name}: ${elapsed.toFixed(1)} ms for ${command.length} chars`);
  }
});

test('a pipeline past the stage cap still names a risk in its last stage', () => {
  assert.equal(describeShell(`${'cat a | '.repeat(200)}xargs rm -rf`).destructive, true);
});

test('repeated wrappers are stripped a bounded number of times', () => {
  for (const shape of ['xargs ', 'parallel ', 'sudo ', 'env ', 'timeout 1 ', 'nohup ']) {
    const command = `${shape.repeat(Math.ceil(4096 / shape.length))}rm -rf /`;
    describeShell(shape.repeat(50));
    const elapsed = fastest(() => describeShell(command));
    assert.ok(elapsed < BUDGET_MS, `${shape.trim()}: ${elapsed.toFixed(1)} ms`);
  }
});
