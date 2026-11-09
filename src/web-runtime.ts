import { web } from './web-transport';
import { mountWebSessionRepair } from './web-repair-session';

export function mountWebConnectionStatus(): () => void {
  if (!web) return () => {};
  const transport = web;
  const status = document.createElement('aside');
  status.className = 'web-connection-status'; status.hidden = true;
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const message = document.createElement('span'), retry = document.createElement('button');
  retry.type = 'button'; retry.textContent = 'Retry connection';
  status.append(message, retry); document.body.append(status);
  const refresh = () => { void transport.recover().catch(() => {}); };
  const paint = (event: Event) => {
    const detail = (event as CustomEvent<{status:string;message?:string}>).detail;
    status.hidden = detail.status === 'connected';
    retry.hidden = detail.status !== 'error';
    message.textContent = detail.status === 'error' ? detail.message ?? 'Could not reconnect to the host.' : 'Reconnecting to the host. Your unsent text stays in this browser.';
  };
  retry.addEventListener('click', refresh);
  const disposeRepair = mountWebSessionRepair();
  window.addEventListener('pandacode-web-connection', paint);
  window.addEventListener('online', refresh);
  return () => { disposeRepair(); status.remove(); window.removeEventListener('pandacode-web-connection', paint); window.removeEventListener('online', refresh); };
}
