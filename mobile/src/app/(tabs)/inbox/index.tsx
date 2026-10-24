// The inbox (home): every computer's tasks in one list. Needs you, Working, Recent,
// Unsent (the outbox), then Snoozed and Settled folded away. Logic in src/store/inbox.ts.
import { Image } from 'expo-image';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEMO } from '../../../demo.ts';
import type { InboxRow as Row, Section } from '../../../store/inbox.ts';
import { useStatus } from '../../../store/index.ts';
import { Icon } from '../../../ui/Icon.tsx';
import { InboxRow } from '../../../ui/InboxRow.tsx';
import { Menu, type MenuItem } from '../../../ui/Menu.tsx';
import { NewThread } from '../../../ui/NewThread.tsx';
import { useSplit } from '../../../ui/split.tsx';
import { useBackdrop } from '../../../ui/Backdrop.tsx';
import { useColors } from '../../../ui/theme.ts';
import { useInbox } from '../../../ui/useInbox.ts';

const TITLES: Record<Section, string> = { needs: 'Needs you', working: 'Working', recent: 'Recent', unsent: 'Unsent', snoozed: 'Snoozed', settled: 'Settled' };
const FOLDED: Section[] = ['snoozed', 'settled'];

type Item = { type: 'header'; section: Section; count: number; open?: boolean } | { type: 'row'; section: Section; row: Row; last: boolean };

/** On the iPhone Duo the sidebar is the inbox, so this route is the New thread pane. */
export default function InboxRoute() {
  return useSplit() ? <NewThread /> : <Inbox />;
}

function Inbox() {
  const colors = useColors();
  const backdrop = useBackdrop();
  const { connected } = useStatus();
  const insets = useSafeAreaInsets();
  const { hosts, inbox, minute, errors, load } = useInbox();
  const [open, setOpen] = useState<Partial<Record<Section, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const online = hosts.filter(h => h.online);
  // The client keeps lists fresh (presence, foreground, run ends, a timer); focus also reports errors.
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const items = useMemo(() => {
    const list: Item[] = [];
    for (const section of ['needs', 'working', 'recent', 'unsent', 'snoozed', 'settled'] as Section[]) {
      const rows = inbox[section];
      if (!rows.length) continue;
      const folded = FOLDED.includes(section);
      list.push({ type: 'header', section, count: rows.length, open: folded ? !!open[section] : undefined });
      if (!folded || open[section]) rows.forEach((row, i) => list.push({ type: 'row', section, row, last: i === rows.length - 1 }));
    }
    return list;
  }, [inbox, open]);

  const render = ({ item }: { item: Item }) => {
    if (item.type === 'row') return <InboxRow row={item.row} snoozed={item.section === 'snoozed'} last={item.last} minute={minute} />;
    const title = item.open === undefined ? TITLES[item.section] : `${TITLES[item.section]} (${item.count})`;
    if (item.open === undefined) return <Text style={[styles.section, { color: colors.secondary }]} accessibilityRole="header">{title}</Text>;
    return (
      <Pressable onPress={() => setOpen(o => ({ ...o, [item.section]: !o[item.section] }))} style={styles.foldHeader} accessibilityRole="button" accessibilityState={{ expanded: item.open }}>
        <Text style={[styles.section, styles.foldTitle, { color: colors.secondary }]}>{title}</Text>
        <Icon ios={item.open ? 'chevron.down' : 'chevron.right'} android={item.open ? 'expand_more' : 'chevron_right'} size={12} color={colors.secondary} />
      </Pressable>
    );
  };

  const offline = hosts.filter(h => !h.online).map(h => h.name);
  const problems = [...Object.values(errors), ...(connected || DEMO ? [] : ['Connecting to PandaCode Connect…'])];
  const empty = !hosts.length ? 'Turn on remote access on a computer signed in to the same GitHub account to see its tasks here.'
    : !online.length ? `${offline.join(', ')} ${offline.length > 1 ? 'are' : 'is'} offline.`
    : 'No tasks yet. Start one with New task.';

  const menu: MenuItem[] = [
    { label: 'New task', ios: 'square.and.pencil', android: 'edit_square', onPress: () => router.push('/new-task') },
    { label: 'Refresh', ios: 'arrow.clockwise', android: 'refresh', onPress: () => void refresh() },
  ];

  return (
    <>
      <Stack.Screen options={{
        title: '',
        headerLeft: Platform.OS === 'ios' ? undefined : () => <Brand />,
        // iOS: a native bar button item (below), which the iPhone Duo moves into its rail.
        headerRight: Platform.OS === 'ios' ? undefined : () => <Menu ios="ellipsis" android="more_vert" color={colors.text} items={menu} label="More">{icon => <View style={styles.more}>{icon}</View>}</Menu>,
      }} />
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.View hidesSharedBackground><Brand /></Stack.Toolbar.View>
        </Stack.Toolbar>
      )}
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New task" onPress={() => router.push('/new-task')} />
        </Stack.Toolbar>
      )}
      <FlatList
        style={{ backgroundColor: backdrop.background }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingLeft: insets.left, paddingRight: insets.right }}
        data={items}
        keyExtractor={item => (item.type === 'header' ? `h/${item.section}` : `${item.section}/${item.row.key}`)}
        renderItem={render}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListHeaderComponent={problems.length ? <Text style={[styles.problem, { color: colors.secondary }]}>{problems.join('\n')}</Text> : undefined}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.secondary }]}>{empty}</Text>}
        initialNumToRender={14}
      />
    </>
  );
}

function Brand() {
  const colors = useColors();
  return (
    <View style={styles.brand} accessibilityRole="header" accessible accessibilityLabel="PandaCode">
      <Image source={require('../../../../assets/images/icon.png')} style={styles.mark} />
      <Text style={[styles.brandText, { color: colors.text }]}>PandaCode</Text>
    </View>
  );
}


const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Platform.OS === 'ios' ? 4 : 0 },
  mark: { width: 26, height: 26, borderRadius: 7 },
  brandText: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  more: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 13, fontWeight: '600', marginTop: 22, marginBottom: 2, paddingHorizontal: 20 },
  foldHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 20, marginTop: 22, marginBottom: 2 },
  foldTitle: { paddingRight: 0, marginTop: 0, marginBottom: 0 },
  problem: { fontSize: 13, paddingHorizontal: 20, paddingTop: 8 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 60, paddingHorizontal: 32 },
});
