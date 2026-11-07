// The iPhone Duo's sidebar (split.tsx), on the Inbox tab and in tasks: the PandaCode header, every
// computer's tasks in the inbox's section cards (the open task highlighted, nothing folded), and a floating
// glass search field that filters them. Tasks open as the current task route in the pane beside it.
import { Image } from 'expo-image';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emptyCopy, filterInbox, inboxItems, type InboxItem } from '../store/inbox.ts';
import { useConnect } from '../store/index.ts';
import { BotRow } from './BotRow.tsx';
import { useColors } from './theme.ts';
import { EmptyState, type, useStagger } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { CardSlice, ComputerFilter, InboxNotices, InboxSkeleton, SectionHead, TravelCell } from './InboxCard.tsx';
import { InboxRow } from './InboxRow.tsx';
import { useInbox } from './useInbox.ts';

const SHARE = 0.32;
const MIN_WIDTH = 300;
const SEARCH = 48;
const MARGIN = 10;

export const useSidebarWidth = () => Math.max(MIN_WIDTH, Math.round(useWindowDimensions().width * SHARE));

export function Sidebar() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const width = useSidebarWidth();
  const { hosts, inbox, bots, minute, problems, load, updating, connected, loading } = useInbox();
  const [query, setQuery] = useState('');
  const pathname = usePathname();
  const { device, session, computer } = useGlobalSearchParams<{ device?: string; session?: string; computer?: string }>();
  const inTask = pathname.startsWith('/task/');
  const selected = inTask ? `${device}/${session}` : '';
  const selectedBot = useConnect(s => (inTask ? s.bots[device ?? '']?.find(b => b.desktopSession === session)?.id : undefined));

  // The client keeps lists fresh (presence, foreground, run ends, a timer); this covers a new host.
  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => {
    const shown = filterInbox(inbox, bots, { query, computer });
    return inboxItems(shown.inbox, shown.bots, 'all');
  }, [inbox, bots, query, computer]);
  const stagger = useStagger(items.length > 0);
  const empty = emptyCopy(hosts, { query, computer });
  const filterName = computer ? hosts.find(h => h.id === computer)?.name ?? 'This computer' : undefined;

  const render = ({ item, index }: { item: InboxItem; index: number }) => {
    const entering = stagger(index);
    if (item.type === 'head') return <SectionHead section={item.section} count={item.count} computer={item.computer} entering={entering} />;
    return (
      <CardSlice first={item.first} last={item.last} attention={item.type === 'row' && item.section === 'needs'} entering={entering}>
        {item.type === 'bot'
          ? <BotRow row={item.row} showComputer={item.showComputer} minute={minute} sidebar selected={item.row.deviceId === device && item.row.bot.id === selectedBot} replace={inTask} />
          : <InboxRow row={item.row} snoozed={item.section === 'snoozed'} showComputer={item.showComputer} minute={minute} sidebar selected={item.row.key === selected} replace={inTask} />}
      </CardSlice>
    );
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.sidebar, { width: width + insets.left, paddingLeft: insets.left, backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
        <View style={styles.brand} accessibilityRole="header" accessible accessibilityLabel="PandaCode">
          <Image source={require('../../assets/images/icon.png')} style={styles.mark} />
          <Text style={[type.title3, { color: colors.text }]}>PandaCode</Text>
        </View>
      </View>
      <FlatList
        data={items}
        keyExtractor={item => item.key}
        renderItem={render}
        CellRendererComponent={TravelCell}
        contentContainerStyle={[styles.list, { paddingBottom: SEARCH + Math.max(insets.bottom, 12) + 16 }]}
        ListHeaderComponent={
          <>
            {!!filterName && <ComputerFilter name={filterName} onClear={() => router.setParams({ computer: undefined })} />}
            <InboxNotices connected={connected} updating={updating} hasRows={items.length > 0} hosts={hosts} problems={problems} retry={() => void load()} style={styles.notices} />
          </>
        }
        ListEmptyComponent={loading && !query.trim() ? <InboxSkeleton /> : <EmptyState icon={{ ios: query.trim() ? 'magnifyingglass' : 'tray', android: query.trim() ? 'search' : 'inbox' }} title={empty.title} body={empty.body} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
      />
      <Glass style={[styles.search, { left: insets.left + 12, bottom: Math.max(insets.bottom, 12) }]} interactive>
        <Icon ios="magnifyingglass" android="search" size={16} color={colors.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search tasks" placeholderTextColor={colors.muted}
          style={[type.callout, styles.searchInput, { color: colors.text }]} returnKeyType="search" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" accessibilityLabel="Search tasks" />
      </Glass>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sidebar: { height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 12, paddingBottom: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 26, height: 26, borderRadius: 7, borderCurve: 'continuous' },
  list: { paddingTop: 4, paddingHorizontal: MARGIN },
  notices: { marginBottom: 10 },
  search: { position: 'absolute', right: 12, height: SEARCH, borderRadius: SEARCH / 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  searchInput: { flex: 1, height: '100%' },
});
