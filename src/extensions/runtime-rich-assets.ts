/**
 * Panel folders served from isolated, persistent per-package origins (R0302, ADR-0001, contract G2).
 *
 * The rules of `src-tauri/src/extensions/runtime_rich_assets.rs`, kept pure so the browser preview and the Node side
 * of the spec use the same answers as the native scheme handler:
 *
 * - a rich view is the legacy inline triple, a **folder** with an **entry** page, or a **remote** page whose origin is
 *   listed in `rich.remote` (up to sixteen https origins, shown at install);
 * - every package's panels are served from one origin of its own, `http://pandapanel.<key>.localhost` (the Windows
 *   form of the `pandapanel` scheme), `<key>` = `p` + 32 hex digits of SHA-256 over the package id: the same for every
 *   version, restart, placement and window, so the page's own storage is shared by that package's panels only;
 * - the host's shell on that origin frames the entry (same origin, first-party storage) or the remote page, owns the
 *   heartbeat, and its policy pins the frame to the package origin and `rich.remote`; package pages get no policy;
 * - paths resolve inside the folder with their media types, HTML pages receive the client script first, and every
 *   failure (outside the folder, another package's origin, the asset budget, an undeclared origin) answers a page or
 *   a note that says what is wrong.
 *
 * Browser preview: the installed scheme does not exist in a browser, so with `?rich-assets` the preview frames
 * `http://pandapanel.<key>.localhost/~panda/shell/<mount>?config=…`, which the spec answers with `respondPanel`
 * (`tests/extensions-runtime-rich-assets.spec.ts`). Without it a served panel shows a note; this column is PREVIEW,
 * never installed behaviour.
 *
 * No top-level browser state and no runtime imports: the spec imports this module in Node.
 */
import type { RegisteredView } from './views-state';

export const SCHEME = 'pandapanel';
export const RESERVED = '~panda';
export const MAX_REMOTE = 16;
export const MAX_ENTRY = 256;
export const MAX_URL = 1024;
export const SERVED_BUDGET = 256 * 1024 * 1024;
export const PREVIEW_FLAG = 'rich-assets';
const SHELL_STYLE = 'html,body{margin:0;height:100%;font:13px system-ui,sans-serif}body{display:flex;flex-direction:column}p[role=status]{margin:4px 8px;opacity:.7}iframe{flex:1;border:0;width:100%;min-height:0}';
const NOT_SERVED = "This address belongs to an extension panel. It is served only to that package's panels.";

export type ServedSource =
  | { kind: 'folder'; folder: string; entry: string; remote: string[] }
  | { kind: 'remote'; url: string; remote: string[] };
type RichDeclaration = Record<string, unknown>;

const FOLDER = /^[a-z0-9][a-z0-9_-]*$/;
/** `https://host[:port]`, lowercase host, no path: one entry of `rich.remote`. */
export function validOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || origin.length > 260 || !origin.startsWith('https://')) return false;
  const rest = origin.slice(8), colon = rest.lastIndexOf(':');
  const host = colon >= 0 ? rest.slice(0, colon) : rest, port = colon >= 0 ? rest.slice(colon + 1) : undefined;
  return host.length > 0 && host.length <= 253 && !/^[.-]|[.-]$|\.\./.test(host) && /^[a-z0-9.-]+$/.test(host)
    && (port === undefined || (/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535));
}
/** The origin of an https address, or `undefined` when it has none the host accepts. */
export function originOf(url: string): string | undefined {
  if (typeof url !== 'string' || !url.startsWith('https://')) return undefined;
  const rest = url.slice(8), end = rest.search(/[/?#]/);
  const origin = `https://${end < 0 ? rest : rest.slice(0, end)}`;
  return validOrigin(origin) ? origin : undefined;
}
/** A page path relative to the folder: segments of `[A-Za-z0-9_.-]` that never start with `.`. */
export const validEntry = (entry: string) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_ENTRY && entry.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part));

