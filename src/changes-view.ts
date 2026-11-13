import type { GitFile, GitStatus } from './types';
import type { DiffViewerController } from './diff-viewer';
import { escape, fileIcon, icon, isImeKey } from './dom';
import { createChangesPresentation, snapshotChangesPresentation, type ChangesPresentation, type ChangesAction, type ChangesResult, type ChangesControl } from './extensions/diff';
import { applyChangesPresentation, componentProviders, componentSelection } from './extensions/replacement';
import { extensionsSnapshot, onExtensionsChanged, extensionIdentity } from './extensions/manager';
import { layout, applyControlOrder, applyControlVisibility } from './extensions/layout-host';
import { mountExtensionActions } from './extensions/header';
import './changes-view.css';

export interface ChangesViewDeps {
  /** Opaque captured host context; not supplied by an extension. */
  context?: string;
  actionContext?(): Record<string, import('./extensions/contracts').Json>;
  loadDiff(path: string, staged: boolean): Promise<string>;
  stage(paths: string[], staged: boolean): Promise<void>;
  commit(message: string): Promise<void>;
  openFile(path: string): void;
  refresh(): void;
  notify(message: string): void;
  choose(anchor: HTMLElement, title: string, items: { id: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; selected?: boolean }[], onSelect: (id: string) => void, filePath?: string): void;
  /** When given, the … menu offers to move the work into an isolated worktree. */
  worktree?(): void;
}
export interface ChangesView {
  /** Re-renders from `status`. Loaded patches are quietly refetched (at most once a second) when
   * `status` is a new object, or always/never with an explicit `refetch`; a viewer re-mounts only
   * when its patch text changed. */
  update(status: GitStatus | null, error?: string, options?: { refetch?: boolean }): void;
  presentation(): ChangesPresentation;
  dispatch(action: ChangesAction): ChangesResult;
  dispose(): void;
}

type Scope = 'all' | 'unstaged' | 'staged';
type Load = 'idle' | 'loading' | 'loaded' | 'error';
interface Entry {
  id: string; diffId: string; revision: number; hunks: { id: string; revision: number }[];
  path: string; staged: boolean; sig: string; code: string;
  el: HTMLElement; body: HTMLElement; stat: HTMLElement;
  load: Load; token: number; raw: string; patch: string; adds: number; dels: number;
  viewer?: DiffViewerController; slot?: HTMLElement; shown?: string;
  /** Viewers still on screen until their replacement has rendered. */
  stale: { viewer: DiffViewerController; slot: HTMLElement }[];
}

const EAGER = 8;
const REFETCH_GAP = 1_000;
// Added to each diff's shadow root (by the viewer, also for hunk groups that mount later): long lines scroll with a visible bar; wrapped code may break anywhere (so indentation never
// sits alone on a row), and hunk headers are one slim muted line.
const SHADOW_CSS = `
  pre[data-diff][data-overflow='wrap'] [data-line] { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; }
  pre[data-diff] [data-code] { scrollbar-gutter: stable; }
  pre[data-diff] [data-code]::-webkit-scrollbar { height: 10px; background: transparent; }
  pre[data-diff] [data-code]::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 35%, transparent); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
  pre[data-diff] [data-code]::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, currentColor 55%, transparent); background-clip: content-box; }
  [data-file-info] { border-block: 0; }
  pre[data-diff] [data-gutter] { background-color: color-mix(in srgb, var(--diffs-fg, currentColor) 5%, var(--diffs-bg)); }
  pre[data-diff] [data-separator='metadata'] { height: 20px; }
  pre[data-diff] [data-separator='metadata'] [data-separator-wrapper] {
    font-size: .68rem; line-height: 20px; opacity: .8;
    background-color: color-mix(in srgb, var(--diffs-bg-separator) 45%, var(--diffs-bg));
  }`;
const TRUNCATED = /\n*\[Preview truncated at [^\]]*\]\n*$/;
const SCOPES: Record<Scope, string> = { all: 'All changes', unstaged: 'Unstaged', staged: 'Staged' };
const STATUS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Modified', U: 'Conflict', '?': 'Untracked' };
const FOLD = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 4 5 5 5-5M7 20l5-5 5 5"/></svg>';
const UNFOLD = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 9 5-5 5 5M7 15l5 5 5-5"/></svg>';

