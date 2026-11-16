import { appendFile } from 'node:fs/promises';
import { visit } from '../core/fake-browser.mjs';
import { loopback, main } from '../common.mjs';

export async function runBrowser(url, env = process.env, signal) {
  return visit(url, {
    mode: env.FAKE_BROWSER ?? 'follow', check: loopback,
    async record(value) {
      if (!env.FAKE_BROWSER_LOG) throw new Error('FAKE_BROWSER_LOG is required in record mode');
      await appendFile(env.FAKE_BROWSER_LOG, `${value}\n`);
    },
    async request(value) {
      const response = await fetch(value, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(10000), ...signal ? [signal] : []]) });
      const result = { status: response.status, location: response.headers.get('location') };
      await response.body?.cancel(); return result;
    },
  });
}
if (main(import.meta.url)) {
  const controller = new AbortController();
  process.stdin.resume(); process.stdin.once('end', () => controller.abort());
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node fake-browser.mjs <url>');
    await runBrowser(process.argv[2], process.env, controller.signal);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.stdin.destroy(); }
}
