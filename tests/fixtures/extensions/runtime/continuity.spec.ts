import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL(`../../../../src-tauri/src/extensions/qualification/target/debug/pandacode-runtime-qualification${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

for (const fault of ['continuity', 'termination']) {
  test(`runtime qualification: core typing and recorded streaming survive ${fault}`, async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem('pandacode.wallpapers', 'false');
      (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    });
    await page.goto('/?extensions-baseline');
    const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
    await expect(prompt).toBeEnabled();
    await prompt.fill('Recorded qualification run'); await prompt.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    const node = await prompt.elementHandle();
    const child = spawn(binary, [fault === 'termination' ? 'loop' : 'continuity'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    // Attach error handlers before awaiting startup, so a missing binary fails, never skips.
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('"ready":"loop"')) ready(); });
    const guard = setTimeout(() => child.kill(), 10_000);
    try {
      await Promise.race([started, closed.then(() => { throw new Error(`Runtime exited before ready: ${errors}`); })]);
      expect(child.exitCode).toBeNull();
      const tokens = ['qualified-stream-one ', 'qualified-stream-two ', 'qualified-stream-three '];
      const begin = Date.now();
      for (let index = 0; index < tokens.length; index++) {
        await page.evaluate(text => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text }), tokens[index]);
        await prompt.pressSequentially(`draft-${index} `);
      }
      const typingMs = Date.now() - begin;
      // Establish overlap, not just usability after the failing process already exited.
      expect(child.exitCode).toBeNull();
      await expect(page.locator('#stream-region .live-text')).toHaveText(tokens.join('').trim());
      await expect(prompt).toHaveValue('draft-0 draft-1 draft-2 ');
      if (fault === 'termination') expect(child.kill()).toBe(true);
      const [code] = await closed;
      if (fault === 'continuity') {
        expect(code, errors).toBe(0);
        const reports = output.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(value => value.status);
        expect(reports.map(value => [value.case, value.status])).toEqual([
          ['loop', 'Timeout'], ['allocation', 'EngineError'], ['exception', 'EngineError'],
        ]);
      } else expect(code).not.toBe(0);
      await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'after-failure' }));
      await expect(page.locator('#stream-region .live-text')).toHaveText(tokens.join('') + 'after-failure');
      await prompt.pressSequentially('after-failure');
      await expect(prompt).toHaveValue('draft-0 draft-1 draft-2 after-failure');
      expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
      await expect(prompt).toHaveAttribute('data-session-id', 'session-1');
      const mutations = await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['send_message', 'stop_session'].includes(call.command)));
      expect(mutations.map((call: any) => call.command)).toEqual(['send_message']);
      const evidence = info.outputPath('native-runtime-continuity.json');
      await writeFile(evidence, JSON.stringify({ fault, typingMs, output, errors, nativeDesktop: false,
        platform: process.platform, architecture: process.arch, browser: info.project.name,
        browserVersion: page.context().browser()?.version(), revision: process.env.BASELINE_REVISION ?? null }, null, 2));
      await info.attach('native-runtime-continuity', { path: evidence, contentType: 'application/json' });
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed.catch(() => {});
    }
  });
}
