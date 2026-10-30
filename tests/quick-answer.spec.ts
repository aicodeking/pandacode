import { test, expect } from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: `${await response.text()}\nwindow.__inlineEmit = event => agent(event);\nmessages['session-1'] = [
      {id:901,sessionId:'session-1',role:'user',content:'Inspect this scene.',createdAt:now},
      {id:902,sessionId:'session-1',role:'tool',content:encodeTool({id:'scene',name:'view_image',status:'completed',input:JSON.stringify({path:'output/scene.png'}),output:''}),createdAt:now},
      {id:903,sessionId:'session-1',role:'assistant',content:'Does the song contain explicit lyrics—Yes or No?',createdAt:now}
    ];`});
  });
  await page.goto('/');
});

test('binary answers can be selected and sent without typing', async ({page}, testInfo) => {
  const form = page.getByRole('form', {name:'Choose your answer'});
  await expect(form).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('answer-controls.png')});
  await expect(form.getByRole('radio',{name:'Yes',exact:true})).not.toBeChecked();
  await form.getByRole('radio',{name:'No',exact:true}).check();
  await form.getByRole('button',{name:'Send answer',exact:true}).click();
  await expect(page.locator('.user-message').last()).toContainText('No');
});

test('quick answers preserve an existing draft', async ({page}) => {
  await page.locator('#prompt').fill('My unsent draft');
  await page.getByRole('radio',{name:'Yes',exact:true}).check();
  await page.getByRole('button',{name:'Send answer',exact:true}).click();
  await expect(page.locator('#prompt')).toHaveValue('My unsent draft');
});

test('tool images open visibly with a close button', async ({page}, testInfo) => {
  await expect(page.locator('img[data-tool-image]')).toBeVisible();
  await page.getByRole('button',{name:'Enlarge image scene.png',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Image preview',exact:true});
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect.poll(() => dialog.getByRole('img').evaluate((node:HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({path:testInfo.outputPath('image-preview.png')});
  await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
  await expect(dialog).toBeHidden();
});


test('a live image appears without opening tool disclosures', async ({page}) => {
  await expect(page.locator('img[data-tool-image="scene"]')).toBeVisible();
  await page.evaluate(() => (window as any).__inlineEmit({sessionId:'session-1',kind:'tool',text:'view_image',tool:{id:'live-image',name:'view_image',status:'completed',input:JSON.stringify({path:'/tmp/scene.png'}),output:''}}));
  await expect(page.locator('.live-activity img[data-tool-image="live-image"]')).toBeVisible();
  await expect.poll(() => page.locator('.live-activity img[data-tool-image="live-image"]').evaluate((img:HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});
