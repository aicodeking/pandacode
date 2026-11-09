import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/web-files.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
globalThis.window={setTimeout,clearTimeout};globalThis.location=new URL('https://panda.example/?web');
globalThis.document={cookie:'other=value; pandacode_csrf=csrf%2Bencoded',documentElement:{dataset:{}}};
const {WebFiles}=await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('file requests encode paths and forward exact decoded CSRF with session credentials',async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:new URL(url),init});return new Response(JSON.stringify({grant:'opaque',name:'folder'}));};
 const files=new WebFiles();await files.list('root-one','folder with space');
 assert.equal(calls[0].url.pathname,'/api/pandacode/files/list');assert.equal(calls[0].url.searchParams.get('path'),'folder with space');
 await files.select('root-one','relative/folder','folder','project');
 const call=calls.at(-1);assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.headers['x-csrf-token'],'csrf+encoded');
 assert.deepEqual(JSON.parse(call.init.body),{root:'root-one',path:'relative/folder',kind:'folder',purpose:'project'});
});
test('upload enforces byte cap before network and returns grant rather than a host path',async()=>{
 let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(init.headers['x-file-name'],'image%20name.png');assert.equal(init.headers['x-file-purpose'],'attachment');return new Response(JSON.stringify({grant:'opaque-upload',name:'image name.png'}));};
 const files=new WebFiles();await assert.rejects(()=>files.upload({size:64*1024*1024+1,name:'large'},'attachment'),/64 MiB/);assert.equal(calls,0);
 const file=new File(['fixture'],'../image name.png');assert.deepEqual(await files.upload(file,'attachment'),{grant:'opaque-upload',name:'image name.png'});assert.equal(calls,1);
});
test('authentication failures fail closed instead of returning sample roots',async()=>{
 globalThis.fetch=async()=>new Response('unauthenticated',{status:401});await assert.rejects(()=>new WebFiles().roots(),/401/);
});

test('file picker ignores early focus and waits for explicit cancel or change', async () => {
 const original=document, originalWindow=window, inputs=[];
 const body={append(input){inputs.push(input);},};
 globalThis.document={cookie:'',documentElement:{dataset:{}},body,createElement(){const listeners={};return {type:'',accept:'',multiple:false,hidden:false,files:[],addEventListener(name,fn){(listeners[name]??=[]).push(fn);},dispatch(name){for(const fn of listeners[name]??[])fn({});},click(){},remove(){this.removed=true;}};}};
 globalThis.window=new EventTarget();
 const files=new WebFiles(); const pending=files.pickFiles('',true,'attachment'); const input=inputs[0];
 window.dispatchEvent(new Event('focus')); await new Promise(resolve=>setTimeout(resolve,250)); assert.equal(input.removed,undefined);
 input.dispatch('cancel'); assert.deepEqual(await pending,[]); assert.equal(input.removed,true);
 globalThis.document=original; globalThis.window=originalWindow;
});

test('file picker ignores late and duplicate events and cleans up rejected uploads', async () => {
 const original=document, inputs=[]; const body={append(input){inputs.push(input);}};
 globalThis.document={cookie:'',documentElement:{dataset:{}},body,createElement(){const listeners={};return {files:[],addEventListener(n,f){(listeners[n]??=[]).push(f);},dispatch(n){for(const f of listeners[n]??[])f({});},click(){},remove(){this.removed=true;}};}};
 const files=new WebFiles(); let calls=0; files.upload=async()=>{calls++; await new Promise(r=>setTimeout(r,10)); throw new Error('upload failed');};
 const pending=files.pickFiles('',true,'attachment'), input=inputs[0]; input.files=[new File(['x'],'x.png')]; input.dispatch('change'); input.dispatch('change'); input.dispatch('cancel'); await assert.rejects(pending,/upload failed/); assert.equal(calls,1); assert.equal(input.removed,true); globalThis.document=original;
});

test('file picker rejects and removes input when the platform refuses click', async () => {
 const original=document; let created;
 globalThis.document={cookie:'',documentElement:{dataset:{}},body:{append(input){created=input;}},createElement(){return {addEventListener(){},click(){throw new Error('picker unavailable');},remove(){this.removed=true;}};}};
 await assert.rejects(() => new WebFiles().pickFiles('',false,'attachment'), /picker unavailable/); assert.equal(created.removed,true); globalThis.document=original;
});

test('reveal rejects invalid paths and server refusal before opening a picker', async () => {
 const files=new WebFiles();let requests=0;
 globalThis.fetch=async()=>{requests++;return new Response(null,{status:403});};
 for(const path of [null,42,'','x'.repeat(4097),'bad\u0000path'])await assert.rejects(()=>files.reveal(path),/Invalid host path/);
 assert.equal(requests,0);
 await assert.rejects(()=>files.reveal('/outside-root/private'),/403/);assert.equal(requests,1);
});

test('late file delivery after focus succeeds once and cancelled pickers cannot upload', async () => {
 const previousDocument=document, previousWindow=window, inputs=[];
 const windowEvents=new EventTarget(); Object.assign(windowEvents,{setTimeout,clearTimeout});
 globalThis.window=windowEvents;
 globalThis.document={cookie:'',documentElement:{dataset:{}},body:{append(input){inputs.push(input);}},createElement(){const listeners={};return {files:[],addEventListener(n,f){(listeners[n]??=[]).push(f);},dispatch(n){for(const f of listeners[n]??[])f({});},click(){},remove(){this.removed=true;}};}};
 try {
  const files=new WebFiles(); let uploads=0;
  files.upload=async file=>{uploads++;return {grant:'opaque-result',name:file.name};};
  const pending=files.pickFiles('',true,'attachment'), input=inputs[0];
  window.dispatchEvent(new Event('focus')); await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(input.removed,undefined);
  input.files=[new File(['safe fixture'],'delayed.txt')];input.dispatch('change');input.dispatch('change');
  assert.deepEqual(await pending,[{grant:'opaque-result',name:'delayed.txt'}]);assert.equal(uploads,1);assert.equal(input.removed,true);
  const cancelled=files.pickFiles('',true,'attachment'), second=inputs[1];second.dispatch('cancel');assert.deepEqual(await cancelled,[]);
  second.files=[new File(['late'],'late.txt')];second.dispatch('change');await Promise.resolve();assert.equal(uploads,1);
 } finally {globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
