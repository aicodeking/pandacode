import { expect, test, type Page } from '@playwright/test';

const probe = String.raw`
  window.__assistCalls ??= []; window.__assistCalls.push({command,args:structuredClone(args)});
  window.__assistRules ??= ['No hardcoded service URLs.']; window.__assistHistory ??= [];
  window.__assistConfig ??= {enabled:false,decisionsEnabled:true,pythonPath:'',chromePath:'',textModel:'inception/mercury-2.5',textBaseUrl:'https://openrouter.ai/api/v1',typesafeKeySaved:true,textKeySaved:false};
  const evidence = {id:'change-1:file-1',label:'src/app.ts',text:'const host = "https://example.test";\n<img src=x onerror=alert(1)>',truncated:false,path:'src/app.ts',changeId:'change-1'};
  if(command === 'jev_configuration') return structuredClone(window.__assistConfig);
  if(command === 'jev_doctor') return {ready:false,issues:['Browser runtime is not installed.']};
  if(command === 'jev_save_configuration') { Object.assign(window.__assistConfig,args.settings); return structuredClone(window.__assistConfig); }
  if(command === 'jev_assist_prepare') {
    const request = structuredClone(args.request);
    if(window.__assistDelayPrepare) await new Promise(resolve=>{window.__assistReleasePrepare=resolve;});
    return {kind:request.kind,title:request.kind==='route'?'Worker suggestion':'Work review',query:request.query||'',rules:request.rules||window.__assistRules,evidence:[evidence],candidateCount:window.__assistEmpty?0:2,inputBytes:523,truncated:false,enabled:window.__assistConfig.decisionsEnabled,keySaved:window.__assistConfig.typesafeKeySaved,fingerprint:'fixture-saved-evidence'};
  }
  if(command === 'jev_assist_save_rules') {
    if(window.__assistDelayRules) await new Promise(resolve=>{window.__assistReleaseRules=resolve;});
    window.__assistRules=structuredClone(args.rules); return structuredClone(args.rules);
  }
  if(command === 'jev_assist_list') return structuredClone(window.__assistHistory);
  if(command === 'get_messages' && args.sessionId==='session-2' && window.__assistChangeFixture) return {messages:[
    {id:701,sessionId:'session-2',role:'user',content:'Review this change',createdAt:100},
    {id:702,sessionId:'session-2',role:'assistant',content:'Saved changes are ready.',createdAt:200},
    {id:703,sessionId:'session-2',role:'changes',content:'',createdAt:200,turnChanges:{id:'change-1',files:[{path:'src/app.ts',status:'modified',additions:1,deletions:1}],additions:1,deletions:1,truncated:false,concurrent:false,attributed:true}}
  ],hasOlder:false};
  if(command === 'turn_change_diff' && args.changeId==='change-1') return {path:args.path,patch:'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',binary:false,truncated:false};
  if(command === 'architect_get' && args.sessionId==='session-2' && window.__assistTeam) return structuredClone(window.__assistTeam);
  if(command === 'architect_worker_messages' && window.__assistTeam) return {messages:[{id:711,sessionId:'worker-1-session',role:'assistant',content:'Worker output ready.',createdAt:200}],hasOlder:false};
  if(command === 'architect_team_messages' && window.__assistTeam) return {messages:[],nextCursor:0,hasMore:false};
  if(command === 'jev_assist_run') {
    if(window.__assistDelayRun) await new Promise(resolve=>{window.__assistReleaseRun=resolve;});
    if(window.__assistFail) throw new Error('TypeSafe could not complete this request.');
    const result = {id:crypto.randomUUID(),sessionId:args.sessionId,kind:args.request.kind,title:args.request.kind==='route'?'Worker suggestion':'Work review',createdAt:Date.now(),model:'jev',durationMs:320,inputTokens:156,status:'uncertain',summary:'More evidence is needed before calling this finished.',findings:[{id:'one',label:'Implementation covers the requested behavior',result:'uncertain',probability:.54,confidence:.62},{id:'two',label:'<script>unsafe</script>',result:'unknown'}],matches:args.request.kind==='context'?[evidence]:[],recommendation:args.request.kind==='route'?{id:'worker-1',label:'Fast worker',detail:'Best match among the configured candidates.'}:undefined,evidence:[evidence],changeId:'change-1',truncated:false};
    window.__assistHistory.unshift(structuredClone(result)); return result;
  }
`;

