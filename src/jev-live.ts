import './jev-live.css';
import { call, subscribe } from './bridge';
import { t } from './i18n.ts';
import { escape, icon } from './dom';
import { errorText } from './error-text';
import type { JevReport } from './jev';

export interface JevFrame {
  sessionId: string; runId: string; sequence: number; dataUrl: string;
  width: number; height: number; elapsedMs: number;
}
export interface JevLiveView {
  watch(runId?: string): Promise<void>;
  url(): string | undefined;
  refresh(): void;
  leave(): void;
  close(): Promise<void>;
}
type Options = { session(): string | undefined; changed(watching: boolean, available: boolean): void; returned(): void };
const active = (report?: JevReport) => report?.status === 'starting' || report?.status === 'running';
const statuses: Record<JevReport['status'], string> = { starting: t('Starting browser'), running: t('Testing'), done: t('Finished'), blocked: t('Blocked'), failed: t('Test failed'), cancelled: t('Cancelled'), limit: t('Limit reached') };
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;
function validImage(value: unknown, live = false): value is string {
  return typeof value === 'string' && value.length <= (live ? 350_000 : 2_800_000)
    && (live ? /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/ : /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).test(value);
}

/** A read-only view of Jev's isolated Chrome, with one ephemeral frame in memory. */
export async function mountJevLive(host: HTMLElement, options: Options): Promise<JevLiveView> {
  host.className = 'jev-live'; host.hidden = true;
  host.setAttribute('role', 'region'); host.setAttribute('aria-label', t('Jev live browser'));
  host.innerHTML = `<header class="jev-live-heading"><span class="jev-live-mark">${icon('spark')}</span><strong>Jev</strong><span class="jev-live-status" role="status"></span><button type="button" class="jev-live-stop" data-jev-live-stop>${icon('stop')}${t('Stop test')}</button><button type="button" class="browser-tool" data-jev-live-return aria-label="${t('Return to browser')}" title="${t('Return to browser')}">${icon('back')}</button></header>
    <div class="jev-live-run-picker" hidden><select aria-label="${t('Jev run')}"></select>${icon('down')}</div>
