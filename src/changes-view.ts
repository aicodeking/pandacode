import type { GitFile, GitStatus } from './types';
import type { DiffViewerController } from './diff-viewer';
import { escape, fileIcon, icon } from './dom';
import './changes-view.css';

export interface ChangesViewDeps {
  loadDiff(path: string, staged: boolean): Promise<string>;
  stage(paths: string[], staged: boolean): Promise<void>;
  commit(message: string): Promise<void>;
  openFile(path: string): void;
  refresh(): void;
  notify(message: string): void;
  choose(anchor: HTMLElement, title: string, items: { id: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; selected?: boolean }[], onSelect: (id: string) => void): void;
  /** When given, the … menu offers to move the work into an isolated worktree. */
  worktree?(): void;
}
export interface ChangesView {
  /** Re-renders from `status`. Loaded patches are quietly refetched (at most once a second) when
   * `status` is a new object, or always/never with an explicit `refetch`; a viewer re-mounts only
   * when its patch text changed. */
  update(status: GitStatus | null, error?: string, options?: { refetch?: boolean }): void;
  dispose(): void;
}

type Scope = 'all' | 'unstaged' | 'staged';
type Load = 'idle' | 'loading' | 'loaded' | 'error';
interface Entry {
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
    commitSubmit.disabled = committing || !stagedFiles().length || !commitInput.value.trim();
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
      entry.body.innerHTML = `<div class="cv-placeholder cv-error">${icon('alert')}<span>${escape(reason instanceof Error ? reason.message : String(reason || 'Unable to load diff'))}</span><button type="button" class="cv-link" data-cv-action="retry-file">Retry</button></div>`;
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
        entry = { path: file.path, staged, sig, code: '', el, body: el.querySelector('.cv-file-body')!, stat: el.querySelector('.cv-stat')!, load: 'idle', token: 0, raw: '', patch: '', adds: 0, dels: 0, stale: [] };
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
    if (folded) collapsed.add(path); else collapsed.delete(path);
    const entry = entries.get(path);
    if (entry) paint(entry, entry.code);
  }

  async function run(task: Promise<void>, failure: string): Promise<void> {
    try { await task; } catch (reason) { deps.notify(reason instanceof Error && reason.message ? reason.message : failure); }
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
    if (!text || committing || !stagedFiles().length) return;
    committing = true;
    totals();
    try {
      await deps.commit(text);
      if (!disposed) closeCommit();
    } catch (reason) {
      deps.notify(reason instanceof Error && reason.message ? reason.message : 'Commit failed');
    } finally {
      committing = false;
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
    deps.choose(anchor, path, items, id => {
      if (id === 'stage' || id === 'unstage') void run(deps.stage([path], id === 'stage'), id === 'stage' ? 'Unable to stage file' : 'Unable to unstage file');
      else if (id === 'open') deps.openFile(path);
      else if (id === 'copy') copy(path);
    });
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
        deps.choose(target, 'Changes', [
          { id: 'stage-all', label: 'Stage all', icon: 'plus', disabled: !unstaged.length },
          { id: 'unstage-all', label: 'Unstage all', icon: 'minimize', disabled: !staged.length },
          { id: 'commit', label: 'Commit…', icon: 'check', disabled: !status?.isRepo },
          { id: 'refresh', label: 'Refresh', icon: 'refresh' },
          ...(deps.worktree ? [{ id: 'worktree', label: 'Create isolated worktree…', icon: 'branch' }] : []),
        ], id => {
          if (id === 'stage-all' && unstaged.length) void run(deps.stage(unstaged, true), 'Unable to stage files');
          else if (id === 'unstage-all' && staged.length) void run(deps.stage(staged, false), 'Unable to unstage files');
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
  host.addEventListener('click', onClick, { signal: listeners.signal });
  commitBar.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void submitCommit(); }, { signal: listeners.signal });
  commitInput.addEventListener('input', totals, { signal: listeners.signal });
  commitInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommit(); }
  }, { signal: listeners.signal });

  render();
  return {
    update(next, nextError, options) {
      if (disposed) return;
      const changed = next !== status && status !== null;
      status = next;
      error = nextError;
      render();
      if (options?.refetch === true) { clearTimeout(refetchTimer); refetchTimer = 0; refetch(); }
      else if (options?.refetch ?? changed) scheduleRefetch();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
