// The app's one scroll edge, after iOS's scroll edge effect: nothing at rest, then the page tone
// arriving over the first few points of scroll, solid behind the bar and easing to nothing past it.
// iOS's own effect only blurs, so cards would ghost through the title. The bottom wash under the tab bar shows only
// while content reaches under it. A screen feeds its scroll through `useScrollEdge()`; the edges find it
// by route. Older iOS and Android have solid bars and draw none of this.
import { useRoute } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { makeMutable, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hasGlass } from '../Glass.tsx';
import { useColors } from '../theme.ts';
import { edgeGradient, edgeProgress } from './palette.ts';

/** A native bar's content height, under the status bar. */
const NAV_BAR = 44;
/** The tab bar's content height, above the home indicator. */
const TAB_BAR = 49;
const FADE = { top: 36, bottom: 16 };
const OPACITY = { top: 1, bottom: 0.96 };
/** How far into the bar the tone stays solid before it starts to ease. */
const SOLID = { top: 0.85, bottom: 0.45 };

interface Edge { top: SharedValue<number>; bottom: SharedValue<number> }
// One pair per route key, held by its mounted edges and dropped when the last one unmounts.
const edges = new Map<string, Edge>();
const holders = new Map<string, number>();
function edgeFor(key: string): Edge {
  let edge = edges.get(key);
  if (!edge) {
    edge = { top: makeMutable(0), bottom: makeMutable(0) };
    edges.set(key, edge);
  }
  return edge;
}

/** For a screen with its own scroll handler: `apply(y, contentHeight, frameHeight)` from a worklet, and the layout props. */
export function useScrollEdgeFeed() {
  const edge = edgeFor(useRoute().key);
  // A tab root without a header (Computers, Settings) rests just under the status bar.
  const { top, bottom } = useSafeAreaInsets();
  const header = useHeaderHeight() || top;
  const bar = bottom + TAB_BAR;
  const headerNow = useSharedValue(header);
  const last = useSharedValue({ y: -header, content: 0, frame: 0 });
  useEffect(() => { headerNow.set(header); }, [header, headerNow]);
  const apply = useCallback((y: number, content: number, frame: number) => {
    'worklet';
    last.set({ y, content, frame });
    // Large titles: the header shrinks as the page scrolls, so the distance under it follows both.
    edge.top.set(edgeProgress(y + headerNow.get()));
    edge.bottom.set(frame > 0 ? edgeProgress(content - (y + frame - bar)) : 0);
  }, [edge, headerNow, last, bar]);
  // Before any scroll: the page at rest, measured as it lays out.
  const onContentSizeChange = useCallback((_width: number, height: number) => { const at = last.get(); apply(at.y, height, at.frame); }, [apply, last]);
  const onLayout = useCallback((event: LayoutChangeEvent) => { const at = last.get(); apply(at.y, at.content, event.nativeEvent.layout.height); }, [apply, last]);
  return { apply, onContentSizeChange, onLayout };
}

/**
 * For the screen's scroll view: spread the result on it. Pass `js` for a list that can't be animated
 * (one with its own CellRendererComponent); its edge then follows on the JS thread.
 */
export function useScrollEdge({ js = false }: { js?: boolean } = {}) {
  const { apply, onContentSizeChange, onLayout } = useScrollEdgeFeed();
  const onWorklet = useAnimatedScrollHandler(event => { apply(event.contentOffset.y, event.contentSize.height, event.layoutMeasurement.height); });
  const onJs = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    apply(contentOffset.y, contentSize.height, layoutMeasurement.height);
  }, [apply]);
  return { onScroll: js ? onJs : onWorklet, onContentSizeChange, onLayout, scrollEventThrottle: 16 };
}

export interface ScrollEdgeProps {
  edge?: 'top' | 'bottom';
  /** A fixed bar height from the screen's edge: the edge then stays on, unrelated to scroll (the thread's cap). */
  bar?: number;
}

function Fade({ edge, covered, opacity, solid, past, progress }: { edge: 'top' | 'bottom'; covered: number; opacity: number; solid: number; past: number; progress?: SharedValue<number> }) {
  const { page } = useColors();
  const height = covered + past;
  const shown = useAnimatedStyle(() => ({ opacity: progress ? progress.get() : 1 }));
  const backgroundImage = edgeGradient(edge === 'top' ? 'to bottom' : 'to top', page, opacity, (covered * solid) / height);
  return <Animated.View pointerEvents="none" accessible={false} style={[styles[edge], { height, experimental_backgroundImage: backgroundImage }, shown]} />;
}

function RouteEdge({ edge, covered }: { edge: 'top' | 'bottom'; covered: number }) {
  const key = useRoute().key;
  const progress = edgeFor(key)[edge];
  const keyRef = useRef(key);
  useEffect(() => {
    const held = keyRef.current;
    holders.set(held, (holders.get(held) ?? 0) + 1);
    return () => {
      const left = (holders.get(held) ?? 1) - 1;
      if (left > 0) { holders.set(held, left); return; }
      holders.delete(held);
      edges.delete(held);
    };
  }, []);
  return <Fade edge={edge} covered={covered} opacity={OPACITY[edge]} solid={SOLID[edge]} past={FADE[edge]} progress={progress} />;
}

export function ScrollEdge({ edge = 'top', bar, headerless = false }: ScrollEdgeProps & { headerless?: boolean }) {
  const insets = useSafeAreaInsets();
  if (!hasGlass) return null;
  if (bar != null) return <Fade edge={edge} covered={bar} opacity={OPACITY[edge]} solid={SOLID[edge]} past={FADE[edge]} />;
  return <RouteEdge edge={edge} covered={edge === 'top' ? insets.top + (headerless ? 0 : NAV_BAR) : insets.bottom + TAB_BAR} />;
}

export const NO_SYSTEM_EDGES = { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' } as const;

/** For a tab's Stack as `screenLayout`: the content, then both edges, under the native bars. */
export function TabEdges({ children, options }: { children: ReactNode; options?: { headerShown?: boolean } }): ReactElement {
  return <View style={styles.fill}>{children}<ScrollEdge headerless={options?.headerShown === false} /><ScrollEdge edge="bottom" /></View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
});
