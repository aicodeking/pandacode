/** A tool call's JSON input as fields. Records are stored cut at 4 KB with a `[Preview truncated]` tail, so a
 *  JSON object that does not parse keeps every key and value read before the cut (the last value as far as it
 *  goes) and is marked `_partial: true`. Pure; the one parser every trace module shares. */

export type Fields = Record<string, unknown>;

/** The key that marks fields salvaged from a cut record. Keys starting with `_` never show in argument tables. */
export const PARTIAL_KEY = '_partial';
const MAX_SCAN = 20_000;
const CUT_TAIL = /\n?\[Preview truncated\]\s*$/;
const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/** Whether a stored input or output was cut by the recorder. */
export function isCut(value: string): boolean { return CUT_TAIL.test(value); }
/** The value without the recorder's `[Preview truncated]` tail. */
export function withoutCut(value: string): string { return value.replace(CUT_TAIL, ''); }

function isRecord(value: unknown): value is Fields { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

// A cursor over the text; `ok: false` means the text ended (or broke) inside the value, which is kept as far as it went.
type Cursor = { text: string; at: number };
type Read = { value: unknown; ok: boolean };

function skipSpace(cursor: Cursor): void {
  while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at])) cursor.at++;
}

function readString(cursor: Cursor): Read {
  const { text } = cursor;
  let value = '';
  let at = cursor.at + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') { cursor.at = at + 1; return { value, ok: true }; }
    if (char !== '\\') { value += char; at++; continue; }
    const code = text[at + 1];
    if (code === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(at + 2, at + 6))) { value += String.fromCharCode(parseInt(text.slice(at + 2, at + 6), 16)); at += 6; continue; }
    if (code === undefined || !Object.hasOwn(ESCAPES, code)) break;
    value += ESCAPES[code];
    at += 2;
  }
  cursor.at = text.length;
  return { value, ok: false };
}

function readLiteral(cursor: Cursor): Read {
  const match = LITERAL.exec(cursor.text.slice(cursor.at, cursor.at + 40));
  // A number that runs into the cut may be missing digits, so it is dropped.
  if (!match || cursor.at + match[0].length >= cursor.text.length) return { value: undefined, ok: false };
  cursor.at += match[0].length;
  return { value: JSON.parse(match[0]), ok: true };
}

function readObject(cursor: Cursor): Read {
  const value: Fields = {};
  cursor.at++;
  for (;;) {
    skipSpace(cursor);
    const char = cursor.text[cursor.at];
    if (char === '}') { cursor.at++; return { value, ok: true }; }
    if (char === ',') { cursor.at++; continue; }
    if (char !== '"') return { value, ok: false };
    const key = readString(cursor);
    skipSpace(cursor);
    if (!key.ok || cursor.text[cursor.at] !== ':') return { value, ok: false };
    cursor.at++;
    const item = readValue(cursor);
    // A `__proto__` key must not reach the prototype.
    if (item.value !== undefined && key.value !== '__proto__') value[key.value as string] = item.value;
    if (!item.ok) return { value, ok: false };
  }
}

function readArray(cursor: Cursor): Read {
  const value: unknown[] = [];
  cursor.at++;
  for (;;) {
    skipSpace(cursor);
    const char = cursor.text[cursor.at];
    if (char === ']') { cursor.at++; return { value, ok: true }; }
    if (char === ',') { cursor.at++; continue; }
    if (char === undefined) return { value, ok: false };
    const item = readValue(cursor);
    if (item.value !== undefined) value.push(item.value);
    if (!item.ok) return { value, ok: false };
  }
}

function readValue(cursor: Cursor): Read {
  skipSpace(cursor);
  const char = cursor.text[cursor.at];
  if (char === '{') return readObject(cursor);
  if (char === '[') return readArray(cursor);
  if (char === '"') return readString(cursor);
  return char === undefined ? { value: undefined, ok: false } : readLiteral(cursor);
}

/** Leading fields of a cut JSON object, or undefined when nothing was read. */
export function salvageFields(input: string): Fields | undefined {
  const text = withoutCut(input).trim();
  if (!text.startsWith('{')) return undefined;
  const { value } = readObject({ text, at: 0 });
  return isRecord(value) && Object.keys(value).length ? value : undefined;
}

/** A JSON object input as fields; a cut object keeps what was read, with `_partial: true`; anything else is `{}`. */
export function parseFields(input: string): Fields {
  const value = input.slice(0, MAX_SCAN).trim();
  if (!value.startsWith('{')) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    const salvaged = salvageFields(value);
    return salvaged ? { ...salvaged, [PARTIAL_KEY]: true } : {};
  }
}
