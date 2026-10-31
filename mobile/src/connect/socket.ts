// The one WebSocket to the relay (viewer only, host=0); mirrors src-tauri/src/remote/socket.rs.
// The relay reads the bearer token from the upgrade request's Authorization header
// (relay/src/index.ts), which React Native's WebSocket can set.
import { AppState, type AppStateStatus } from 'react-native';
import { backoff, REVOKED } from '../store/backoff.ts';

const PING_MS = 30_000;
const SILENT_MS = 75_000;
/** Background longer than this closes the socket; foreground reconnects. */
const BACKGROUND_MS = 30_000;
/** A socket kept through a short background must answer a ping this fast, else it reconnects (iOS may have dropped it). */
const PROBE_MS = 4_000;
/** A socket still connecting after this (captive portal, blackholed route) is closed and retried with backoff. */
export const CONNECT_MS = 12_000;

export interface SocketHandlers {
  /** The current token, or null when signed out (stops the socket). */
  token(): string | null;
  url(): string;
  onOpen(): void;
  onClose(): void;
  onText(text: string): void;
  /** Close code 4001, or a socket that never opened: the owner decides whether to sign out. */
  onRefused(token: string, revoked: boolean): void;
}

export class RelaySocket {
  private ws: WebSocket | null = null;
  private delay = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundAt = 0;
  private heard = 0;
  private running = false;
  private readonly appState = AppState.addEventListener('change', state => this.onAppState(state));

  constructor(private readonly handlers: SocketHandlers) {}

  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  /** Opening now (not waiting out a backoff). */
  get connecting() { return this.ws?.readyState === WebSocket.CONNECTING; }

  start() {
    this.running = true;
    if (!this.ws && !this.retry) this.connect();
  }

  stop() {
    this.running = false;
    this.clearRetry();
    this.drop();
  }

  dispose() {
    this.stop();
    this.appState.remove();
  }

  send(text: string): boolean {
    if (!this.open) return false;
    this.ws!.send(text);
    return true;
  }

  private clearRetry() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private drop() {
    const ws = this.ws;
    this.ws = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000); } catch { /* already closed */ }
      this.handlers.onClose();
    }
  }

  private connect() {
    this.retry = null;
    const token = this.handlers.token();
    if (!this.running || !token || AppState.currentState === 'background') return;
    // React Native's WebSocket takes headers as a third argument (the DOM typings don't know it).
    const RNWebSocket = WebSocket as unknown as new (url: string, protocols: null, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new RNWebSocket(this.handlers.url(), null, { headers: { Authorization: `Bearer ${token}` } });
    this.ws = ws;
    let openedAt = 0;
    const stuck = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) closed(1006); }, CONNECT_MS);
    ws.onopen = () => {
      clearTimeout(stuck);
      openedAt = this.heard = Date.now();
      this.ping = setInterval(() => {
        if (Date.now() - this.heard > SILENT_MS) return this.reconnectNow();
        ws.send('ping');
      }, PING_MS);
      this.handlers.onOpen();
    };
    ws.onmessage = event => {
      this.heard = Date.now();
      if (typeof event.data === 'string' && event.data !== 'pong') this.handlers.onText(event.data);
    };
    const closed = (code: number) => {
      clearTimeout(stuck);
      if (this.ws !== ws) return;
      this.drop();
      const outcome = { opened: openedAt > 0, upMs: openedAt ? Date.now() - openedAt : 0, code };
      if (outcome.code === REVOKED || !outcome.opened) this.handlers.onRefused(token, outcome.code === REVOKED);
      const next = backoff(this.delay, outcome);
      if (!next || !this.running) return;
      this.delay = next[1];
      // A first retry goes at once (no timer turn either).
      if (next[0] === 0) return this.connect();
      this.retry = setTimeout(() => this.connect(), next[0]);
    };
    ws.onclose = event => closed(event.code);
  }

  private reconnectNow() {
    this.drop();
    this.clearRetry();
    this.delay = 0;
    this.connect();
  }

  private onAppState(state: AppStateStatus) {
    if (state === 'background') {
      this.backgroundAt = Date.now();
      this.backgroundTimer ??= setTimeout(() => { this.backgroundTimer = null; this.drop(); this.clearRetry(); }, BACKGROUND_MS);
      return;
    }
    if (state !== 'active') return;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
    if (!this.running) return;
    // Timers may not have run while suspended: a long absence means the socket is likely dead.
    const away = this.backgroundAt ? Date.now() - this.backgroundAt : 0;
    this.backgroundAt = 0;
    // No backoff here: the first try after foregrounding goes at once.
    if (!this.ws || away >= BACKGROUND_MS) return this.reconnectNow();
    if (away > 0 && this.open) this.probe();
  }

  /** Pings a socket kept through a short background; no frame within PROBE_MS → reconnect now
   * instead of waiting SILENT_MS for the keepalive to notice. */
  private probe() {
    const ws = this.ws!;
    const sent = Date.now();
    ws.send('ping');
    setTimeout(() => { if (this.ws === ws && this.heard < sent) this.reconnectNow(); }, PROBE_MS);
  }
}
