import { expect, test, type Page } from '@playwright/test';

test('launcher preserves saved harness authors and renders handoffs beside the current live provider', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:650,height:610});
  await instrumentLauncher(page, `if (command === 'overlay_thread') return {
    provider:'kimi', status:'running', hasOlder:false, liveText:'Current Kimi response', messages:[
      {id:1,sessionId:args.sessionId,role:'user',content:'Earlier question',createdAt:1},
      {id:2,sessionId:args.sessionId,role:'assistant',content:'Original Claude answer',authorProvider:'claude',createdAt:2},
      {id:3,sessionId:args.sessionId,role:'handoff',content:JSON.stringify({fromProvider:'claude',toProvider:'kimi',summary:'Saved conversation <script>unsafe()</script> stays readable.'}),createdAt:3},
    ]};`);
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const responses = page.locator('.launcher-thread-response:visible');
  await expect(responses).toHaveCount(2);
  await expect(responses.nth(0).locator('header')).toHaveText('Claude Code');
  await expect(responses.nth(1).locator('header')).toHaveText('Kimi Code');
  const marker = page.locator('.launcher-thread-handoff');
  await expect(marker.locator('summary')).toHaveText('Conversation carried forward');
  await marker.locator('summary').click();
  await expect(marker.locator('p')).toContainText('<script>unsafe()</script>');
  await expect(marker.locator('script')).toHaveCount(0);
  await expect(page.locator('.launcher-thread-turn')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('overlay copies live Markdown and forks a saved message without opening the app', async ({page}) => {
  await page.setViewportSize({width:650,height:510});
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async (value:string) => { (window as any).__copiedMessage = value; }}});
  });
  await instrumentLauncher(page);
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const user = page.locator('.launcher-thread-user');
  const response = page.locator('.launcher-thread-response');
  await expect(response).toContainText('refining the onboarding');
  await response.getByRole('button',{name:'Copy message',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__copiedMessage)).toBe('I’m refining the onboarding flow, starting with the welcome screen and keyboard navigation.');
  await expect(response.getByRole('button',{name:'Fork from here'})).toHaveCount(0);
  await user.getByRole('button',{name:'Copy message',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__copiedMessage)).toBe('Polish the new onboarding');
  await user.getByRole('button',{name:'Fork from here'}).click();
  await expect(page.locator('.launcher-thread-heading h2')).toHaveText('Polish the new onboarding (fork)');
  await expect(user).toContainText('Polish the new onboarding');
  await expect(response).toBeHidden();
  expect(await page.evaluate(() => (window as any).__overlayCalls.filter((call:any) => call.command === 'fork_session_at_message').map((call:any) => call.args))).toEqual([{sessionId:'preview-active',messageId:1}]);
  expect(await page.evaluate(() => (window as any).__overlayCalls.some((call:any) => call.command === 'overlay_open_task'))).toBe(false);
  await page.screenshot({path:'/private/tmp/pandacode-overlay-message-fork.png'});
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect(response).toContainText('refining the onboarding');
});

test('launcher offers harness and model selection without opening the workspace', async ({page}) => {
  await page.goto('/?view=launcher');
  await page.getByRole('button', {name:'Choose harness and model'}).click();
  await expect(page.getByRole('dialog', {name:'Harness and model'})).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search harnesses and models'})).toBeFocused();
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden', 'true');
  expect(page.url()).toContain('view=launcher');
});

test('launcher model trigger toggles the picker without reopening it', async ({page}) => {
  await page.goto('/?view=launcher');
  const trigger = page.getByRole('button',{name:'Choose harness and model'});
  const picker = page.getByRole('dialog',{name:'Harness and model'});
  await trigger.click();
  await expect(picker).toBeVisible();
  await trigger.click();
  await expect(picker).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  await expect(trigger).toBeFocused();
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  await trigger.click();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
});

test('launcher shows saved team models beside its architect and preserves the count when changing models', async ({page}) => {
  await page.setViewportSize({width:490,height:410});
  await page.clock.install();
  await instrumentLauncher(page, `if (command === 'overlay_snapshot') {
    const count = window.__teamWorkerCount ?? 2;
    return {tasks, projects:[{id:'preview-project',name:'PandaCode',path:'/Projects/PandaCode'}],
      context:{...effectiveContext(),...(!previewPreferences.modelSelection && count > 0 ? {provider:'claude',model:'opus',reasoningEffort:'medium'} : {})},
      activeCount:4, teamWorkerCount:count};
  }`);
  await page.goto('/?view=launcher');
  const trigger = page.getByRole('button',{name:'Choose harness and model'});
  const suffix = trigger.locator('.launcher-team-models');
  await expect(trigger.locator('.launcher-model-name')).toContainText('Opus');
  await expect(suffix).toHaveText('+2 models');
  expect(await suffix.evaluate(el => ({shrink:getComputedStyle(el).flexShrink,clipped:el.scrollWidth > el.clientWidth}))).toEqual({shrink:'0',clipped:false});
  const triggerRect = (await trigger.boundingBox())!, suffixRect = (await suffix.boundingBox())!;
  expect(suffixRect.x + suffixRect.width).toBeLessThanOrEqual(triggerRect.x + triggerRect.width);
  await trigger.click();
  const selected = page.getByRole('option',{name:'Claude Code · Claude Opus 5',exact:true});
  await expect(selected).toHaveAttribute('aria-current','true');
  await page.getByRole('tab',{name:'Codex',exact:true}).click();
  await page.getByRole('option',{name:'Codex · GPT-5.6-Sol',exact:true}).click();
  await expect(trigger.locator('.launcher-model-name')).toHaveText('GPT-5.6-Sol');
  await expect(suffix).toHaveText('+2 models');
  await page.clock.runFor(1600);
  await expect(trigger).toHaveAttribute('title','Codex · GPT-5.6-Sol +2 models');
  await page.screenshot({path:'/private/tmp/pandacode-overlay-team-models.png'});
  await page.evaluate(() => { (window as any).__teamWorkerCount = 1; });
  await page.clock.runFor(1600);
  await expect(suffix).toHaveText('+1 model');
  await page.evaluate(() => { (window as any).__teamWorkerCount = 0; });
  await page.clock.runFor(1600);
  await expect(suffix).toHaveCount(0);
  await expect(trigger.locator('.launcher-model-name')).toHaveText('GPT-5.6-Sol');
});

