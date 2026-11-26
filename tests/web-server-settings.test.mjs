import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// web-server-settings.ts imports CSS and browser modules; stub them so its pure validators load in Node.
const hooks = `
const STUBS = { './web-server-settings.css': '', './dom': 'export const escape = v => String(v), icon = () => "", isImeKey = () => false, morph = () => {};', './error-text': 'export const errorText = e => String(e);', './tooltip': 'export const infoMark = () => "";' };
export async function resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/web-server-settings.ts') && specifier in STUBS) return { url: 'stub:' + specifier, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { parsePortInput, parseHostInput, parseAllowedHostsInput, MAX_PORT, MAX_ALLOWED_HOSTS, formatHost, isLoopbackHost, reachableSessionUrl, reachableDisplayUrl, movedSessionUrl } = await import('../src/web-server-settings.ts');

test('accepts every port from 0 (automatic) to 65535', () => {
  for (const port of [0, 80, 3000, 47322, 65535]) assert.deepEqual(parsePortInput(String(port)), { ok: true, port });
  assert.equal(MAX_PORT, 65535);
});

test('trims surrounding whitespace', () => {
  assert.deepEqual(parsePortInput('  8080 \t'), { ok: true, port: 8080 });
  assert.deepEqual(parsePortInput('\n0\n'), { ok: true, port: 0 });
});

test('leading zeros still name the same port', () => {
  assert.deepEqual(parsePortInput('0080'), { ok: true, port: 80 });
});

test('rejects empty and whitespace-only input', () => {
  for (const raw of ['', '   ', '\t']) {
    const result = parsePortInput(raw);
    assert.equal(result.ok, false);
    assert.match(result.error, /Enter a port/);
  }
});

test('rejects non-digits, negatives and decimals with the range hint', () => {
  for (const raw of ['abc', '-1', '80.5', '1e3', '+80', '80 81', '0x50']) {
    const result = parsePortInput(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.error, /between 0 and 65535 \(0 picks an open port automatically\)/, raw);
  }
});

test('rejects ports above 65535', () => {
  for (const raw of ['65536', '70000', '99999999999999999999']) {
    const result = parsePortInput(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.error, /too large/, raw);
  }
});

test('tolerates non-string input without throwing', () => {
  assert.equal(parsePortInput(undefined).ok, false);
  assert.equal(parsePortInput(null).ok, false);
});

test('formatHost brackets IPv6 literals once and leaves other hosts alone', () => {
  assert.equal(formatHost('::1'), '[::1]');
  assert.equal(formatHost('[::1]'), '[::1]');
  assert.equal(formatHost('fe80::1'), '[fe80::1]');
  assert.equal(formatHost('127.0.0.1'), '127.0.0.1');
  assert.equal(formatHost('0.0.0.0'), '0.0.0.0');
  assert.equal(formatHost('my-box.tail1234.ts.net'), 'my-box.tail1234.ts.net');
});

test('isLoopbackHost knows the local-only addresses', () => {
  for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1', '']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '100.64.0.7', 'my-box.tail1234.ts.net']) assert.equal(isLoopbackHost(host), false, host);
});

test('isLoopbackHost accepts IPv4-mapped loopback (::ffff:127.x.y.z) like Rust', () => {
  for (const host of ['::ffff:127.0.0.2', '::FFFF:127.255.255.254', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['::ffff:128.0.0.1', '::ffff:192.168.1.2', '::ffff:127.0.0.256', '::ffff:']) assert.equal(isLoopbackHost(host), false, host);
});

test('isLoopbackHost covers all of 127.0.0.0/8, like Rust is_loopback()', () => {
  for (const host of ['127.0.0.2', '127.255.255.254', '127.1.2.3', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['127.0.0.256', '127.0.1', '128.0.0.1', '127.0.0.1.5', '1127.0.0.1', '127.00.0.1x']) assert.equal(isLoopbackHost(host), false, host);
});

test('reachableSessionUrl keeps the browser tab\'s origin (an SSH tunnel) with the token', () => {
  const tokenUrl = 'http://127.0.0.1:8787/#token=abc123';
  assert.equal(reachableSessionUrl(tokenUrl, 'http://127.0.0.1:9000', true), 'http://127.0.0.1:9000/#token=abc123');
  assert.equal(reachableSessionUrl(tokenUrl, 'http://my-box.tail1234.ts.net:8787', true), 'http://my-box.tail1234.ts.net:8787/#token=abc123');
  assert.equal(reachableSessionUrl(tokenUrl, 'https://pc.example.com', true), 'https://pc.example.com/#token=abc123');
});

test('reachableSessionUrl in the desktop app keeps the server link', () => {
  const tokenUrl = 'http://127.0.0.1:8787/#token=abc123';
  assert.equal(reachableSessionUrl(tokenUrl, 'tauri://localhost', false), tokenUrl);
  assert.equal(reachableSessionUrl(tokenUrl, 'http://127.0.0.1:9000', false), tokenUrl);
});

test('reachableSessionUrl ignores an origin that is not plain http(s)', () => {
  const tokenUrl = 'http://127.0.0.1:8787/#token=abc123';
  for (const origin of ['tauri://localhost', 'null', '', 'http://127.0.0.1:9000/path', 'javascript:alert(1)']) assert.equal(reachableSessionUrl(tokenUrl, origin, true), tokenUrl, origin);
});

test('reachableDisplayUrl follows the same rule', () => {
  assert.equal(reachableDisplayUrl('http://127.0.0.1:8787', 'http://127.0.0.1:9000', true), 'http://127.0.0.1:9000');
  assert.equal(reachableDisplayUrl('http://127.0.0.1:8787', 'http://127.0.0.1:9000', false), 'http://127.0.0.1:8787');
  assert.equal(reachableDisplayUrl('http://127.0.0.1:8787', 'null', true), 'http://127.0.0.1:8787');
});

test('movedSessionUrl keeps the tab\'s host on the new port', () => {
  assert.equal(movedSessionUrl(9200, 'http://127.0.0.1:9200/#token=t1', { protocol: 'http:', hostname: 'my-box.local' }), 'http://my-box.local:9200/#token=t1');
  assert.equal(movedSessionUrl(9200, 'http://[::1]:9200/#token=t1', { protocol: 'http:', hostname: '::1' }), 'http://[::1]:9200/#token=t1');
});

test('parseHostInput accepts IPv4 and IPv6 literals, bracketed or bare', () => {
  for (const [raw, host] of [
    ['127.0.0.1', '127.0.0.1'],
    ['  100.101.102.103 \t', '100.101.102.103'],
    ['0.0.0.0', '0.0.0.0'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[2001:DB8::1]', '2001:db8::1'],
    ['fe80::1', 'fe80::1'],
    ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:1'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
  ]) assert.deepEqual(parseHostInput(raw), { ok: true, host }, raw);
});

test('parseHostInput treats empty input as the loopback default', () => {
  for (const raw of ['', '   ', '\t\n']) assert.deepEqual(parseHostInput(raw), { ok: true, host: '127.0.0.1' }, JSON.stringify(raw));
});

test('parseHostInput rejects text, host names and malformed addresses', () => {
  for (const raw of ['abc', 'localhost', '1.2.3.4.5', '[::1', '::1]', '[::1]:8080', '1.2.3.256', '127.00.0.1', '127.0.0.1:80']) {
    const result = parseHostInput(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.error, /is not an IP address \(for example 127\.0\.0\.1 or ::1\)/, raw);
  }
});

test('parseHostInput tolerates non-string input without throwing', () => {
  for (const raw of [undefined, null, 42, {}]) assert.equal(parseHostInput(raw).ok, false, String(raw));
});

test('parseAllowedHostsInput splits on commas, spaces and newlines', () => {
  assert.deepEqual(parseAllowedHostsInput('my-mac.tail1234.ts.net, Other-Box.tail5678.ts.net\nthird-host'), {
    ok: true,
    hosts: ['my-mac.tail1234.ts.net', 'other-box.tail5678.ts.net', 'third-host'],
  });
});

test('parseAllowedHostsInput lowercases, trims and de-duplicates', () => {
  assert.deepEqual(parseAllowedHostsInput('  A.TS.net,a.ts.net,\tB.ts.net  '), { ok: true, hosts: ['a.ts.net', 'b.ts.net'] });
});

test('parseAllowedHostsInput allows an empty list and a bracketed IPv6 literal', () => {
  for (const raw of ['', '   ', ' , \n\t ']) assert.deepEqual(parseAllowedHostsInput(raw), { ok: true, hosts: [] }, JSON.stringify(raw));
  assert.deepEqual(parseAllowedHostsInput('[::1]'), { ok: true, hosts: ['[::1]'] });
});

test('parseAllowedHostsInput rejects URLs, paths, userinfo and ports', () => {
  for (const raw of ['https://my-mac.tail1234.ts.net', 'my-mac.tail1234.ts.net/path', 'my-mac.tail1234.ts.net:8080', 'user@my-mac.tail1234.ts.net', 'my-mac.tail1234.ts.net?x=1', 'my-mac.tail1234.ts.net#frag', 'my\\mac', '[::1]:8080']) {
    const result = parseAllowedHostsInput(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.error, /(URL|not a host name|includes a port)/, raw);
  }
});

test('parseAllowedHostsInput caps the list after de-duplicating', () => {
  assert.equal(MAX_ALLOWED_HOSTS, 8);
  const names = Array.from({ length: MAX_ALLOWED_HOSTS }, (_, index) => `host-${index}.ts.net`);
  assert.deepEqual(parseAllowedHostsInput(names.join(', ')), { ok: true, hosts: names });
  assert.deepEqual(parseAllowedHostsInput([...names, names[0]].join(', ')), { ok: true, hosts: names });
  const tooMany = parseAllowedHostsInput([...names, 'one-too-many.ts.net'].join(', '));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /at most 8 trusted host names/);
});

test('parseAllowedHostsInput tolerates non-string input without throwing', () => {
  for (const raw of [undefined, null, 42, {}]) assert.equal(parseAllowedHostsInput(raw).ok, false, String(raw));
});
