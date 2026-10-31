/** Usage limits hit by a task's run: the composer banner and when a limit counts as current. */
import { t } from './i18n.ts';
import { escape, icon } from './dom';
import type { Session } from './types';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** A limit is current until its reset passes; one with an unknown reset stays until resolved. */
export function limitActive(task: Pick<Session, 'limitedAt' | 'limitedUntil'>, now = Date.now()): boolean {
  return Boolean(task.limitedAt) && (task.limitedUntil == null || task.limitedUntil > now);
}

export function resetLabel(until: number | null | undefined, now = Date.now()): string {
  if (!until) return t('Reset time not reported');
  const sameDay = new Date(until).toDateString() === new Date(now).toDateString();
  return t`Resets ${(sameDay ? time : day).format(until)}`;
}

/** Banner above the composer for a limited task that is not running. `alternatives` are the
 *  harness's other named connections, offered as Continue on <name> (never automatic). */
export function limitBanner(task: Session, now = Date.now(), alternatives: { id: string; name: string }[] = []): string {
  if (!task.limitedAt) return '';
  const passed = task.limitedUntil != null && task.limitedUntil <= now;
  const status = passed ? t('The usage limit has reset') : t`Usage limit reached · ${resetLabel(task.limitedUntil, now)}`;
  const toggle = task.limitedUntil && !passed
    ? `<label class="limit-resume"><input type="checkbox" class="limit-resume-switch" ${task.resumeAtReset ? 'checked' : ''}><span>${t('Resume at reset')}</span></label>` : '';
  return `<section class="limit-banner" aria-label="${t('Usage limit')}" data-passed="${passed}">${icon('alert')}<span class="limit-status" role="status">${escape(status)}</span>${toggle}
    <button type="button" class="limit-continue" data-action="limit-continue">${t('Continue now')}</button>${passed ? '' : alternatives.map(c => `<button type="button" class="limit-continue" data-action="limit-switch" data-connection="${escape(c.id)}">${t`Continue on ${escape(c.name)}`}</button>`).join('')}<button type="button" class="icon-button" data-action="limit-dismiss" aria-label="${t('Dismiss usage limit')}" title="${t('Dismiss')}">${icon('close')}</button></section>`;
}