async function setup(page: Page) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), body = await response.text();
    expect(body).toMatch(/switch \(command\) \{/);
    await route.fulfill({ response, body: body.replace(/switch \(command\) \{/, `${probe}\nswitch (command) {`) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}
async function open(page: Page, options: Record<string, unknown> = {}) {
  await page.evaluate(async options => {
    const module = await import('/src/jev-assist.ts');
    void module.showJevAssist(document.querySelector('#dialog'), {
      sessionId:'session-1', ...options,
      attach:(text: string)=>{(window as any).__assistAttached=text;},
      settings:()=>{(window as any).__assistSettingsOpened=true;},
      openDiff:(changeId: string,path: string)=>{(window as any).__assistDiff={changeId,path};},
    });
  }, options);
  await expect(page.getByRole('heading', { name:'Jev assistance', exact:true })).toBeVisible();
}
async function calls(page: Page, command: string): Promise<any[]> { return page.evaluate(command => (window as any).__assistCalls.filter((entry: any) => entry.command===command),command); }
async function prepared(page: Page) { await expect(page.locator('[data-assist-run]')).toBeEnabled(); }
async function finish(page: Page) { await page.locator('[data-assist-run]').click(); await expect(page.locator('.jev-assist-advisory')).toHaveText('Needs judgment'); }

test('decisions opt in independently and missing Jev keys do not block normal app use', async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{ (window as any).__assistConfig.decisionsEnabled=false; (window as any).__assistConfig.typesafeKeySaved=false; });
  await open(page); await expect(page.locator('.jev-assist-evidence')).toHaveCount(1);
  await expect(page.locator('[data-assist-run]')).toBeDisabled();
  await expect(page.locator('.jev-assist-setup')).toContainText('Enable decision assistance');
  expect(await calls(page,'jev_assist_run')).toHaveLength(0);
  await page.locator('[data-assist-close]').click();
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Tools & add-ons',exact:true}).click();
  await page.getByRole('button',{name:'Set up Jev',exact:true}).click();
  await expect(page.locator('#jev-decisions-enabled')).not.toBeChecked();
  await page.locator('#jev-decisions-enabled').check(); await page.locator('[data-jev-save]').click();
  await expect.poll(async()=> (await calls(page,'jev_save_configuration')).length).toBe(1);
  expect((await calls(page,'jev_save_configuration'))[0].args.settings).toMatchObject({enabled:false,decisionsEnabled:true});
  await expect(page.locator('#dialog')).toContainText('PandaCode works without Jev or a TypeSafe key');
});

test('saved diff evidence is previewed locally, escaped, and opens its original diff', async ({page}) => {
  await setup(page); await open(page,{changeId:'change-1'}); await prepared(page);
  expect(await calls(page,'jev_assist_run')).toHaveLength(0);
  expect((await calls(page,'jev_assist_prepare'))[0].args).toEqual({sessionId:'session-1',request:{kind:'review',changeId:'change-1'}});
  await page.locator('.jev-assist-evidence summary').click();
  await expect(page.locator('.jev-assist-evidence pre')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.jev-assist-evidence img')).toHaveCount(0);
  await page.getByRole('button',{name:'Open saved diff',exact:false}).click();
  expect(await page.evaluate(()=>(window as any).__assistDiff)).toEqual({changeId:'change-1',path:'src/app.ts'});
});

test('task menu and saved-diff entry use the current task and disappear when disabled', async ({page}) => {
  await setup(page);
  await page.getByRole('button',{name:'Task actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Jev assistance',exact:true}).click(); await prepared(page);
  expect((await calls(page,'jev_assist_prepare'))[0].args.sessionId).toBe('session-1');
  await page.locator('[data-assist-close]').click();
  await page.evaluate(()=>{(window as any).__assistChangeFixture=true;});
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.getByRole('button',{name:'Open diff',exact:true}).click();
  await page.getByRole('button',{name:'Review with Jev',exact:true}).click(); await prepared(page);
  expect((await calls(page,'jev_assist_prepare')).at(-1).args).toEqual({sessionId:'session-2',request:{kind:'review',changeId:'change-1'}});
  await page.locator('[data-assist-close]').click();
  await page.evaluate(()=>{(window as any).__assistConfig.decisionsEnabled=false;window.dispatchEvent(new CustomEvent('pandacode:jev-settings',{detail:(window as any).__assistConfig}));});
  await page.getByRole('button',{name:'Task actions',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:'Jev assistance',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open diff',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review with Jev',exact:true})).toHaveCount(0);
});

test('team entry suggests configured workers and worker review uses the worker task', async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{
    const profile={id:'fast',name:'Fast worker',provider:'codex',model:'gpt-6-astra'};
    (window as any).__assistTeam={sessionId:'session-2',config:{workers:[profile],maxParallel:1,maxRounds:4,maxAssignments:8,workspace:'shared',summaryLimit:1800},status:'ready',round:1,revision:1,updatedAt:200,workers:[{...profile,id:'worker-1',profileId:'fast',sessionId:'worker-1-session',status:'completed',assignment:'Check keyboard navigation',summary:'Checked the task',dependsOn:[],files:['src/app.ts'],attempt:1,createdAt:100,updatedAt:200}]};
  });
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.locator('#agents-toggle').click();
  await page.getByRole('button',{name:'Suggest worker',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Choose worker',exact:true})).toHaveAttribute('aria-selected','true');
  await page.locator('#jev-assist-query').fill('Add meaningful keyboard tests');
  await page.locator('[data-assist-prepare]').click(); await prepared(page);
  expect((await calls(page,'jev_assist_prepare')).at(-1).args).toEqual({sessionId:'session-2',request:{kind:'route',query:'Add meaningful keyboard tests'}});
  await page.locator('[data-assist-close]').click();
  await page.locator('#agents-toggle').click();
  await page.locator('.architect-worker-row[data-worker-id="worker-1"]').click();
  await page.getByRole('button',{name:'Review with Jev',exact:true}).click(); await prepared(page);
  expect((await calls(page,'jev_assist_prepare')).at(-1).args).toEqual({sessionId:'worker-1-session',request:{kind:'review'}});
});

test('project rules persist without inference and saving never overwrites a newer draft', async ({page}) => {
  await setup(page); await open(page,{kind:'rules'}); await prepared(page);
  await expect(page.locator('#jev-assist-rules')).toHaveValue('No hardcoded service URLs.');
  await page.locator('#jev-assist-rules').fill('New behavior has meaningful checks.');
  await page.evaluate(()=>{(window as any).__assistDelayRules=true;});
  await page.locator('[data-assist-save-rules]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__assistReleaseRules)).toBe('function');
  await page.locator('#jev-assist-rules').fill('Keep the new unsaved rule.');
  await page.evaluate(()=>{(window as any).__assistReleaseRules();});
  await expect(page.locator('.jev-feedback')).toContainText('Rules saved');
  await expect(page.locator('#jev-assist-rules')).toHaveValue('Keep the new unsaved rule.');
  await expect(page.locator('[data-assist-save-rules]')).toBeEnabled();
  expect((await calls(page,'jev_assist_save_rules'))[0].args).toEqual({sessionId:'session-1',rules:['New behavior has meaningful checks.']});
  expect(await calls(page,'jev_assist_run')).toHaveLength(0);
  await page.locator('#jev-assist-rules').fill(Array.from({length:9},(_,i)=>`Rule ${i}`).join('\n'));
  await page.locator('[data-assist-save-rules]').click();
  await expect(page.locator('.jev-feedback')).toContainText('up to 8 rules');
  expect(await calls(page,'jev_assist_save_rules')).toHaveLength(1);
});

test('async evidence and reports preserve typed queries, focus, and uncertain judgments', async ({page}) => {
  await setup(page); await open(page,{kind:'context'});
  expect(await calls(page,'jev_assist_prepare')).toHaveLength(0);
  await page.locator('#jev-assist-query').fill('Why did login fail?');
  await page.evaluate(()=>{(window as any).__assistDelayPrepare=true; (window as any).__assistInput=document.querySelector('#jev-assist-query');});
  await page.locator('[data-assist-prepare]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__assistReleasePrepare)).toBe('function');
  await page.locator('#jev-assist-query').fill('Keep this updated search');
  await page.evaluate(()=>{(window as any).__assistReleasePrepare();});
  await expect(page.locator('[data-assist-prepare]')).toBeEnabled();
  await expect(page.locator('.jev-assist-preview')).toBeEmpty();
  await expect(page.locator('#jev-assist-query')).toBeFocused();
  expect(await page.evaluate(()=>(window as any).__assistInput===document.querySelector('#jev-assist-query'))).toBe(true);
  await page.evaluate(()=>{(window as any).__assistDelayPrepare=false; (window as any).__assistDelayRun=true;});
  await page.locator('[data-assist-prepare]').click(); await prepared(page);
  await page.locator('[data-assist-run]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__assistReleaseRun)).toBe('function');
  expect((await calls(page,'jev_assist_run')).at(-1).args.request.fingerprint).toBe('fixture-saved-evidence');
  await page.locator('#jev-assist-query').fill('Next search while it evaluates');
  await page.evaluate(()=>{(window as any).__assistReleaseRun();});
  await expect(page.locator('.jev-assist-advisory')).toHaveText('Needs judgment');
  await expect(page.locator('#jev-assist-query')).toHaveValue('Next search while it evaluates');
  await expect(page.locator('#jev-assist-query')).toBeFocused();
  await expect(page.locator('.jev-assist-finding-state').nth(1)).toHaveText('Uncertain');
  await expect(page.locator('.jev-assist-report script')).toHaveCount(0);
  await page.getByRole('button',{name:'Use report in prompt',exact:true}).click();
  const attached = await page.evaluate(()=>(window as any).__assistAttached);
  expect(attached).toContain('Advisory judgments, not proof'); expect(attached).toContain('const host = "https://example.test";');
});

test('API errors preserve drafts and configured worker recommendations never change models', async ({page}) => {
  await setup(page); await open(page,{kind:'route'});
  await page.locator('#jev-assist-query').fill('Add keyboard navigation');
  await page.locator('[data-assist-prepare]').click(); await prepared(page);
  await page.evaluate(()=>{(window as any).__assistFail=true;});
  await page.locator('[data-assist-run]').click();
  await expect(page.locator('.jev-feedback')).toContainText('Jev is unavailable');
  await expect(page.locator('#jev-assist-query')).toHaveValue('Add keyboard navigation');
  await expect(page.locator('.jev-assist-advisory')).toHaveCount(0); await prepared(page);
  await page.evaluate(()=>{(window as any).__assistFail=false;}); await finish(page);
  await expect(page.locator('.jev-assist-recommendation')).toContainText('Fast worker');
  await expect(page.locator('.jev-assist-recommendation')).toContainText('models stay unchanged');
  expect(await calls(page,'configure_session')).toHaveLength(0);
  expect(await calls(page,'architect_configure')).toHaveLength(0);
});

test('saved history stays scoped and closing invalidates late async results', async ({page}) => {
  await setup(page); await open(page); await prepared(page); await finish(page);
  const saved = await page.evaluate(()=>(window as any).__assistHistory[0]);
  await page.evaluate(saved=>{(window as any).__assistHistory.push({...saved,id:'foreign',sessionId:'other-task',title:'Foreign task data'});},saved);
  await page.locator('[data-assist-close]').click(); await open(page);
  await expect(page.getByRole('combobox',{name:'Saved Jev report'}).locator('option')).toHaveCount(1);
  await expect(page.locator('#dialog')).not.toContainText('Foreign task data'); await prepared(page);
  await page.evaluate(()=>{(window as any).__assistDelayRun=true;}); await page.locator('[data-assist-run]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__assistReleaseRun)).toBe('function');
  await page.locator('[data-assist-close]').click(); await open(page,{sessionId:'another-task',kind:'context'});
  await page.evaluate(()=>{(window as any).__assistReleaseRun();});
  await expect(page.getByRole('combobox',{name:'Saved Jev report'})).toBeHidden();
  await expect(page.locator('.jev-assist-advisory')).toHaveCount(0);
});

for (const theme of ['dark','light']) test(`Jev assistance is readable in ${theme} and keyboard tabs fit narrow screens`, async ({page}) => {
  await setup(page); await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await open(page); await prepared(page); await finish(page);
  await page.screenshot({path:`/private/tmp/pandacode-jev-assist-${theme}.png`});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('tab',{name:'Work review',exact:true}).focus(); await page.keyboard.press('End');
  await expect(page.getByRole('tab',{name:'Choose worker',exact:true})).toBeFocused();
  await expect(page.getByRole('tab',{name:'Choose worker',exact:true})).toHaveAttribute('aria-selected','true');
  expect(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`/private/tmp/pandacode-jev-assist-${theme}-narrow.png`});
});
