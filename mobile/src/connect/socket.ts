// The one WebSocket to the relay (viewer only, host=0); the logic is in relay-socket.ts, mirroring
// src-tauri/src/remote/socket.rs. The relay reads the bearer token from the upgrade request's
// Authorization header (relay/src/index.ts), which React Native's WebSocket can set.
import { AppState } from 'react-native';
import { RelayConnection, type SocketEnv, type SocketHandlers, type SocketLike } from './relay-socket.ts';

export { ANSWER_MS, CONNECT_MS, PING_MS } from './relay-socket.ts';
export type { ConnectionQuality, QualityListener, SocketHandlers, SocketState } from './relay-socket.ts';

// React Native's WebSocket takes headers as a third argument (the DOM typings don't know it).
type RNWebSocket = new (url: string, protocols: null, options: { headers: Record<string, string> }) => SocketLike;

const nativeEnv: SocketEnv = {
  open: (url, token) => new (WebSocket as unknown as RNWebSocket)(url, null, { headers: { Authorization: `Bearer ${token}` } }),
  appState: () => AppState.currentState ?? 'unknown',
  onAppState: listener => AppState.addEventListener('change', listener),
  random: Math.random,
};

/** The relay socket bound to React Native. Public API: `start`, `stop`, `dispose`, `send`, `open`,
 * `connecting`, `kick()`, `quality` and `subscribeQuality(listener)`. */
export class RelaySocket extends RelayConnection {
  constructor(handlers: SocketHandlers) {
    super(handlers, nativeEnv);
  }
}