/** Intercept the preview transport to exercise delays and failures without paid agent calls. */
async function instrumentLauncher(page: Page, intercept = ''): Promise<void> {
  await page.route('**/src/overlay-client.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /if \(command === ["']overlay_preferences["']\)/;
    expect(source).toMatch(marker);
    await route.fulfill({response, body:source.replace(marker, `
      (window.__overlayCalls ??= []).push({command,args:structuredClone(args)});
      ${intercept}
      $&`)});
  });
  await page.addInitScript(() => {
    window.addEventListener('pandacode-overlay-launched', event => {
      document.documentElement.dataset.lastLaunch = JSON.stringify((event as CustomEvent).detail);
    });
  });
}

test('launcher file mentions insert a quoted reference without sending and keep the launch prompt editable', async ({page}) => {
  await page.setViewportSize({width:490,height:410});
  await instrumentLauncher(page, `if (command === 'search_files') return [{name:'my notes.md',path:'src/my notes.md',isDir:false}];`);
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__overlayCalls.filter((call:any) => call.command === 'search_files'))).toHaveLength(0);
  const prompt = page.locator('#launcher-prompt');
  await prompt.fill('Review @notes');
  const menu = page.getByRole('dialog',{name:'Mention a file'});
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-file-path="src/my notes.md"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__overlayCalls.filter((call:any) => call.command === 'search_files').at(-1).args)).toMatchObject({projectId:'preview-project',query:'notes'});
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(490);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(410);
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('Review @"src/my notes.md" ');
  await expect(menu).toHaveCount(0);
  await expect(prompt).toBeFocused();
  expect(await page.evaluate(() => (window as any).__overlayCalls.some((call:any) => call.command === 'overlay_launch'))).toBe(false);
  await prompt.press('End');
  await prompt.pressSequentially('and explain the approach');
  await prompt.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__overlayCalls.find((call:any) => call.command === 'overlay_launch')?.args)).toEqual({projectId:'preview-project',prompt:'Review @"src/my notes.md" and explain the approach'});
  await expect(prompt).toHaveValue('');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
});

test('launcher file mentions stay scoped to the selected project and ignore delayed previous results', async ({page}) => {
  await instrumentLauncher(page, `if (command === 'overlay_snapshot') return {tasks,projects:[{id:'preview-project',name:'PandaCode',path:'/Projects/PandaCode'},{id:'other-project',name:'Other project',path:'/Projects/Other'}],context:effectiveContext(),activeCount:4};
    if (command === 'search_files') {
      if (args.projectId === 'preview-project') {
        await new Promise(resolve => {window.__releaseFileSearch=resolve;});
        return [{name:'old-only.ts',path:'src/old-only.ts',isDir:false}];
      }
      return [{name:'other.ts',path:'lib/other.ts',isDir:false}];
    }`);
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  const prompt = page.locator('#launcher-prompt');
  await prompt.fill('Update @');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseFileSearch)).toBe('function');
  await page.getByRole('combobox',{name:'Task project'}).selectOption('other-project');
  await prompt.focus();
  await prompt.fill('Update @other');
  const menu = page.getByRole('dialog',{name:'Mention a file'});
  await expect(menu.locator('[data-file-path="lib/other.ts"]')).toBeVisible();
  await page.evaluate(() => (window as any).__releaseFileSearch());
  await expect(menu.locator('[data-file-path="src/old-only.ts"]')).toHaveCount(0);
  await expect(menu.locator('[data-file-path="lib/other.ts"]')).toBeVisible();
  await prompt.press('Tab');
  await expect(prompt).toHaveValue('Update @lib/other.ts ');
  await expect(prompt).toBeFocused();
  await prompt.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__overlayCalls.find((call:any) => call.command === 'overlay_launch')?.args)).toEqual({projectId:'other-project',prompt:'Update @lib/other.ts'});
});

test('launcher dismisses file suggestions before opening a thread and Escape first closes suggestions', async ({page}) => {
  await instrumentLauncher(page);
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  const prompt = page.locator('#launcher-prompt');
  const menu = page.getByRole('dialog',{name:'Mention a file'});
  await prompt.fill('Read @main');
  await expect(menu).toBeVisible();
  await prompt.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(prompt).toHaveValue('Read @main');
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  await prompt.fill('Read @overlay');
  await expect(menu).toBeVisible();
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect(page.getByRole('button',{name:'Back to active agents'})).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await expect(prompt).toHaveValue('Read @overlay');
  await expect(menu).toHaveCount(0);
  await prompt.focus();
  await prompt.fill('Read @README');
  await expect(menu).toBeVisible();
  await prompt.press('Escape');
  await prompt.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-overlay-hidden','true');
  await expect(menu).toHaveCount(0);
});

test('launcher discovers full model names on demand and launches the chosen harness', async ({page}) => {
  const loaded: string[] = [];
  page.on('request', request => loaded.push(request.url()));
  await instrumentLauncher(page);
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__overlayCalls.filter((call:any) => call.command === 'list_provider_models'))).toHaveLength(0);
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  const claude = page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true});
  await expect(claude).toBeVisible();
  await expect(page.getByRole('option',{name:'Antigravity · Default',exact:true})).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search harnesses and models'}).fill('Claude Sonnet 5');
  await claude.click();
  await expect(page.getByRole('dialog',{name:'Harness and model'})).toHaveCount(0);
  await expect(page.locator('.launcher-agent')).toContainText('Claude Sonnet 5');
  await expect(page.locator('.launcher-agent .provider-logo')).toHaveCount(1);
  await page.getByRole('textbox',{name:'New task'}).fill('Use the selected Claude model');
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-last-launch') || '{}')).toMatchObject({provider:'claude',model:'sonnet',mode:'full'});
  await expect(page.locator('.launcher-task').filter({hasText:'Use the selected Claude model'})).toBeVisible();
  expect(loaded.some(url => /\/src\/(main|preview)\.ts(?:\?|$)/.test(url))).toBe(false);
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
});

test('launcher keeps its chosen harness and model through main-window context sync and reload', async ({page}) => {
  await instrumentLauncher(page);
  await page.goto('/?view=launcher');
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  await page.getByRole('option',{name:'Claude Code · Claude Opus 5',exact:true}).click();
  await expect(page.locator('.launcher-agent')).toContainText('Claude Opus 5');
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    await overlayCall('overlay_sync_context',{context:{projectId:'preview-project',provider:'codex',model:'gpt-6-astra',mode:'ask',reasoningEffort:'high'}});
  });
  await page.reload();
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await expect(page.getByRole('option',{name:'Claude Code · Claude Opus 5',exact:true})).toHaveAttribute('aria-current','true');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox',{name:'New task'}).fill('Continue with the saved model');
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-last-launch') || '{}')).toMatchObject({provider:'claude',model:'opus',reasoningEffort:null,mode:'ask'});
});

