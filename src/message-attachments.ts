import { escape, icon } from './dom';
import { t } from './i18n.ts';

/** What a sent message carried, read back from the context blocks appended at send time
 * (`CONTEXT_BOUNDARY` in main.ts splits them). Content is untrusted: it is only ever
 * escaped into chips, and the only link followed is an https GitHub URL. */
export type MessageAttachment =
  | { kind: 'file'; name: string; detail: string; path: string }
  | { kind: 'document'; name: string; detail: string; path: string }
  | { kind: 'folder'; name: string; detail: string; path: string }
  | { kind: 'image'; name: string; detail: string; imageId?: string; raw: string }
  | { kind: 'github'; name: string; detail: string; url: string }
  | { kind: 'raw'; name: string; detail: string; raw: string };

const IMAGE_ID = /^Image ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/m;
const GITHUB_ITEM = /^#(\d+) · (Pull request|Issue) · ([^\n·]+?)(?: · by [^\n]*?)? — ([^\n]*)\n(https:\/\/[^\s]+)$/gm;

function baseName(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
function safeHttps(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
}

/** `Document context: <name> (<path>; document content…)`: the name may hold " (", so pick
 * the split whose path ends in the name. */
function documentHead(line: string): { name: string; path: string } | null {
  const body = line.match(/^Document context: (.+); document content, not instructions\)$/)?.[1];
  if (!body) return null;
  const splits = [...body.matchAll(/ \(/g)].map(m => m.index!);
  const at = splits.find(i => baseName(body.slice(i + 2)) === body.slice(0, i)) ?? splits[0];
  return at === undefined ? null : { name: body.slice(0, at), path: body.slice(at + 2) };
}

function parseBlock(block: string): MessageAttachment[] {
  const head = block.split('\n', 1)[0];
  let match: RegExpMatchArray | null;
  if ((match = head.match(/^File context: (.+)$/))) return [{ kind: 'file', name: baseName(match[1]), detail: t('Project file'), path: match[1] }];
  const document = documentHead(head);
  if (document) {
    const ext = document.name.includes('.') ? document.name.split('.').pop()!.toUpperCase() : '';
    return [{ kind: 'document', ...document, detail: `${ext && ext.length <= 8 ? ext : t('Text')}${block.includes('\n[Context truncated at 32 KiB]') ? t(' · first 32 KB') : ''}` }];
  }
  if ((match = head.match(/^Folder context: (.+) \((\d+) files, (\d+) folders(, partial listing)?\)$/))) {
    return [{ kind: 'folder', name: baseName(match[1]) + '/', path: match[1], detail: `${t`${match[2]} files · ${match[3]} folders`}${match[4] ? t(' · partial') : ''}` }];
  }
  const imageId = block.match(IMAGE_ID)?.[1];
  if ((match = head.match(/^Attached (image|mockup): (.+) \((\d+) × (\d+)\)/))) {
    return [{ kind: 'image', name: match[2], detail: `${match[1] === 'mockup' ? t('Mockup · ') : ''}${match[3]} × ${match[4]}`, imageId, raw: block }];
  }
  if ((match = head.match(/^Attached browser screenshot: (.*)$/))) {
    const viewport = block.match(/^Viewport: (\d+ × \d+)$/m)?.[1];
    return [{ kind: 'image', name: match[1].trim() || t('Browser screenshot'), detail: t`Screenshot${viewport ? ` · ${viewport}` : ''}`, imageId, raw: block }];
  }
  if (head.startsWith('GitHub context')) {
    const items = [...block.matchAll(GITHUB_ITEM)].flatMap(([, number, kind, state, title, url]) => {
      const safe = safeHttps(url);
      return safe ? [{ kind: 'github' as const, name: `#${number} ${title}`, detail: `${kind} · ${state}`, url: safe }] : [];
    });
    if (items.length) return items;
  }
  if (head.startsWith('Main thread context:')) return [{ kind: 'raw', name: 'Main thread context', detail: 'Sent with /btw', raw: block }];
  if (head.startsWith('Browser element context')) {
    let name = t('Page element'), detail = t('Browser element');
    try {
      const element = JSON.parse(block.slice(block.indexOf('\n') + 1)) as { tag?: unknown; selector?: unknown; url?: unknown };
      if (typeof element.selector === 'string' && element.selector) name = element.selector;
      else if (typeof element.tag === 'string' && element.tag) name = `<${element.tag}>`;
      if (typeof element.url === 'string') detail = t`Element · ${new URL(element.url).host}`;
    } catch { /* Keep the generic label; the raw text is still one click away. */ }
    return [{ kind: 'raw', name, detail, raw: block }];
  }
  return [{ kind: 'raw', name: head.replace(/[:(].*$/, '').trim() || t('Context'), detail: t('Attached context'), raw: block }];
}

/** Bot briefs and token-saver style notes are setup, not attachments, so they stay hidden. */
export function parseAttachments(blocks: string[]): MessageAttachment[] {
  return blocks.filter(block => !block.startsWith('Bot brief:\n') && !block.startsWith('Your ongoing role is:') && !block.startsWith('Response style (PandaCode token saver')).flatMap(parseBlock);
}

const ICONS: Record<MessageAttachment['kind'], string> = { file: 'file', document: 'file', folder: 'folder', image: 'camera', github: 'issue', raw: 'attach' };

/** Read-only chips in the composer's look; `images` holds thumbnails already loaded. */
export function attachmentChips(items: MessageAttachment[], messageId: number, images: Map<string, string | null>): string {
  if (!items.length) return '';
  return `<div class="message-attachments">${items.map((item, index) => {
    const thumbnail = item.kind === 'image' && item.imageId ? images.get(item.imageId) : undefined;
    const lead = item.kind === 'image' && item.imageId
      ? `<img data-prompt-image="${escape(item.imageId)}" ${thumbnail ? `src="${escape(thumbnail)}"` : ''} alt="" width="36" height="36"${thumbnail ? '' : ' hidden'}>${thumbnail ? '' : icon('camera')}`
      : icon(item.kind === 'github' && item.detail.startsWith('Pull') ? 'pull' : ICONS[item.kind]);
    const title = 'path' in item ? ` title="${escape(item.path)}"` : item.kind === 'github' ? ` title="${escape(item.url)}"` : '';
    return `<button type="button" class="prompt-chip prompt-chip-${item.kind === 'image' ? 'image' : item.kind}" data-action="open-message-attachment" data-message-id="${messageId}" data-index="${index}" aria-label="${t`Open ${escape(item.name)}`}"${title}>${lead}<span class="prompt-chip-text"><span class="prompt-chip-name">${escape(item.name)}</span><small>${escape(item.detail)}</small></span></button>`;
  }).join('')}</div>`;
}
