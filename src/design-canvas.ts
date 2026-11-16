import './design-canvas.css';
import { escape, icon, isImeKey } from './dom';
import { createDesignPresentation, snapshotDesign, type DesignPresentation, type DesignControl, type DesignAction } from './extensions/design';
import { applyDesignPresentation, componentSelection, componentProviders } from './extensions/replacement';
import { extensionsSnapshot, onExtensionsChanged } from './extensions/manager';
import { applyControlOrder, applyControlVisibility, layout as extensionLayout } from './extensions/layout-host';
import { DESIGN_CONTROLS } from './extensions/surfaces';
import { mountExtensionActions } from './extensions/header';
import { openContextActions } from './extensions/context-actions';
import { errorText } from './error-text';

/* The inspector's Design view: a pan/zoom canvas of the task's artboards
 * (`.pandacode/design/*.html`), each in a sandboxed iframe that runs no scripts.
 * Clicking an element in comment mode pins a comment to it; the agent reads them
 * through pandacode_design_comments and resolves them. */

export type Artboard = { name: string; path: string; size: number; modified: number };
export type Bbox = { x: number; y: number; width: number; height: number };
export type DesignComment = { id: string; artboard: string; selector: string; bbox: Bbox; text: string; status: 'open' | 'resolved'; createdAt: number; note?: string };
export type DesignContext = { projectId: string; sessionId: string | null };
export type DesignHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(text: string): void;
  notifyError?(text: string): void;
  /** The selected project and task, or null when none is open. */
  context(): DesignContext | null;
  /** Put a prompt in the composer without sending it. */
  compose(prompt: string): void;
};

const GAP = 80, WIDTH = 1280, HEIGHT = 800, MAX_HEIGHT = 6000, MIN_ZOOM = 0.05, MAX_ZOOM = 4;
type Board = { name: string; size: number; modified: number; html: string; x: number; width: number; height: number; el: HTMLElement; frame: HTMLIFrameElement };
type Pick = { artboard: string; selector: string; bbox: Bbox };

/** A CSS path from `body` that names one element: ids when unique, else nth-of-type. */
export function selectorPath(element: Element): string {
  const parts: string[] = [];
  for (let el: Element | null = element; el && el.tagName !== 'HTML'; el = el.parentElement) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body') { parts.unshift('body'); break; }
    if (el.id && el.ownerDocument.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
    const same = el.parentElement ? [...el.parentElement.children].filter(c => c.tagName === el!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag);
  }
  return parts.join(' > ');
}

/** The prompt "Send comments to agent" puts in the composer. */
export function commentPrompt(comments: DesignComment[]): string {
  const open = comments.filter(c => c.status === 'open');
  if (!open.length) return '';
  const lines = open.map((c, i) => `${i + 1}. [${c.id}] .pandacode/design/${c.artboard}, element \`${c.selector}\` (x ${Math.round(c.bbox.x)}, y ${Math.round(c.bbox.y)}, ${Math.round(c.bbox.width)}×${Math.round(c.bbox.height)}): ${c.text.trim()}`);
  return `Please address my design comments on the Design canvas artboards. Edit each artboard, then call pandacode_design_resolve with the comment id (and a short note).\n\n${lines.join('\n')}`;
}