test('launcher blocks starting a task while a model change is saving', async ({page}) => {
  await instrumentLauncher(page, `if (command === 'overlay_select_model') await new Promise(resolve => {window.__releaseModelSave=resolve;});`);
  await page.goto('/?view=launcher');
  await page.getByRole('textbox',{name:'New task'}).fill('Launch with the new harness');
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  await page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseModelSave)).toBe('function');
  await expect(page.getByRole('button',{name:'Start task',exact:true})).toBeDisabled();
  await expect(page.getByRole('dialog',{name:'Harness and model'})).toHaveAttribute('aria-busy','true');
  await page.locator('.launcher-compose').dispatchEvent('submit');
  expect(await page.evaluate(() => (window as any).__overlayCalls.some((call:any) => call.command === 'overlay_launch'))).toBe(false);
  await page.evaluate(() => (window as any).__releaseModelSave());
  await expect(page.locator('.launcher-agent')).toContainText('Claude Sonnet 5');
  await expect(page.getByRole('button',{name:'Start task',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-last-launch') || '{}')).toMatchObject({provider:'claude',model:'sonnet',mode:'full'});
});

test('launcher retains its old model after a failed selection and allows retry', async ({page}) => {
  await instrumentLauncher(page, `if (command === 'overlay_select_model' && !window.__allowModelSave) throw new Error('Could not save the selected model.');`);
  await page.goto('/?view=launcher');
  const trigger = page.getByRole('button',{name:'Choose harness and model'});
  const original = await trigger.textContent();
  await trigger.click();
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  await page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('Could not save the selected model.');
  await expect(trigger).toHaveText(original!);
  await expect(page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true})).toBeEnabled();
  await page.evaluate(() => { (window as any).__allowModelSave = true; });
  await page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true}).click();
  await expect(trigger).toContainText('Claude Sonnet 5');
  await expect(page.getByRole('dialog',{name:'Harness and model'})).toHaveCount(0);
});

test('launcher ignores late model discovery after a newer selection', async ({page}) => {
  await instrumentLauncher(page, `if (command === 'list_provider_models' && args.provider === 'claude') await new Promise(resolve => {window.__releaseCatalog=resolve;});`);
  await page.goto('/?view=launcher');
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseCatalog)).toBe('function');
  await page.getByRole('tab',{name:'Codex',exact:true}).click();
  await page.getByRole('option',{name:'Codex · GPT-5.6-Sol',exact:true}).click();
  await expect(page.locator('.launcher-agent')).toContainText('GPT-5.6-Sol');
  await page.evaluate(() => (window as any).__releaseCatalog());
  await expect(page.getByRole('dialog',{name:'Harness and model'})).toHaveCount(0);
  await expect(page.locator('.launcher-agent')).toContainText('GPT-5.6-Sol');
  await page.getByRole('textbox',{name:'New task'}).fill('Use the latest selection');
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-last-launch') || '{}')).toMatchObject({provider:'codex',model:'gpt-5.6-sol'});
});

test('launcher keeps a saved model when an older status snapshot arrives late', async ({page}) => {
  await instrumentLauncher(page, `if (command === 'overlay_snapshot' && window.__holdNextSnapshot) {
    window.__holdNextSnapshot=false;
    const oldSnapshot=structuredClone(window.__oldSnapshot);
    await new Promise(resolve => {window.__releaseSnapshot=resolve;});
    return oldSnapshot;
  }`);
  await page.clock.install();
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    (window as any).__oldSnapshot = await overlayCall('overlay_snapshot');
    (window as any).__holdNextSnapshot = true;
  });
  await page.clock.runFor(1600);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseSnapshot)).toBe('function');
  await page.getByRole('button',{name:'Choose harness and model'}).click();
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  await page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true}).click();
  await expect(page.locator('.launcher-agent')).toContainText('Claude Sonnet 5');
  await page.evaluate(() => (window as any).__releaseSnapshot());
  await page.clock.runFor(100);
  await expect(page.locator('.launcher-agent')).toContainText('Claude Sonnet 5');
  await page.getByRole('textbox',{name:'New task'}).fill('Preserve my model selection');
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-last-launch') || '{}')).toMatchObject({provider:'claude',model:'sonnet',mode:'full'});
});

