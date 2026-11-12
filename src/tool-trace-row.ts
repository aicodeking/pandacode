import { escape } from './dom.ts';
import { toolImageThumbHtml } from './tool-images.ts';
import { basename } from './tool-text.ts';
import type { Trace, TraceChip } from './tool-trace.ts';

/* One row's sentence: `Verb [chip] object · “note”`, then muted extras (`+2 more commands`), the edit delta and badges.
 * Pure and escaped, except guardTraceBadges, which keeps a focusable badge inside a row's <summary> from toggling it. */

const BADGE = '[data-trace-badge]';

function chipHtml(chip: TraceChip): string {
  return `<span class="tool-trace-chip" title="${escape(chip.title)}">${chip.svg ?? ''}<b>${escape(chip.label)}</b></span>`;
}

/** Free text a row carries (a summary, a prompt, a message): after a separator, quoted and muted, never run into the verb. */
export function quoteHtml(text: string): string {
  return text ? `<span class="tool-trace-quote">· “${escape(text)}”</span>` : '';
}

/** `+3 −1`, both sides always (`+1 −0`), so a delta never reads as a count beside `+1 more file`; no change, no delta. */
function deltaHtml(added = 0, removed = 0): string {
  return added > 0 || removed > 0 ? `<span class="tool-trace-delta"><ins>+${added}</ins> <del>−${removed}</del></span>` : '';
}

/** `exit 2`: a failed compound keeps its lead verb and carries this one badge (`failed` when no code was recorded), saying
 *  on hover that a later step failed. A refused call never ran, so it has none. */
function exitHtml(trace: Trace): string {
  if (trace.blocked || (trace.exit === undefined && !trace.then)) return '';
  const title = trace.then ? ` title="${trace.exit === undefined ? 'A later step failed' : `Then failed with exit ${trace.exit}`}"` : '';
  return `<span class="tool-trace-badge is-failed"${title}>${trace.exit === undefined ? 'failed' : `exit ${trace.exit}`}</span>`;
}

