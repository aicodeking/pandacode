/** Host-owned tool consent. Package arguments are data, never command lines. */
import { call } from '../bridge';
import { isImeKey } from '../dom';
import { onExtensionChanged, type ExtensionTool } from './manager';
import type { Json } from './contracts';
import type { ContextReply } from './context-state';
export type OwnedJob = { schemaVersion: 1; job: string; state: 'running' | 'completed' | 'cancelled' | 'timeout' | 'failed'; progress: Json[]; result: Json; error: string | null };
export function openToolCommand(id: string, version: string, context: Record<string, Json>, tool: ExtensionTool, trigger: HTMLElement, onClose?: () => void): () => void {
  if (document.querySelector('[data-extension-tool]')) return () => {};
  const panel = document.createElement('section'); panel.className = 'extension-context-inspector ds-card'; panel.dataset.extensionTool = tool.id;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Extension tool');
  const heading = document.createElement('h2'); heading.textContent = 'Run registered tool';
  const disclosure = document.createElement('p'); disclosure.textContent = `${tool.id} · packaged ${tool.executable} · cwd: captured project ${String(context.projectId ?? 'none')} · deadline ${tool.timeoutMs} ms. Trusted code has normal OS-account authority; this grant only authorizes PandaCode's managed job API.`;
  const label = document.createElement('label'); label.textContent = 'Literal argument (optional)';
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = tool.arguments.maxLength; label.append(input);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Not authorized — no process started';
  const fields = document.createElement('div'); fields.className = 'extension-project-reads'; fields.append(label);
  const output = document.createElement('pre'); output.className = 'extension-context-output extension-project-read-output'; output.setAttribute('aria-label', 'Tool progress and result');
  let ended = false, running = false, handle: string | undefined, job: string | undefined;
  const send = async <T>(command: string, request: Record<string, unknown>): Promise<ContextReply<T>> => {
    try { return await call(command, { request }); } catch { return { ok: false, error: { schemaVersion: 1, code: 'HostUnavailable', path: '$', ids: [] } }; }
  };
  const jobs = <T>(request: Record<string, unknown>) => send<T>('extensions_runtime', { op: 'jobs', handle, request: { tool: tool.id, ...request } });
  const ready = send<{ handle: string }>('extensions_context', { op: 'capture', id, version, context: structuredClone(context) }).then(async reply => { if (reply.ok) { handle = reply.value.handle; if (ended) await send('extensions_context', { op: 'release', handle }); } return reply; });
  const close = () => {
    if (ended) return; ended = true; unsubscribe(); panel.remove();
    if (handle) void jobs({ op: 'grant', allow: false }).finally(() => send('extensions_context', { op: 'release', handle }));
    if (trigger.isConnected && trigger.checkVisibility()) trigger.focus({ preventScroll: true }); onClose?.();
  };
  const button = (text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'ds-btn'; node.textContent = text; node.onclick = () => { node.focus({ preventScroll: true }); action(); }; return node; };
  const start = button('Authorize this project and run tool', () => { void run(); });
  async function run() {
    if (running || ended) return; running = true; start.disabled = true;
    // WebKit drops focus when the active launch button becomes disabled and does not
    // focus buttons on pointer click. Keep Escape and keyboard cancellation in the panel.
    cancel.focus({ preventScroll: true });
    const captured = await ready; if (ended) return;
    if (!captured.ok) { status.textContent = captured.error.code; return; }
    const grant = await jobs({ op: 'grant', allow: true }); if (ended) { await jobs({ op: 'grant', allow: false }); return; }
    if (!grant.ok) { status.textContent = grant.error.code; return; }
    const reply = await jobs<OwnedJob>({ op: 'start', args: input.value ? [input.value] : [] }); if (ended) return;
    if (!reply.ok) { status.textContent = reply.error.code; return; }
    job = reply.value.job;
    let current = reply.value;
    while (!ended) {
      status.textContent = `Job ${current.state}${current.error ? ` — ${current.error}` : ''}`;
      output.textContent = [...current.progress.map(value => JSON.stringify(value)), ...(current.state === 'completed' ? [JSON.stringify(current.result)] : [])].join('\n');
      if (current.state !== 'running') break;
      await new Promise(resolve => window.setTimeout(resolve, 100)); if (ended) return;
      const next = await jobs<OwnedJob>({ op: 'poll', job }); if (ended) return;
      if (!next.ok) { status.textContent = next.error.code; return; } current = next.value;
    }
  }
  const cancel = button('Cancel owned job', () => { if (job) void jobs({ op: 'cancel', job }); });
  const revoke = button('Revoke tool authorization', () => { if (handle) void jobs({ op: 'grant', allow: false }); });
  const exit = button('Close tool', close);
  const actions = document.createElement('div'); actions.className = 'extension-context-consent'; actions.append(start, cancel, revoke, exit);
  panel.append(heading, disclosure, fields, status, output, actions);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !isImeKey(event)) { event.stopPropagation(); close(); } });
  const unsubscribe = onExtensionChanged(id.split('/')[0], close); document.body.append(panel); start.focus(); return close;
}
