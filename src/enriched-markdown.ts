/** Markdown through Software Mansion's Enriched Markdown engine: the md4c parser it ships
 * for the web (vendored WebAssembly, see src/vendor/enriched-markdown), rendered to HTML
 * with the node set its web renderer supports. Math renders through KaTeX on demand. */

import { brandFor } from './trace-brands.ts';

type NodeType =
  | 'Document' | 'Paragraph' | 'Text' | 'Link' | 'Heading' | 'LineBreak' | 'SoftBreak' | 'Strong' | 'Emphasis'
  | 'Strikethrough' | 'Underline' | 'Superscript' | 'Subscript' | 'Highlight' | 'Code' | 'Image' | 'Blockquote'
  | 'UnorderedList' | 'OrderedList' | 'ListItem' | 'CodeBlock' | 'ThematicBreak' | 'Table' | 'TableHead' | 'TableBody'
  | 'TableRow' | 'TableHeaderCell' | 'TableCell' | 'LatexMathInline' | 'LatexMathDisplay' | 'BlankLine' | 'Admonition' | 'Video';
export interface MarkdownNode {
  type: NodeType;
  content?: string;
  attributes?: { level?: string; url?: string; title?: string; language?: string; isTask?: string; taskChecked?: string; admonitionType?: string; align?: string; start?: string; tight?: string };
  children?: MarkdownNode[];
}
export interface RenderOptions {
  /** Rewrites a link target before it is written, e.g. file: URLs into workspace paths. */
  link?: (url: string) => string;
}

type Parse = (markdown: string, ...flags: number[]) => string;
interface Engine { parse: Parse; memory?: WebAssembly.Memory }

/** WebAssembly memory only grows, so a parser past this is dropped and the next parse starts a fresh one. */
export const MEMORY_CAP = 64 * 1024 * 1024;
/** Inputs longer than this parse in a throwaway instance, so the long-lived one never grows for them. */
export const LARGE_INPUT = 512 * 1024;

type Factory = (options?: { instantiateWasm?: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => object }) =>
  Promise<{ cwrap: (name: string, returns: string, args: string[]) => Parse }>;

// The vendored glue keeps its wasm bytes private, so the compiled module is read once from the one
// instantiate its first start makes; the patch is in place only for that start, never two at once.
let compiled: Promise<WebAssembly.Module> | undefined;
function compiledModule(factory: Factory): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    const instantiate = WebAssembly.instantiate;
    let found: WebAssembly.Module | undefined;
    WebAssembly.instantiate = (async (...args: unknown[]) => {
      const result = await (instantiate as (...a: unknown[]) => Promise<WebAssembly.WebAssemblyInstantiatedSource>).apply(WebAssembly, args);
      if (result.instance?.exports?.parseMarkdown) found = result.module;
      return result;
    }) as typeof instantiate;
    try { await factory(); } finally { WebAssembly.instantiate = instantiate; }
    if (!found) throw new Error('Markdown engine did not start.');
    return found;
  })().catch(error => { compiled = undefined; throw error; });
  return compiled;
}

