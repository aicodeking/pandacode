export interface FileLinkContext { projectId: string; sessionId?: string }
export interface ResolvedFile { input: string; path: string; previewable: boolean }
interface FileLinkOptions {
  context: () => FileLinkContext | undefined;
  resolve: (context: FileLinkContext, paths: string[]) => Promise<ResolvedFile[]>;
  open: (context: FileLinkContext, file: ResolvedFile) => void | Promise<void>;
}

const PREVIEW_EXTENSIONS = /\.(?:html?|svg|png|jpe?g|gif|webp|avif|bmp|ico|pdf)$/i;
const TEXT_EXTENSIONS = /\.(?:html?|svg|png|jpe?g|gif|webp|avif|bmp|ico|pdf|md|mdx|txt|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|json|jsonc|yaml|yml|toml|xml|csv|rs|py|go|java|c|cc|cpp|h|hpp|swift|kt|sh|zsh|fish|sql|vue|svelte|astro|lock|env)$/i;
export function isPreviewableFile(path: string): boolean { return PREVIEW_EXTENSIONS.test(path); }

/** A reference is only a candidate. Native resolution must confirm its workspace and existence. */
export function fileReference(input: string): string | undefined {
  if (!input || input.length > 1024 || /[\x00-\x1f<>]/.test(input)) return;
  let path = input.trim();
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search) return;
      path = url.pathname + url.hash;
      if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
    } catch { return; }
  }
  try { path = decodeURIComponent(path); } catch { return; }
  if (/[\x00-\x1f<>]/.test(path)) return;
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  if (!path || /[?#]/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
  if (path.includes('@') || /[:]/.test(path.replace(/^[a-z]:/i, ''))) return;
  if (!/(?:^|[\\/])[^\\/]+\.[a-z\d]{1,12}$/i.test(path) && !/(?:^|[\\/])(?:README|LICENSE|Dockerfile|Makefile|\.gitignore|\.env)$/i.test(path)) return;
  return path;
}

export function findFileReferences(text: string): Array<{ start: number; end: number; path: string }> {
  const matches: Array<{ start: number; end: number; path: string }> = [];
  // Consume a complete token first, so a URL cannot leak a filename-shaped suffix.
  const tokens = /[^\s<>"'`()[\]{};,!=]+/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0].replace(/[.!]+$/, '');
    const path = fileReference(token);
    if (path && (TEXT_EXTENSIONS.test(path) || /(?:^|\/)README$/.test(path))) matches.push({ start: match.index!, end: match.index! + token.length, path });
    if (matches.length >= 96) break;
  }
  return matches;
}

type CachedFile = { file: ResolvedFile | null; expires: number };
type Hub = { context: FileLinkContext; options: FileLinkOptions; cache: Map<string, CachedFile>; queue: Set<string>; targets: Set<WeakRef<HTMLElement>>; timer?: number; busy: boolean; refreshPending?: boolean };
type BoundTarget = { hub?: Hub };
let options: FileLinkOptions | undefined;
const targets = new WeakMap<HTMLElement, BoundTarget>();
const hubs = new Map<string, Hub>();
const MAX_CACHE = 512;
const BATCH_SIZE = 32;

export function configureFileLinks(value: FileLinkOptions): void { options = value; hubs.clear(); }

/** Recheck missing references after the agent writes files or the user refreshes the inspector. */
export function refreshFileLinks(context: FileLinkContext): void {
  const hub = hubs.get(JSON.stringify([context.projectId, context.sessionId ?? '']));
  if (!hub) return;
  if (hub.busy) { hub.refreshPending = true; return; }
  for (const [path, entry] of hub.cache) if (!entry.file) hub.cache.delete(path);
  updateTargets(hub);
}

function updateTargets(hub: Hub): void {
  for (const reference of hub.targets) {
    const target = reference.deref();
    if (!target || !target.isConnected || targets.get(target)?.hub !== hub) hub.targets.delete(reference);
    else decorateFileLinks(target, target);
  }
}

function hubFor(context: FileLinkContext | undefined): Hub | undefined {
  if (!context?.projectId || !options) return;
  const key = JSON.stringify([context.projectId, context.sessionId ?? '']);
  let hub = hubs.get(key);
  if (!hub) {
    hub = { context: { ...context }, options, cache: new Map(), queue: new Set(), targets: new Set(), busy: false };
    hubs.set(key, hub);
    if (hubs.size > 24) hubs.delete(hubs.keys().next().value!);
  }
  return hub;
}

/** Bind before Markdown rendering when a worker or board pane belongs to another task. */
export function bindFileLinkContext(target: HTMLElement, context: FileLinkContext | undefined): void {
  const previous = targets.get(target);
  const hub = hubFor(context);
  if (previous && previous.hub === hub) return;
  targets.set(target, { hub });
  if (hub) hub.targets.add(new WeakRef(target));
  installClickHandler(target);
}

export function captureFileLinkContext(target: HTMLElement): object | undefined { return capture(target); }

/** A document's relative image path from its folder (a leading / is the workspace root, as on GitHub). */
export function workspaceImagePath(src: string, documentPath: string): string | undefined {
  if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) return undefined;
  const folder = documentPath.slice(0, documentPath.lastIndexOf('/') + 1).split('/').map(encodeURIComponent).join('/');
  try { return decodeURIComponent(new URL(src, `file:///${folder}`).pathname.slice(1)); } catch { return undefined; }
}

