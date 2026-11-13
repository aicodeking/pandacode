/* A small, total shell lexer for shell-intent.ts: splits a command into steps (`;`, `&&`, `||`, `&`, newlines)
 * and pipe segments, never inside quotes, substitutions or heredoc bodies. Records stdout redirects, `< file`
 * inputs and the commands of live substitutions (unquoted, or in double quotes or an unquoted heredoc, never single-quoted
 * or escaped). Subshell and group parentheses are dropped; a here-string (`<<< text`) is recorded as the segment's body. */
import type { Segment, Step } from './shell-intent-base.ts';

type Next = 'word' | 'redirect' | 'input' | 'heredoc' | 'herestring' | 'drop';
/** A pending heredoc: its delimiter, and whether its body expands `$(…)` (an unquoted delimiter). */
interface Heredoc { tag: string; live: boolean }
interface Lexer {
  src: string; i: number; start: number; word: string | null; next: Next; fd: string; appendNext: boolean;
  /** The current word holds quoted or substituted text, so its braces are literal. */
  quoted: boolean;
  heredocs: Heredoc[];
  /** The segment that opened the pending heredocs; their bodies are recorded on it. */
  heredocSeg: Segment | null;
  seg: Segment; step: Segment[]; steps: Step[];
  /** Where the current pipe segment's source text starts. */
  segStart: number;
  /** The segment's last `[[` starts a test (after nothing or a keyword) and no `]]` has closed it. */
  testOpen: boolean;
}

const newSegment = (): Segment => ({ words: [], heredoc: false, redirect: '', append: false, input: '', substituted: false, subs: [], body: '' });
const MAX_SUBS = 8;
/** Writes to these never touch a file. */
const DEVICE = /^(?:\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)|\d+)$/;

export function lex(src: string): Step[] {
  const s: Lexer = { src, i: 0, start: 0, word: null, next: 'word', fd: '', appendNext: false, quoted: false, heredocs: [], heredocSeg: null, seg: newSegment(), step: [], steps: [], segStart: 0, testOpen: false };
  while (s.i < src.length) lexChar(s);
  endStep(s, src.length, src.length);
  return s.steps;
}

function lexChar(s: Lexer): void {
  const c = s.src[s.i], next = s.src[s.i + 1];
  if (c === "'") return readQuoted(s, "'");
  if (c === '"') return readQuoted(s, '"');
  if (c === '`') return readBackticks(s);
  if (c === '\\') { if (next !== '\n') append(s, next ?? ''); s.i += 2; return; }
  if ((c === '$' || c === '<' || c === '>') && next === '(') return readSubstitution(s);
  if (c === '$' && next === '{') return readParameter(s);
  if (c === '(' && s.word !== null && s.word.endsWith('=')) return readArray(s); // `args=(a b)`, `args+=(-i "$f")`
  if (c === '#' && s.word === null) { const nl = s.src.indexOf('\n', s.i); s.i = nl < 0 ? s.src.length : nl; return; }
  if (c === '\n') { endWord(s); s.i++; if (s.heredocs.length) skipHeredocs(s); endStep(s, s.i, s.i); return; }
  if (c === ' ' || c === '\t' || c === '\r') { endWord(s); s.i++; return; }
  // `[[ a && b ]]`, `[[ x < y ]]`: inside a test these are operators, not step separators or redirects.
  if ((((c === '&' || c === '|') && next === c) || c === '<' || c === '>') && inTest(s)) { const op = c === next ? c + c : c; append(s, op); s.i += op.length; return; }
  if (c === ';' || ((c === '&' || c === '|') && next === c)) { const width = c === ';' ? 1 : 2; endStep(s, s.i, s.i + width); s.i += width; return; }
  if (c === '|') { endWord(s); s.step.push(closeSegment(s, s.i)); s.seg = newSegment(); s.testOpen = false; s.i += next === '&' ? 2 : 1; s.segStart = s.i; return; }
  if (c === '>' || (c === '&' && next === '>')) return readRedirect(s);
  if (c === '&') { endStep(s, s.i, s.i + 1); s.i++; return; }
  if (c === '<') return readInput(s);
  if (c === ')' && opensParen(s.word)) { append(s, c); s.i++; return; } // `p.goto(1)`: a call inside one word
  if ((c === '(' && s.word === null) || c === ')') { endWord(s); if (c === ')') s.seg.group = true; s.i++; return; } // subshell grouping
  // A run of plain characters joins the word at once: one string per run, not one per character.
  let end = s.i + 1;
  while (end < s.src.length && !SPECIAL.has(s.src[end])) end++;
  append(s, s.src.slice(s.i, end));
  s.i = end;
}

/** Characters lexChar must look at one by one; anything else only extends the current word. */
const SPECIAL: ReadonlySet<string> = new Set([...' \t\r\n\'"`\\$<>()#;&|']);

