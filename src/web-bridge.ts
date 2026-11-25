/**
 * Browser-mode transport. When PandaCode's built-in HTTP/WS server serves the UI to a
 * regular browser (`<meta name="pandacode-web">`), `call()` goes over `POST /api/invoke`
 * and `subscribe()` over one shared WebSocket at `/api/events`, both authenticated with
 * the session token. The token arrives once in the URL fragment (`#token=…`), is moved to
 * sessionStorage and stripped from the address bar; without a valid token an accessible
 * gate asks for it. Native dialogs (folder/file pickers) become simple path prompts,
 * because the paths name files on the host machine, not in this browser.
 *
 * The pure helpers at the top are imported by `tests/web-bridge.test.mjs` under Node, so
 * this module must not touch the DOM at load time outside a browser and has no static
 * relative imports (Node needs file extensions; Vite does not).
 */

export const TOKEN_STORAGE_KEY = 'pandacode.web.token';
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 5000;
export const BACKOFF_JITTER_MS = 250;
/** Offline this long before the reconnecting pill appears. */
export const OFFLINE_NOTICE_MS = 2000;
/** WebSocket close code the server uses for a rotated or revoked token. */
export const CLOSE_UNAUTHORIZED = 4001;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Takes `token` out of a URL fragment, keeping any other fragment params. */
export function extractTokenFromHash(hash: string): { token: string | null; cleanHash: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return { token: null, cleanHash: '' };
  const params = new URLSearchParams(raw);
  if (!params.has('token')) return { token: null, cleanHash: hash.startsWith('#') ? hash : `#${hash}` };
  const value = (params.get('token') ?? '').trim();
  params.delete('token');
  const rest = params.toString();
  return { token: value || null, cleanHash: rest ? `#${rest}` : '' };
}

/** Accepts a raw token or a pasted access link (`http://host:port/#token=…`); '' when neither. */
export function parseTokenInput(input: string): string {
  const text = (input ?? '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return validToken(extractTokenFromHash(url.hash).token ?? url.searchParams.get('token') ?? '');
    } catch { return ''; }
  }
  if (text.startsWith('#') || text.startsWith('token=')) return validToken(extractTokenFromHash(text).token ?? '');
  return validToken(text);
}

function validToken(value: string): string {
  const token = value.trim();
  return token && TOKEN_PATTERN.test(token) ? token : '';
}

