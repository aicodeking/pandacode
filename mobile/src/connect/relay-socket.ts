// The relay socket's logic, free of React Native so tests can drive it (src/connect/socket.ts binds it
// to RN's WebSocket and AppState). Mirrors src-tauri/src/remote/socket.rs.
import { jitteredBackoff, REVOKED } from '../store/backoff.ts';

/** Keepalive ping interval; the relay reaps sockets silent for 75 s (relay/src/limits.ts STALE_MS). */
export const PING_MS = 30_000;
/** Every ping must be answered (a pong or any frame) this fast, else the socket is dead and reconnects. */
export const ANSWER_MS = 10_000;
/** Background longer than this closes the socket; foreground reconnects. */
export const BACKGROUND_MS = 30_000;
/** A socket kept through a short background must answer a ping this fast, else it reconnects (iOS may have dropped it). */
export const PROBE_MS = 4_000;
/** A socket still connecting after this (captive portal, blackholed route) is closed and retried with backoff. */
export const CONNECT_MS = 12_000;

const CONNECTING = 0;
const OPEN = 1;

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

/** 'open': connected. 'connecting': opening now. 'waiting': backing off before the next try.
 * 'offline': not trying (stopped, signed out or in the background). */
export type SocketState = 'open' | 'connecting' | 'waiting' | 'offline';

export interface ConnectionQuality {
  readonly state: SocketState;
  /** Round trip of the last answered keepalive ping, or null before one has been answered on this socket. */
  readonly rttMs: number | null;
  /** Failed attempts or dead sockets since the last successful open. */
  readonly failures: number;
}

export type QualityListener = (quality: ConnectionQuality) => void;

/** The subset of WebSocket the socket uses. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(text: string): void;
  close(code?: number): void;
}

export interface SocketEnv {
  /** Opens a socket carrying the bearer token in its upgrade request. */
  open(url: string, token: string): SocketLike;
  /** 'active' | 'background' | 'inactive' | … */
  appState(): string;
  onAppState(listener: (state: string) => void): { remove(): void };
  /** In [0, 1); jitters backoff waits. */
  random(): number;
}

type Timer = ReturnType<typeof setTimeout>;

export class RelayConnection {
  private ws: SocketLike | null = null;
  private delay = 0;
  private retry: Timer | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private answer: Timer | null = null;
  private backgroundTimer: Timer | null = null;
  private backgroundAt = 0;
  /** Frames received on the current socket; a ping is answered when this moves past its value at send. */
  private heard = 0;
  private pingAt = 0;
  private running = false;
  private snapshot: ConnectionQuality = { state: 'offline', rttMs: null, failures: 0 };
  private readonly listeners = new Set<QualityListener>();
  private readonly appSub: { remove(): void };
  private readonly handlers: SocketHandlers;
  private readonly env: SocketEnv;

  constructor(handlers: SocketHandlers, env: SocketEnv) {
    this.handlers = handlers;
    this.env = env;
    this.appSub = env.onAppState(state => this.onAppState(state));
  }

  get open() { return this.ws?.readyState === OPEN; }
  /** Opening now (not waiting out a backoff). */
  get connecting() { return this.ws?.readyState === CONNECTING; }
  /** The current connection quality (an immutable snapshot). */
  get quality(): ConnectionQuality { return this.snapshot; }

  /** Calls `listener` on every quality change (not immediately); returns the unsubscribe. */
  subscribeQuality(listener: QualityListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start() {
    this.running = true;
    if (!this.ws && !this.retry) this.connect();
  }

  stop() {
    this.running = false;
    this.clearRetry();
    this.drop();
    this.update({});
  }

  dispose() {
    this.stop();
    this.appSub.remove();
    this.listeners.clear();
  }

  /** For user-initiated actions: skips any pending backoff wait and connects now; an open socket is
   * probed instead (no answer within PROBE_MS → reconnect). No-op when stopped, connecting or in the background. */
  kick() {
    if (!this.running || this.connecting) return;
    if (this.open) {
      if (!this.answer) this.sendPing(PROBE_MS);
      return;
    }
    this.clearRetry();
    this.connect();
  }

  send(text: string): boolean {
    if (!this.open) return false;
    this.ws!.send(text);
    return true;
  }

  private update(change: Partial<ConnectionQuality>) {
    const state: SocketState = this.open ? 'open' : this.connecting ? 'connecting' : this.retry ? 'waiting' : 'offline';
    const next = { ...this.snapshot, ...change, state };
    const prev = this.snapshot;
    if (next.state === prev.state && next.rttMs === prev.rttMs && next.failures === prev.failures) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch (error) { console.warn('connection quality listener failed', error); }
    }
  }

