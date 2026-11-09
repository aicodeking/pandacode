import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/platform.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
async function platform(client,host,web=true){
 Object.defineProperty(globalThis,'navigator',{value:{platform:client},configurable:true});
 globalThis.document={documentElement:{dataset:web?{pandacodeWeb:'true',...(host?{pandacodeHostPlatform:host}:{})}:{}}};
 globalThis.location={search:web?'?web':''};
 return import(`data:text/javascript,${encodeURIComponent(js)}#${client}-${host}-${web}`);
}
test('iPad keyboard conventions do not enable macOS-only host capabilities on Linux',async()=>{
 const state=await platform('MacIntel','linux');assert.equal(state.commandKey,'⌘');assert.equal(state.hostIsMac,false);assert.equal(state.androidOnly,true);
});
test('Windows browser can use macOS host capabilities with its own shortcut labels',async()=>{
 const state=await platform('Win32','macos');assert.equal(state.commandKey,'Ctrl');assert.equal(state.hostIsMac,true);assert.equal(state.androidOnly,false);
});
test('unknown browser host does not silently assume Apple host capabilities',async()=>{
 const state=await platform('iPad',undefined);assert.equal(state.hostPlatform,'unknown');assert.equal(state.hostIsMac,false);
});
test('native platform fallback remains compatible',async()=>{
 const state=await platform('MacIntel',undefined,false);assert.equal(state.hostIsMac,true);assert.equal(state.commandKey,'⌘');
});
