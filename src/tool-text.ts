/* Small text helpers shared by the tool-call rows and cards (tool-trace*.ts, tool-cards.ts, tool-images.ts,
 * shell-intent*.ts). Pure and total. */

/** The last segment of a path, for either separator; '/' for the root, the input when it has no name. */
export function basename(path: string): string {
  // A loop, not `/[\\/]+$/`: that regex retries from every slash of a long run that is not at the end (quadratic).
  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--;
  const trimmed = path.slice(0, end);
  if (!trimmed) return path ? path.charAt(0) : '';
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed;
}

/** A row's text (object, note) is kept whole up to this safety cap; CSS ellipsizes it to the room the row has. */
export const ROW_TEXT = 400;

/** One line of at most `limit` characters: whitespace runs collapse to a space, a cut ends in `…`. */
export function clip(value: string, limit = 140): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, Math.max(0, limit - 1)).trimEnd() + '…' : flat;
}

/** Terminal escapes removed: OSC sequences (titles, links), CSI sequences (colours, cursor) and lone escapes. */
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
}

/** Lines of a text without its trailing newlines; CRLF and lone CR read as LF. Empty text has no lines. */
export function lines(value: string): string[] {
  return value ? value.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n') : [];
}

/** The non-empty strings of a list (or a lone string as a list of one); anything else is empty. */
export function strings(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const PERSISTED_OPEN = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';
const PERSISTED_HEAD = /^Output too large \([^)\n]*\)\. Full output saved to: [^\n]*\n+(?:Preview \(first [^)\n]*\):\n)?/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The text inside Claude Code's `<persisted-output>` (its notice that the full text was saved elsewhere dropped), else itself. */
function persistedPreview(output: string): string {
  const start = output.trimStart();
  if (!start.startsWith(PERSISTED_OPEN)) return output;
  const end = start.lastIndexOf(PERSISTED_CLOSE);
  const inner = start.slice(PERSISTED_OPEN.length, end < 0 ? undefined : end).replace(/^\n/, '').replace(/\n$/, '');
  return inner.replace(PERSISTED_HEAD, '');
}

/** A result without the harness's own wrappers: `<persisted-output>` (kept as the preview it carries) and the
 *  `<system-reminder>` blocks a harness appends to a result. */
export function unwrapHarness(output: string): string {
  if (!output.includes('</')) return output;
  const inner = persistedPreview(output);
  return inner.includes('<system-reminder>') ? inner.replace(REMINDER, '').trimEnd() : inner;
}
