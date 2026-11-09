import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/web-transport.ts', import.meta.url), 'utf8');
const sequencer = fs.readFileSync(new URL('../src/web-terminal-input.ts', import.meta.url), 'utf8');
const sequencerJs = ts.transpileModule(sequencer, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('export class TerminalInputSequencer', 'class TerminalInputSequencer');
const js = ts.transpileModule(source.replace("import { TerminalInputSequencer } from './web-terminal-input';", sequencerJs), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
globalThis.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
globalThis.location = new URL('https://panda.example/workspace');
globalThis.document = { cookie: 'pandacode_csrf=csrf', documentElement: { dataset: {} } };
const { WebTransport } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('rejects foreign origins and unsafe commands', async () => {
  assert.throws(() => new WebTransport({ baseUrl: 'https://evil.example/' }), /current origin/);
  await assert.rejects(() => new WebTransport({ fetchImpl: async () => { throw Error('unexpected'); } }).call('run/anything'), /Invalid gateway command/);
});
test('caps actual chunked bytes despite misleading content length', async () => {
  let cancelled = false; const body = { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(9) }), cancel: async () => { cancelled = true; } }) };
  const transport = new WebTransport({ maxResponseBytes: 8, fetchImpl: async () => ({ ok: true, headers: new Map([['content-length', '1']]), body }) });
  await assert.rejects(() => transport.call('projects'), /exceeds limit/); assert.equal(cancelled, true);
});
test('reconnects with resume and requests missing sequence', async () => {
  const sockets = []; class FakeSocket { constructor() { sockets.push(this); } send(v) { this.sent = [...(this.sent ?? []), JSON.parse(v)]; } close() { this.onclose?.(); } }
  const transport = new WebTransport({ websocket: FakeSocket }); const seen = []; const stop = transport.subscribe('agent', e => seen.push(e.payload));
  sockets[0].onopen(); sockets[0].onmessage({ data: JSON.stringify({ type: 'agent', sequence: 1, payload: 'one' }) }); sockets[0].onmessage({ data: JSON.stringify({ type: 'agent', sequence: 3, payload: 'gap' }) });
  assert.deepEqual(seen, ['one']); assert.deepEqual(sockets[0].sent.at(-1), { type: 'resync', from: 1 }); sockets[0].onclose(); await new Promise(r => setTimeout(r, 270));
  assert.equal(sockets.length, 2); sockets[1].onopen(); assert.deepEqual(sockets[1].sent[0], { type: 'resume', sequence: 1 }); stop();
});
test('console binary envelopes decode exactly and cannot be smuggled through other commands', async () => {
  const transport = new WebTransport({ fetchImpl: async () => new Response(JSON.stringify({__pandacode_web_binary__:'AH//'})) });
  assert.deepEqual([...new Uint8Array(await transport.call('vm_frame'))],[0,127,255]);
  await assert.rejects(()=>transport.call('list_projects'),/Invalid gateway binary/);
});
test('the deadline covers a body stalled after successful headers', async () => {
  const transport=new WebTransport({timeoutMs:10,fetchImpl:async(_url,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(new Error('aborted')));}}))});
  await assert.rejects(()=>transport.call('list_projects'),/timed out/);
});
test('clone waits beyond the native and gateway deadlines without changing ordinary request deadlines', async () => {
  const deadlines = []; const originalTimer = window.setTimeout;
  window.setTimeout = (callback, delay) => { deadlines.push(delay); return originalTimer(callback, delay); };
  try {
    const transport = new WebTransport({ fetchImpl: async () => new Response('{}') });
    await transport.call('github_clone_repo', { repo: 'owner/repo', parent: 'opaque-grant' });
    await transport.call('list_projects');
    assert.deepEqual(deadlines, [630000, 50000]);
    const short = new WebTransport({ timeoutMs: 10, fetchImpl: async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('aborted'))); } })) });
    await assert.rejects(() => short.call('github_clone_repo'), /timed out/);
    assert.equal(deadlines.at(-1), 10);
  } finally { window.setTimeout = originalTimer; }
});
test('runtime recovery installs a coherent snapshot and resumes strictly after its cursor', async () => {
  const sockets=[];class FakeSocket{constructor(){sockets.push(this);}send(value){this.sent=JSON.parse(value);}close(){this.closed=true;this.onclose?.();}}
  const transport=new WebTransport({websocket:FakeSocket,fetchImpl:async url=>{
    assert.equal(new URL(url).pathname,'/api/pandacode/runtime-snapshot');
    return new Response(JSON.stringify({sequence:42,truncated:false,events:[{type:'agent-event',payload:{sessionId:'fixture',kind:'text',text:'complete prefix'}}]}));
  }});
  const received=[];const stop=transport.subscribe('agent-event',event=>received.push(event.payload));
  await transport.recover();assert.equal(sockets[0].closed,true);assert.equal(received[0].text,'complete prefix');
  const latest=sockets.at(-1);latest.onopen();assert.deepEqual(latest.sent,{type:'resume',sequence:42});
  latest.onmessage({data:JSON.stringify({type:'agent-event',sequence:43,payload:{text:'suffix'}})});
  assert.equal(received[1].text,'suffix');assert.equal(received.length,2);stop();
});
test('truncated recovery never resets the visible runtime or pretends success',async()=>{
  let resets=0;const reset=()=>resets++;window.addEventListener('pandacode-web-runtime-reset',reset);
  const transport=new WebTransport({fetchImpl:async()=>new Response(JSON.stringify({sequence:9,truncated:true,events:[]}))});
  await assert.rejects(()=>transport.recover(),/recovery limit/);assert.equal(resets,0);
  window.removeEventListener('pandacode-web-runtime-reset',reset);transport.close();
});