  private clearRetry() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private clearAnswer() {
    if (this.answer) clearTimeout(this.answer);
    this.answer = null;
  }

  private drop() {
    const ws = this.ws;
    this.ws = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.clearAnswer();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000); } catch { /* already closed */ }
      this.handlers.onClose();
    }
  }

  /** Sends a ping that must be answered (any frame) within `limitMs`, else the socket is dead. */
  private sendPing(limitMs: number) {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    const sent = this.heard;
    this.pingAt = Date.now();
    this.clearAnswer();
    try { ws.send('ping'); } catch { /* the close handler follows */ }
    this.answer = setTimeout(() => {
      this.answer = null;
      if (this.ws === ws && this.heard === sent) this.dead();
    }, limitMs);
  }

  /** An open socket that stopped answering: count it and reconnect now. */
  private dead() {
    this.drop();
    this.clearRetry();
    this.delay = 0;
    this.update({ failures: this.snapshot.failures + 1, rttMs: null });
    this.connect();
  }

  private connect() {
    this.retry = null;
    const token = this.handlers.token();
    if (!this.running || !token || this.env.appState() === 'background') return this.update({});
    const ws = this.env.open(this.handlers.url(), token);
    this.ws = ws;
    let openedAt = 0;
    const stuck = setTimeout(() => { if (ws.readyState === CONNECTING) closed(1006); }, CONNECT_MS);
    ws.onopen = () => {
      clearTimeout(stuck);
      openedAt = Date.now();
      this.heard = 0;
      this.ping = setInterval(() => this.sendPing(ANSWER_MS), PING_MS);
      this.update({ failures: 0, rttMs: null });
      this.handlers.onOpen();
    };
    ws.onmessage = event => {
      const now = Date.now();
      this.heard += 1;
      if (event.data === 'pong') {
        if (this.pingAt) this.update({ rttMs: now - this.pingAt });
        this.pingAt = 0;
        return;
      }
      // Any frame answers the ping: its pong, if it comes later, would time the traffic ahead of it.
      this.pingAt = 0;
      if (typeof event.data === 'string') this.handlers.onText(event.data);
    };
    const closed = (code: number) => {
      clearTimeout(stuck);
      if (this.ws !== ws) return;
      this.drop();
      const outcome = { opened: openedAt > 0, upMs: openedAt ? Date.now() - openedAt : 0, code };
      if (outcome.code === REVOKED || !outcome.opened) this.handlers.onRefused(token, outcome.code === REVOKED);
      const failures = this.snapshot.failures + 1;
      const next = jitteredBackoff(this.delay, outcome, this.env.random());
      if (!next || !this.running) return this.update({ failures, rttMs: null });
      this.delay = next[1];
      // A first retry goes at once (no timer turn either).
      if (next[0] === 0) {
        this.update({ failures, rttMs: null });
        return this.connect();
      }
      this.retry = setTimeout(() => this.connect(), next[0]);
      this.update({ failures, rttMs: null });
    };
    ws.onclose = event => closed(event.code);
    this.update({});
  }

  private reconnectNow() {
    this.drop();
    this.clearRetry();
    this.delay = 0;
    this.connect();
  }

  private onAppState(state: string) {
    if (state === 'background') {
      this.backgroundAt = Date.now();
      this.backgroundTimer ??= setTimeout(() => {
        this.backgroundTimer = null;
        this.drop();
        this.clearRetry();
        this.update({});
      }, BACKGROUND_MS);
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
    // A socket kept through a short background must answer quickly (iOS may have dropped it).
    if (away > 0 && this.open) this.sendPing(PROBE_MS);
  }
}
