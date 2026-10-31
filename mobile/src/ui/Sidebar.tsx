// The iPhone Duo's sidebar (split.tsx), on the Inbox tab and in tasks: the PandaCode header, every
// computer's tasks in one compact list (the open task highlighted), its bots after Unsent, and a floating glass search
// field that filters it. Tasks open as the current task route in the pane beside it.
import { Image } from 'expo-image';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { filterBots, filterRows, type BotRow as BotItem, type InboxRow as Row, type Section } from '../store/inbox.ts';
import { useConnect } from '../store/index.ts';
import { BotRow } from './BotRow.tsx';
import { Material, useWallpaperShown } from './Backdrop.tsx';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { InboxRow } from './InboxRow.tsx';
import { useColors } from './theme.ts';
import { useInbox } from './useInbox.ts';

const SHARE = 0.32;
const MIN_WIDTH = 300;
const SEARCH = 48;
const ORDER: (Section | 'bots')[] = ['running', 'needs', 'recent', 'unsent', 'bots', 'settled', 'snoozed'];

export const useSidebarWidth = () => Math.max(MIN_WIDTH, Math.round(useWindowDimensions().width * SHARE));

type Item = { section: Section; row: Row } | { section: 'bots'; row: BotItem };

export function Sidebar() {
  const colors = useColors();
  const wallpaper = useWallpaperShown();
  const insets = useSafeAreaInsets();
  const width = useSidebarWidth();
  const { hosts, inbox, bots, minute, load, updating } = useInbox();
  const [query, setQuery] = useState('');
  const pathname = usePathname();
  const { device, session } = useGlobalSearchParams<{ device?: string; session?: string }>();
  const inTask = pathname.startsWith('/task/');
  const selected = inTask ? `${device}/${session}` : '';
  const selectedBot = useConnect(s => (inTask ? s.bots[device ?? '']?.find(b => b.desktopSession === session)?.id : undefined));

  // The client keeps lists fresh (presence, foreground, run ends, a timer); this covers a new host.
  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => ORDER.flatMap((section): Item[] => (section === 'bots'
    ? filterBots(bots, query).map(row => ({ section, row }))
    : filterRows(inbox[section], query).map(row => ({ section, row })))), [inbox, bots, query]);
  const empty = query.trim() ? 'No matching threads.' : !hosts.length ? 'Turn on remote access on a computer signed in to the same GitHub account to see its tasks here.' : 'No tasks yet.';

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.sidebar, { width: width + insets.left, paddingLeft: insets.left, backgroundColor: wallpaper ? undefined : colors.grouped }]}>
      {/* Over the wallpaper the sidebar is a system blur material, like iPadOS. */}
      {wallpaper && <Material material="systemThinMaterial" style={StyleSheet.absoluteFill} />}
      <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
        <View style={styles.brand} accessibilityRole="header" accessible accessibilityLabel="PandaCode">
          <Image source={require('../../assets/images/icon.png')} style={styles.mark} />
          <Text style={[styles.brandText, { color: colors.text }]}>PandaCode</Text>
        </View>
        {updating && <Text style={[styles.updating, { color: colors.secondary }]} accessibilityLiveRegion="polite">Updating…</Text>}
      </View>
      <FlatList
        data={items}
        keyExtractor={(item: Item) => `${item.section}/${item.row.key}`}
        renderItem={({ item, index }) => (item.section === 'bots'
          ? <BotRow row={item.row} last={index === items.length - 1} minute={minute} sidebar selected={item.row.deviceId === device && item.row.bot.id === selectedBot} replace={inTask} />
          : <InboxRow row={item.row} snoozed={item.section === 'snoozed'} last={index === items.length - 1} minute={minute}
            sidebar selected={item.row.key === selected} replace={inTask} />
        )}
        contentContainerStyle={[styles.list, { paddingBottom: SEARCH + Math.max(insets.bottom, 12) + 16 }]}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.secondary }]}>{empty}</Text>}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
      />
      <Glass style={[styles.search, { left: insets.left + 12, bottom: Math.max(insets.bottom, 12) }]} interactive>
        <Icon ios="magnifyingglass" android="search" size={16} color={colors.secondary} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search threads" placeholderTextColor={colors.secondary as string}
          style={[styles.searchInput, { color: colors.text }]} returnKeyType="search" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" accessibilityLabel="Search threads" />
      </Glass>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sidebar: { height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 12, paddingBottom: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 26, height: 26, borderRadius: 7 },
  brandText: { fontSize: 21, fontWeight: '700', letterSpacing: -0.4 },
  updating: { fontSize: 13 },
  list: { gap: 2, paddingTop: 4 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
  search: { position: 'absolute', right: 12, height: SEARCH, borderRadius: SEARCH / 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  searchInput: { flex: 1, fontSize: 16, height: '100%' },
});
