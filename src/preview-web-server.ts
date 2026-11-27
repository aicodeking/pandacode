/** Browser preview for Web access (web-server-settings.ts): an in-memory server, no sockets. Native builds serve from src-tauri. */
import type { WebServerStatus } from './web-server-settings';

const LOCAL_HOST = '127.0.0.1', DEFAULT_PORT = 47322, AUTO_PORT = 54321, MAX_TRUSTED = 8;
let tokenGeneration = 0, host = LOCAL_HOST, enabled = false, cliStarted = false, configuredHost = LOCAL_HOST, configuredPort = DEFAULT_PORT, allowedHosts: string[] = [], port = 0, clients = 0, serial = 0, token = nextToken();

function nextToken(): string {
  serial += 1;
  return `preview-token-${serial.toString(36).padStart(4, '0')}`;
}
function loopback(address: string): boolean {
  const text = address.trim().toLowerCase();
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return bare === '::1' || bare === 'localhost' || bare === '0:0:0:0:0:0:0:1' || /^127(?:\.|$)/.test(bare);
}
function displayHost(address: string): string {
  const text = address.trim();
  return text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
}
/** The Rust rule: a loopback bind with trusted names serves its link through the first name over https. */
function sessionBase(): string {
  return loopback(host) && allowedHosts.length > 0 ? `https://${displayHost(allowedHosts[0])}` : `http://${displayHost(host)}:${port}`;
}
function status(): WebServerStatus {
  const running = (enabled || cliStarted) && port > 0;
  const url = running ? sessionBase() : null;
  return { enabled, running, host, port: running ? port : 0, configuredPort, configuredHost, allowedHosts: [...allowedHosts], url, tokenUrl: url ? `${url}/#token=${token}` : null, clients: running ? clients : 0, error: null, tokenGeneration: running ? tokenGeneration : 0 };
}
/** What `web-server-changed` carries: like Rust's status_redacted(), never the token link. */
function redacted(): WebServerStatus { return { ...status(), tokenUrl: null }; }
function validPort(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Port ${String(value)} is out of range (0–65535).`);
  return n;
}
/** Any IPv4 literal, with no leading zeros (Rust's `Ipv4Addr` rejects those too). */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** The saved bind address: an IP literal (brackets around IPv6 accepted), or empty for 127.0.0.1. */
function validHost(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return LOCAL_HOST;
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1).trim() : text;
  const ipv4 = IPV4.test(bare);
  let ipv6 = false;
  if (!ipv4 && bare.includes(':')) { try { new URL(`http://[${bare}]/`); ipv6 = true; } catch { /* not IPv6 */ } }
  if (!ipv4 && !ipv6) throw new Error(`\`${text.slice(0, 47)}\` is not an IP address (for example ${LOCAL_HOST} or ::1).`);
  return bare.toLowerCase();
}
/** Saved trusted names: lowercase, de-duplicated and capped, like the backend's list. */
function validAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Trusted host names must be a list.');
  const hosts: string[] = [];
  for (const raw of value) {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!text) continue;
    if (text.includes('://') || /[/\\?#@]/.test(text) || (text.includes(':') && !/^\[[0-9a-f:.]+\]$/.test(text))) throw new Error(`\`${text.slice(0, 64)}\` is not a host name.`);
    if (!hosts.includes(text)) hosts.push(text);
  }
  if (hosts.length > MAX_TRUSTED) throw new Error(`Enter at most ${MAX_TRUSTED} trusted host names.`);
  return hosts;
}
function start(wanted: number): void {
  const busy = (window as any).__webServerBusyPort;
  if (wanted !== 0 && busy === wanted) throw new Error(`Port ${wanted} is already in use.`);
  if (!status().running) tokenGeneration = 1;
  port = wanted === 0 ? AUTO_PORT : wanted;
}

export function invokeWebServer<T>(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): Promise<T> {
  return Promise.resolve().then(() => handle(command, args ?? {}, emit) as T);
}
function handle(command: string, args: Record<string, any>, emit: (name: string, payload: unknown) => void): unknown {
  const w = window as any;
  w.__webServerClients ??= (count: number) => { clients = Math.max(0, Math.floor(count)); emit('web-server-changed', redacted()); return status(); };
  // A server started by `pandacode --port N`: live, while the saved setting stays off.
  w.__webServerCliStart ??= (cliPort: number, cliHost = LOCAL_HOST) => { if (!status().running) tokenGeneration = 1; cliStarted = true; host = validHost(cliHost); port = validPort(cliPort) || AUTO_PORT; emit('web-server-changed', redacted()); return status(); };
  switch (command) {
    case 'app_version': return '0.3.129';
    case 'web_server_status': return status();
    case 'web_server_configure': {
      // Test seam: the settings spec proves a browser tab never sends host/allowedHosts.
      w.__webServerLastConfigure = { ...args };
      const nextPort = args.port === undefined ? configuredPort : validPort(args.port);
      const nextHost = args.host === undefined ? undefined : validHost(args.host);
      const nextAllowed = args.allowedHosts === undefined ? undefined : validAllowedHosts(args.allowedHosts);
      const nextEnabled = Boolean(args.enabled);
      // persist: false restarts a one-off CLI session without turning on the saved setting.
      const persist = args.persist !== false;
      if (persist) {
        if (nextHost !== undefined) configuredHost = nextHost;
        if (nextAllowed !== undefined) allowedHosts = nextAllowed;
        enabled = nextEnabled;
        configuredPort = nextPort;
        cliStarted = false;
      } else {
        cliStarted = nextEnabled;
      }
      if (nextEnabled) {
        if (nextHost !== undefined) host = nextHost;
        else if (persist) host = configuredHost;
        start(nextPort);
      } else { port = 0; clients = 0; host = LOCAL_HOST; }
      emit('web-server-changed', redacted());
      return status();
    }
    case 'web_server_rotate_token':
      token = nextToken(); clients = 0; tokenGeneration += 1;
      emit('web-server-changed', redacted());
      return status();
    default: throw new Error(`Unknown web server command: ${command}`);
  }
}
