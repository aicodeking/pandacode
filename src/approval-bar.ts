import './approval-bar.css';
import { t } from './i18n.ts';
import { escape, icon } from './dom';

/* Pending approvals sit in one slim bar directly above the prompt: a single request is one
 * line with Deny and Approve; several are grouped into one line that expands to a line each. */

export type PendingApproval = { id: string; text: string };

/** The request's first meaningful line, without Markdown code ticks, for a one-line summary. */
export function approvalSummary(text: string): string {
  const line = text.split('\n').map(part => part.replace(/`+/g, '').trim()).find(Boolean) ?? t('Approval needed');
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

function actions(id: string, busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  return `<span class="approval-actions"><button type="button" class="approval-deny" data-action="approval-deny" data-request="${escape(id)}" ${disabled}>${t('Deny')}</button><button type="button" class="approval-allow" data-action="approval-allow" data-request="${escape(id)}" ${disabled}>${t('Approve')}</button></span>`;
}

function row(approval: PendingApproval, busy: boolean, open: boolean): string {
  const summary = approvalSummary(approval.text), full = approval.text.trim();
  const more = full !== summary;
  return `<li class="approval-row${open ? ' is-open' : ''}" data-approval="${escape(approval.id)}">
    <div class="approval-line">${icon('lock', 'approval-mark')}${more
      ? `<button type="button" class="approval-summary" data-action="approval-details" data-request="${escape(approval.id)}" aria-expanded="${open}" title="${escape(full)}">${escape(summary)}</button>`
      : `<span class="approval-summary" title="${escape(full)}">${escape(summary)}</span>`}${actions(approval.id, busy)}</div>
    ${more && open ? `<pre class="approval-full">${escape(full)}</pre>` : ''}
  </li>`;
}

export function approvalBarHtml(approvals: PendingApproval[], options: { busy: (id: string) => boolean; expanded: boolean; details: Set<string> }): string {
  if (!approvals.length) return '';
  if (approvals.length === 1) {
    const [only] = approvals;
    return `<section class="approval-bar" aria-label="${t('Approval needed')}"><ul class="approval-list">${row(only, options.busy(only.id), options.details.has(only.id))}</ul></section>`;
  }
  const busy = approvals.some(approval => options.busy(approval.id));
  return `<section class="approval-bar is-group${options.expanded ? ' is-expanded' : ''}" aria-label="${t`${approvals.length} approvals needed`}">
    <div class="approval-line approval-group">${icon('lock', 'approval-mark')}<button type="button" class="approval-summary" data-action="approval-group" aria-expanded="${options.expanded}"><strong>${t`${approvals.length} approvals needed`}</strong><span>${escape(approvalSummary(approvals[0].text))}${approvals.length > 1 ? t` and ${approvals.length - 1} more` : ''}</span>${icon('chevron', 'approval-chevron')}</button>
      <span class="approval-actions"><button type="button" class="approval-deny" data-action="approval-deny-all" ${busy ? 'disabled' : ''}>${t('Deny all')}</button><button type="button" class="approval-allow" data-action="approval-allow-all" ${busy ? 'disabled' : ''}>${t('Approve all')}</button></span></div>
    ${options.expanded ? `<ul class="approval-list">${approvals.map(approval => row(approval, options.busy(approval.id), options.details.has(approval.id))).join('')}</ul>` : ''}
  </section>`;
}
