import { call } from './bridge';
import { icon } from './dom';

export interface RunContext { projectId: string; sessionId?: string }
export interface RunScript { path: string; previewUrl?: string; previewPath?: string }
const key = (context: RunContext) => `${context.projectId}:${context.sessionId ?? ''}`;

/** Availability is refreshed on task selection/completion, never on streamed tokens. */
export class ProjectRunner {
  private scripts = new Map<string, RunScript | null>();
  private revisions = new Map<string, number>();
  private starting = new Set<string>();
  private previewRevisions = new Map<string, number>();
  private exits = new Map<string, () => boolean>();
  constructor(private options: {
    context(): RunContext | undefined;
    start(requestId?: string): Promise<() => boolean>;
    navigate(url: string, context: RunContext): Promise<void>;
    notify(message: string): void;
  }) { window.addEventListener('pandacode:terminal-exit', () => this.paint()); }
  available(context = this.options.context()): boolean { return Boolean(context && this.scripts.get(key(context))); }
  /** The Run terminal's script is up: from its start until it exits or its tab closes. */
  running(context = this.options.context()): boolean { return Boolean(context && this.exits.get(key(context))?.() === false); }
  paint(): void {
    const context = this.options.context(), available = this.available(context);
    const busy = Boolean(context && this.starting.has(key(context))), running = !busy && this.running(context);
    document.querySelectorAll<HTMLButtonElement>('[data-action="run-project"]').forEach(button => {
      button.hidden = !available || Boolean(button.dataset.sessionId && button.dataset.sessionId !== context?.sessionId);
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      button.toggleAttribute('data-running', running);
      if (running) button.setAttribute('aria-description', 'Running'); else button.removeAttribute('aria-description');
      const label = busy ? 'Starting…' : 'Run';
      if (button.dataset.label !== label) { button.innerHTML = `${icon('play')}<span>${label}</span>`; button.dataset.label = label; }
    });
  }
  async refresh(context = this.options.context()): Promise<void> {
    if (!context) { this.paint(); return; }
    const id = key(context), revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    // Malformed or removed scripts should not leave a stale launch affordance.
    const script = await call<RunScript | null>('get_run_script', { ...context }).catch(() => null);
    if (this.revisions.get(id) !== revision) return;
    this.scripts.set(id, script); this.paint();
  }
  async run(requestId?: string, active?: () => Promise<void>): Promise<{ started: boolean; previewPending: boolean }> {
    const context = this.options.context();
    if (!context) throw new Error('Open a project to run it.');
    const id = key(context);
    if (this.starting.has(id)) return { started: false, previewPending: true };
    this.starting.add(id); this.paint();
    try {
      const script = await call<RunScript | null>('get_run_script', { ...context });
      if (!script) throw new Error('Add pandacode-run.sh to this checkout to run the project.');
      this.scripts.set(id, script);
      await active?.();
      if (key(this.options.context() ?? { projectId: '' }) !== id) throw new Error('Task changed before the script could start.');
      const exited = await this.options.start(requestId);
      this.exits.set(id, exited);
      const revision = (this.previewRevisions.get(id) ?? 0) + 1;
      this.previewRevisions.set(id, revision);
      const hasPreview = Boolean(script.previewUrl || script.previewPath);
      if (hasPreview) void this.openWhenReady(context, revision, exited);
      return { started: true, previewPending: hasPreview };
    } finally { this.starting.delete(id); this.paint(); }
  }
  private async openWhenReady(context: RunContext, revision: number, exited: () => boolean): Promise<void> {
    const id = key(context);
    const current = () => this.previewRevisions.get(id) === revision && key(this.options.context() ?? { projectId: '' }) === id;
    // Dev servers can take a few seconds; poll a bounded native readiness check,
    // with no cross-origin browser fetch, no reload loop, and no task switching.
    for (let attempt = 0; attempt < 30 && current(); attempt++) {
      let url: string | null;
      try { url = await call<string | null>('get_run_script_preview', { ...context }); }
      catch (error) { if (current()) this.options.notify(String(error)); return; }
      if (!current()) return;
      if (url) { try { await this.options.navigate(url, context); } catch (error) { if (current()) this.options.notify(String(error)); } return; }
      if (exited()) { this.options.notify('The script exited before its preview was available. Check the Run terminal.'); return; }
      await new Promise(resolve => setTimeout(resolve, Math.min(250 + attempt * 100, 1000)));
    }
    if (current()) this.options.notify('The script is running. Preview is not ready yet; click Run to check again.');
  }
}
