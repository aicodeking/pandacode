import { call } from './bridge';
import { escape } from './dom';
interface TestResult { ok: boolean; installed: boolean; version: string | null; path: string | null; message: string; durationMs: number; }
/** The Settings quick test for one agent: run its CLI's `--version` (metadata only, no prompt). */
export function mountProviderTest(host: HTMLElement, id: string, name: string): () => void {
  let disposed = false, pending = false;
  host.innerHTML = `<button type="button" class="secondary-button" aria-label="Test ${escape(name)}">Test</button><span role="status"></span><p hidden></p>`;
  const button = host.querySelector<HTMLButtonElement>('button')!;
  const status = host.querySelector<HTMLElement>('[role="status"]')!;
  const detail = host.querySelector<HTMLParagraphElement>('p')!;
  const run = async () => {
    if (pending || disposed) return;
    pending = true; button.disabled = true; button.textContent = 'Testing…';
    status.textContent = 'Checking…'; status.classList.remove('provider-test-failed'); detail.hidden = true;
    try {
      const result = await call<TestResult>('provider_test', { provider: id });
      if (disposed) return;
      const seconds = (result.durationMs / 1000).toFixed(1);
      status.textContent = `${result.ok ? 'Working' : 'Failed'} · ${seconds} s`;
      status.classList.toggle('provider-test-failed', !result.ok);
      detail.textContent = result.message; detail.hidden = false;
    } catch (error) {
      if (disposed) return;
      status.textContent = 'Could not run the test';
      detail.textContent = error instanceof Error ? error.message : String(error); detail.hidden = false;
    } finally { pending = false; if (!disposed) { button.disabled = false; button.textContent = 'Test again'; } }
  };
  button.addEventListener('click', run);
  return () => { disposed = true; button.removeEventListener('click', run); };
}