test('launcher model picker fits the minimum window and Escape only closes the picker', async ({page}) => {
  await page.setViewportSize({width:490,height:410});
  await page.goto('/?view=launcher');
  const trigger = page.getByRole('button',{name:'Choose harness and model'});
  await trigger.click();
  const picker = page.getByRole('dialog',{name:'Harness and model'});
  await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
  await expect(page.getByRole('option',{name:'Claude Code · Claude Sonnet 5',exact:true})).toBeAttached();
  const rect = await picker.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(490);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(410);
  await page.getByRole('combobox', { name: 'Search harnesses and models'}).fill('GLM Coding Plan');
  const glm = page.locator('.model-menu-option[data-provider="glm"][data-model="glm-5.3"]');
  await expect(glm).toBeInViewport();
  await expect(glm.locator('.provider-logo')).toHaveCount(1);
  await expect(picker).toHaveAttribute('data-popover-state','open');
  await expect(picker).toHaveCSS('opacity','1');
  await page.screenshot({path:'/private/tmp/pandacode-overlay-check/model-picker.png'});
  // The first Escape clears the search, the second closes the picker.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Search harnesses and models'})).toHaveValue('');
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test('launcher stays lightweight and starts concurrent tasks without opening the workspace', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', request => loaded.push(request.url()));
  await page.goto('/?view=launcher');
  await expect(page.getByRole('main', {name:'PandaCode quick launcher'})).toBeVisible();
  await expect(page.locator('.launcher-task[data-task="preview-active"]')).toBeVisible();
  await expect(page.getByRole('button',{name:/Build a responsive gallery/})).toContainText('Needs attention');
  await expect(page.locator('.launcher-count')).toHaveText('4 active');
  await expect(page.getByRole('button', {name:/Review the API changes/})).toHaveCount(0);
  await expect(page.getByRole('button', {name:/Build search indexing/})).toBeVisible();
  await expect(page.getByRole('button', {name:/Audit accessibility/})).toBeVisible();
  expect(loaded.some(url => /\/src\/(main|preview)\.ts(?:\?|$)/.test(url))).toBe(false);
  await page.getByRole('textbox', {name:'New task'}).fill('Add keyboard navigation');
  await page.getByRole('textbox', {name:'New task'}).press('Enter');
  await expect(page.getByRole('button', {name:/Add keyboard navigation/})).toBeVisible();
  await expect(page.getByRole('textbox', {name:'New task'})).toHaveValue('');
  await page.getByRole('textbox', {name:'New task'}).fill('Review the accessibility');
  await page.getByRole('button', {name:'Start task', exact:true}).click();
  await expect(page.getByRole('button', {name:/Review the accessibility/})).toBeVisible();
  await expect(page.locator('.launcher-count')).toHaveText('6 active');
  expect(page.url()).toContain('view=launcher');
});

test('launcher search and keyboard navigation preserve task identity during status refresh', async ({page}) => {
  await page.goto('/?view=launcher');
  const task = page.locator('.launcher-task[data-task="preview-active"]');
  await expect(task).toBeVisible();
  await task.evaluate(el => el.setAttribute('data-original-node','yes'));
  await page.clock.install();
  await page.clock.runFor(1700);
  await expect(task).toHaveAttribute('data-original-node','yes');
  await page.getByRole('searchbox',{name:'Search tasks'}).fill('gallery');
  await expect(page.locator('.launcher-task')).toHaveCount(1);
  await page.getByRole('searchbox',{name:'Search tasks'}).press('ArrowDown');
  await expect(page.getByRole('button',{name:/Build a responsive gallery/})).toBeFocused();
  await page.evaluate(() => { window.addEventListener('pandacode-overlay-open-task', event => document.documentElement.dataset.openedTask = (event as CustomEvent).detail.sessionId); });
  await page.keyboard.press('Enter');
  await expect(page.locator('.launcher-thread')).toBeVisible();
  await expect(page.locator('.launcher-thread h2')).toHaveText('Build a responsive gallery');
  await expect(page.locator('.launcher-thread-scroll')).toContainText('waiting for approval');
  await expect(page.locator('html')).not.toHaveAttribute('data-opened-task');
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.launcher-thread')).toBeHidden();
  await expect(page.locator('.launcher-task-area')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-overlay-hidden','true');
});

for (const child of [
  {id:'preview-active',name:'Polish the new onboarding', response:'refining the onboarding flow', payload:{sessionId:'preview-active'}},
  {id:'preview-worker',name:'Build search indexing', response:'built the search index', payload:{sessionId:'preview-worker'}},
  {id:'preview-subagent',name:'Audit accessibility', response:'checking keyboard navigation and contrast', payload:{sessionId:'preview-active',subagentId:'preview-child'}},
]) test(`launcher reads ${child.name} inside the overlay and opens the app only when requested`, async ({page}) => {
  const loaded: string[] = [];
  page.on('request', request => loaded.push(request.url()));
  await page.goto('/?view=launcher');
  const row = page.locator(`.launcher-task[data-task="${child.id}"]`);
  await expect(row).toBeVisible();
  await page.evaluate(() => { window.addEventListener('pandacode-overlay-open-task', event => document.documentElement.dataset.openedPayload = JSON.stringify((event as CustomEvent).detail)); });
  await row.click();
  await expect(page.locator('.launcher-thread')).toBeVisible();
  await expect(page.locator('.launcher-thread h2')).toHaveText(child.name);
  await expect(page.locator('.launcher-thread-scroll')).toContainText(child.response);
  await expect(page.getByRole('textbox',{name:'New task'})).toBeHidden();
  await expect(page.locator('html')).not.toHaveAttribute('data-opened-payload');
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  expect(page.url()).toContain('view=launcher');
  expect(loaded.some(url => /\/src\/(main|preview)\.ts(?:\?|$)/.test(url))).toBe(false);
  await page.getByRole('button',{name:'Open in app',exact:true}).click();
  await expect.poll(() => page.locator('html').getAttribute('data-opened-payload')).toBe(JSON.stringify(child.payload));
});

test('launcher renders internal coordination as neutral Team status and preserves user JSON after reload', async ({page}) => {
  const userJson = '{"workers":[{"name":"Keep this user JSON","status":"ready"}]}';
  const messages = [
    {id:601,sessionId:'preview-active',role:'user',content:userJson,createdAt:1000},
    {id:602,sessionId:'preview-active',role:'assistant',content:'I will coordinate the requested work.',createdAt:2000},
    {id:603,sessionId:'preview-active',role:'coordination',coordinationKind:'worker_update',content:'Checking worker updates',createdAt:3000},
    {id:604,sessionId:'preview-active',role:'assistant',content:'The builder finished the requested work.',createdAt:4000},
    {id:605,sessionId:'preview-active',role:'changes',content:'',createdAt:4000,turnChanges:{id:'worker-files',files:[{path:'src/search.ts',status:'added',additions:12,deletions:0}],additions:12,deletions:0,truncated:false,concurrent:false}},
    {id:606,sessionId:'preview-active',role:'coordination',coordinationKind:'worker_review',content:'Reviewing worker results',createdAt:5000},
    {id:607,sessionId:'preview-active',role:'assistant',content:'The worker review passed.',createdAt:6000},
  ];
  await instrumentLauncher(page, `if (command === 'overlay_thread' && args.sessionId === 'preview-active') return {messages:${JSON.stringify(messages)},hasOlder:false,liveText:'',status:'running'};`);
  await page.goto('/?view=launcher');
  for (const reload of [false,true]) {
    if (reload) await page.reload();
    await page.locator('.launcher-task[data-task="preview-active"]').click();
    const history = page.locator('.launcher-thread-history');
    const status = history.locator('.coordination-status[aria-label="Team status"]');
    await expect(status).toHaveCount(2);
    await expect(status.nth(0)).toBeVisible(); await expect(status.nth(0)).toContainText('Checking worker updates');
    await expect(status.nth(1)).toBeVisible(); await expect(status.nth(1)).toContainText('Reviewing worker results');
    expect(await status.evaluateAll(rows => rows.every(el => !el.closest('.launcher-thread-user, .launcher-thread-response')))).toBe(true);
    await expect(status.locator('.provider-logo')).toHaveCount(0);
    await expect(history.locator('.launcher-thread-user:visible')).toHaveCount(1);
    await expect(history.locator('.launcher-thread-user:visible')).toContainText('You');
    await expect(history.locator('.launcher-thread-user:visible')).toContainText(userJson);
    const responses = history.locator('.launcher-thread-response:visible');
    await expect(responses).toHaveCount(3);
    await expect(responses.nth(0)).toContainText('I will coordinate the requested work.');
    await expect(responses.nth(1)).toContainText('The builder finished the requested work.');
    await expect(responses.nth(2)).toContainText('The worker review passed.');
    expect(page.url()).toContain('view=launcher');
  }
});

test('launcher keeps live narratives between compact tool groups and preserves late updates', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:650,height:610});
  await page.clock.install();
  await instrumentLauncher(page, `if (command === 'overlay_thread') {
    const message = (id,role,content) => ({id,sessionId:args.sessionId,role,content,createdAt:id * 1000});
    const tool = (id,name,status,input) => JSON.stringify({type:'tool_activity',version:1,id,name,status,input,output:''});
    const fixture = window.__chronologicalThread ??= {version:1,status:'running',messages:[
      message(1,'user','Inspect the launch flow.'),
      message(2,'assistant','I will inspect the current launcher.'),
      message(3,'tool',tool('read-launcher','Read','running','src/overlay.ts')),
      message(4,'tool',tool('read-client','Read','completed','src/overlay-client.ts')),
      message(5,'assistant','The client is ready; I will verify the behavior.'),
      message(6,'tool',tool('verify-launcher','Bash','running','npm test')),
    ]};
    const unchanged = args.historyVersion === fixture.version;
    return structuredClone({messages:unchanged ? [] : fixture.messages,hasOlder:false,liveText:'',status:fixture.status,historyVersion:fixture.version,historyUnchanged:unchanged});
  }`);
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const activity = page.locator('.launcher-thread-activity');
  await expect(activity).toHaveJSProperty('open',true);
  const narratives = activity.locator('[data-commentary]');
  await expect(narratives).toHaveCount(2);
  await expect(narratives.nth(0)).toBeVisible();
  await expect(narratives.nth(1)).toBeVisible();
  const groups = activity.locator('details.tool-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator(':scope > summary')).toContainText('Read 2 files');
  await expect(groups.nth(1).locator(':scope > summary')).toContainText('Running 1 command');
  await expect(groups.nth(0)).toHaveJSProperty('open',false);
  await expect(groups.nth(1)).toHaveJSProperty('open',false);
  const sequence = () => activity.locator('[data-commentary], details.tool-group').evaluateAll(elements => elements.map(element => element.matches('.tool-group') ? element.querySelector('.tool-group-label')!.textContent : element.textContent));
  const originalSequence = await sequence();
  expect(originalSequence).toEqual([
    expect.stringContaining('I will inspect the current launcher.'),
    expect.stringContaining('Read 2 files'),
    expect.stringContaining('The client is ready; I will verify the behavior.'),
    expect.stringContaining('Running 1 command'),
  ]);
  await groups.nth(0).locator(':scope > summary').click();
  const firstTool = groups.nth(0).locator('[data-tool-key="tool:read-launcher"]');
  await firstTool.locator(':scope > summary').click();
  await page.evaluate(() => {
    const fixture = (window as any).__chronologicalThread;
    const message = fixture.messages.find((message:any) => message.id === 3);
    // Longer than the card's preview, so the full output stays behind the row's disclosure.
    message.content = JSON.stringify({...JSON.parse(message.content),status:'completed',output:'The launcher inspection is complete.\n' + 'checked\n'.repeat(12)});
    fixture.version++;
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'tool',text:''}}));
  });
  await page.clock.runFor(1600);
  await expect(firstTool).toHaveAttribute('data-tool-status','completed');
  await expect(firstTool).toHaveJSProperty('open',true);
  await expect(groups.nth(0)).toHaveJSProperty('open',true);
  await expect(groups.nth(1)).toHaveJSProperty('open',false);
  await expect(firstTool.locator('[data-tool-section="output"]')).toContainText('The launcher inspection is complete.');
  expect(await sequence()).toEqual([originalSequence[0], 'Read 2 files', originalSequence[2], originalSequence[3]]);
  await page.screenshot({path:'/private/tmp/pandacode-overlay-chronological-tools.png'});
  await page.evaluate(() => {
    const fixture = (window as any).__chronologicalThread;
    fixture.status = 'completed'; fixture.version++;
    fixture.messages.push({id:7,sessionId:'preview-active',role:'assistant',content:'The launch flow is verified.',createdAt:7000});
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'done',text:''}}));
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-thread-response:visible')).toContainText('The launch flow is verified.');
  await expect(activity).toHaveJSProperty('open',true);
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect(activity).toHaveJSProperty('open',false);
  await expect(page.locator('.launcher-thread-response:visible')).toContainText('The launch flow is verified.');
  expect(errors).toEqual([]);
});

