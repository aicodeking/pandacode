// Every other device on the account: a card each, opening that computer's hub (computer/[device].tsx),
// where 'Tasks on this computer' still opens the inbox filtered to it.
import { router } from 'expo-router';
import type { SFSymbol } from 'expo-symbols';
import { memo, useCallback, useState, type ComponentProps } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { computerSummary, platformName } from '../../../store/inbox.ts';
import { useDevices, useStatus, type DeviceRow } from '../../../store/index.ts';
import { useColors } from '../../../ui/theme.ts';
import { Banner, crossFadeIn, EmptyState, geometry, Group, Row, StatusDot, type, useMotion, useScrollEdge, useStagger } from '../../../ui/ds/index.ts';
import { Icon } from '../../../ui/Icon.tsx';
import { ConnectionLine } from '../../../ui/ConnectionQuality.tsx';
import { InboxSkeleton, ROW_PRESS_DELAY_MS } from '../../../ui/InboxCard.tsx';
import { ago } from '../../../ui/status.tsx';
import { useInbox } from '../../../ui/useInbox.ts';

type Entering = ComponentProps<typeof Animated.View>['entering'];

const SYMBOLS: Record<string, { ios: SFSymbol; android: ComponentProps<typeof Icon>['android'] }> = {
  macos: { ios: 'desktopcomputer', android: 'computer' },
  windows: { ios: 'pc', android: 'desktop_windows' },
  linux: { ios: 'server.rack', android: 'dns' },
  ios: { ios: 'iphone', android: 'smartphone' },
  android: { ios: 'candybarphone', android: 'smartphone' },
};

function DeviceGlyph({ device }: { device: DeviceRow }) {
  const colors = useColors();
  const symbol = SYMBOLS[device.platform.toLowerCase()] ?? SYMBOLS.macos;
  return (
    <View style={styles.glyph}>
      <Icon {...symbol} size={22} color={colors.muted} />
      <View style={[styles.dot, { backgroundColor: colors.cardInner }]}>
        {device.online ? <StatusDot tone="running" size={7} /> : <View style={[styles.offline, { backgroundColor: colors.faint }]} />}
      </View>
    </View>
  );
}

const DeviceCard = memo(function DeviceCard({ device, summary, entering }: { device: DeviceRow; summary: string; entering: Entering }) {
  const colors = useColors();
  const seen = !device.online && device.lastSeen ? ago(device.lastSeen) : '';
  const state = device.online ? 'Online' : seen && seen !== 'now' ? `Last seen ${seen} ago` : 'Offline';
  const subtitle = `${platformName(device.platform)} · ${state}`;
  const label = [device.name, subtitle, summary].filter(Boolean).join(', ');
  // Offline hosts open too: the hub shows their status and the inbox keeps their cached tasks.
  const open = () => router.push({ pathname: '/computer/[device]', params: { device: device.id } });
  return (
    <Animated.View entering={entering} style={styles.card}>
      {/* One row says nothing with a second card round it: a single card, with the hint as its note. */}
      <Group accessible={!device.host} accessibilityLabel={device.host ? undefined : label} footer={!device.host && (
        <View style={styles.note}>
          <Icon ios="info.circle" android="info" size={16} color={colors.warning} />
          <Text style={[type.footnote, styles.noteText, { color: colors.muted }]}>Remote control is off on this computer. Turn on Allow remote control in Settings → Remote access.</Text>
        </View>
      )}>
        <Row title={device.name} subtitle={subtitle} leading={<DeviceGlyph device={device} />} trailing={summary || undefined} chevron={device.host}
          onPress={device.host ? open : undefined} unstable_pressDelay={ROW_PRESS_DELAY_MS} accessibilityLabel={label} accessibilityHint="Opens this computer: its tasks, projects and tools" />
      </Group>
    </Animated.View>
  );
});

export default function Computers() {
  const colors = useColors();
  const all = useDevices();
  const { connected } = useStatus();
  const { inbox } = useInbox();
  const { layout } = useMotion();
  const insets = useSafeAreaInsets();
  const devices = all.filter(d => !d.current);
  const stagger = useStagger(devices.length > 0);
  const edge = useScrollEdge();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await connect.refreshDevices().catch(() => undefined);
    setRefreshing(false);
  }, []);
  return (
    <Animated.FlatList
      {...edge}
      style={{ backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.list, { paddingLeft: geometry.screenMargin + insets.left, paddingRight: geometry.screenMargin + insets.right }]}
      data={devices}
      keyExtractor={d => d.id}
      renderItem={({ item, index }) => <DeviceCard device={item} summary={computerSummary(inbox, item.id)} entering={stagger(index) ?? crossFadeIn} />}
      itemLayoutAnimation={layout}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      ListHeaderComponent={(
        <>
          <Banner visible={!connected} title="Connecting…" icon={{ ios: 'wifi.exclamationmark', android: 'wifi_off' }} style={styles.banner} />
          <View style={styles.banner}><ConnectionLine /></View>
        </>
      )}
      // Presence lists this phone too: no rows at all means it hasn't arrived.
      ListEmptyComponent={!all.length ? <InboxSkeleton rows={2} /> : (
        <EmptyState icon={{ ios: 'desktopcomputer', android: 'computer' }} title="No computers yet" body="No other devices on this account yet. Sign in to PandaCode Connect on your computer." style={styles.empty} />
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingTop: 4, paddingBottom: geometry.sectionGap },
  card: { marginBottom: geometry.sectionGap },
  banner: { marginBottom: geometry.sectionGap },
  glyph: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: -1, right: -3, padding: 1.5, borderRadius: 6 },
  offline: { width: 7, height: 7, borderRadius: 3.5 },
  note: { flexDirection: 'row', gap: 8, paddingHorizontal: geometry.rowInset },
  noteText: { flex: 1 },
  empty: { marginTop: geometry.emptyTop },
});