// Every engine instantiates the cached module through the glue's own hook, so its memory is read
// straight from the instance and nothing global changes. Re-creating costs about 1 ms.
async function createEngine(): Promise<Engine> {
  const factory = (await import('./vendor/enriched-markdown/md4c.js')).default as Factory;
  const module = await compiledModule(factory);
  let memory: WebAssembly.Memory | undefined;
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  const wasm = await Promise.race([failed, factory({
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(module, imports).then(instance => {
        if (instance.exports.memory instanceof WebAssembly.Memory) memory = instance.exports.memory;
        receive(instance);
      }, fail);
      return {};
    },
  })]);
  return { memory, parse: wasm.cwrap('parseMarkdown', 'string', ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']) };
}

let engine: Promise<Engine> | undefined;
function load(): Promise<Engine> {
  engine ??= createEngine().catch(error => { engine = undefined; throw error; });
  return engine;
}

/** Bytes held by the long-lived parser's memory (0 before it loads). */
export async function parserMemory(): Promise<number> {
  return engine ? (await engine).memory?.buffer.byteLength ?? 0 : 0;
}

/** CommonMark with GitHub extensions, LaTeX math and admonitions; no syntax that changes
 * the meaning of ordinary agent text (`_underline_`, `^sup^`, `~sub~`, `==mark==`). */
export async function parseMarkdown(markdown: string): Promise<MarkdownNode> {
  const large = markdown.length > LARGE_INPUT;
  const pending = large ? createEngine() : load();
  const current = await pending;
  // underline, latexMath, superscript, subscript, highlight, hardSoftBreaks, preserveBlankLines, admonitions
  const json = current.parse(markdown, 0, 1, 0, 0, 0, 0, 0, 1);
  if (engine === pending && (current.memory?.buffer.byteLength ?? 0) > MEMORY_CAP) engine = undefined;
  const node = JSON.parse(json) as MarkdownNode;
  if (!node || typeof node.type !== 'string') throw new Error('Markdown could not be parsed.');
  return node;
}

const escapeText = (text: string) => text.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');
const text = (node: MarkdownNode): string => node.content ?? (node.children ?? []).map(text).join('');
const ADMONITIONS: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
const ALIGN = new Set(['left', 'center', 'right']);
const GENERATIVE = new Set(['ui', 'chart', 'svg', 'html', 'mermaid']);
// Raw HTML is text to md4c; these collapsibles are the one HTML form agents rely on.
const DETAILS_OPEN = /^<details( open)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?$/i;
const SUMMARY = /^<summary>([\s\S]*?)<\/summary>$/i;
// Follow-up suggestions written as an inline directive, e.g. :codex-followup[Run tests]{prompt="Run the tests"}.
const FOLLOWUP = /:(?:codex-)?followup\[([^\]\n]{1,80})\](?:\{prompt=("|&quot;)([\s\S]*?)\2\})?/g;

/** Writes the tree as HTML. Math becomes inert placeholders that `typesetMath` fills in. */
export function renderMarkdown(root: MarkdownNode, options: RenderOptions = {}): string {
  const link = (url: string) => escapeAttr(options.link ? options.link(url) : url);
  const kids = (node: MarkdownNode) => (node.children ?? []).map(render).join('');
  let details = 0;
  const paragraph = (node: MarkdownNode): string => {
    const a = node.attributes ?? {};
    const raw = node.children?.every(child => child.type === 'Text' || child.type === 'SoftBreak') ? text(node).trim() : '';
    const open = raw.match(DETAILS_OPEN);
    if (open) { details++; return `<details${open[1] ? ' open' : ''}>${open[2] === undefined ? '' : `<summary>${escapeText(open[2])}</summary>`}\n`; }
    const summary = details ? raw.match(SUMMARY) : null;
    if (summary) return `<summary>${escapeText(summary[1])}</summary>\n`;
    if (/^<\/details>$/i.test(raw) && details) { details--; return '</details>\n'; }
    const followups: { label: string; prompt: string }[] = [];
    const html = kids(node).replace(FOLLOWUP, (_, label: string, _quote: string, prompt?: string) => {
      followups.push({ label: unescapeText(label), prompt: unescapeText(prompt ?? label) });
      return '';
    });
    const body = html.trim() ? (a.tight === 'true' ? html : `<p>${html}</p>\n`) : '';
    return followups.length ? `${body}<pandacode-ui><pre><code class="language-ui">${escapeText(JSON.stringify({ type: 'followups', items: followups.slice(0, 8) }))}</code></pre></pandacode-ui>\n` : body;
  };
  const cell = (tag: string, node: MarkdownNode) => {
    const align = node.attributes?.align ?? '';
    return `<${tag}${ALIGN.has(align) ? ` class="md-align-${align}"` : ''}>${kids(node)}</${tag}>`;
  };
  function render(node: MarkdownNode): string {
    const a = node.attributes ?? {};
    switch (node.type) {
      case 'Document': return kids(node);
      // Tight list items hold their text directly, as CommonMark renders them.
      case 'Paragraph': return paragraph(node);
      case 'Text': return escapeText(node.content ?? '');
      case 'SoftBreak': return '\n';
      case 'LineBreak': return '<br>\n';
      case 'Heading': { const level = Math.min(6, Math.max(1, Number(a.level) || 1)); return `<h${level}>${kids(node)}</h${level}>\n`; }
      case 'Strong': return `<strong>${kids(node)}</strong>`;
      case 'Emphasis': return `<em>${kids(node)}</em>`;
      case 'Strikethrough': return `<del>${kids(node)}</del>`;
      case 'Underline': return `<u>${kids(node)}</u>`;
      case 'Superscript': return `<sup>${kids(node)}</sup>`;
      case 'Subscript': return `<sub>${kids(node)}</sub>`;
      case 'Highlight': return `<mark>${kids(node)}</mark>`;
      case 'Code': return `<code>${escapeText(text(node))}</code>`;
      case 'Link': {
        // A citation chip only for a real web link whose text is not the URL itself; brandFor alone would chip bare words.
        const url = a.url ?? '';
        const label = text(node).trim();
        const brand = /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url) && label !== url && label !== url.replace(/^https?:\/\//i, '') ? brandFor(url) : undefined;
        if (brand) return `<a class="md-cite" href="${link(a.url ?? '')}" title="${escapeAttr(a.url ?? '')}">${brand.svg}<span>${kids(node)}</span></a>`;
        return `<a href="${link(a.url ?? '')}"${a.title ? ` title="${escapeAttr(a.title)}"` : ''}>${kids(node)}</a>`;
      }
      // Remote images are not loaded in the transcript; their description links to them instead.
      case 'Image': case 'Video': { const label = text(node) || a.title || (node.type === 'Video' ? 'Video' : 'Image'); return `<a class="md-media" href="${link(a.url ?? '')}">${escapeText(label)}</a>`; }
      case 'Blockquote': return `<blockquote>\n${kids(node)}</blockquote>\n`;
      case 'Admonition': {
        const type = ADMONITIONS[a.admonitionType ?? ''] ? a.admonitionType! : 'note';
        return `<aside class="md-admonition md-admonition-${type}" role="note"><p class="md-admonition-title">${ADMONITIONS[type]}</p>${kids(node)}</aside>\n`;
      }
      case 'UnorderedList': case 'OrderedList': {
        const tag = node.type === 'OrderedList' ? 'ol' : 'ul';
        const tasks = node.children?.some(item => item.attributes?.isTask === 'true');
        const start = Number(a.start);
        return `<${tag}${tasks ? ' class="md-task-list"' : ''}${tag === 'ol' && Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ''}>\n${kids(node)}</${tag}>\n`;
      }
      case 'ListItem': {
        if (a.isTask !== 'true') return `<li>${kids(node)}</li>\n`;
        const done = a.taskChecked === 'true';
        return `<li class="md-task${done ? ' md-task-done' : ''}"><span class="md-checkbox" role="img" aria-label="${done ? 'Done' : 'Not done'}"></span>${kids(node)}</li>\n`;
      }
      case 'CodeBlock': {
        const language = (a.language ?? '').trim().split(/\s/)[0];
        const code = `<pre><code${language ? ` class="language-${escapeAttr(language)}"` : ''}>${escapeText(text(node))}</code></pre>`;
        // Generative UI: the source stays in the light DOM; <pandacode-ui> draws it in a shadow root.
        // Other code gets a copy button from <pandacode-code>, which slots the block unchanged.
        return GENERATIVE.has(language.toLowerCase()) ? `<pandacode-ui>${code}</pandacode-ui>\n` : `<pandacode-code>${code}</pandacode-code>\n`;
      }
      case 'ThematicBreak': return '<hr>\n';
      case 'Table': return `<table>\n${kids(node)}</table>\n`;
      case 'TableHead': return `<thead>\n${kids(node)}</thead>\n`;
      case 'TableBody': return `<tbody>\n${kids(node)}</tbody>\n`;
      case 'TableRow': return `<tr>${kids(node)}</tr>\n`;
      case 'TableHeaderCell': return cell('th', node);
      case 'TableCell': return cell('td', node);
      case 'LatexMathInline': return `<code class="md-math">${escapeText(text(node))}</code>`;
      case 'LatexMathDisplay': return `<pre class="md-math-display"><code class="md-math">${escapeText(text(node))}</code></pre>\n`;
      case 'BlankLine': return '';
      default: return kids(node);
    }
  }
  const html = render(root);
  return details > 0 ? html + '</details>\n'.repeat(details) : html;
}

type Katex = { renderToString(tex: string, options: Record<string, unknown>): string };
let katex: Promise<Katex> | undefined;
const unescapeText = (html: string) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Replaces math placeholders in sanitized HTML with KaTeX output (which never runs code:
 * `trust` is off, so it emits no links, classes or styles from the formula). */
export async function typesetMath(html: string): Promise<string> {
  if (!html.includes('class="md-math"')) return html;
  katex ??= import('./math').then(module => module.default as Katex);
  const engine = await katex;
  const typeset = (tex: string, display: boolean) => {
    try { return engine.renderToString(unescapeText(tex), { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxExpand: 1000, maxSize: 20 }); }
    catch { return `<code class="md-math-error">${tex}</code>`; }
  };
  return html
    .replace(/<pre class="md-math-display"><code class="md-math">([\s\S]*?)<\/code><\/pre>/g, (_, tex: string) => `<div class="md-math-block">${typeset(tex, true)}</div>`)
    .replace(/<code class="md-math">([\s\S]*?)<\/code>/g, (_, tex: string) => typeset(tex, false));
}
