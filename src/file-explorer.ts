import './file-explorer.css';
import { escape, isImeKey } from './dom';
import type { openChoiceMenu } from './choice-menu';

type Context = { projectId: string; sessionId?: string };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  menu(options: Omit<Parameters<typeof openChoiceMenu>[0], 'onClose'>): void;
  modal(title: string, body: string): HTMLDialogElement;
  closeModal(): void;
  open(path: string, context: Context): Promise<void>;
  changed(context: Context, path: string, next?: string): void;
  hasChanges(context: Context, path: string): boolean;
  created(context: Context, parent: string): void;
  refresh(): Promise<void>;
  notify(text: string): void;
  report(error: unknown): void;
  /** The computer a task's files are on when it is not this one: they are only browsed, by path. */
  remoteName?(context: Context): string | undefined;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createFileExplorer(deps: Deps) {
  let refreshing = false;
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try { await deps.refresh(); } finally { refreshing = false; }
  }
  function edit(context: Context, action: string, path: string, directory: boolean): void {
    if (deps.remoteName?.(context)) return;
    const name = path.split('/').pop() ?? '';
    const deleting = action === 'delete', renaming = action === 'rename';
    const title = deleting ? `Delete ${name}?` : renaming ? 'Rename' : action === 'new-folder' ? 'New folder' : 'New file';
    const dialog = deps.modal(title, `<form class="explorer-form">${deleting ? `<p class="dialog-description">This permanently deletes ${escape(path)}${directory ? ' and all its contents' : ''}.</p>` : `<label class="field-label" for="explorer-name">Name</label><input id="explorer-name" name="name" value="${renaming ? escape(name) : ''}" required autocomplete="off" spellcheck="false" maxlength="255">`}<p role="alert" class="ds-danger" hidden></p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="primary-button${deleting ? ' danger' : ''}">${deleting ? 'Delete permanently' : renaming ? 'Rename' : 'Create'}</button></div></form>`);
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector<HTMLInputElement>('input');
    input?.select();
    form.addEventListener('keydown', event => { if (event.key === 'Enter' && isImeKey(event)) { event.preventDefault(); event.stopPropagation(); } });
    form.addEventListener('submit', event => {
      event.preventDefault(); event.stopPropagation();
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      if (submit.disabled) return;
      void (async () => {
        submit.disabled = true;
        try {
          if ((deleting || renaming) && deps.hasChanges(context, path)) throw new Error('Save or discard unsaved edits in this file or folder first.');
          const value = (input?.value ?? '').trim();
          if (!deleting && (!value || /[/\\:\0]/.test(value) || value === '.' || value === '..' || value.toLowerCase() === '.git')) throw new Error('Enter a single file or folder name.');
          const parent = renaming || deleting ? path : directory ? path : path.split('/').slice(0, -1).join('/');
          const target = renaming || deleting ? path : [parent, value].filter(Boolean).join('/');
          const next = await deps.call<string>('manage_workspace_entry', { ...context, action, path: target, ...(renaming ? { name: value } : {}) });
          if (deleting || renaming) deps.changed(context, path, deleting ? undefined : next);
          if (!deleting && !renaming) deps.created(context, parent);
          if (form.isConnected && dialog.open) deps.closeModal();
          await refresh();
          if (action === 'new-file') await deps.open(target, context);
          deps.notify(deleting ? 'Deleted' : renaming ? 'Renamed' : 'Created');
        } catch (error) {
          const alert = form.querySelector<HTMLElement>('[role="alert"]')!;
          alert.textContent = message(error); alert.hidden = false;
        } finally { submit.disabled = false; }
      })();
    });
  }
  function menu(anchor: HTMLElement, context: Context, path: string, directory: boolean, point?: { x: number; y: number }): void {
    // Another computer's files: nothing to create, rename, reveal or open here; the path is the project's own.
    const remote = deps.remoteName?.(context);
    if (remote) {
      deps.menu({ anchor, point, title: path.split('/').pop() || 'Project files', actions: true, items: [
        { id: 'copy-path', label: 'Copy Path', description: `Relative to the project on ${remote}`, icon: 'copy' },
      ], onSelect: async () => { await navigator.clipboard.writeText(path); deps.notify('Path copied'); } });
      return;
    }
    deps.menu({ anchor, point, title: path.split('/').pop() || 'Project files', actions: true, items: [
      { id: 'new-file', label: 'New File', icon: 'file' },
      { id: 'new-folder', label: 'New Folder', icon: 'folder' },
      ...(path ? [{ id: 'rename', label: 'Rename', icon: 'edit', separator: true }, { id: 'delete', label: 'Delete', icon: 'trash', danger: true }] : []),
      { id: 'copy-path', label: 'Copy Path', icon: 'copy', separator: true },
      { id: 'reveal', label: 'Reveal in OS', icon: 'folder' },
      ...(!directory ? [{ id: 'open-external', label: 'Open in Default App', icon: 'external' }] : []),
    ], onSelect: async action => {
      if (['copy-path', 'reveal', 'open-external'].includes(action)) {
        if (action === 'open-external') { await deps.call('open_workspace_file', { ...context, path }); return; }
        const absolute = await deps.call<string>('manage_workspace_entry', { ...context, action: 'path', path });
        if (action === 'reveal') await deps.call('reveal_path', { path: absolute });
        else { await navigator.clipboard.writeText(absolute); deps.notify('Path copied'); }
      } else edit(context, action, path, directory);
    } });
  }
  window.setInterval(() => { if (!document.hidden) void refresh().catch(deps.report); }, 2000);
  window.addEventListener('focus', () => { void refresh().catch(deps.report); });
  return { menu, edit };
}
