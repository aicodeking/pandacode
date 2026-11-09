// One file's diff in an inner card: a line-number gutter and hunk headers that hold still while long
// lines scroll sideways, hunk headers sticky at the top, a scroll thumb that's always there when lines
// run wide. Rows are virtualized at a fixed height. The surface is solid so pinned rows can cover code.
import { memo, useMemo, useRef, useState, type ComponentProps } from 'react';
import { FlatList, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { Easing, Keyframe, ReduceMotion, useAnimatedScrollHandler, useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { numberedLines, type NumberedLine } from '../store/diff.ts';
import { Card, CHROME_FONT_SCALE, geometry, InnerCard, PressScale, type as text } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { useColors, type Colors } from './theme.ts';

const LINE = text.code.lineHeight;
/** Menlo's advance at 13 pt; a little over, so the longest line never clips. */
const CHAR = 7.9;
const PAD = 10;
const THUMB_HEIGHT = 3;
const MIN_DIGITS = 2;
const LIST_END = 12;
const HUNK_BAR = 40;
const HUNK_BUTTON = 30;
const FLASH_OPACITY = 0.3;
const FLASH_MS = 500;

type Pin = ComponentProps<typeof Animated.View>['style'];

const fills = (colors: Colors) => ({ add: colors.successFill, del: colors.dangerFill, hunk: colors.infoFill, meta: undefined, context: undefined });

/** A hunk you just jumped to lights up once. */
const FLASH = new Keyframe({ from: { opacity: FLASH_OPACITY }, to: { opacity: 0, easing: Easing.out(Easing.cubic) } }).duration(FLASH_MS).reduceMotion(ReduceMotion.Never);

const Line = memo(function Line({ item, height, gutter, pin, surface, colors, flash }: { item: NumberedLine; height: number; gutter: number; pin: Pin; surface: string; colors: Colors; flash: number }) {
  const fill = fills(colors)[item.kind];
  const ink = item.kind === 'meta' || item.kind === 'hunk' ? colors.muted : colors.text;
  if (item.kind === 'hunk') {
    // Sticky: solid underneath, so the code scrolling up doesn't show through.
    return (
      <View style={{ height, backgroundColor: surface }}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
        {flash > 0 && <Animated.View key={flash} entering={FLASH} pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.info, opacity: 0 }]} />}
        <Animated.View style={[styles.hunk, { height, paddingLeft: PAD }, pin]}>
          <Text numberOfLines={1} style={[text.code, { color: ink }]}>{item.text}</Text>
        </Animated.View>
      </View>
    );
  }
  const number = item.newLine ?? item.oldLine;
  return (
    <View style={{ height, backgroundColor: fill, paddingLeft: gutter + PAD, justifyContent: 'center' }}>
      <Text numberOfLines={1} style={[text.code, { color: ink }]}>{item.text || ' '}</Text>
      <Animated.View style={[styles.gutter, { width: gutter, backgroundColor: surface }, pin]}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
        {number !== undefined && <Text accessibilityLabel={`Line ${number}`} numberOfLines={1} style={[text.code, styles.number, { color: colors.faint }]}>{number}</Text>}
      </Animated.View>
    </View>
  );
});

