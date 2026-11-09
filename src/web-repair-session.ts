import { web } from './web-transport';
import { webJson } from './web-http';

export function mountWebSessionRepair(): () => void {
  if (!web) return () => {};
  const transport = web;
  const banner = document.querySelector<HTMLElement>('.web-connection-status');
  if (!banner) return () => {};
  const pair = document.createElement('button');
  pair.type = 'button'; pair.textContent = 'Pair again'; pair.className = 'secondary-button'; banner.append(pair);
  let active: HTMLDialogElement | null = null;

  const open = () => {
    if (active) return;
    const dialog = document.createElement('dialog');
    active = dialog; dialog.className = 'web-pairing dialog-plate';
    dialog.innerHTML = '<form method="dialog"><h2>Pair again</h2><p>Your workspace and unsent drafts stay open.</p><label>One-time pairing code <input name="token" type="password" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="256"></label><p role="status" aria-live="polite"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" value="submit">Pair</button></footer></form>';
    document.body.append(dialog);
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const status = dialog.querySelector<HTMLElement>('[role=status]')!;
    const submit = dialog.querySelector<HTMLButtonElement>('button[value=submit]')!;
    const previous = document.activeElement as HTMLElement | null;
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => { if (settled) return; settled = true; controller.abort(); if (active === dialog) active = null; dialog.remove(); previous?.focus?.(); };
    dialog.addEventListener('close', cleanup, { once: true });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('submit', async event => {
      event.preventDefault();
      if ((event.submitter as HTMLButtonElement)?.value !== 'submit' || settled) return dialog.close();
      const token = input.value.trim(); input.value = ''; submit.disabled = true; status.textContent = 'Pairing…';
      try {
        const { response } = await webJson('/api/pandacode/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal });
        if (settled || active !== dialog) return;
        if (response.status !== 204) throw new Error('Pairing failed');
        await transport.recover();
        if (!settled && active === dialog) dialog.close();
      } catch (error) {
        if (settled || active !== dialog || controller.signal.aborted) return;
        status.textContent = error instanceof Error ? error.message : 'Could not pair with the host.'; submit.disabled = false;
      }
    });
    void webJson('/api/pandacode/login-mode', { cache: 'no-store', signal: controller.signal }).then(({ value }) => {
      if (settled || (value as { mode?: string } | null)?.mode !== 'password') return;
      dialog.querySelector('h2')!.textContent = 'Sign in again';
      input.parentElement!.firstChild!.textContent = 'Instance password ';
      input.autocomplete = 'current-password';
      submit.textContent = 'Sign in';
    }).catch(() => {});
    dialog.showModal(); input.focus();
  };
  pair.addEventListener('click', open);
  return () => { pair.removeEventListener('click', open); active?.close(); pair.remove(); };
}
