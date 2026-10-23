import './design-canvas.css';
import { escape, icon } from './dom';

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

  const args = (): Record<string, unknown> | null => { const c = host.context(); return c && { projectId: c.projectId, sessionId: c.sessionId }; };
  const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
  function place(): void {
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
    frame.addEventListener('load', () => measure(made));
    world.append(el);
    return made;
  }

  async function load(): Promise<void> {
    const context = args();
    const key = context ? `${context.projectId}:${context.sessionId ?? ''}` : '';
    if (key !== contextKey) { contextKey = key; boards.forEach(b => b.el.remove()); boards = []; comments = []; pick = null; fitted = false; }
    if (!context) { say('Open a project to see its designs.'); renderComments(); return; }
    try {
      const [listed, saved] = await Promise.all([host.call<Artboard[]>('design_list', context), host.call<DesignComment[]>('design_comments', context)]);
      if (key !== contextKey) return;
      const keep = new Map(boards.map(b => [b.name, b]));
      boards.filter(b => !listed.some(a => a.name === b.name)).forEach(b => b.el.remove());
      boards = listed.map(a => keep.get(a.name) ?? board(a.name));
      await Promise.all(listed.map(async (artboard, i) => {
        const target = boards[i];
        if (target.modified === artboard.modified && target.size === artboard.size) return;
        const html = await host.call<string>('design_read', { ...context, name: artboard.name });
        Object.assign(target, { modified: artboard.modified, size: artboard.size });
        if (html === target.html) return;
        target.html = html; target.width = artboardWidth(html);
        target.frame.srcdoc = html;
      }));
      if (key !== contextKey) return;
      comments = saved;
      layout();
      if (!fitted && boards.length) { fitted = true; fit(); }
      say(boards.length ? '' : 'No artboards yet. Ask the agent to design a screen; it saves HTML artboards in .pandacode/design/.');
    } catch (error) { say(failure(error)); }
    renderComments();
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
    list.innerHTML = form + (rows ? `<ol>${rows}</ol>` : commenting || pick ? '' : '<p class="design-hint">Turn on comment mode and click an element to comment on it.</p>');
    list.querySelector('textarea')?.focus();
    paintMarks();
  }
  async function save(next: DesignComment[]): Promise<void> {
    const context = args();
    if (!context) return;
    try { await host.call('design_save_comments', { ...context, comments: next }); comments = next; }
    catch (error) { host.notify(`Could not save design comments: ${failure(error)}`); }
    renderComments();
  }

  function choose(event: PointerEvent, hit: HTMLElement): void {
    const target = boards.find(b => b.name === hit.dataset.board);
    const doc = target?.frame.contentDocument;
    if (!target || !doc) return;
    const rect = hit.getBoundingClientRect();
    const x = (event.clientX - rect.left) / view.z, y = (event.clientY - rect.top) / view.z;
    const element = doc.elementFromPoint(x, y);
    if (!element) return;
    const box = element.getBoundingClientRect();
    pick = { artboard: target.name, selector: selectorPath(element), bbox: { x: box.x, y: box.y, width: box.width, height: box.height } };
    renderComments();
  }
  function setCommenting(on: boolean): void {
    commenting = on;
    tool('comment').setAttribute('aria-pressed', String(on));
    viewport.classList.toggle('design-commenting', on);
    if (!on) pick = null;
    renderComments();
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; viewport.classList.add('design-panning');
    view = { ...view, x: drag.vx + dx, y: drag.vy + dy }; place();
  });
  viewport.addEventListener('pointerup', event => {
    const moved = drag?.moved; drag = null; viewport.classList.remove('design-panning');
    if (moved || !commenting) return;
    // Captured pointers report the viewport; find what lies under the pointer.
    const hit = document.elementsFromPoint(event.clientX, event.clientY).find(el => el.classList.contains('design-hit')) as HTMLElement | undefined;
    if (hit) choose(event, hit);
  });
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY / 300), event.clientX - rect.left, event.clientY - rect.top);
    else if (event.shiftKey) { view = { ...view, x: view.x - (event.deltaX || event.deltaY) }; place(); }
    else { view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY }; place(); }
  }, { passive: false });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && (pick || commenting)) { event.stopPropagation(); if (pick) { pick = null; renderComments(); } else setCommenting(false); } });
  list.addEventListener('submit', event => {
    event.preventDefault();
    const text = list.querySelector('textarea')?.value.trim();
    if (!pick || !text) return;
    const comment: DesignComment = { id: crypto.randomUUID(), ...pick, text, status: 'open', createdAt: Date.now() };
    pick = null;
    void save([...comments, comment]);
  });
  root.addEventListener('click', event => {
    const el = (event.target as Element).closest<HTMLElement>('[data-design]');
    if (!el) return;
    const index = Number(el.dataset.index);
    switch (el.dataset.design) {
      case 'comment': setCommenting(!commenting); break;
      case 'in': zoom(1.25); break;
      case 'out': zoom(0.8); break;
      case 'fit': fit(); break;
      case 'refresh': void refresh(); break;
      case 'cancel': pick = null; renderComments(); break;
      case 'send': { const prompt = commentPrompt(comments); if (prompt) host.compose(prompt); break; }
      case 'toggle': void save(comments.map((c, i) => i === index ? { ...c, status: c.status === 'open' ? 'resolved' : 'open' } : c)); break;
      case 'delete': void save(comments.filter((_, i) => i !== index)); break;
    }
  });

  /** Reloads changed artboards and comments; hidden canvases wait until shown. */
  function refresh(): Promise<void> {
    if (!visible) { stale = true; return Promise.resolve(); }
    stale = false;
    return loading ??= load().finally(() => { loading = null; });
  }
  place();
  return {
    show(): void { visible = true; root.hidden = false; if (stale || contextKey !== (args() ? `${args()!.projectId}:${args()!.sessionId ?? ''}` : '')) void refresh(); },
    hide(): void { visible = false; root.hidden = true; },
    refresh,
  };
}
