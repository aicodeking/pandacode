import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const preferences = `data:text/javascript,${encodeURIComponent(compile('../src/web-preferences.ts'))}`;
const actions = `data:text/javascript,${encodeURIComponent(compile('../src/web-actions.ts'))}`;
const host = compile('../src/web-native-host.ts').replace("'./web-preferences'",JSON.stringify(preferences)).replace("'./web-actions'",JSON.stringify(actions))
  .replace("import { palette } from './palette';", 'const palette = globalThis.mockPalette;')
  .replace("import('@tauri-apps/api/event')",'Promise.resolve(globalThis.mockEvents)')
  .replace("import('@tauri-apps/api/core')",'Promise.resolve(globalThis.mockCore)');
globalThis.mockPalette = { wallpaperColor: '#aabbcc' };
const {initializeWebNativeHost}=await import(`data:text/javascript,${encodeURIComponent(host)}`);
test('broker is inert outside native window',async()=>{
 globalThis.window={}; globalThis.mockEvents={listen:()=>{throw Error('must not listen')}};
 await initializeWebNativeHost();
});
test('native broker forwards typed commands, binary response and rejects gateway recursion',async()=>{
 const handlers=new Map(),events=new Map(),calls=[];
 globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
 globalThis.window={__TAURI_INTERNALS__:{},setTimeout,clearTimeout,addEventListener:(name,fn)=>events.set(name,fn),dispatchEvent:event=>{if(event.type==='pandacode-web-ui-action')event.detail.resolve(null);}};
 globalThis.mockEvents={listen:async(name,fn)=>handlers.set(name,fn)};
 globalThis.mockCore={invoke:async(command,args)=>{calls.push({command,args});if(command==='list_projects')return [{id:'fixture'}];if(command==='read_document_file')return new Uint8Array([0,127,255]).buffer;}};
 await initializeWebNativeHost();
 assert.ok(calls.some(call=>call.command==='web_gateway_preferences_publish' && call.args.wallpaperAccentSeed==='#aabbcc'));
 await handlers.get('web-gateway-preferences')({payload:{id:'prefs',preferences:{'pandacode.theme':'dark'},wallpaperAccentSeed:'#ff0000'}});
 assert.equal(calls.at(-1).args.wallpaperAccentSeed,'#aabbcc');
 assert.equal(calls.at(-1).args.requestId,'prefs');
 globalThis.mockPalette.wallpaperColor = '#abc';
 events.get('pandacode-palette-change')();
 assert.equal(calls.at(-1).args.wallpaperAccentSeed,null);
 globalThis.mockPalette.wallpaperColor = '#aabbcc';
 assert.ok(!calls.some(call=>call.command==='web_gateway_ready'));
 events.get('pandacode-workspace-ready')();
 await Promise.resolve();
 await Promise.resolve();
 assert.ok(calls.some(call=>call.command==='web_gateway_ready'&&call.args.ready));
 const request=handlers.get('web-gateway-request');
 await request({payload:{id:'one',command:'list_projects',args:{}}});
 assert.deepEqual(calls.at(-1),{command:'web_gateway_resolve',args:{id:'one',result:[{id:'fixture'}],error:null}});
 await request({payload:{id:'two',command:'read_document_file',args:{}}});
 assert.equal(calls.at(-1).args.result.__pandacode_web_binary__,'AH//');
 const count=calls.length;
 await request({payload:{id:'three',command:'web_gateway_pair',args:{}}});
 assert.equal(calls.length,count);
 await request({payload:{id:'four',command:'web_ui_action',args:{action:'queue-resume',sessionId:'fixture'}}});
 assert.equal(calls.at(-1).command,'web_gateway_resolve'); assert.equal(calls.at(-1).args.error,null);
 assert.ok(!calls.some(call=>call.command==='web_ui_action'));
 await request({payload:{id:'five',command:'web_ui_action',args:{action:'eval',sessionId:'fixture'}}});
 assert.match(calls.at(-1).args.error,/Invalid browser workspace action/);
});
