import './subagents.css';
import { call } from './bridge';
import { icon } from './dom';
import { t } from './i18n.ts';
import { showPopover, hidePopover } from './popover-motion';
import { streamMarkdown } from './streaming-markdown';
import { bindFileLinkContext, refreshFileLinks, type FileLinkContext } from './file-links';
import { renderToolActivity } from './tool-activity';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import type { SubagentActivity } from './types';

type Entry = { value: SubagentActivity; revision: number; number: number };
type Task = { agents: Map<string, Entry>; loading: boolean; error: boolean; request: number; nextNumber: number };
const active = (agent: SubagentActivity) => agent.status === 'running' || agent.status === 'waiting';
const statusName = (agent: SubagentActivity) => ({ running: t('Working'), waiting: t('Waiting'), completed: t('Completed'), failed: t('Failed'), stopped: t('Stopped') })[agent.status];
function agentName(entry: Entry): string {
  const name = entry.value.name.trim();
  return name && !/[\\/]/.test(name) && !/^(?:subagent|agent)$/i.test(name) ? name : `#${entry.number}`;
}

function decode(value: unknown): SubagentActivity | undefined {
  if (!value || typeof value !== 'object') return;
  const a = value as SubagentActivity;
  if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || typeof a.response !== 'string' || !['running', 'waiting', 'completed', 'failed', 'stopped'].includes(a.status)) return;
  return { id: a.id.slice(0, 512), parentId: typeof a.parentId === 'string' ? a.parentId.slice(0, 512) : null,
    name: a.name.slice(0, 256), prompt: String(a.prompt ?? '').slice(0, 4096), status: a.status, response: a.response.slice(0, 65536),
    startedAt: Number(a.startedAt) || 0, updatedAt: Number(a.updatedAt) || 0,
    tools: (Array.isArray(a.tools) ? a.tools : []).slice(-16).filter(tool => tool && typeof tool.id === 'string' && typeof tool.name === 'string' && ['running', 'completed', 'failed'].includes(tool.status)).map(tool => ({ id: tool.id.slice(0, 1024), name: tool.name.slice(0, 256), status: tool.status, input: String(tool.input ?? '').slice(0, 4096), output: String(tool.output ?? '').slice(0, 8192) })) };
}

/** Only the selected child's response is formatted. Background snapshots never touch the transcript. */
export class Subagents {
  private tasks = new Map<string, Task>();
  private sessionId = '';
  private revision = 0;
  private frame = 0;
  private panel?: HTMLElement;
  private selected = '';
  private visible = true;
  private trigger: HTMLButtonElement;
  private rows = new Map<string, HTMLButtonElement>();
  private renderedTools = '';

