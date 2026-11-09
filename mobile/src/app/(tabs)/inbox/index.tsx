// The inbox (home): every computer's tasks in one list, one card per section: Running, Needs you,
// Recent, Unsent (the outbox), Bots (every computer's bots; their conversations stay out of the
// other sections), then Snoozed and Settled folded away. `?computer=` (from Computers) shows one
// computer's rows. Logic in src/store/inbox.ts.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Platform, RefreshControl, StyleSheet, View, type NativeSyntheticEvent, type TextInputChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emptyCopy, filterInbox, inboxItems, type InboxItem, type SectionId } from '../../../store/inbox.ts';
import { BotRow } from '../../../ui/BotRow.tsx';
import { Brand } from '../../../ui/brand/Brand.tsx';
import { contentShown, useIntro } from '../../../ui/splash/handoff.ts';
import { EmptyState, geometry, useMotion, useScrollEdge, useStagger } from '../../../ui/ds/index.ts';
import { CardSlice, ComputerFilter, InboxNotices, InboxSkeleton, SectionHead, TravelCell, useFolds } from '../../../ui/InboxCard.tsx';
import { InboxRow } from '../../../ui/InboxRow.tsx';
import { Menu, type MenuItem } from '../../../ui/Menu.tsx';
import { NewThread } from '../../../ui/NewThread.tsx';
import { useSplit } from '../../../ui/split.tsx';
import { useColors } from '../../../ui/theme.ts';
import { useInbox } from '../../../ui/useInbox.ts';

/** On the iPhone Duo the sidebar is the inbox, so this route is the New thread pane. */
export default function InboxRoute() {
  return useSplit() ? <NewThread /> : <Inbox />;
}

const newTask = () => router.push('/new-task');
const clearComputer = () => router.setParams({ computer: undefined });

function Inbox() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { computer } = useLocalSearchParams<{ computer?: string }>();
  const { hosts, inbox, bots, minute, problems, load, updating, connected, loading } = useInbox();
  const folds = useFolds();
  const { enter } = useMotion();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // The client keeps lists fresh (presence, foreground, run ends, a timer); focus also reports errors.
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const refresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const foldsShown = JSON.stringify(folds.shown);
  const items = useMemo(() => {
    const shown = filterInbox(inbox, bots, { query, computer });
    return inboxItems(shown.inbox, shown.bots, query.trim() ? 'all' : JSON.parse(foldsShown) as Record<SectionId, boolean>);
  }, [inbox, bots, query, computer, foldsShown]);
  // On a cold launch the intro's hand-off brings the whole list in (contentShown), so rows don't stagger
  // in a second time.
  const [underIntro] = useState(() => !useIntro.getState().done);
  const introDone = useIntro(s => s.done);
  const stagger = useStagger(items.length > 0 && !underIntro);
  const veil = useAnimatedStyle(() => ({ opacity: 1 - contentShown.get() }));
  // A plain FlatList: Reanimated's would replace TravelCell, so the edge follows on the JS thread.
  const edge = useScrollEdge({ js: true });

  const render = ({ item, index }: { item: InboxItem; index: number }) => {
    if (item.type === 'head') return <SectionHead section={item.section} count={item.count} open={item.open && !folds.closing(item.section)} computer={item.computer} entering={underIntro ? undefined : stagger(index)} onToggle={() => folds.toggle(item.section)} />;
    // A row of a folded section only mounts when that section opens: they come in as a short cascade.
    const entering = item.type === 'row' && folds.shown[item.section] ? enter(item.position) : underIntro ? undefined : stagger(index);
    return (
      <CardSlice first={item.first} last={item.last} attention={item.type === 'row' && item.section === 'needs'} leaving={item.type === 'row' && folds.closing(item.section)} entering={entering}>
        {item.type === 'bot'
          ? <BotRow row={item.row} showComputer={item.showComputer} minute={minute} />
          : <InboxRow row={item.row} snoozed={item.section === 'snoozed'} showComputer={item.showComputer} minute={minute} />}
      </CardSlice>
    );
  };

  const options = useMemo(() => {
    const menu: MenuItem[] = [
      { label: 'New task', ios: 'square.and.pencil', android: 'edit_square', onPress: newTask },
      { label: 'Refresh', ios: 'arrow.clockwise', android: 'refresh', onPress: () => void refresh() },
    ];
    return {
      // No title: the tab bar names the screen, so the bar carries only its icons.
      title: 'Inbox',
      headerTitle: '',
      headerSearchBarOptions: {
        placeholder: 'Search tasks',
        // A magnifying glass in the bar that becomes the field on tap; Cancel clears and restores the list.
        placement: 'integratedButton' as const,
        allowToolbarIntegration: false,
        autoCapitalize: 'none' as const,
        onChangeText: (event: NativeSyntheticEvent<TextInputChangeEvent['nativeEvent']>) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(''),
      },
      headerLeft: Platform.OS === 'ios' ? undefined : () => <Brand />,
      // iOS: a native bar button item (below), which the iPhone Duo moves into its rail.
      headerRight: Platform.OS === 'ios' ? undefined : () => <Menu ios="ellipsis" android="more_vert" color={colors.text} items={menu} label="More">{icon => <View style={styles.more}>{icon}</View>}</Menu>,
    };
  }, [colors.text, refresh]);

  const filterName = computer ? hosts.find(h => h.id === computer)?.name ?? 'This computer' : undefined;
  const empty = emptyCopy(hosts, { query, computer });
  return (
    <>
      <Stack.Screen options={options} />
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="left">
          {/* No glass capsule: the brand sits on the bar like a title. */}
          <Stack.Toolbar.View hidesSharedBackground><Brand /></Stack.Toolbar.View>
        </Stack.Toolbar>
      )}
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New task" onPress={newTask} />
        </Stack.Toolbar>
      )}
      <FlatList
        {...edge}
        style={{ backgroundColor: colors.background }}
        // Automatic adds the header's and tab bar's insets; the padding keeps the last card off the bar's glass.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.list, { paddingLeft: geometry.screenMargin + insets.left, paddingRight: geometry.screenMargin + insets.right }]}
        data={items}
        keyExtractor={item => item.key}
        renderItem={render}
        CellRendererComponent={TravelCell}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            {!!filterName && <ComputerFilter name={filterName} onClear={clearComputer} />}
            <InboxNotices connected={connected} updating={updating} hasRows={items.length > 0} hosts={hosts} problems={problems} retry={refresh} style={styles.notices} />
          </>
        }
        ListEmptyComponent={loading && !query.trim() ? <InboxSkeleton /> : (
          <EmptyState icon={{ ios: query.trim() ? 'magnifyingglass' : 'tray', android: query.trim() ? 'search' : 'inbox' }} title={empty.title} body={empty.body}
            action={!query.trim() && !computer && hosts.some(h => h.online) ? { label: 'New task', onPress: newTask } : undefined} style={styles.empty} />
        )}
        initialNumToRender={14}
      />
      {/* On a cold launch the list is mounted under the intro from the start (never remounted: that left a
          blank gap) and revealed by its hand-off through this veil. A veil, not an animated wrapper: any
          live animated style on the list's ancestor left the rows undrawn (Reanimated 4, Fabric). */}
      {underIntro && !introDone && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }, veil]} />}
    </>
  );
}

const styles = StyleSheet.create({
  more: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  list: { paddingTop: 4, paddingBottom: geometry.sectionGap },
  notices: { marginBottom: geometry.sectionGap },
  empty: { marginTop: 40 },
});