test('launcher streams the selected thread in place and keeps its completed response readable', async ({page}) => {
  await page.clock.install();
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const history = page.locator('.launcher-thread-message').first();
  await expect(history).toBeVisible();
  await history.evaluate(element => element.setAttribute('data-original-node','history'));
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const thread = await overlayCall('overlay_thread',{sessionId:'preview-active'}) as {liveText:string};
    thread.liveText += '\n\nKeyboard navigation now works across all onboarding steps.';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'text',text:'\n\nKeyboard navigation now works across all onboarding steps.'}}));
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-thread-live')).toContainText('Keyboard navigation now works');
  await expect(history).toHaveAttribute('data-original-node','history');
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const thread = await overlayCall('overlay_thread',{sessionId:'preview-active'}) as {liveText:string;status:string;messages:unknown[]};
    thread.status = 'completed';
    thread.messages.push({id:2,sessionId:'preview-active',role:'assistant',content:'The onboarding is ready. Keyboard navigation and focus states are verified.',createdAt:Date.now()});
    thread.liveText = '';
    const snapshot = await overlayCall('overlay_snapshot') as {tasks:{id:string;status:string}[]};
    snapshot.tasks.find(task=>task.id==='preview-active')!.status='completed';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'done',text:''}}));
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-thread-scroll')).toContainText('The onboarding is ready.');
  await expect(page.locator('.launcher-thread')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await expect(page.locator('.launcher-task[data-task="preview-active"]')).toHaveCount(0);
  await expect(page.locator('.launcher-count')).toHaveText('3 active');
});

