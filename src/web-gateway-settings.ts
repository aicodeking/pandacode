import { web } from './web-transport';
import { webJson } from './web-http';

const limits = [
  { value: '12h', seconds: 43200, label: '12 hours' },
  { value: '24h', seconds: 86400, label: '24 hours' },
  { value: '2d', seconds: 172800, label: '2 days' },
  { value: '7d', seconds: 604800, label: '1 week' },
  { value: 'none', seconds: null, label: 'No limit' },
];

type SessionSummary = { id: string; remainingSeconds: number | null };

function sessionLabel(id: string): string {
  return `Session ${id.slice(0, 8)}`;
}

function expiryLabel(seconds: number | null): string {
  return seconds === null ? 'No server-side expiration.' :
    `Expires ${new Date(Date.now() + seconds * 1000).toLocaleString()}.`;
}

/** Pairing secrets are displayed only in the native main window, never saved in storage. */
export function mountWebGatewaySettings(host: HTMLElement): () => void {
  if (!('__TAURI_INTERNALS__' in window)) return () => {};
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = '<div><strong>Browser workspace</strong><small data-web-status>Checking browser gateway…</small><output data-web-pairing hidden aria-label="One-time browser pairing code"></output></div><button type="button" class="secondary-button" disabled>Create pairing code</button>';
  host.append(row);
  const status = row.querySelector('small')!;
  const button = row.querySelector('button')!;
  const output = row.querySelector('output')!;
  let disposed = false, timer = 0;
  const management = document.createElement('div');
  host.append(management);
  void import('@tauri-apps/api/core').then(async ({ invoke }) => {
    const info = await invoke<{enabled:boolean;ready:boolean;origin:string|null;sessionLimitSeconds?:number|null;passwordMode?:boolean}>('web_gateway_info');
    if (disposed) return;
    status.textContent = info.enabled ? `Browser gateway: ${info.origin}. Pairing codes expire after ten minutes and work once.` : 'Disabled. Start the host with --web-gateway to enable browser access.';
    if (info.enabled && info.passwordMode) {
      status.textContent = `Browser gateway: ${info.origin}. Password sign-in is enabled.`;
      button.hidden = true;
    }
    button.disabled = !info.enabled || !!info.passwordMode;
    if (info.enabled && info.sessionLimitSeconds !== undefined) {
      const settingsRow = document.createElement('div');
      settingsRow.className = 'setting-row';
      const label = document.createElement('label');
      label.textContent = 'Session duration for new sign-ins';
      const select = document.createElement('select');
      select.setAttribute('aria-label', label.textContent);
      for (const limit of limits) select.add(new Option(limit.label, limit.value));
      let saved = limits.find(limit => limit.seconds === info.sessionLimitSeconds)?.value ?? '12h';
      select.value = saved;
      const feedback = document.createElement('small');
      feedback.setAttribute('role', 'status');
      feedback.textContent = 'Existing sessions keep their original expiration.';
      label.append(document.createElement('br'), feedback);
      settingsRow.append(label, select);
      select.onchange = async () => {
        const setting = select.value;
        select.disabled = true;
        try {
          await invoke('web_gateway_set_session_limit', { setting });
          saved = setting;
          feedback.textContent = 'Saved for new sign-ins.';
        } catch {
          select.value = saved;
          feedback.textContent = 'Could not save session duration.';
        } finally {
          select.disabled = false;
        }
      };

      const list = document.createElement('div');
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'secondary-button';
      refresh.textContent = 'Refresh browser sessions';
      const listStatus = document.createElement('p');
      listStatus.setAttribute('role', 'status');
      const reload = async () => {
        refresh.disabled = true;
        try {
          const sessions = await invoke<SessionSummary[]>('web_gateway_sessions');
          if (disposed) return;
          list.replaceChildren();
          listStatus.textContent = sessions.length ? '' : 'No active browser sessions.';
          for (const session of sessions) {
            const item = document.createElement('div');
            item.className = 'setting-row';
            const description = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = sessionLabel(session.id);
            const expiry = document.createElement('small');
            expiry.textContent = expiryLabel(session.remainingSeconds);
            description.append(title, expiry);
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'secondary-button';
            revoke.textContent = 'Revoke';
            revoke.setAttribute('aria-label', `Revoke ${title.textContent}`);
            revoke.onclick = async () => {
              revoke.disabled = true;
              try {
                await invoke('web_gateway_revoke_session', { id: session.id });
                await reload();
              } catch {
                listStatus.textContent = 'Could not revoke this session.';
                revoke.disabled = false;
              }
            };
            item.append(description, revoke);
            list.append(item);
          }
        } catch {
          listStatus.textContent = 'Could not load browser sessions.';
        } finally {
          refresh.disabled = false;
        }
      };
      refresh.onclick = reload;
      management.append(settingsRow, refresh, listStatus, list);
      void reload();
    }
    button.addEventListener('click', async () => {
      button.disabled = true; output.hidden = true; output.textContent = '';
      try {
        const pairing = await invoke<{token:string;expiresAt:number}>('web_gateway_pair');
        if (disposed) return;
        output.textContent = pairing.token; output.hidden = false;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { output.textContent = ''; output.hidden = true; }, Math.max(0, Math.min(600000, pairing.expiresAt * 1000 - Date.now())));
      } catch { status.textContent = 'Could not create a pairing code. Check that the browser gateway is enabled.'; }
      finally { if (!disposed) button.disabled = false; }
    });
  }).catch(() => { if (!disposed) status.textContent = 'Browser gateway is unavailable in this host build.'; });
  return () => { disposed = true; window.clearTimeout(timer); output.textContent = ''; row.remove(); management.remove(); };
}

export function mountBrowserWorkspaceSettings(host: HTMLElement): () => void {
  if (!web) return mountWebGatewaySettings(host);
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = '<div><strong>Browser session</strong><small role="status">Sign out of PandaCode on this browser.</small></div>';
  const signOut = document.createElement('button');
  signOut.type = 'button';
  signOut.className = 'secondary-button';
  signOut.textContent = 'Sign out';
  const status = row.querySelector('small')!;
  row.append(signOut);
  signOut.onclick = async () => {
    signOut.disabled = true;
    try {
      const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )pandacode_csrf=([^;]+)/)?.[1] ?? '');
      const { response } = await webJson('/api/pandacode/session', { method: 'DELETE', headers: { 'x-csrf-token': csrf } });
      if (response.status !== 204) throw new Error('Sign-out failed');
      location.reload();
    } catch {
      status.textContent = 'Could not sign out. Try again.';
      signOut.disabled = false;
    }
  };
  host.append(row);
  const controller = new AbortController();
  void webJson('/api/pandacode/session/details', { signal: controller.signal }).then(({ response, value }) => {
    if (controller.signal.aborted || !response.ok || !value || typeof value !== 'object') return;
    const { id, remainingSeconds: seconds } = value as { id?: unknown; remainingSeconds?: unknown };
    if (typeof id === 'string') row.querySelector('strong')!.textContent = sessionLabel(id);
    if (seconds === null || (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0)) {
      status.textContent = expiryLabel(seconds);
    }
  }).catch(() => {});
  return () => { controller.abort(); row.remove(); };
}
