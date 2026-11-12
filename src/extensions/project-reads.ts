import { isImeKey } from '../dom';
import type { createContextClient, ProjectReadPage, ProjectReadResource } from './context-state';

/** Fixed host controls: exact relative resource consent, never package-provided paths or HTML. */
export function projectReadControls(client: ReturnType<typeof createContextClient>, parent: HTMLElement): () => void {
  const section = document.createElement('details'); section.className = 'extension-project-reads';
  const summary = document.createElement('summary'); summary.textContent = 'Separately authorized file and Git reads';
  const note = document.createElement('p'); note.textContent = 'Exact relative file only, for the captured project and this launch. Hidden/auth files and links are denied. Git exposes only local HEAD, not configuration or status.';
  const label = document.createElement('label'); label.textContent = 'Relative file path';
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = 1024; input.placeholder = 'README.md'; label.append(input);
  const actions = document.createElement('div'); actions.className = 'extension-context-navigation';
  const output = document.createElement('pre'); output.className = 'extension-project-read-output'; output.setAttribute('role', 'status');
  section.append(summary, note, label, actions, output); parent.append(section);
  let disposed = false, pending = 0, page: ProjectReadPage | undefined, current: { resource: ProjectReadResource; path: string } | undefined;
  const button = (text: string, action: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'ds-btn'; node.textContent = text; node.addEventListener('click', action); actions.append(node); return node; };
  async function read(resource: ProjectReadResource, path: string, next = false) {
    const generation = ++pending; output.textContent = 'Reading captured project…';
    const reply = await client.read(resource, path, next && page ? { cursor: page.nextCursor ?? 0, revision: page.revision } : {});
    if (disposed || generation !== pending || !reply.ok && reply.error.code === 'Cancelled') return;
    if (!reply.ok) { output.textContent = reply.error.code; page = undefined; nextButton.disabled = true; return; }
    page = reply.value; current = { resource, path }; nextButton.disabled = page.nextCursor === null;
    output.textContent = `Schema ${page.schemaVersion} · revision ${page.revision}\n${page.content ?? JSON.stringify(page.items, null, 2)}`;
  }
  for (const [resource, capability, title] of [['metadata', 'projects.files.metadata', 'file metadata'], ['file', 'projects.files.read', 'file content'], ['git', 'projects.git.read', 'Git HEAD']] as const) {
    const path = () => resource === 'git' ? '.' : input.value;
    button(`Read ${title}`, () => { void read(resource, path()); });
    for (const allow of [true, false]) button(`${allow ? 'Allow' : 'Revoke'} ${title}`, () => {
      const generation = ++pending, capturedPath = path(); page = undefined; nextButton.disabled = true;
      output.textContent = allow ? 'Updating scoped access…' : 'PermissionDenied';
      void client.readConsent(capability, capturedPath, allow).then(reply => {
        if (disposed || generation !== pending) return;
        if (!reply.ok) { output.textContent = reply.error.code; return; }
        if (allow) void read(resource, capturedPath);
      });
    });
  }
  const nextButton = button('Next file page', () => { if (current && page?.nextCursor != null) void read(current.resource, current.path, true); }); nextButton.disabled = true;
  button('Cancel read', () => { pending++; output.textContent = 'Cancelled'; void client.cancelRead(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); void read('file', input.value); } });
  return () => { disposed = true; pending++; };
}
