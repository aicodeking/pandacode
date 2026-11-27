/* Release notes for /changelog, read at build time from the repository's releases/X.Y.Z.md
 * (the same files the release runbook publishes). Notes use a small subset of Markdown:
 * an optional "# Heading", "## Section" and "### Subsection" headings, paragraphs, "- " bullets (an indented "- " nests one level) with
 * wrapped continuation lines, **bold**, `code` and [links](https://…) (http/https only). The signing boilerplate repeated on every release is dropped here
 * and stated once on the page. */
import dates from '../data/release-dates.json';
import { bundledInVersion, publishedReleaseSummary } from './changelog-meta';

export type Item = { html: string; children: readonly string[] };
export type Block =
  | { kind: 'heading'; level: 2 | 3; html: string }
  | { kind: 'paragraph'; html: string }
  | { kind: 'list'; items: readonly Item[] };
export type Release = { version: string; date?: string; bundledIn?: string; title?: string; blocks: readonly Block[] };

const sources = import.meta.glob('../../../releases/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const BOILERPLATE = /^This is an (?:Apple silicon )?Alpha preview\b/;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const inline = (text: string) => escape(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

const compare = (a: string, b: string) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  return x.reduce((order, part, index) => order || part - (y[index] ?? 0), 0);
};

/** Top-level bullets, each with its indented sub-bullets; other lines continue the last one. */
function listItems(chunk: string): Item[] {
  const raw = chunk.split('\n').reduce<{ text: string; children: string[] }[]>((items, line) => {
    const last = items.at(-1);
    if (line.startsWith('- ')) return [...items, { text: line.slice(2), children: [] }];
    if (!last) return items;
    const nested = line.match(/^\s+- (.*)$/)?.[1];
    const children = nested !== undefined ? [...last.children, nested]
      : last.children.length ? [...last.children.slice(0, -1), `${last.children.at(-1)} ${line.trim()}`] : last.children;
    const text = nested === undefined && !last.children.length ? `${last.text} ${line.trim()}` : last.text;
    return [...items.slice(0, -1), { text, children }];
  }, []);
  return raw.map(item => ({ html: inline(item.text), children: item.children.map(inline) }));
}

/** Section headings stand alone, even without blank lines around them. */
export function parse(source: string): { title?: string; blocks: Block[] } {
  const lines = source.replace(/\r\n/g, '\n').trim().split('\n');
  const heading = lines[0]?.match(/^#\s+(.+)$/)?.[1];
  const title = heading && !/^PandaCode \d/.test(heading) ? heading : undefined;
  // A list may follow its lead-in paragraph without a blank line between them.
  const leadIn = (chunk: string): string[] => {
    const at = chunk.search(/\n- /);
    return at > 0 && !chunk.startsWith('- ') ? [chunk.slice(0, at), chunk.slice(at + 1)] : [chunk];
  };
  const chunks = (heading ? lines.slice(1) : lines).join('\n').split(/(^#{2,3}[ \t]+\S[^\n]*)/m)
    .flatMap(chunk => chunk.split(/\n\s*\n/))
    .map(chunk => chunk.trim()).filter(Boolean).flatMap(leadIn);
  const blocks = chunks.flatMap((chunk): Block[] => {
    const section = chunk.match(/^(#{2,3})[ \t]+(.+)$/);
    if (section) return [{ kind: 'heading', level: section[1] === '##' ? 2 : 3, html: inline(section[2]) }];
    if (chunk.startsWith('- ')) return [{ kind: 'list', items: listItems(chunk) }];
    const text = chunk.replace(/\s*\n\s*/g, ' ');
    return BOILERPLATE.test(text) ? [] : [{ kind: 'paragraph', html: inline(text) }];
  });
  return { title, blocks };
}

export const releases: readonly Release[] = Object.entries(sources)
  .map(([path, source]) => {
    const version = path.match(/(\d+\.\d+\.\d+)\.md$/)?.[1] ?? '';
    const bundledIn = bundledInVersion(version);
    return {
      version,
      date: (dates as Record<string, string>)[version],
      ...(bundledIn ? { bundledIn } : {}),
      ...parse(source),
    };
  })
  .filter(release => release.version)
  .sort((a, b) => compare(b.version, a.version));

const { latest: latestPublished, publishedCount: publishedReleaseCount } = publishedReleaseSummary(releases);
export { latestPublished, publishedReleaseCount };

export const formatDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