const invalid = (message: string) => `InvalidShape: ${message}`;
function remoteList(rich: RichDeclaration, required: boolean): string[] {
  if (!('remote' in rich)) { if (required) throw new Error(invalid('a remote page needs rich.remote.')); return []; }
  const items = rich.remote;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_REMOTE) throw new Error(invalid('rich.remote lists 1 to 16 origins.'));
  const origins: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !validOrigin(item)) throw new Error(invalid(`${JSON.stringify(item)} is not an https origin (https://host[:port], lowercase, no path).`));
    if (!origins.includes(item)) origins.push(item);
  }
  return origins;
}
/** Twin of `runtime_rich_assets::source`: `undefined` for the legacy triple, else the served form; throws `InvalidShape: …`. */
export function richSource(rich: unknown): ServedSource | undefined {
  if (!rich || typeof rich !== 'object' || Array.isArray(rich)) throw new Error(invalid('rich is an object.'));
  const value = rich as RichDeclaration, has = (key: string) => key in value;
  if (has('html') || has('css') || has('script')) {
    if (has('folder') || has('entry') || has('url') || has('remote')) throw new Error(invalid('a rich view is either inline files, a folder or a remote page, never a mix.'));
    return undefined;
  }
  if (has('folder')) {
    if (has('url')) throw new Error(invalid('a rich view is either a folder or a remote page, never both.'));
    if (typeof value.folder !== 'string' || value.folder.length > 64 || !FOLDER.test(value.folder)) throw new Error(invalid('rich.folder is an archive folder name (lowercase letters, digits, - and _).'));
    if (typeof value.entry !== 'string' || !validEntry(value.entry)) throw new Error(invalid('rich.entry is a page path inside the folder (no leading /, no . or .. segments, at most 256 characters).'));
    return { kind: 'folder', folder: value.folder, entry: value.entry, remote: remoteList(value, false) };
  }
  if (has('url')) {
    if (has('entry')) throw new Error(invalid('a remote page has no rich.entry.'));
    if (typeof value.url !== 'string' || value.url.length > MAX_URL || /\s/.test(value.url)) throw new Error(invalid('rich.url is an https address of at most 1,024 characters.'));
    const origin = originOf(value.url);
    if (!origin) throw new Error(invalid(`${value.url} is not an https address with a lowercase host.`));
    const remote = remoteList(value, true);
    if (!remote.includes(origin)) throw new Error(invalid(`the origin of rich.url (${origin}) is not listed in rich.remote.`));
    return { kind: 'remote', url: value.url, remote };
  }
  throw new Error(invalid('a rich view declares html/css/script, folder/entry or url.'));
}
/** The served form of a view's `rich`, or `undefined` for the legacy triple or an invalid declaration. */
export function servedSource(rich: unknown): ServedSource | undefined {
  try { return rich ? richSource(rich) : undefined; } catch { return undefined; }
}
/** The origins a package's panels declare (`rich.remote`), shown with the trust decision. */
export function declaredRemoteOrigins(manifest: { contributes?: { views?: { rich?: unknown }[] } }): string[] {
  const origins = new Set<string>();
  for (const view of manifest.contributes?.views ?? []) { const source = servedSource(view.rich); for (const origin of source?.remote ?? []) origins.add(origin); }
  return [...origins].sort();
}
export function declaredRemoteNote(manifest: { contributes?: { views?: { rich?: unknown }[] } }): string {
  const origins = declaredRemoteOrigins(manifest);
  return origins.length ? `Its panels load pages and frames from: ${origins.join(', ')}.` : '';
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256Base64(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...bytes));
}
const hashSource = async (source: string) => `'sha256-${await sha256Base64(source)}'`;
/** Twin of `runtime_rich_assets::origin_key`. */
export async function originKey(id: string): Promise<string> { return `p${(await sha256Hex(`pandacode-panel-origin-v1:${id}`)).slice(0, 32)}`; }
/** The Windows form of a package origin (the installed qualification target; the preview uses the same form). */
export const panelOrigin = (key: string) => `http://${SCHEME}.${key}.localhost`;
export const shellUrl = (key: string, label: string) => `${panelOrigin(key)}/${RESERVED}/shell/${label}`;
/** `[key, path]` of a request to the scheme in any form an engine hands over; query and fragment dropped. */
export function parsePanelUri(uri: string): [string, string] | undefined {
  const prefix = [`${SCHEME}://`, `http://${SCHEME}.`, `https://${SCHEME}.`].find(candidate => uri.startsWith(candidate));
  if (!prefix) return undefined;
  const rest = uri.slice(prefix.length), slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash), key = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : host;
  if (!/^p[0-9a-f]{32}$/.test(key)) return undefined;
  let path = slash < 0 ? '' : rest.slice(slash);
  const cut = path.search(/[?#]/); if (cut >= 0) path = path.slice(0, cut);
  return [key, path || '/'];
}
/** Twin of `runtime_rich_assets::folder_path`. */
export function folderPath(path: string): string | undefined {
  let decoded: string;
  try { if (/%(?![0-9a-fA-F]{2})/.test(path)) return undefined; decoded = decodeURIComponent(path); } catch { return undefined; }
  if (!decoded.startsWith('/')) return undefined;
  let relative = decoded.slice(1);
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  // eslint-disable-next-line no-control-regex
  return relative.length <= 1024 && !relative.includes('\\') && !/[\u0000-\u001f\u007f]/.test(relative) && relative.split('/').every(part => part !== '' && part !== '.' && part !== '..') ? relative : undefined;
}
const MEDIA: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', map: 'application/json', webmanifest: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', wasm: 'application/wasm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', xml: 'application/xml',
};
/** Twin of `runtime_rich_assets::media_type`. */
export function mediaType(path: string): string { const dot = path.lastIndexOf('.'); return (dot >= 0 && MEDIA[path.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'; }
/** Twin of `runtime_rich_assets::inject_client`: the client script first in an HTML page. */
export function injectClient(html: string, session: string): string {
  const tag = `<script src="/${RESERVED}/client.js" data-panda-session="${session}"></script>`, lower = html.toLowerCase();
  const after = (name: string) => {
    for (let start = lower.indexOf(name); start >= 0; start = lower.indexOf(name, start + 1)) {
      if (/[>/\s]/.test(lower[start + name.length] ?? '')) { const end = lower.indexOf('>', start); return end < 0 ? undefined : end + 1; }
    }
    return undefined;
  };
  const at = after('<head') ?? after('<html') ?? 0;
  return html.slice(0, at) + tag + html.slice(at);
}

export type PanelMount = { key: string; session: string; src: string; remote: string[]; expectsClient: boolean; dto: Record<string, unknown>; theme: Record<string, unknown> };
export type PanelServed = { owner: string; files: ReadonlyMap<string, Uint8Array | string>; wipe?: boolean };
export type PanelScripts = { channel: string; host: string; client: string };
export type PanelReply = { status: number; contentType: string; headers: Record<string, string>; body: Uint8Array | string };
const escapeJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
/** Twin of `runtime_rich_assets::shell_document`. */
export async function shellDocument(mount: PanelMount, ownOrigin: string, wipe: boolean, scripts: Pick<PanelScripts, 'channel' | 'host'>): Promise<{ html: string; policy: string }> {
  const script = `${scripts.channel}\n${scripts.host}`;
  const policy = `default-src 'none'; script-src ${await hashSource(script)}; style-src ${await hashSource(SHELL_STYLE)}; frame-src 'self'${mount.remote.map(origin => ` ${origin}`).join('')}; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const config = escapeJson({ session: mount.session, src: mount.src, origin: ownOrigin, frameOrigins: mount.remote, expectsClient: mount.expectsClient, wipe, dto: mount.dto, theme: mount.theme });
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Extension view</title><style>${SHELL_STYLE}</style></head><body><script type="application/json" id="panda-view-config">${config}</script><script>${script}</script></body></html>`, policy };
}
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const reply = (status: number, contentType: string, body: Uint8Array | string): PanelReply => ({ status, contentType, headers: { 'Cache-Control': 'no-store' }, body });
const page = (status: number, title: string, detail: string) => reply(status, 'text/html; charset=utf-8', `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`);
/** Twin of `Registry::respond`: the answer to `method uri` from the mount `label`. */
export async function respondPanel(input: { label: string; uri: string; method?: string; mounts: ReadonlyMap<string, PanelMount>; served: ReadonlyMap<string, PanelServed>; scripts: PanelScripts; onWiped?: (key: string) => void }): Promise<PanelReply> {
  const method = input.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return page(405, 'Method not allowed', 'Panel files are read-only.');
  const answer = await respondGet(input);
  return method === 'HEAD' ? { ...answer, body: '' } : answer;
}
async function respondGet({ label, uri, mounts, served, scripts, onWiped }: Parameters<typeof respondPanel>[0]): Promise<PanelReply> {
  const parsed = parsePanelUri(uri);
  if (!parsed) return page(404, 'Not a panel address', NOT_SERVED);
  const [key, path] = parsed, mount = mounts.get(label);
  if (!mount) return page(403, 'Not served here', NOT_SERVED);
  if (mount.key !== key) return page(403, "Another package's address", `This panel belongs to ${served.get(mount.key)?.owner ?? ''}; ${panelOrigin(key)} belongs to another package, whose files are served only to its own panels.`);
  const folder = served.get(key);
  if (!folder) return page(404, 'Panel closed', NOT_SERVED);
  if (path.startsWith(`/${RESERVED}/`)) {
    const rest = path.slice(RESERVED.length + 2);
    if (rest === 'client.js') return reply(200, 'text/javascript; charset=utf-8', `${scripts.channel}\n${scripts.client}`);
    if (rest === 'wiped') { onWiped?.(key); return reply(204, 'text/plain; charset=utf-8', ''); }
    if (rest === `shell/${label}`) {
      const { html, policy } = await shellDocument(mount, panelOrigin(key), !!folder.wipe, scripts);
      const answer = reply(200, 'text/html; charset=utf-8', html); answer.headers['Content-Security-Policy'] = policy; return answer;
    }
    return page(404, 'Not a host file', `/${RESERVED}/ is the host's own namespace on a panel origin.`);
  }
  const relative = folderPath(path);
  if (!relative) return page(404, 'Outside the panel folder', `${path} is not a path inside this panel's folder.`);
  const bytes = folder.files.get(relative);
  if (bytes === undefined) return page(404, 'Not in the panel folder', `${relative} is not a file of this panel's folder. Paths resolve relative to the folder; check the address and the archive.`);
  const media = mediaType(relative);
  if (media.startsWith('text/html')) return reply(200, media, injectClient(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes), mount.session));
  return reply(200, media, bytes);
}

/** Twin of `runtime_rich_assets::mount_for`. */
export function mountFor(owner: string, version: string, view: { id: string; title: string; text: string }, source: ServedSource, label: string, theme: Record<string, unknown>, key: string, session: string): PanelMount {
  const src = source.kind === 'folder' ? `/${source.entry}` : source.url;
  return { key, session, src, remote: source.remote, expectsClient: source.kind === 'folder' && /\.html?$/.test(source.entry), dto: { schemaVersion: 1, owner, version, viewId: view.id, windowId: label, title: view.title, text: view.text }, theme };
}

/** Notes for the failures this slice adds (the mount's own notes cover the rest). */
export const ASSET_RELOADABLE = ['origin'] as const;
export function assetEndedNote(reason: string): string | undefined {
  if (reason === 'origin') return 'The extension panel tried to open an address its package does not declare in rich.remote, and was closed. Reload the panel; the rest of PandaCode is unaffected.';
  return undefined;
}
export function assetRefusalNote(code: string): string | undefined {
  if (code.startsWith('LimitExceeded') && code.includes('panel assets')) return `Open extension panels hold too many panel files (${SERVED_BUDGET / 1024 / 1024} MiB). Close a panel of another package, then reload this one.`;
  if (code.startsWith('StaleContext')) return 'The package changed while the panel opened. Reload the panel to show the current version.';
  if (code.startsWith('UnsafeAsset')) return "The panel's declared files are not usable: check rich.folder, rich.entry or rich.url, then reinstall the package. The host-rendered view stays available.";
  if (code.startsWith('UnsupportedRuntime') && code.includes(PREVIEW_FLAG)) return 'The browser preview serves panel folders and remote pages only with ?rich-assets; the installed app serves them from the package origin. The host-rendered view stays available.';
  return undefined;
}

const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
/** Decodes the preview shell's `config` (the spec's route handler). */
export function previewMountFromUrl(url: string): { label: string; mount: PanelMount } | undefined {
  const parsed = parsePanelUri(url); const match = parsed && /^\/~panda\/shell\/([A-Za-z0-9-]+)$/.exec(parsed[1]);
  const config = new URL(url).searchParams.get('config');
  if (!match || !config) return undefined;
  const binary = atob(config.replaceAll('-', '+').replaceAll('_', '/'));
  return { label: match[1], mount: JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))) as PanelMount };
}
/**
 * Browser preview: the address a served panel opens (the shell of the package origin, with its mount in the query,
 * answered by the spec). Refuses with a note code without `?rich-assets`.
 */
export async function previewServedUrl(entry: RegisteredView, label: string): Promise<string> {
  const source = servedSource(entry.view.rich);
  if (!source) throw new Error('UnsafeAsset');
  if (!new URLSearchParams(location.search).has(PREVIEW_FLAG)) throw new Error(`UnsupportedRuntime: the browser preview serves panel folders only with ?${PREVIEW_FLAG}.`);
  const { appearanceSnapshot } = await import('./rich-views');
  const key = await originKey(entry.owner);
  const mount = mountFor(entry.owner, entry.version, entry.view, source, label, appearanceSnapshot(), key, crypto.randomUUID());
  return `${shellUrl(key, label)}?config=${base64url(JSON.stringify(mount))}`;
}
