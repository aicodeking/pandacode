// Living reference for the design-system primitives (src/design-system.css). Preview only:
// main.ts loads it when the browser preview runs with `?ds`. It covers the main pane so every
// primitive shows over the real panel surface in dark, light and over a wallpaper.
import './gallery.css';
import { icon, escape } from '../dom';
import { trackSegment } from '../motion';
import { openChoiceMenu } from '../choice-menu';
import { infoMark } from '../tooltip';

const row = (lead: string, title: string, opts: { sub?: string; subClass?: string; trail?: string; tag?: 'div' | 'button'; dot?: string; dim?: boolean } = {}): string => {
  const tag = opts.tag ?? 'div';
  return `<${tag}${tag === 'button' ? ' type="button"' : ''} class="ds-row${opts.dim ? ' ds-row-dim' : ''}"><span class="ds-row-icon">${icon(lead)}${opts.dot ? `<span class="ds-dot ${opts.dot}"></span>` : ''}</span><span class="ds-row-main"><span class="ds-row-title">${escape(title)}</span>${opts.sub ? `<span class="ds-row-sub ${opts.subClass ?? ''}">${escape(opts.sub)}</span>` : ''}</span>${opts.trail ? `<span class="ds-row-trail">${opts.trail}</span>` : ''}</${tag}>`;
};
const iconButton = (name: string, label: string): string => `<button type="button" class="icon-button" aria-label="${escape(label)}">${icon(name)}</button>`;
const toggle = (label: string, on: boolean): string => `<input type="checkbox" role="switch" class="ds-toggle" aria-label="${escape(label)}"${on ? ' checked' : ''}>`;

