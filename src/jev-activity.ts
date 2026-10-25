import './jev-activity.css';
import { call, subscribe } from './bridge';
import { t } from './i18n.ts';
import { icon } from './dom';
import type { JevReport } from './jev';

/** A small live entry point shared by conversation and board detail views. */
export class JevActivity {
  private task = '';
  private revision = 0;
  private report?: Pick<JevReport, 'id' | 'createdAt' | 'status' | 'verification'>;
  readonly host = document.createElement('div');
  constructor() {
    this.host.className = 'jev-activity'; this.host.hidden = true;
    this.host.innerHTML = `<button type="button" class="secondary-button" data-action="jev-tests" aria-label="${t('Open Jev browser test reports')}">${icon('spark')}<span></span>${icon('chevron')}</button>`;
    void subscribe('jev-run', report => {
      if (report.sessionId !== this.task) return;
      this.revision++;
      this.accept(report);
    }).catch(() => { /* Optional browser status must never prevent app startup. */ });
  }
  setTask(task: string): void {
    if (task === this.task) return;
    this.task = task; this.report = undefined; this.host.hidden = true;
    const revision = ++this.revision;
    if (!task) return;
    void call<JevReport[]>('jev_list_runs', { sessionId: task }).then(reports => {
      if (revision !== this.revision || !reports.length) return;
      this.accept(reports[0]);
    }).catch(() => { /* Test history must never block opening a conversation. */ });
  }
  private accept(report: JevReport): void {
    if (this.report && report.createdAt < this.report.createdAt) return;
    this.report = { id: report.id, createdAt: report.createdAt, status: report.status, verification: report.verification };
    const working = report.status === 'starting' || report.status === 'running';
    const label = working ? t('Testing app…') : report.verification === 'failed' ? t('Checks failed') : report.verification === 'passed' ? t('Checks passed') : report.status === 'done' ? t('Agent finished') : report.status === 'cancelled' ? t('Test stopped') : t('Test needs attention');
    this.host.querySelector('span')!.textContent = t`Jev · ${label}`;
    this.host.dataset.working = String(working); this.host.hidden = false;
  }
}