/** Width an artboard asks for with `<meta name="artboard-width" content="390">`. */
export function artboardWidth(html: string): number {
  const match = /<meta[^>]+name=["']artboard-width["'][^>]+content=["'](\d{2,4})["']/i.exec(html);
  return match ? Math.min(Math.max(Number(match[1]), 200), 3000) : WIDTH;
}

export function mountDesignCanvas(root: HTMLElement, host: DesignHost) {
  root.innerHTML = `<div class="design-toolbar" role="toolbar" aria-label="Design canvas">
      <button type="button" class="icon-button" data-design="comment" aria-pressed="false" aria-label="Comment on an element" title="Comment: click an element">${icon('chat')}</button>
      <button type="button" class="icon-button" data-design="out" aria-label="Zoom out" title="Zoom out">${icon('minimize')}</button>
      <button type="button" class="design-zoom" data-design="fit" aria-label="Fit artboards" title="Fit artboards">100%</button>
      <button type="button" class="icon-button" data-design="in" aria-label="Zoom in" title="Zoom in">${icon('plus')}</button>
      <button type="button" class="icon-button" data-design="refresh" aria-label="Reload artboards" title="Reload artboards">${icon('refresh')}</button>
      <button type="button" class="secondary-button design-send" data-design="send" disabled>Send comments to agent</button>
    </div>
    <div class="design-viewport" tabindex="0" aria-label="Artboards. Drag to pan, Shift-scroll to pan horizontally, or pinch and Ctrl/Command-scroll to zoom.">
      <div class="design-world"></div>
      <div class="design-empty" hidden></div>
    </div>
    <section class="design-comments" aria-label="Design comments"></section>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const viewport = $('.design-viewport'), world = $('.design-world'), empty = $('.design-empty'), list = $('.design-comments');
  const tool = (name: string) => $<HTMLButtonElement>(`[data-design="${name}"]`);
  let boards: Board[] = [], comments: DesignComment[] = [], view = { x: 40, y: 60, z: 0.5 }, fitted = false;
  let visible = false, stale = true, contextKey = '', commenting = false, pick: Pick | null = null, loading: Promise<void> | null = null;
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  let revision = 0, selection = '', pickVersion = '', busy = false, savingKey = '', disposed = false, draftVersion = 0, commentsEpoch = 0;
  const context = crypto.randomUUID(), handles = new Map<string, string>(), applied = new Set<string>();
  const handle = (key: string): string => { if (!handles.has(key)) handles.set(key, crypto.randomUUID()); return handles.get(key)!; };
  const versions = new Map<string, { signature: string; revision: string }>();
  const resourceVersion = (key: string, signature: string): string => {
    if (versions.get(key)?.signature !== signature) versions.set(key, { signature, revision: crypto.randomUUID() });
    return versions.get(key)!.revision;
  };
  let closeContext: (() => void) | undefined;
  const lifetime = new AbortController(), listener = { signal: lifetime.signal };
  const currentKey = () => { const c = host.context(); return c ? `${c.projectId}:${c.sessionId ?? ''}` : ''; };

  const args = (): Record<string, unknown> | null => { const c = host.context(); return c && { projectId: c.projectId, sessionId: c.sessionId }; };
  function place(): void {
    revision++;
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    world.style.setProperty('--inverse', String(1 / view.z));
    tool('fit').textContent = `${Math.round(view.z * 100)}%`;
  }
  function zoom(factor: number, px = viewport.clientWidth / 2, py = viewport.clientHeight / 2): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * factor));
    view = { x: px - (px - view.x) * z / view.z, y: py - (py - view.y) * z / view.z, z };
    place();
  }
  function fit(): void {
    const last = boards.at(-1);
    if (!last) return;
    const width = last.x + last.width, height = Math.max(...boards.map(b => b.height)) + 40;
    const z = Math.min(1, (viewport.clientWidth - 48) / width, (viewport.clientHeight - 48) / height) || 0.5;
    view = { x: Math.max(24, (viewport.clientWidth - width * z) / 2), y: 24 + 28 * z, z: Math.max(MIN_ZOOM, z) };
    place();
  }

  function layout(): void {
    let x = 0;
    for (const board of boards) { board.x = x; board.el.style.left = `${x}px`; board.el.style.width = `${board.width}px`; board.frame.style.height = `${board.height}px`; x += board.width + GAP; }
    paintMarks();
  }
  function measure(board: Board): void {
    const doc = board.frame.contentDocument;
    if (!doc?.documentElement) return;
    const height = Math.min(MAX_HEIGHT, Math.max(200, doc.documentElement.scrollHeight));
    if (height !== board.height) { board.height = height; layout(); }
  }
  function board(name: string): Board {
    const el = document.createElement('article');
    el.className = 'design-board';
    el.innerHTML = `<header class="design-board-name">${escape(name)}</header><div class="design-board-body"><iframe sandbox="allow-same-origin" referrerpolicy="no-referrer" tabindex="-1" title="${escape(name)}"></iframe><div class="design-hit" data-board="${escape(name)}"></div></div>`;
    const frame = el.querySelector('iframe')!;
    const made: Board = { name, size: -1, modified: -1, html: '', x: 0, width: WIDTH, height: HEIGHT, el, frame };
    frame.addEventListener('load', () => measure(made), listener);
    if (!visible) frame.remove();
    world.append(el);
    return made;
  }
  /** A hidden canvas drops its artboard documents; showing it reinserts each iframe, which reloads its srcdoc. */
  function attachFrames(on: boolean): void {
    for (const b of boards) if (!on) b.frame.remove(); else if (!b.frame.isConnected) b.el.querySelector('.design-board-body')!.prepend(b.frame);
  }

  async function load(): Promise<void> {
    const context = args();
    const key = context ? `${context.projectId}:${context.sessionId ?? ''}` : '';
    const epoch = commentsEpoch, pending = busy && savingKey === key;
    if (key !== contextKey) { contextKey = key; boards.forEach(b => b.el.remove()); boards = []; comments = []; pick = null; selection = ''; list.replaceChildren(); fitted = false; revision++; }
    if (!context) { say('Open a project to see its designs.'); renderComments(); return; }
    try {
      const [listed, saved] = await Promise.all([host.call<Artboard[]>('design_list', context), host.call<DesignComment[]>('design_comments', context)]);
      if (disposed || key !== contextKey || key !== currentKey()) return;
      const keep = new Map(boards.map(b => [b.name, b]));
      boards.filter(b => !listed.some(a => a.name === b.name)).forEach(b => b.el.remove());
      boards = listed.map(a => keep.get(a.name) ?? board(a.name));
      await Promise.all(listed.map(async (artboard, i) => {
        const target = boards[i];
        if (target.modified === artboard.modified && target.size === artboard.size) return;
        const html = await host.call<string>('design_read', { ...context, name: artboard.name });
        if (disposed || key !== contextKey || key !== currentKey()) return;
        Object.assign(target, { modified: artboard.modified, size: artboard.size });
        if (html === target.html) return;
        target.html = html; target.width = artboardWidth(html);
        target.frame.srcdoc = html;
      }));
      if (disposed || key !== contextKey || key !== currentKey()) return;
      if (epoch === commentsEpoch && !pending && (!busy || savingKey !== key)) comments = saved;
      revision++;
      layout();
      if (!fitted && boards.length) { fitted = true; fit(); }
      say(boards.length ? '' : 'No artboards yet. Ask the agent to design a screen; it saves HTML artboards in .pandacode/design/.');
    } catch (error) { if (!disposed && key === contextKey && key === currentKey()) say(errorText(error)); }
    if (key === contextKey && key === currentKey()) renderComments();
  }
  function say(text: string): void { empty.textContent = text; empty.hidden = !text; }

  function boxHtml(cls: string, b: Board, box: Bbox, attrs = ''): string {
    return `<div class="${cls}" ${attrs} style="left:${b.x + box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px"></div>`;
  }
  function paintMarks(): void {
    world.querySelectorAll('.design-mark, .design-pick').forEach(el => el.remove());
    const at = (name: string) => boards.find(b => b.name === name);
    const marks = comments.filter(c => c.status === 'open').map((c, i) => {
      const b = at(c.artboard);
      return b ? boxHtml('design-mark', b, c.bbox, `data-comment="${escape(c.id)}" data-number="${i + 1}"`) : '';
    });
    const picked = pick && at(pick.artboard);
    world.insertAdjacentHTML('beforeend', marks.join('') + (picked ? boxHtml('design-pick', picked, pick!.bbox) : ''));
  }
  function renderComments(): void {
    if (disposed) return;
    const previous = list.querySelector<HTMLFormElement>('.design-new');
    const retain = previous?.dataset.selection === selection && Boolean(pick);
    const open = comments.filter(c => c.status === 'open');
    tool('send').disabled = !open.length;
    tool('send').textContent = open.length ? `Send ${open.length} comment${open.length === 1 ? '' : 's'} to agent` : 'Send comments to agent';
    const form = pick ? `<form class="design-new"><label class="sr-only" for="design-comment-text">Comment on ${escape(pick.selector)}</label>
      <textarea id="design-comment-text" rows="2" maxlength="4000" placeholder="Comment on ${escape(pick.selector)}"></textarea>
      <div><button type="button" class="secondary-button" data-design="cancel">Cancel</button><button type="submit" class="primary-button">Add comment</button></div></form>` : '';
    const rows = comments.map((c, i) => `<li class="design-comment${c.status === 'resolved' ? ' resolved' : ''}" data-comment="${escape(c.id)}">
      <span class="design-comment-number">${c.status === 'open' ? open.indexOf(c) + 1 : icon('check')}</span>
      <div><p>${escape(c.text)}</p><small>${escape(c.artboard)} · <code>${escape(c.selector)}</code></small>${c.note ? `<small class="design-note">${escape(c.note)}</small>` : ''}</div>
      <button type="button" class="icon-button" data-design="toggle" data-index="${i}" aria-label="${c.status === 'open' ? 'Resolve' : 'Reopen'} comment" title="${c.status === 'open' ? 'Resolve' : 'Reopen'}">${icon(c.status === 'open' ? 'check' : 'refresh')}</button>
      <button type="button" class="icon-button" data-design="delete" data-index="${i}" aria-label="Delete comment" title="Delete">${icon('trash')}</button></li>`).join('');
    const content = rows ? `<ol>${rows}</ol>` : commenting || pick ? '' : '<p class="design-hint">Turn on comment mode and click an element to comment on it.</p>';
    if (retain && previous) { [...list.children].filter(node => node !== previous).forEach(node => node.remove()); list.insertAdjacentHTML('beforeend', content); }
    else list.innerHTML = form + content;
    const nextForm = list.querySelector<HTMLFormElement>('.design-new');
    if (nextForm) nextForm.dataset.selection = selection;
    if (!retain) list.querySelector('textarea')?.focus();
    list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
    const submit = list.querySelector<HTMLButtonElement>('[type="submit"]');
    if (submit && !validPick()) { submit.disabled = true; submit.title = 'Artboard changed; select an element again. Your draft is retained.'; }
    configureControls();
    paintMarks();
  }
  async function save(next: DesignComment[], added = false): Promise<void> {
    const context = args();
    if (!context || busy || currentKey() !== contextKey) return;
    const key = contextKey, selected = selection, version = draftVersion;
    busy = true; savingKey = key; commentsEpoch++; renderComments();
    try {
      await host.call('design_save_comments', { ...context, comments: next });
      if (key === contextKey && key === currentKey()) {
        comments = next; revision++; commentsEpoch++;
        if (added && selection === selected && version === draftVersion) { pick = null; selection = ''; }
      }
    }
    catch (error) { if (!disposed) (host.notifyError ?? host.notify)(`Could not save design comments: ${errorText(error)}`); }
    finally { busy = false; savingKey = ''; }
    renderComments();
  }

  function choose(event: PointerEvent, hit: HTMLElement): void {
    const target = boards.find(b => b.name === hit.dataset.board);
    const doc = target?.frame.contentDocument;
    if (!target || !doc) return;
    const rect = hit.getBoundingClientRect();
    const x = (event.clientX - rect.left) / view.z, y = (event.clientY - rect.top) / view.z;
    chooseAt(target, x, y);
  }
  function chooseAt(target: Board, x: number, y: number): void {
    if (busy || x < 0 || x > target.width || y < 0 || y > target.height) return;
    const element = target.frame.contentDocument?.elementFromPoint(x, y);
    if (!element) return;
    const box = element.getBoundingClientRect();
    pick = { artboard: target.name, selector: selectorPath(element), bbox: { x: box.x, y: box.y, width: box.width, height: box.height } };
    selection = crypto.randomUUID(); revision++;
    pickVersion = `${target.modified}:${target.size}`;
    renderComments();
  }
  function validPick(): boolean {
    const b = boards.find(b => b.name === pick?.artboard);
    return Boolean(b && pickVersion === `${b.modified}:${b.size}`);
  }
  function setCommenting(on: boolean): void {
    if (busy) return;
    revision++;
    commenting = on;
    tool('comment').setAttribute('aria-pressed', String(on));
    viewport.classList.toggle('design-commenting', on);
    if (!on) { pick = null; selection = ''; }
    renderComments();
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    viewport.setPointerCapture(event.pointerId);
  }, listener);
  viewport.addEventListener('pointermove', event => {
    if (!drag || !controlVisible('pan')) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; viewport.classList.add('design-panning');
    view = { ...view, x: drag.vx + dx, y: drag.vy + dy }; place();
  }, listener);
  viewport.addEventListener('pointerup', event => {
    const moved = drag?.moved; drag = null; viewport.classList.remove('design-panning');
    if (moved || !commenting || !controlVisible('select')) return;
    // Captured pointers report the viewport; find what lies under the pointer.
    const hit = document.elementsFromPoint(event.clientX, event.clientY).find(el => el.classList.contains('design-hit')) as HTMLElement | undefined;
    if (hit) choose(event, hit);
  }, listener);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    if (!controlVisible(event.ctrlKey || event.metaKey ? event.deltaY < 0 ? 'in' : 'out' : 'pan')) return;
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY / 300), event.clientX - rect.left, event.clientY - rect.top);
    else if (event.shiftKey) { view = { ...view, x: view.x - (event.deltaX || event.deltaY) }; place(); }
    else { view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY }; place(); }
  }, { ...listener, passive: false });
  root.addEventListener('keydown', event => { if (!isImeKey(event) && !busy && event.key === 'Escape' && (pick || commenting)) { event.stopPropagation(); if (pick) { pick = null; selection = ''; revision++; renderComments(); } else setCommenting(false); } }, listener);
  list.addEventListener('input', () => { draftVersion++; revision++; }, listener);
  list.addEventListener('submit', event => {
    event.preventDefault();
    const text = list.querySelector('textarea')?.value.trim();
    if (!pick || !text || busy || !validPick()) return;
    const comment: DesignComment = { id: crypto.randomUUID(), ...pick, text, status: 'open', createdAt: Date.now() };
    void save([...comments, comment], true);
  }, listener);
  root.addEventListener('click', event => {
    const el = (event.target as Element).closest<HTMLElement>('[data-design]');
    if (!el) return;
    perform(el.dataset.design!, Number(el.dataset.index));
  }, listener);
  function perform(id: string, index = -1): void {
    if (busy && !['in', 'out', 'fit'].includes(id)) return;
    switch (id) {
      case 'comment': setCommenting(!commenting); break;
      case 'in': zoom(1.25); break;
      case 'out': zoom(0.8); break;
      case 'fit': fit(); break;
      case 'refresh': void refresh(); break;
      case 'cancel': pick = null; selection = ''; revision++; renderComments(); break;
      case 'send': { const prompt = commentPrompt(comments); if (prompt) host.compose(prompt); break; }
      case 'toggle': void save(comments.map((c, i) => i === index ? { ...c, status: c.status === 'open' ? 'resolved' : 'open' } : c)); break;
      case 'delete': void save(comments.filter((_, i) => i !== index)); break;
    }
  }

  /** Reloads changed artboards and comments; hidden canvases wait until shown. */
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!visible) { stale = true; return Promise.resolve(); }
    stale = false;
    return loading ??= load().finally(() => { loading = null; if (visible && !disposed && contextKey !== currentKey()) void refresh(); });
  }
  function authority() {
    const provider = componentSelection.resolve('panda.design', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.manifest.id === provider?.id.split('/')[0]);
    return { owner: provider?.id ?? '', active: !disposed && Boolean(provider && root.dataset.designProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.summary')) };
  }
  function presentation(): DesignPresentation {
    const c = host.context();
    const controls = DESIGN_CONTROLS['panda.design.controls'].map(([id]) => {
      const available = id === 'save' ? validPick() && Boolean(list.querySelector<HTMLTextAreaElement>('textarea')?.value.trim())
        : id === 'draft' || id === 'cancel' ? Boolean(pick)
        : id === 'select' ? commenting && boards.length > 0
        : id === 'compose' ? comments.some(c => c.status === 'open')
        : ['resolve', 'reopen', 'delete'].includes(id) ? comments.length > 0 : true;
      return { id, enabled: controlVisible(id) && available };
    });
    return snapshotDesign({
      contractVersion: 1, context, project: c ? handle(`project:${c.projectId}`) : '', session: c?.sessionId ? handle(`session:${c.sessionId}`) : '',
      revision, selection, visible: visible && !disposed && contextKey === currentKey(), busy, loading: Boolean(loading),
      error: empty.hidden ? '' : 'Design unavailable or empty', commenting, draft: Boolean(list.querySelector<HTMLTextAreaElement>('textarea')?.value),
      artboards: boards.slice(0, 100).map(b => ({ id: handle(`board:${contextKey}:${b.name}`), revision: resourceVersion(`board:${contextKey}:${b.name}`, `${b.modified}:${b.size}`), label: authority().metadata ? b.name.slice(0, 256) : '' })),
      comments: comments.slice(0, 500).map(c => ({ id: handle(`comment:${contextKey}:${c.id}`), revision: resourceVersion(`comment:${contextKey}:${c.id}`, JSON.stringify(c)), artboard: handle(`board:${contextKey}:${c.artboard}`), status: c.status })), controls,
    });
  }
  function dispatch(input: unknown) {
    const auth = authority(), slot = createDesignPresentation(presentation(), auth.owner, presentation, authority, executeAction, applied);
    const result = slot.dispatch(input); slot.dispose(); return result;
  }
  function executeAction(action: DesignAction): void {
    const index = comments.findIndex(c => handle(`comment:${contextKey}:${c.id}`) === action.comment);
    switch (action.controlId) {
      case 'select': { const b = boards.find(b => handle(`board:${contextKey}:${b.name}`) === action.artboard); if (b) chooseAt(b, action.x, action.y); break; }
      case 'pan': view = { ...view, x: view.x + (action.value === 'left' ? 80 : action.value === 'right' ? -80 : 0), y: view.y + (action.value === 'up' ? 80 : action.value === 'down' ? -80 : 0) }; place(); break;
      case 'draft': list.querySelector('textarea')?.focus(); break;
      case 'save': list.querySelector<HTMLFormElement>('form')?.requestSubmit(); break;
      case 'resolve': case 'reopen': perform('toggle', index); break;
      case 'compose': perform('send'); break;
      default: perform(action.controlId, index);
    }
  }
  const controlVisible = (id: string) => extensionsSnapshot().safeMode || !extensionLayout.isHidden(`panda.design.controls/${id}`, host.context()?.projectId);
  function configureControls(): void {
    const bindings: [string, HTMLElement][] = [];
    root.querySelectorAll<HTMLElement>('[data-design], .design-new textarea, .design-new button[type="submit"]').forEach(node => {
      const id = node.matches('textarea') ? 'draft' : node.matches('[type="submit"]') ? 'save' : node.dataset.design === 'send' ? 'compose' : node.dataset.design === 'toggle' ? comments[Number(node.dataset.index)]?.status === 'open' ? 'resolve' : 'reopen' : node.dataset.design!;
      bindings.push([`panda.design.controls/${id}`, node]);
    });
    applyControlOrder('panda.design.controls', bindings); applyControlVisibility(bindings, () => viewport);
  }
  function configure(): void { if (disposed) return; revision++; closeContext?.(); applyDesignPresentation(root); configureControls(); }
  const stopExtensions = onExtensionsChanged(configure), stopLayout = extensionLayout.subscribe(configure);
  window.addEventListener('pandacode-components-change', configure);
  const actionContext = () => ({ projectId: host.context()?.projectId ?? '', sessionId: host.context()?.sessionId ?? '', revision, selection: { kind: 'design', ids: selection ? [selection] : [] } });
  const stopActions = mountExtensionActions($('.design-toolbar'), 'panda.design.actions', actionContext, host.notify);
  const hasContext = () => !extensionsSnapshot().safeMode && extensionsSnapshot().packages.some(item => item.enabled && item.manifest.permissions?.includes('ui.contribute') && item.manifest.contributes.menus?.some(menu => menu.location === 'panda.design.context'));
  function openContext(anchor: HTMLElement, point?: { x: number; y: number }, comment?: string): void {
    closeContext?.(); const captured = revision, key = currentKey();
    const context = actionContext();
    if (comment) context.selection.ids = [handle(`comment:${contextKey}:${comment}`)];
    closeContext = openContextActions(anchor, 'panda.design.context', context, { title: 'Design', items: [], onSelect() {}, notify: host.notify, point, isAlive: () => visible && !disposed && captured === revision && key === currentKey() });
  }
  root.addEventListener('contextmenu', event => { if (hasContext() && (event.target as Element).closest('.design-toolbar, .design-comments')) { event.preventDefault(); openContext(tool('comment'), { x: event.clientX, y: event.clientY }, (event.target as Element).closest<HTMLElement>('[data-comment]')?.dataset.comment); } }, listener);
  tool('comment').addEventListener('keydown', event => { if (!isImeKey(event) && hasContext() && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) { event.preventDefault(); event.stopPropagation(); openContext(tool('comment')); } }, listener);
  configure();
  place();
  return {
    presentation, dispatch,
    show(): void { if (disposed) return; visible = true; root.hidden = false; attachFrames(true); if (stale || contextKey !== (args() ? `${args()!.projectId}:${args()!.sessionId ?? ''}` : '')) void refresh(); },
    hide(): void { visible = false; root.hidden = true; attachFrames(false); closeContext?.(); },
    refresh,
    dispose(): void { disposed = true; lifetime.abort(); stopExtensions(); stopLayout(); stopActions(); closeContext?.(); window.removeEventListener('pandacode-components-change', configure); attachFrames(false); },
  };
}
