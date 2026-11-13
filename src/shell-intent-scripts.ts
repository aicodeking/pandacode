/* Inline scripts for shell-intent.ts: what a `python3 - <<EOF`, `python -c`, `node -e`, `perl -e`, `ruby -e` or
 * `osascript -e` script does (edits, reads, queries, fetches, runs a command) and what it deletes. Also finds the
 * text fed to a shell (`echo … | bash`) and the commands inside `$(…)`, backticks and `<(…)`. Pure and total. */
import { basename, clip, desc, isImagePath, urlParts, withImage, type Desc, type Recurse, type Risk, type Segment } from './shell-intent-base.ts';
import { lex } from './shell-intent-lex.ts';
import { SEVERITY, riskLine, risksOf, withCommandRisk } from './shell-intent-risk.ts';

export const LANGUAGES: Record<string, string> = {
  python: 'Python', node: 'Node', bun: 'Bun', deno: 'Deno', perl: 'Perl', ruby: 'Ruby', php: 'PHP', osascript: 'AppleScript', tsx: 'Node', 'ts-node': 'Node',
};
export const languageOf = (program: string): string | undefined => LANGUAGES[/^python[\d.]*$/.test(program) ? 'python' : program];

/** A quoted path: group 1 the quote, group 2 the path (never an interpolation). */
const LITERAL = /(['"`])([^'"`\n$]+)\1/.source;
const NAME = /([A-Za-z_]\w*)/.source;
/** Writes whose path is a literal (`path` group) or a variable (`name` group). */
const WRITES: { pattern: RegExp; path?: number; name?: number }[] = [
  { pattern: new RegExp(`\\bopen\\(\\s*(?:${LITERAL}|${NAME})\\s*,\\s*(?:mode\\s*=\\s*)?['"][wa]`), path: 2, name: 3 },
  { pattern: new RegExp(`\\bPath\\(\\s*${LITERAL}\\s*\\)\\.write_(?:text|bytes)\\(`), path: 2 },
  { pattern: new RegExp(`\\b${NAME}\\.write_(?:text|bytes)\\(`), name: 1 },
  { pattern: new RegExp(`\\bwriteFile(?:Sync)?\\(\\s*(?:${LITERAL}|${NAME})\\s*,`), path: 2, name: 3 },
];
/** A bare `open(` (never a method: `tarfile.open('x.tar')`, `p.open('rb')`). */
const BARE_OPEN = String.raw`(?<![.\w])open\(`;
const READS = [
  new RegExp(`${BARE_OPEN}\\s*${LITERAL}\\s*(?:\\)|,\\s*(?:mode\\s*=\\s*)?['"]r)`),
  new RegExp(`\\bPath\\(\\s*${LITERAL}\\s*\\)\\.(?:read_text|read_bytes|open)\\(`),
  new RegExp(`\\b(?:readFileSync|readFile|File\\.read|File\\.readlines|IO\\.read|Bun\\.file|Deno\\.readTextFile)\\(\\s*${LITERAL}`),
];
/** Reads through a variable holding a literal path (`p = 'a.ts'; open(p).read()`, `readFileSync(p, 'utf8')`). */
const VARIABLE_READS = new RegExp(`(?:${BARE_OPEN}|\\b(?:readFileSync|readFile|Path)\\()\\s*${NAME}\\s*(?:\\)|,\\s*(?:mode\\s*=\\s*)?['"](?:r|utf))`);
/** `p.open('rb')`, `p.read_text()` where `p = Path('a.bin')`: the receiver names the file. */
const PATH_METHOD_READS = new RegExp(`\\b${NAME}\\.(?:open|read_text|read_bytes)\\(`, 'g');
const DATABASES = new RegExp(`\\b(?:sqlite3\\.connect|Database|SQLite3::Database\\.new|duckdb\\.connect)\\(\\s*${LITERAL}`);
const FETCHES = /\b(?:requests\.(?:get|post|put|patch|delete|head)|httpx\.(?:get|post|put|patch|delete)|urlopen|urllib\.request\.Request|fetch|axios(?:\.\w+)?|https?\.get|URI|open-uri)\(\s*(['"`])(https?:\/\/[^'"`\s]+)\1/;
/** Commands run through a shell string or an argument list. */
const SHELL_CALLS = /\b(?:os\.system|os\.popen|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput)|execSync|execFileSync|spawnSync|exec|spawn|system|do shell script)\s*\(?\s*(\[[^\]]*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)(?:\s*,\s*(\[[^\]]*\]))?/g;
const STRING = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*)`/g;

/** The literal path a variable was assigned (`p = 'a.ts'`, `f = Path("a.py")`, `const p = 'a.ts'`). */
function assignedPath(text: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s;(])${name}\\s*=\\s*(?:Path\\(\\s*|path\\.resolve\\(\\s*)?${LITERAL}`, 'm').exec(text)?.[2];
}

/** A file an inline script writes: its path, the variable naming it (if any) and whether the write truncates it. */
interface Written { path: string; name?: string; truncates: boolean }

/** The first file an inline script clearly writes, when its path is a literal or a variable holding one. */
function writtenFile(text: string): Written | undefined {
  for (const { pattern, path, name } of WRITES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const variable = name !== undefined ? match[name] : undefined;
    const found = (path !== undefined ? match[path] : undefined) ?? (variable ? assignedPath(text, variable) : undefined);
    if (found) return { path: found, name: variable, truncates: /['"]w|write_|writeFile/.test(match[0]) };
  }
  return undefined;
}

export const editedFile = (text: string): string | undefined => writtenFile(text)?.path;

const OPENS_BEFORE = /\b(?:open|readFileSync|readFile)\(\s*$/;
const OPENS_AFTER = /^\s*(?:\)|,\s*(?:mode\s*=\s*)?['"]r|,\s*['"]utf)/;
const PATH_BEFORE = /\bPath\(\s*$/;
const READ_METHOD = /^\.(?:read_text|read_bytes|open)\(/;
const PATH_AFTER = /^\s*\)\.(?:read_text|read_bytes|open)\(/;
const WORD_CHAR = /[\w$]/;
const MAX_MENTIONS = 16;
const LOOK = 40;

/** Up to MAX_MENTIONS places `needle` occurs in `text`, by string search (no pattern built from script text). */
function mentions(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0 && out.length < MAX_MENTIONS; at = text.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

/** Whether the script also reads the file it writes (`s = open(p).read()`, `f.read_text()`, `writeFileSync(p, readFileSync(p))`). */
function readsTarget(text: string, written: Written): boolean {
  const quotedPath = ['"', "'", '`'].map(quote => `${quote}${written.path}${quote}`);
  const opened = (at: number, length: number) => {
    const before = text.slice(Math.max(0, at - LOOK), at), after = text.slice(at + length, at + length + LOOK);
    return (OPENS_BEFORE.test(before) && OPENS_AFTER.test(after)) || (PATH_BEFORE.test(before) && PATH_AFTER.test(after));
  };
  if (quotedPath.some(needle => mentions(text, needle).some(at => opened(at, needle.length)))) return true;
  const name = written.name;
  if (!name) return false;
  return mentions(text, name).some(at => !WORD_CHAR.test(text[at - 1] ?? '') && !WORD_CHAR.test(text[at + name.length] ?? '')
    && (opened(at, name.length) || READ_METHOD.test(text.slice(at + name.length, at + name.length + LOOK))));
}

const strings = (text: string): string[] => [...text.matchAll(STRING)].map(match => match[1] ?? match[2] ?? match[3] ?? '');

/** `os.system('rm -rf x')`, `subprocess.run(['git', 'status'])`, `spawnSync('rm', ['-rf', 'x'])`: the commands a script runs. */
export function shellCalls(text: string): string[] {
  return [...text.slice(0, 20_000).matchAll(SHELL_CALLS)].map(match => {
    const [, first = '', list = ''] = match;
    const head = first.startsWith('[') ? strings(first).join(' ') : strings(first)[0] ?? '';
    return [head, ...strings(list)].join(' ').replace(/\\n/g, '\n');
  }).filter(command => command.trim());
}

/** Risks of each command, classified one pipe stage at a time. */
export function commandRisks(command: string, recurse: Recurse): Risk[] {
  return lex(command).flatMap(step => step.pipes.flatMap(seg => risksOf(withCommandRisk(recurse(seg.words, seg), seg.text || seg.words.join(' ')))));
}

/** [pattern, reason, severity]: library calls in a script body that lose data, matched on code without its strings or comments. */
const SCRIPT_DANGER: [RegExp, string, number][] = [
  [/\b(?:shutil\.)?rmtree\s*\(|\bFileUtils\.rm_rf?\b|\b(?:rimraf|remove_tree|rm_rf)(?:\.sync)?\s*\(|\.(?:rm|rmdir)(?:Sync)?\([^)]*recursive/, 'Deletes a folder', SEVERITY.tree],
  [/\bos\.(?:remove|unlink|rmdir|removedirs)\(|\.unlink\(|\bunlink\b|\.(?:rm|rmdir|unlink)(?:Sync)?\(|\bFile\.delete\b|\bFileUtils\.rm\b|\bDeno\.remove\b/, 'Deletes files', SEVERITY.other],
  [/\bgit\s+(?:reset\s+--hard|push\s+(?:-f|--force)|clean\s+-\w*f)/, 'Runs a destructive git command', SEVERITY.critical],
];
/** SQL that loses data, only at the start of a string or after a `;` (statement starts), in uppercase. */
const SQL_DANGER: [RegExp, string, number][] = [
  [/(?:^|;)\s*(DROP\s+(?:TABLE|DATABASE|SCHEMA)\s+[^;]*)/, 'Drops a table', SEVERITY.tree],
  [/(?:^|;)\s*(DELETE\s+FROM\s+\w[^;]*|TRUNCATE\s+TABLE\s+\w[^;]*)/, 'Deletes rows', SEVERITY.other],
];

/** A script with every string literal's contents and every comment blanked to spaces (same length, newlines kept), and
 * the contents of its top-level strings. Python triple quotes, `'`, `"` and backticks; `#` or `//` and block comments by language. */
interface Scanned { code: string; strings: string[] }

const HASH_COMMENTS = /^(?:Python|Ruby|Perl|PHP)$/;
const SLASH_COMMENTS = /^(?:Node|Bun|Deno|PHP)$/;
const blank = (text: string) => text.replace(/[^\n]/g, ' ');

/** Where the comment or string starting at `i` ends, or -1 when none starts there. */
function literalEnd(text: string, i: number, language: string): number {
  const c = text[i], two = text.slice(i, i + 2), three = text.slice(i, i + 3);
  if ((c === '#' && HASH_COMMENTS.test(language)) || (two === '//' && SLASH_COMMENTS.test(language))) {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;
  }
  if (two === '/*' && SLASH_COMMENTS.test(language)) { const close = text.indexOf('*/', i + 2); return close < 0 ? text.length : close + 2; }
  const quote = three === "'''" || three === '"""' ? three : /['"`]/.test(c) ? c : '';
  if (!quote) return -1;
  for (let j = i + quote.length; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text.startsWith(quote, j)) return j + quote.length;
    else if (text[j] === '\n' && quote.length === 1 && quote !== '`') return j;
  }
  return text.length;
}

export function scanScript(text: string, language: string): Scanned {
  let code = '', i = 0;
  const strings: string[] = [];
  while (i < text.length) {
    const end = literalEnd(text, i, language);
    if (end < 0) { code += text[i++]; continue; }
    const quote = /^(?:'''|""")/.test(text.slice(i, i + 3)) ? 3 : /['"`]/.test(text[i]) ? 1 : 0;
    if (quote) {
      const close = text.slice(end - quote, end) === text.slice(i, i + quote) && end - quote > i ? quote : 0;
      strings.push(text.slice(i + quote, end - close));
      code += text.slice(i, i + quote) + blank(text.slice(i + quote, end - close)) + text.slice(end - close, end);
    } else code += blank(text.slice(i, end));
    i = end;
  }
  return { code, strings };
}

/** `shutil.rmtree('src')`, `.rmSync('.', {recursive:true})`: the matched call through its closing parenthesis (found in
 * the blanked code, so a `)` inside a string never ends it), else up to a quote or `;` (bounded). */
function dangerSnippet(text: string, code: string, pattern: RegExp): string {
  const match = pattern.exec(code);
  if (!match) return '';
  let depth = 0, close = -1;
  for (let j = match.index; j < Math.min(code.length, match.index + 80) && close < 0; j++) {
    if (code[j] === '(') depth++;
    else if (code[j] === ')' && --depth === 0) close = j + 1;
  }
  if (close > 0) return text.slice(match.index, close).trim();
  const rest = text.slice(match.index, match.index + 80), end = match[0].length;
  const stop = rest.slice(end).search(/['"`;\n)]/);
  return (stop >= 0 ? rest.slice(0, end + stop) : rest).trim();
}

/** `DELETE FROM users WHERE …` at the start of a top-level string (`c.execute("…")`), never SQL quoted inside other code. */
function sqlRisks(strings: string[], language: string): Risk[] {
  return SQL_DANGER.flatMap(([pattern, reason, severity]) => {
    const statement = strings.map(text => pattern.exec(text)?.[1]).find(Boolean);
    return statement ? [{ text: riskLine(reason, `${clip(statement.trim().replace(/\s+/g, ' '), 80)} in ${language}`), severity }] : [];
  });
}

/** What a script body deletes: library calls outside strings and comments, SQL statements and the commands it runs. */
export function scriptRisks(text: string, language: string, recurse: Recurse): Risk[] {
  const bounded = text.slice(0, 20_000);
  const { code, strings } = scanScript(bounded, language);
  const fromCalls = shellCalls(bounded).flatMap(command => commandRisks(command, recurse));
  const matched = SCRIPT_DANGER.filter(([pattern]) => pattern.test(code));
  // A recursive delete also matches the plain one; say it once.
  const own = matched.filter(([, reason]) => !(reason === 'Deletes files' && matched.some(([, other]) => other === 'Deletes a folder')))
    .map(([pattern, reason, severity]) => ({ text: riskLine(reason, `${clip(dangerSnippet(bounded, code, pattern), 80)} in ${language}`), severity }));
  return [...own, ...sqlRisks(strings, language), ...fromCalls];
}

const NOISE_LINE = /^(?:#|\/\/|import\s|from\s+\S+\s+import\b|use\s|require\(\s*['"][^'"]+['"]\s*\)\s*$|'use strict'|"use strict"|(?:const|let|var)\s+\w+\s*=\s*require\(|package\s|<\?php)/;

/** The first statement that does something (not an import, comment or blank line). */
export function firstStatement(text: string): string {
  for (const line of text.split('\n')) {
    for (const statement of line.split(/;\s*/)) {
      const trimmed = statement.trim();
      if (trimmed && !NOISE_LINE.test(trimmed)) return clip(trimmed, 60);
    }
  }
  return '';
}

/** The inline script text: heredoc body plus every `-c`/`-e`/`--eval`/`-p` value. */
export function inlineText(args: string[], seg: Segment): string {
  const values = args.flatMap((arg, i) => /^-(?:c|e|-eval|p|-print|[a-z]*e)$/.test(arg) ? [args[i + 1] ?? ''] : []);
  return [seg.body, ...values].filter(Boolean).join('\n');
}

const withLanguage = (described: Desc, language: string): Desc => ({ ...described, object: [described.object, `with ${language}`].filter(Boolean).join(' ') });

/** What an inline script does, by the first clear effect: an edit, a database, a fetch, a command, a read. */
function scriptEffect(text: string, language: string, recurse: Recurse): Desc | undefined {
  const written = writtenFile(text);
  if (written) {
    const verb = written.truncates && !readsTarget(text, written) ? 'Wrote' : 'Edited';
    return desc('file', verb, clip(basename(written.path), 48), `with ${language}`, 'edit');
  }
  const database = DATABASES.exec(text)?.[2];
  if (database) return desc('db', 'Queried', clip(basename(database), 48), `with ${language}`);
  const url = FETCHES.exec(text)?.[2];
  const host = url ? urlParts(url)?.[0] : undefined;
  if (host) return desc('fetch', 'Fetched', clip(host, 48), `with ${language}`);
  const read = READS.map(pattern => pattern.exec(text)?.[2]).find(Boolean) ?? variableRead(text);
  return read ? desc('read', 'Read', clip(basename(read), 48), `with ${language}`) : deletingCall(text, language, recurse);
}

/** `p = 'tests/ui.spec.ts'; s = open(p).read()`: the literal path a read variable holds. */
function variableRead(text: string): string | undefined {
  const name = VARIABLE_READS.exec(text)?.[1];
  return (name ? assignedPath(text, name) : undefined) ?? pathMethodRead(text);
}

/** The first `p.open(…)` whose `p` was assigned `Path('…')` (bounded: the first few method calls only). */
function pathMethodRead(text: string): string | undefined {
  for (const match of [...text.slice(0, 20_000).matchAll(PATH_METHOD_READS)].slice(0, 8)) {
    const path = new RegExp(`(?:^|[\\s;(])${match[1]}\\s*=\\s*Path\\(\\s*${LITERAL}`, 'm').exec(text)?.[2];
    if (path) return path;
  }
  return undefined;
}

/** `subprocess.run(['rm', '-rf', 'old'])`: a command the script runs leads the row only when it deletes (`Deleted [old]
 * with Python`); any other command (`git status`, `[BIN, '--validate-only']`) leaves the row to the script itself. */
function deletingCall(text: string, language: string, recurse: Recurse): Desc | undefined {
  for (const command of shellCalls(text).slice(0, 8)) {
    for (const seg of lex(command).flatMap(step => step.pipes)) {
      const inner = recurse(seg.words, seg);
      if (inner?.destructive && !inner.raw && inner.verb === 'Deleted') return withLanguage({ ...inner, destructive: undefined, risks: undefined, severity: undefined, producedImage: undefined }, language);
    }
  }
  return undefined;
}

/** Languages whose inline scripts save images through the calls IMAGE_SAVES knows. */
const IMAGE_LANGUAGES = new Set(['Python', 'Node', 'Deno', 'Bun']);
/** A literal path an image library writes, as the last group: Playwright/Puppeteer `.screenshot({ path: 'x.png' })` and
 * `.screenshot(path="x.png")`, PIL `.save('x.png')`, matplotlib `savefig('x.png')`. Kept in step with Rust's
 * tool_images_auth (tests/fixtures/produced-images.json). Bounded gaps, one line, so any script stays linear. */
const IMAGE_SAVES = /\.screenshot\(\s*\{?[^()\n]{0,200}?\bpath\s*[:=]\s*(['"`])([^'"`\n$]{1,300})\1|(?:\.save|\bsavefig)\(\s*(['"])([^'"\n]{1,300})\3/g;
const MAX_SCRIPT = 20_000;

/** The last literal image path an inline script saves (isImagePath decides the format and rejects `{name}.png`). */
export function scriptImage(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.slice(0, MAX_SCRIPT).matchAll(IMAGE_SAVES)) {
    const path = match[2] ?? match[4];
    if (isImagePath(path)) found = path;
  }
  return found;
}

/** `python3 - <<EOF`, `node -e`, `osascript -e`: the script's effect and what it deletes; without a clear effect a heredoc
 * reads `Ran [Python script]` and a one-liner its first statement. */
export function inlineScript(program: string, text: string, recurse: Recurse, heredoc = false): Desc {
  const language = languageOf(program) ?? program;
  const plain = heredoc ? desc('script', 'Ran', `${language} script`) : desc('script', 'Ran script', program, firstStatement(text));
  const described = withImage(scriptEffect(text, language, recurse) ?? plain, IMAGE_LANGUAGES.has(language) ? scriptImage(text) : undefined);
  const risks = scriptRisks(text, language, recurse);
  if (!risks.length) return described;
  return { ...described, destructive: true, severity: risks.reduce((max, risk) => Math.max(max, risk.severity), 0), risks };
}

/** The text a pipe stage feeds to the next: `echo`/`printf` arguments, a heredoc body. */
export function fedText(seg: Segment, words: string[]): string {
  const program = basename(words[0] ?? '');
  if (program === 'echo' || program === 'printf') return words.slice(1).filter(word => !/^-[neE]+$/.test(word)).join(' ').replace(/\\n/g, '\n');
  return seg.body;
}
