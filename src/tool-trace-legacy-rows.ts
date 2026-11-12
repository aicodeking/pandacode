import type { Fields, TraceChip } from './tool-trace.ts';
import { COMPLETE, PARTIAL, clip, field, lines, linesPre, parseJson } from './tool-trace.ts';
import type { TraceParts } from './tool-trace-intent.ts';
import { ROW_TEXT, strings } from './tool-text.ts';

/* Rows and cards for legacy records that tool-trace-legacy.ts mapped: Devin `Ran grep, rg` rows (programs from the
 * title, the recorded text as output) and GitHub file fetches (`raw.githubusercontent.com`, `github.com/…/blob/…`,
 * the contents API). Pure and escaped (linesPre escapes). */

const PROGRAM_CHIPS = 3;
const OUTPUT_LINES = 8;
const FILE_LINES = 8;

/** `Ran [grep] [rg] in ./src`; undefined unless the call came from a `Ran …` title without a command. */
export function programsTrace(fields: Fields, failed: boolean): TraceParts | undefined {
  if (!Array.isArray(fields._programs)) return undefined;
  const programs = strings(fields._programs);
  const chips: TraceChip[] = programs.slice(0, PROGRAM_CHIPS).map(name => ({ icon: 'terminal', label: clip(name, 40), title: name }));
  const more = programs.length - chips.length;
  const where = field(fields, '_where');
  const object = [more > 0 ? `+${more} more ${more === 1 ? 'program' : 'programs'}` : '', where ? `in ${clip(where, ROW_TEXT)}` : ''].filter(Boolean).join(' ');
  // `in ./src` is prose around a place, never code.
  return { verb: failed ? 'Running' : 'Ran', chips, joined: true, object, mono: false, icon: 'terminal' };
}

/** The recorded text's last lines; the row already names the programs. */
export function programsCard(fields: Fields, output: string): string | undefined {
  if (!Array.isArray(fields._programs)) return undefined;
  const all = lines(output.trimEnd());
  const shown = all.slice(-OUTPUT_LINES);
  if (!shown.length) return COMPLETE;
  return (all.length > shown.length || fields._partial === true ? PARTIAL : '') + linesPre(shown, 'Command output, last lines');
}

/** The file a GitHub URL points at (raw file, blob or tree page, contents API), else undefined. */
export function githubFile(url: string): { repo: string; path: string } | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const host = parsed.hostname;
    if (host === 'raw.githubusercontent.com' && parts.length >= 4) return { repo: `${parts[0]}/${parts[1]}`, path: parts.slice(3).join('/') };
    if (host === 'github.com' && /^(blob|tree|raw)$/.test(parts[2] ?? '') && parts.length >= 5) return { repo: `${parts[0]}/${parts[1]}`, path: parts.slice(4).join('/') };
    if (host === 'api.github.com' && parts[0] === 'repos' && parts[3] === 'contents' && parts.length >= 5) return { repo: `${parts[1]}/${parts[2]}`, path: parts.slice(4).join('/') };
  } catch { /* not a URL: no file */ }
  return undefined;
}

/** A fetched file's first lines from the app's `{ content }` answer; undefined when it carried none (the caller lists results). */
export function githubFileCard(output: string): string | undefined {
  const start = output.search(/^[[{]/m);
  const json = start < 0 ? undefined : parseJson(output.slice(start));
  const record = json && typeof json === 'object' && !Array.isArray(json) ? json as Fields : {};
  const content = typeof record.content === 'string' && record.encoding !== 'base64' ? record.content : '';
  if (!content) return undefined;
  const all = lines(content);
  const shown = all.slice(0, FILE_LINES);
  return (all.length > shown.length ? PARTIAL : '') + linesPre(shown, 'File preview');
}
