// The relay connection's quality for screens: `useConnectionQuality()` follows the socket
// (src/connect/relay-socket.ts) and `<ConnectionDot/>` shows it as one small status dot with a
// spoken label ("Connected, 120 ms"); `<ConnectionNotice/>` is the task screen's banner while the relay
// is down or the computer is offline (messages wait in the outbox). Demo mode always reads as connected.
import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { connect } from '../connect/client.ts';
import type { ConnectionQuality } from '../connect/socket.ts';
import { useConnect } from '../store/index.ts';
import { Banner } from './ds/Banner.tsx';
import { StatusDot } from './ds/StatusDot.tsx';
import { type as textStyle } from './ds/type.ts';
import { useColors } from './theme.ts';
import type { StatusTone } from './ds/palette.ts';

/** A round trip slower than this reads as a weak connection. */
export const SLOW_RTT_MS = 800;
const DEMO: ConnectionQuality = { state: 'open', rttMs: null, failures: 0 };

export function useConnectionQuality(): ConnectionQuality {
  const demo = useConnect(s => s.demo);
  const quality = useSyncExternalStore(connect.subscribeQuality, connect.connectionQuality);
  return demo ? DEMO : quality;
}

/** The dot's tone and spoken label for a quality. Pure, so screens and tests can share it. */
export function describeQuality(quality: ConnectionQuality): { tone: StatusTone; label: string; pulse: boolean } {
  switch (quality.state) {
    case 'open': {
      const slow = quality.rttMs !== null && quality.rttMs > SLOW_RTT_MS;
      const label = quality.rttMs === null ? 'Connected' : `Connected, ${Math.round(quality.rttMs)} ms${slow ? ', slow' : ''}`;
      return { tone: slow ? 'warning' : 'success', label, pulse: false };
    }
    case 'connecting':
      return { tone: 'warning', label: 'Connecting', pulse: true };
    case 'waiting':
      return { tone: 'warning', label: quality.failures > 1 ? `Reconnecting, ${quality.failures} tries so far` : 'Reconnecting', pulse: true };
    default:
      return { tone: 'danger', label: 'Offline', pulse: false };
  }
}

/** A small dot for a header or status row; `size` in points. */
export function ConnectionDot({ size }: { size?: number }) {
  const { tone, label, pulse } = describeQuality(useConnectionQuality());
  return <StatusDot tone={tone} pulse={pulse} size={size} accessibilityLabel={label} />;
}

/** A small dot and its label on one line, for a list header. */
export function ConnectionLine() {
  const colors = useColors();
  const { tone, label, pulse } = describeQuality(useConnectionQuality());
  return (
    <View style={styles.line} accessible accessibilityLabel={`Connection: ${label}`}>
      <StatusDot tone={tone} pulse={pulse} size={7} />
      <Text style={[textStyle.footnote, { color: colors.muted }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** What a task screen says about getting messages through, or null when nothing is in the way. Pure. */
export function connectionNotice(quality: ConnectionQuality, hostOnline: boolean, hostName: string): { title: string; body: string } | null {
  if (quality.state === 'offline') return { title: 'You’re offline', body: 'Messages you send wait here and go out when the connection is back.' };
  if (quality.state === 'waiting') return { title: 'Reconnecting…', body: 'Messages you send wait here and go out when the connection is back.' };
  if (quality.state === 'open' && !hostOnline) return { title: `${hostName || 'This computer'} is offline`, body: 'Messages you send wait here until it is back.' };
  return null;
}

/** The task screen's banner while messages can't get through. */
export function ConnectionNotice({ deviceId, style }: { deviceId: string; style?: StyleProp<ViewStyle> }) {
  const quality = useConnectionQuality();
  const demo = useConnect(s => s.demo);
  const host = useConnect(s => s.devices.find(d => d.id === deviceId));
  const notice = demo ? null : connectionNotice(quality, host?.online ?? true, host?.name ?? '');
  return <Banner visible={!!notice} title={notice?.title ?? ''} body={notice?.body} tone="warning" icon={{ ios: 'wifi.exclamationmark', android: 'wifi_off' }} style={style} />;
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
});
