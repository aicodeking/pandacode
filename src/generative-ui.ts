/// <reference types="vite/client" />
import css from './generative-ui.css?inline';
import typeBase from './type-base.css?inline';
import shadowBase from './shadow-base.css?inline';
import richCss from './rich-markdown.css?inline';
import { icon } from './dom';
import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';

/* Generative UI in threads. `renderMarkdown` wraps ```ui, ```chart, ```svg and ```html fences
 * in <pandacode-ui>; the fence source stays in the light DOM (so streaming reconciles and
 * morphs see plain text) and the view is drawn in a shadow root that survives them.
 * Nothing runs agent code: buttons only put a prompt in the composer for the user to send. */

let sheet: CSSStyleSheet | undefined;
let mathSheetPromise: Promise<CSSStyleSheet> | undefined;
/** One constructed sheet shared by every view; styles arrive with the element, so nothing reflows. */
export function generativeSheet(): CSSStyleSheet {
  if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(`${typeBase}\n${shadowBase}\n${richCss}\n${css}`); }
  return sheet;
}
function loadKatexSheet(): Promise<CSSStyleSheet> {
  // A failed load is forgotten so the next view retries instead of reusing the rejection.
  return (mathSheetPromise ??= import('katex/dist/katex.min.css?inline').then(mod => {
    const next = new CSSStyleSheet();
    next.replaceSync(mod.default);
    return next;
  }).catch((error: unknown) => {
    mathSheetPromise = undefined;
    throw error;
  }));
}

let library: Promise<typeof import('./generative-ui-components')> | undefined;
const components = () => (library ??= import('./generative-ui-components'));

const NESTED_HOST = '.turn-card-reply,.bc-message-text,.launcher-thread-user,.md-admonition,blockquote';
const TIGHT_HOST = '.gh-job-summary,.agent-input-option,:is(.turn-card-reply,.bc-message-text,.launcher-thread-user) :is(blockquote,.md-admonition),:is(blockquote,.md-admonition) :is(blockquote,.md-admonition)';
const SHADOW_SURFACE = [...GU_CONTAINERS, '.gu-custom', '.rich-html'].join(',');

/** Dialog context crosses custom-view shadow roots just like surface nesting. */
function inDialog(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.tagName === 'DIALOG') return true;
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

type HostTier = 'tight' | 'nested' | '';
function hostTier(el: Element): HostTier {
  let depth = 0;
  let cur: Element | null = el;
  while (cur) {
    if (cur.closest(TIGHT_HOST) || cur.closest('.gu-tight-host')) return 'tight';
    const root = cur.getRootNode();
    let node: Element | null = cur === el ? cur.parentElement : cur;
    while (node) {
      if (node.matches(NESTED_HOST) || node.matches(SHADOW_SURFACE)) {
        if (++depth >= 2) return 'tight';
      }
      node = node.parentElement;
    }
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return depth === 1 ? 'nested' : '';
}

function markNested(view: Element | null | undefined, tier: HostTier, dialog: boolean): void {
  if (!view) return;
  view.classList.toggle('gu-dialog-host', dialog);
  view.classList.toggle('gu-tight-host', tier === 'tight');
  view.classList.toggle('gu-nested-host', tier === 'nested');
  markTightCustom(view);
}

class GenerativeView extends HTMLElement {
  static observedAttributes = ['class'];
  private drawn = '';
  private queued = false;
  connectedCallback(): void { this.schedule(); }
  attributeChangedCallback(): void { this.schedule(); }
  /** Streaming sets attributes before it updates children, so read the source a microtask later. */
  private schedule(): void {
    if (this.queued || !this.isConnected) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; void this.draw(); });
  }
  private async draw(): Promise<void> {
    const code = this.querySelector('code');
    const kind = (code?.className.match(/language-(\w+)/)?.[1] ?? 'ui').toLowerCase();
    const source = code?.textContent ?? '';
    const pending = this.classList.contains('pending');
    const key = `${pending}\u0000${kind}\u0000${source}`;
    const tier = hostTier(this);
    if (key === this.drawn) { markNested(this.shadowRoot?.firstElementChild, tier, inDialog(this)); return; }
    this.drawn = key;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [generativeSheet()];
    if (pending) {
      const note = placeholder();
      markNested(note, tier, inDialog(this));
      root.replaceChildren(note);
      return;
    }
    if (!root.firstChild) {
      const note = placeholder();
      markNested(note, tier, inDialog(this));
      root.append(note);
    }
    try {
      const view = await (await components()).renderBlock(kind, source, typeBase + shadowBase);
      if (this.drawn !== key) return;
      if (view.querySelector('.katex, .md-math, .md-math-block')) {
        try {
          const kSheet = await loadKatexSheet();
          if (this.drawn !== key) return;
          root.adoptedStyleSheets = [kSheet, generativeSheet()];
        } catch (error) {
          // Math still renders as text without KaTeX's sheet; keep the view rather than an error note.
          if (this.drawn !== key) return;
          console.warn('KaTeX styles could not be loaded', error);
          root.adoptedStyleSheets = [generativeSheet()];
        }
      }
      markNested(view, hostTier(this), inDialog(this));
      root.replaceChildren(view);
      // Agents also write HTML and SVG as examples: the light-DOM source (slotted, not copied) is one click away.
      if (kind === 'html' || kind === 'svg') root.append(sourceToggle());
    } catch {
      if (this.drawn === key) { const note = document.createElement('p'); note.className = 'gu-error'; note.textContent = 'This view could not be shown.'; root.replaceChildren(note); }
    }
  }
}

