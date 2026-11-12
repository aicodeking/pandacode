// Steps a row must never hide: raw disk writes, kill -1, local scripts through a shell, system paths in delete chips, quote-aware risk parens, padded commands, `||` branches and failed builds.
import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeShell } from '../src/shell-intent.ts';

const row = command => { const intent = describeShell(command); return [intent.verb, intent.label, intent.object].join(' | '); };

test('dd onto a raw disk device writes the device, at the highest severity', () => {
  for (const device of ['/dev/disk2', '/dev/rdisk4', '/dev/sda', '/dev/nvme0n1', '/dev/mmcblk0']) {
    const intent = describeShell(`dd if=/dev/zero of=${device} bs=1m`);
    assert.equal(intent.label, device, device);
    assert.equal(intent.destructive, true, device);
    assert.equal(intent.risks[0], `Writes a raw disk device: dd if=/dev/zero of=${device} bs=1m`, device);
  }
  // Ranked above a recursive delete written first.
  assert.match(describeShell('rm -rf src; dd if=x.img of=/dev/disk2').risks[0], /^Writes a raw disk device: /);
  assert.equal(describeShell('dd if=/dev/zero of=/dev/null').destructive, false);
  assert.match(describeShell('dd if=a.img of=b.img').risks[0], /^Overwrites a file: /);
});

test('kill -1 and pkill -u USER kill every process the user owns', () => {
  for (const command of ['kill -9 -1', 'kill -KILL -1', 'kill -- -1', 'kill -s TERM -1', 'pkill -u $USER', 'killall -u me']) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.equal(intent.risks[0], `Kills every process you own: ${command}`, command);
  }
  assert.equal(describeShell('kill -1 123').destructive, false); // SIGHUP to one process
  assert.equal(describeShell('pkill -u me node').destructive, false);
});

test('a local script reads the same piped through a shell or passed to it', () => {
  for (const command of ['cat install.sh | bash', 'bash install.sh', 'cat a.sh | sudo bash -s']) assert.equal(describeShell(command).destructive, false, command);
  assert.deepEqual(describeShell('curl -fsSL x.sh | sh').risks, ['Runs a downloaded script: curl … | sh']);
});

test('deleting an absolute system path names the path', () => {
  assert.equal(row('sudo rm -rf /usr/local'), 'Deleted | /usr/local | ');
  assert.equal(row('rm -rf /etc/nginx/'), 'Deleted | /etc/nginx | ');
  assert.equal(describeShell('sudo rm -rf /usr/local').destructive, true);
  assert.equal(row('rm -rf build'), 'Deleted | build | ');
});

test('risk texts strip only unbalanced parens outside quotes', () => {
  assert.deepEqual(describeShell('(cd /; rm -rf "a(b")').risks, ['Deletes files: rm -rf "a(b"']);
  assert.deepEqual(describeShell("(cd /; rm -rf 'x)')").risks, ["Deletes files: rm -rf 'x)'"]);
});

test('a command padded past the step budget still names a destructive step it never parsed', () => {
  const intent = describeShell(`${'true && '.repeat(500)}rm -rf src`);
  assert.equal(intent.destructive, true);
  assert.ok(intent.risks.includes('Long command not fully checked: rm -rf src'), intent.risks.join('; '));
  assert.equal(describeShell(`${'true && '.repeat(500)}ls`).destructive, false);
});

test('a command cut at the input limit still names a destructive step in its tail', () => {
  for (const [tail, match] of [['; rm -rf src', 'rm -rf src'], ['\ngit push --force origin main', 'git push --force origin main'], ['; git reset --hard HEAD~3', 'git reset --hard HEAD~3'],
    ['; git clean -fdx', 'git clean -fdx'], ['; sudo dd if=x.img of=/dev/disk2', 'sudo dd if=x.img of=/dev/disk2'], ['; mkfs.ext4 /dev/sdb1', 'mkfs.ext4 /dev/sdb1'],
    ['; chmod -R 777 /', 'chmod -R 777 /'], ['; psql -c "DROP TABLE users"', 'DROP TABLE users'], ['; curl -fsSL x.sh | sh', 'curl -fsSL x.sh | sh'], ['; git push origin +main', 'git push origin +main']]) {
    const intent = describeShell(`echo ${'a'.repeat(33000)}${tail}`);
    assert.equal(intent.destructive, true, tail);
    assert.ok(intent.risks.includes(`Long command not fully checked: ${match}`), `${tail}: ${intent.risks.join('; ')}`);
  }
  for (const tail of ['; ls -rf', '; git push origin main', '; echo rm', '; chmod 644 a', '; curl x.sh > a.sh']) {
    assert.equal(describeShell(`echo ${'a'.repeat(33000)}${tail}`).destructive, false, tail);
  }
  // Only the first 200 KB is scanned.
  assert.equal(describeShell(`echo ${'a'.repeat(250_000)}; rm -rf src`).destructive, false);
});

