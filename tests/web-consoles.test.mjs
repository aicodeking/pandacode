import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compile = file => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const http = `data:text/javascript,${encodeURIComponent(compile('../src/web-http.ts'))}`;
const source = compile('../src/web-consoles.ts').replace("'./web-http'",JSON.stringify(http));
globalThis.window={setTimeout,clearTimeout}; globalThis.location=new URL('https://panda.example/'); globalThis.document={cookie:'pandacode_csrf=fixture'};
const {WebConsoles}=await import(`data:text/javascript,${encodeURIComponent(source)}`);
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('frame and input share one authenticated opaque lease, and release closes it',async()=>{
 const requests=[];globalThis.fetch=async(url,init)=>{const path=new URL(url).pathname;requests.push({url:new URL(url),init});
 if(path.endsWith('/open'))return json({lease:'webconsole_fixture',controller:true,expiresAt:42});
 if(path.endsWith('/frame'))return new Response(new Uint8Array([0,127,255]),{headers:{'content-type':'image/jpeg'}});
 if(path.endsWith('/input'))return json('ok');return new Response(null,{status:204});};
 const consoles=new WebConsoles();
 const [a,b]=await Promise.all([consoles.call('vm_frame',{name:'fixture'}),consoles.call('vm_frame',{name:'fixture'})]);
 assert.deepEqual([...new Uint8Array(a)],[0,127,255]);assert.equal(b.byteLength,3);
 assert.equal(requests.filter(r=>r.url.pathname.endsWith('/open')).length,1);
 assert.equal(await consoles.call('vm_input',{name:'fixture',input:{action:'key',key:'space'}}),'ok');
 const input=requests.find(r=>r.url.pathname.endsWith('/input'));assert.equal(JSON.parse(input.init.body).lease,'webconsole_fixture');assert.equal(input.init.headers['x-csrf-token'],'fixture');
 await consoles.release('vm');assert.equal(requests.at(-1).init.method,'DELETE');assert.ok(requests.at(-1).url.pathname.endsWith('/webconsole_fixture'));
});
test('closing during lease acquisition prevents stale frame or input dispatch',async()=>{
 let finish;const calls=[];globalThis.fetch=async(url,init)=>{calls.push(new URL(url).pathname);if(new URL(url).pathname.endsWith('/open'))return await new Promise(resolve=>{finish=()=>resolve(json({lease:'webconsole_race',controller:true,expiresAt:42}));});return new Response(null,{status:204});};
 const consoles=new WebConsoles();const frame=consoles.call('vm_frame',{name:'fixture'});const rejection=assert.rejects(()=>frame,/closed/);
 const release=consoles.release('vm');finish();await rejection;await release;assert.equal(calls.length,2);assert.ok(calls[1].endsWith('/webconsole_race'));
});
test('failed input is surfaced once without automatic replay',async()=>{
 let inputs=0;globalThis.fetch=async(url)=>{if(new URL(url).pathname.endsWith('/open'))return json({lease:'webconsole_failure',controller:true,expiresAt:42});inputs++;return new Response(null,{status:504});};
 const consoles=new WebConsoles();await assert.rejects(()=>consoles.call('cloud_input',{id:'fixture',input:{action:'type',text:'hello'}}),/504/);assert.equal(inputs,1);
});
test('frame route validates MIME and caps actual streamed bytes',async()=>{
 let badMime=true,cancelled=false;globalThis.fetch=async(url)=>{if(new URL(url).pathname.endsWith('/open'))return json({lease:'webconsole_bounds',controller:true,expiresAt:42});if(badMime)return new Response('x',{headers:{'content-type':'text/html'}});return {ok:true,headers:new Map([['content-type','image/jpeg']]),body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(8*1024*1024+1)}),cancel:async()=>{cancelled=true;}})}};};
 const consoles=new WebConsoles();await assert.rejects(()=>consoles.call('vm_frame',{name:'fixture'}),/frame type/);badMime=false;
 await assert.rejects(()=>consoles.call('vm_frame',{name:'fixture'}),/exceeds limit/);assert.equal(cancelled,true);
});

