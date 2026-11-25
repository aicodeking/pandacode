/** Browser preview for Web access (web-server-settings.ts): an in-memory server, no sockets. Native builds serve from src-tauri. */
import type { WebServerStatus } from './web-server-settings';

const LOCAL_HOST = '127.0.0.1', DEFAULT_PORT = 47322, AUTO_PORT = 54321;
let tokenGeneration = 0, host = LOCAL_HOST, enabled = false, cliStarted = false, configuredPort = DEFAULT_PORT, port = 0, clients = 0, serial = 0, token = nextToken();

function nextToken(): string {
  serial += 1;
  return `preview-token-${serial.toString(36).padStart(4, '0')}`;
}
function status(): WebServerStatus {
  const running = (enabled || cliStarted) && port > 0;
  const url = running ? `http://${host.includes(':') ? `[${host}]` : host}:${port}` : null;
  return { enabled, running, host, port: running ? port : 0, configuredPort, url, tokenUrl: url ? `${url}/#token=${token}` : null, clients: running ? clients : 0, error: null, tokenGeneration: running ? tokenGeneration : 0 };
}
/** What `web-server-changed` carries: like Rust's status_redacted(), never the token link. */
function redacted(): WebServerStatus { return { ...status(), tokenUrl: null }; }
function validPort(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Port ${String(value)} is out of range (0–65535).`);
  return n;
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
  w.__webServerCliStart ??= (cliPort: number, cliHost = LOCAL_HOST) => { if (!status().running) tokenGeneration = 1; cliStarted = true; host = String(cliHost); port = validPort(cliPort) || AUTO_PORT; emit('web-server-changed', redacted()); return status(); };
  switch (command) {
    case 'app_version': return '0.3.129';
    case 'web_server_status': return status();
    case 'web_server_configure': {
      const nextPort = args.port === undefined ? configuredPort : validPort(args.port);
      const nextEnabled = Boolean(args.enabled);
      // persist: false restarts a one-off CLI session without turning on the saved setting.
      const persist = args.persist !== false;
      if (nextEnabled) start(nextPort); else { port = 0; clients = 0; host = LOCAL_HOST; }
      if (persist) { enabled = nextEnabled; configuredPort = nextPort; cliStarted = false; }
      else cliStarted = nextEnabled;
      if (typeof args.host === 'string' && args.host.trim()) host = args.host.trim();
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