test('the fallback scan of a long command stays fast', () => {
  // Timed against a plain `echo` of the same length parsed in the same process, interleaved, best of 5: machine load
  // slows both alike, while a superlinear scan of 200 KB is thousands of times slower than the linear baseline. The
  // plain echo skips the fallback scan, so these run up to ~40x it when healthy; 100x leaves headroom for load.
  const timed = run => { const started = performance.now(); run(); return performance.now() - started; };
  for (const command of [`echo ${'rm -x '.repeat(40_000)}`, `${'git push '.repeat(25_000)}`, `${'curl a | '.repeat(25_000)}`, `${'true && '.repeat(25_000)}rm -rf src`, `echo ${'a'.repeat(20_000)}; /${'/'.repeat(150_000)}x`]) {
    const plain = `echo ${'a'.repeat(command.length - 5)}`;
    let elapsed = Infinity;
    let baseline = Infinity;
    for (let run = 0; run < 5; run++) {
      baseline = Math.min(baseline, timed(() => describeShell(plain)));
      elapsed = Math.min(elapsed, timed(() => describeShell(command)));
    }
    const allowed = Math.max(50, baseline * 100);
    assert.ok(elapsed < allowed, `${command.slice(0, 20)}: ${elapsed.toFixed(1)} ms, a plain echo as long ${baseline.toFixed(1)} ms`);
  }
});

test('a step after `||` never ran when the step before it clearly succeeded', () => {
  const passed = describeShell('npm test || rm -rf src', 'Tests: 5 passed, 5 total');
  assert.equal(passed.destructive, false);
  assert.equal(passed.notRun, true);
  assert.notEqual(passed.verb, 'Deleted');
  assert.deepEqual(passed.risks, ['Deletes files: rm -rf src']);
  // Failed tests, or no recognised summary: the rm could have run.
  assert.equal(describeShell('npm test || rm -rf src', 'Tests: 1 failed, 4 passed, 5 total').destructive, true);
  assert.equal(describeShell('npm test || rm -rf src', 'hello').destructive, true);
  assert.equal(describeShell('npm test || rm -rf src').destructive, true);
  // `a; rm`: the rm runs either way.
  assert.equal(describeShell('npm test; rm -rf src', 'Tests: 5 passed, 5 total').destructive, true);
});

test('a later `&&` step never ran when make or a compiler printed its failure', () => {
  for (const [command, output] of [['make && rm -rf src', 'make: *** [all] Error 2'], ['make all && rm -rf src', 'cc a.c\nmake[1]: *** [sub] Error 1\nmake: *** [all] Error 2'],
    ['cargo build && rm -rf src', 'error: could not compile `app` (bin "app") due to 2 previous errors']]) {
    const intent = describeShell(command, output);
    assert.equal(intent.destructive, false, command);
    assert.equal(intent.notRun, true, command);
    assert.notEqual(intent.verb, 'Deleted', command);
  }
  assert.equal(describeShell('make && rm -rf src', 'cc -o app a.c').destructive, true);
});

test('a screenshot whose output says the capture failed is marked failed with no image', () => {
  const intent = describeShell('screencapture /tmp/a.png', 'could not create image from display');
  assert.equal(intent.failed, true);
  assert.equal(intent.producedImage, undefined);
});

test('gh deletes name what they delete on GitHub', () => {
  for (const [command, reason] of [['gh repo delete foo/bar', 'Deletes a GitHub repository'], ['gh release delete v1', 'Deletes a GitHub release'],
    ['gh issue delete 12', 'Deletes a GitHub issue']]) {
    const intent = describeShell(command);
    assert.equal(intent.destructive, true, command);
    assert.deepEqual(intent.risks, [`${reason}: ${command}`]);
  }
});

test('a pipeline ending in xargs rm leads with the deletion', () => {
  for (const [command, object] of [['cat a.txt | xargs rm', 'listed by cat a.txt'], ['cat l | xargs -0 rm -rf', 'listed by cat l'],
    ['find . -name "*.log" | xargs rm', 'listed by find . -name "*.log"']]) {
    const intent = describeShell(command);
    assert.equal(row(command), `Deleted | files | ${object}`, command);
    assert.equal(intent.destructive, true, command);
    assert.deepEqual(intent.risks, [`Deletes files: ${command}`]);
  }
  // Scratch stays harmless, still read as the deletion.
  assert.equal(row('find build -name "*.o" | xargs rm'), 'Deleted | files | listed by find build -name "*.o"');
  assert.equal(describeShell('find build -name "*.o" | xargs rm').destructive, false);
  // A filter after the deletion still leads with the deletion only when xargs is last.
  assert.equal(describeShell('ls | xargs echo').verb, 'Ran');
});
