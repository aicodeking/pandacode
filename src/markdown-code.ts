import { icon } from './dom';

const COPY_STYLE = ':host{display:block;position:relative}button{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:24px;height:24px;color:var(--muted);background:var(--panel);border:0;border-radius:5px;padding:0;cursor:pointer;opacity:0}svg{width:14px;height:14px}:host(:hover) button,button:focus-visible{opacity:1}button:hover{color:var(--text)}button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}@media (hover:none){button{opacity:1}}';

/** A code block with a copy button. The block stays in the light DOM (slotted), so app styles,
 * find-in-thread and streaming updates see it unchanged. No generative-view module or stylesheet is needed. */
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

if (typeof customElements !== 'undefined' && !customElements.get('pandacode-code')) customElements.define('pandacode-code', CodeBlock);
