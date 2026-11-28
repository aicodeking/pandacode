import { t } from './i18n.ts';
import { call } from './bridge';
import { errorText } from './error-text';
interface Readiness { installed: boolean; acpReady: boolean; sessionReady: boolean; state: string; message: string; }
/** Explicit, metadata-only connection check. Installation alone cannot establish sign-in. */
export function mountProviderReadiness(host: HTMLElement): () => void {
  let disposed = false, pending = false;
  host.classList.add('provider-readiness');
  host.innerHTML = `<div><span role="status">${t('Connection not checked')}</span><button type="button" class="secondary-button">${t('Check connection')}</button></div><p hidden></p>`;
  const status = host.querySelector<HTMLElement>('[role="status"]')!;
  const button = host.querySelector<HTMLButtonElement>('button')!;
  const detail = host.querySelector<HTMLParagraphElement>('p')!;
  const check = async () => {
    if (pending || disposed) return;
    pending = true; button.disabled = true; button.textContent = t('Checking…');
    status.textContent = t('Starting ACP…'); detail.hidden = true;
    try {
      const result = await call<Readiness>('provider_check_connection', {provider:'antigravity'});
      if (disposed) return;
      status.textContent = result.sessionReady ? t('Connection ready') : result.state === 'authenticationRequired' ? t('Sign-in required') : !result.installed ? t('ACP executable missing') : result.acpReady ? t('Session unavailable') : t('ACP startup failed');
      detail.textContent = result.message; detail.hidden = false;
    } catch (error) { if (!disposed) { status.textContent = 'Could not check connection'; detail.textContent = errorText(error); detail.hidden = false; } }
    finally { pending = false; if (!disposed) { button.disabled = false; button.textContent = 'Check again'; } }
  };
  button.addEventListener('click', check);
  return () => { disposed = true; button.removeEventListener('click', check); };
}
