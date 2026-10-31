/* Settings → Remote access: sign in with GitHub, allow this computer to be driven, and
 * manage the account's devices and what each may do (scoped pairing, remote/grants.rs).
 * Nothing reaches the network until the user signs in. */
import './remote-settings.css';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import { mountOrchestrationSettings } from './machine-orchestration';
import { t } from './i18n.ts';
import { APPROVE_SCOPES, SCOPE_HELP, SCOPE_LABELS, groupFingerprint, type DeviceGrant, type GrantScope, type PairCode } from './remote-pairing-prompt';
import type { RemoteDevice, RemoteHost, RemoteSignIn, RemoteStatus } from './remote-types';

const FULL_TIP = t('When off, your other computers cannot start or switch a task here to Full access (no approvals); a remote task without a mode starts in Ask.');
const ALLOW_TIP = t('Remote prompts follow this computer’s approval settings; they get no more power than prompts typed here.');
const NOTIFY_TIP = t('The relay sends the phone a push that says only how many tasks need attention; approving still happens in the app over the end-to-end encrypted channel.');
const KEY_TIP = t('Another computer shows this key when it asks you to approve this one. Approve only if the keys match.');
const CODE_TIP = t('A one-time code skips the approval prompt for one new device. It works once, for 10 minutes, and gives the access you pick. Enter it on the other computer under Pair with a code.');
const PAIR_TIP = t('Enter the 6-digit code that the other computer shows under Pairing code. It gives this computer the access that computer chose.');

const scopeOptions = (selected: GrantScope, waiting: string) => [...(selected === 'pending' ? [{ id: 'pending', label: waiting }] : []), ...APPROVE_SCOPES, { id: 'blocked', label: t('Blocked') }]
  .map(scope => `<option value="${scope.id}"${scope.id === selected ? ' selected' : ''}>${scope.label}</option>`).join('');
const pickOptions = (selected: string) => APPROVE_SCOPES.map(scope => `<option value="${scope.id}"${scope.id === selected ? ' selected' : ''}>${scope.label}</option>`).join('');
const groupCode = (code: string) => code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

