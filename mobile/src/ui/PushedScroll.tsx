// A pushed screen's scroll edge, the same as Settings: the system bar's own material and hairline
// fade in as soon as anything is under it, with iOS's soft edge effect off.
import { useHeaderHeight } from 'expo-router/react-navigation';
import type { ReactElement, ReactNode } from 'react';
import { StyleSheet, type RefreshControlProps, type TextStyle } from 'react-native';
import Animated, { interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useColors } from './theme.ts';
import { NO_SYSTEM_EDGES, type as text, useScrollEdgeFeed } from './ds/index.ts';
import { hasGlass } from './Glass.tsx';
import { usePagePadding } from './usePagePadding.ts';

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

/** The pushed screen's page: side insets, Stack header options by the caller. */
export function PushedScroll({ scroll, refreshControl, children }: { scroll: ReturnType<typeof usePushedScroll>; refreshControl?: ReactElement<RefreshControlProps>; children: ReactNode }) {
  const colors = useColors();
  const page = usePagePadding();
  return (
    <Animated.ScrollView onScroll={scroll.onScroll} onLayout={scroll.edge.onLayout} onContentSizeChange={scroll.edge.onContentSizeChange} scrollEventThrottle={16} style={[styles.scroll, { backgroundColor: colors.background }]} contentContainerStyle={page} contentInsetAdjustmentBehavior="automatic" refreshControl={refreshControl}>
      {children}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  title: { maxWidth: 240 },
});
