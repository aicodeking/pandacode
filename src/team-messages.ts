import './team-messages.css';
import { call } from './bridge';
import { t } from './i18n.ts';
import type { TeamMessagePage, TeamSnapshot } from './architect-types';

/** Fetch coordination only while expanded, using team events rather than timers. */
export class TeamMessages {
  readonly host = document.createElement('details');
  private list = document.createElement('ol');
  private status = document.createElement('p');
  private more = document.createElement('button');
  private team: TeamSnapshot;
  private cursor = 0;
  private loadedRevision = -1;
  private busy = false;
  private hasMore = false;
  private failed = false;
  private disposed = false;

  constructor(team: TeamSnapshot) {
    this.team = team;
    this.host.className = 'team-messages';
    const summary = document.createElement('summary'); summary.textContent = t('Team messages');
    this.list.setAttribute('aria-label', t('Messages between teammates'));
    this.status.className = 'team-messages-status'; this.status.setAttribute('role', 'status');
    this.more.type = 'button'; this.more.className = 'secondary-button'; this.more.hidden = true;
    this.host.append(summary, this.list, this.status, this.more);
    this.host.addEventListener('toggle', () => { if (this.host.open) void this.load(); });
    this.more.addEventListener('click', () => { void this.load(true); });
  }

  update(team: TeamSnapshot): void {
    if (this.disposed || team.sessionId !== this.team.sessionId) return;
    this.team = team;
    if (this.host.open && !this.hasMore && !this.failed) void this.load();
  }

  destroy(): void { this.disposed = true; }

  private name(id: string): string {
    if (id === 'architect') return t('Architect');
    const index = this.team.workers.findIndex(worker => worker.id === id);
    return index < 0 ? t('Worker') : this.team.workers[index].name || t`Worker ${index + 1}`;
  }

  private async load(force = false): Promise<void> {
    if (this.disposed || this.busy || !force && (this.hasMore || this.loadedRevision >= this.team.revision)) return;
    this.busy = true; this.failed = false; this.more.disabled = true;
    const revision = this.team.revision;
    this.status.textContent = this.cursor ? '' : t('Loading team messages…');
    try {
      const page = await call<TeamMessagePage>('architect_team_messages', { sessionId: this.team.sessionId, afterId: this.cursor, limit: 50 });
      if (this.disposed) return;
      const fragment = document.createDocumentFragment();
      for (const message of page.messages) {
        if (message.id <= this.cursor) continue;
        const row = document.createElement('li'); row.dataset.teamMessageId = String(message.id);
        const heading = document.createElement('div'); heading.className = 'team-message-heading';
        const route = document.createElement('strong'); route.textContent = t`${this.name(message.sender)} → ${this.name(message.recipient)}`;
        const time = document.createElement('time'); time.dateTime = new Date(message.createdAt).toISOString();
        time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const body = document.createElement('p'); body.textContent = message.message;
        heading.append(route, time); row.append(heading, body); fragment.append(row);
      }
      this.list.append(fragment);
      this.cursor = page.nextCursor; this.hasMore = page.hasMore; this.loadedRevision = revision;
      this.status.textContent = this.cursor ? '' : t('No messages yet. Teammates can share questions and handoffs here.');
      this.more.hidden = !this.hasMore; this.more.textContent = t('More messages');
    } catch {
      if (this.disposed) return;
      this.failed = true;
      this.status.textContent = t('Couldn’t load team messages.');
      this.more.textContent = t('Retry'); this.more.hidden = false;
    } finally {
      this.busy = false; this.more.disabled = false;
      if (!this.disposed && this.host.open && !this.failed && !this.hasMore && this.team.revision > revision) void this.load();
    }
  }
}