  constructor(private host: HTMLElement, private panelId = 'subagents-panel', private fileContext?: (sessionId: string) => FileLinkContext | undefined) {
    host.innerHTML = `<button type="button" class="subagents-trigger" aria-label="${t('Subagents')}" aria-expanded="false" aria-controls="subagents-panel" title="${t('View subagent work')}" hidden>${icon('branch')}<span></span>${icon('chevron')}</button>`;
    this.trigger = host.querySelector('button')!;
    this.trigger.setAttribute('aria-controls', panelId);
    this.trigger.addEventListener('click', () => this.panel ? this.close() : this.open());
    bindMessageActions(host, {
      content: (sessionId, key) => {
        const separator = key.indexOf(':');
        const agent = this.tasks.get(sessionId)?.agents.get(key.slice(separator + 1))?.value;
        return key.startsWith('prompt:') ? agent?.prompt : agent?.response;
      },
      report: error => {
        const notice = this.panel?.querySelector<HTMLElement>('.subagent-action-notice');
        if (notice) { notice.textContent = error instanceof Error ? error.message : String(error); notice.hidden = false; }
      },
    });
    // Capture Escape before the main task's stop shortcut or Board dismissal.
    document.addEventListener('keydown', event => {
      if (!this.panel || event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], .floating-menu[role="dialog"]:not([aria-hidden="true"])')) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.close();
    }, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.schedule(); });
  }

  private task(id: string): Task {
    let task = this.tasks.get(id);
    if (!task) { task = { agents: new Map(), loading: false, error: false, request: 0, nextNumber: 1 }; this.tasks.set(id, task); }
    return task;
  }

  setTask(id: string, visible: boolean): void {
    this.visible = visible; this.host.hidden = !visible || !id; dispatchEvent(new Event('pandacode:agents'));
    if (!visible) this.close(false);
    if (id !== this.sessionId) {
      this.close(false); this.sessionId = id;
      this.render();
      if (id) void this.load(id);
      this.prune();
    } else this.schedule();
  }

  receive(sessionId: string, value: unknown): void {
    const agent = decode(value); if (!agent) return;
    const task = this.task(sessionId);
    const previous = task.agents.get(agent.id)?.value;
    if (previous && active(previous) && !active(agent)) {
      const context = this.fileContext?.(sessionId); if (context) refreshFileLinks(context);
    }
    this.upsert(task, agent, ++this.revision);
    if (sessionId === this.sessionId) this.schedule();
    this.prune();
  }

  forget(id: string): void {
    const task = this.tasks.get(id); if (task) task.request++;
    this.tasks.delete(id);
    if (id === this.sessionId) this.setTask('', this.visible);
  }

  private upsert(task: Task, value: SubagentActivity, revision: number): void {
    if (!task.agents.has(value.id) && task.agents.size >= 64) {
      const old = [...task.agents].find(([, entry]) => !active(entry.value));
      if (!old) return;
      task.agents.delete(old[0]);
    }
    const number = task.agents.get(value.id)?.number ?? task.nextNumber++;
    task.agents.set(value.id, { value, revision, number });
  }

  private prune(): void {
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= 8) break;
      if (id !== this.sessionId && !task.loading && ![...task.agents.values()].some(entry => active(entry.value))) this.tasks.delete(id);
    }
  }

  private async load(id: string): Promise<void> {
    const task = this.task(id), request = ++task.request, revision = this.revision;
    task.loading = true; task.error = false;
    try {
      const snapshots = await call<unknown[]>('list_subagents', { sessionId: id });
      if (task.request !== request) return;
      const saved = (Array.isArray(snapshots) ? snapshots : []).map(decode).filter((agent): agent is SubagentActivity => Boolean(agent));
      saved.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      for (const agent of saved) {
        // A delayed history snapshot must never replace a newer live update.
        if ((task.agents.get(agent.id)?.revision ?? -1) <= revision) this.upsert(task, agent, revision);
      }
    } catch { if (task.request === request) task.error = true; }
    finally { if (task.request === request) task.loading = false; if (id === this.sessionId) this.schedule(); this.prune(); }
  }

  private schedule(): void {
    if (this.frame || document.hidden || !this.visible) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  async showAgent(agentId: string): Promise<void> {
    const taskId = this.sessionId;
    if (!taskId || !this.visible) return;
    await this.load(taskId);
    if (taskId !== this.sessionId || !this.visible) return;
    if (!this.task(taskId).agents.has(agentId)) throw new Error(t('This subagent is no longer available.'));
    this.open(); this.selected = agentId; this.render();
    this.panel?.querySelector<HTMLButtonElement>('.subagents-back')?.focus();
  }

  /** For the dock's Agents item: whether this task has subagents, how many run, and the panel. */
  get present(): boolean { return this.visible && Boolean(this.sessionId) && !this.trigger.hidden; }
  get running(): number { return [...this.tasks.get(this.sessionId)?.agents.values() ?? []].filter(entry => active(entry.value)).length; }
  get isOpen(): boolean { return Boolean(this.panel); }
  open(focus = true): void {
    if (this.panel || !this.sessionId) return;
    this.selected = ''; this.rows.clear();
    const panel = document.createElement('section');
    panel.id = this.panelId; panel.className = 'subagents-panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', t('Subagents'));
    panel.innerHTML = `<header class="subagents-heading"><button type="button" class="icon-button subagents-back" aria-label="${t('Back to Subagents')}" hidden>${icon('back')}</button><strong>${t('Subagents')}</strong><span class="subagents-summary"></span><button type="button" class="icon-button subagents-close" aria-label="${t('Close subagents')}">${icon('close')}</button></header><div class="subagents-body"><div class="subagents-list"></div><p class="subagents-notice" role="status" hidden></p><button class="secondary-button subagents-retry" hidden>${t('Retry loading subagents')}</button><div class="subagent-detail" hidden><div class="subagent-detail-meta"><span class="subagent-state"></span><h3 class="subagent-detail-name"></h3><span class="subagent-detail-status"></span></div><p class="subagent-parent" hidden></p><details class="subagent-assignment"><summary>${t('Assignment')}</summary><p></p></details><div class="subagent-response"></div><p class="subagent-empty muted"></p><div class="subagent-tools"></div></div></div>`;
    this.host.append(panel); this.panel = panel;
    panel.querySelector('.subagent-assignment')!.insertAdjacentHTML('beforeend', '<div class="subagent-assignment-actions"></div>');
    panel.querySelector('.subagent-response')!.insertAdjacentHTML('afterend', '<div class="subagent-response-actions"></div><p class="subagent-action-notice" role="status" hidden></p>');
    panel.querySelector('.subagents-close')!.addEventListener('click', () => this.close());
    panel.querySelector('.subagents-back')!.addEventListener('click', () => { const id = this.selected; this.selected = ''; this.render(); this.rows.get(id)?.focus(); });
    panel.querySelector('.subagents-retry')!.addEventListener('click', () => { void this.load(this.sessionId); this.render(); });
    this.trigger.setAttribute('aria-expanded', 'true');
    this.render(); showPopover(panel, this.trigger);
    if (focus) (panel.querySelector<HTMLButtonElement>('[data-subagent-id]') ?? panel.querySelector<HTMLButtonElement>('.subagents-close'))?.focus();
  }

  close(focus = true): void {
    if (!this.panel) return;
    hidePopover(this.panel); this.panel = undefined; this.selected = ''; this.rows.clear();
    this.trigger.setAttribute('aria-expanded', 'false');
    if (focus) this.trigger.focus({ preventScroll: true });
  }

  private render(): void {
    const task = this.tasks.get(this.sessionId);
    const agents = [...task?.agents.values() ?? []].map(entry => ({ ...entry.value, name: agentName(entry) }));
    const running = agents.filter(active).length;
    this.trigger.hidden = !agents.length && !task?.error;
    const label = running ? t`${running} running` : agents.length === 1 ? t`1 subagent` : agents.length ? t`${agents.length} subagents` : t('Subagents');
    const text = this.trigger.querySelector('span')!; if (text.textContent !== label) text.textContent = label;
    this.trigger.classList.toggle('has-running', running > 0);
    dispatchEvent(new Event('pandacode:agents'));
    this.trigger.title = running ? agents.filter(active).map(a => a.name).join('\n') : t('View subagent work');
    const panel = this.panel; if (!panel) return;
    const summary = panel.querySelector('.subagents-summary')!;
    if (summary.textContent !== label) summary.textContent = label;
    const detail = panel.querySelector<HTMLElement>('.subagent-detail')!, list = panel.querySelector<HTMLElement>('.subagents-list')!;
    const selected = agents.find(a => a.id === this.selected);
    list.hidden = Boolean(selected); detail.hidden = !selected;
    panel.querySelector<HTMLElement>('.subagents-back')!.hidden = !selected;
    const notice = panel.querySelector<HTMLElement>('.subagents-notice')!;
    notice.hidden = Boolean(selected) || (!task?.error && Boolean(agents.length));
    const note = task?.error ? t('Couldn’t load saved subagents. Live work will still appear here.') : task?.loading ? t('Loading subagents…') : t('No subagents in this task yet.');
    if (notice.textContent !== note) notice.textContent = note;
    panel.querySelector<HTMLElement>('.subagents-retry')!.hidden = !task?.error || Boolean(selected);
    if (!selected) {
      const ids = new Set(agents.map(a => a.id));
      for (const [id, row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
      for (const agent of agents) {
        let row = this.rows.get(agent.id);
        if (!row) {
          row = document.createElement('button'); row.type = 'button'; row.className = 'subagent-row'; row.dataset.subagentId = agent.id;
          row.innerHTML = `<span class="subagent-state"></span><span class="subagent-row-copy"><strong></strong><small></small></span><span class="subagent-row-status"></span>${icon('chevron')}`;
          row.addEventListener('click', () => {
            this.selected = agent.id; this.renderedTools = '';
            // Clear the previous child's response before its first streamed paint.
            const output = detail.querySelector<HTMLElement>('.subagent-response')!;
            if (this.fileContext) bindFileLinkContext(output, this.fileContext(this.sessionId));
            streamMarkdown(output, ''); detail.querySelector('.subagent-tools')!.replaceChildren();
            panel.querySelector<HTMLElement>('.subagents-body')!.scrollTop = 0;
            this.render(); panel.querySelector<HTMLButtonElement>('.subagents-back')!.focus();
          });
          this.rows.set(agent.id, row); list.append(row);
        }
        row.dataset.status = agent.status;
        const parent = agents.find(a => a.id === agent.parentId);
        const info = parent ? t`From ${parent.name}` : '';
        const name = row.querySelector('strong')!, description = row.querySelector('small')!, status = row.querySelector('.subagent-row-status')!;
        if (name.textContent !== agent.name) name.textContent = agent.name;
        if (description.textContent !== info) description.textContent = info;
        (description as HTMLElement).hidden = !info;
        if (status.textContent !== statusName(agent)) status.textContent = statusName(agent);
      }
      return;
    }
    detail.dataset.status = selected.status;
    if (detail.dataset.agentId !== selected.id) {
      detail.dataset.agentId = selected.id;
      detail.querySelector('.subagent-assignment-actions')!.innerHTML = messageActionsHtml(this.sessionId, `prompt:${selected.id}`, false);
      detail.querySelector('.subagent-response-actions')!.innerHTML = messageActionsHtml(this.sessionId, `response:${selected.id}`, false);
      detail.querySelector<HTMLElement>('.subagent-action-notice')!.hidden = true;
    }
    const setText = (selector: string, text: string) => { const target = detail.querySelector(selector)!; if (target.textContent !== text) target.textContent = text; };
    setText('.subagent-detail-name', selected.name); setText('.subagent-detail-status', statusName(selected));
    setText('.subagent-assignment p', selected.prompt);
    detail.querySelector<HTMLElement>('.subagent-assignment')!.hidden = !selected.prompt;
    const parent = agents.find(a => a.id === selected.parentId);
    setText('.subagent-parent', parent ? t`From ${parent.name}` : ''); detail.querySelector<HTMLElement>('.subagent-parent')!.hidden = !parent;
    const output = detail.querySelector<HTMLElement>('.subagent-response')!;
    if (this.fileContext) bindFileLinkContext(output, this.fileContext(this.sessionId));
    streamMarkdown(output, selected.response, panel.querySelector<HTMLElement>('.subagents-body')!);
    detail.querySelector<HTMLElement>('.subagent-response-actions')!.hidden = !selected.response;
    setText('.subagent-empty', selected.response ? '' : active(selected) ? t('Waiting for the first update…') : t('This harness did not provide a response for this agent.'));
    const serializedTools = JSON.stringify(selected.tools);
    if (this.renderedTools !== serializedTools) {
      const target = detail.querySelector('.subagent-tools')!;
      // Update only changed tool details, preserving open state, focus and scroll.
      const existing = new Map([...target.querySelectorAll<HTMLDetailsElement>('[data-tool-key]')].map(el => [el.dataset.toolKey!, el]));
      for (const tool of selected.tools) {
        const key = 'subagent-tool:' + tool.id, old = existing.get(key), html = renderToolActivity(tool, key);
        if (old?.dataset.snapshot !== JSON.stringify(tool)) {
          const template = document.createElement('template'); template.innerHTML = html;
          const next = template.content.firstElementChild as HTMLDetailsElement;
          next.dataset.snapshot = JSON.stringify(tool); next.open = old?.open ?? false;
          const raw = next.querySelector<HTMLDetailsElement>('.tool-trace-raw');
          if (raw) raw.open = Boolean(old?.querySelector<HTMLDetailsElement>('.tool-trace-raw')?.open);
          const focusedIndex = old ? [...old.querySelectorAll('summary, pre')].findIndex(control => control === document.activeElement) : -1;
          const positions = old ? [...old.querySelectorAll('pre')].map(pre => ({ top: pre.scrollTop, left: pre.scrollLeft })) : [];
          if (old) old.replaceWith(next); else target.append(next);
          next.querySelectorAll('pre').forEach((pre, i) => { pre.scrollTop = positions[i]?.top ?? 0; pre.scrollLeft = positions[i]?.left ?? 0; });
          if (focusedIndex >= 0) (next.querySelectorAll<HTMLElement>('summary, pre')[focusedIndex] ?? next.querySelector('summary'))?.focus({ preventScroll: true });
        }
        existing.delete(key);
      }
      for (const old of existing.values()) old.remove();
      this.renderedTools = serializedTools;
    }
  }
}
