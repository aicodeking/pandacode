/* Settings → Memory: the shared shelf. Local notes, scoped to a project or to
 * every project; search, add, edit and delete here. Injection is off until the
 * switch is on. The IPC contract is `memory-api.ts`. */
import './memory-settings.css';
import { escape, icon } from './dom';
import { memoryApi, scopeLabel, type MemoryNote, type MemoryScope, type MemoryStats } from './memory-api.ts';
import { memoryDefault, setMemoryDefault } from './memory.ts';
import { trackSegment } from './motion';

export interface MemorySettingsOptions {
  projects: { id: string; name: string }[];
}

const SEARCH_DELAY = 150;
const LIST_LIMIT = 50;

const when = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function mountMemorySettings(host: HTMLElement, options: MemorySettingsOptions): () => void {
  host.classList.add('memory-settings');
  let notes: MemoryNote[] = [];
  let scopes: MemoryScope[] = [];
  let stats: MemoryStats | null = null;
  let query = '';
  let filter = '';
  let enabled = memoryDefault();
  let editing: number | null = null;
  let editText = '';
  let draft = '';
  let confirming: number | null = null;
  let busy = false;
  let error = '';
  let notice = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const scopeOptions = () => {
    const known = new Map<string, string>();
    known.set('user', 'All projects');
    for (const project of options.projects) known.set(`project:${project.id}`, project.name);
    for (const scope of scopes) if (!known.has(scope.scope)) known.set(scope.scope, scopeLabel(scope.scope, options.projects));
    return [...known.entries()];
  };

  function render(): void {
    const selected = scopeOptions().find(([id]) => id === filter)?.[0] ?? '';
    const addScope = selected && selected !== 'user' ? selected : 'user';
    host.innerHTML = `
      <div class="settings-group memory-intro">
        <div class="setting-row memory-switch-row">
          <div><strong>Memory Fabric</strong><small>Shared notes every thread and harness can use. Local only, off until you turn it on, and never sent as instructions.</small></div>
          <input type="checkbox" role="switch" class="ds-toggle" data-memory-toggle aria-label="Memory Fabric" ${enabled ? 'checked' : ''}>
        </div>
        <p class="memory-note">${enabled ? 'On: a small block rides with your next message when the shelf changes, then every 8 messages.' : 'Off: nothing is sent, read or written automatically.'}</p>
      </div>
      <form class="memory-add" data-memory-add>
        <label for="memory-new">Remember a fact, decision or gotcha</label>
        <textarea id="memory-new" data-memory-input rows="2" maxlength="4000" placeholder="We use pnpm, not npm. CI runs on Windows and macOS."></textarea>
        <div class="memory-add-row">
          <label class="memory-scope-label" for="memory-scope">Scope</label>
          <select id="memory-scope" data-memory-scope>${scopeOptions().map(([id, label]) => `<option value="${escape(id)}"${id === addScope ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>
          <button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>Remember</button>
        </div>
        <p class="memory-count">${stats ? `${stats.total} note${stats.total === 1 ? '' : 's'} across ${stats.scopes} scope${stats.scopes === 1 ? '' : 's'}` : 'Loading…'}${stats?.updatedAt ? ` · last change ${when(stats.updatedAt)}` : ''}</p>
        ${error ? `<p class="memory-error" role="alert">${escape(error)}</p>` : ''}
        ${notice ? `<p class="memory-notice" role="status">${escape(notice)}</p>` : ''}
      </form>
      <div class="memory-browse">
        <div class="memory-browse-head">
          <h3 class="settings-heading">Notes</h3>
          <input type="search" data-memory-search value="${escape(query)}" placeholder="Search notes" aria-label="Search memory notes">
        </div>
        <div class="ds-seg memory-filters" role="group" aria-label="Filter by scope">
          <button type="button" data-memory-filter="" aria-pressed="${filter === ''}">All</button>
          ${scopes.map(scope => `<button type="button" data-memory-filter="${escape(scope.scope)}" aria-pressed="${filter === scope.scope}">${escape(scopeLabel(scope.scope, options.projects))} <small>${scope.count}</small></button>`).join('')}
        </div>
        <div class="memory-list">${notes.length ? notes.map(row).join('') : '<p class="memory-empty">No notes here yet.</p>'}</div>
        ${notes.length >= LIST_LIMIT ? '<p class="memory-note">Showing the newest notes. Narrow the search to see older ones.</p>' : ''}
      </div>`;
    trackSegment(host.querySelector<HTMLElement>('.memory-filters')!, host.querySelector<HTMLElement>('.memory-filters [aria-pressed="true"]'));
    host.querySelector<HTMLInputElement>('[data-memory-toggle]')!.checked = enabled;
    host.querySelector<HTMLTextAreaElement>('#memory-new')!.value = draft;
    host.querySelector<HTMLInputElement>('[data-memory-search]')!.value = query;
  }

  function row(note: MemoryNote): string {
    const isEditing = editing === note.id;
    const isConfirming = confirming === note.id;
    const body = isEditing
      ? `<textarea class="memory-edit" data-memory-edit="${note.id}" rows="3" maxlength="4000">${escape(editText)}</textarea>
         <div class="memory-row-actions"><button type="button" class="secondary-button" data-memory-save="${note.id}">Save</button><button type="button" class="secondary-button" data-memory-cancel>Cancel</button></div>`
      : `<p class="memory-content">${escape(note.content)}</p>
         <div class="memory-meta"><span class="memory-scope">${escape(scopeLabel(note.scope, options.projects))}</span><span>${escape(note.source)}</span><span>${when(note.updatedAt)}</span>${note.hits ? `<span>used ${note.hits}×</span>` : ''}</div>
         <div class="memory-row-actions">${isConfirming
           ? `<span class="memory-confirm">Delete this note?</span><button type="button" class="secondary-button memory-danger" data-memory-delete="${note.id}">Delete</button><button type="button" class="secondary-button" data-memory-cancel>Cancel</button>`
           : `<button type="button" class="icon-button" data-memory-edit-start="${note.id}" aria-label="Edit note" title="Edit">${icon('edit')}</button><button type="button" class="icon-button" data-memory-ask-delete="${note.id}" aria-label="Delete note" title="Delete">${icon('trash')}</button>`}</div>`;
    return `<article class="memory-row${isEditing ? ' memory-row-editing' : ''}" data-memory-row="${note.id}">${body}</article>`;
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    try {
      const [nextNotes, nextScopes, nextStats] = await Promise.all([
        memoryApi.recall({ scope: filter || undefined, query: query || undefined, limit: LIST_LIMIT, mark: false }),
        memoryApi.scopes(),
        memoryApi.stats(),
      ]);
      if (current !== generation) return;
      notes = nextNotes; scopes = nextScopes; stats = nextStats;
      error = '';
    } catch (cause) {
      if (current !== generation) return;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    render();
  }

  host.addEventListener('change', onChange);
  host.addEventListener('input', onInput);
  host.addEventListener('click', onClick);
  host.addEventListener('submit', onSubmit);
  render();
  void refresh();
  return () => {
    clearTimeout(timer);
    host.removeEventListener('change', onChange);
    host.removeEventListener('input', onInput);
    host.removeEventListener('click', onClick);
    host.removeEventListener('submit', onSubmit);
    host.replaceChildren();
  };

  function onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-memory-toggle]')) {
      enabled = target.checked;
      setMemoryDefault(enabled);
      notice = enabled ? 'Memory Fabric is on. Notes ride with your next message.' : 'Memory Fabric is off. Nothing is sent.';
      render();
    }
  }

  function onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.matches('[data-memory-search]')) {
      query = target.value;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), SEARCH_DELAY);
    } else if (target.matches('[data-memory-edit]')) {
      editText = target.value;
    } else if (target.matches('[data-memory-input]')) {
      draft = target.value;
    }
  }

  async function onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-memory-add]') || busy) return;
    const input = form.querySelector<HTMLTextAreaElement>('[data-memory-input]')!;
    const scope = form.querySelector<HTMLSelectElement>('[data-memory-scope]')!;
    const content = input.value.trim();
    if (!content) { error = 'Write the note you want to remember.'; render(); return; }
    busy = true; error = ''; notice = '';
    try {
      await memoryApi.remember({ scope: scope.value, content });
      draft = '';
      notice = filter || query ? 'Remembered. It may be outside the current filter.' : 'Remembered.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    busy = false;
    await refresh();
  }

  async function onClick(event: MouseEvent): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-memory-filter],[data-memory-edit-start],[data-memory-ask-delete],[data-memory-delete],[data-memory-save],[data-memory-cancel]');
    if (!target) return;
    const filterValue = target.dataset.memoryFilter;
    if (filterValue !== undefined) {
      filter = filterValue; error = ''; await refresh(); return;
    }
    const editId = target.dataset.memoryEditStart;
    if (editId) {
      const note = notes.find(item => item.id === Number(editId));
      if (!note) return;
      editing = note.id; editText = note.content; confirming = null; render();
      host.querySelector<HTMLTextAreaElement>('[data-memory-edit]')?.focus();
      return;
    }
    const askId = target.dataset.memoryAskDelete;
    if (askId) { confirming = Number(askId); editing = null; render(); return; }
    if (target.dataset.memoryCancel !== undefined) { editing = null; confirming = null; render(); return; }
    const saveId = target.dataset.memorySave;
    if (saveId) {
      if (!editText.trim()) { error = 'Write the note you want to keep.'; render(); return; }
      try { await memoryApi.update(Number(saveId), editText); editing = null; error = ''; notice = 'Note updated.'; await refresh(); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
      return;
    }
    const deleteId = target.dataset.memoryDelete;
    if (deleteId) {
      try { await memoryApi.forget(Number(deleteId)); confirming = null; notice = 'Note deleted.'; await refresh(); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
    }
  }
}