/** Inside an open `[[ … ]]` that starts a command (after nothing or a keyword, so `echo '[['` is an argument). */
const inTest = (s: Lexer): boolean => s.word !== ']]' && s.testOpen;
const TEST_OPENERS = /^(?:if|elif|while|until|!|then|do|else|\{)$/;

/** Adds words to the segment, tracking whether its last `[[` opened a test (so `inTest` never rescans the words). */
function pushWords(s: Lexer, words: string[]): void {
  for (const word of words) {
    const list = s.seg.words;
    if (word === '[[') s.testOpen = list.length === 0 || TEST_OPENERS.test(list[list.length - 1]);
    else if (word === ']]') s.testOpen = false;
    list.push(word);
  }
}

/** The word has more `(` than `)`, so a `)` closes it rather than a subshell. */
const opensParen = (word: string | null) => !!word && !word.endsWith('(') && word.split('(').length > word.split(')').length;

function append(s: Lexer, text: string): void { s.word = (s.word ?? '') + text; }

/** Index just past the `)` closing the `(` at `open`, skipping quoted text; the end of input when unbalanced. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'" || c === '"') { i = quoteEnd(src, i); }
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Index of the quote closing the one at `open` (or the end of input). */
function quoteEnd(src: string, open: number): number {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i++) {
    if (quote === '"' && src[i] === '\\') i++;
    else if (quote === '"' && src[i] === '$' && src[i + 1] === '(') i = closeParen(src, i + 1) - 1;
    else if (src[i] === quote) return i;
  }
  return src.length;
}

/** The commands of the live substitutions in text where quotes are literal but `$(…)` and backticks run (double-quoted
 * text, an unquoted heredoc body); `\$` and `` \` `` are escapes. `$((…))` is arithmetic. */
export function liveSubstitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < MAX_SUBS; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '$' && text[i + 1] === '(') {
      const end = closeParen(text, i + 1);
      if (text[i + 2] !== '(') out.push(text.slice(i + 2, end - 1));
      i = end - 1;
    } else if (c === '`') {
      const end = backtickEnd(text, i);
      out.push(text.slice(i + 1, end).replace(/\\`/g, '`'));
      i = end;
    }
  }
  return out.filter(sub => sub.trim());
}

/** Index of the backtick closing the one at `open` (skipping escaped ones), or the end of the text. */
function backtickEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
  }
  return text.length;
}

function addSubs(s: Lexer, subs: string[]): void {
  if (!subs.length) return;
  s.seg.substituted = true;
  s.seg.subs = [...s.seg.subs, ...subs].slice(0, MAX_SUBS);
}