test('console input waits for acknowledgement and a failed chain never sends queued actions',async()=>{
 let acknowledge;const sent=[];globalThis.fetch=async(url,init)=>{
  if(new URL(url).pathname.endsWith('/open'))return json({lease:'webconsole_ordered',controller:true,expiresAt:42});
  sent.push(JSON.parse(init.body).input);
  if(sent.length===1)return await new Promise(resolve=>{acknowledge=()=>resolve(new Response(null,{status:504}));});
  return json('unexpected');
 };
 const consoles=new WebConsoles();const first=consoles.call('vm_input',{name:'fixture',input:{action:'key',key:'space'}});
 const second=consoles.call('vm_input',{name:'fixture',input:{action:'key',key:'Return'}});
 const checked=Promise.allSettled([first,second]);
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sent.length,1);acknowledge();
 const results=await checked;assert.ok(results.every(result=>result.status==='rejected'));assert.equal(sent.length,1);
 await assert.rejects(()=>consoles.call('vm_input',{name:'fixture',input:{action:'key',key:'space'}}),/504/);assert.equal(sent.length,1);
});

test('lifecycle commands map native arguments to finite manager and target requests',async()=>{
 const opens=[];const mutations=[];
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/open')){
   const body=JSON.parse(init.body);opens.push(body);
   return json({lease:`webconsole_${body.kind}_${body.target==='\u0024manager'?'manager':'target'}`,controller:true,expiresAt:42});
  }
  if(path.endsWith('/lifecycle')){
   const body=JSON.parse(init.body);mutations.push({body,headers:init.headers});
   return json({result:{accepted:body.action},expiresAt:43});
  }
  throw new Error(`Unexpected route ${path}`);
 };
 const consoles=new WebConsoles();
 assert.deepEqual(await consoles.call('simulator_select',{udid:'sim-1'}),{accepted:'simulatorSelect'});
 await consoles.call('simulator_create_duo',{});
 await consoles.call('simulator_pose',{udid:'sim-1',pose:'book'});
 await consoles.call('simulator_power',{udid:'sim-1',on:true});
 await consoles.call('simulator_appearance',{udid:'sim-1',mode:'dark'});
 await consoles.call('vm_show',{name:'fixture-vm'});
 await consoles.call('vm_create',{image:'ubuntu',name:'fixture-vm'});
 await consoles.call('vm_power',{name:'fixture-vm',action:'start',share:'project-1'});
 await consoles.call('vm_power',{name:'fixture-vm',action:'delete'});
 await consoles.call('vm_desktop',{name:'fixture-vm'});
 await consoles.call('vm_setup',{});

 assert.deepEqual(opens,[
  {kind:'simulator',target:'$manager',control:true},
  {kind:'simulator',target:'sim-1',control:true},
  {kind:'vm',target:'$manager',control:true},
  {kind:'vm',target:'fixture-vm',control:true},
 ]);
 const bodies=mutations.map(entry=>entry.body);
 assert.deepEqual(bodies[0],{lease:'webconsole_simulator_manager',action:'simulatorSelect',udid:'sim-1'});
 assert.deepEqual(bodies[1],{lease:'webconsole_simulator_manager',action:'simulatorCreateDuo'});
 assert.deepEqual(bodies[2],{lease:'webconsole_simulator_target',action:'simulatorPose',pose:'book'});
 assert.deepEqual(bodies[3],{lease:'webconsole_simulator_target',action:'simulatorPower',on:true});
 assert.deepEqual(bodies[4],{lease:'webconsole_simulator_target',action:'simulatorAppearance',mode:'dark'});
 assert.deepEqual(bodies[5],{lease:'webconsole_vm_manager',action:'vmShow',name:'fixture-vm'});
 assert.deepEqual(bodies[6],{lease:'webconsole_vm_manager',action:'vmCreate',image:'ubuntu',name:'fixture-vm'});
 assert.deepEqual(bodies[7],{lease:'webconsole_vm_target',action:'vmPower',operation:'start',shareProjectId:'project-1'});
 assert.deepEqual(bodies[8],{lease:'webconsole_vm_target',action:'vmPower',operation:'delete',confirm:'fixture-vm'});
 assert.deepEqual(bodies[9],{lease:'webconsole_vm_target',action:'vmDesktop'});
 assert.deepEqual(bodies[10],{lease:'webconsole_vm_manager',action:'vmSetup'});
 assert.ok(mutations.every(entry=>entry.headers['x-request-id']&&entry.headers['x-csrf-token']==='fixture'));
});

