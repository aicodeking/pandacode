import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const js=ts.transpileModule(fs.readFileSync(new URL('../src/web-actions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {validWebUiAction}=await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('UI runtime adapter admits only explicit actions with their exact data',()=>{
 assert.equal(validWebUiAction({action:'queue-resume',sessionId:'fixture'}),true);
 assert.equal(validWebUiAction({action:'queue-send-now',sessionId:'fixture',id:'message'}),true);
 assert.equal(validWebUiAction({action:'queue-steer',sessionId:'fixture',id:'message'}),true);
 assert.equal(validWebUiAction({action:'continue-after-limit',sessionId:'fixture',text:'Continue'}),true);
 for(const value of [{action:'eval',sessionId:'fixture'},{action:'queue-send-now',sessionId:'fixture'},
  {action:'queue-resume',sessionId:'fixture',code:'anything'},{action:'queue-resume',sessionId:'bad\nidentifier'},
  {action:'continue-after-limit',sessionId:'fixture',text:'x'.repeat(16385)}]) assert.equal(validWebUiAction(value),false);
});
