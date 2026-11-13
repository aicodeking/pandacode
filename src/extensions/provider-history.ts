import { providerOwner, PROVIDER_RECOVERY } from './provider-identity';
import './provider-history.css';

/** A host-owned notice, never a replacement transcript. Recovery keeps the model picker
 * and Settings reachable without importing or activating missing package code. */
export function renderProviderRecovery(host: HTMLElement, provider: string | undefined, recover: { install(): void; change(): void }): void {
  let notice = host.querySelector<HTMLElement>(':scope > [data-provider-recovery]');
  const owner = provider && providerOwner(provider);
  if (!owner) { if (notice) notice.hidden = true; return; }
  if (!notice) {
    notice = document.createElement('div'); notice.dataset.providerRecovery = ''; notice.className = 'provider-recovery'; notice.setAttribute('role', 'status');
    const message = document.createElement('p'); message.textContent = PROVIDER_RECOVERY;
    const install = document.createElement('button'); install.type = 'button'; install.className = 'ds-btn'; install.textContent = 'Reinstall or enable extension'; install.onclick = () => recover.install();
    const change = document.createElement('button'); change.type = 'button'; change.className = 'ds-btn'; change.textContent = 'Change provider'; change.onclick = () => recover.change();
    notice.append(message, install, change); host.prepend(notice);
  }
  notice.hidden = false; notice.dataset.providerRecovery = provider;
}
