import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { body, listen, listener } from '../common.mjs';
import { control, evidence, program } from '../test-support.mjs';

test('B4 follows cloud authorize to a real loopback callback without opening a browser', async t => {
  const requests = [];
  const callback = listener(async (req, res) => { requests.push(req.url); await body(req); res.end('signed in'); });
  t.after(callback.close); const redirect = `${await listen(callback.server)}/callback`;
  const cloud = program(t, './fake-cloud/fake-cloud.mjs'), ready = await cloud.out.next(x => x.ready);
  const url = new URL('/authorize', ready.identity);
  url.search = new URLSearchParams({ response_type: 'code', client_id: 'fixture', redirect_uri: redirect, state: 'canary-state', code_challenge: 'fixture-challenge', code_challenge_method: 'S256', scope: 'profile' });
  const result = await program(t, './fake-browser/fake-browser.mjs', [url.href]).exited;
  assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0], redirect).searchParams.get('state'), 'canary-state');
  await control(ready.control, 'mode', { authorize: 'deny' });
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [url.href]).exited).code, 0);
  assert.match(requests[1], /error=access_denied/);
});

test('B4 ignore, record, five redirects, outside redirect rejection and EOF cancel', async t => {
  const requests = [];
  const server = listener(async (req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/hang') return;
    if (url.pathname === '/outside') { res.writeHead(302, { location: 'https://example.test/' }); res.end(); return; }
    const n = Number(url.searchParams.get('n') ?? 0);
    if (n > 0) res.writeHead(302, { location: `/?n=${n - 1}` });
    res.end('done');
  });
  t.after(server.close); const url = await listen(server.server), file = await evidence('browser-urls.log');
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [url], { FAKE_BROWSER: 'ignore' }).exited).code, 0);
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [url], { FAKE_BROWSER: 'record', FAKE_BROWSER_LOG: file }).exited).code, 0);
  assert.equal(requests.length, 0); assert.equal((await readFile(file, 'utf8')).trim().split('\n').at(-1), url);
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [`${url}/?n=5`]).exited).code, 0);
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [`${url}/?n=6`]).exited).code, 1);
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', [`${url}/outside`]).exited).code, 1);
  assert.equal((await program(t, './fake-browser/fake-browser.mjs', ['https://example.test/']).exited).code, 1);
  const hung = program(t, './fake-browser/fake-browser.mjs', [`${url}/hang`]);
  hung.child.stdin.end(); assert.equal((await hung.exited).code, 1);
});