/** With more than one hunk: where you are, and a jump either way. */
function HunkBar({ at, total, onJump }: { at: number; total: number; onJump: (by: number) => void }) {
  const colors = useColors();
  return (
    <View style={styles.hunkBar}>
      <Text numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_SCALE} accessibilityLiveRegion="polite" style={[text.footnote, styles.hunkLabel, { color: colors.muted }]}>{`Change ${at + 1} of ${total}`}</Text>
      <PressScale onPress={() => onJump(-1)} disabled={at <= 0} haptic="selection" hitSlop={6} accessibilityLabel="Previous change" style={[styles.hunkButton, at <= 0 && styles.off, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Icon ios="chevron.up" android="expand_less" size={13} color={colors.text} />
      </PressScale>
      <PressScale onPress={() => onJump(1)} disabled={at >= total - 1} haptic="selection" hitSlop={6} accessibilityLabel="Next change" style={[styles.hunkButton, at >= total - 1 && styles.off, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Icon ios="chevron.down" android="expand_more" size={13} color={colors.text} />
      </PressScale>
    </View>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const reduced = useReducedMotion();
  const lines = useMemo(() => numberedLines(diff), [diff]);
  const [viewport, setViewport] = useState(0);
  const x = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(event => { x.set(event.contentOffset.x); });
  const pin = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  // Text grows with Dynamic Type, so rows, the gutter and the offsets do too.
  const height = Math.ceil(LINE * fontScale);
  const char = CHAR * fontScale;
  const digits = useMemo(() => Math.max(MIN_DIGITS, ...lines.map(l => String(l.newLine ?? l.oldLine ?? '').length)), [lines]);
  const gutter = Math.ceil(digits * char + PAD);
  const longest = useMemo(() => lines.reduce((max, l) => Math.max(max, l.text.length), 0), [lines]);
  const wide = Math.max(viewport, Math.ceil(longest * char + gutter + PAD * 2));
  const sticky = useMemo(() => lines.flatMap((l, i) => (l.kind === 'hunk' ? [i] : [])), [lines]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: wide > 0 ? (x.get() / wide) * viewport : 0 }] }));
  const measure = (event: LayoutChangeEvent) => setViewport(event.nativeEvent.layout.width);
  const list = useRef<FlatList<NumberedLine>>(null);
  const [hunk, setHunk] = useState(0);
  const [flash, setFlash] = useState({ line: -1, count: 0 });
  const several = sticky.length > 1;
  const follow = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!several) return;
    const top = Math.floor(event.nativeEvent.contentOffset.y / height);
    setHunk(Math.max(0, sticky.findLastIndex(line => line <= top)));
  };
  const jump = (by: number) => {
    const line = sticky[Math.min(sticky.length - 1, Math.max(0, hunk + by))];
    list.current?.scrollToIndex({ index: line, animated: !reduced, viewPosition: 0 });
    setFlash(f => ({ line, count: f.count + 1 }));
  };
  return (
    <Card style={[styles.card, { height: lines.length * height + LIST_END + THUMB_HEIGHT + geometry.cardPadding * 2 + geometry.hairline * 4 + (several ? HUNK_BAR : 0) }]}>
      <InnerCard style={[styles.inner, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} onLayout={measure}>
        {viewport > 0 && (
          <Animated.ScrollView horizontal onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ width: wide }} directionalLockEnabled showsHorizontalScrollIndicator={false}>
            <FlatList ref={list} onScroll={follow} scrollEventThrottle={64} data={lines} keyExtractor={(_, i) => String(i)} style={{ width: wide }} stickyHeaderIndices={sticky}
              extraData={flash} renderItem={({ item, index }) => <Line item={item} height={height} gutter={gutter} pin={pin} surface={colors.cardInner} colors={colors} flash={flash.line === index ? flash.count : 0} />}
              contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}
              getItemLayout={(_, index) => ({ length: height, offset: height * index, index })} initialNumToRender={60} windowSize={7} />
          </Animated.ScrollView>
        )}
        {wide > viewport && viewport > 0 && (
          <View pointerEvents="none" style={[styles.track, { backgroundColor: colors.fill }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Animated.View style={[styles.thumb, { width: (viewport / wide) * viewport, backgroundColor: colors.glyphFaint }, thumb]} />
          </View>
        )}
      </InnerCard>
      {several && <HunkBar at={hunk} total={sticky.length} onJump={jump} />}
    </Card>
  );
}

const styles = StyleSheet.create({
  // As tall as the diff, giving way to the screen: a short diff doesn't sit in a tall empty panel.
  card: { flexShrink: 1 },
  inner: { flex: 1, overflow: 'hidden', paddingVertical: 0 },
  list: { paddingBottom: LIST_END },
  hunkBar: { flexDirection: 'row', alignItems: 'center', gap: 6, height: HUNK_BAR, paddingHorizontal: 6, paddingTop: 6 },
  hunkLabel: { flex: 1 },
  hunkButton: { width: HUNK_BUTTON, height: HUNK_BUTTON, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderCurve: 'continuous', borderWidth: geometry.hairline },
  off: { opacity: 0.4 },
  hunk: { justifyContent: 'center' },
  gutter: { position: 'absolute', left: 0, top: 0, bottom: 0, justifyContent: 'center' },
  number: { textAlign: 'right', paddingRight: PAD / 2 },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: THUMB_HEIGHT },
  thumb: { height: THUMB_HEIGHT, borderRadius: THUMB_HEIGHT / 2 },
});