// `?ds=source`: the reference screenshot (/tmp/redesign/reference2.png) rebuilt from the primitives only,
// at its proportions (the image is ~1.45x CSS px), so every area can be compared with it side by side.
const glyph = (paths: string): string => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const G = {
  mic: glyph('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  gauge: glyph('<path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0"/><path d="m12 13 3.5-4"/>'),
  sliders: glyph('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  schedule: glyph('<path d="M20 11V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h4M4 10h16M8 3v4M16 3v4"/><circle cx="16.5" cy="16.5" r="4"/><path d="M16.5 14.8v1.9l1.2.8"/>'),
  steer: glyph('<path d="M6 4v7a3 3 0 0 0 3 3h10m-4-4 4 4-4 4"/>'),
  checkCircle: glyph('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.3 4.6-5"/>'),
  stopFill: '<span class="ds-src-stop" aria-hidden="true"></span>',
  collapse: glyph('<path d="M3.5 20.5 10 14M10 19.5V14H4.5M20.5 3.5 14 10M14 4.5V10h5.5"/>'),
  up: glyph('<path d="M7 17 17 7M9 7h8v8"/>'),
  terminal: glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="m7.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5h3.5"/>'),
};
const btn = (inner: string, label: string, cls = 'icon-button'): string => `<button type="button" class="${cls}" aria-label="${escape(label)}">${inner}</button>`;

function sourceMarkup(): string {
  const check = (title: string, meta: string): string => `<button type="button" class="ds-row"><span class="ds-row-icon ds-success">${G.checkCircle}</span><span class="ds-row-main"><span class="ds-row-title">${escape(title)}</span></span><span class="ds-row-trail"><span class="ds-row-meta ds-src-faint">${escape(meta)}</span>${icon('chevron')}</span></button>`;
  return `<div class="ds-src-col ds-src-left">
      <div class="ds-src-bubble">…ntext strip into a tray under the composer and drop the PR chip.</div>
      <div class="ds-src-turn"><span class="ds-success">+84</span><span class="ds-danger">−22</span><span class="ds-dots" aria-hidden="true"><span class="ds-success"></span><span class="ds-success"></span><span class="ds-success"></span><span class="ds-danger"></span><span></span></span></div>
      <hr class="ds-src-rule">
      <p class="ds-src-text">…lives in the tray: branch and machine on the left, model and permissions on the right.</p>
      <div class="ds-card ds-src-composer">
        <div class="ds-src-steer">${btn(icon('edit'), 'Edit queued message')}<button type="button" class="ds-src-steer-btn">${G.steer}Steer</button>${btn(icon('close'), 'Discard')}</div>
        <div class="ds-card-inner ds-src-input"><span class="ds-src-ph">Ask for follow-up changes, @ files, / commands</span>${btn(icon('attach'), 'Attach')}<span class="ds-src-pill">${btn(G.mic, 'Dictate')}${btn(G.stopFill, 'Stop')}</span></div>
        <div class="ds-src-tray"><button type="button">${icon('spark')}GPT-6 Astra</button><button type="button">${G.gauge}High</button><button type="button">${icon('unlock')}Full access</button></div>
      </div>
    </div>
    <div class="ds-src-col ds-src-mid">
      <div class="ds-card">
        <div class="ds-card-inner">
          ${row('server', 'build-box', { tag: 'button', trail: icon('down') })}
          ${row('branch', 'maria/composer-tray', { trail: btn(icon('upload'), 'Push branch') })}
          ${row('pull', '#1234 Composer tray', { tag: 'button', sub: '2 checks failing', subClass: 'ds-danger', trail: `<span class="ds-link">Fix${G.up}</span>` }).replace('ds-row-icon', 'ds-row-icon ds-success')}
          ${row('terminal', 'dev', { dot: 'ds-success', trail: `${btn(icon('square'), 'Stop dev')}${icon('down')}` }).replace(icon('terminal'), G.terminal)}
        </div>
        <div class="ds-card-foot"><span class="ds-row-icon">${G.gauge}</span><span>Context</span><span class="ds-meter" role="meter" aria-label="Context used" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100"><span style="--ds-value:26%"></span><span style="--ds-value:9%"></span><span style="--ds-value:4%"></span></span><span class="ds-row-meta">42%</span>${btn(G.collapse, 'Compact context', 'ds-btn ds-btn-icon')}</div>
      </div>
      <section class="ds-card"><div class="ds-section-head"><h2>Automations</h2>${btn(G.sliders, 'Automation settings')}</div>
        <div class="ds-card-inner">
          ${row('clock', 'Nightly typecheck', { sub: 'Daily at 2:00 AM', dot: 'ds-success', trail: `${btn(icon('play'), 'Run now')}${toggle('Nightly typecheck', true)}` }).replace(icon('clock'), G.schedule)}
          ${row('clock', 'Dependency bump', { sub: 'Running for 1m', subClass: 'ds-info', dot: 'ds-info', trail: `${btn(icon('square'), 'Stop')}${toggle('Dependency bump', true)}` }).replace(icon('clock'), G.schedule)}
          ${row('clock', 'Weekly cleanup', { sub: 'Paused', dim: true, trail: `${btn(icon('play'), 'Run now')}${toggle('Weekly cleanup', false)}` }).replace(icon('clock'), G.schedule)}
        </div></section>
      <section class="ds-card"><div class="ds-section-head"><h2>Lineage</h2><span class="ds-row-meta">2 running</span>${btn(icon('more'), 'Lineage actions')}</div>
        <div class="ds-card-inner">${row('back', 'Composer redesign', { tag: 'button', sub: 'Parent thread · Opus 4.8', trail: G.up })}${row('branch', 'Composer tray redesign', { tag: 'button', sub: 'Child thread', trail: G.up })}</div></section>
    </div>
    <div class="ds-src-col ds-src-right">
      <h1 class="ds-title">Move the composer context row into a tray</h1>
      <div class="ds-src-meta"><span class="ds-avatar" style="--ds-avatar:var(--ds-src-avatar)">M</span><span class="ds-src-author">maria</span><span class="ds-src-faint">2h ago</span><span class="ds-src-chips"><span class="ds-chip">main</span>${icon('back')}<span class="ds-chip">maria/composer-tray</span></span></div>
      <div class="ds-seg" role="tablist" aria-label="Pull request view"><button type="button" role="tab" aria-selected="true">Summary</button><button type="button" role="tab" aria-selected="false">Guide</button><button type="button" role="tab" aria-selected="false">Timeline</button><button type="button" role="tab" aria-selected="false">Code</button></div>
      <div class="ds-card ds-src-checks">
        ${check('All checks passed', '4 of 4')}${check('Approved by julius', '1 of 1 required')}${check('No conflicts with main', 'squash · 3 commits')}
        <div class="ds-src-merge"><div class="ds-btn-split"><button type="button" class="ds-btn-primary">${icon('merge')}Squash and merge</button><button type="button" class="ds-btn-primary" data-ds-menu aria-label="Merge options" aria-haspopup="menu">${icon('down')}</button></div></div>
      </div>
      <div class="ds-src-desc-head"><h2>Description</h2>${icon('chevron')}${btn(icon('edit'), 'Edit description')}</div>
      <p class="ds-src-body">Moves branch, model, effort and permission controls out of the composer and into a tray under it, so the input keeps one clean line.</p>
      <p class="ds-src-closes">Closes #13094</p>
      <div class="ds-src-desc-head"><h2>Attachments <span class="ds-src-faint">3</span></h2></div>
    </div>`;
}

function markup(theme: string, wallpaper: boolean): string {
  return `<div class="ds-gallery-bar"><h1 class="ds-title">Design system</h1>
    <div class="ds-seg ds-gallery-theme" role="group" aria-label="Theme"><button type="button" data-ds-theme="dark" aria-pressed="${theme === 'dark'}">Dark</button><button type="button" data-ds-theme="light" aria-pressed="${theme === 'light'}">Light</button></div>
    <label class="ds-gallery-wall">${toggle('Wallpaper', wallpaper).replace('class="ds-toggle"', 'class="ds-toggle" data-ds-wallpaper')}<span>Wallpaper</span></label></div>
  <div class="ds-gallery-grid">
    <div class="ds-gallery-col">
      <div class="ds-card">
        ${row('server', 'build-box', { tag: 'button', trail: icon('down') })}
        ${row('branch', 'maria/composer-tray', { trail: iconButton('upload', 'Push branch') })}
        ${row('pull', '#1234 Composer tray', { tag: 'button', sub: '2 checks failing', subClass: 'ds-danger', trail: `<span class="ds-row-meta ds-danger">Fix ↗</span>` })}
        ${row('terminal', 'dev', { dot: 'ds-success', trail: `${iconButton('square', 'Stop dev')}${icon('down')}` })}
        <div class="ds-row"><span class="ds-row-icon">${icon('clock')}</span><span class="ds-row-title">Context</span><span class="ds-meter" role="meter" aria-label="Context used" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100"><span style="--ds-value:28%"></span><span style="--ds-value:8%"></span><span style="--ds-value:6%"></span></span><span class="ds-row-meta">42%</span>${iconButton('minimize', 'Compact context')}</div>
      </div>
      <section class="ds-section"><div class="ds-section-head"><h2>Automations</h2>${iconButton('settings', 'Automation settings')}</div>
        <div class="ds-card"><div class="ds-card-inset">
          ${row('clock', 'Nightly typecheck', { sub: 'Daily at 2:00 AM', dot: 'ds-success', trail: `${iconButton('play', 'Run now')}${toggle('Nightly typecheck', true)}` })}
          ${row('clock', 'Dependency bump', { sub: 'Running for 1m', subClass: 'ds-info', dot: 'ds-info', trail: `${iconButton('square', 'Stop')}${toggle('Dependency bump', true)}` })}
          ${row('clock', 'Weekly cleanup', { sub: 'Paused', dim: true, trail: `${iconButton('play', 'Run now')}${toggle('Weekly cleanup', false)}` })}
        </div></div></section>
      <section class="ds-section"><div class="ds-section-head"><h2>Lineage</h2><span class="ds-row-meta">2 running</span>${iconButton('more', 'Lineage actions')}</div>
        <div class="ds-card">${row('back', 'Composer redesign', { tag: 'button', sub: 'Parent thread · Opus 4.8', trail: icon('external') })}</div></section>
    </div>
    <div class="ds-gallery-col">
      <h2 class="ds-title">Move the composer context row into a tray</h2>
      <div class="ds-gallery-chips"><span class="ds-chip">main</span>${icon('back')}<span class="ds-chip">maria/composer-tray</span><span class="ds-chip ds-chip-text">${icon('branch')}chip-text</span></div>
      <div class="ds-seg ds-gallery-tabs" role="tablist" aria-label="Pull request view"><button type="button" role="tab" aria-selected="true">Summary</button><button type="button" role="tab" aria-selected="false">Guide</button><button type="button" role="tab" aria-selected="false">Timeline</button><button type="button" role="tab" aria-selected="false">Code</button></div>
      <div class="ds-card">
        ${row('check', 'All checks passed', { tag: 'button', trail: `<span class="ds-row-meta">4 of 4</span>${icon('chevron')}` }).replace('ds-row-icon', 'ds-row-icon ds-success')}
        ${row('check', 'Approved by julius', { tag: 'button', trail: `<span class="ds-row-meta">1 of 1 required</span>${icon('chevron')}` }).replace('ds-row-icon', 'ds-row-icon ds-success')}
        ${row('check', 'No conflicts with main', { tag: 'button', trail: `<span class="ds-row-meta">squash · 3 commits</span>${icon('chevron')}` }).replace('ds-row-icon', 'ds-row-icon ds-success')}
        <div class="ds-gallery-pad"><div class="ds-btn-split"><button type="button" class="ds-btn-primary">${icon('merge')}Squash and merge</button><button type="button" class="ds-btn-primary" data-ds-menu aria-label="Merge options" aria-haspopup="menu">${icon('down')}</button></div></div>
      </div>
      <section class="ds-section"><div class="ds-section-head"><h2>Buttons and status</h2></div>
        <div class="ds-card"><div class="ds-gallery-pad ds-gallery-wrap">
          <button type="button" class="ds-btn">${icon('edit')}Secondary</button><button type="button" class="ds-btn ds-btn-icon" aria-label="Copy">${icon('copy')}</button>
          <button type="button" class="primary-button">.primary-button</button><button type="button" class="secondary-button">.secondary-button</button>${iconButton('settings', 'Icon button')}
          <span class="ds-success"><span class="ds-dot"></span> success</span><span class="ds-danger"><span class="ds-dot"></span> danger</span><span class="ds-info"><span class="ds-dot"></span> info</span><span class="ds-warn"><span class="ds-dot"></span> warn</span>
        </div>
        <div class="ds-gallery-pad ds-gallery-wrap"><input type="text" placeholder="Text field" aria-label="Text field"><select aria-label="Select"><option>Select</option></select><label class="ds-gallery-wall"><input type="checkbox" checked> Checkbox</label><span>Tooltip ${infoMark('Tooltips use the floating glass.', 'Hover hint')}</span></div></div></section>
    </div>
  </div>`;
}

export function mountGallery(): void {
  const pane = document.querySelector<HTMLElement>('.main-pane');
  if (!pane || pane.querySelector('.ds-gallery')) return;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  let wallpaper = true;
  try { wallpaper = localStorage.getItem('pandacode.wallpapers') !== 'false'; } catch { /* Default on. */ }
  const source = new URLSearchParams(location.search).get('ds') === 'source';
  const host = document.createElement('div');
  host.className = source ? 'ds-gallery ds-source' : 'ds-gallery';
  host.innerHTML = source ? sourceMarkup() : markup(theme, wallpaper);
  pane.append(host);
  for (const group of host.querySelectorAll<HTMLElement>('.ds-seg')) trackSegment(group, group.querySelector('[aria-selected="true"],[aria-pressed="true"]'));
  host.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('.ds-gallery-tabs>[role=tab]');
    if (tab) {
      for (const other of tab.parentElement!.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
      trackSegment(tab.parentElement!, tab);
    }
    const choice = target.closest<HTMLElement>('[data-ds-theme]');
    if (choice) { localStorage.setItem('pandacode.theme', choice.dataset.dsTheme!); location.reload(); }
    const menu = target.closest<HTMLElement>('[data-ds-menu]');
    if (menu) openChoiceMenu({ anchor: menu, title: 'Merge options', items: [{ id: 'squash', label: 'Squash and merge', icon: 'merge', description: '3 commits', selected: true }, { id: 'merge', label: 'Merge commit', icon: 'pull' }, { id: 'rebase', label: 'Rebase and merge', icon: 'branch', description: 'linear' }], onSelect: () => undefined, onClose: () => menu.focus() });
  });
  host.querySelector<HTMLInputElement>('[data-ds-wallpaper]')?.addEventListener('change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    localStorage.setItem('pandacode.wallpapers', String(enabled));
    localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ ...JSON.parse(localStorage.getItem('pandacode.wallpaperPreferences') || '{}'), enabled }));
    location.reload();
  });
}
