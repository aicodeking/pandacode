import './styles.css';
import './design-system.css';
import './web-ui.css';
import { storeAppearance, applyHostClockMetadata, applyWallpaperAccentSeed } from './web-preferences';
import { webJson } from './web-http';

/** Authenticate before importing the workspace or theme modules. */
export async function bootstrapWeb(): Promise<void> {
  document.documentElement.dataset.pandacodeWeb = 'true';
  const preferences = async () => {
    const { response, value } = await webJson('/api/pandacode/preferences', { cache: 'no-store' });
    if (!response.ok) return false;
    const snapshot = value as { preferences: unknown; platform: string; version: string };
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid appearance response');
    storeAppearance(snapshot.preferences); applyHostClockMetadata(snapshot); applyWallpaperAccentSeed(snapshot);
    if (['macos', 'linux', 'windows'].includes(snapshot.platform)) document.documentElement.dataset.pandacodeHostPlatform = snapshot.platform;
    if (typeof snapshot.version === 'string') document.documentElement.dataset.pandacodeVersion = snapshot.version;
    return true;
  };
  try { if (await preferences()) { await runtimeReady(); return; } } catch { /* Pairing screen also offers recovery while the host is offline. */ }
  const { value } = await webJson('/api/pandacode/login-mode', { cache: 'no-store' }).catch(() => ({ value: null }));
  const mode = (value as { mode?: string } | null)?.mode;
  const password = mode === 'password';
  const root = document.createElement('main');
  root.className = 'web-pairing';
  root.innerHTML = '<h1>PandaCode</h1><p>Enter the one-time pairing code from the PandaCode desktop app.</p><form><label>Pairing code <input name="token" type="password" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="256"></label><button type="submit">Connect</button><p role="status" aria-live="polite"></p></form><p>This is a fork of <a href="https://github.com/aicodeking/pandacode">PandaCode</a>.</p>';
  if (password) {
    root.querySelector('p')!.textContent = 'Enter the password for this PandaCode instance.';
    const field = root.querySelector('input')!;
    field.autocomplete = 'current-password';
    field.parentElement!.firstChild!.textContent = 'Instance password ';
    root.querySelector('button')!.textContent = 'Sign in';
  }
  if (!mode) {
    const field = root.querySelector('input')!;
    field.autocomplete = 'off';
    field.parentElement!.firstChild!.textContent = 'Pairing code or instance password ';
  }
  (document.querySelector('#app') ?? document.body).append(root);
  await new Promise<void>(resolve => {
    const form = root.querySelector('form')!;
    const input = root.querySelector('input')!;
    const button = root.querySelector('button')!;
    const status = root.querySelector('[role="status"]')!;
    form.addEventListener('submit', async event => {
      event.preventDefault(); button.disabled = true; status.textContent = 'Connecting…';
      const token = input.value.trim(); input.value = '';
      try {
        const { response } = await webJson('/api/pandacode/session', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
        if (!response.ok || !(await preferences())) throw new Error('Pairing failed');
        root.remove(); resolve();
      } catch { status.textContent = password ? 'Could not sign in. Check the instance password and try again.' : 'Could not connect. Check the code and that the desktop app is open, then try again.'; }
      finally { button.disabled = false; }
    });
  });
  await runtimeReady();
}

async function runtimeReady(): Promise<void> {
  const { web } = await import('./web-transport');
  if (!web) throw new Error('Browser runtime transport is unavailable');
  try { await web.recover(); return; } catch { /* Keep the page usable while the host recovers. */ }
  const root = document.createElement('main'); root.className = 'web-pairing';
  root.innerHTML = '<h1>PandaCode</h1><p role="status">The host workspace could not be recovered. Check that the native app is open, then retry.</p><button type="button">Retry connection</button>';
  (document.querySelector('#app') ?? document.body).append(root);
  await new Promise<void>(resolve => {
    const button = root.querySelector('button')!;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await web.recover(); root.remove(); resolve(); }
      catch { root.querySelector('p')!.textContent = 'The host is still unavailable. If your browser session expired, reload this page to pair again.'; }
      finally { button.disabled = false; }
    });
  });
}
