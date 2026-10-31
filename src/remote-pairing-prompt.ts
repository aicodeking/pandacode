/* Scoped pairing (src-tauri/src/remote/grants.rs): the prompt shown when a device asks for
 * access to this computer for the first time, with the shared grant types. Mounted once by
 * main.ts; Settings → Remote access lists the same devices. */
import './remote-pairing-prompt.css';
import { escape } from './dom';
import type { RemoteHost } from './remote-types';

export type GrantScope = 'pending' | 'view' | 'control' | 'full' | 'blocked';
export interface DeviceGrant { deviceId: string; name: string; platform: string; fingerprint: string; scope: GrantScope; online: boolean; requested: boolean }
export interface PairCode { code: string; scope: GrantScope; expiresAt: number }
export interface DevicePending { deviceId: string; name: string; fingerprint: string }

export const APPROVE_SCOPES: { id: GrantScope; label: string }[] = [
  { id: 'view', label: 'View only' },
  { id: 'control', label: 'Control' },
  { id: 'full', label: 'Full access' },
];
export const SCOPE_LABELS: Record<GrantScope, string> = { pending: 'Waiting for approval', view: 'View only', control: 'Control', full: 'Full access', blocked: 'Blocked' };
export const SCOPE_HELP = 'View only: see tasks, changes and diffs. Control: also send prompts, stop tasks and answer approvals. Full access: also start tasks, merge pull requests and message bots. Blocked: refused.';

/** The first 16 hex digits of a key fingerprint in groups of four, to compare by eye on both computers. */
export function groupFingerprint(fingerprint: string): string {
  return (fingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ');
}

const options = (selected: GrantScope) => APPROVE_SCOPES.map(scope => `<option value="${scope.id}"${scope.id === selected ? ' selected' : ''}>${scope.label}</option>`).join('');

export function mountPairingPrompt(host: RemoteHost): () => void {
  const stack = document.createElement('div');
  stack.className = 'pairing-prompts';
  stack.setAttribute('aria-label', 'Devices asking for access');
  document.body.append(stack);
  const card = (deviceId: string) => [...stack.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.device === deviceId);
  const show = (pending: DevicePending) => {
    card(pending.deviceId)?.remove();
    const element = document.createElement('section');
    element.className = 'pairing-prompt';
    element.dataset.device = pending.deviceId;
    element.setAttribute('role', 'alert');
    element.innerHTML = `<div class="pairing-prompt-text"><strong>${escape(pending.name || 'A device')} wants access to this computer</strong><small>Its key is <code>${escape(groupFingerprint(pending.fingerprint))}</code>. Approve only if it matches the key shown on that device.</small></div>
      <div class="pairing-prompt-actions"><select aria-label="Access for ${escape(pending.name)}">${options('control')}</select><button type="button" class="primary-button" data-approve>Approve</button><button type="button" class="secondary-button" data-block>Block</button><button type="button" class="secondary-button" data-later aria-label="Decide later">Later</button></div>`;
    stack.append(element);
  };
  stack.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    const element = target?.closest<HTMLElement>('.pairing-prompt');
    const deviceId = element?.dataset.device;
    if (!target || !element || !deviceId) return;
    if (target.hasAttribute('data-later')) { element.remove(); return; }
    const scope = target.hasAttribute('data-block') ? 'blocked' : element.querySelector('select')!.value;
    target.disabled = true;
    void host.call('remote_set_device_grant', { deviceId, scope }).then(() => element.remove(), error => { target.disabled = false; host.notify(error instanceof Error ? error.message : String(error)); });
  });
  const unlisten: Promise<() => void>[] = [
    host.listen('remote://device-pending', (pending: DevicePending) => { if (pending?.deviceId) show(pending); }),
    host.listen('remote://device-grants', (grants: DeviceGrant[]) => {
      if (Array.isArray(grants)) for (const element of [...stack.children]) if (grants.some(grant => grant.deviceId === (element as HTMLElement).dataset.device && grant.scope !== 'pending')) element.remove();
    }),
  ];
  return () => { for (const u of unlisten) void u.then(fn => fn(), () => undefined); stack.remove(); };
}