test('document reads use the scoped binary route and preserve all bytes', async () => {
  const transport = new WebTransport({ fetchImpl: async (url, init) => {
    const request = new URL(url); assert.equal(request.pathname, '/api/pandacode/files/document');
    assert.equal(request.searchParams.get('projectId'), 'fixture'); assert.equal(request.searchParams.get('path'), 'space name.pdf');
    assert.equal(init.credentials, 'same-origin');
    return new Response(new Uint8Array([0, 127, 255]), { headers: { 'content-type': 'application/octet-stream' } });
  } });
  assert.deepEqual([...new Uint8Array(await transport.call('read_document_file', { projectId: 'fixture', path: 'space name.pdf' }))], [0, 127, 255]);
});

test('coalesces browser write_terminal calls into one request', async () => {
  const requests = []; const transport = new WebTransport({ fetchImpl: async (url, init) => { requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return new Response('{}'); } });
  const a = transport.call('write_terminal', { terminalId: 't', data: 'a' }); const b = transport.call('write_terminal', { terminalId: 't', data: ' b' }); await Promise.all([a, b]);
  assert.equal(requests.length, 1); assert.equal(requests[0].body.data, 'a b');
});
test('waits for the in-flight write acknowledgement before the next batch', async () => {
  const requests = []; let release; const first = new Promise(resolve => { release = resolve; });
  const transport = new WebTransport({ fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push(body); if (requests.length === 1) await first; return new Response('{}'); } });
  const one = transport.call('write_terminal', { terminalId: 't', data: 'one' }); await new Promise(r => setTimeout(r, 20)); const two = transport.call('write_terminal', { terminalId: 't', data: 'two' }); await new Promise(r => setTimeout(r, 20)); assert.deepEqual(requests.map(r => r.data), ['one']); release(); await Promise.all([one, two]); assert.deepEqual(requests.map(r => r.data), ['one', 'two']);
});
test('close_terminal flushes writes before issuing close', async () => {
  const order = []; const transport = new WebTransport({ fetchImpl: async (url, init) => { const command = new URL(url).pathname.split('/').pop(); order.push(command); return new Response('{}'); } });
  const write = transport.call('write_terminal', { terminalId: 't', data: 'pending' }); const close = transport.call('close_terminal', { terminalId: 't' }); await Promise.all([write, close]); assert.deepEqual(order, ['write_terminal', 'close_terminal']);
});
test('failed writes do not retry and reset explicitly permits input again', async () => {
  const requests = []; let fail = true; const transport = new WebTransport({ fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); if (fail) { fail = false; throw new Error('offline'); } return new Response('{}'); } });
  await assert.rejects(() => transport.call('write_terminal', { terminalId: 't', data: 'once' }), /offline/); await new Promise(r => setTimeout(r, 20)); assert.equal(requests.length, 1); await assert.rejects(() => transport.call('write_terminal', { terminalId: 't', data: 'blocked' }), /closed/); transport.resetTerminalInput('t'); await transport.call('write_terminal', { terminalId: 't', data: 'again' }); assert.equal(requests.length, 2); assert.equal(requests[1].data, 'again');
});

test('expired command authentication stops reconnecting and reports pairing without replay', async () => {
  const sockets=[];class FakeSocket{constructor(){sockets.push(this);}send(){}close(){this.closed=true;this.onclose?.();}}
  const transport=new WebTransport({websocket:FakeSocket,fetchImpl:async()=>new Response(null,{status:401})});
  const stop=transport.subscribe('agent-event',()=>{});let status;
  const listen=event=>{status=event.detail;};window.addEventListener('pandacode-web-connection',listen);
  await assert.rejects(()=>transport.call('list_projects'),/401/);
  assert.equal(status.status,'error');assert.match(status.message,/Pair/);assert.equal(sockets[0].closed,true);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(sockets.length,1);
  stop();window.removeEventListener('pandacode-web-connection',listen);
});
test('socket loss rejects in-flight and queued terminal input until explicit reset', async () => {
  const sockets=[]; class FakeSocket { constructor(){ sockets.push(this); } send(){} close(){ this.onclose?.(); } }
  let release; const requests=[]; const transport = new WebTransport({ websocket:FakeSocket, fetchImpl:async (_url,init) => { requests.push(JSON.parse(init.body)); await new Promise(resolve => { release=resolve; }); return new Response('{}'); } });
  const stop=transport.subscribe('agent-event',()=>{}); const first=transport.call('write_terminal',{terminalId:'t',data:'old'}); await new Promise(r=>setTimeout(r,20)); const queued=transport.call('write_terminal',{terminalId:'t',data:'queued'}); sockets[0].onclose(); await assert.rejects(first,/connection closed/); await assert.rejects(queued,/connection closed/); release(); await new Promise(r=>setTimeout(r,20)); await assert.rejects(()=>transport.call('write_terminal',{terminalId:'t',data:'blocked'}),/closed/); transport.resetTerminalInput('t'); const fresh=transport.call('write_terminal',{terminalId:'t',data:'fresh'}); await new Promise(r=>setTimeout(r,20)); release(); await fresh; assert.deepEqual(requests.map(item=>item.data),['old','fresh']); stop();
});