test('lifecycle failures are not retried and invalid mappings never reach the network',async()=>{
 let lifecycleCalls=0;
 globalThis.fetch=async(url,init)=>{
  if(new URL(url).pathname.endsWith('/open'))return json({lease:'webconsole_lifecycle_failure',controller:true,expiresAt:42});
  lifecycleCalls++;return new Response(null,{status:504});
 };
 const consoles=new WebConsoles();
 await assert.rejects(()=>consoles.call('vm_power',{name:'fixture-vm',action:'start'}),/504/);
 assert.equal(lifecycleCalls,1);
 await assert.rejects(()=>consoles.call('vm_power',{name:'fixture-vm',action:'explode'}),/Invalid VM power action/);
 await assert.rejects(()=>consoles.call('vm_create',{image:'https://invalid.test/image',name:'fixture-vm'}),/Invalid VM image/);
 assert.equal(lifecycleCalls,1);
});

test('simulator capture is lease-bound, deadline-bound, MIME checked, and byte-capped',async()=>{
 let mode='ok',cancelled=false,signal;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/open'))return json({lease:'webconsole_capture',controller:true,expiresAt:42});
  signal=init.signal;
  if(mode==='mime')return new Response('x',{headers:{'content-type':'image/jpeg'}});
  if(mode==='large')return {ok:true,headers:new Map([['content-type','image/png']]),body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(16*1024*1024+1)}),cancel:async()=>{cancelled=true;}})}};
  return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
 };
 const consoles=new WebConsoles();
 assert.deepEqual([...new Uint8Array(await consoles.call('simulator_capture',{udid:'sim-1'}))],[137,80,78,71]);
 assert.ok(signal instanceof AbortSignal);
 mode='mime';await assert.rejects(()=>consoles.call('simulator_capture',{udid:'sim-1'}),/capture type/);
 mode='large';await assert.rejects(()=>consoles.call('simulator_capture',{udid:'sim-1'}),/exceeds limit/);assert.equal(cancelled,true);
});

test('dock preferences use the typed route while native window pinning fails visibly',async()=>{
 const requests=[];
 globalThis.fetch=async(url,init)=>{
  requests.push({url:new URL(url),init,body:JSON.parse(init.body)});
  if(requests.at(-1).body.action==='pin')return new Response(null,{status:501});
  return json({enabled:true,keepOnScreen:false,pinned:false});
 };
 const consoles=new WebConsoles();
 assert.deepEqual(await consoles.call('agents_dock_save_preferences',{enabled:true,keepOnScreen:false}),{enabled:true,keepOnScreen:false,pinned:false});
 assert.equal(requests[0].url.pathname,'/api/pandacode/dock');
 assert.deepEqual(requests[0].body,{action:'save',enabled:true,keepOnScreen:false});
 assert.ok(requests[0].init.headers['x-request-id']);
 await assert.rejects(()=>consoles.call('agents_dock_pin',{}),/unavailable in the web UI/);
 assert.deepEqual(requests[1].body,{action:'pin'});
 await assert.rejects(()=>consoles.call('agents_dock_save_preferences',{enabled:'yes',keepOnScreen:false}),/Invalid running agents/);
 assert.equal(requests.length,2);
});
