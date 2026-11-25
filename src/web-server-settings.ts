/* Settings → Connections → Remote access → Web access: serve this live PandaCode session to a browser on a
 * chosen port. The server binds to 127.0.0.1 and every link carries a secret access token. */
import './web-server-settings.css';
import { escape, icon, isImeKey, morph } from './dom';
import { errorText } from './error-text';
import { infoMark } from './tooltip';

export interface WebServerStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  /** The bound port while running, 0 when stopped. */
  port: number;
  /** The saved port (default 47322; 0 = pick an open port automatically). */
  configuredPort: number;
  url: string | null;
  tokenUrl: string | null;
  clients: number;
  error: string | null;
  /** Bumps on every start and token rotation; events carry it so a rotation elsewhere is noticed. */
  tokenGeneration?: number;
}

export interface WebServerHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: string, callback: (payload: any) => void): Promise<() => void>;
  notify(text: string): void;
  notifyError?(text: string): void;
  openUrl(url: string): Promise<void>;
}

export type PortParse = { ok: true; port: number } | { ok: false; error: string };

export const MAX_PORT = 65535;
const PORT_RANGE_ERROR = `Enter a port between 0 and ${MAX_PORT} (0 picks an open port automatically).`;
const SERVE_TIP = 'Serves this live PandaCode session to a browser with a secret access token. By default it listens only on 127.0.0.1; to reach it from another machine, forward the port over an SSH tunnel.';
const PORT_TIP = 'Any open port from 1 to 65535, or 0 to let the system choose one. A browser tab that applies the change moves to the new port; other connected browsers disconnect and need the new link.';
const MOVE_DETAIL = 'This tab will try to open the new port. If you connected through an SSH tunnel or port forward, update it to point to the new port.';
const STOP_TITLE = 'Stop the web server?';
/** How to get the server back, for the desktop app and headless `pandacode serve` alike. */
const RECONNECT_HINT = 'You can turn it back on in the PandaCode desktop app or by restarting pandacode serve.';
const STOP_DETAIL = `This browser tab will disconnect. ${RECONNECT_HINT}`;
const LOOPBACK_HOSTS = new Set(['', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'localhost', '::ffff:127.0.0.1']);
/** Any address in 127.0.0.0/8, as Rust's `IpAddr::is_loopback()` counts it. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const LOCAL_HOST = '127.0.0.1';
type Target = '' | 'enabled' | 'port' | 'link';

/** Whether `host` only accepts connections from this computer. */
export function isLoopbackHost(host: string): boolean {
  const text = String(host ?? '').trim().toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.x.y.z) is loopback too, as Rust's to_canonical().is_loopback() sees it.
  return LOOPBACK_HOSTS.has(text) || LOOPBACK_V4.test(text.replace(/^::ffff:/, ''));
}

/** Set from `bridge.webMode` at mount (loaded lazily so the pure helpers stay importable in Node tests). */
let webMode = false;
/** This page is itself served by the web server (or a spec says to act as if it were). */
const inWebBrowser = () => webMode || Boolean((window as any).__webServerTestInWebMode);

/** A host as it appears before `:port` in a URL or `ssh -L`: IPv6 literals in brackets. */
export function formatHost(host: string): string {
  const text = String(host ?? '').trim();
  return text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
}

/** The same page on `port`, keeping this tab's scheme and host and carrying the token from `tokenUrl`. */
export function movedSessionUrl(port: number, tokenUrl: string, here: { protocol: string; hostname: string }): string {
  const fragment = new URL(tokenUrl).hash;
  return `${here.protocol}//${formatHost(here.hostname)}:${port}/${fragment}`;
}

/** `origin` when it is a plain http(s) origin (no path), else null. */
function httpOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin.replace(/\/$/, '') ? url.origin : null;
  } catch { return null; }
}

/** The session link to open or copy. In a browser tab it keeps the tab's own origin (an SSH tunnel, a
 *  the machine's LAN or Tailscale IP that works from here) with the token from `tokenUrl`; the desktop app
 *  uses the server's link as is. */