function sourceToggle(): HTMLElement {
  const details = document.createElement('details');
  details.className = 'gu-source';
  const summary = document.createElement('summary');
  summary.setAttribute('aria-label', 'Source');
  details.append(summary, document.createElement('slot'));
  return details;
}

function placeholder(): HTMLElement {
  const note = document.createElement('div');
  note.className = 'gu-pending';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-label', 'Building view');
  return note;
}

/** Puts `text` in the composer for the user to review and send; it is never sent from here. */
export function fillComposer(text: string): boolean {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (!prompt || prompt.disabled) return false;
  const current = prompt.value.trimEnd();
  prompt.value = current ? `${current}\n\n${text}` : text;
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  return true;
}

const COPY_STYLE = ':host{display:block;position:relative}button{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:24px;height:24px;font:inherit;color:var(--muted);background:var(--panel);border:0;border-radius:var(--code-copy-radius,var(--radius-chip));padding:0;cursor:pointer;opacity:0}svg{width:14px;height:14px}:host(:hover) button,button:focus-visible{opacity:1}button:hover{color:var(--text)}button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}@media (hover:none){button{opacity:1}}';

/** A code block with a copy button. The block stays in the light DOM (slotted), so app styles,
 * find-in-thread and streaming updates see it unchanged. */
class CodeBlock extends HTMLElement {
  connectedCallback(): void {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = COPY_STYLE;
    const copy = document.createElement('button');
    // Icon only: no text node, so the message's text (copy, find, selection) stays the code alone.
    const show = (label: string, symbol: string) => { copy.setAttribute('aria-label', label); copy.title = label; copy.innerHTML = icon(symbol); };
    copy.type = 'button'; show('Copy code', 'copy');
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.querySelector('code')?.textContent ?? '')
        .then(() => show('Copied', 'check'), () => show('Copy failed', 'alert'))
        .finally(() => setTimeout(() => show('Copy code', 'copy'), 1500));
    });
    root.append(style, document.createElement('slot'), copy);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('pandacode-ui')) {
  customElements.define('pandacode-ui', GenerativeView);
  customElements.define('pandacode-code', CodeBlock);
  // Load the component library while the app is idle, before the first view needs it.
  setTimeout(() => { void components().catch(() => { library = undefined; }); }, 1500);
}
