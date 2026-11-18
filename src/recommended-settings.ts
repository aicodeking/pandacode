import { escape, icon, showsHtml } from './dom';
import { recommendations, recommendationSummary, type Recommendation, type RecommendationFacts } from './settings-recommendations';

function rowHtml(item: Recommendation): string {
  const verb = item.done === null ? 'Open' : item.done ? 'Review' : 'Set up';
  const state = item.done === null ? '' : item.done
    ? `<span class="recommended-state ds-success">${icon('check')}Set</span>`
    : '<span class="recommended-state">Not set</span>';
  return `<div class="setting-row recommended-row" data-recommendation="${item.id}"><div><strong>${escape(item.title)}</strong><small>${escape(item.why)}</small></div><div class="recommended-actions">${state}<button type="button" class="secondary-button" data-section="${item.page}"${item.fold ? ` data-fold="${escape(item.fold)}"` : ''} aria-label="${verb}: ${escape(item.title)}">${verb}</button></div></div>`;
}

/** Settings' first page. It draws what it knows at once, then the statuses that need asking for; `refresh` runs each time
 * the page is shown again, so a setting just changed elsewhere reads correctly on the way back. */
export function mountRecommended(host: HTMLElement, known: () => RecommendationFacts, ask: () => Promise<Partial<RecommendationFacts>>): { refresh(): void; dispose(): void } {
  let ticket = 0;
  let answers: Partial<RecommendationFacts> = {};
  const draw = (): void => {
    const list = recommendations({ ...known(), ...answers });
    const group = (items: Recommendation[]) => `<div class="settings-group">${items.map(rowHtml).join('')}</div>`;
    const html = `<p class="recommended-summary" role="status">${recommendationSummary(list)}</p>${group(list.filter(item => !item.optional))}<h3 class="settings-heading">When you need them</h3>${group(list.filter(item => item.optional))}`;
    if (!showsHtml(host, html)) host.innerHTML = html;
  };
  const refresh = (): void => {
    const mine = ++ticket;
    draw();
    void ask().then(next => { if (mine === ticket) { answers = next; draw(); } });
  };
  refresh();
  return { refresh, dispose: () => { ticket++; host.replaceChildren(); } };
}