for (const task of ['preview-active', 'preview-worker']) {
  test(`launcher preserves unchanged transcript DOM while still refreshing ${task} updates and recovery`, async ({page}) => {
    await page.clock.install();
    await instrumentLauncher(page, `if (command === 'overlay_thread') {
      const fixture = window.__stableThread ??= {calls:0,fail:false,version:1,live:'The first streaming response.',status:'running',messages:[
        {id:1,sessionId:args.sessionId,role:'user',content:'Keep the saved requirements.',createdAt:1000},
        {id:2,sessionId:args.sessionId,role:'assistant',content:'The original response is preserved.',createdAt:2000},
      ]};
      fixture.calls++;
      if (fixture.fail) throw new Error('Temporary connection failure');
      const unchanged = args.historyVersion === fixture.version;
      return structuredClone({messages:unchanged ? [] : fixture.messages,hasOlder:false,liveText:fixture.live,status:fixture.status,historyVersion:fixture.version,historyUnchanged:unchanged});
    }`);
    await page.goto('/?view=launcher');
    await page.locator(`.launcher-task[data-task="${task}"]`).click();
    const history = page.locator('.launcher-thread-history');
    await expect(history).toContainText('The first streaming response.');
    await page.clock.runFor(100);
    await history.evaluate(host => {
      const win = window as any;
      win.__threadMutations = 0;
      win.__threadObserver = new MutationObserver(records => { win.__threadMutations += records.length; });
      win.__threadObserver.observe(host,{subtree:true,childList:true,attributes:true,characterData:true});
    });
    const initialCalls = await page.evaluate(() => (window as any).__stableThread.calls);
    await page.clock.runFor(3200);
    expect(await page.evaluate(() => (window as any).__stableThread.calls)).toBeGreaterThan(initialCalls);
    expect(await page.evaluate(() => (window as any).__threadMutations)).toBe(0);
    await page.evaluate(() => { (window as any).__threadObserver.disconnect(); (window as any).__stableThread.live = 'A newly streamed response replaces the last one.'; });
    await page.clock.runFor(1600);
    await expect(history).toContainText('A newly streamed response replaces the last one.');
    await expect(history).not.toContainText('The first streaming response.');
    await page.evaluate(() => { (window as any).__stableThread.status = 'waiting'; });
    await page.clock.runFor(1600);
    await expect(page.locator('.launcher-thread-status')).toHaveText('Needs attention');
    await page.evaluate(() => {
      const fixture = (window as any).__stableThread;
      fixture.version++;
      fixture.messages.push({id:3,sessionId:'preview-active',role:'coordination',coordinationKind:'worker_update',content:'Checking worker updates',createdAt:3000});
      fixture.live = 'The coordination response remains visible.';
    });
    await page.clock.runFor(1600);
    await expect(history.locator('.coordination-status')).toHaveText('TeamChecking worker updates');
    await expect(history).toContainText('The coordination response remains visible.');
    await page.evaluate(() => { (window as any).__stableThread.fail = true; });
    await page.clock.runFor(1600);
    await expect(page.getByRole('button',{name:'Retry loading conversation'})).toBeVisible();
    await expect(page.locator('.launcher-thread-notice')).toContainText('Temporary connection failure');
    await page.evaluate(() => { (window as any).__stableThread.fail = false; });
    await page.getByRole('button',{name:'Retry loading conversation'}).click();
    await page.clock.runFor(250);
    await expect(page.locator('.launcher-thread-notice')).toBeHidden();
    await expect(page.getByRole('button',{name:'Retry loading conversation'})).toBeHidden();
    await expect(history.locator('.coordination-status')).toBeVisible();
    await expect(history).toContainText('The coordination response remains visible.');
  });
}

test('launcher restores its empty conversation state after an unchanged snapshot recovers', async ({page}) => {
  await page.clock.install();
  await instrumentLauncher(page, `if (command === 'overlay_thread') {
    if (window.__emptyThreadFailure) throw new Error('Temporary connection failure');
    return {messages:[],hasOlder:false,liveText:'',status:'running',historyVersion:0,historyUnchanged:args.historyVersion === 0};
  }`);
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const empty = page.locator('.launcher-thread-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('The agent is getting started…');
  await page.evaluate(() => { (window as any).__emptyThreadFailure = true; });
  await page.clock.runFor(1600);
  await expect(empty).toBeHidden();
  await expect(page.getByRole('button',{name:'Retry loading conversation'})).toBeVisible();
  await page.evaluate(() => { (window as any).__emptyThreadFailure = false; });
  await page.getByRole('button',{name:'Retry loading conversation'}).click();
  await page.clock.runFor(250);
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('The agent is getting started…');
  await expect(page.locator('.launcher-thread-notice')).toBeHidden();
  await expect(page.getByRole('button',{name:'Retry loading conversation'})).toBeHidden();
});

test('launcher keeps worker and subagent responses separate while receiving live updates', async ({page}) => {
  await page.clock.install();
  await page.goto('/?view=launcher');
  await page.getByRole('button',{name:/Build search indexing/}).click();
  await expect(page.locator('.launcher-thread-scroll')).toContainText('built the search index');
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const thread = await overlayCall('overlay_thread',{sessionId:'preview-active'}) as {liveText:string};
    thread.liveText = 'Unrelated architect response';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'text',text:'Unrelated architect response'}}));
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-thread-scroll')).not.toContainText('Unrelated architect response');
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await page.getByRole('button',{name:/Audit accessibility/}).click();
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const thread = await overlayCall('overlay_thread',{sessionId:'preview-active',subagentId:'preview-child'}) as {subagent:{response:string;status:string}};
    thread.subagent.response += '\n\nChecked the final contrast ratios.';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'subagent',text:'',data:thread.subagent}}));
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-thread-scroll')).toContainText('Checked the final contrast ratios.');
  await expect(page.locator('.launcher-thread-scroll')).not.toContainText('Unrelated architect response');
  await expect(page.locator('.launcher-thread-scroll')).not.toContainText('built the search index');
});

test('launcher ignores a delayed thread response after switching agents or closing the overlay', async ({page}) => {
  await page.route('**/src/overlay-client.ts*',async route => {
    const original = await route.fetch();
    const source = await original.text();
    const marker = /if \(command === ["']overlay_thread["']\)/;
    expect(source).toMatch(marker);
    const gate = `if (command === 'overlay_thread' && window.__overlayThreadGate?.hold === args.sessionId) {
      await new Promise(resolve => { window.__overlayThreadGate.release = resolve; });
    }
    `;
    await route.fulfill({response:original,body:source.replace(marker,gate+'$&')});
  });
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task[data-task="preview-active"]')).toBeVisible();
  await page.evaluate(() => { (window as any).__overlayThreadGate={hold:'preview-active'}; });
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__overlayThreadGate.release)).toBe('function');
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await page.getByRole('button',{name:/Build search indexing/}).click();
  await expect(page.locator('.launcher-thread-scroll')).toContainText('built the search index');
  await page.evaluate(() => { (window as any).__overlayThreadGate.release(); });
  await expect(page.locator('.launcher-thread h2')).toHaveText('Build search indexing');
  await expect(page.locator('.launcher-thread-scroll')).not.toContainText('refining the onboarding flow');
  await page.getByRole('button',{name:'Back to active agents'}).click();
  await page.evaluate(() => { (window as any).__overlayThreadGate={hold:'preview-active'}; });
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__overlayThreadGate.release)).toBe('function');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__overlayThreadGate.hold=''; (window as any).__overlayThreadGate.release(); });
  await expect(page.locator('html')).toHaveAttribute('data-overlay-hidden','true');
  await expect(page.locator('.launcher-thread')).toBeHidden();
});

