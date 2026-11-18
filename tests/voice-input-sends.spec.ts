import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release, mockVoiceSend, chooseSendTarget } from './voice-test-helpers';

test.describe('voice input', () => {
  test('a transcript arriving after a typed send settled inserts into the empty draft', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('Send this typed message'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue(''); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(page.locator('#transcript .user-message', { hasText: 'Send this typed message' })).toHaveCount(1);
    await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
  });

  test('a transcript arriving after a settled send reviews when the next draft has text', async ({ page }) => {
    await open(page, 'delayed'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.keyboard.type('Send this typed message'); await prompt(page).press('Enter');
    await expect(page.locator('#transcript .user-message', { hasText: 'Send this typed message' })).toHaveCount(1);
    await prompt(page).fill('Next message'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review'); await expect(prompt(page)).toHaveValue('Next message');
  });

  test('empty Enter during transcription shows a hint and unlock uses current agent guidance', async ({ page }) => {
    await mockVoiceSend(page, 'hold'); await open(page, 'delayed');
    await prompt(page).fill('Run'); await prompt(page).press('Enter'); await start(page);
    await page.evaluate(() => (window as any).__voiceFinishRun());
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await expect(prompt(page)).toHaveAttribute('aria-description', /Enter to send/);
    await prompt(page).press('Enter'); await expect(pill(page).locator('.voice-label')).toContainText(/still.*transcri|transcri.*still/i);
  });

  test('sending invalidates a stopped anchor even when the next draft repeats its prefix', async ({ page }) => {
    await mockVoiceSend(page, 'hold'); await open(page, 'delayed'); await prompt(page).fill('Call Bob');
    await start(page); await page.keyboard.press('Enter'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue(''); await prompt(page).fill('Call Bob about lunch'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect(prompt(page)).toHaveValue('Call Bob about lunch');
  });

  for (const [draft, remaining] of [
    ['Sent text', 'Sent text '], ['Sent text\n', 'Sent text\n'], ['Before Sent text', 'Before Sent text '],
    ['Before Sent text and Sent text', 'Before Sent text and Sent text '],
  ]) test(`successful local send leaves the next draft untouched: ${JSON.stringify(draft)}`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'read_file') {
          window.__voicePrepareWaiting = true; await new Promise(resolve => window.__voicePrepareRelease = resolve);
          return 'Attached file contents.';
        }
        if (command === 'send_message') { window.__voicePreparedSent = true; return; }
        switch (command) {
      `) });
    });
    await open(page, 'delayed');
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach package.json', exact: true }).click();
    await prompt(page).fill('Sent text'); await start(page); await page.keyboard.press('Enter');
    await prompt(page).press('Enter'); await page.waitForFunction(() => (window as any).__voicePrepareWaiting);
    await prompt(page).fill(draft); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(prompt(page)).toHaveValue(draft);
    await page.evaluate(() => (window as any).__voicePrepareRelease());
    await page.waitForFunction(() => (window as any).__voicePreparedSent);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    const expected = remaining + 'A dictated draft.';
    await expect(prompt(page)).toHaveValue(expected);
    expect(await prompt(page).evaluate(el => el.selectionStart)).toBe(expected.length);
  });

  for (const target of ['normal', 'cloud', 'remote']) for (const scenario of ['prepend', 'append', 'middle', 'speech', 'failure'])
    test(`settled ${target} send preserves ${scenario} edits and holds speech`, async ({ page }) => {
      test.slow();
      await page.route('**/src/preview.ts*', async route => {
        const response = await route.fetch(); let source = await response.text();
        const gate = `window.__r11Waiting = true; await new Promise(resolve => window.__r11Release = resolve); ${scenario === 'failure' ? "window.__r11Done = true; throw new Error('Committed send failed.');" : ''}`;
        source = source.replace(/switch\s*\(command\)\s*\{/, `
          if (command === 'read_file') { ${target === 'cloud' || scenario === 'failure' ? '' : gate} return 'File contents.'; }
          if (command === 'send_message') { ${target === 'normal' && scenario === 'failure' ? gate : ''} window.__r11Done = true; return; }
          switch (command) {
        `);
        if (target === 'cloud') source = source.replace(/if \(command === ['"]cloud_agent_start['"]\) \{/, `if (command === 'cloud_agent_start') { ${gate} window.__r11Done = true;`);
        if (target === 'remote') source = source.replace(/if \(command === ['"]remote_start_task['"]\) \{/, `
          if (command === 'remote_start_task') {
            ${scenario === 'failure' ? gate : ''}
            const task = session(args.sessionId); Object.assign(task, { draft: false, remoteDevice: { id: args.deviceId, name: 'Studio iMac' } });
            window.__r11Done = true; return { sessionId: task.id };
          }
          if (command === '__unused_remote_start_task') {
        `);
        await route.fulfill({ response, body: source });
      });
      await open(page, 'delayed'); await chooseSendTarget(page, target);
      if (target !== 'cloud') {
        await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
        await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: 'Project files', exact: true }).click();
        await page.getByRole('button', { name: 'Attach package.json', exact: true }).click();
      }
      await prompt(page).fill('Call Bob');
      if (scenario === 'speech') { await start(page); await page.keyboard.press('Enter'); }
      await prompt(page).press('Enter'); await page.waitForFunction(() => (window as any).__r11Waiting);
      await expect(prompt(page)).toHaveValue('');
      const edits: Record<string, string> = { prepend: 'Prepended new text', append: 'Call Bob newly typed', middle: 'Call Rob; example: Call Bob', speech: 'Newly typed text', failure: 'Newly typed text' };
      const edited = edits[scenario];
      await prompt(page).fill(edited);
      if (scenario === 'speech') {
        await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
        await expect(prompt(page)).toHaveValue(edited);
        await expect(pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true })).toHaveCount(0);
      }
      await page.evaluate(() => (window as any).__r11Release());
      await page.waitForFunction(() => (window as any).__r11Done);
      if (target !== 'normal' && scenario !== 'failure') await expect(page.locator('.composer-computer-fixed')).toHaveText(target === 'cloud' ? 'on E2B' : 'on Studio iMac');
      await expect(prompt(page)).toHaveValue(scenario === 'failure' ? `Call Bob\n${edited}` : edited);
      if (scenario === 'failure' && target !== 'cloud') await expect(page.locator('#attachments')).toContainText('package.json');
      if (scenario === 'speech') await expect(pill(page)).toHaveAttribute('data-phase', 'review');
      else expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
    });

  test('failed-send prepend during recording rebases the saved selected text', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'send_message') {
          window.__voiceRestoreWaiting = true; await new Promise(resolve => window.__voiceRestoreReject = resolve);
          throw new Error('Recording restore regression.');
        }
        switch (command) {
      `) });
    });
    await open(page, 'delayed'); await prompt(page).fill('Original'); await prompt(page).press('Enter');
    await page.waitForFunction(() => (window as any).__voiceRestoreWaiting);
    await prompt(page).fill('head selected tail'); await prompt(page).evaluate(el => el.setSelectionRange(5, 13)); await start(page);
    await page.evaluate(() => (window as any).__voiceRestoreReject());
    await expect(prompt(page)).toHaveValue('Original\nhead selected tail');
    await page.keyboard.press('Enter'); await release(page);
    await expect(prompt(page)).toHaveValue('Original\nhead A dictated draft. tail');
  });

  test('committed attachment read rejection restores the original before newer text', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'read_file') {
          window.__voiceReadWaiting = true; await new Promise(resolve => window.__voiceReadReject = resolve);
          throw new Error('Attachment read failed.');
        }
        switch (command) {
      `) });
    });
    await open(page, 'delayed');
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach package.json', exact: true }).click();
    await prompt(page).fill('Original message'); await prompt(page).press('Enter');
    await page.waitForFunction(() => (window as any).__voiceReadWaiting);
    await prompt(page).fill('Original message plus newer text'); await page.evaluate(() => (window as any).__voiceReadReject());
    await expect(page.locator('#toast')).toContainText('Attachment read failed.');
    await expect(prompt(page)).toHaveValue('Original message\nOriginal message plus newer text');
  });

  for (const path of ['normal', 'btw', 'equal']) test(`rejected ${path} send keeps original draft before inserted speech`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = /switch\s*\(command\)\s*\{/;
      await route.fulfill({ response, body: source.replace(marker, `
        if (command === 'send_message') {
          window.__voiceRejectedSendReady = true;
          await new Promise(resolve => window.__voiceRejectSend = resolve);
          throw new Error('Rejected send regression.');
        }
        switch (command) {
      `) });
    });
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    const draft = path === 'btw' ? '/btw Rejected side question.' : path === 'equal' ? 'A dictated draft.' : 'Rejected original.';
    await prompt(page).fill(draft); await prompt(page).press('Enter');
    await page.waitForFunction(() => (window as any).__voiceRejectedSendReady);
    await expect(prompt(page)).toHaveValue('');
    const newer = path === 'equal' ? draft : 'Newer text';
    await prompt(page).fill(newer); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await prompt(page).evaluate(el => el.setSelectionRange(3, 3));
    await page.evaluate(() => (window as any).__voiceRejectSend());
    const expected = path === 'equal' ? draft : `${draft}\n${newer}`;
    await expect(prompt(page)).toHaveValue(expected);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await expect.poll(() => prompt(page).evaluate(el => el.selectionStart)).toBe(path === 'equal' ? 3 : draft.length + 4);
  });

  for (const cloud of [false, true]) test(`late transcript survives the real ${cloud ? 'cloud' : 'normal'} send completion`, async ({ page }) => {
    test.slow();
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const command = cloud ? 'cloud_agent_start' : 'send_message';
      const marker = cloud ? /if \(command === ['"]cloud_agent_start['"]\) \{/ : /switch\s*\(command\)\s*\{/;
      expect(source).toMatch(marker);
      const wait = `window.__voiceSendEntered = true; await new Promise(resolve => window.__voiceSendRelease = resolve);`;
      const replacement = cloud ? `if (command === 'cloud_agent_start') { ${wait}`
        : `if (command === '${command}') { ${wait} } switch (command) {`;
      await route.fulfill({ response, body: source.replace(marker, replacement) });
    });
    await open(page, 'delayed');
    if (cloud) {
      await page.locator('.new-task-button').click(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('region', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Connections', exact: true }).click();
      await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
      const fold = settings.locator('details.cloud-more'); if (!await fold.evaluate(el => (el as HTMLDetailsElement).open)) await fold.locator('summary').click();
      await settings.getByRole('button', { name: 'Connect E2B', exact: true }).click();
      await settings.getByLabel('E2B API key').fill('preview');
      await settings.getByRole('form', { name: 'Connect E2B' }).locator('[type="submit"]').click();
      await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      await page.locator('#composer-computer').click(); await page.getByRole('menuitemradio', { name: 'Cloud · E2B' }).click();
    }
    await prompt(page).fill('Sent text'); await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => (window as any).__voiceSendEntered);
    await release(page); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(prompt(page)).toHaveValue('');
    await page.evaluate(() => (window as any).__voiceSendRelease());
    if (cloud) await expect(page.locator('.composer-computer-fixed')).toHaveText('on E2B');
    else await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    await pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true }).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  for (const target of ['cloud', 'remote']) test(`dictation started while a slow ${target} send is pending inserts automatically`, async ({ page }) => {
    test.slow();
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(); let source = await response.text();
      const gate = 'window.__r13Waiting = true; await new Promise(resolve => window.__r13Release = resolve); window.__r13Done = true;';
      source = target === 'cloud'
        ? source.replace(/if \(command === ['"]cloud_agent_start['"]\) \{/, `if (command === 'cloud_agent_start') { ${gate}`)
        : source.replace(/if \(command === ['"]remote_start_task['"]\) \{/, `if (command === 'remote_start_task') { ${gate}`);
      await route.fulfill({ response, body: source });
    });
    await open(page); await chooseSendTarget(page, target);
    await prompt(page).fill('Ship the fix'); await prompt(page).press('Enter');
    await page.waitForFunction(() => (window as any).__r13Waiting);
    await expect(prompt(page)).toHaveValue('');
    await prompt(page).fill('Next:'); await start(page); await page.keyboard.press('Enter');
    await expect(prompt(page)).toHaveValue('Next: A dictated draft.');
    await expect(pill(page)).toBeHidden();
    expect(await page.evaluate(() => Boolean((window as any).__r13Done))).toBe(false);
    await page.evaluate(() => (window as any).__r13Release());
    await page.waitForFunction(() => (window as any).__r13Done);
  });

  test('a slash instruction that resolves during recording keeps the draft and asks to stop dictation', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'set_task_preference') { window.__r13PlanWaiting = true; await new Promise(resolve => window.__r13PlanRelease = resolve); }
        if (command === 'send_message') window.__r13Sent = true;
        switch (command) {
      `) });
    });
    await open(page, 'delayed'); await page.locator('.task-item[data-id="session-2"]').click();
    await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
    await prompt(page).fill('/plan Ship the search fix'); await prompt(page).press('Enter');
    await page.waitForFunction(() => (window as any).__r13PlanWaiting);
    await expect(prompt(page)).toHaveValue('');
    await prompt(page).fill('Keep this draft'); await start(page);
    await page.evaluate(() => (window as any).__r13PlanRelease());
    await expect(pill(page).locator('.voice-label')).toHaveText('Stop dictation to send');
    await expect(prompt(page)).toHaveValue('Keep this draft');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    expect(await page.evaluate(() => Boolean((window as any).__r13Sent))).toBe(false);
  });

  for (const order of [[0, 1], [1, 0]]) test(`two rejected queued messages restore in written order when message ${order[0] + 1} fails first`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'send_message') { session(args.sessionId).status = 'running'; return; }
        if (command === 'queue_add') { await new Promise(resolve => (window.__r13Queued ??= []).push(resolve)); throw new Error('Queue rejected.'); }
        switch (command) {
      `) });
    });
    await open(page, 'delayed'); await prompt(page).fill('Run'); await prompt(page).press('Enter');
    await expect(page.locator('#composer.composer-running')).toBeVisible();
    for (const [index, text] of ['First queued', 'Second queued'].entries()) {
      await prompt(page).fill(text); await prompt(page).press('Enter');
      await page.waitForFunction(count => ((window as any).__r13Queued ?? []).length === count, index + 1);
      await expect(prompt(page)).toHaveValue('');
    }
    for (const index of order) await page.evaluate(at => (window as any).__r13Queued[at](), index);
    await expect(prompt(page)).toHaveValue('First queued\nSecond queued');
  });

  test('the empty-send hint clears as soon as a typed send commits', async ({ page }) => {
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await prompt(page).press('Enter');
    const label = pill(page).locator('.voice-label');
    await expect(label).toHaveText('Transcription is still running. Type a message to send.');
    await prompt(page).fill('Send this typed message'); await prompt(page).press('Enter');
    await expect(prompt(page)).toHaveValue('');
    expect(await label.textContent()).not.toContain('still running');
    // The send settles before the transcript arrives, so it goes straight into the empty composer.
    await expect(page.locator('#transcript .user-message', { hasText: 'Send this typed message' })).toHaveCount(1);
    await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('two rejected queued messages with the same text each come back', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        if (command === 'send_message') { session(args.sessionId).status = 'running'; return; }
        if (command === 'queue_add') { await new Promise(resolve => (window.__r14Queued ??= []).push(resolve)); throw new Error('Queue rejected.'); }
        switch (command) {
      `) });
    });
    await open(page, 'delayed'); await prompt(page).fill('Run'); await prompt(page).press('Enter');
    await expect(page.locator('#composer.composer-running')).toBeVisible();
    for (const count of [1, 2]) {
      await prompt(page).fill('Same follow-up'); await prompt(page).press('Enter');
      await page.waitForFunction(n => ((window as any).__r14Queued ?? []).length === n, count);
    }
    for (const index of [0, 1]) await page.evaluate(at => (window as any).__r14Queued[at](), index);
    await expect(prompt(page)).toHaveValue('Same follow-up\nSame follow-up');
  });
});
