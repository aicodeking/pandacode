/** Host-owned credential form. Never render/log credential values or remote error text. */
import { call } from '../bridge';
import { isImeKey } from '../dom';
import { onExtensionChanged } from './manager';
import type { Json } from './contracts';
import type { ContextReply } from './context-state';
import type { ConnectionDescriptor, ConnectionStatus, ConnectionRequest } from './sdk';

export function openConnectionCommand(id: string, version: string, context: Record<string, Json>, descriptor: ConnectionDescriptor, trigger: HTMLElement, onClose?: () => void): () => void {
  if (document.querySelector('[data-extension-connection]')) return () => {};
  const panel = document.createElement('section'); panel.className = 'extension-context-inspector ds-card'; panel.dataset.extensionConnection = descriptor.id;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Extension connection');
  const title = document.createElement('h2'); title.textContent = descriptor.title;
  const disclosure = document.createElement('p'); disclosure.textContent = `Host-managed ${descriptor.authentication} / ${descriptor.adapter}. Only the selected exact GET endpoint is authorized; redirects are denied. Credentials remain in native storage for this invocation and are removed on close/revoke. Trusted code can independently access account-available credentials; this API is not an OS sandbox.`;
  const label = document.createElement('label'); label.textContent = 'Service credential';
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.maxLength = 4096; label.append(input);
  const operationsLabel = document.createElement('label'); operationsLabel.textContent = 'Authorized operation';
  const operations = document.createElement('select'); operations.setAttribute('aria-label', 'Authorized operation');
  for (const operation of descriptor.operations) { const option = document.createElement('option'); option.value = operation.id; option.textContent = `${operation.id} · GET ${operation.url}`; operations.append(option); }
  operationsLabel.append(operations);
  const fields = document.createElement('div'); fields.className = 'extension-project-reads'; fields.append(label, operationsLabel);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Disconnected — no network request';
  const output = document.createElement('pre'); output.className = 'extension-context-output extension-project-read-output'; output.setAttribute('aria-label', 'Sanitized connection response');
  let ended = false, busy = false, handle: string | undefined, credential: string | null = null, requestId: string | undefined, grantedOperation: string | undefined;
  const send = async <T>(command: string, request: Record<string, unknown>): Promise<ContextReply<T>> => {
    try { return await call(command, { request }); } catch { return { ok: false, error: { schemaVersion: 1, code: 'HostUnavailable', path: '$', ids: [] } }; }
  };
  const connection = <T>(request: Record<string, unknown>, operation = grantedOperation ?? operations.value) => send<T>('extensions_runtime', { op: 'connections', handle, request: { connection: descriptor.id, operation, ...request } });
  const ready = send<{ handle: string }>('extensions_context', { op: 'capture', id, version, context: structuredClone(context) }).then(async reply => { if (reply.ok) { handle = reply.value.handle; if (ended) await send('extensions_context', { op: 'release', handle }); } return reply; });
  const revoke = async () => { input.value = ''; credential = null; output.textContent = ''; if (handle && grantedOperation) await connection({ op: 'revoke' }); grantedOperation = undefined; if (!ended) status.textContent = 'Disconnected — authorization revoked'; };
  const close = () => {
    if (ended) return; ended = true; input.value = ''; unsubscribe(); panel.remove();
    void revoke().finally(() => { if (handle) void send('extensions_context', { op: 'release', handle }); });
    if (trigger.isConnected && trigger.checkVisibility()) trigger.focus({ preventScroll: true }); onClose?.();
  };
  const button = (text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'ds-btn'; node.textContent = text; node.onclick = () => { node.focus({ preventScroll: true }); action(); }; return node; };
  const connect = button('Save credential and authorize operation', () => { void (async () => {
    if (busy || ended) return; busy = true;
    try {
      const captured = await ready; if (ended) return; if (!captured.ok) { input.value = ''; status.textContent = captured.error.code; return; }
      // Copy only into this one host-to-native call; clear the password control synchronously.
      const secret = input.value; input.value = ''; await revoke(); if (ended) return;
      grantedOperation = operations.value;
      const reply = await connection<ConnectionStatus>({ op: 'connect', secret });
      if (ended) { await revoke(); return; }
      if (!reply.ok) { status.textContent = reply.error.code; return; }
      credential = reply.value.credential; status.textContent = 'Connected — no network request';
    } finally { busy = false; }
  })(); });
  const run = button('Run broker request', () => { void (async () => {
    if (busy || ended) return; if (!credential || operations.value !== grantedOperation) { status.textContent = 'PermissionDenied'; return; }
    busy = true; run.disabled = true; cancel.focus({ preventScroll: true }); output.textContent = '';
    try {
      let reply = await connection<ConnectionRequest>({ op: 'start', credential });
      while (!ended) {
        if (!reply.ok) { status.textContent = reply.error.code; break; }
        const current = reply.value; requestId = current.request;
        status.textContent = current.error ?? `Request ${current.state}`;
        if (current.state !== 'running') { output.textContent = credential && current.response ? JSON.stringify(current.response) : ''; break; }
        await new Promise(resolve => window.setTimeout(resolve, 50)); if (ended) break;
        reply = await connection<ConnectionRequest>({ op: 'poll', request: requestId });
      }
    } finally { busy = false; run.disabled = false; }
  })(); });
  const cancel = button('Cancel request', () => { if (requestId && handle) void connection({ op: 'cancel', request: requestId }); });
  const revokeButton = button('Revoke connection authorization', () => { void revoke(); });
  const exit = button('Close connection', close);
  const actions = document.createElement('div'); actions.className = 'extension-context-consent'; actions.append(connect, run, cancel, revokeButton, exit);
  panel.append(title, disclosure, fields, status, output, actions);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !isImeKey(event)) { event.stopPropagation(); close(); } });
  const unsubscribe = onExtensionChanged(id.split('/')[0], close); document.body.append(panel); input.focus(); return close;
}