test('launcher fills collapsed history automatically without rolling back a newer live response', async ({page}) => {
  await page.route('**/src/overlay-client.ts*',async route => {
    const original = await route.fetch();
    const source = await original.text();
    const marker = /if \(command === ["']overlay_thread["']\)/;
    expect(source).toMatch(marker);
    const fixture = `if (command === 'overlay_thread' && args.sessionId === 'preview-active') {
      const fixture = window.__overlayHistory ??= {calls:[],live:'Initial live snapshot',release:null};
      fixture.calls.push(structuredClone(args));
      const message = (id,role,content) => ({id,sessionId:args.sessionId,role,content,createdAt:Date.now()});
      if (args.beforeId) {
        const older = {messages:[message(1,'user','Keep the original accessibility requirements.'),message(2,'assistant','The initial review is saved.'),message(100,'user','Continue with the implementation.')],hasOlder:false,liveText:'Stale response from the older page',status:'idle',historyVersion:199};
        await new Promise(resolve => { fixture.release=resolve; });
        return older;
      }
      const unchanged = args.historyVersion === 200;
      return {messages:unchanged ? [] : Array.from({length:100},(_,index)=>message(index+101,'tool',JSON.stringify({type:'tool_activity',version:1,id:'tool-'+index,name:'Read',status:'completed',input:'src/file-'+index+'.ts',output:'Read complete'}))),hasOlder:!unchanged,liveText:fixture.live,status:'running',historyVersion:200,historyUnchanged:unchanged};
    }
    `;
    await route.fulfill({response:original,body:source.replace(marker,fixture+'$&')});
  });
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect(page.locator('.launcher-thread-live')).toContainText('Initial live snapshot');
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__overlayHistory.release)).toBe('function');
  expect(await page.evaluate(()=>(window as any).__overlayHistory.calls.some((call:any)=>call.beforeId===101))).toBe(true);
  await page.evaluate(() => {
    (window as any).__overlayHistory.live='The latest streaming response is preserved.';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'text',text:'The latest streaming response is preserved.'}}));
  });
  await expect(page.locator('.launcher-thread-live')).toContainText('The latest streaming response is preserved.');
  await page.evaluate(() => { (window as any).__overlayHistory.release(); });
  await expect(page.locator('.launcher-thread-user').filter({hasText:'Keep the original accessibility requirements.'})).toBeVisible();
  await expect(page.locator('.launcher-thread-live')).toContainText('The latest streaming response is preserved.');
  await expect(page.locator('.launcher-thread-scroll')).not.toContainText('Stale response from the older page');
  await expect(page.getByRole('button',{name:/Load earlier/i})).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__overlayHistory.live='Streaming continues after earlier history arrives.';
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event',{detail:{sessionId:'preview-active',kind:'text',text:'Streaming continues after earlier history arrives.'}}));
  });
  await expect(page.locator('.launcher-thread-live')).toContainText('Streaming continues after earlier history arrives.');
  await expect(page.locator('.launcher-thread-user').filter({hasText:'Keep the original accessibility requirements.'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__overlayHistory.calls.filter((call:any)=>!call.beforeId).slice(1).every((call:any)=>call.historyVersion===200))).toBe(true);
});

test('launcher loads beyond 300 messages when scrolling up without losing the latest response', async ({page}) => {
  await page.route('**/src/overlay-client.ts*', async route => {
    const original = await route.fetch(), source = await original.text();
    const marker = /if \(command === ["']overlay_thread["']\)/;
    expect(source).toMatch(marker);
    await route.fulfill({response:original, body:source.replace(marker, `if (command === 'overlay_thread' && args.sessionId === 'preview-active') {
      const total = window.__overlayLongHistoryTotal ??= 450;
      const all = Array.from({length:total}, (_,index) => ({id:index+1,sessionId:args.sessionId,role:index%2?'assistant':'user',content:'Saved conversation '+(index+1),createdAt:index+1}));
      const eligible = all.filter(message => !args.beforeId || message.id < args.beforeId);
      return {messages:eligible.slice(-100),hasOlder:eligible.length>100,liveText:'Latest response remains visible.',status:'running',historyVersion:total};
    } $&`)});
  });
  await page.goto('/?view=launcher');
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  const scroll = page.locator('.launcher-thread-scroll');
  await expect(scroll.locator('[data-message-id="351"]')).toHaveCount(1);
  for (const first of [251,151,51,1]) {
    await scroll.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await expect(scroll.locator(`[data-message-id="${first}"]`)).toHaveCount(1);
  }
  await expect(scroll).toContainText('Saved conversation 450');
  await expect(scroll.locator('.launcher-thread-live')).toContainText('Latest response remains visible.');
  await page.evaluate(() => {
    (window as any).__overlayLongHistoryTotal = 650;
    window.dispatchEvent(new CustomEvent('pandacode-overlay-agent-event', {detail:{sessionId:'preview-active',kind:'done',text:''}}));
  });
  await expect(scroll.locator('[data-message-id="451"]')).toHaveCount(1);
  await expect(scroll.locator('[data-message-id="551"]')).toHaveCount(1);
  await expect(scroll.locator('[data-message-id="1"]')).toHaveCount(1);
  await expect(page.getByRole('button', {name:/Load earlier/i})).toHaveCount(0);
});

test('launcher removes completed agents while preserving other rows and shows an empty active list', async ({page}) => {
  await page.clock.install();
  await page.goto('/?view=launcher');
  const parent = page.locator('.launcher-task[data-task="preview-active"]');
  const approval = page.getByRole('button',{name:/Build a responsive gallery/});
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await parent.evaluate(element => element.setAttribute('data-original-node','parent'));
  await approval.evaluate(element => element.setAttribute('data-original-node','approval'));
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const snapshot = await overlayCall('overlay_snapshot') as {tasks:{id:string;status:string}[]};
    snapshot.tasks.find(task=>task.id==='preview-worker')!.status='completed';
  });
  await page.clock.runFor(1600);
  await expect(page.getByRole('button',{name:/Build search indexing/})).toHaveCount(0);
  await expect(page.locator('.launcher-count')).toHaveText('3 active');
  await expect(parent).toHaveAttribute('data-original-node','parent');
  await expect(approval).toHaveAttribute('data-original-node','approval');
  await expect(page.getByRole('button',{name:/Audit accessibility/})).toBeVisible();
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const snapshot = await overlayCall('overlay_snapshot') as {tasks:{status:string}[]};
    snapshot.tasks.forEach(task=>{task.status='completed';});
  });
  await page.clock.runFor(1600);
  await expect(page.locator('.launcher-task')).toHaveCount(0);
  await expect(page.locator('.launcher-empty')).toBeVisible();
  await expect(page.locator('.launcher-empty')).not.toHaveText('Loading tasks…');
  await expect(page.getByRole('button',{name:/Review the API changes/})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'New task'})).toBeEnabled();
});

