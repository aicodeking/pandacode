// The file viewer's pure layout (CodeView.tsx): tabs expanded to spaces, so every character is one
// monospace advance and the measured width matches what is drawn. Pure, so tests/files.test.ts covers it.

/** Columns per tab stop. */
export const TAB_SIZE = 4;
/** Menlo's advance at 13 pt; the code text is pinned to that size (maxFontSizeMultiplier 1). */
export const CHAR_WIDTH = 7.83;
/** Characters drawn per line; longer lines are cut there. */
export const MAX_CHARS = 2000;
export const GUTTER_PAD = 12;

/** `line` with each tab replaced by spaces up to the next tab stop. */
export function expandTabs(line: string, size = TAB_SIZE): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    out += ch === '\t' ? ' '.repeat(size - (out.length % size)) : ch;
  }
  return out;
}

/** The line-number gutter's width for a file of `count` lines. */
export const gutterWidth = (count: number) => String(Math.max(count, 1)).length * CHAR_WIDTH + GUTTER_PAD * 2;

/** The scrolled content's width: the gutter plus the longest (expanded, capped) line, at least `pane`. */
export function codeWidth(lines: readonly string[], pane: number): number {
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 0);
  return Math.max(pane, gutterWidth(lines.length) + Math.min(longest, MAX_CHARS) * CHAR_WIDTH + GUTTER_PAD * 2);
}
