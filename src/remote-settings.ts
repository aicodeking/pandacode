/* Settings → Remote access: sign in with GitHub, allow this computer to be driven, and
 * manage the account's devices. Nothing reaches the network until the user signs in. */
import './remote-settings.css';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import type { RemoteDevice, RemoteHost, RemoteSignIn, RemoteStatus } from './remote-types';

const FULL_TIP = 'When off, your other computers cannot start or switch a task here to Full access (no approvals); a remote task without a mode starts in Ask.';
const ALLOW_TIP = 'Remote prompts follow this computer’s approval settings; they get no more power than prompts typed here.';

export function mountRemoteSettings(root: HTMLElement, host: RemoteHost): () => void {
  let status: RemoteStatus | undefined, devices: RemoteDevice[] = [], error = '', code: RemoteSignIn | undefined, expires = 0, signingIn = false, disposed = false, attempt = 0;
  const fail = (e: unknown) => { error = e instanceof Error ? e.message : String(e); render(); };

  function deviceRow(device: RemoteDevice): string {
    return `<div class="setting-row remote-device" data-device="${escape(device.id)}"><div><strong><span class="remote-dot" data-online="${device.online}" role="img" aria-label="${device.online ? 'Online' : 'Offline'}"></span>${escape(device.name)}${device.current ? ' <span class="remote-badge">This computer</span>' : ''}</strong><small>${escape(device.platform)} · ${device.host ? 'remote control on' : 'remote control off'} · key <code>${escape(device.fingerprint)}</code></small></div>${device.current ? '' : `<button type="button" class="secondary-button" data-revoke="${escape(device.id)}" aria-label="Revoke ${escape(device.name)}">Revoke</button>`}</div>`;
  }
  function body(): string {
    if (!status) return '<p class="dialog-loading" role="status">Loading…</p>';
    if (!status.configured) return '<p class="remote-note" role="status">Remote access is not configured in this build.</p>';
    if (!status.signedIn) {
      const flow = code ? `<div class="remote-code"><p>Enter this code at <strong>${escape(code.verificationUri)}</strong>:</p><div class="remote-code-row"><output class="remote-user-code" aria-label="Device code">${escape(code.userCode)}</output><button type="button" class="secondary-button" data-copy>${icon('copy')}Copy code</button></div><p class="remote-note" role="status">Waiting for you to approve in the browser… The code expires at ${new Date(expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p><button type="button" class="secondary-button" data-cancel>Cancel</button></div>` : '';
      return `<div class="setting-row"><div><strong>PandaCode Connect</strong><small>Sign in with GitHub to reach your other computers. Task content is end-to-end encrypted; the relay sees only ciphertext.</small></div><button type="button" class="secondary-button" data-sign-in ${signingIn ? 'disabled' : ''}>${icon('github')}Sign in with GitHub</button></div>${flow}`;
    }
    return `<div class="setting-row"><div><strong>${escape(status.account?.login ?? 'Signed in')}</strong><small>Signed in with GitHub · ${status.connected ? 'connected' : 'connecting…'}</small></div><button type="button" class="secondary-button" data-sign-out>Sign out</button></div>
      <div class="setting-row"><div><strong>Allow remote control of this computer ${infoMark(ALLOW_TIP, 'About remote control')}</strong><small>Your other signed-in computers can see and drive tasks here.</small></div><input type="checkbox" class="settings-switch" id="remote-host" aria-label="Allow remote control of this computer" ${status.hostEnabled ? 'checked' : ''}></div>
      <div class="setting-row"><div><strong>Full access for remote tasks ${infoMark(FULL_TIP, 'About full access for remote tasks')}</strong><small>Off: remote tasks always ask before acting.</small></div><input type="checkbox" class="settings-switch" id="remote-full-access" aria-label="Full access for remote tasks" ${status.remoteFullAccess ? 'checked' : ''}></div>
      <h3 class="settings-heading">Devices</h3><div class="settings-group remote-devices">${devices.length ? devices.map(deviceRow).join('') : '<p class="remote-note">No devices yet.</p>'}</div>`;
  }
  function render(): void {
    if (disposed) return;
    root.innerHTML = `<div class="settings-group remote-settings">${body()}</div>${error ? `<p class="remote-error" role="alert">${escape(error)}</p>` : ''}`;
  }
  const apply = (next: RemoteStatus) => { status = next; if (next.signedIn) { code = undefined; signingIn = false; } };
  async function load(): Promise<void> {
    try {
      apply(await host.call<RemoteStatus>('remote_status'));
      devices = status!.signedIn ? await host.call<RemoteDevice[]>('remote_devices') : [];
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    render();
  }
  async function signIn(): Promise<void> {
    if (signingIn) return;
    error = ''; signingIn = true;
    const mine = ++attempt;
    try {
      code = await host.call<RemoteSignIn>('remote_sign_in_start'); expires = Date.now() + code.expiresIn * 1000; render();
      void host.openUrl(code.verificationUri).catch(() => undefined);
      apply(await host.call<RemoteStatus>('remote_sign_in_finish'));
      devices = await host.call<RemoteDevice[]>('remote_devices');
    } catch (e) {
      if (mine !== attempt) return;
      code = undefined; signingIn = false; error = e instanceof Error ? e.message : String(e);
    }
    render();
  }
  function cancelSignIn(): void {
    attempt++; code = undefined; signingIn = false; error = ''; render();
    void host.call('remote_sign_in_cancel').catch(fail);
  }
  root.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    if (target.hasAttribute('data-sign-in')) void signIn();
    else if (target.hasAttribute('data-cancel')) cancelSignIn();
    else if (target.hasAttribute('data-copy') && code) void navigator.clipboard.writeText(code.userCode).then(() => host.notify('Code copied'), () => host.notify('Couldn’t copy; select the code instead'));
    else if (target.hasAttribute('data-sign-out')) void host.call<RemoteStatus>('remote_sign_out').then(next => { apply(next); devices = []; error = ''; render(); }, fail);
    else if (target.dataset.revoke) void host.call('remote_revoke_device', { deviceId: target.dataset.revoke }).then(() => { devices = devices.filter(d => d.id !== target.dataset.revoke); render(); }, fail);
  });
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const args = input.id === 'remote-host' ? { enabled: input.checked } : input.id === 'remote-full-access' ? { fullAccess: input.checked } : undefined;
    if (args) void host.call<RemoteStatus>('remote_set_host_enabled', args).then(next => { apply(next); render(); }, e => { input.checked = !input.checked; fail(e); });
  });
  const unlisten: Promise<() => void>[] = [
    host.listen('remote://status', next => { if (!signingIn || next.signedIn) { apply(next); render(); } }),
    host.listen('remote://presence', next => { if (Array.isArray(next)) { devices = next; render(); } }),
  ];
  void load();
  return () => { disposed = true; for (const u of unlisten) void u.then(fn => fn(), () => undefined); };
}