/** Capped exponential backoff: 500 ms, 1 s, 2 s, 4 s, then 5 s, plus up to 250 ms jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(step, 16), BACKOFF_MAX_MS);
  const jitter = Math.min(Math.max(random(), 0), 1) * BACKOFF_JITTER_MS;
  return Math.round(base + jitter);
}

/** The message in a failed response body (`{ error }` as a string or object), or a status fallback. */
export function responseErrorMessage(body: unknown, status: number): string {
  const fallback = `PandaCode request failed (${status}).`;
  if (typeof body === 'string') return body.trim() || fallback;
  if (!body || typeof body !== 'object') return fallback;
  const error = (body as { error?: unknown }).error ?? body;
  if (typeof error === 'string') return error.trim() || fallback;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
let token: string | null = inBrowser ? initialToken() : null;
let authenticated = false;
let authPromise: Promise<void> | null = null;

function storage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function initialToken(): string | null {
  const { token: fromHash, cleanHash } = extractTokenFromHash(location.hash);
  if (location.hash && (fromHash || cleanHash !== location.hash)) {
    if (fromHash) storage()?.setItem(TOKEN_STORAGE_KEY, fromHash);
    history.replaceState(null, '', location.pathname + location.search + cleanHash);
  }
  return fromHash ?? storage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

function storeToken(value: string): void {
  token = value;
  authenticated = true;
  storage()?.setItem(TOKEN_STORAGE_KEY, value);
}

/** Forgets the token, but only if it is still the one that failed (a newer one may have arrived). */
function invalidateToken(failed: string | null): void {
  if (failed !== token) return;
  token = null;
  authenticated = false;
  storage()?.removeItem(TOKEN_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

const ROTATE_COMMAND = 'web_server_rotate_token';
const ROTATE_REFUSED = 'The access token was already replaced elsewhere. Enter the new token to reconnect.';
/** No call waits longer than this for a rotation to settle, whatever its caller does. */
export const ROTATION_WAIT_MS = 15_000;
const RAN_DURING_ROTATION = 'Access token rotated while request was running.';
type AuthResult = 'ok' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'unreachable' | 'error';
const FORBIDDEN_TEXT = 'PandaCode refused this request (Host or Origin check failed). Open the link directly on the host address.';

async function verifyToken(candidate: string): Promise<AuthResult> {
  try {
    const res = await fetch('/api/auth', { method: 'POST', headers: { Authorization: `Bearer ${candidate}` }, cache: 'no-store' });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'unauthorized';
    // A Host/Origin refusal says nothing about the token: never forget it for a 403.
    if (res.status === 403) return 'forbidden';
    if (res.status === 429) return 'rate-limited';
    return 'error';
  } catch (error) {
    console.warn('PandaCode web: auth request failed', error);
    return 'unreachable';
  }
}

function authErrorText(result: AuthResult): string {
  switch (result) {
    case 'unauthorized': return 'That token was not accepted. Copy the current one from PandaCode and try again.';
    case 'forbidden': return FORBIDDEN_TEXT;
    case 'rate-limited': return 'Too many attempts. Wait a moment, then try again.';
    case 'unreachable': return 'Could not reach PandaCode. Check that it is still running, then try again.';
    default: return 'PandaCode could not check the token. Try again.';
  }
}

/** Resolves once a verified token is held. Concurrent callers share one check and one gate. */
export function ensureAuth(reason?: string): Promise<void> {
  if (authenticated && token) return Promise.resolve();
  if (authPromise) return authPromise;
  authPromise = (async () => {
    let notice = reason;
    if (token) {
      const result = await verifyToken(token);
      if (result === 'ok') { authenticated = true; return; }
      if (result === 'unauthorized') invalidateToken(token);
      else notice = authErrorText(result);
    }
    await showAuthGate(notice);
  })().finally(() => { authPromise = null; });
  return authPromise;
}

async function showAuthGate(notice?: string): Promise<void> {
  await openPrompt({
    className: 'web-auth-gate',
    title: 'Connect to PandaCode',
    description: 'Paste the access token or link from PandaCode Settings → Connections → Remote access → Web access, or from the output of pandacode --port or pandacode serve --port.',
    label: 'Access token or link',
    placeholder: 'Token or http://…/#token=…',
    value: token ?? '',
    token: true,
    submitLabel: 'Connect',
    register: close => { dismissGate = () => close(token); },
    cancellable: false,
    notice,
    submit: async value => {
      const candidate = parseTokenInput(value);
      if (!candidate) return 'Paste the access token, or the full link that contains #token=.';
      const result = await verifyToken(candidate);
      if (result !== 'ok') return authErrorText(result);
      storeToken(candidate);
      return null;
    },
  });
  dismissGate = null;
}

/** Closes the open token gate, if any, as accepted (a token arrived another way). */
let dismissGate: (() => void) | null = null;

/**
 * Installs a token (raw or an access link) without asking, e.g. after the host rotated it and
 * this tab was handed the new one. The event stream reconnects with it; a close from the old
 * socket can no longer forget it. Returns false when the input holds no token.
 */
export function adoptWebToken(tokenOrUrl: string): boolean {
  const next = parseTokenInput(tokenOrUrl);
  if (!next) return false;
  storeToken(next);
  closedDuringRotation = null;
  settleRotationWaiters();
  dismissGate?.();
  const old = socket;
  if (old) {
    // Detached first, so its close event is ignored rather than treated as a drop or a revocation.
    socket = null;
    socketReady = false;
    try { old.close(1000, 'Token replaced'); } catch (error) { console.warn('PandaCode web: closing the old event stream failed', error); }
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ensureSocket();
  return true;
}

// ---------------------------------------------------------------------------
// call()
// ---------------------------------------------------------------------------

export async function webInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invokeOnce<T>(command, args, false);
}

async function invokeOnce<T>(command: string, args: Record<string, unknown>, retried: boolean): Promise<T> {
  await ensureAuth();
  const used = token;
  let res: Response;
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${used}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      cache: 'no-store',
    });
  } catch (error) {
    console.warn(`PandaCode web: ${command} could not reach the server`, error);
    throw new Error('Could not reach PandaCode. Check that it is still running.');
  }
  if (res.status === 401) {
    const body = await readBody(res);
    // Our own rotation request refused (another client rotated first): waiting for "our" rotation here would
    // wait on itself. Fail now, so the caller releases beginWebTokenRotation() and the new token is asked for.
    if (command === ROTATE_COMMAND) {
      invalidateToken(used);
      const reported = body && typeof body === 'object' ? (body as { error?: unknown }).error : body;
      throw new Error(typeof reported === 'string' && reported.trim() ? reported : ROTATE_REFUSED);
    }
    // The token rotated while the command was already running (server `guard_reply`): it ran, so it is
    // never sent again. Our own rotation still gets to install its token first, without the sign-in prompt.
    if (body && typeof body === 'object' && (body as { ran?: unknown }).ran === true) {
      if (rotatingToken > 0) await rotationSettled();
      invalidateToken(used); // only if no newer token arrived meanwhile
      const reported = (body as { error?: unknown }).error;
      throw new Error(typeof reported === 'string' && reported.trim() ? reported : RAN_DURING_ROTATION);
    }
    // This tab's own rotation is in flight: the old token just stopped working. Wait for the new one
    // rather than flashing the sign-in prompt; without one, fall through and ask as usual.
    if (rotatingToken > 0) {
      await rotationSettled();
      if (token && token !== used) return invokeOnce<T>(command, args, retried);
    }
    invalidateToken(used);
    if (retried) throw new Error('PandaCode did not accept the access token.');
    await ensureAuth('Access token expired or rotated. Enter the new token to reconnect.');
    return invokeOnce<T>(command, args, true);
  }
  if (!res.ok) throw new Error(responseErrorMessage(await readBody(res), res.status));
  if ((res.headers.get('Content-Type') ?? '').includes('application/octet-stream')) {
    // The desktop IPC hands raw replies over as an ArrayBuffer; callers read `.byteLength`.
    return (await res.arrayBuffer()) as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new Error(`PandaCode sent an unreadable reply to ${command}.`); }
}

async function readBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let socketReady = false;
let connecting = false;
let connectedBefore = false;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(name: string, payload: unknown): void {
  for (const listener of [...(listeners.get(name) ?? [])]) {
    try { listener(payload); } catch (error) { console.error(`PandaCode web: a "${name}" listener failed`, error); }
  }
}

function send(message: Record<string, unknown>): void {
  if (socket && socketReady && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export async function webListen(name: string, callback: Listener): Promise<() => void> {
  let set = listeners.get(name);
  if (!set) { set = new Set(); listeners.set(name, set); send({ type: 'subscribe', event: name }); }
  set.add(callback);
  ensureSocket();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = listeners.get(name);
    if (!current) return;
    current.delete(callback);
    if (current.size) return;
    listeners.delete(name);
    send({ type: 'unsubscribe', event: name });
  };
}

function ensureSocket(reason?: string): void {
  if (stoppedByUser || socket || connecting || reconnectTimer || !listeners.size) return;
  connecting = true;
  ensureAuth(reason)
    .then(openSocket)
    .catch(error => { console.warn('PandaCode web: could not open the event stream', error); scheduleReconnect(); })
    .finally(() => { connecting = false; });
}

function openSocket(): void {
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events`;
  // The token this socket authenticated with: a 4001 revokes this one, never a newer one.
  const socketToken = token;
  const ws = new WebSocket(url);
  socket = ws;
  socketReady = false;
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: socketToken })));
  ws.addEventListener('message', event => { if (socket === ws) handleMessage(ws, event.data); });
  ws.addEventListener('close', event => { if (socket === ws) handleClose(event, socketToken); });
}

function handleMessage(ws: WebSocket, data: unknown): void {
  let message: { type?: unknown; name?: unknown; payload?: unknown; event?: unknown };
  try { message = JSON.parse(String(data)); } catch { console.warn('PandaCode web: unreadable event frame'); return; }
  if (message.type === 'ready') {
    socketReady = true;
    attempt = 0;
    for (const name of listeners.keys()) ws.send(JSON.stringify({ type: 'subscribe', event: name }));
    clearOffline();
    // Events sent before these subscriptions landed were missed: after a drop, and also on the first
    // connection (between the startup loads and now). Views reload what they show.
    triggerResync();
    connectedBefore = true;
  } else if (message.type === 'lagged') {
    // The server dropped events for this slow client: the same full refresh as a reconnect.
    triggerResync();
  } else if (message.type === 'event' && typeof message.name === 'string') {
    dispatch(message.name, message.payload);
  } else if (message.type === 'error') {
    console.warn('PandaCode web: event stream error', message);
  }
}

let rotatingToken = 0;
/** Calls that met a 401 while this tab's rotation was in flight, waiting for its new token or its end. */
let rotationWaiters: (() => void)[] = [];
function settleRotationWaiters(): void {
  const waiting = rotationWaiters;
  rotationWaiters = [];
  for (const resume of waiting) resume();
}
/** Resolves once the pending rotation installs a token (adoptWebToken) or settles without one. */
function rotationSettled(): Promise<void> {
  if (rotatingToken <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const resume = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { rotationWaiters = rotationWaiters.filter(waiter => waiter !== resume); resolve(); }, ROTATION_WAIT_MS);
    rotationWaiters.push(resume);
  });
}
/** Token of a socket the server closed (4001) while a rotation was pending; null when none. */
let closedDuringRotation: string | null = null;

/**
 * Marks a token rotation this tab asked for (`web_server_rotate_token`) as in flight, so the
 * server's 4001 for the old socket does not open the token gate before the reply installs the
 * new token. Call the returned function when the request settles (success or failure).
 */
export function beginWebTokenRotation(): () => void {
  rotatingToken++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    rotatingToken = Math.max(0, rotatingToken - 1);
    if (!rotatingToken) settleRotationWaiters();
    if (rotatingToken || closedDuringRotation === null) return;
    const stale = closedDuringRotation;
    closedDuringRotation = null;
    // No new token arrived over the closed socket's: it is revoked, so ask as for any 4001.
    if (!socket && stale === (token ?? '')) {
      invalidateToken(token);
      ensureSocket('Access token rotated or revoked. Enter the new token to reconnect.');
    } else ensureSocket();
  };
}

/** Tells views that events may have been missed, so they reload everything they show. */
function triggerResync(): void {
  dispatch('sessions-changed', undefined);
  try { window.dispatchEvent(new CustomEvent('pandacode:web-resync')); } catch (error) { console.warn('PandaCode web: resync event failed', error); }
}

/**
 * A socket's close. A 4001 revokes `socketToken` (the token that socket signed in with), never a
 * newer one installed meanwhile. Exported for tests (`tests/web-bridge.test.mjs`).
 */
export function handleClose(event: Pick<CloseEvent, 'code'>, socketToken: string | null): void {
  socket = null;
  socketReady = false;
  // The server was stopped on purpose: its closing socket is expected, and nothing reconnects.
  if (stoppedByUser) return;
  if (event.code === CLOSE_UNAUTHORIZED && rotatingToken > 0) {
    // Our own rotation: the server closed the old socket before the new token's reply arrived.
    // adoptWebToken() reconnects with it; if the rotation fails, endRotation() reconnects instead.
    closedDuringRotation = socketToken ?? '';
    return;
  }
  if (event.code === CLOSE_UNAUTHORIZED) {
    invalidateToken(socketToken);
    ensureSocket('Access token rotated or revoked. Enter the new token to reconnect.');
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (stoppedByUser || reconnectTimer || !listeners.size) return;
  offlineTimer ??= setTimeout(() => showConnectionBanner(true), OFFLINE_NOTICE_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureSocket(); }, backoffDelay(attempt++));
}

function clearOffline(): void {
  if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
  showConnectionBanner(false);
}

/** Set once the web server was stopped on purpose: the tab stays offline, saying so, instead of retrying. */
let stoppedByUser = false;
export const WEB_STOPPED_TEXT = 'Web server stopped.';

/**
 * The web server this tab talks to was stopped (from this tab's Settings, which dispatches
 * `pandacode:web-stopped`, or by a caller). Stops reconnecting, closes the event stream, and shows a calm,
 * final notice in place of the pulsing "Reconnecting…" pill. `detail` says how to turn it back on.
 */
export function markWebServerStopped(detail?: string): void {
  stoppedByUser = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
  const old = socket;
  socket = null;
  socketReady = false;
  if (old) { try { old.close(1000, 'Web server stopped'); } catch (error) { console.warn('PandaCode web: closing the event stream failed', error); } }
  const hint = typeof detail === 'string' && detail.trim() ? ` ${detail.trim()}` : '';
  renderBanner(`${WEB_STOPPED_TEXT}${hint}`, true);
}
if (inBrowser) window.addEventListener('pandacode:web-stopped', event => markWebServerStopped((event as CustomEvent<unknown>).detail as string | undefined));

/** Held here rather than looked up: a dialog removed with the pill inside takes it out of the document. */
let bannerEl: HTMLElement | null = null;
function showConnectionBanner(show: boolean): void {
  // The stopped notice is final: neither "Reconnecting…" nor a reconnect replaces it.
  if (stoppedByUser) return;
  if (!show) { bannerEl?.remove(); bannerEl = null; watchDialogs(false); return; }
  renderBanner('Reconnecting to PandaCode…', false);
}

function renderBanner(text: string, stopped: boolean): void {
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
  let banner = bannerEl;
  watchDialogs(true);
  if (!banner) {
    void loadStyles();
    banner = document.createElement('div');
    banner.className = 'web-conn-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    const dot = document.createElement('span');
    dot.className = 'web-conn-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'web-conn-text';
    banner.append(dot, label);
    bannerEl = banner;
    document.body.append(banner);
  }
  const label = banner.querySelector<HTMLElement>('.web-conn-text');
  if (label && label.textContent !== text) label.textContent = text;
  if (stopped) banner.dataset.stopped = 'true'; else delete banner.dataset.stopped;
  placeBanner();
}

/** Open modal dialogs in top-layer order as far as the DOM tells (`:modal` where supported). */
function openModalDialogs(): HTMLDialogElement[] {
  try { return [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')]; }
  catch { return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')]; }
}

/** The pill lives in the topmost open modal dialog (any of the app's, or a prompt) while one is open, so it
 *  paints in the top layer above that dialog's ::backdrop; otherwise in the body. */
/** True while placeBanner() moves the pill, so the observer does not react to that move. */
let placingBanner = false;
function placeBanner(): void {
  const banner = bannerEl;
  if (!banner) return;
  const dialogs = openModalDialogs();
  // The most recently opened prompt is on top; otherwise the last open dialog in document order.
  const host = dialogs.filter(dialog => dialog.classList.contains('web-modal')).at(-1) ?? dialogs.at(-1) ?? document.body;
  if (banner.parentElement === host && banner.isConnected) return;
  placingBanner = true;
  try { host.append(banner); } finally { placingBanner = false; }
}

/** While the pill shows, it follows dialogs as they open, close or leave the page. */
let dialogWatch: MutationObserver | null = null;
function watchDialogs(on: boolean): void {
  if (!on) { dialogWatch?.disconnect(); dialogWatch = null; return; }
  if (dialogWatch || typeof MutationObserver === 'undefined') return;
  dialogWatch = new MutationObserver(records => {
    // A dialog rewrote its content (main.ts modal() sets innerHTML when one modal replaces another) and took the
    // pill with it: put it back at once, in the topmost open dialog or the body.
    if (!placingBanner && bannerEl && !bannerEl.isConnected) { placeBanner(); return; }
    const dialogChanged = records.some(record => record.type === 'attributes'
      || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
        && !node.classList.contains('web-conn-banner') && (node.matches('dialog') || Boolean(node.querySelector('dialog')))));
    if (dialogChanged) placeBanner();
  });
  dialogWatch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
}

// ---------------------------------------------------------------------------
// Path prompts (stand-ins for native pickers)
// ---------------------------------------------------------------------------

export async function webChooseFolder(title: string): Promise<string | null> {
  return webChoosePath(title, '/path/to/project', 'Folder path on the PandaCode machine');
}

export async function webChoosePath(title: string, placeholder = '/path/to/file', label = 'Path on the PandaCode machine'): Promise<string | null> {
  const value = await openPrompt({
    className: 'web-path-prompt', title, label, placeholder, submitLabel: 'Choose', cancellable: true,
    description: 'Files live on the computer running PandaCode, so type or paste the full path there.',
    submit: async input => (input.trim() ? null : 'Enter a path.'),
  });
  return value === null ? null : value.trim();
}

export async function webChoosePaths(title: string, multiple: boolean): Promise<string[]> {
  if (!multiple) { const one = await webChoosePath(title); return one ? [one] : []; }
  const value = await openPrompt({
    className: 'web-path-prompt', title, label: 'Paths on the PandaCode machine, one per line',
    placeholder: '/path/to/file.png\n/path/to/notes.md', submitLabel: 'Attach', cancellable: true, multiline: true,
    description: `Files live on the computer running PandaCode, so type or paste full paths there. ${submitHint()}`,
    submit: async input => (splitPaths(input).length ? null : 'Enter at least one path.'),
  });
  return value === null ? [] : splitPaths(value);
}

/** The multi-line prompt's submit shortcut, named for this keyboard. */
export function submitHint(platform = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : ''): string {
  return /mac|iphone|ipad/i.test(platform) ? 'Press ⌘+Enter to attach.' : 'Press Ctrl+Enter to attach.';
}

/**
 * Opens a link in this browser (the host's `open_external_url` would open it on the machine
 * running PandaCode). The same rule as the host: http(s) only, never embedded credentials.
 */
export function webOpenExternalUrl(url: string): void {
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !(parsed.protocol === 'http:' || parsed.protocol === 'https:') || parsed.username || parsed.password) {
    throw new Error('Only http and https links without credentials can be opened.');
  }
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

/** Clears a shown validation error as soon as the field holds something again (like Settings' port field). */
export function clearErrorOnInput(
  input: Pick<HTMLInputElement, 'value' | 'getAttribute' | 'addEventListener'>,
  setError: (text: string) => void,
): void {
  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true' && input.value.trim()) setError('');
  });
}

export function splitPaths(input: string): string[] {
  return input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

type PromptOptions = {
  className: string;
  title: string;
  description: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  cancellable: boolean;
  value?: string;
  /** The session-token field: visible text, never offered to password managers. */
  token?: boolean;
  multiline?: boolean;
  notice?: string;
  /** Receives a way to close the prompt from outside. */
  register?: (close: (value: string | null) => void) => void;
  /** Returns an error to show, or null when the value is accepted. */
  submit: (value: string) => Promise<string | null>;
};

let stylesLoaded: Promise<unknown> | null = null;
function loadStyles(): Promise<unknown> {
  stylesLoaded ??= import('./web-bridge.css').catch(error => console.warn('PandaCode web: styles failed to load', error));
  return stylesLoaded;
}
// Fetched now, while the server is reachable: the "Reconnecting…" pill appears only once it is not.
// (This module loads only in web mode, so desktop and preview startup are unaffected.)
if (inBrowser) void loadStyles();

let promptCount = 0;

/** Resolves with the accepted value, or null when cancelled. */
async function openPrompt(options: PromptOptions): Promise<string | null> {
  const [{ isImeKey, icon }] = await Promise.all([import('./dom'), loadStyles()]);
  const id = `web-prompt-${++promptCount}`;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // A modal <dialog> in the top layer: it stacks above any dialog already open (Open project → Browse…)
  // and makes everything beneath it inert until it closes, without touching #app.
  const overlay = document.createElement('dialog');
  overlay.className = `web-modal ${options.className}`;
  overlay.setAttribute('aria-labelledby', `${id}-title`);
  overlay.setAttribute('aria-describedby', `${id}-desc`);

  const form = document.createElement('form');
  form.className = 'web-modal-card';
  form.noValidate = true;
  const heading = document.createElement('h2');
  heading.id = `${id}-title`;
  heading.textContent = options.title;
  const description = document.createElement('p');
  description.id = `${id}-desc`;
  description.className = 'web-modal-desc';
  description.textContent = options.description;
  const label = document.createElement('label');
  label.htmlFor = `${id}-input`;
  label.textContent = options.label;
  const input = options.multiline ? document.createElement('textarea') : document.createElement('input');
  input.id = `${id}-input`;
  input.className = 'web-modal-input';
  input.placeholder = options.placeholder;
  input.value = options.value ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  if (input instanceof HTMLInputElement) input.type = 'text';
  else input.rows = 4;
  if (options.token) {
    input.name = 'pandacode-session-token';
    input.setAttribute('data-1p-ignore', '');
    input.setAttribute('data-lpignore', 'true');
  }
  // Context for why the prompt opened (a rotated token) is a status, not a validation error.
  const notice = document.createElement('p');
  notice.className = 'web-modal-notice';
  notice.id = `${id}-notice`;
  notice.setAttribute('role', 'status');
  notice.textContent = options.notice ?? '';
  notice.hidden = !options.notice;
  // The alert: a danger mark (no text, so textContent stays the message) and the message in normal ink.
  const error = document.createElement('p');
  error.className = 'web-modal-error';
  error.id = `${id}-error`;
  error.setAttribute('role', 'alert');
  error.dataset.empty = '';
  const errorIcon = document.createElement('span');
  errorIcon.className = 'web-modal-error-icon';
  errorIcon.dataset.stateTone = 'danger';
  errorIcon.setAttribute('aria-hidden', 'true');
  errorIcon.innerHTML = icon('alert');
  errorIcon.hidden = true;
  const errorText = document.createElement('span');
  errorText.className = 'web-modal-error-text';
  error.append(errorIcon, errorText);
  input.setAttribute('aria-describedby', options.notice ? `${id}-notice ${id}-error` : `${id}-error`);
  input.setAttribute('aria-invalid', 'false');
  const actions = document.createElement('div');
  actions.className = 'web-modal-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'ds-btn-primary web-modal-primary';
  submit.textContent = options.submitLabel;
  let cancel: HTMLButtonElement | null = null;
  if (options.cancellable) {
    cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ds-btn web-modal-secondary';
    cancel.textContent = 'Cancel';
    actions.append(cancel);
  }
  actions.append(submit);
  form.append(heading, description, notice, label, input, error, actions);
  overlay.append(form);

  const setError = (text: string) => {
    errorText.textContent = text;
    errorIcon.hidden = !text;
    error.toggleAttribute('data-empty', !text);
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
  };
  clearErrorOnInput(input, setError);

  return new Promise<string | null>(resolve => {
    let busy = false, closed = false;
    const close = (value: string | null) => {
      if (closed) return;
      closed = true;
      if (overlay.open && typeof overlay.close === 'function') overlay.close();
      overlay.remove();
      placeBanner();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    options.register?.(close);
    // While a submission is in flight, Cancel matches Escape and the native cancel: it does nothing.
    const setBusy = (value: boolean) => {
      busy = value;
      submit.disabled = value;
      if (cancel) cancel.disabled = value;
      if (value) overlay.setAttribute('aria-busy', 'true');
      else overlay.removeAttribute('aria-busy');
    };
    const accept = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const problem = await options.submit(input.value);
        if (problem === null) { close(input.value); return; }
        setError(problem);
      } catch (failure) {
        console.warn('PandaCode web: prompt submit failed', failure);
        setError('Something went wrong. Try again.');
      } finally {
        setBusy(false);
      }
      input.focus();
      input.select();
    };
    form.addEventListener('submit', event => { event.preventDefault(); void accept(); });
    cancel?.addEventListener('click', () => { if (busy) return; close(null); });
    // A click on the backdrop (the dialog box itself, outside the card) keeps focus in the input.
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) event.preventDefault(); });
    overlay.addEventListener('click', event => { if (event.target === overlay) input.focus(); });
    // The native Escape/close request: only a cancellable prompt closes, and always through close().
    // A submission in flight is never thrown away by Escape (native cancel or the key).
    overlay.addEventListener('cancel', event => { event.preventDefault(); if (options.cancellable && !busy) close(null); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (isImeKey(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (options.cancellable && !busy) close(null);
        return;
      }
      if (event.key === 'Enter' && event.target === input) {
        if (isImeKey(event)) return;
        // In the multi-line box a plain Enter is a new line; ⌘/Ctrl+Enter submits.
        if (input instanceof HTMLTextAreaElement && !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        void accept();
        return;
      }
      if (event.key === 'Tab') trapFocus(event, form);
    });
    document.body.append(overlay);
    if (typeof overlay.showModal === 'function') overlay.showModal();
    else overlay.setAttribute('open', '');
    placeBanner();
    input.focus();
    if (input.value) input.select();
  });
}

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = [...container.querySelectorAll<HTMLElement>('input, textarea, button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
