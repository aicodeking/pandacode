import './skill-picker.css';
import { escape } from './dom';
import { infoMark } from './tooltip';
import type { SlashCommand } from './slash-commands';

/** Chooses enabled harness skills for the current task, without sending a turn. */
export function mountSkillPicker(host: HTMLElement, options: {
  load(force: boolean): Promise<{ commands: SlashCommand[]; warnings: string[] }>;
  select(skill: SlashCommand): void;
  manage(): void;
}): () => void {
  host.className = 'skill-picker';
  host.innerHTML = `<p class="dialog-description">Choose a skill, then send your message when ready.</p><input type="search" class="skill-picker-search" role="combobox" aria-label="Search skills" aria-autocomplete="list" aria-expanded="true" autocomplete="off" spellcheck="false" placeholder="Search skills…"><div class="skill-picker-list" role="listbox" aria-label="Available skills" id="skill-list-${crypto.randomUUID()}"></div><p class="skill-picker-status" role="status">Loading available skills…</p><p class="skill-picker-warning" hidden></p><p class="skill-picker-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="secondary-button" data-skill-manage>Manage skills…</button><button type="button" class="secondary-button" data-skill-refresh>Refresh</button></div>`;
  const search = host.querySelector<HTMLInputElement>('input')!;
  const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
  const status = host.querySelector<HTMLElement>('[role="status"]')!;
  const warning = host.querySelector<HTMLElement>('.skill-picker-warning')!;
  const error = host.querySelector<HTMLElement>('[role="alert"]')!;
  const refresh = host.querySelector<HTMLButtonElement>('[data-skill-refresh]')!;
  const dialog = host.closest('dialog');
  search.setAttribute('aria-controls', list.id);
  let skills: SlashCommand[] = [], shown: SlashCommand[] = [], active = 0, revision = 0, disposed = false, loading = false;
  function mark(index: number): void {
    active = index;
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    rows.forEach((row, n) => row.setAttribute('aria-selected', String(n === index)));
    const row = rows[index];
    if (row) { search.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  }
  function render(): void {
    const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = skills.filter(skill => words.every(word => `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(word)));
    shown = matches.slice(0, 100);
    list.innerHTML = shown.map((skill, index) => {
      const description = `${skill.description}${skill.source ? ` · ${skill.source}` : ''}`;
      const detail = `${list.id}-detail-${index}`;
      return `<button type="button" class="skill-picker-option" role="option" id="${list.id}-option-${index}" data-skill-index="${index}" aria-label="${escape(skill.name.replace(/^\//, ''))}" aria-describedby="${detail}" aria-selected="false" tabindex="-1" ${loading ? 'disabled' : ''}><span>${escape(skill.name.replace(/^\//, ''))}</span><span class="sr-only" id="${detail}">${escape(description)}</span>${infoMark(description, `About ${skill.name}`)}</button>`;
    }).join('');
    mark(0);
    status.textContent = loading ? 'Loading available skills…' : !skills.length ? 'No enabled skills found. Enable a skill for this agent in Manage skills, then refresh.' : !shown.length ? 'No skills match your search.' : `${matches.length} skill${matches.length === 1 ? '' : 's'}${matches.length > shown.length ? ' · Search to narrow the list' : ''}`;
    refresh.disabled = loading;
    list.setAttribute('aria-busy', String(loading));
  }
  async function load(force: boolean): Promise<void> {
    if (disposed || loading) return;
    const ticket = ++revision;
    loading = true; error.hidden = true; render();
    try {
      const result = await options.load(force);
      if (disposed || ticket !== revision) return;
      const available = result.commands.filter(skill => skill.skill === true && skill.kind === 'prompt');
      const names = new Set(available.map(skill => skill.name));
      skills = available.filter(skill => !skill.name.startsWith('/skills:') || !names.has(`/${skill.name.slice('/skills:'.length)}`));
      warning.textContent = result.warnings.join(' '); warning.hidden = !warning.textContent;
    } catch (reason) { if (!disposed) { error.textContent = `Could not load skills. ${String(reason)}`; error.hidden = false; } }
    finally { if (!disposed && ticket === revision) { loading = false; render(); } }
  }
  function choose(index: number): void {
    if (disposed || loading || !shown[index]) return;
    try { options.select(shown[index]); }
    catch (reason) { error.textContent = String(reason); error.hidden = false; }
  }
  const click = (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (target?.dataset.skillIndex !== undefined) choose(Number(target.dataset.skillIndex));
    else if (target?.hasAttribute('data-skill-refresh')) void load(true);
    else if (target?.hasAttribute('data-skill-manage')) options.manage();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== search || event.isComposing || loading) return;
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && shown.length) {
      event.preventDefault();
      mark(event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : (active + (event.key === 'ArrowUp' ? -1 : 1) + shown.length) % shown.length);
    } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); choose(active); }
  };
  const input = () => render();
  const dispose = () => { disposed = true; ++revision; host.removeEventListener('click', click); host.removeEventListener('keydown', keydown); search.removeEventListener('input', input); dialog?.removeEventListener('close', dispose); };
  host.addEventListener('click', click); host.addEventListener('keydown', keydown); search.addEventListener('input', input);
  dialog?.addEventListener('close', dispose);
  search.focus(); void load(true);
  return dispose;
}
