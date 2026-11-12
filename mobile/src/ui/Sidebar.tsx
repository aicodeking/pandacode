// The iPhone Duo's sidebar (split.tsx), on the Inbox tab and in tasks: the PandaCode header, every
// computer's tasks in the inbox's section cards (the open task highlighted, only Archived folded), an Undo
// toast after an archive, and a floating
// glass search field that filters them, with the inbox's "In conversations" matches under them
// (SearchResults.tsx). Tasks open as the current task route in the pane beside it.
import { Image } from 'expo-image';
import { router, useGlobalSearchParams, useRootNavigationState } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emptyCopy, filterInbox, inboxItems, type InboxItem } from '../store/inbox.ts';
import { useConnect } from '../store/index.ts';
import { BotRow } from './BotRow.tsx';
import { useColors } from './theme.ts';
import { EmptyState, geometry, type, useStagger } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { CardSlice, ComputerFilter, InboxNotices, InboxSkeleton, SectionHead, TravelCell, useFolds } from './InboxCard.tsx';
import { InboxRow } from './InboxRow.tsx';
import { SearchResults, useThreadSearch } from './SearchResults.tsx';
import { rootStack, sidebarOpen, sidebarSelection, type StackState } from './sidebar-nav.ts';
import { sidebarWidth } from './sidebar-width.ts';
import { useInbox } from './useInbox.ts';

const SEARCH = 48;
const MARGIN = geometry.screenMargin;

export const useSidebarWidth = () => sidebarWidth(useWindowDimensions().width);

export function Sidebar() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const width = useSidebarWidth();
  const { hosts, inbox, bots, minute, problems, load, updating, connected, loading } = useInbox();
  const [query, setQuery] = useState('');
  const { computer } = useGlobalSearchParams<{ computer?: string }>();
  // From the navigation state, not the path: the open task stays lit under Changes, Files... over it.
  const stack = rootStack(useRootNavigationState() as StackState | undefined);
  const selected = sidebarSelection(stack);
  // How a pick opens (sidebar-open.ts): pushed over the root, replacing the open task, or over a
  // feature screen back to the root first.
  const how = sidebarOpen(stack);
  const [device, session] = selected ? selected.split('/') : ['', ''];
  const selectedBot = useConnect(s => (selected ? s.bots[device]?.find(b => b.desktopSession === session)?.id : undefined));

  // The client keeps lists fresh (presence, foreground, run ends, a timer); this covers a new host.
  useEffect(() => { void load(); }, [load]);

  // Everything open but Archived, which can hold every settled task the computers list.
  const folds = useFolds();
  const archivedOpen = !!folds.shown.archived;
  const items = useMemo(() => {
    const shown = filterInbox(inbox, bots, { query, computer });
    return inboxItems(shown.inbox, shown.bots, query.trim() ? 'all' : { snoozed: true, settled: true, archived: archivedOpen });
  }, [inbox, bots, query, computer, archivedOpen]);
  // Conversation text from computers that search it, under the title matches (not repeating them), as the inbox.
  const titled = useMemo(() => new Set(items.flatMap(item => (item.type === 'row' ? [item.row.key] : []))), [items]);
  const conversations = useThreadSearch(query, computer, titled);
  const searched = !!query.trim();
  const stagger = useStagger(items.length > 0);
  const empty = emptyCopy(hosts, { query, computer });
  const filterName = computer ? hosts.find(h => h.id === computer)?.name ?? 'This computer' : undefined;

  const render = ({ item, index }: { item: InboxItem; index: number }) => {
    const entering = stagger(index);
    if (item.type === 'head') {
      const folding = item.section === 'archived' && item.open !== undefined;
      return <SectionHead section={item.section} count={item.count} open={folding ? item.open && !folds.closing(item.section) : undefined} computer={item.computer} entering={entering} onToggle={folding ? () => folds.toggle(item.section) : undefined} />;
    }
    return (
      <CardSlice first={item.first} last={item.last} attention={item.type === 'row' && item.section === 'needs'} leaving={item.type === 'row' && folds.closing(item.section)} entering={entering}>
        {item.type === 'bot'
          ? <BotRow row={item.row} showComputer={item.showComputer} minute={minute} sidebar selected={item.row.deviceId === device && item.row.bot.id === selectedBot} how={how} />
          : <InboxRow row={item.row} snoozed={item.section === 'snoozed'} showComputer={item.showComputer} minute={minute} sidebar selected={item.row.key === selected} how={how} />}
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
        ListFooterComponent={searched ? <SearchResults hits={conversations.hits} query={query} searching={conversations.searching} how={how} /> : undefined}
        ListEmptyComponent={loading && !searched ? <InboxSkeleton /> : conversations.hits.length || conversations.searching ? undefined : (
          <EmptyState icon={{ ios: searched ? 'magnifyingglass' : 'tray', android: searched ? 'search' : 'inbox' }} title={empty.title} body={empty.body} />
        )}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
      />
      <Glass style={[styles.search, { left: insets.left + geometry.rowInset, bottom: Math.max(insets.bottom, 12) }]} interactive>
        <Icon ios="magnifyingglass" android="search" size={16} color={colors.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search tasks" placeholderTextColor={colors.muted}
          style={[type.callout, styles.searchInput, { color: colors.text }]} returnKeyType="search" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" accessibilityLabel="Search tasks" />
      </Glass>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sidebar: { height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: MARGIN + geometry.rowInset, paddingRight: geometry.rowInset, paddingBottom: geometry.sectionGap },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 26, height: 26, borderRadius: 7, borderCurve: 'continuous' },
  list: { paddingTop: 4, paddingHorizontal: MARGIN },
  notices: { marginBottom: geometry.sectionGap },
  search: { position: 'absolute', right: geometry.rowInset, height: SEARCH, borderRadius: SEARCH / 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: geometry.rowInset },
  searchInput: { flex: 1, height: '100%' },
});
