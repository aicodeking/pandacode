import { call } from '../bridge';
import { isImeKey } from '../dom';
import { onExtensionChanged } from './manager';
import { createContextClient, type ContextReply, type SummaryPage, type ContextResource } from './context-state';
import type { Json } from './contracts';
import { projectReadControls } from './project-reads';

/** Nonmodal host surface: navigation remains available, but queries never read active context. */
export function openProjectContext(id: string, version: string, context: Record<string, Json>, trigger: HTMLElement, onClose?: () => void): () => void {
  const existing = document.querySelector<HTMLElement>('.extension-context-inspector');
  if (existing) { existing.querySelector<HTMLButtonElement>('button')?.focus(); return () => {}; }
  const client = createContextClient(id, version, context, request => call<ContextReply>('extensions_context', { request }));
  const panel = document.createElement('section'); panel.className = 'extension-context-inspector ds-card';
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Project context inspector');
  panel.innerHTML = '<div class="dialog-heading"><h2>Project context</h2><button type="button" class="ds-btn" aria-label="Close project context">Close</button></div><p class="extension-context-scope"></p><p>Read-only summaries · access is for this project and launch only.</p><div class="extension-context-consent"></div><div class="extension-context-output ds-card-inner" aria-live="polite"></div><div class="extension-context-navigation"></div>';
  const scope = panel.querySelector<HTMLElement>('.extension-context-scope')!, output = panel.querySelector<HTMLElement>('.extension-context-output')!;
  scope.textContent = `Captured project: ${typeof context.projectId === 'string' ? context.projectId : 'none'}`;
  const owner = document.createElement('p'); owner.textContent = `Extension: ${id.split('/')[0]}`; scope.after(owner);
  const consent = panel.querySelector<HTMLElement>('.extension-context-consent')!, navigation = panel.querySelector<HTMLElement>('.extension-context-navigation')!;
  let ended = false, page: SummaryPage | undefined, resource: ContextResource = 'projects', pending = 0;
  let stopWatching: (() => void) | undefined;
  const streamState = document.createElement('p'); streamState.className = 'extension-context-stream'; streamState.setAttribute('role', 'status'); output.after(streamState);
  const stopStream = () => { stopWatching?.(); stopWatching = undefined; streamState.textContent = ''; };
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'ds-btn'; node.textContent = label;
    node.addEventListener('click', action); parent.append(node); return node;
  };
  function show(result: ContextReply<SummaryPage>): void {
    if (ended || !panel.isConnected || !result.ok && result.error.code === 'Cancelled') return;
    output.replaceChildren();
    if (!result.ok) { output.textContent = result.error.code; page = undefined; return; }
    page = result.value;
    const meta = document.createElement('p'); meta.textContent = `Schema ${page.schemaVersion} · revision ${page.revision} · ${page.state}`; output.append(meta);
    if (!page.items.length) { const empty = document.createElement('p'); empty.textContent = page.state === 'NoProject' ? 'No project selected at invocation.' : resource === 'tasks' ? 'No authorized tasks in this project.' : 'No authorized inventory items in this project.'; output.append(empty); }
    if (resource === 'harnesses') { const note = document.createElement('p'); note.textContent = 'Last host discovery observation; inventory never probes, prompts, installs or updates tools. Capabilities describe host adapters, not access grants.'; output.append(note); }
    for (const item of page.items) {
      const row = document.createElement('p');
      row.textContent = item.installed ? `${item.name} · ${item.installed} · version ${item.version ?? 'Unknown'} · host capabilities: ${item.capabilities?.join(', ')}` : item.authentication ? `${item.name} (${item.id}) · ${item.status} · authentication ${item.authentication} · ${item.capabilities?.join(', ')}` : item.name !== undefined ? `${item.name} (${item.id})` : `${item.id} · ${item.status}`;
      output.append(row);
    }
  }
  async function query(next = false): Promise<void> {
    stopStream();
    const current = ++pending; output.textContent = 'Loading captured context…';
    const result = await client.query(resource, next && page ? { cursor: page.nextCursor ?? 0, revision: page.revision } : {});
    if (!ended && current === pending) { show(result); nextButton.disabled = !result.ok || result.value.nextCursor === null; }
  }
  function watch(): void {
    stopStream(); const current = ++pending; output.textContent = 'Loading captured context…';
    stopWatching = client.watch(resource, result => {
      if (ended || pending !== current) return;
      if (!result.ok) { show(result); streamState.textContent = ['Timeout', 'HostUnavailable'].includes(result.error.code) ? 'Reconnecting granted stream…' : 'Subscription closed'; return; }
      if (result.value.snapshot) { show({ ok: true, value: result.value.snapshot }); nextButton.disabled = result.value.snapshot.nextCursor === null; }
      streamState.textContent = `${result.value.resync ? 'Resynced snapshot' : 'Watching granted stream'}${result.value.events.length ? ` · ${result.value.events.map(event => `${event.kind}: ${event.id} ${event.status}`).join(' · ')}` : ''}`;
    });
  }
  for (const [capability, label, target] of [['projects.summary', 'project summaries', 'projects'], ['tasks.summary', 'task summaries', 'tasks'], ['harnesses.inventory', 'harness inventory', 'harnesses'], ['connections.summary', 'connection summaries', 'connections'], ['jobs.summary', 'owned-job summaries', 'jobs']] as const) {
    for (const allow of [true, false]) button(consent, `${allow ? 'Allow' : 'Revoke'} ${label}`, () => {
      stopStream();
      const current = ++pending; output.textContent = allow ? 'Updating access…' : 'PermissionDenied'; page = undefined; nextButton.disabled = true;
      void client.consent(capability, allow).then(result => {
        if (ended || pending !== current) return;
        if (!result.ok) { show(result); return; }
        resource = target; if (allow && !['projects', 'tasks'].includes(resource)) watch(); else void query();
      });
    });
  }
  button(navigation, 'Refresh project summaries', () => { resource = 'projects'; void query(); });
  button(navigation, 'Refresh task summaries', () => { resource = 'tasks'; void query(); });
  for (const target of ['harnesses', 'connections', 'jobs'] as const) button(navigation, `Watch ${target}`, () => { resource = target; watch(); });
  const nextButton = button(navigation, 'Next page', () => { if (page?.nextCursor !== null) void query(true); }); nextButton.disabled = true;
  const disposeReads = projectReadControls(client, panel);
  const close = () => {
    if (ended) return; ended = true; pending++; stopStream(); disposeReads(); client.dispose(); unsubscribe(); panel.remove();
    if (panel.contains(document.activeElement) || document.activeElement === document.body) {
      const target = trigger.isConnected && trigger.checkVisibility() ? trigger : document.querySelector<HTMLElement>('#prompt:not([disabled])'); target?.focus({ preventScroll: true });
    }
    onClose?.();
  };
  const unsubscribe = onExtensionChanged(id.split('/')[0], close);
  panel.querySelector('button')!.addEventListener('click', close);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !isImeKey(event)) { event.stopPropagation(); close(); } });
  document.body.append(panel); panel.querySelector('button')!.focus(); void query();
  return close;
}