export function mountRemoteSettings(root: HTMLElement, host: RemoteHost): () => void {
  let status: RemoteStatus | undefined, devices: RemoteDevice[] = [], grants: DeviceGrant[] = [], error = '', statusError = '', devicesError = '', grantsError = '', devicesLoaded = false, loading = true, code: RemoteSignIn | undefined, expires = 0, signingIn = false, disposed = false, attempt = 0;
  let pairCode: PairCode | undefined, codeScope: GrantScope = 'control', pairTarget = '', pairInput = '', pairing = false, expiry: number | undefined;
  const picks: Record<string, string> = {};
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  const fail = (e: unknown) => { error = message(e); render(); };
  const failure = (title: string, detail: string) => `<div class="remote-load-error" role="alert">${icon('alert')}<span><strong>${escape(title)}</strong><small>${escape(detail)}</small></span><button type="button" class="secondary-button" data-retry>Retry</button></div>`;
  const grantOf = (id: string) => grants.find(grant => grant.deviceId === id);

  function deviceRow(device: RemoteDevice): string {
    const grant = device.current ? undefined : grantOf(device.id);
    const waiting = grant?.scope === 'pending' && grant.requested;
    const revoke = device.current ? '' : `<button type="button" class="secondary-button" data-revoke="${escape(device.id)}" aria-label="${t`Revoke ${escape(device.name)}`}">${t('Revoke')}</button>`;
    const access = !grant ? '' : waiting
      ? `<select data-pick="${escape(device.id)}" aria-label="${t`Approve ${escape(device.name)} as`}">${pickOptions(picks[device.id] ?? 'control')}</select><button type="button" class="primary-button" data-approve="${escape(device.id)}" aria-label="${t`Approve ${escape(device.name)}`}">${t('Approve')}</button><button type="button" class="secondary-button" data-block="${escape(device.id)}" aria-label="${t`Block ${escape(device.name)}`}">${t('Block')}</button>`
      : `<select data-grant="${escape(device.id)}" aria-label="${t`Access for ${escape(device.name)}`}">${scopeOptions(grant.scope, t('Not approved'))}</select>`;
    const detail = waiting ? `${escape(device.platform)} · ${t('asks for access')} · ${t('key')} <code>${escape(groupFingerprint(device.fingerprint))}</code>` : `${escape(device.platform)} · ${device.host ? t('remote control on') : t('remote control off')} · ${t('key')} <code>${escape(device.fingerprint)}</code>`;
    return `<div class="setting-row remote-device${waiting ? ' remote-pending' : ''}" data-device="${escape(device.id)}"><div><strong><span class="remote-dot" data-online="${device.online}" role="img" aria-label="${device.online ? t('Online') : t('Offline')}"></span>${escape(device.name)}${device.current ? ` <span class="remote-badge">${t('This computer')}</span>` : ''}</strong><small>${detail}</small></div><span class="remote-device-actions">${access}${revoke}</span></div>`;
  }
  function deviceList(): string {
    if (devicesError) return failure(t('Couldn’t load devices.'), devicesError);
    if (!devicesLoaded) return `<p class="dialog-loading" role="status">${t('Loading devices…')}</p>`;
    if (!devices.length) return `<p class="remote-note">${t('No devices yet.')}</p>`;
    const waiting = (device: RemoteDevice) => { const grant = grantOf(device.id); return !device.current && grant?.scope === 'pending' && grant.requested; };
    return [...devices.filter(waiting), ...devices.filter(device => !waiting(device))].map(deviceRow).join('');
  }
  function hosts(): RemoteDevice[] { return devices.filter(device => !device.current && device.host); }
  function pairRow(): string {
    const list = hosts();
    if (!pairTarget || !list.some(device => device.id === pairTarget)) pairTarget = list.find(device => device.online)?.id ?? list[0]?.id ?? '';
    const select = `<select id="remote-pair-host" aria-label="${t('Computer to pair with')}" ${list.length ? '' : 'disabled'}>${list.length ? list.map(device => `<option value="${escape(device.id)}"${device.id === pairTarget ? ' selected' : ''}>${escape(device.name)}</option>`).join('') : `<option>${t('No computers with remote control on')}</option>`}</select>`;
    return `<div class="setting-row"><div><strong>${t('Pair with a code')} ${infoMark(PAIR_TIP, t('About pairing with a code'))}</strong><small>${t('Enter the code shown on the other computer.')}</small></div><span class="remote-device-actions">${select}<input type="text" id="remote-pair-input" class="remote-pair-input" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000 000" aria-label="${t('Pairing code from the other computer')}" value="${escape(groupCode(pairInput))}"><button type="button" class="secondary-button" data-pair ${pairing || !list.length ? 'disabled' : ''}>${t('Pair')}</button></span></div>`;
  }
  function codeRow(): string {
    const shown = pairCode ? `<div class="remote-code"><div class="remote-code-row"><output class="remote-user-code" aria-label="${t('Pairing code')}">${escape(groupCode(pairCode.code))}</output><button type="button" class="secondary-button" data-code-cancel>${t('Cancel')}</button></div><p class="remote-note" role="status">${t`Gives ${SCOPE_LABELS[pairCode.scope].toLowerCase()} once. Expires at ${new Date(pairCode.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}</p></div>` : '';
    return `<div class="setting-row"><div><strong>${t('Pairing code')} ${infoMark(CODE_TIP, t('About pairing codes'))}</strong><small>${t('Add a device without the approval prompt.')}</small></div><span class="remote-device-actions"><select id="remote-code-scope" aria-label="${t('Access the pairing code gives')}">${pickOptions(codeScope)}</select><button type="button" class="secondary-button" data-code-new>${t('Show pairing code')}</button></span></div>${shown}`;
  }
  function body(): string {
    if (!status) {
      if (statusError) return failure(t('Couldn’t load remote access.'), statusError);
      if (loading) return `<p class="dialog-loading" role="status">${t('Loading…')}</p>`;
    }
    if (!status) return failure(t('Couldn’t load remote access.'), t('Try again.'));
    if (!status.configured) return `<p class="remote-note" role="status">${t('Remote access is not configured in this build.')}</p>`;
    if (!status.signedIn) {
      const flow = code ? `<div class="remote-code"><p>${t('Enter this code at')} <strong>${escape(code.verificationUri)}</strong>:</p><div class="remote-code-row"><output class="remote-user-code" aria-label="${t('Device code')}">${escape(code.userCode)}</output><button type="button" class="secondary-button" data-copy>${icon('copy')}${t('Copy code')}</button></div><p class="remote-note" role="status">${t`Waiting for you to approve in the browser… The code expires at ${new Date(expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}</p><button type="button" class="secondary-button" data-cancel>${t('Cancel')}</button></div>` : '';
      return `<div class="setting-row"><div><strong>${t('PandaCode Connect')}</strong><small>${t('Sign in with GitHub to reach your other computers. Task content is end-to-end encrypted; the relay sees only ciphertext.')}</small></div><button type="button" class="secondary-button" data-sign-in ${signingIn ? 'disabled' : ''}>${icon('github')}${t('Sign in with GitHub')}</button></div>${flow}`;
    }
    return `<div class="setting-row"><div><strong>${escape(status.account?.login ?? t('Signed in'))}</strong><small>${t('Signed in with GitHub')} · ${status.connected ? t('connected') : t('connecting…')}</small></div><button type="button" class="secondary-button" data-sign-out>${t('Sign out')}</button></div>
      <div class="setting-row"><div><strong>${t('Allow remote control of this computer')} ${infoMark(ALLOW_TIP, t('About remote control'))}</strong><small>${t('Your other signed-in computers can see and drive tasks here.')}</small></div><input type="checkbox" class="settings-switch" id="remote-host" aria-label="t('Allow remote control of this computer')" ${status.hostEnabled ? 'checked' : ''}></div>
      <div class="setting-row"><div><strong>${t('Notify my phone')} ${infoMark(NOTIFY_TIP, t('About phone notifications'))}</strong><small>${t('Pushes a generic notice when a hosted task needs approval or finishes. The relay never sees task content.')}</small></div><input type="checkbox" class="settings-switch" id="remote-notify" aria-label="t('Notify my phone')" ${status.notifyEnabled ? 'checked' : ''}></div>
      <div class="setting-row"><div><strong>${t('Full access for remote tasks')} ${infoMark(FULL_TIP, t('About full access for remote tasks'))}</strong><small>${t('Off: remote tasks always ask before acting.')}</small></div><input type="checkbox" class="settings-switch" id="remote-full-access" aria-label="t('Full access for remote tasks')" ${status.remoteFullAccess ? 'checked' : ''}></div>
      <div class="setting-row"><div><strong>${t('This computer’s key')} ${infoMark(KEY_TIP, t('About this computer’s key'))}</strong><small><code class="remote-key">${escape(groupFingerprint(status.device.fingerprint))}</code></small></div></div>
      ${status.hostEnabled ? codeRow() : ''}${pairRow()}
      <h3 class="settings-heading">${t('Devices')} ${infoMark(SCOPE_HELP, t('About device access'))}</h3>${grantsError ? `<p class="remote-note" role="status">${t`Access levels could not be loaded: ${escape(grantsError)}`}</p>` : ''}<div class="settings-group remote-devices">${deviceList()}</div>`;
  }
  function render(): void {
    if (disposed) return;
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
    const keep = active?.id, caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    main.innerHTML = `<div class="settings-group remote-settings">${body()}</div>${error ? `<p class="remote-error" role="alert">${escape(error)}</p>` : ''}`;
    if (keep) { const again = main.querySelector<HTMLElement>(`#${CSS.escape(keep)}`); again?.focus(); if (again instanceof HTMLInputElement && caret !== null) again.setSelectionRange(caret, caret); }
    if (status?.signedIn && !unmountOrchestration) unmountOrchestration = mountOrchestrationSettings(orchestration, host);
    else if (!status?.signedIn && unmountOrchestration) { unmountOrchestration(); unmountOrchestration = undefined; orchestration.innerHTML = ''; }
  }
  const apply = (next: RemoteStatus) => { status = next; if (next.signedIn) { code = undefined; signingIn = false; } else { pairCode = undefined; grants = []; } };
  async function loadGrants(): Promise<void> {
    grantsError = '';
    if (!status?.signedIn) { grants = []; return; }
    try { grants = await host.call<DeviceGrant[]>('remote_device_grants'); }
    catch (e) { grants = []; grantsError = message(e); }
  }
  async function loadDevices(): Promise<void> {
    devicesLoaded = false; devicesError = '';
    if (!status?.signedIn) { devices = []; devicesLoaded = true; return; }
    try { devices = await host.call<RemoteDevice[]>('remote_devices'); devicesLoaded = true; }
    catch (e) { devicesError = message(e); }
    await loadGrants();
  }
  async function load(): Promise<void> {
    loading = true; statusError = ''; devicesError = ''; error = ''; render();
    try { apply(await host.call<RemoteStatus>('remote_status')); }
    catch (e) { status = undefined; statusError = message(e); }
    if (status) await loadDevices();
    loading = false; render();
  }
  async function signIn(): Promise<void> {
    if (signingIn) return;
    error = ''; devicesError = ''; signingIn = true;
    const mine = ++attempt;
    try {
      code = await host.call<RemoteSignIn>('remote_sign_in_start'); expires = Date.now() + code.expiresIn * 1000; render();
      void host.openUrl(code.verificationUri).catch(() => undefined);
      apply(await host.call<RemoteStatus>('remote_sign_in_finish'));
      await loadDevices();
    } catch (e) {
      if (mine !== attempt) return;
      code = undefined; signingIn = false; error = message(e);
    }
    render();
  }
  function cancelSignIn(): void {
    attempt++; code = undefined; signingIn = false; error = ''; render();
    void host.call('remote_sign_in_cancel').catch(fail);
  }
  function setGrant(deviceId: string, scope: string): void {
    error = '';
    void host.call('remote_set_device_grant', { deviceId, scope }).then(() => loadGrants()).then(() => render(), e => { error = message(e); void loadGrants().then(render); });
  }
  function showCode(next: PairCode | undefined): void {
    pairCode = next; window.clearTimeout(expiry);
    if (next) expiry = window.setTimeout(() => { if (pairCode === next) { pairCode = undefined; render(); } }, Math.max(0, next.expiresAt - Date.now()));
    render();
  }
  root.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    const row = target.closest<HTMLElement>('.remote-device');
    if (target.hasAttribute('data-retry')) void load();
    else if (target.hasAttribute('data-sign-in')) void signIn();
    else if (target.hasAttribute('data-cancel')) cancelSignIn();
    else if (target.hasAttribute('data-copy') && code) void navigator.clipboard.writeText(code.userCode).then(() => host.notify(t('Code copied')), () => host.notify(t('Couldn’t copy; select the code instead')));
    else if (target.hasAttribute('data-sign-out')) void host.call<RemoteStatus>('remote_sign_out').then(next => { apply(next); devices = []; devicesLoaded = true; devicesError = ''; error = ''; render(); }, fail);
    else if (target.dataset.revoke) void host.call('remote_revoke_device', { deviceId: target.dataset.revoke }).then(() => { devices = devices.filter(d => d.id !== target.dataset.revoke); render(); }, fail);
    else if (target.dataset.approve) setGrant(target.dataset.approve, row?.querySelector<HTMLSelectElement>('select[data-pick]')?.value ?? 'control');
    else if (target.dataset.block) setGrant(target.dataset.block, 'blocked');
    else if (target.hasAttribute('data-code-new')) void host.call<PairCode>('remote_pair_code', { scope: codeScope }).then(showCode, fail);
    else if (target.hasAttribute('data-code-cancel')) { showCode(undefined); void host.call('remote_pair_code_cancel').catch(fail); }
    else if (target.hasAttribute('data-pair') && !pairing) {
      const name = devices.find(device => device.id === pairTarget)?.name ?? 'that computer';
      error = ''; pairing = true; render();
      void host.call<{ scope: GrantScope }>('remote_pair_redeem', { deviceId: pairTarget, code: pairInput }).then(result => { pairInput = ''; host.notify(`Paired with ${name}: ${(SCOPE_LABELS[result.scope] ?? result.scope).toLowerCase()}`); }, e => { error = message(e); }).finally(() => { pairing = false; render(); });
    }
  });
  root.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'remote-pair-input') return;
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    pairInput = digits; input.value = groupCode(digits);
  });
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.id === 'remote-pair-host') { pairTarget = input.value; return; }
    if (input.id === 'remote-code-scope') { codeScope = input.value as GrantScope; return; }
    if (input instanceof HTMLSelectElement && input.dataset.pick) { picks[input.dataset.pick] = input.value; return; }
    if (input instanceof HTMLSelectElement && input.dataset.grant) { setGrant(input.dataset.grant, input.value); return; }
    const args = input.id === 'remote-host' ? { enabled: (input as HTMLInputElement).checked } : input.id === 'remote-full-access' ? { fullAccess: (input as HTMLInputElement).checked } : undefined;
    if (args) void host.call<RemoteStatus>('remote_set_host_enabled', args).then(next => { apply(next); render(); }, e => { (input as HTMLInputElement).checked = !(input as HTMLInputElement).checked; fail(e); });
    if (input.id === 'remote-notify') void host.call<RemoteStatus>('remote_set_notify_enabled', { enabled: (input as HTMLInputElement).checked }).then(next => { apply(next); render(); }, e => { (input as HTMLInputElement).checked = !(input as HTMLInputElement).checked; fail(e); });
  });
  const unlisten: Promise<() => void>[] = [
    host.listen('remote://status', next => { if (!signingIn || next.signedIn) { apply(next); render(); } }),
    host.listen('remote://presence', next => { if (Array.isArray(next)) { devices = next; devicesLoaded = true; devicesError = ''; void loadGrants().then(render); } }),
    host.listen('remote://device-grants', next => { if (Array.isArray(next)) { grants = next; grantsError = ''; render(); } }),
    host.listen('remote://pair-code-used', () => { if (pairCode) { host.notify('Pairing code used'); showCode(undefined); } }),
  ];
  // The orchestration section keeps its own state, so it lives beside the redrawn body.
  root.innerHTML = '<div class="remote-main"></div><div class="remote-orchestration"></div><section class="remote-diagnostics-section" hidden><h3 class="settings-heading">Diagnostics</h3><div class="settings-group remote-diagnostics-body"></div></section>';
  const main = root.querySelector<HTMLElement>('.remote-main')!, orchestration = root.querySelector<HTMLElement>('.remote-orchestration')!;
  let unmountOrchestration: (() => void) | undefined;
  const section = root.querySelector<HTMLElement>('.remote-diagnostics-section')!;
  void import('./remote-diagnostics').then(module => {
    const mount = (module as { mountRemoteDiagnostics?: (container: HTMLElement) => void }).mountRemoteDiagnostics;
    if (disposed || typeof mount !== 'function') return;
    mount(section.querySelector<HTMLElement>('.remote-diagnostics-body')!);
    section.hidden = false;
  }).catch(() => undefined);
  void load();
  return () => { disposed = true; window.clearTimeout(expiry); unmountOrchestration?.(); for (const u of unlisten) void u.then(fn => fn(), () => undefined); };
}