/** `Deleted files: rm -rf src` → its prose reason and the command; a bare command has no reason. */
const REASON = /^([A-Z][^:;|&<>$`'"\n]{0,60}?): (.+)$/s;
function splitRisk(risk: string): { reason: string; command: string } {
  const match = REASON.exec(risk);
  return match ? { reason: match[1], command: match[2] } : { reason: '', command: risk };
}

// A word longer than this may break anywhere; shorter ones (`--no-preserve-root`) never break inside.
const LONG_WORD = 36;
function commandHtml(command: string): string {
  const words = command.trim().split(/\s+/).map(word => `<span class="tool-trace-tip-word${word.length > LONG_WORD ? ' is-long' : ''}">${escape(word)}</span>`);
  return `<code>${words.join(' ')}</code>`;
}

/** The tooltip's body: one line per risk, the reason as text and the command as code that wraps only between words. */
export function tipLinesHtml(risks: string[]): string {
  return risks.map(splitRisk).map(({ reason, command }) =>
    `<span class="tool-trace-tip-line">${reason ? `<span class="tool-trace-tip-reason">${escape(reason)}</span>` : ''}${commandHtml(command)}</span>`).join('');
}

/** A quiet `destructive` badge that keyboard and VoiceOver users can reach. Its in-app tooltip (drawn below, on hover
 *  and focus) lists every risk from `data-trace-risks`; a native title would never show on focus. */
function dangerHtml(trace: Trace): string {
  if (!trace.destructive) return '';
  const risks = trace.risks?.length ? trace.risks : [trace.chip?.title || trace.object].filter(Boolean);
  const why = risks.join('; ');
  const label = escape('Destructive: ' + why);
  return `<span class="tool-trace-badge is-danger" tabindex="0" role="note" data-trace-badge aria-label="${label}" data-trace-risks="${escape(JSON.stringify(risks))}" data-trace-tip="${escape(why)}">destructive</span>`;
}

/** Where an image a command wrote sits: immediately before the chip or object that names it (the thumb drops its name:
 *  `Captured screenshot [thumb] desk.png`), else after the sentence, before `+N more` and the badges, with its file name
 *  unless the row's text already says it. One rule with a viewed image (`Viewed [thumb] a.png`). */
type Produced = { html: string; after: 'chip' | 'object' | 'sentence' };
const THUMB_NAME = /<span class="tool-image-name">[^<]*<\/span>$/;
function producedOf(trace: Trace): Produced | undefined {
  if (!trace.produced) return undefined;
  const name = basename(trace.produced);
  const thumb = toolImageThumbHtml(trace.produced);
  const compact = `<span class="tool-trace-produced is-compact">${thumb.replace(THUMB_NAME, '')}</span>`;
  const inChip = [trace.chip, ...(trace.chips ?? [])].some(chip => chip?.label.includes(name));
  if (inChip) return { html: compact, after: 'chip' };
  if (trace.object.includes(name)) return { html: compact, after: 'object' };
  if ([trace.verb, trace.note ?? '', trace.more ?? ''].some(text => text.includes(name))) return { html: compact, after: 'sentence' };
  return { html: `${producedLead(trace.verb)}<span class="tool-trace-produced">${thumb}</span>`, after: 'sentence' };
}

/** Verbs whose object is the image they made: its own output follows a bare separator (`Encoded [k12.png] · [thumb] k16.png`);
 *  after any other verb the image is a later step's output (`Edited [s_panda.py] · wrote [thumb] r1_sheet.jpg`). */
const MAKES_IMAGE = /^(?:Encoded|Captured|Converted|Rendered|Generated|Resized|Cropped|Rotated|Transcoded|Optimized|Wrote|Exported|Saved|Took|Drew|Created|Made)\b/;
function producedLead(verb: string): string {
  return `<span class="tool-trace-join">· ${MAKES_IMAGE.test(verb) ? '' : 'wrote'}</span>`.replace('· </span>', '·</span>');
}

/** Several chips side by side; `joined` lists them as prose (`[python3], [grep] and [rg]`; commas only when more follow). */
function chipsHtml(chips: TraceChip[], joined: boolean, more: boolean): string {
  if (!joined || chips.length < 2) return chips.map(chipHtml).join('');
  const comma = '<span class="tool-trace-join is-comma">,</span>';
  return chips.map((chip, index) => {
    const last = index === chips.length - 1;
    const before = index === 0 ? '' : last && !more ? '<span class="tool-trace-join">and</span>' : comma;
    return before + chipHtml(chip);
  }).join('');
}

/** The object, mono when it is code; counts and tallies after its first ` · ` (`main · 10 files`) are never code. */
function objectHtml(object: string, mono: boolean): string {
  if (!object) return '';
  const at = mono ? (object.startsWith('· ') ? 0 : object.indexOf(' · ')) : -1;
  const code = at < 0 ? object : object.slice(0, at);
  const tally = at < 0 ? '' : `<span class="tool-trace-object${code ? ' is-tally' : ''}">${escape(object.slice(at))}</span>`;
  return (code ? `<span class="tool-trace-object${mono ? ' is-mono' : ''}">${escape(code)}</span>` : '') + tally;
}

/** `Verb [chip] object` (or `object [chip]` when the chip is a place), each with the thumbnail of an image it names. */
function sentenceHtml(trace: Trace, produced: Produced | undefined): string {
  const many = trace.chips?.length ? chipsHtml(trace.chips, trace.joined === true, /^\+\d+ more\b/.test(trace.object)) : '';
  const chips = many || (trace.chip ? chipHtml(trace.chip) : '');
  // A viewed image sits in the sentence as a thumbnail button (tool-images.ts); beside a chip or a title it drops its file name.
  const compact = chips || (trace.kind !== 'image' && trace.object);
  const image = trace.image ? `<span class="tool-trace-image${compact ? ' is-compact' : ''}">${toolImageThumbHtml(trace.image)}</span>` : '';
  const object = objectHtml(trace.object, trace.mono === true);
  // A viewed image's thumbnail comes right after the verb (`Viewed [thumb] a.png`); a screenshot of a device after the device
  // it shows (`Took a screenshot of [Simulator] [thumb]`).
  const afterChips = image && chips && trace.kind !== 'image';
  const chipPart = (produced?.after === 'chip' ? produced.html : '') + chips + (afterChips ? image : '');
  const objectPart = (produced?.after === 'object' ? produced.html : '') + object;
  if (!trace.chipLast) return (afterChips ? '' : image) + chipPart + objectPart;
  // A place chip ends its phrase (`for “x” in [src]`); tallies after it (`· no matches`) follow the chip.
  const text = trace.object.startsWith('· ') ? ` ${trace.object}` : trace.object;
  const tallyAt = text.indexOf(' · ');
  if (tallyAt < 0 || !chipPart) return image + objectPart + chipPart;
  const tally = `<span class="tool-trace-object is-tally">${escape(text.slice(tallyAt + 1))}</span>`;
  return image + objectHtml(text.slice(0, tallyAt), trace.mono === true) + chipPart + tally;
}

/** Why a call wrote or ran nothing (`· string to replace not found`): muted, after the sentence. */
function reasonHtml(reason: string | undefined): string {
  return reason ? `<span class="tool-trace-reason">· ${escape(reason)}</span>` : '';
}

/** `+2 more commands` after a tally, a note, a reason or another `+N more` takes a separator, so two tails never run together:
 *  `· 119 passed · +2 more commands`, `a.ts +1 more file · +1 more command`. */
const OVERFLOW_END = /\+\d+ more [a-z]+$/;
function moreHtml(trace: Trace): string {
  if (!trace.more) return '';
  const after = trace.object.startsWith('· ') || trace.object.includes(' · ') || OVERFLOW_END.test(trace.object) || Boolean(trace.note || trace.reason);
  return `<span class="tool-trace-more-steps">${after ? '· ' : ''}${escape(trace.more)}</span>`;
}

export function traceRowHtml(trace: Trace): string {
  const produced = producedOf(trace);
  const more = moreHtml(trace);
  const tail = produced?.after === 'sentence' ? produced.html : '';
  const delta = trace.added !== undefined ? deltaHtml(trace.added, trace.removed) : '';
  const title = trace.title ? ` title="${escape(trace.title)}"` : '';
  const verb = `<span class="tool-trace-verb"${title}>${escape(trace.verb)}</span>`;
  return `${verb}${sentenceHtml(trace, produced)}${quoteHtml(trace.note ?? '')}${reasonHtml(trace.reason)}${tail}${more}${delta}${exitHtml(trace)}${dangerHtml(trace)}`;
}

/** A click or Enter/Space on a row's badge reads the badge, it never opens or closes the row around it. */
function keepRowClosed(event: Event): void {
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (!target?.closest?.(BADGE)) return;
  const key = (event as KeyboardEvent).key;
  if (event.type === 'keydown' && key !== 'Enter' && key !== ' ') return;
  event.preventDefault();
}

// --- The badge's tooltip: one glass bubble in the document's top layer of stacking, so no row or pane paints over it -----

const TIP_GAP = 6;
const TIP_MARGIN = 8;
type Box = { top: number; bottom: number; left: number; right: number };

/** Below the badge, or above it when the space below is short; kept inside the viewport. Pure. */
export function placeTip(badge: Box, tip: { width: number; height: number }, view: { width: number; height: number }): { top: number; left: number; above: boolean } {
  const below = badge.bottom + TIP_GAP;
  const above = below + tip.height > view.height - TIP_MARGIN && badge.top - TIP_GAP - tip.height >= TIP_MARGIN;
  const left = Math.max(TIP_MARGIN, Math.min(badge.left, view.width - TIP_MARGIN - tip.width));
  return { top: above ? badge.top - TIP_GAP - tip.height : below, left, above };
}

function badgeRisks(badge: HTMLElement): string[] {
  try {
    const value: unknown = JSON.parse(badge.dataset.traceRisks ?? '');
    if (Array.isArray(value)) return value.filter((risk): risk is string => typeof risk === 'string' && risk !== '');
  } catch { /* An older row without the list: its joined text. */ }
  return [badge.dataset.traceTip ?? ''].filter(Boolean);
}

let tipNode: HTMLElement | undefined;
/** The badge whose tooltip is open. */
let tipBadge: HTMLElement | undefined;
function tipElement(doc: Document): HTMLElement {
  if (tipNode?.isConnected) return tipNode;
  tipNode = doc.createElement('div');
  tipNode.className = 'tool-trace-tip';
  // The badge's aria-label already says all of it.
  tipNode.setAttribute('aria-hidden', 'true');
  doc.body.append(tipNode);
  return tipNode;
}

function showTip(badge: HTMLElement): void {
  const doc = badge.ownerDocument;
  const tip = tipElement(doc);
  tipBadge = badge;
  tip.innerHTML = tipLinesHtml(badgeRisks(badge));
  tip.dataset.open = '';
  const view = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  const place = placeTip(badge.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, view);
  tip.style.top = `${place.top}px`;
  tip.style.left = `${place.left}px`;
  tip.dataset.placement = place.above ? 'above' : 'below';
}

function hideTip(): void { tipBadge = undefined; if (tipNode) delete tipNode.dataset.open; }

/** A scroll moves the tooltip with its badge while the badge keeps focus (focusing scrolls it into view, which must not
 *  close what the focus just opened); otherwise it closes. */
function scrollTip(): void {
  const badge = tipBadge;
  if (badge?.isConnected && badge.ownerDocument.activeElement === badge) showTip(badge);
  else hideTip();
}

function badgeOf(event: Event): HTMLElement | undefined {
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  const badge = target?.closest?.(BADGE);
  return badge && 'dataset' in badge ? badge as HTMLElement : undefined;
}

/** Escape on a badge with its tooltip open closes only the tooltip: the badge keeps focus and nothing else hears the key. */
function escapeTip(event: Event, badge: HTMLElement | undefined): void {
  const open = tipNode?.dataset.open !== undefined;
  hideTip();
  if (open && badge) { event.preventDefault(); event.stopPropagation(); }
}

/** Hover and keyboard focus show the tooltip; leaving, blurring, Escape or a scroll away from a focused badge hides it. */
function tipEvent(event: Event): void {
  const badge = badgeOf(event);
  if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape') { escapeTip(event, badge); return; }
  if (event.type === 'scroll') { scrollTip(); return; }
  if (!badge) return;
  if (event.type === 'mouseover' || event.type === 'focusin') { showTip(badge); return; }
  const next = (event as FocusEvent).relatedTarget as Node | null;
  if (!next || !badge.contains(next)) hideTip();
}

export function guardTraceBadges(root: Pick<Document, 'addEventListener'>): void {
  root.addEventListener('click', keepRowClosed, true);
  root.addEventListener('keydown', keepRowClosed, true);
  for (const type of ['mouseover', 'mouseout', 'focusin', 'focusout', 'keydown', 'scroll']) root.addEventListener(type, tipEvent, true);
}

// Rows are HTML strings rendered anywhere in the window, so the guard listens once on the document.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') guardTraceBadges(document);