function capture(target: HTMLElement): Hub | undefined {
  let bound = targets.get(target);
  if (!bound) {
    const hub = hubFor(options?.context());
    bound = { hub }; targets.set(target, bound);
    if (hub) hub.targets.add(new WeakRef(target));
    installClickHandler(target);
  }
  return bound.hub;
}

const listening = new WeakSet<HTMLElement>();
const linkFiles = new WeakMap<Element, { hub: Hub; file: ResolvedFile }>();
function installClickHandler(target: HTMLElement): void {
  if (listening.has(target)) return;
  listening.add(target);
  target.addEventListener('click', event => {
    const link = (event.target as Element).closest?.('.workspace-file-link');
    if (!link || !target.contains(link)) return;
    event.preventDefault(); event.stopPropagation();
    const bound = linkFiles.get(link);
    if (!bound || targets.get(target)?.hub !== bound.hub) return;
    // Errors are surfaced by the host callback; avoid an unhandled rejected promise.
    void Promise.resolve(bound.hub.options.open(bound.hub.context, bound.file)).catch(() => {});
  });
}

function cached(hub: Hub, input: string): ResolvedFile | null | undefined {
  const entry = hub.cache.get(input);
  if (entry && entry.expires > Date.now()) return entry.file;
  if (entry) hub.cache.delete(input);
}
function request(hub: Hub, input: string): void {
  if (cached(hub, input) !== undefined || hub.queue.size >= MAX_CACHE) return;
  hub.queue.add(input);
  if (!hub.timer && !hub.busy) hub.timer = window.setTimeout(() => { hub.timer = undefined; void flush(hub); }, 100);
}
async function flush(hub: Hub): Promise<void> {
  const paths = [...hub.queue].slice(0, BATCH_SIZE);
  if (!paths.length || hub.busy) return;
  paths.forEach(path => hub.queue.delete(path)); hub.busy = true;
  // Pending entries prevent streaming frames from queuing the same paths repeatedly.
  paths.forEach(path => hub.cache.set(path, { file: null, expires: Date.now() + 30_000 }));
  try {
    const files = await hub.options.resolve(hub.context, paths);
    for (const file of files) if (paths.includes(file.input) && typeof file.path === 'string' && file.path.length <= 4096) {
      hub.cache.set(file.input, { file, expires: Infinity });
    }
  } catch { /* Missing/unavailable files remain readable plain text; retry on a later render. */ }
  finally {
    hub.busy = false;
    while (hub.cache.size > MAX_CACHE) hub.cache.delete(hub.cache.keys().next().value!);
    if (hub.refreshPending) {
      hub.refreshPending = false;
      for (const [path, entry] of hub.cache) if (!entry.file) hub.cache.delete(path);
    }
    updateTargets(hub);
    if (hub.queue.size && !hub.timer) hub.timer = window.setTimeout(() => { hub.timer = undefined; void flush(hub); }, 100);
  }
}

function fileLink(hub: Hub, file: ResolvedFile, contents: Node[]): HTMLElement {
  const link = document.createElement('button');
  link.type = 'button'; link.className = 'workspace-file-link';
  link.title = `${file.previewable ? 'Preview' : 'Open'} ${file.path}`;
  link.append(...contents); linkFiles.set(link, { hub, file });
  return link;
}

/** Run on the sanitized fragment before reconciliation, and after asynchronous resolution. */
export function decorateFileLinks(root: ParentNode, target: HTMLElement): void {
  const hub = capture(target);
  // Relative Markdown links must never navigate the desktop webview, even without a workspace.
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href) continue;
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; continue; }
    const path = fileReference(href);
    const span = document.createElement('span'); span.append(...anchor.childNodes);
    if (path && hub) {
      const file = cached(hub, path);
      if (file) { span.replaceChildren(fileLink(hub, file, [...span.childNodes])); }
      else { span.dataset.fileReference = path; request(hub, path); }
    }
    anchor.replaceWith(span);
  }
  if (!hub) return;
  for (const span of root.querySelectorAll<HTMLElement>('[data-file-reference]')) {
    const path = span.dataset.fileReference!; const file = cached(hub, path);
    if (file) span.replaceChildren(fileLink(hub, file, [...span.childNodes]));
    if (file) delete span.dataset.fileReference;
    else request(hub, path);
  }
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('a,pre,button,script,style,[data-file-reference]')) continue;
    textNodes.push(node as Text);
  }
  let count = 0;
  for (const text of textNodes) {
    if (count >= 96) break;
    const full = text.parentElement?.tagName === 'CODE' ? fileReference(text.data) : undefined;
    const references = full ? [{ start: 0, end: text.length, path: full }] : findFileReferences(text.data);
    if (!references.length) continue;
    const fragment = document.createDocumentFragment(); let cursor = 0; let linked = false;
    for (const ref of references) {
      if (++count > 96) break;
      const file = cached(hub, ref.path);
      if (!file) { request(hub, ref.path); continue; }
      fragment.append(text.data.slice(cursor, ref.start), fileLink(hub, file, [document.createTextNode(text.data.slice(ref.start, ref.end))]));
      cursor = ref.end; linked = true;
    }
    if (linked) { fragment.append(text.data.slice(cursor)); text.replaceWith(fragment); }
  }
}

/** Reconciliation retains DOM nodes, so restore trusted click metadata from the prepared node. */
export function retainFileLink(old: Element, next: Element): void {
  const bound = linkFiles.get(next);
  if (bound) linkFiles.set(old, bound);
  else linkFiles.delete(old);
}