export const isStaged = (f: GitFile): boolean => ![' ', '?', '!', '.'].includes(f.index);
export const isUnstaged = (f: GitFile): boolean => ![' ', '!', '.'].includes(f.working) || f.index === '?';

/** Added and removed lines inside hunks; file headers (`---`/`+++`) never count. */
export function countLines(patch: string): { adds: number; dels: number } {
  let adds = 0, dels = 0, hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff ')) hunk = false;
    else if (line.startsWith('@@')) hunk = true;
    else if (hunk && line[0] === '+') adds++;
    else if (hunk && line[0] === '-') dels++;
  }
  return { adds, dels };
}

function iconButton(action: string, label: string, svg: string, extra = ''): string {
  return `<button type="button" class="cv-icon" data-cv-action="${action}" title="${escape(label)}" aria-label="${escape(label)}" ${extra}>${svg}</button>`;
}

export function mountChangesView(host: HTMLElement, deps: ChangesViewDeps): ChangesView {
  let scope: Scope = 'all';
  let status: GitStatus | null = null;
  let error: string | undefined;
  let disposed = false;
  let committing = false;
  let mutating = false, revision = 0;
  let presentationSignature = '';
  const repository = crypto.randomUUID(), context = deps.context ?? crypto.randomUUID();
  const applied = new Set<string>();
  const entries = new Map<string, Entry>();
  const collapsed = new Set<string>();
  let order: string[] = [];
  let viewerModule: Promise<typeof import('./diff-viewer')> | undefined;
  let lastRefetch = 0, refetchTimer = 0, fitFrame = 0;

  host.classList.add('changes-view');
  host.innerHTML = `
    <div class="cv-header">
      <button type="button" class="cv-scope" data-cv-action="scope" aria-haspopup="menu">${icon('branch')}<span class="cv-scope-label"></span>${icon('down', 'cv-caret')}</button>
      <span class="cv-files"></span><span class="cv-adds"></span><span class="cv-dels"></span>
      <span class="cv-branch" hidden></span>
      <span class="cv-spacer"></span>
      ${iconButton('fold-all', 'Collapse all', FOLD, 'aria-pressed="false"')}
      ${iconButton('menu', 'More actions', icon('more'), 'aria-haspopup="menu"')}
    </div>
    <form class="cv-commit" hidden>
      <input class="cv-commit-input" type="text" placeholder="Commit message" aria-label="Commit message" autocomplete="off" spellcheck="true">
      <button type="submit" class="cv-commit-submit">Commit</button>
    </form>
    <div class="cv-body" tabindex="-1"><div class="cv-list"></div></div>`;
  const q = <T extends HTMLElement>(s: string) => host.querySelector<T>(s)!;
  const body = q('.cv-body'), list = q('.cv-list'), scopeLabel = q('.cv-scope-label'), filesLabel = q('.cv-files');
  const addsLabel = q('.cv-adds'), delsLabel = q('.cv-dels'), branchLabel = q('.cv-branch'), foldButton = q<HTMLButtonElement>('[data-cv-action="fold-all"]');
  const commitBar = q<HTMLFormElement>('.cv-commit'), commitInput = q<HTMLInputElement>('.cv-commit-input'), commitSubmit = q<HTMLButtonElement>('.cv-commit-submit');
  const control = (id: string, label: string, enabled = true, selected?: boolean): ChangesControl => ({ id, label, enabled, ...(selected === undefined ? {} : { selected }) });
  function presentation(): ChangesPresentation {
    const selected = [...entries.values()].find(entry => entry.el.contains(document.activeElement));
    // Leave room for controls inside the shared 8,192-node/256 KiB envelope.
    const items = [...entries.values()].slice(0, 64); let hunkBudget = 256, omitted = entries.size > items.length;
    const mapped = items.map(entry => {
      const hunks = entry.hunks.slice(0, Math.min(32, hunkBudget)); hunkBudget -= hunks.length; omitted ||= hunks.length < entry.hunks.length;
      return { id: entry.id, diffId: entry.diffId, revision: entry.revision, staged: entry.staged, load: entry.load, hunks, controls: [control('toggle', 'Collapse file', true, !collapsed.has(entry.path)), control('copy', 'Copy path'), control('open', 'Open file', entry.code !== 'D'), control('stage', 'Stage file', unstagedFiles().some(file => file.path === entry.path)), control('unstage', 'Unstage file', stagedFiles().some(file => file.path === entry.path)), control('retry-file', 'Retry diff', entry.load === 'error'), ...(entry.viewer?.controls().map(({ id, node }) => control(id, node.getAttribute('aria-label')!, !node.disabled && !node.closest('[hidden]'), node.getAttribute('aria-pressed') === 'true')) ?? [])] };
    });
    const state: ChangesPresentation = { contractVersion: 1, context, repository, revision, scope, selected: selected && items.includes(selected) ? selected.id : '', focused: selected?.id ?? '', loading: !status, error: Boolean(error), offline: !navigator.onLine, visible: !disposed && host.checkVisibility() && !host.closest('[inert]'), pending: committing || mutating, truncated: omitted, files: mapped,
      controls: [control('scope-all', 'All changes', true, scope === 'all'), control('scope-staged', 'Staged', true, scope === 'staged'), control('scope-unstaged', 'Unstaged', true, scope === 'unstaged'), control('fold-all', 'Collapse all', entries.size > 0), control('stage-all', 'Stage all', unstagedFiles().length > 0), control('unstage-all', 'Unstage all', stagedFiles().length > 0), control('open-commit', 'Commit…', Boolean(status?.isRepo), !commitBar.hidden), control('commit', 'Commit', !committing && stagedFiles().length > 0 && Boolean(commitInput.value.trim())), control('refresh', 'Refresh')],
    };
    const signature = JSON.stringify({ ...state, revision: 0, selected: '', focused: '' });
    if (signature !== presentationSignature) { presentationSignature = signature; revision++; }
    return snapshotChangesPresentation({ ...state, revision });
  }
  function dispatch(action: ChangesAction): ChangesResult {
    const provider = componentSelection.resolve('panda.changes', componentProviders());
    if (!provider || !host.dataset.changesProvider) return { ok: false, reason: 'Revoked' };
    const identity = extensionIdentity(provider.id.split('/')[0]);
    const instance = createChangesPresentation(presentation(), provider.id, presentation, () => {
      const current = componentSelection.resolve('panda.changes', componentProviders());
      return { owner: current?.id ?? '', active: !disposed && current !== undefined && extensionIdentity(provider.id.split('/')[0]) === identity, granted: Boolean(extensionsSnapshot().packages.find(item => item.manifest.id === provider.id.split('/')[0])?.manifest.permissions?.includes('ui.contribute')) };
    }, originalAction, applied);
    try { return instance.dispatch(action); } finally { instance.dispose(); }
  }
  function originalAction(action: ChangesAction): void {
    const entry = [...entries.values()].find(entry => entry.id === action.fileId);
    const id = action.controlId;
    if (entry) {
      if (id === 'toggle') { toggle(entry.path); totals(); }
      else if (id === 'copy') copy(entry.path);
      else if (id === 'open') deps.openFile(entry.path);
      else if (id === 'stage' || id === 'unstage') void mutate([entry.path], id === 'stage');
      else if (id === 'retry-file') { reset(entry); void load(entry); }
      else { entry.viewer?.controls().find(control => control.id === id)?.invoke(); revision++; }
    } else if (id.startsWith('scope-')) { scope = id.slice(6) as Scope; revision++; render(); }
    else if (id === 'fold-all') { const fold = ![...entries.keys()].every(path => collapsed.has(path)); for (const path of entries.keys()) toggle(path, fold); totals(); }
    else if (id === 'stage-all' || id === 'unstage-all') void mutate((id === 'stage-all' ? unstagedFiles() : stagedFiles()).map(file => file.path), id === 'stage-all');
    else if (id === 'open-commit') openCommit();
    else if (id === 'commit') void submitCommit();
    else if (id === 'refresh') deps.refresh();
  }
  const headerBindings = ['scope', 'fold-all', 'menu'].map(id => [`panda.changes.controls/${id}`, q<HTMLElement>(`[data-cv-action="${id}"]`)] as const);
  const commitBindings = [['panda.changes.controls/commit-message', commitInput], ['panda.changes.controls/commit', commitSubmit]] as const;
  function refreshPresentation(): void {
    if (disposed) return;
    applyChangesPresentation(host);
    applyControlOrder('panda.changes.controls', [...headerBindings, ...commitBindings]);
    const bindings: (readonly [string, HTMLElement | null])[] = [...headerBindings, ...commitBindings, ['panda.changes.controls/retry', list.querySelector<HTMLElement>('[data-cv-action="retry"]')]];
    for (const entry of entries.values()) {
      const controls = ['toggle', 'copy', 'file-menu'].map(id => [`panda.changes.file/${id}`, entry.el.querySelector<HTMLElement>(`[data-cv-action="${id}"]`)!] as const);
      applyControlOrder('panda.changes.file', controls); bindings.push(...controls);
      bindings.push(['panda.changes.file/retry-file', entry.body.querySelector<HTMLElement>('[data-cv-action="retry-file"]')]);
      const viewer = entry.viewer?.controls().map(({ id, node }) => [`panda.changes.viewer/${id}`, node] as const) ?? [];
      applyControlOrder('panda.changes.viewer', viewer); bindings.push(...viewer);
    }
    applyControlVisibility(bindings, () => body);
  }
  const disposeActions = mountExtensionActions(q('.cv-header'), 'panda.changes.actions', () => ({ ...(deps.actionContext?.() ?? {}), revision, selection: { kind: 'repository', ids: [repository] } }), deps.notify);
  const disposeExtensions = onExtensionsChanged(refreshPresentation), disposeLayout = layout.subscribe(refreshPresentation);
  window.addEventListener('pandacode-components-change', refreshPresentation);

  const observer = new IntersectionObserver(records => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const entry = entries.get((record.target as HTMLElement).dataset.path ?? '');
      if (entry && entry.load === 'idle') void load(entry);
    }
  }, { root: body, rootMargin: '800px 0px' });
  const resizer = new ResizeObserver(() => scheduleFit());
  resizer.observe(body);

  const files = (): GitFile[] => status?.isRepo ? status.files : [];
  const stagedFiles = () => files().filter(isStaged);
  const unstagedFiles = () => files().filter(isUnstaged);

  function visible(): { file: GitFile; staged: boolean }[] {
    return files().flatMap(file => {
      const s = isStaged(file), u = isUnstaged(file);
      if (scope === 'staged') return s ? [{ file, staged: true }] : [];
      if (scope === 'unstaged') return u ? [{ file, staged: false }] : [];
      return s || u ? [{ file, staged: !u }] : [];
    }).sort((a, b) => a.file.path.localeCompare(b.file.path));
  }

  function setStat(entry: Entry): void {
    const parts: string[] = [];
    if (entry.load === 'loaded') {
      if (entry.adds) parts.push(`<span class="cv-add">+${entry.adds}</span>`);
      if (entry.dels) parts.push(`<span class="cv-del">-${entry.dels}</span>`);
    }
    entry.stat.innerHTML = parts.join('');
    scheduleFit();
  }

  /** Directories lose leading segments (`…/components`), never a mid-word fragment. */
  function fitDir(el: HTMLElement): void {
    const dir = el.dataset.dir ?? '';
    el.textContent = dir;
    if (!el.clientWidth || el.scrollWidth <= el.clientWidth) return;
    const parts = dir.split('/');
    for (let i = 1; i < parts.length; i++) {
      el.textContent = `…/${parts.slice(i).join('/')}`;
      if (el.scrollWidth <= el.clientWidth) return;
    }
    // No room for even the last folder: the full path stays in the title.
    el.textContent = '';
  }
  function scheduleFit(): void {
    fitFrame ||= requestAnimationFrame(() => {
      fitFrame = 0;
      if (!disposed) for (const el of body.querySelectorAll<HTMLElement>('.cv-dir')) fitDir(el);
    });
  }

  function totals(): void {
    let adds = 0, dels = 0;
    for (const entry of entries.values()) if (entry.load === 'loaded') { adds += entry.adds; dels += entry.dels; }
    const n = entries.size;
    filesLabel.textContent = n ? `${n} file${n === 1 ? '' : 's'}` : '';
    addsLabel.textContent = n ? `+${adds}` : '';
    delsLabel.textContent = n ? `-${dels}` : '';
    const allFolded = n > 0 && [...entries.keys()].every(p => collapsed.has(p));
    foldButton.innerHTML = allFolded ? UNFOLD : FOLD;
    foldButton.title = allFolded ? 'Expand all' : 'Collapse all';
    foldButton.setAttribute('aria-label', foldButton.title);
    foldButton.setAttribute('aria-pressed', String(allFolded));
    foldButton.disabled = !n;
    commitSubmit.disabled = committing || mutating || !navigator.onLine || !stagedFiles().length || !commitInput.value.trim();
  }

  function element(path: string): Entry['el'] {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1), dir = slash > 0 ? path.slice(0, slash) : '';
    const el = document.createElement('section');
    el.className = 'cv-file';
    el.dataset.path = path;
    el.innerHTML = `
      <div class="cv-file-header">
        <button type="button" class="cv-toggle" data-cv-action="toggle" aria-expanded="true" aria-label="Collapse ${escape(path)}">${icon('chevron', 'cv-chevron')}</button>
        <span class="cv-file-icon">${fileIcon(name, false)}</span>
        <button type="button" class="cv-file-name" data-cv-action="toggle" title="${escape(path)}"><span class="cv-name">${escape(name)}</span>${dir ? `<span class="cv-dir" data-dir="${escape(dir)}" title="${escape(dir)}">${escape(dir)}</span>` : ''}</button>
        ${iconButton('copy', 'Copy path', icon('copy'), 'tabindex="-1"').replace('cv-icon', 'cv-icon cv-copy')}
        <span class="cv-stat"></span>
        <span class="cv-pill"></span>
        ${iconButton('file-menu', 'File actions', icon('more'), 'aria-haspopup="menu"')}
      </div>
      <div class="cv-file-body"><div class="cv-placeholder">Loading diff…</div></div>`;
    return el;
  }

  function drop(entry: Entry): void {
    entry.viewer?.dispose();
    for (const old of entry.stale.splice(0)) old.viewer.dispose();
    entry.viewer = entry.slot = entry.shown = undefined;
  }

  function reset(entry: Entry): void {
    drop(entry);
    entry.token++;
    entry.revision++; revision++;
    entry.diffId = crypto.randomUUID(); entry.hunks = [];
    entry.load = 'idle';
    entry.raw = entry.patch = '';
    entry.adds = entry.dels = 0;
    entry.body.innerHTML = '<div class="cv-placeholder">Loading diff…</div>';
    setStat(entry);
  }

  function paint(entry: Entry, code: string): void {
    entry.code = code;
    const label = STATUS[code] ?? 'Modified';
    const pill = entry.el.querySelector<HTMLElement>('.cv-pill')!;
    pill.textContent = label;
    pill.dataset.status = label.toLowerCase();
    const folded = collapsed.has(entry.path);
    entry.el.classList.toggle('collapsed', folded);
    const toggle = entry.el.querySelector<HTMLElement>('.cv-toggle')!;
    toggle.setAttribute('aria-expanded', String(!folded));
    toggle.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${entry.path}`);
    entry.body.hidden = folded;
  }

  /** A quiet load keeps the current diff on screen and changes nothing when the text is unchanged. */
  async function load(entry: Entry, quiet = false): Promise<void> {
    const token = ++entry.token;
    if (!quiet) entry.load = 'loading';
    try {
      const text = await deps.loadDiff(entry.path, entry.staged);
      if (disposed || token !== entry.token) return;
      if (quiet && entry.load === 'loaded' && text === entry.raw) { mountViewer(entry); return; }
      entry.raw = text;
      entry.revision++; revision++;
      entry.diffId = crypto.randomUUID();
      entry.hunks = [...text.matchAll(/^@@ .+ @@/gm)].slice(0, 257).map(() => ({ id: crypto.randomUUID(), revision: entry.revision }));
      const truncated = TRUNCATED.test(text);
      entry.patch = truncated ? text.replace(TRUNCATED, '\n') : text;
      Object.assign(entry, countLines(entry.patch), { load: 'loaded' as Load });
      entry.el.dataset.truncated = String(truncated);
      setStat(entry);
      totals();
      mountViewer(entry);
    } catch (reason) {
      if (disposed || token !== entry.token || (quiet && entry.load === 'loaded')) return;
      drop(entry);
      entry.load = 'error';
      entry.revision++; revision++;
      entry.body.innerHTML = `<div class="cv-placeholder cv-error">${icon('alert')}<span>${escape(reason instanceof Error ? reason.message : String(reason || 'Unable to load diff'))}</span><button type="button" class="cv-link" data-cv-action="retry-file">Retry</button></div>`;
      refreshPresentation();
    }
  }

  /** Mounts the patch, or swaps in a new viewer once it has rendered so the old one never flashes away. */
  function mountViewer(entry: Entry): void {
    if (entry.load !== 'loaded' || (entry.viewer && entry.shown === entry.raw)) return;
    const token = entry.token, raw = entry.raw;
    viewerModule ??= import('./diff-viewer');
    viewerModule.then(({ mountDiffViewer }) => {
      if (disposed || token !== entry.token || (entry.viewer && entry.shown === raw)) return;
      const slot = document.createElement('div');
      slot.className = 'cv-diff';
      if (entry.viewer && entry.slot) {
        entry.stale.push({ viewer: entry.viewer, slot: entry.slot });
        slot.classList.add('cv-diff-next');
        entry.body.append(slot);
      } else entry.body.replaceChildren(slot);
      const viewer = mountDiffViewer(slot, { patch: entry.patch, path: entry.path, layout: 'unified', truncated: entry.el.dataset.truncated === 'true', scrollRoot: body, shadowCSS: SHADOW_CSS });
      Object.assign(entry, { viewer, slot, shown: raw });
      void viewer.ready.then(() => {
        if (disposed || entry.viewer !== viewer) return;
        for (const old of entry.stale.splice(0)) { old.viewer.dispose(); old.slot.remove(); }
        slot.classList.remove('cv-diff-next');
        refreshPresentation();
      });
    }, () => { if (!disposed && token === entry.token) entry.body.innerHTML = `<pre class="cv-raw">${escape(entry.patch)}</pre>`; });
  }

  function refetch(): void {
    lastRefetch = Date.now();
    for (const entry of entries.values()) if (entry.load === 'loaded' || entry.load === 'error') void load(entry, true);
  }
  function scheduleRefetch(): void {
    const wait = lastRefetch + REFETCH_GAP - Date.now();
    if (wait <= 0) { clearTimeout(refetchTimer); refetchTimer = 0; refetch(); }
    else refetchTimer ||= window.setTimeout(() => { refetchTimer = 0; if (!disposed) refetch(); }, wait);
  }

  function message(html: string, cls = ''): void {
    for (const entry of entries.values()) { drop(entry); observer.unobserve(entry.el); }
    entries.clear();
    order = [];
    list.innerHTML = `<div class="cv-state ${cls}">${html}</div>`;
  }

  function render(): void {
    scopeLabel.textContent = SCOPES[scope];
    const branch = status?.isRepo ? status.branch || 'No commits yet' : '';
    branchLabel.hidden = !branch;
    branchLabel.textContent = branch;
    branchLabel.title = branch && `Branch ${branch}`;
    if (error) message(`${icon('alert')}<span>${escape(error)}</span><button type="button" class="cv-link" data-cv-action="retry">Retry</button>`, 'cv-state-error');
    else if (!status) message('<span>Loading changes…</span>');
    else if (!status.isRepo) message(`${icon('branch')}<span>Not a Git repository</span>`);
    else {
      const wanted = visible();
      if (!wanted.length) message(`${icon('check')}<span>${scope === 'all' ? 'Working tree clean' : scope === 'staged' ? 'No staged changes' : 'No unstaged changes'}</span>`, 'cv-state-clean');
      else sync(wanted);
    }
    totals();
    refreshPresentation();
  }

  function sync(wanted: { file: GitFile; staged: boolean }[]): void {
    list.querySelector('.cv-state')?.remove();
    const keep = new Set(wanted.map(w => w.file.path));
    for (const [path, entry] of entries) {
      if (keep.has(path)) continue;
      drop(entry);
      observer.unobserve(entry.el);
      entry.el.remove();
      entries.delete(path);
    }
    let previous: Element | null = null;
    const fresh: Entry[] = [];
    wanted.forEach(({ file, staged }) => {
      const sig = `${file.index}${file.working}:${staged ? 1 : 0}`;
      let entry = entries.get(file.path);
      if (!entry) {
        const el = element(file.path);
        entry = { id: crypto.randomUUID(), diffId: crypto.randomUUID(), revision: 0, hunks: [], path: file.path, staged, sig, code: '', el, body: el.querySelector('.cv-file-body')!, stat: el.querySelector('.cv-stat')!, load: 'idle', token: 0, raw: '', patch: '', adds: 0, dels: 0, stale: [] };
        entries.set(file.path, entry);
        observer.observe(el);
        fresh.push(entry);
      } else if (entry.sig !== sig) {
        entry.sig = sig;
        entry.staged = staged;
        const wasLoaded = entry.load !== 'idle';
        reset(entry);
        if (wasLoaded) void load(entry);
      }
      const side = staged ? file.index : (file.index === '?' ? '?' : file.working);
      paint(entry, side);
      const next: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
      if (next !== entry.el) list.insertBefore(entry.el, next);
      previous = entry.el;
    });
    order = wanted.map(w => w.file.path);
    // The first few patches load right away; the rest load as they near the viewport.
    for (const entry of fresh) if (order.indexOf(entry.path) < EAGER && entry.load === 'idle') void load(entry);
    if (fresh.length) scheduleFit();
  }

  function toggle(path: string, folded = !collapsed.has(path)): void {
    revision++;
    if (folded) collapsed.add(path); else collapsed.delete(path);
    const entry = entries.get(path);
    if (entry) paint(entry, entry.code);
  }

  async function run(task: Promise<void>, failure: string): Promise<void> {
    try { await task; } catch (reason) { deps.notify(reason instanceof Error && reason.message ? reason.message : failure); }
  }
  async function mutate(paths: string[], staged: boolean): Promise<void> {
    if (disposed || committing || mutating || !navigator.onLine || !paths.length) return;
    mutating = true; revision++; totals();
    try { await run(deps.stage([...paths], staged), staged ? 'Unable to stage files' : 'Unable to unstage files'); }
    finally { mutating = false; revision++; if (!disposed) totals(); }
  }

  function openCommit(): void {
    commitBar.hidden = false;
    totals();
    commitInput.focus();
  }
  function closeCommit(): void {
    commitBar.hidden = true;
    commitInput.value = '';
    totals();
  }
  async function submitCommit(): Promise<void> {
    const text = commitInput.value.trim();
    if (!text || disposed || committing || mutating || !navigator.onLine || !stagedFiles().length) return;
    committing = true;
    revision++;
    totals();
    try {
      await deps.commit(text);
      if (!disposed) closeCommit();
    } catch (reason) {
      deps.notify(reason instanceof Error && reason.message ? reason.message : 'Commit failed');
    } finally {
      committing = false;
      revision++;
      if (!disposed) totals();
    }
  }

  function copy(path: string): void {
    void navigator.clipboard.writeText(path).then(() => deps.notify('Copied path'), () => deps.notify('Unable to copy path'));
  }

  function fileMenu(anchor: HTMLElement, path: string): void {
    const file = files().find(f => f.path === path);
    if (!file) return;
    const items = [
      ...(isUnstaged(file) ? [{ id: 'stage', label: 'Stage file', icon: 'plus' }] : []),
      ...(isStaged(file) ? [{ id: 'unstage', label: 'Unstage file', icon: 'minimize' }] : []),
      { id: 'open', label: 'Open file', icon: 'file', disabled: file.working === 'D' || (file.index === 'D' && file.working === ' ') },
      { id: 'copy', label: 'Copy path', icon: 'copy' },
    ];
    const capturedRevision = revision;
    deps.choose(anchor, path, items, id => {
      if (disposed || revision !== capturedRevision) return;
      if (id === 'stage' || id === 'unstage') void mutate([path], id === 'stage');
      else if (id === 'open') deps.openFile(path);
      else if (id === 'copy') copy(path);
    }, path);
  }

  function onClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cv-action]');
    if (!target || !host.contains(target)) return;
    event.stopPropagation();
    const path = target.closest<HTMLElement>('.cv-file')?.dataset.path ?? '';
    switch (target.dataset.cvAction) {
      case 'scope':
        deps.choose(target, 'Show', (Object.keys(SCOPES) as Scope[]).map(id => ({ id, label: SCOPES[id], selected: id === scope })), id => {
          if (id === scope || !(id in SCOPES)) return;
          scope = id as Scope;
          revision++;
          render();
        });
        break;
      case 'fold-all': {
        const fold = ![...entries.keys()].every(p => collapsed.has(p));
        for (const p of entries.keys()) toggle(p, fold);
        totals();
        break;
      }
      case 'menu': {
        const staged = stagedFiles().map(f => f.path), unstaged = unstagedFiles().map(f => f.path);
        const capturedRevision = revision;
        deps.choose(target, 'Changes', [
          { id: 'stage-all', label: 'Stage all', icon: 'plus', disabled: !unstaged.length },
          { id: 'unstage-all', label: 'Unstage all', icon: 'minimize', disabled: !staged.length },
          { id: 'commit', label: 'Commit…', icon: 'check', disabled: !status?.isRepo },
          { id: 'refresh', label: 'Refresh', icon: 'refresh' },
          ...(deps.worktree ? [{ id: 'worktree', label: 'Create isolated worktree…', icon: 'branch' }] : []),
        ], id => {
          if (disposed || revision !== capturedRevision) return;
          if (id === 'stage-all' && unstaged.length) void mutate(unstaged, true);
          else if (id === 'unstage-all' && staged.length) void mutate(staged, false);
          else if (id === 'commit') openCommit();
          else if (id === 'refresh') deps.refresh();
          else if (id === 'worktree') deps.worktree?.();
        });
        break;
      }
      case 'toggle': toggle(path); totals(); break;
      case 'copy': copy(path); break;
      case 'file-menu': fileMenu(target, path); break;
      case 'retry': deps.refresh(); break;
      case 'retry-file': { const entry = entries.get(path); if (entry) { reset(entry); void load(entry); } break; }
    }
  }

  const listeners = new AbortController();
  window.addEventListener('online', totals, { signal: listeners.signal });
  window.addEventListener('offline', totals, { signal: listeners.signal });
  host.addEventListener('click', onClick, { signal: listeners.signal });
  commitBar.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void submitCommit(); }, { signal: listeners.signal });
  commitInput.addEventListener('input', () => { revision++; totals(); }, { signal: listeners.signal });
  commitInput.addEventListener('keydown', event => {
    if (isImeKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommit(); }
  }, { signal: listeners.signal });

  render();
  return {
    presentation,
    dispatch,
    update(next, nextError, options) {
      if (disposed) return;
      const changed = next !== status && status !== null;
      if (JSON.stringify(next) !== JSON.stringify(status) || nextError !== error) revision++;
      status = next;
      error = nextError;
      render();
      if (options?.refetch === true) { clearTimeout(refetchTimer); refetchTimer = 0; refetch(); }
      else if (options?.refetch ?? changed) scheduleRefetch();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeActions(); disposeExtensions(); disposeLayout();
      window.removeEventListener('pandacode-components-change', refreshPresentation);
      listeners.abort();
      observer.disconnect();
      resizer.disconnect();
      clearTimeout(refetchTimer);
      cancelAnimationFrame(fitFrame);
      for (const entry of entries.values()) drop(entry);
      entries.clear();
      host.replaceChildren();
      host.classList.remove('changes-view');
    },
  };
}
