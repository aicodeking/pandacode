import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import vm from 'node:vm'; import ts from 'typescript';
const source=await fs.readFile(new URL('../src/web-browser.ts',import.meta.url),'utf8'); const js=ts.transpileModule(source.replace("import { WebFiles } from './web-files';",'const WebFiles=globalThis.__WebFiles;').replace("import { webJson } from './web-http';",'const webJson=globalThis.__webJson;').replace("import { call } from './bridge';",'const call=globalThis.__call;').replace("import { isImeKey } from './dom';",'const isImeKey=globalThis.__isImeKey;').replace("import { mountJevLive, type JevLiveView } from './jev-live';",'const mountJevLive=globalThis.__mountJevLive;'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("import { subscribe } from './bridge';",'const subscribe=globalThis.__subscribe;').replace("import type { BrowserAttachment, BrowserStatus, BrowserElement } from './types';",'');
const {validateBrowserLease}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('actual adapter validates bounded opaque leases',()=>{assert.equal(validateBrowserLease('lease_123'),'lease_123');for(const value of ['', '../x','lease with spaces','x'.repeat(129),null,42])assert.throws(()=>validateBrowserLease(value));});
test('lease encoding remains path-safe',()=>{const lease=validateBrowserLease('abc_DEF-9');assert.equal(encodeURIComponent(lease),'abc_DEF-9');});
test('remote browser status clips oversized URL and title at the script boundary',async()=>{
  const source=await fs.readFile(new URL('../src-tauri/src/browser/remote_agent.js',import.meta.url),'utf8');
  const script=source.replace('__PANDACODE_ARGS__',JSON.stringify({kind:'status'}));
  const value=JSON.parse(vm.runInNewContext(script,{location:{href:'https://example.test/'+'u'.repeat(5000)},document:{title:'t'.repeat(500),readyState:'complete'},history:{length:2}}));
  assert.equal(value.url.length,4096); assert.equal(value.title.length,300); assert.equal(value.loading,false);
});
test('native browser inspect read clips oversized URL and title at the script boundary',async()=>{
  const source=await fs.readFile(new URL('../src-tauri/src/browser_agent.js',import.meta.url),'utf8');
  const script=source.replace('__PANDACODE_ARGS__',JSON.stringify({action:'read',selector:'',text:''}));
  const value=JSON.parse(vm.runInNewContext(script,{location:{href:'https://example.test/'+'u'.repeat(5000)},document:{title:'t'.repeat(500),body:{innerText:'fixture'},querySelectorAll:()=>[]},getComputedStyle:()=>({visibility:'visible'})}));
  assert.equal(value.url.length,4096); assert.equal(value.title.length,300); assert.deepEqual(value.elements,[]);
});
test('remote inspect rejects oversized callback text before JSON parsing',async()=>{
  const source=await fs.readFile(new URL('../src-tauri/src/browser.rs',import.meta.url),'utf8');
  assert.match(source,/fn parse_browser_result\(raw: &str\)/);
  assert.match(source,/if raw\.len\(\) > MAX_BROWSER_RESULT/);
});
