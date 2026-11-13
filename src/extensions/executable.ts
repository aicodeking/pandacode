/** Host-owned executable command UI. No source, runtime path or raw bridge reaches package code. */
import { call } from '../bridge';
import { isImeKey } from '../dom';
import { onExtensionChanged, extensionsSnapshot, type ExtensionMenuItem } from './manager';
import { openToolCommand } from './jobs';
import { openConnectionCommand } from './connections';
import { openExtensionDialog } from './dialogs';
import type { DialogDefinition } from './dialog-state';
import type { ContextReply } from './context-state';
import type { Json } from './contracts';

export const EXECUTABLE_WARNING = 'This is trusted executable code under your normal OS account. It can read and write user-accessible files, access credentials available to your account, use the network, and start programs. PandaCode API grants are not an OS sandbox and do not constrain independent OS calls. No automatic elevation. Revoking trust stops future managed activation and owned work where possible; it cannot undo prior effects or contain deliberately hostile trusted code.';

export function openExecutableCommand(id: string, version: string, context: Record<string, Json>, trigger: HTMLElement, notify: (message: string) => void, onClose?: () => void): () => void {
  const contributes = extensionsSnapshot().packages.find(item => item.manifest.id === id.split('/')[0])?.manifest.contributes;
  const consumer = extensionsSnapshot().packages.find(item => item.manifest.id === id.split('/')[0])?.manifest;
  const services = consumer?.permissions?.includes('services.call') ? extensionsSnapshot().packages.filter(item => Object.hasOwn(consumer.dependencies ?? {}, item.manifest.id)).flatMap(item => item.manifest.contributes.services ?? []) : [];
  const leafCommand = (items: ExtensionMenuItem[]): string | undefined => { for (const item of items) { if (item.id === id) return item.command; const nested = item.items && leafCommand(item.items); if (nested) return nested; } };
  const menu = contributes?.menus?.find(menu => menu.id === id);
  const commandId = menu?.command ?? contributes?.menus?.flatMap(menu => menu.items ?? []).map(item => leafCommand([item])).find(Boolean) ?? id;
  const tool = contributes?.tools?.find(tool => tool.command === commandId);
  const connection = contributes?.connections?.find(connection => connection.command === commandId);
  if (connection) return openConnectionCommand(id, version, context, connection, trigger, onClose);
  if (tool) return openToolCommand(id, version, context, tool, trigger, onClose);
  if (document.querySelector('[data-executable-command]')) return () => {};
  const captured = structuredClone(context), requestId = crypto.randomUUID();
  const panel = document.createElement('section'); panel.className = 'extension-context-inspector ds-card'; panel.dataset.executableCommand = id;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Executable command');
  const heading = document.createElement('h2'); heading.textContent = 'Executable command';
  const scope = document.createElement('p'); scope.textContent = `Captured project: ${String(captured.projectId ?? 'none')} · ${id.split('/')[0]}`;
  const explanation = document.createElement('p'); explanation.textContent = 'Executable trust does not grant PandaCode context APIs. Allow project summaries for this captured project and launch, or run without API access.';
  if (consumer?.permissions?.includes('services.call')) explanation.textContent = `Allow public service calls for this captured invocation only: ${services.map(service => `${service.id} @ ${service.version}`).join(', ') || 'no available provider'}. Caller and project come from the native broker, not package input.`;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Ready — no package code started';
  let ended = false, running = false, handle: string | undefined, closeDialog: (() => void) | undefined;
  const send = async <T>(command: string, request: Record<string, unknown>): Promise<ContextReply<T>> => {
    try { return await call<ContextReply<T>>(command, { request }); } catch { return { ok: false, error: { schemaVersion: 1, code: 'HostUnavailable', path: '$', ids: [] } }; }
  };
  const ready = send<{ handle: string }>('extensions_context', { op: 'capture', id, version, context: captured }).then(async result => {
    if (result.ok) { handle = result.value.handle; if (ended) await send('extensions_context', { op: 'release', handle }); }
    return result;
  });
  const close = () => {
    if (ended) return; ended = true; unsubscribe(); panel.remove(); closeDialog?.();
    void send('extensions_runtime', { op: 'cancel', requestId });
    if (handle) void send('extensions_context', { op: 'release', handle });
    if (trigger.isConnected && trigger.checkVisibility()) trigger.focus({ preventScroll: true });
    onClose?.();
  };
  const button = (text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'ds-btn'; node.textContent = text; node.onclick = action; return node; };
  async function run(allow: boolean) {
    if (ended || running) return; running = true; status.textContent = 'Starting supervised host…';
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-executable-run]')) button.disabled = true;
    const result = await ready;
    if (ended) return;
    if (!result.ok) { status.textContent = result.error.code; return; }
    if (allow) {
      for (const request of consumer?.permissions?.includes('services.call') ? services.map(service => ({ command: 'extensions_runtime', request: { op: 'services', handle, request: { op: 'grant', service: service.id, allow: true } } })) : [{ command: 'extensions_context', request: { op: 'consent', handle, capability: 'projects.summary', allow: true } }]) {
        const grant = await send(request.command, request.request);
        if (ended) return;
        if (!grant.ok) { status.textContent = grant.error.code; return; }
      }
    }
    const reply = await send<{ schemaVersion: 1; dialogs: DialogDefinition[] }>('extensions_runtime', { op: 'activate', handle, requestId });
    if (ended) return;
    if (!reply.ok) { status.textContent = `${reply.error.code} — close; disable/enable explicitly to retry a quarantined host.`; return; }
    status.textContent = 'Completed — owned host and subscriptions disposed';
    const definition = reply.value.dialogs[0];
    if (definition) {
      panel.remove(); const transient = openExtensionDialog(definition, captured, id.split('/')[0], trigger); closeDialog = transient.close;
      void transient.result.then(result => { if (!ended && result.kind === 'confirmed') notify(definition.successMessage); close(); });
    }
  }
  const allow = button('Allow project summaries and run', () => { void run(true); }); allow.dataset.executableRun = '';
  if (consumer?.permissions?.includes('services.call')) allow.textContent = 'Allow public services and run';
  const deny = button('Run without API grants', () => { void run(false); }); deny.dataset.executableRun = '';
  const cancel = button('Cancel executable command', close);
  panel.append(heading, scope, explanation, status, allow, deny, cancel);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !isImeKey(event)) { event.stopPropagation(); close(); } });
  const unsubscribe = onExtensionChanged(id.split('/')[0], close);
  document.body.append(panel); cancel.focus(); return close;
}
