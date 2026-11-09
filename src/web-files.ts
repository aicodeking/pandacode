export type WebFileGrant = { grant: string; name: string; directory?: boolean };
const grantNames = new Map<string, string>();
export function webFileName(path: string): string | undefined { return grantNames.get(path); }
function remember(grant: WebFileGrant): WebFileGrant {
  if (typeof grant.grant !== 'string' || typeof grant.name !== 'string') throw new Error('Invalid host file grant');
  grantNames.set(grant.grant, grant.name);
  while (grantNames.size > 512) grantNames.delete(grantNames.keys().next().value!);
  return grant;
}
const LIMIT = 64 * 1024 * 1024;
const CSRF_PREFIX = 'pandacode_csrf=';
const csrf = () => { const value = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(CSRF_PREFIX)); return value ? decodeURIComponent(value.slice(CSRF_PREFIX.length)) : ''; };
const basename = (name: string) => name.split(/[\\/]/).pop()!.replace(/[\u0000]/g, '').slice(0, 255) || 'upload';

export class WebFiles {
  private readonly base = new URL('/api/pandacode/files/', location.href);
  private async request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController(); const timeoutMs = init.headers && String(new Headers(init.headers).get('content-type')) === 'application/octet-stream' ? 120000 : 15000; const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', signal: controller.signal, headers: { ...init.headers, 'x-csrf-token': csrf() } });
      if (!response.ok) throw new Error(`File gateway request failed (${response.status})`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty file gateway response');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('File gateway response exceeds limit'); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) { throw controller.signal.aborted ? new Error('File gateway request timed out') : error; } finally { window.clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
  }
  roots(): Promise<{ id: string; label: string }[]> { return this.request(new URL('roots', this.base)); }
  list(root: string, path = '', signal?: AbortSignal, cursor?: string): Promise<{ root: string; path: string; entries: { name: string; path: string; directory: boolean; size?: number }[]; hasMore?: boolean; nextCursor?: string }> {
    const url = new URL('list', this.base); url.searchParams.set('root', root); url.searchParams.set('path', path); if (cursor) url.searchParams.set('cursor', cursor); return this.request(url, { signal });
  }
  select(root: string, path: string, kind: 'folder' | 'file', purpose: 'project' | 'attachment' | 'theme' | 'executable' | 'folder'): Promise<WebFileGrant> {
    return this.request<WebFileGrant>(new URL('select', this.base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root, path, kind, purpose }) }).then(remember);
  }
  async upload(file: File, purpose: 'attachment' | 'theme'): Promise<WebFileGrant> {
    if (file.size > LIMIT) throw new Error('File exceeds the 64 MiB upload limit');
    return await this.request<WebFileGrant>(new URL('upload', this.base), { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(basename(file.name)), 'x-file-purpose': purpose }, body: file }).then(remember);
  }
  async reveal(path: unknown): Promise<void> {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('Invalid host path');
    const location = await this.request<{ root: string; path: string; name: string }>(new URL('locate', this.base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
    });
    if (!location || typeof location.root !== 'string' || typeof location.path !== 'string' || typeof location.name !== 'string') throw new Error('Invalid host location');
    await this.pickHost('folder', 'folder', location);
  }
  async pickFolder(purpose: 'project' | 'folder'): Promise<WebFileGrant | null> {
    return this.pickHost('folder', purpose);
  }
  async pickHostFile(purpose: 'executable'): Promise<WebFileGrant | null> {
    return this.pickHost('file', purpose);
  }
  private async pickHost(kind: 'folder' | 'file', purpose: 'project' | 'folder' | 'executable', reveal?: { root: string; path: string; name: string }): Promise<WebFileGrant | null> {
    const roots = await this.roots();
    if (!roots.length) throw new Error('The host has no accessible folders.');
    const dialog = document.createElement('dialog');
    dialog.className = 'web-file-picker dialog-plate';
    dialog.innerHTML = `<form method="dialog"><h2>${reveal ? 'Host files' : kind === 'folder' ? 'Choose a folder' : 'Choose a file'}</h2><label>Root <select data-root></select></label><nav aria-label="Folder path" data-breadcrumb></nav><button type="button" data-up>Up</button><label>Folder path <input data-location placeholder="Relative folder path" autocomplete="off"></label><button type="button" data-go>Go</button><div data-picker-list role="listbox" aria-label="Host entries"></div><p role="status" aria-live="polite"></p><footer><button value="cancel">Cancel</button><button type="button" data-previous disabled>Previous</button><button type="button" data-next disabled>Next</button><button value="select" data-select disabled>Select ${kind}</button></footer></form>`;
    document.body.append(dialog);
    const list = dialog.querySelector<HTMLElement>('[data-picker-list]')!;
    const status = dialog.querySelector<HTMLElement>('[role=status]')!;
    const select = dialog.querySelector<HTMLButtonElement>('[data-select]')!;
    const previousButton = dialog.querySelector<HTMLButtonElement>('[data-previous]')!;
    const nextButton = dialog.querySelector<HTMLButtonElement>('[data-next]')!;
    const breadcrumb = dialog.querySelector<HTMLElement>('[data-breadcrumb]')!;
    const rootSelect = dialog.querySelector<HTMLSelectElement>('[data-root]')!;
    const up = dialog.querySelector<HTMLButtonElement>('[data-up]')!;
    const locationInput = dialog.querySelector<HTMLInputElement>('[data-location]')!;
    roots.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; rootSelect.append(option); });
    const initialRoot = reveal ? roots.find(item => item.id === reveal.root) : roots[0];
    if (!initialRoot) { dialog.remove(); throw new Error('The host folder is no longer accessible.'); }
    let root = initialRoot;
    if (reveal) { select.hidden = true; dialog.querySelector<HTMLButtonElement>('button[value=cancel]')!.textContent = 'Close'; }
    let path = reveal?.path ?? '', listed = false, selected: string | null = null, resultGrant: WebFileGrant | null = null;
    let cursor: string | undefined; let previousCursors: (string | undefined)[] = [];
    let generation = 0; let disposed = false; let listing: AbortController | undefined;
    const renderBreadcrumb = () => {
      breadcrumb.replaceChildren();
      const segments = path.split('/').filter(Boolean);
      [root.label, ...segments].forEach((name, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = name; button.disabled = index === segments.length;
        button.addEventListener('click', () => { path = segments.slice(0, index).join('/'); previousCursors = []; cursor = undefined; void renderPage(); }); breadcrumb.append(button);
      });
      locationInput.value = path; up.disabled = !path;
    };
    const resetPage = () => { previousCursors = []; cursor = undefined; selected = null; void renderPage(); };
    const renderPage = async (pageCursor?: string) => {
      const token = ++generation; listing?.abort(); listing = new AbortController(); cursor = pageCursor; listed = false; selected = null;
      select.disabled = true; previousButton.disabled = previousCursors.length === 0; nextButton.disabled = true; status.textContent = 'Loading…'; list.replaceChildren(); renderBreadcrumb();
      try {
        const result = await this.list(root.id, path, listing.signal, pageCursor);
        if (disposed || token !== generation) return;
        listed = true;
        for (const entry of result.entries) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.directory ? `▸ ${entry.name}` : entry.name; button.dataset.path = entry.path;
          if (entry.directory) button.addEventListener('click', () => { path = entry.path; resetPage(); });
          else if (kind === 'file') button.addEventListener('click', () => { selected = entry.path; list.querySelectorAll('[aria-selected]').forEach(node => node.removeAttribute('aria-selected')); button.setAttribute('aria-selected', 'true'); select.disabled = false; });
          else button.disabled = true;
          list.append(button);
        }
        nextButton.dataset.cursor = result.nextCursor ?? ''; nextButton.disabled = !result.nextCursor;
        previousButton.disabled = previousCursors.length === 0;
        select.disabled = kind === 'file' ? selected === null : false;
        status.textContent = reveal ? `Showing host folder for ${reveal.name}` : result.entries.length ? '' : 'No entries on this page.';
      } catch (error) {
        if (disposed || token !== generation) return;
        status.textContent = error instanceof Error ? error.message : 'Could not list this folder.';
        select.disabled = true; previousButton.disabled = true; nextButton.disabled = true;
      }
    };
    const previous = document.activeElement as HTMLElement | null;
    const closed = new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
    dialog.addEventListener('close', () => { disposed = true; generation++; listing?.abort(); dialog.remove(); previous?.focus?.(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    rootSelect.addEventListener('change', () => { root = roots.find(item => item.id === rootSelect.value)!; path = ''; resetPage(); });
    up.addEventListener('click', () => { path = path.split('/').slice(0, -1).join('/'); resetPage(); });
    dialog.querySelector('[data-go]')!.addEventListener('click', () => { path = locationInput.value.trim().replace(/^\/+|\/+$/g, ''); resetPage(); });
    locationInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); path = locationInput.value.trim().replace(/^\/+|\/+$/g, ''); resetPage(); } });
    nextButton.addEventListener('click', () => { const next = nextButton.disabled ? undefined : nextButton.dataset.cursor; if (!next) return; previousCursors.push(cursor); void renderPage(next); });
    previousButton.addEventListener('click', () => { if (!previousCursors.length) return; void renderPage(previousCursors.pop()); });
    dialog.addEventListener('submit', async event => { event.preventDefault(); if (reveal || (event.submitter as HTMLButtonElement)?.value !== 'select' || !listed) return dialog.close(); const target = kind === 'folder' ? path : selected; if (target === null) return; select.disabled = true; status.textContent = 'Preparing…'; try { resultGrant = await this.select(root.id, target, kind, purpose); dialog.close(); } catch (error) { select.disabled = false; status.textContent = error instanceof Error ? error.message : `Could not select ${kind}.`; } });
    dialog.showModal(); void renderPage(); await closed; return resultGrant;
  }
  pickFiles(accept: string, multiple: boolean, purpose: 'attachment' | 'theme'): Promise<WebFileGrant[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.multiple = multiple; input.hidden = true; document.body.append(input);
      let settled = false, uploading = false;
      const finish = (value: WebFileGrant[] | Error) => { if (settled) return; settled = true; input.remove(); value instanceof Error ? reject(value) : resolve(value); };
      input.addEventListener('change', () => { if (settled || uploading) return; const files = [...input.files ?? []]; if (!files.length) return finish([]); uploading = true; void (async () => { const grants: WebFileGrant[] = []; for (const file of files) grants.push(await this.upload(file, purpose)); return grants; })().then(value => finish(value), error => finish(error instanceof Error ? error : new Error(String(error)))); });
      input.addEventListener('cancel', () => { if (!uploading) finish([]); });
      try { input.click(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
export const webFiles = typeof window !== 'undefined' && (new URLSearchParams(location.search).has('web') || document.documentElement.dataset.pandacodeWeb === 'true') ? new WebFiles() : null;