test('launcher preserves multiline input and stops activity when dismissed', async ({page}) => {
  await page.goto('/?view=launcher');
  const input = page.getByRole('textbox',{name:'New task'});
  await input.fill('First line'); await input.press('Shift+Enter'); await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await input.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-overlay-hidden','true');
});

test('launcher shortcut settings save, reject invalid shortcuts and persist on reload', async ({page}) => {
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {mountOverlaySettings} = await import('/src/overlay-settings.ts');
    document.querySelector('#app')!.innerHTML = '<div id="test-settings"></div>';
    mountOverlaySettings(document.querySelector<HTMLElement>('#test-settings')!);
  });
  await expect(page.getByRole('checkbox',{name:'Enable quick launcher'})).toBeEnabled();
  await page.getByRole('textbox',{name:'Keyboard shortcut'}).fill('Control+Alt+B');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('textbox',{name:'Keyboard shortcut'}).fill('Space');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Use a shortcut');
  await page.reload();
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {mountOverlaySettings} = await import('/src/overlay-settings.ts');
    document.querySelector('#app')!.innerHTML = '<div id="test-settings"></div>';
    mountOverlaySettings(document.querySelector<HTMLElement>('#test-settings')!);
  });
  await expect(page.getByRole('textbox',{name:'Keyboard shortcut'})).toHaveValue('Control+Alt+B');
});

test('launcher settings retain unavailable shortcut warnings and keep manual Open usable', async ({page}) => {
  const warning = 'Global shortcuts are unavailable. Linux shortcuts require X11; Wayland support depends on your desktop. Use Open in Quick launcher settings.';
  await instrumentLauncher(page, `
    if (command === 'overlay_preferences') return {...previewPreferences,error:${JSON.stringify(warning)}};
    if (command === 'overlay_save_preferences') return {...previewPreferences,...args,error:${JSON.stringify(warning)}};
    if (command === 'overlay_recording') throw new Error(${JSON.stringify(warning)});
    if (command === 'overlay_toggle') return;
  `);
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {mountOverlaySettings} = await import('/src/overlay-settings.ts');
    document.querySelector('#app')!.innerHTML = '<div id="test-settings"></div>';
    mountOverlaySettings(document.querySelector<HTMLElement>('#test-settings')!);
  });
  await expect(page.getByRole('status')).toHaveText(warning);
  await page.getByRole('checkbox',{name:'Enable quick launcher'}).uncheck();
  await expect(page.getByRole('status')).toHaveText(warning);
  await expect.poll(() => page.evaluate(() => (window as any).__overlayCalls.find((call:any) => call.command === 'overlay_save_preferences')?.args.enabled)).toBe(false);
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await expect(page.getByRole('status')).toContainText(warning);
  await expect(page.getByRole('button',{name:'Open',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Open',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__overlayCalls.some((call:any) => call.command === 'overlay_toggle'))).toBe(true);
});

test('shortcut recorder captures physical keys and Escape cancels without closing settings', async ({page}) => {
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {mountOverlaySettings} = await import('/src/overlay-settings.ts');
    document.querySelector('#app')!.innerHTML = '<div id="test-settings"></div>';
    mountOverlaySettings(document.querySelector<HTMLElement>('#test-settings')!);
  });
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Press your shortcut');
  await page.getByRole('textbox',{name:'Keyboard shortcut'}).press('Control+Alt+KeyK');
  await expect(page.getByRole('textbox',{name:'Keyboard shortcut'})).toHaveValue('Control+Alt+KeyK');
  await expect(page.getByRole('status')).toContainText('Save to apply');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await page.getByRole('textbox',{name:'Keyboard shortcut'}).press('Escape');
  await expect(page.getByRole('textbox',{name:'Keyboard shortcut'})).toHaveValue('Control+Alt+KeyK');
  await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden','true');
});

test('shortcut recorder names the Windows key portably and keeps Control shortcuts', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', {get: () => 'Win32'}));
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task')).toHaveCount(4);
  await page.evaluate(async () => {
    const {mountOverlaySettings} = await import('/src/overlay-settings.ts');
    document.querySelector('#app')!.innerHTML = '<div id="test-settings"></div>';
    mountOverlaySettings(document.querySelector<HTMLElement>('#test-settings')!);
  });
  const input = page.getByRole('textbox',{name:'Keyboard shortcut'});
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await input.press('KeyK');
  await expect(page.getByRole('status')).toHaveText('Include Control, Alt, Shift, or the Windows key.');
  await input.dispatchEvent('keydown',{key:'k',code:'KeyK',metaKey:true,shiftKey:true});
  await expect(input).toHaveValue('Super+Shift+KeyK');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button',{name:'Record',exact:true}).click();
  await input.press('Control+Alt+KeyK');
  await expect(input).toHaveValue('Control+Alt+KeyK');
});

test('launcher fits small windows and keeps task controls accessible', async ({page}) => {
  await page.setViewportSize({width:490,height:410});
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task[data-task="preview-active"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await expect(page.locator('.launcher')).toHaveCSS('opacity','1');
  await page.getByRole('searchbox',{name:'Search tasks'}).focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
  const lastRow = page.locator('.launcher-task').last();
  await expect(lastRow).toBeFocused(); await expect(lastRow).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(page.locator('.launcher-task').first()).toBeFocused();
  await page.screenshot({path:'/private/tmp/pandacode-overlay-check/launcher.png'});
});

test('launcher thread stays readable and scrollable at minimum window size', async ({page}) => {
  await page.setViewportSize({width:490,height:410});
  await page.goto('/?view=launcher');
  await expect(page.locator('.launcher-task[data-task="preview-active"]')).toBeVisible();
  await page.evaluate(async () => {
    const {overlayCall} = await import('/src/overlay-client.ts');
    const thread = await overlayCall('overlay_thread',{sessionId:'preview-active'}) as {liveText:string};
    thread.liveText = Array.from({length:20},(_,index)=>`Step ${index+1}: I verified the keyboard controls and focus states.`).join('\n\n');
  });
  await page.locator('.launcher-task[data-task="preview-active"]').click();
  await expect(page.locator('.launcher-thread-live')).toContainText('Step 20:');
  await expect(page.getByRole('button',{name:'Back to active agents'})).toBeInViewport();
  await expect(page.getByRole('button',{name:'Open in app',exact:true})).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  const scroll = page.locator('.launcher-thread-scroll');
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 100)).toBe(true);
  await scroll.evaluate(element => { element.scrollTop=element.scrollHeight; });
  expect(await scroll.evaluate(element => element.scrollTop > 0)).toBe(true);
  await page.screenshot({path:'/private/tmp/pandacode-overlay-check/thread.png'});
});
