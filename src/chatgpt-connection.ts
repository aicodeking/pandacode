import { call, preview } from './bridge';

interface Status { installed: boolean; state: 'signedOut' | 'chatgpt' | 'apiKey' | 'other'; email: string | null; plan: string | null; }

/** Codex owns the browser login. No auth URL or credentials enter the webview. */
export function mountChatgptConnection(host: HTMLElement, saved: () => Promise<unknown>): () => void {
  const status = host.querySelector<HTMLElement>('[data-chatgpt-status]')!;
  const login = host.querySelector<HTMLButtonElement>('[data-chatgpt-login]')!;
  const logout = host.querySelector<HTMLButtonElement>('[data-chatgpt-logout]')!;
  const cancel = host.querySelector<HTMLButtonElement>('[data-chatgpt-cancel]')!;
  const refresh = host.querySelector<HTMLButtonElement>('[data-chatgpt-refresh]')!;
  const feedback = host.querySelector<HTMLElement>('[data-chatgpt-feedback]')!;
  let disposed = false, busy = false, revision = 0, loginId: string | undefined;

  function message(text: string, error = false): void {
    feedback.textContent = text; feedback.hidden = !text; feedback.classList.toggle('error', error);
  }
  function render(value: Status): void {
    const identity = [value.email, value.plan].filter(Boolean).join(' · ');
    status.textContent = !value.installed ? 'Codex is not installed. See Advanced setup below.'
      : value.state === 'chatgpt' ? `Signed in with ChatGPT${identity ? ` · ${identity}` : ''}`
      : value.state === 'apiKey' ? 'Codex uses an API key with separate API billing.'
      : value.state === 'other' ? 'Codex uses another authentication method.' : 'Not signed in with ChatGPT';
    login.hidden = value.state === 'chatgpt';
    login.disabled = !value.installed;
    logout.hidden = value.state === 'signedOut';
  }
  function setBusy(value: boolean): void {
    busy = value;
    host.setAttribute('aria-busy', String(value));
    login.disabled = value; logout.disabled = value; refresh.disabled = value;
    cancel.hidden = !loginId; cancel.disabled = false;
    login.textContent = loginId ? 'Waiting for browser…' : 'Sign in with ChatGPT';
  }
  async function check(): Promise<void> {
    if (busy || disposed) return;
    const ticket = ++revision;
    refresh.disabled = true;
    try {
      const result = await call<Status>('provider_chatgpt_status');
      if (!disposed && ticket === revision) render(result);
    } catch { if (!disposed && ticket === revision) status.textContent = 'Could not check Codex sign-in. Try Refresh or sign in again.'; }
    finally { if (!disposed && ticket === revision) refresh.disabled = busy; }
  }
  async function change(signingIn: boolean): Promise<void> {
    if (busy || disposed) return;
    ++revision;
    loginId = signingIn ? crypto.randomUUID() : undefined;
    setBusy(true);
    message(signingIn ? preview ? 'Browser preview · simulating ChatGPT sign-in.' : 'Finish signing in in your browser. You can return here when it is complete.' : 'Signing out…');
    try {
      const result = await call<Status>(signingIn ? 'provider_chatgpt_login' : 'provider_chatgpt_logout', signingIn ? { loginId } : undefined);
      if (disposed) return;
      await saved();
      if (disposed) return;
      loginId = undefined; setBusy(false); render(result);
      message(signingIn && result.state !== 'chatgpt' ? 'Codex finished sign-in but did not report a ChatGPT account. Refresh to check again.' : '');
    } catch (error) { if (!disposed) message(String(error), true); }
    finally {
      loginId = undefined;
      if (!disposed) { setBusy(false); void check(); }
    }
  }
  const click = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button === login) void change(true);
    else if (button === logout) void change(false);
    else if (button === refresh) void check();
    else if (button === cancel && loginId) {
      cancel.disabled = true;
      void call('provider_chatgpt_cancel', { loginId }).catch(error => {
        if (!disposed) { cancel.disabled = false; message(String(error), true); }
      });
    }
  };
  // Settings keeps mounted sections alive while their tabs are hidden.
  const panel = host.closest<HTMLElement>('[role="tabpanel"]');
  const visibility = new MutationObserver(() => {
    if (panel?.hidden && loginId) void call('provider_chatgpt_cancel', { loginId }).catch(() => {});
  });
  if (panel) visibility.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  host.addEventListener('click', click);
  void check();
  return () => {
    disposed = true; ++revision;
    visibility.disconnect();
    if (loginId) void call('provider_chatgpt_cancel', { loginId }).catch(() => {});
    host.removeEventListener('click', click);
  };
}
