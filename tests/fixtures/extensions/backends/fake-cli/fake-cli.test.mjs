import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { program, control } from '../test-support.mjs';

test('B2 every CLI command shares B1 state, including conflicts and chunked reads', async t => {
  const daemon = program(t, './fake-daemon/fake-daemon.mjs'), ready = await daemon.out.next(x => x.ready);
  const cli = async (...command) => {
    const result = await program(t, './fake-cli/fake-cli.mjs', ['--daemon', ready.socket, '--json', ...command]).exited;
    return { ...result, value: JSON.parse(result.stdout) };
  };
  assert.equal((await cli('version')).value.server, 'fake-daemon');
  const first = (await cli('create', '--title=First 🐼', '--type=bug', '--priority=1')).value;
  const second = (await cli('create', '--title=Second')).value;
  assert.equal((await cli('dep', 'add', second.id, first.id)).code, 0);
  assert.equal((await cli('blocked')).value[0].id, second.id);
  assert.equal((await cli('ready')).value[0].id, first.id);
  assert.equal((await cli('claim', `--id=${first.id}`, '--actor=fixture')).value.assignee, 'fixture');
  assert.equal((await cli('update', `--id=${first.id}`, '--title=Changed')).value.title, 'Changed');
  const closed = (await cli('close', `--id=${first.id}`, '--reason=done')).value;
  await cli('comment', first.id, 'comment with spaces');
  const conflict = await cli('reopen', `--id=${first.id}`, `--if-revision=${closed.revision}`);
  assert.equal(conflict.code, 1); assert.equal(conflict.value.error.code, 'Conflict');
  assert.equal((await cli('reopen', `--id=${first.id}`)).value.status, 'open');
  assert.equal((await cli('show', `--id=${first.id}`)).value.comments.length, 1);
  assert.equal((await cli('list', '--status=open')).value.length, 2);
  await control(ready.control, 'issues/fill', { count: 2000 });
  assert.equal((await cli('list')).value.length, 2000);
  assert.equal((await cli('show', '--id=missing')).code, 1);
});

test('B2 usage, unreachable, injected failure, delay cancellation and valid padded JSON', async t => {
  const daemon = program(t, './fake-daemon/fake-daemon.mjs'), ready = await daemon.out.next(x => x.ready);
  const invocation = ['--daemon', ready.socket, '--json', 'version'];
  assert.equal((await program(t, './fake-cli/fake-cli.mjs', ['--json', 'wat']).exited).code, 2);
  assert.equal((await program(t, './fake-cli/fake-cli.mjs', ['--daemon', ready.socket, '--json', 'claim', '--id=x']).exited).code, 2);
  const fail = await program(t, './fake-cli/fake-cli.mjs', invocation, { FAKE_CLI_FAIL: 'InjectedCode' }).exited;
  assert.equal(fail.code, 1); assert.equal(JSON.parse(fail.stdout).error.code, 'InjectedCode');
  const padded = await program(t, './fake-cli/fake-cli.mjs', invocation, { FAKE_CLI_PAD_BYTES: '70000' }).exited;
  assert.equal(padded.code, 0); assert.equal(JSON.parse(padded.stdout).server, 'fake-daemon'); assert(Buffer.byteLength(padded.stdout) > 70000);
  const delayed = program(t, './fake-cli/fake-cli.mjs', invocation, { FAKE_CLI_DELAY_MS: '60000' });
  delayed.child.stdin.end(); assert.equal((await delayed.exited).code, 3);
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  assert.equal((await program(t, './fake-cli/fake-cli.mjs', ['--daemon', `127.0.0.1:${port}`, '--json', 'version']).exited).code, 3);
});