function readQuoted(s: Lexer, quote: string): void {
  let i = s.i + 1, text = '';
  while (i < s.src.length && s.src[i] !== quote) {
    if (quote === '"' && s.src[i] === '$' && s.src[i + 1] === '(') {
      // `"$f $(python3 -c "print(1)")"`: the substitution's own quotes do not end this string.
      const end = closeParen(s.src, i + 1);
      text += s.src.slice(i, end);
      i = end;
      continue;
    }
    if (quote === '"' && s.src[i] === '\\' && /["\\$`]/.test(s.src[i + 1] ?? '')) i++;
    text += s.src[i++] ?? '';
  }
  if (quote === '"') addSubs(s, liveSubstitutions(s.src.slice(s.i + 1, i)));
  append(s, text);
  s.quoted = true;
  s.i = i + 1;
}

function readBackticks(s: Lexer): void {
  const end = backtickEnd(s.src, s.i);
  const stop = Math.min(end + 1, s.src.length);
  append(s, s.src.slice(s.i, stop));
  addSubs(s, liveSubstitutions(s.src.slice(s.i, stop)));
  s.quoted = true;
  s.i = stop;
}

function readSubstitution(s: Lexer): void {
  const end = closeParen(s.src, s.i + 1);
  const text = s.src.slice(s.i, end);
  append(s, text);
  if (text[2] !== '(') addSubs(s, [text.slice(2, text.endsWith(')') ? -1 : undefined)].filter(sub => sub.trim()));
  s.quoted = true;
  s.i = end;
}

/** `${VAR:-a b; c}`: one word through the matching `}` (spaces, `;` and quotes inside do not split), its braces literal;
 * a default (`:-`, `:=`, `:?`, `:+`) reads as the bare `${VAR}`. */
function readParameter(s: Lexer): void {
  const end = braceEnd(s.src, s.i + 1);
  const text = s.src.slice(s.i, end);
  // `${DIR:-/tmp/a b}` names the variable, never a path inside its default.
  append(s, /^\$\{[A-Za-z_]\w*:?[-=?+]/.test(text) ? text.replace(/^(\$\{[A-Za-z_]\w*)[\s\S]*$/, '$1}') : text);
  addSubs(s, liveSubstitutions(text));
  s.quoted = true;
  s.i = end;
}

/** Index just past the `}` closing the `{` at `open`, skipping quotes and `$(…)`; the end of input when unbalanced. */
function braceEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'" || c === '"') i = quoteEnd(src, i);
    else if (c === '$' && src[i + 1] === '(') i = closeParen(src, i + 1) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

function readArray(s: Lexer): void {
  const end = closeParen(s.src, s.i);
  append(s, s.src.slice(s.i, end));
  s.i = end;
}

function readRedirect(s: Lexer): void {
  const fd = s.src[s.i] === '&' ? '&' : s.word !== null && /^\d+$/.test(s.word) ? s.word : '';
  if (fd && fd !== '&') s.word = null; // a file-descriptor number, as in 2>&1
  endWord(s);
  s.i += s.src[s.i] === '&' ? 2 : 1;
  const doubled = s.src[s.i] === '>';
  if (doubled || s.src[s.i] === '|') s.i++;
  s.fd = fd;
  s.appendNext = doubled;
  if (s.src[s.i] === '&') { s.i++; s.next = 'drop'; } else s.next = 'redirect';
}

function readInput(s: Lexer): void {
  endWord(s);
  if (s.src.startsWith('<<<', s.i)) { s.i += 3; s.next = 'herestring'; return; }
  if (s.src.startsWith('<<', s.i)) { s.i += s.src[s.i + 2] === '-' ? 3 : 2; s.next = 'heredoc'; return; }
  s.i++;
  s.next = 'input';
}

function endWord(s: Lexer): void {
  if (s.word === null) return;
  const word = s.word, mode = s.next, quoted = s.quoted;
  s.word = null;
  s.quoted = false;
  s.next = 'word';
  if (mode === 'word') pushWords(s, quoted ? [word] : expandBraces(word));
  else if (mode === 'heredoc') { s.heredocs.push({ tag: word, live: !quoted }); s.seg.heredoc = true; s.heredocSeg = s.seg; }
  else if (mode === 'herestring') s.seg.body = [s.seg.body, word].filter(Boolean).join('\n');
  else if (mode === 'input') s.seg.input = word;
  else if (mode === 'redirect') recordRedirect(s, word);
}

const BRACES = /^([^{}]*)\{([^{}$]*,[^{}$]*)\}([^{}]*)$/;
const MAX_EXPANSION = 32;

/** `a/{x,y}.ts` → `a/x.ts a/y.ts`, as the shell expands it (one level; quoted words never reach here). */
function expandBraces(word: string): string[] {
  const match = BRACES.exec(word);
  if (!match) return [word];
  const parts = match[2].split(',');
  return parts.length > MAX_EXPANSION ? [word] : parts.map(part => match[1] + part + match[3]);
}

function recordRedirect(s: Lexer, word: string): void {
  const toStdout = s.fd === '' || s.fd === '1' || s.fd === '&';
  if (!toStdout || DEVICE.test(word)) return;
  s.seg.redirect = word;
  s.seg.append = s.appendNext;
}

function skipHeredocs(s: Lexer): void {
  const lines: string[] = [], live: string[] = [];
  while (s.heredocs.length && s.i < s.src.length) {
    const nl = s.src.indexOf('\n', s.i);
    const line = s.src.slice(s.i, nl < 0 ? s.src.length : nl);
    s.i = nl < 0 ? s.src.length : nl + 1;
    if (line.trim() === s.heredocs[0].tag) s.heredocs.shift();
    else { lines.push(line); if (s.heredocs[0].live) live.push(line); }
  }
  if (s.heredocSeg) {
    s.heredocSeg.body += lines.join('\n');
    const subs = liveSubstitutions(live.join('\n'));
    // Not `substituted`: no word (file name) holds these, the body only runs them.
    s.heredocSeg.subs = [...s.heredocSeg.subs, ...subs].slice(0, MAX_SUBS);
  }
  s.heredocs = [];
  s.heredocSeg = null;
}

/** The segment with its source text (`rm -rf "$(pwd)"`), bounded for risk texts. */
function closeSegment(s: Lexer, end: number): Segment {
  s.seg.text = s.src.slice(Math.max(s.segStart, s.start), end).trim().slice(0, 400);
  return s.seg;
}

function endStep(s: Lexer, end: number, nextStart: number): void {
  endWord(s);
  closeSegment(s, end);
  const pipes = [...s.step, s.seg].filter(seg => seg.words.length || seg.redirect);
  if (pipes.length) s.steps.push({ text: s.src.slice(s.start, end).trim(), pipes, next: s.src.slice(end, nextStart) });
  s.seg = newSegment(); s.testOpen = false;
  s.step = [];
  s.start = nextStart;
  s.segStart = nextStart;
}
