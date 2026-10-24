import { router } from 'expo-router';
import { memo, useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { useDevices, useStatus, type DeviceRow } from '../../../store/index.ts';
import { useBackdrop } from '../../../ui/Backdrop.tsx';

const Row = memo(function Row({ device }: { device: DeviceRow }) {
  const colors = useBackdrop();
  const open = device.host;
  return (
    <Pressable disabled={!open} onPress={() => router.navigate('/inbox')}
      style={({ pressed }) => [styles.row, { backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]} accessibilityRole={open ? 'button' : undefined}>
      <View style={[styles.dot, { backgroundColor: device.online ? colors.green : colors.tertiary }]} accessibilityLabel={device.online ? 'Online' : 'Offline'} />
      <View style={styles.main}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{device.name}</Text>
        <Text style={[styles.detail, { color: colors.secondary }]}>{device.platform}{device.online ? ' · online' : ' · offline'}</Text>
        {!device.host && <Text style={[styles.detail, { color: colors.orange }]}>Remote control is off on this computer. Turn on Allow remote control in Settings → Remote access.</Text>}
      </View>
    </Pressable>
  );
});

export default function Computers() {
  const colors = useBackdrop();
  const all = useDevices();
  const { connected } = useStatus();
  const insets = useSafeAreaInsets();
  const devices = all.filter(d => !d.current);
  const refresh = useCallback(() => { connect.refreshDevices().catch(() => undefined); }, []);
  return (
    <FlatList
      style={{ backgroundColor: colors.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.list, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right }]}
      data={devices}
      keyExtractor={d => d.id}
      renderItem={({ item }) => <Row device={item} />}
      onRefresh={refresh}
      refreshing={false}
      ItemSeparatorComponent={() => <View style={styles.gap} />}
      ListEmptyComponent={<Text style={[styles.empty, { color: colors.secondary }]}>{connected ? 'No other devices on this account yet. Sign in to PandaCode Connect on your computer.' : 'Connecting…'}</Text>}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, padding: 14 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  main: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '600' },
  detail: { fontSize: 13 },
  gap: { height: 10 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 40 },
});
