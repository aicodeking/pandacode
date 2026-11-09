/** Authenticated transport used by the browser-hosted PandaCode UI.
 *
 * The gateway is deliberately a small typed boundary: callers can invoke
 * named domain commands and subscribe to ordered events, while credentials
 * remain in the browser session and never enter preview fixtures.
 */
export type WebTransportOptions = { baseUrl?: string; fetchImpl?: typeof fetch; websocket?: typeof WebSocket; timeoutMs?: number; maxResponseBytes?: number };
export type RuntimeSnapshot = { sequence: number; events: { type: string; payload: unknown }[]; truncated: boolean };
export type WebEvent = { sequence: number; type: string; payload: unknown };
import { TerminalInputSequencer } from './web-terminal-input';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_COMMAND = /^[a-z][a-z0-9_.:-]{0,96}$/;

function sameOrigin(url: URL): boolean { return url.origin === location.origin; }

export class WebTransport {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly websocket: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly cloneTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly documentTimeoutMs: number;
  private socket: WebSocket | null = null;
  private sequence = 0;
  private listeners = new Map<string, Set<(event: WebEvent) => void>>();
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  private recovery: Promise<void> | null = null;
  private initialEvents = new Map<string, WebEvent[]>();
  private readonly terminalInput = new TerminalInputSequencer((terminalId, data) => this.sendCommand('write_terminal', { terminalId, data }));

  constructor(options: WebTransportOptions = {}) {
    this.base = new URL(options.baseUrl ?? '/api/pandacode/', location.href);
    if (!sameOrigin(this.base)) throw new Error('Web gateway must use the current origin');
    this.fetchImpl = options.fetchImpl ?? fetch.bind(window);
    this.websocket = options.websocket ?? WebSocket;
    this.timeoutMs = options.timeoutMs ?? 50000;
    // Native cloning is bounded at 600 seconds; the gateway allows 620 for
    // process teardown. Keep this response deadline beyond both boundaries.
    this.cloneTimeoutMs = options.timeoutMs ?? 630000;
    this.documentTimeoutMs = options.timeoutMs ?? 120000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (command === 'write_terminal') { if (typeof args.terminalId !== 'string' || typeof args.data !== 'string') throw new Error('Invalid terminal input'); return await this.terminalInput.enqueue(args.terminalId, args.data) as T; }
    if (command === 'close_terminal' && typeof args.terminalId === 'string') { try { await this.terminalInput.flush(args.terminalId); } finally { try { return await this.sendCommand(command, args) as T; } finally { this.terminalInput.release(args.terminalId); } } }
    return await this.sendCommand(command, args);
  }