export function reachableSessionUrl(tokenUrl: string, browserOrigin: string, inBrowser: boolean): string {
  const origin = inBrowser ? httpOrigin(browserOrigin) : null;
  if (!origin) return tokenUrl;
  try { return `${origin}/${new URL(tokenUrl).hash}`; } catch { return tokenUrl; }
}

/** The address shown in the link block, by the same rule as reachableSessionUrl. */
export function reachableDisplayUrl(url: string, browserOrigin: string, inBrowser: boolean): string {
  return (inBrowser ? httpOrigin(browserOrigin) : null) ?? url;
}

/** Validates the port field: digits only, 0 through 65535 (0 = automatic). */
export function parsePortInput(raw: string): PortParse {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Enter a port number.' };
  if (!/^\d+$/.test(text)) return { ok: false, error: `“${text.slice(0, 12)}” is not a port. ${PORT_RANGE_ERROR}` };
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port > MAX_PORT) return { ok: false, error: `Port ${text.slice(0, 12)} is too large. ${PORT_RANGE_ERROR}` };
  return { ok: true, port };
}

export function mountWebServerSettings(root: HTMLElement, host: WebServerHost): () => void {
  let status: WebServerStatus | undefined, loading = true, loadError = '';
  let error = '', errorTarget: Target = '', saving = false, disposed = false;
  let portDraft = '', portDirty = false;
  /** The switch's value while a toggle is saving, so the redraw does not flip it back before the reply. */
  let pendingEnabled: boolean | undefined;
  /** Asking before a browser tab stops the server that serves it. */
  let confirmingStop = false;
  /** Asking before a browser tab moves the server it is served from to another port. */
  let confirmingPort: number | null = null;
  /** Asking before New token signs out other connected browsers. */
  let confirmingRotate = false;
  /** Opens one confirmation and closes the others, so they never stack. */
  function openConfirm(kind: 'stop' | 'rotate' | 'port', port: number | null = null): void {
    confirmingStop = kind === 'stop';
    confirmingRotate = kind === 'rotate';
    confirmingPort = kind === 'port' ? port : null;
  }
  /** Bumps per status fetch so an older reply never overwrites a newer one. */
  let fetchSerial = 0;
  // The switch shows whether the server is live: a CLI start (--port) runs without the saved setting on.
  const shownEnabled = () => pendingEnabled ?? Boolean(status?.running);

  /** The port the field stands for: the live port when the CLI chose it (a one-off `--port` session, or
   *  `--port N` moving a running server), otherwise the saved one (0 = automatic stays 0). */
  const portSaved = () => {
    if (!status) return '';
    const live = status.running && status.port > 0 && (!status.enabled || (status.configuredPort !== 0 && status.port !== status.configuredPort));
    return String(live ? status.port : status.configuredPort);
  };
  const sessionLink = (s: WebServerStatus) => reachableSessionUrl(s.tokenUrl ?? '', location.origin, inWebBrowser());
  const fail = (e: unknown, target: Target) => { error = errorText(e); errorTarget = target; render(); };

  function banner(): string {
    if (!error) return '';
    return `<div class="message-error error-row remote-error-row web-server-error-row"><div class="error-row-head"><span class="error-row-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="error-row-summary remote-error"${errorTarget === 'port' ? ' id="web-server-port-error"' : ''} role="alert">${escape(error)}</span><button type="button" class="error-row-button error-row-dismiss" data-dismiss-error aria-label="Dismiss error">${icon('close')}</button></div></div>`;
  }
  const after = (target: Target) => errorTarget === target ? banner() : '';

  function serveRow(s: WebServerStatus): string {
    const displayHost = formatHost(s.host || LOCAL_HOST);
    const clients = s.clients > 0 ? ` · ${s.clients} ${s.clients === 1 ? 'browser' : 'browsers'} connected` : '';
    const subtitle = s.running
      ? `<span class="remote-dot" data-online="true" role="img" aria-label="Running"></span><span>Listening on ${escape(displayHost)}:${s.port}</span>${clients}`
      : s.error ? `<span class="web-server-state-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span>${escape(s.error)}</span>` : `Off · binds only to ${LOCAL_HOST}`;
    return `<div class="setting-row web-server-row" data-row="enabled"><div><strong>Serve in browser</strong><small class="web-server-state">${subtitle}</small></div><input type="checkbox" class="settings-switch" id="web-server-enabled" aria-label="Serve in browser" ${shownEnabled() ? 'checked' : ''} ${saving ? 'disabled' : ''}>${infoMark(SERVE_TIP, 'About serving in a browser')}</div>`;
  }
  function portRow(): string {
    return `<div class="setting-row web-server-row" data-row="port"><div><strong>Port</strong><small>Any open port (1–65535), or 0 for automatic</small></div><span class="web-server-port-controls"><input type="text" id="web-server-port" class="web-server-port-input" inputmode="numeric" autocomplete="off" maxlength="5" aria-label="Web server port" value="${escape(portDraft)}"${error && errorTarget === 'port' ? ' aria-invalid="true" aria-describedby="web-server-port-error"' : ''} ${saving ? 'disabled' : ''}><button type="button" class="secondary-button" data-web-apply ${saving || !portDirty ? 'disabled' : ''}>Apply</button></span>${infoMark(PORT_TIP, 'About the web server port')}</div>`;
  }
  function linkBlock(s: WebServerStatus): string {
    if (!(s.running && s.url)) return '';
    // Events carry no token link; until web_server_status returns it, Open and Copy wait.
    const linkWait = s.tokenUrl ? '' : 'disabled aria-busy="true"';
    return `<div class="web-server-link" data-row="link"><div class="web-server-link-head"><code class="web-server-url">${escape(reachableDisplayUrl(s.url, location.origin, inWebBrowser()))}</code><span class="remote-badge">Token in link</span></div><div class="web-server-link-actions"><button type="button" class="primary-button" data-web-open ${linkWait}>Open</button><button type="button" class="secondary-button" data-web-copy ${linkWait}>${icon('copy')}Copy link</button><button type="button" class="secondary-button" data-web-rotate ${saving ? 'disabled' : ''}>New token</button></div>${reachNote(s)}</div>`;
  }
  function reachNote(s: WebServerStatus): string {
    const displayHost = escape(formatHost(s.host || LOCAL_HOST));
    // A browser tab may be on another machine (SSH tunnel), so it names the machine running PandaCode.
    const machine = inWebBrowser() ? 'the PandaCode machine' : 'this computer';
    if (isLoopbackHost(s.host)) return `<p class="web-server-note">Only reachable from ${machine} (${displayHost}). From another machine, forward with <code>ssh -L ${s.port}:${displayHost}:${s.port} &lt;host&gt;</code>.</p>`;
    return `<p class="web-server-note web-server-note-warn"><span class="web-server-note-icon" data-state-tone="warn" aria-hidden="true">${icon('alert')}</span><span>Listening on ${escape(formatHost(s.host))} over plain HTTP — traffic and the access token are unencrypted unless on a private Tailscale/WireGuard network. Prefer 127.0.0.1 with an SSH tunnel.</span></p>`;
  }
  /** Desktop: who a stop or port change would cut off. */
  const clientsNote = (s: WebServerStatus) => `${s.clients} ${s.clients === 1 ? 'browser is' : 'browsers are'} currently connected and will be disconnected.`;
  const movingNote = (s: WebServerStatus) => `${s.clients} connected ${s.clients === 1 ? 'browser' : 'browsers'} will disconnect and need the new link.`;
  /** A stop or port change asks first from a browser tab (it cuts itself off) or while browsers are connected. */
  const asksFirst = (s: WebServerStatus) => s.running && (inWebBrowser() || s.clients > 0);
  function stopConfirm(): string {
    if (!confirmingStop || !status?.running) return '';
    const others = otherClients(status), noun = others === 1 ? 'browser' : 'browsers';
    const detail = !inWebBrowser() ? clientsNote(status) : others > 0 ? `This browser tab will disconnect, along with ${others} other connected ${noun}. ${RECONNECT_HINT}` : STOP_DETAIL;
    return `<div class="setting-row web-server-confirm" role="group" aria-label="${STOP_TITLE}"><div><strong>${STOP_TITLE}</strong><small>${escape(detail)}</small></div><div class="web-server-confirm-actions"><button type="button" class="secondary-button" data-web-stop-cancel>Cancel</button><button type="button" class="secondary-button" data-web-stop-confirm><span class="web-server-confirm-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span>Stop server</button></div></div>`;
  }
  /** Browsers a new token would sign out: all of them on desktop; in a browser tab, all but this one. */
  const otherClients = (s: WebServerStatus) => inWebBrowser() ? Math.max(0, s.clients - 1) : s.clients;
  function rotateConfirm(): string {
    if (!confirmingRotate || !status?.running) return '';
    const others = otherClients(status), noun = others === 1 ? 'browser' : 'browsers';
    const detail = inWebBrowser() ? `${others} other connected ${noun} will disconnect and need the new link. This tab stays signed in.` : `${others} connected ${noun} will disconnect and need the new link.`;
    return `<div class="setting-row web-server-confirm" role="group" aria-label="Generate a new access token?"><div><strong>Generate a new access token?</strong><small>${escape(detail)}</small></div><div class="web-server-confirm-actions"><button type="button" class="secondary-button" data-web-cancel-rotate>Cancel</button><button type="button" class="secondary-button" data-web-confirm-rotate><span class="web-server-confirm-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span>New token</button></div></div>`;
  }
  function cancelRotate(): void {
    confirmingRotate = false; render();
    root.querySelector<HTMLElement>('[data-web-rotate]')?.focus();
  }
  function portConfirm(): string {
    if (confirmingPort === null || !status?.running) return '';
    const title = confirmingPort === 0 ? 'Switch to an automatic port?' : `Move web server to port ${confirmingPort}?`;
    const others = otherClients(status), noun = others === 1 ? 'browser' : 'browsers';
    const detail = !inWebBrowser() ? movingNote(status) : others > 0 ? `This browser tab will move to the new port. ${others} other connected ${noun} will disconnect and need the new link.` : MOVE_DETAIL;
    return `<div class="setting-row web-server-confirm" role="group" aria-label="${title}"><div><strong>${title}</strong><small>${escape(detail)}</small></div><div class="web-server-confirm-actions"><button type="button" class="secondary-button" data-web-cancel-port>Cancel</button><button type="button" class="secondary-button" data-web-confirm-port><span class="web-server-confirm-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span>Change port</button></div></div>`;
  }
  function body(): string {
    if (!status) {
      if (loading) return '<p class="dialog-loading" role="status">Loading…</p>';
      return `<div class="remote-load-error" role="alert"><span class="web-server-state-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span><strong>Couldn’t load web access.</strong><small>${escape(loadError || 'Try again.')}</small></span><button type="button" class="secondary-button" data-web-retry>Retry</button></div>`;
    }
    return `${serveRow(status)}${stopConfirm()}${after('enabled')}${portRow()}${portConfirm()}${after('port')}${linkBlock(status)}${rotateConfirm()}${after('link')}${errorTarget === '' ? banner() : ''}`;
  }

  /** Redraws by morphing, so unchanged nodes keep focus, caret and the switch's data-armed. */
  function render(): void {
    if (disposed) return;
    morph(root, `<div class="settings-group web-server-settings">${body()}</div>`, 8);
    const toggle = root.querySelector<HTMLInputElement>('#web-server-enabled');
    if (toggle && status) toggle.checked = shownEnabled();
    const port = root.querySelector<HTMLInputElement>('#web-server-port');
    if (port && port.value !== portDraft) {
      const focused = document.activeElement === port, caret = port.selectionStart;
      port.value = portDraft;
      if (focused && caret !== null) port.setSelectionRange(Math.min(caret, portDraft.length), Math.min(caret, portDraft.length));
    }
  }
  function apply(next: WebServerStatus): void {
    status = next;
    // A stopped server (here or elsewhere) has nothing left to confirm.
    if (!next.running) { confirmingStop = false; confirmingRotate = false; confirmingPort = null; }
    if (!portDirty) portDraft = portSaved();
  }
  function refreshApply(): void {
    const button = root.querySelector<HTMLButtonElement>('[data-web-apply]');
    if (button) button.disabled = saving || !portDirty;
  }

  /** Runs one native change; controls disable while it runs and focus returns to the control that started it. */
  async function save(command: string, args: Record<string, unknown> | undefined, target: Target, done?: (next: WebServerStatus) => void): Promise<void> {
    if (saving) return;
    const back = focusSelector(document.activeElement);
    saving = true; error = ''; errorTarget = ''; render();
    try {
      const next = await host.call<WebServerStatus>(command, args);
      if (disposed) return;
      fetchSerial++;
      done?.(next);
      apply(next);
    } catch (e) { if (disposed) return; error = errorText(e); errorTarget = target; }
    saving = false; pendingEnabled = undefined; render();
    if (back) root.querySelector<HTMLElement>(back)?.focus();
  }
  /** Where focus goes after a save: the same control, or the port field for Apply (which disables once saved). */
  function focusSelector(active: Element | null): string {
    if (!(active instanceof HTMLElement) || !root.contains(active)) return '';
    if (active.id) return `#${CSS.escape(active.id)}`;
    if (active.hasAttribute('data-web-apply')) return '#web-server-port';
    if (active.hasAttribute('data-web-rotate')) return '[data-web-rotate]';
    if (active.hasAttribute('data-web-stop-confirm')) return '#web-server-enabled';
    return '';
  }

  /** The typed port when it differs from the saved one; undefined when unchanged; null after showing a validation error. */
  function draftPort(): number | undefined | null {
    if (!portDirty) return undefined;
    const parsed = parsePortInput(portDraft);
    if (!parsed.ok) { fail(parsed.error, 'port'); return null; }
    return parsed.port;
  }
  const settle = () => { portDirty = false; };

  function applyPort(): void {
    if (!status || saving) return;
    const port = draftPort();
    if (port === null || port === undefined) return;
    if (asksFirst(status) && port !== status.port) {
      openConfirm('port', port); error = ''; errorTarget = ''; render();
      root.querySelector<HTMLElement>('[data-web-cancel-port]')?.focus();
      return;
    }
    changePort(port);
  }
  function cancelPortChange(): void {
    confirmingPort = null; render();
    root.querySelector<HTMLElement>('#web-server-port')?.focus();
  }
  function changePort(port: number): void {
    if (!status || saving) return;
    confirmingPort = null;
    const before = status.running ? status.port : 0;
    // A one-off CLI session (`--port` without the saved setting) stays one-off: restart it without saving.
    const args = status.running && !status.enabled ? { enabled: true, port, persist: false } : { enabled: status.running, port };
    void save('web_server_configure', args, 'port', next => { settle(); followPort(before, next); });
  }
  /** A browser tab served on the old port follows the server to the new one. */
  function followPort(before: number, next: WebServerStatus): void {
    if (!inWebBrowser() || !before || !next.running || next.port === before || !next.tokenUrl) return;
    const target = movedSessionUrl(next.port, next.tokenUrl, location);
    host.notify(`Moving to port ${next.port}…`);
    if ((window as any).__webServerTestInWebMode) (window as any).__webServerLastRedirect = target;
    else window.location.assign(target);
  }
  /** New token. In a browser tab, the bridge is told a rotation is under way (so the old token's 4001 close
   *  does not flash the sign-in gate, even over a slow tunnel) until this tab has adopted the new token. */
  async function rotateToken(): Promise<void> {
    type Bridge = typeof import('./web-bridge') & { beginWebTokenRotation?: () => () => void };
    let bridge: Bridge | undefined, release: (() => void) | undefined;
    if (webMode) {
      try { bridge = await import('./web-bridge') as Bridge; release = bridge.beginWebTokenRotation?.(); }
      catch (e) { fail(e, 'link'); return; }
    }
    try {
      await save('web_server_rotate_token', undefined, 'link', next => {
        host.notify('Access token rotated');
        if (bridge && next.tokenUrl && !bridge.adoptWebToken(next.tokenUrl)) throw new Error('The new access token could not be read. Copy the link from the desktop app.');
      });
    } finally { release?.(); }
  }
  function setEnabled(input: HTMLInputElement): void {
    if (!status) return;
    const enabled = input.checked;
    if (!enabled && asksFirst(status)) {
      input.checked = true; openConfirm('stop'); render();
      root.querySelector<HTMLElement>('[data-web-stop-cancel]')?.focus();
      return;
    }
    const port = enabled ? draftPort() : undefined;
    if (port === null) { input.checked = status.running; return; }
    pendingEnabled = enabled;
    void save('web_server_configure', port === undefined ? { enabled } : { enabled, port }, port === undefined ? 'enabled' : 'port', port === undefined ? undefined : settle);
  }
  async function load(): Promise<void> {
    loading = true; loadError = ''; render();
    try { apply(await host.call<WebServerStatus>('web_server_status')); }
    catch (e) { status = undefined; loadError = errorText(e); }
    loading = false; render();
  }
  function copyLink(): void {
    if (!status?.tokenUrl) return;
    const link = sessionLink(status);
    const copied = () => host.notify('Session link copied');
    const failed = () => (host.notifyError ?? host.notify)('Couldn’t copy the link; use Open instead');
    const fallback = () => { if (copyWithSelection(link)) copied(); else failed(); };
    // Plain HTTP on a LAN or Tailscale address is not a secure context, so navigator.clipboard is missing there.
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (typeof clipboard?.writeText !== 'function') { fallback(); return; }
    try { void clipboard.writeText(link).then(copied, fallback); } catch { fallback(); }
  }
  /** The pre-Clipboard-API copy: a hidden read-only textarea, selected and copied, then removed. */
  function copyWithSelection(text: string): boolean {
    const button = root.querySelector<HTMLElement>('[data-web-copy]');
    const area = document.createElement('textarea');
    area.readOnly = true;
    area.value = text;
    area.tabIndex = -1;
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.append(area);
    try { area.select(); return document.execCommand('copy'); }
    catch { return false; }
    finally { area.remove(); button?.focus(); }
  }

  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-dismiss-error')) {
      const back = errorTarget === 'enabled' ? '#web-server-enabled' : errorTarget === 'port' ? '#web-server-port' : errorTarget === 'link' ? '[data-web-rotate]' : '';
      error = ''; errorTarget = ''; render();
      ((back ? root.querySelector<HTMLElement>(back) : null) ?? root.querySelector<HTMLElement>('input:not([disabled]),button:not([disabled])'))?.focus();
    }
    else if (button.hasAttribute('data-web-retry')) void load();
    else if (button.hasAttribute('data-web-apply')) applyPort();
    else if (button.hasAttribute('data-web-open') && status?.tokenUrl) void host.openUrl(sessionLink(status)).catch(e => fail(e, 'link'));
    else if (button.hasAttribute('data-web-copy')) copyLink();
    else if (button.hasAttribute('data-web-rotate')) {
      if (status && otherClients(status) > 0) { openConfirm('rotate'); error = ''; errorTarget = ''; render(); root.querySelector<HTMLElement>('[data-web-cancel-rotate]')?.focus(); }
      else void rotateToken();
    }
    else if (button.hasAttribute('data-web-cancel-rotate')) cancelRotate();
    else if (button.hasAttribute('data-web-confirm-rotate')) { confirmingRotate = false; root.querySelector<HTMLElement>('[data-web-rotate]')?.focus(); void rotateToken(); }
    else if (button.hasAttribute('data-web-cancel-port')) cancelPortChange();
    else if (button.hasAttribute('data-web-confirm-port')) { const port = confirmingPort; if (port !== null) { root.querySelector<HTMLElement>('#web-server-port')?.focus(); changePort(port); } }
    else if (button.hasAttribute('data-web-stop-cancel')) { confirmingStop = false; render(); root.querySelector<HTMLElement>('#web-server-enabled')?.focus(); }
    else if (button.hasAttribute('data-web-stop-confirm')) { confirmingStop = false; pendingEnabled = false; void save('web_server_configure', { enabled: false }, 'enabled', next => {
      // This tab's server is gone: web-bridge shows a calm final "Web server stopped" banner instead of reconnecting forever.
      if (inWebBrowser() && !next.running) window.dispatchEvent(new CustomEvent('pandacode:web-stopped', { detail: RECONNECT_HINT }));
    }).then(() => root.querySelector<HTMLElement>('#web-server-enabled')?.focus()); }
  };
  const onInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.id !== 'web-server-port') return;
    portDraft = input.value;
    if (confirmingPort !== null) { confirmingPort = null; render(); }
    // A port error clears as soon as the field holds a valid port again.
    if (error && errorTarget === 'port' && parsePortInput(portDraft).ok) { error = ''; errorTarget = ''; render(); }
    portDirty = portDraft.trim() !== portSaved();
    refreshApply();
  };
  /** Escape cancels an open confirmation wherever focus is in Settings, before Settings' own Escape sees it. */
  const onDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || isImeKey(event)) return;
    if (!confirmingStop && !confirmingRotate && confirmingPort === null) return;
    // Only a confirmation actually on screen takes Escape; otherwise it belongs to Settings.
    if (!root.querySelector('.web-server-confirm')) return;
    // Only while this section is on screen (Settings keeps other pages mounted but hidden).
    if (!root.isConnected || !root.getClientRects().length) return;
    // A modal dialog opened above Settings handles its own Escape.
    if ([...document.querySelectorAll('dialog[open]')].some(dialog => !dialog.contains(root))) return;
    event.preventDefault(); event.stopPropagation();
    if (confirmingRotate) cancelRotate();
    else if (confirmingPort !== null) cancelPortChange();
    else { confirmingStop = false; render(); root.querySelector<HTMLElement>('#web-server-enabled')?.focus(); }
  };
  document.addEventListener('keydown', onDocumentKeydown, true);
  const onKeydown = (event: KeyboardEvent) => {
    const input = event.target as HTMLInputElement;
    if (isImeKey(event)) return;
    if (input.id !== 'web-server-port') return;
    if (event.key === 'Enter') { event.preventDefault(); applyPort(); }
    else if (event.key === 'Escape' && portDirty) {
      event.preventDefault(); event.stopPropagation();
      portDraft = portSaved(); portDirty = false;
      if (errorTarget === 'port') { error = ''; errorTarget = ''; }
      render();
    }
  };
  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.id === 'web-server-enabled') setEnabled(input);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('change', onChange);
  // Live changes from elsewhere: the CLI's --port, browsers connecting, a token rotated in another window.
  // Events are redacted (no tokenUrl): keep the link we hold while the server stays put, else fetch it.
  const unlisten = host.listen('web-server-changed', payload => {
    if (!payload || typeof payload !== 'object' || typeof (payload as WebServerStatus).enabled !== 'boolean') return;
    const next = payload as WebServerStatus;
    // A new token generation means a rotation (here or in another window): the held link is retired.
    const same = Boolean(status?.running && status.tokenUrl && status.port === next.port && status.host === next.host && status.tokenGeneration === next.tokenGeneration);
    if (next.running && !next.tokenUrl && same) apply({ ...next, tokenUrl: status!.tokenUrl });
    else apply(next);
    if (!saving) render();
    if (next.running && !next.tokenUrl && !same) void refreshStatus();
  });
  /** Fetches the full status (with the token link) after an event that could not carry it. */
  async function refreshStatus(): Promise<void> {
    const mine = ++fetchSerial;
    try {
      const next = await host.call<WebServerStatus>('web_server_status');
      if (disposed || mine !== fetchSerial) return;
      apply(next);
      if (!saving) render();
    } catch (e) { if (!disposed && mine === fetchSerial) fail(e, 'link'); }
  }
  void import('./bridge').then(bridge => { webMode = bridge.webMode; }, () => undefined);
  void load();
  return () => {
    disposed = true;
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKeydown);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    root.removeEventListener('change', onChange);
    void unlisten.then(fn => fn(), () => undefined);
  };
}
