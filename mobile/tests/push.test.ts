// Push registration payloads and the relay's answer classification (src/connect/push.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRegister, REGISTER_PATH, registerBody, unregisterBody } from '../src/connect/push.ts';

test('the register body is platform and token only: the relay never learns task content', () => {
  assert.deepEqual(registerBody('ios', 'a'.repeat(64)), { platform: 'ios', token: 'a'.repeat(64) });
  const long = registerBody('android', 'x'.repeat(4000));
  assert.equal(long.token.length, 512); // tokens are bounded before they hit the wire
});

test('unregister carries the same shape', () => {
  assert.deepEqual(unregisterBody('ios', 'tok'), { platform: 'ios', token: 'tok' });
});

test('a relay without the endpoint classifies as unsupported (404, 405, 501); silence, then retry next launch', () => {
  for (const status of [200, 201, 204]) assert.equal(classifyRegister(status), 'enrolled');
  for (const status of [404, 405, 501]) assert.equal(classifyRegister(status), 'unsupported');
  for (const status of [400, 401, 403, 429, 500, 503]) assert.equal(classifyRegister(status), 'error');
});

test('the registration path is stable: it is the contract the proposal names', () => {
  assert.equal(REGISTER_PATH, '/v1/push/devices');
});
