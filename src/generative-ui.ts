/// <reference types="vite/client" />
import css from './generative-ui.css?inline';
import richCss from './rich-markdown.css?inline';
import { icon } from './dom';

/* Generative UI in threads. `renderMarkdown` wraps ```ui, ```chart, ```svg and ```html fences
 * in <pandacode-ui>; the fence source stays in the light DOM (so streaming reconciles and
 * morphs see plain text) and the view is drawn in a shadow root that survives them.
 * Nothing runs agent code: buttons only put a prompt in the composer for the user to send. */

let sheet: CSSStyleSheet | undefined;
/** One constructed sheet shared by every view; styles arrive with the element, so nothing reflows. */
export function generativeSheet(): CSSStyleSheet {
  if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(`${richCss}\n${css}`); }
  return sheet;
}

let library: Promise<typeof import('./generative-ui-components')> | undefined;
const components = () => (library ??= import('./generative-ui-components'));

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
    if (key === this.drawn) return;
    this.drawn = key;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [generativeSheet()];
    if (pending) { root.replaceChildren(placeholder()); return; }
    if (!root.firstChild) root.append(placeholder());
    try {
      const view = await (await components()).renderBlock(kind, source);
      if (this.drawn !== key) return;
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

const COPY_STYLE = ':host{display:block;position:relative}button{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:24px;height:24px;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:0;cursor:pointer;opacity:0}svg{width:14px;height:14px}:host(:hover) button,button:focus-visible{opacity:1}button:hover{color:var(--text)}button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}@media (hover:none){button{opacity:1}}';

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
