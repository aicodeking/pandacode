// A pushed screen's scroll edge, the same as Settings: the system bar's own material and hairline
// fade in as soon as anything is under it, with iOS's soft edge effect off. The page keeps a focused
// field above the keyboard (react-native-keyboard-controller), and the first tap while it is up reaches
// the button under the finger instead of only closing the keyboard.
import { useHeaderHeight } from 'expo-router/react-navigation';
import type { ReactElement, ReactNode } from 'react';
import { Platform, StyleSheet, View, type ListRenderItem, type RefreshControlProps, type TextStyle } from 'react-native';
import Animated, { interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller';
import { useColors } from './theme.ts';
import { geometry, NO_SYSTEM_EDGES, type as text, useScrollEdgeFeed } from './ds/index.ts';
import { hasGlass } from './Glass.tsx';
import { usePagePadding } from './usePagePadding.ts';
import { useNoDockClearance } from './ds/Toast.tsx';

/** A bar title stays bar-sized at any Dynamic Type size, as the system's does. */
const TITLE_FONT_SCALE = 1.2;

/** The one scroll edge is ds/ScrollEdge, mounted from the root layout. */
export const PUSHED_HEADER = { headerShadowVisible: false, scrollEdgeEffects: NO_SYSTEM_EDGES } as const;

/** How far the content has moved under the bar (0 at rest), and the handler that keeps it. */
export function usePushedScroll() {
  const header = useHeaderHeight();
  const top = hasGlass ? header : 0;
  const scrolled = useSharedValue(0);
  const edge = useScrollEdgeFeed();
  const onScroll = useAnimatedScrollHandler(event => {
    scrolled.set(event.contentOffset.y + top);
    edge.apply(event.contentOffset.y, event.contentSize.height, event.layoutMeasurement.height);
  });
  return { scrolled, onScroll, edge };
}

/** The nav title that fades in as the page's own title leaves: `from` and `to` are scroll distances. */
export function FadingTitle({ title, scrolled, from, to, style }: { title: string; scrolled: SharedValue<number>; from: SharedValue<number>; to: SharedValue<number>; style?: TextStyle }) {
  const colors = useColors();
  const fade = useAnimatedStyle(() => ({ opacity: interpolate(scrolled.get(), [from.get(), to.get()], [0, 1], 'clamp') }));
  return <Animated.Text numberOfLines={1} maxFontSizeMultiplier={TITLE_FONT_SCALE} accessibilityRole="header" style={[text.headline, styles.title, { color: colors.text }, style, fade]}>{title}</Animated.Text>;
}

/** Space kept between a focused field and the keyboard. */
const KEYBOARD_GAP = geometry.sectionGap;

/** The pushed screen's page: side insets, Stack header options by the caller. No dock: toasts sit just
 * above the safe area, not the tab bar's allowance (a screen with its own dock registers it, and wins). */
export function PushedScroll({ scroll, refreshControl, children }: { scroll: ReturnType<typeof usePushedScroll>; refreshControl?: ReactElement<RefreshControlProps>; children: ReactNode }) {
  const colors = useColors();
  const page = usePagePadding();
  useNoDockClearance();
  return (
    <KeyboardAwareScrollView onScroll={scroll.onScroll} onLayout={scroll.edge.onLayout} onContentSizeChange={scroll.edge.onContentSizeChange} scrollEventThrottle={16} style={[styles.scroll, { backgroundColor: colors.background }]} contentContainerStyle={page} contentInsetAdjustmentBehavior="automatic" refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" bottomOffset={KEYBOARD_GAP}>
      {children}
    </KeyboardAwareScrollView>
  );
}

/**
 * PushedScroll for long lists (a folder, search results): the same page, bar edge and side insets, with
 * only the rows on screen mounted. `header` and `footer` sit above and below the rows; `gap` spaces
 * rows that are cards of their own.
 */
export function PushedList<T>({ scroll, data, renderItem, keyExtractor, header, footer, gap, refreshControl }: {
  scroll: ReturnType<typeof usePushedScroll>; data: readonly T[]; renderItem: ListRenderItem<T>; keyExtractor: (item: T, index: number) => string;
  header?: ReactNode; footer?: ReactNode; gap?: boolean; refreshControl?: ReactElement<RefreshControlProps>;
}) {
  const colors = useColors();
  const { paddingTop, paddingBottom, paddingLeft, paddingRight } = usePagePadding();
  useNoDockClearance();
  // Rows stay reachable above the keyboard (a search field's results): iOS insets the list itself
  // (automaticallyAdjustKeyboardInsets); Android gets the keyboard's height as bottom padding.
  const android = Platform.OS === 'android';
  const keyboard = useKeyboardState(state => (android && state.isVisible ? state.height : 0));
  return (
    <Animated.FlatList data={data} renderItem={renderItem} keyExtractor={keyExtractor}
      onScroll={scroll.onScroll} onLayout={scroll.edge.onLayout} onContentSizeChange={scroll.edge.onContentSizeChange} scrollEventThrottle={16}
      style={[styles.scroll, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingTop, paddingBottom: paddingBottom + keyboard, paddingLeft, paddingRight }} contentInsetAdjustmentBehavior="automatic" refreshControl={refreshControl}
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      ListHeaderComponent={header ? <View style={styles.listHeader}>{header}</View> : undefined}
      ListFooterComponent={footer ? <View style={styles.listFooter}>{footer}</View> : undefined}
      ItemSeparatorComponent={gap ? ListGap : undefined} />
  );
}

const ListGap = () => <View style={styles.listGap} />;

/**
 * One row of a card cut into list cells (PushedList): the first rounds the top, the last the bottom,
 * so the rows read as the one Card > InnerCard of RowsCard.
 */
export function CardSlice({ first, last, children }: { first: boolean; last: boolean; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.slice, first && styles.sliceFirst, last && styles.sliceLast, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.innerSlice, first && styles.innerFirst, last && styles.innerLast, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}>
        {children}
      </View>
    </View>
  );
}

/** InnerCard's own vertical padding. */
const INNER_PAD = 2;

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  listHeader: { gap: geometry.sectionGap, paddingBottom: geometry.sectionGap },
  listFooter: { gap: geometry.sectionGap, paddingTop: geometry.sectionGap },
  listGap: { height: geometry.sectionGap },
  slice: { borderLeftWidth: geometry.hairline, borderRightWidth: geometry.hairline, paddingHorizontal: geometry.cardPadding, borderCurve: 'continuous' },
  sliceFirst: { borderTopWidth: geometry.hairline, borderTopLeftRadius: geometry.cardRadius, borderTopRightRadius: geometry.cardRadius, paddingTop: geometry.cardPadding },
  sliceLast: { borderBottomWidth: geometry.hairline, borderBottomLeftRadius: geometry.cardRadius, borderBottomRightRadius: geometry.cardRadius, paddingBottom: geometry.cardPadding },
  innerSlice: { borderLeftWidth: geometry.hairline, borderRightWidth: geometry.hairline, borderCurve: 'continuous' },
  innerFirst: { borderTopWidth: geometry.hairline, borderTopLeftRadius: geometry.innerRadius, borderTopRightRadius: geometry.innerRadius, paddingTop: INNER_PAD },
  innerLast: { borderBottomWidth: geometry.hairline, borderBottomLeftRadius: geometry.innerRadius, borderBottomRightRadius: geometry.innerRadius, paddingBottom: INNER_PAD },
  title: { maxWidth: 240 },
});