  private async sendCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!SAFE_COMMAND.test(command)) throw new Error('Invalid gateway command');
    if (command === 'read_document_file') return await this.readDocument(args) as T;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), command === 'github_clone_repo' ? this.cloneTimeoutMs : this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(`commands/${encodeURIComponent(command)}`, this.base), {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': this.csrfToken(), 'x-request-id': requestId },
        body: JSON.stringify(args), signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          this.close();
          window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Your browser session expired. Pair with the host again. Your unsent text stays here.' } }));
        }
        throw new Error(`Gateway request failed (${response.status})`);
      }
      if (Number(response.headers.get('content-length') ?? 0) > this.maxResponseBytes) {
        await response.body?.cancel(); throw new Error('Gateway response exceeds limit');
      }
      const body = response.body; if (!body) throw new Error('Empty gateway response');
      const reader = body.getReader();
      let length = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        if (!part.value) continue; length += part.value.byteLength;
        if (length > this.maxResponseBytes) { await reader.cancel(); throw new Error('Gateway response exceeds limit'); }
        if (part.value) chunks.push(part.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === 'object' && '__pandacode_web_binary__' in parsed) {
        const encoded = parsed.__pandacode_web_binary__;
        const limit = 8 * 1024 * 1024;
        if (!['simulator_frame', 'vm_frame', 'cloud_frame'].includes(command) || Object.keys(parsed).length !== 1 || typeof encoded !== 'string' ||
            encoded.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error('Invalid gateway binary response');
        }
        const raw = atob(encoded);
        if (raw.length > limit) throw new Error('Gateway binary response exceeds limit');
        return Uint8Array.from(raw, char => char.charCodeAt(0)).buffer as T;
      }
      return parsed as T;
    } catch (error) {
      throw controller.signal.aborted ? new Error('Gateway request timed out') : error;
    } finally { window.clearTimeout(timeout); }
  }

  private async readDocument(args: Record<string, unknown>): Promise<ArrayBuffer> {
    if (typeof args.projectId !== 'string' || typeof args.path !== 'string' ||
        (args.sessionId != null && typeof args.sessionId !== 'string') ||
        Object.keys(args).some(key => !['projectId', 'sessionId', 'path'].includes(key))) throw new Error('Invalid document request');
    const url = new URL('files/document', this.base);
    url.searchParams.set('projectId', args.projectId); url.searchParams.set('path', args.path);
    if (typeof args.sessionId === 'string') url.searchParams.set('sessionId', args.sessionId);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), this.documentTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Document request failed (${response.status})`);
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') throw new Error('Invalid document response');
      const limit = 64 * 1024 * 1024;
      if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('Document exceeds the native viewer limit'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty document response');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > limit) { await reader.cancel(); throw new Error('Document exceeds the native viewer limit'); }
        if (part.value) chunks.push(part.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes.buffer;
    } catch (error) { throw controller.signal.aborted ? new Error('Document request timed out') : error; }
    finally { window.clearTimeout(timer); }
  }

  subscribe(type: string, callback: (event: WebEvent) => void): () => void {
    let set = this.listeners.get(type); if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(callback);
    const initial = this.initialEvents.get(type);
    if (initial) { this.initialEvents.delete(type); initial.forEach(callback); }
    this.connect();
    return () => { set!.delete(callback); if (!set!.size) this.listeners.delete(type); if (!this.listeners.size) this.close(); };
  }

  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.close();
    window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'recovering' } }));
    let recovered = false;
    this.recovery = (async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(new URL('runtime-snapshot', this.base), {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(response.status === 401 ? 'Your browser session expired. Pair with the host again.' : 'Could not recover the host workspace.');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty runtime snapshot');
        const chunks: Uint8Array[] = []; let length = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.length;
          if (length > this.maxResponseBytes) { await reader.cancel(); throw new Error('Runtime snapshot exceeds limit'); }
          if (part.value) chunks.push(part.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as RuntimeSnapshot;
        if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !Array.isArray(snapshot.events) ||
            snapshot.events.length > 8192 || typeof snapshot.truncated !== 'boolean') throw new Error('Invalid runtime snapshot');
        if (snapshot.truncated) throw new Error('This running workspace exceeds the recovery limit. Retry after the active tasks finish.');
        if (snapshot.events.some(event => event.type !== 'agent-event' || !event.payload || typeof event.payload !== 'object')) throw new Error('Invalid runtime snapshot event');
        window.dispatchEvent(new Event('pandacode-web-runtime-reset'));
        this.sequence = snapshot.sequence;
        this.initialEvents.clear();
        for (const record of snapshot.events) {
          const event = { ...record, sequence: snapshot.sequence };
          const listeners = this.listeners.get(record.type);
          if (listeners?.size) listeners.forEach(listener => listener(event));
          else { const waiting = this.initialEvents.get(record.type) ?? []; waiting.push(event); this.initialEvents.set(record.type, waiting); }
        }
        recovered = true;
        window.dispatchEvent(new Event('pandacode-web-runtime-restored'));
        window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'connected' } }));
      } catch (error) {
        window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: error instanceof Error ? error.message : 'Workspace recovery failed.' } }));
        throw error;
      } finally { window.clearTimeout(timer); }
    })().finally(() => { this.recovery = null; if (recovered) this.connect(); });
    return this.recovery;
  }

  resetTerminalInput(terminalId: string): void { this.terminalInput.reset(terminalId); }

  close(): void {
    if (this.retryTimer != null) { window.clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.terminalInput.interrupt(new Error('Terminal connection closed; input was not replayed.'));
    const socket = this.socket; this.socket = null; socket?.close();
  }

  private connect(): void {
    if (this.recovery || this.socket || !this.listeners.size) return;
    if (this.retryTimer != null) { window.clearTimeout(this.retryTimer); this.retryTimer = null; }
    const url = new URL('events', this.base); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new this.websocket(url);
    socket.onopen = () => { window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'connected' } })); this.retryAttempt = 0; socket.send(JSON.stringify({ type: 'resume', sequence: this.sequence })); };
    socket.onmessage = message => {
      try {
        const event = JSON.parse(String(message.data)) as Partial<WebEvent>;
        if (typeof event.type !== 'string' || typeof event.sequence !== 'number') return;
        if (event.type === 'resync') {
          void this.recover().catch(() => { /* The recovery status event displays the failure. */ });
          return;
        }
        if (event.sequence <= this.sequence) return;
        if (event.sequence > this.sequence + 1) { socket.send(JSON.stringify({ type: 'resync', from: this.sequence })); return; }
        this.sequence = event.sequence;
        this.listeners.get(event.type)?.forEach(listener => { try { listener(event as WebEvent); } catch (error) { queueMicrotask(() => { throw error; }); } });
      } catch { /* malformed events are discarded at the protocol boundary */ }
    };
    socket.onclose = () => { if (this.socket !== socket) return; this.terminalInput.interrupt(new Error('Terminal connection closed; input was not replayed.')); window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'recovering' } })); this.socket = null; if (this.listeners.size) { if (this.retryAttempt >= 2) { void this.recover().catch(() => {}); return; } const delay = Math.min(5000, 250 * 2 ** this.retryAttempt++); this.retryTimer = window.setTimeout(() => this.connect(), delay); } };
  }

  private csrfToken(): string {
    const token = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('pandacode_csrf='));
    return token ? decodeURIComponent(token.slice('pandacode_csrf='.length)) : '';
  }
}

export const web = typeof window !== 'undefined' && (new URLSearchParams(location.search).has('web') || document.documentElement.dataset.pandacodeWeb === 'true')
  ? new WebTransport() : null;
