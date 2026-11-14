import './jev-activity.css';
import { call, subscribe } from './bridge';
import { icon } from './dom';
import type { JevReport } from './jev';
import { statusChanged } from './extensions/status-state';

export type JevActivityState = 'none' | 'testing' | 'passed' | 'failed' | 'finished' | 'stopped' | 'attention';

/** A small live entry point shared by conversation and board detail views. */
export class JevActivity {
  private task = '';
  private revision = 0;
  private report?: Pick<JevReport, 'id' | 'createdAt' | 'status' | 'verification'>;
  readonly host = document.createElement('div');
  constructor() {
    this.host.className = 'jev-activity'; this.host.hidden = true;
    this.host.innerHTML = `<button type="button" class="secondary-button" data-action="jev-tests" aria-label="Open Jev browser test reports">${icon('spark')}<span></span>${icon('chevron')}</button>`;
    void subscribe('jev-run', report => {
      if (report.sessionId !== this.task) return;
      this.revision++;
      this.accept(report);
    }).catch(() => { /* Optional browser status must never prevent app startup. */ });
  }
  setTask(task: string): void {
    if (task === this.task) return;
    this.task = task; this.report = undefined; this.host.hidden = true; statusChanged();
    const revision = ++this.revision;
    if (!task) return;
    void call<JevReport[]>('jev_list_runs', { sessionId: task }).then(reports => {
      if (revision !== this.revision || !reports.length) return;
      this.accept(reports[0]);
    }).catch(() => { /* Test history must never block opening a conversation. */ });
  }
  /** Host-only state for presentation adoption (docs/extensions/status.md): the task and a status, never the report. */
  status(): { task: string; shown: boolean; state: JevActivityState } {
    const report = this.report;
    const state: JevActivityState = !report ? 'none' : report.status === 'starting' || report.status === 'running' ? 'testing' : report.verification === 'failed' ? 'failed' : report.verification === 'passed' ? 'passed' : report.status === 'done' ? 'finished' : report.status === 'cancelled' ? 'stopped' : 'attention';
    return { task: this.task, shown: !this.host.hidden && this.host.isConnected, state };
  }
  private accept(report: JevReport): void {
    if (this.report && report.createdAt < this.report.createdAt) return;
    this.report = { id: report.id, createdAt: report.createdAt, status: report.status, verification: report.verification };
    const working = report.status === 'starting' || report.status === 'running';
    const label = working ? 'Testing app…' : report.verification === 'failed' ? 'Checks failed' : report.verification === 'passed' ? 'Checks passed' : report.status === 'done' ? 'Agent finished' : report.status === 'cancelled' ? 'Test stopped' : 'Test needs attention';
    this.host.querySelector('span')!.textContent = `Jev · ${label}`;
    this.host.dataset.working = String(working); this.host.hidden = false;
    statusChanged();
  }
}
