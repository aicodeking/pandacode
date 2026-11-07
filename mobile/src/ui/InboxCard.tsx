// The pieces of a section's card for the virtualised inbox and sidebar lists: each list item draws
// one slice (head, or a row inside the inner card), so a section is never one giant view. Also the
// banners, the computer filter chip and the first-load skeleton they share.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming, ZoomIn } from 'react-native-reanimated';
import type { SectionId } from '../store/inbox.ts';
import { useColors } from './theme.ts';
import { AnimatedNumber, Banner, Chevron, Chip, crossFadeIn, crossFadeOut, EXIT_MS, geometry, PressScale, Skeleton, springs, type } from './ds/index.ts';

const TITLES: Record<SectionId, string> = { bots: 'Bots', running: 'Running', needs: 'Needs you', recent: 'Recent', unsent: 'Unsent', snoozed: 'Snoozed', settled: 'Settled' };
const RETRY = 'Retry';
/** Rows wait this long to light up, so starting a scroll doesn't flinch them. */
export const ROW_PRESS_DELAY_MS = 90;
const BUMP_SCALE = 1.22;
const FLASH_IN_MS = 180;
const FLASH_OUT_MS = 700;
/** Beyond about a row's height a cell is moving, not being nudged by a neighbour. */
const FAR_MOVE = 96;
const FAR_FADE = 0.3;

const LEAVE_TRAVEL = 6;
/** How far a slice's clipped shadow may reach past its edges, and how far its box runs on under a neighbour. */
const SHADOW_REACH = 12;
const SHADOW_RUN = 40;

type Entering = ComponentProps<typeof Animated.View>['entering'];

/**
 * A list cell that travels to its new place on a transform spring when the list reorders; one going
 * far also fades up, so the eye follows it. Not Reanimated's itemLayoutAnimation: that remounts a
 * cell's subtree, and the native view behind Link.Menu then drops its child, leaving rows blank.
 */
export function TravelCell({ onLayout, style, children }: { onLayout?: (event: LayoutChangeEvent) => void; style: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduced = useReducedMotion();
  const placed = useRef<number | null>(null);
  const shift = useSharedValue(0);
  const fade = useSharedValue(1);
  const measure = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.y;
    const before = placed.current;
    placed.current = next;
    onLayout?.(event);
    if (before === null || before === next || reduced) return;
    shift.set(shift.get() + before - next);
    shift.set(withSpring(0, springs.smooth));
    if (Math.abs(before - next) > FAR_MOVE) {
      fade.set(FAR_FADE);
      fade.set(withTiming(1, { duration: FLASH_OUT_MS / 2 }));
    }
  };
  const moving = useAnimatedStyle(() => ({ opacity: fade.get(), transform: [{ translateY: shift.get() }] }));
  return <Animated.View onLayout={measure} style={[style, moving]}>{children}</Animated.View>;
}

/**
 * Which folded sections show their rows. Closing keeps them listed for the slices' fade (`closing`),
 * since rows under Link.Menu can't use `exiting`; then they leave the data and TravelCell closes the gap.
 */
export function useFolds() {
  const reduced = useReducedMotion();
  const [folds, setFolds] = useState<Partial<Record<SectionId, 'open' | 'closing'>>>({});
  const timer = useRef<Partial<Record<SectionId, ReturnType<typeof setTimeout>>>>({});
  useEffect(() => {
    const timers = timer.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);
  const set = (section: SectionId, value?: 'open' | 'closing') => setFolds(now => ({ ...now, [section]: value }));
  const toggle = (section: SectionId) => {
    clearTimeout(timer.current[section]);
    if (folds[section] !== 'open') return set(section, 'open');
    if (reduced) return set(section);
    set(section, 'closing');
    timer.current[section] = setTimeout(() => set(section), EXIT_MS);
    return undefined;
  };
  const shown = Object.fromEntries(Object.entries(folds).map(([section, value]) => [section, !!value]));
  return { shown, toggle, closing: (section: SectionId) => folds[section] === 'closing' };
}

/**
 * The outer card's shadow for one slice. An outset shadow never paints inside its own box, and the
 * clip stops it at the slice's open ends, so it can't fall on the neighbouring slice; the box runs on
 * past those ends, so the sides stay even all the way down the card.
 */
function SliceShadow({ top, bottom }: { top?: boolean; bottom?: boolean }) {
  const { shadowCard } = useColors();
  if (!shadowCard) return null;
  const box = {
    boxShadow: shadowCard,
    top: top ? SHADOW_REACH - edge : -SHADOW_RUN,
    bottom: bottom ? SHADOW_REACH - edge : -SHADOW_RUN,
    borderTopLeftRadius: top ? geometry.cardRadius : 0, borderTopRightRadius: top ? geometry.cardRadius : 0,
    borderBottomLeftRadius: bottom ? geometry.cardRadius : 0, borderBottomRightRadius: bottom ? geometry.cardRadius : 0,
  };
  return (
    <View pointerEvents="none" style={[styles.shadowClip, { top: top ? -SHADOW_REACH : 0, bottom: bottom ? -SHADOW_REACH : 0 }]}>
      <View style={[styles.shadowBox, box]} />
    </View>
  );
}

/** The count, with a tiny bump when it changes (not on mount, not with Reduce Motion). */
function Count({ value, color }: { value: number; color: string }) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const before = useRef(value);
  useEffect(() => {
    if (before.current !== value && !reduced) scale.set(withSequence(withSpring(BUMP_SCALE, springs.press), withSpring(1, springs.snappy)));
    before.current = value;
  }, [value, reduced, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return <Animated.View style={style}><AnimatedNumber value={value} style={[type.subhead, { color }]} /></Animated.View>;
}

/** A section's head: the top of its outer card, or all of it while folded. `open` undefined: doesn't fold. */
export function SectionHead({ section, count, open, computer, onToggle, entering }: { section: SectionId; count: number; open?: boolean; computer?: string; onToggle?: () => void; entering?: Entering }) {
  const colors = useColors();
  const closed = open === false;
  const rounding = useSharedValue(closed ? 1 : 0);
  useEffect(() => { rounding.set(withSpring(closed ? 1 : 0, springs.snappy)); }, [closed, rounding]);
  const corners = useAnimatedStyle(() => ({ borderBottomLeftRadius: rounding.get() * geometry.cardRadius, borderBottomRightRadius: rounding.get() * geometry.cardRadius }));
  const body = (
    <>
      {/* The computer reads as where, joined to the title; the count keeps the right edge. */}
      <Text numberOfLines={1} style={[type.subhead, styles.headTitle, { color: colors.muted }]}>
        {TITLES[section]}
        {!!computer && <Text style={{ color: colors.faint }}>{` · ${computer}`}</Text>}
      </Text>
      <Count value={count} color={colors.faint} />
      {open !== undefined && <Chevron expanded={open} />}
    </>
  );
  const label = [TITLES[section], count, computer].filter(v => v !== undefined).join(', ');
  return (
    <Animated.View entering={entering ?? crossFadeIn} style={[styles.head, closed && styles.headClosed, { backgroundColor: colors.card, borderColor: colors.border }, corners]}>
      <SliceShadow top bottom={closed} />
      {open === undefined
        ? <View accessible accessibilityRole="header" accessibilityLabel={label} style={styles.headRow}>{body}</View>
        : <PressScale scale={1} haptic="selection" onPress={onToggle} unstable_pressDelay={ROW_PRESS_DELAY_MS} accessibilityLabel={label} accessibilityState={{ expanded: open }} style={styles.headRow}>{body}</PressScale>}
    </Animated.View>
  );
}

/** One row's slice of the outer and inner cards. Clips, so swipe actions stay inside the inner card.
 * `attention`: a row arriving under Needs you glows once (the same cell, moved here from another section).
 * `leaving`: its section is folding, so it fades up before it leaves the list. */
export function CardSlice({ first, last, attention, leaving, entering, children }: { first: boolean; last: boolean; attention?: boolean; leaving?: boolean; entering?: Entering; children: ReactNode }) {
  const colors = useColors();
  const glow = useSharedValue(0);
  const present = useSharedValue(1);
  const was = useRef(attention);
  useEffect(() => {
    if (attention && !was.current) glow.set(withSequence(withTiming(1, { duration: FLASH_IN_MS }), withTiming(0, { duration: FLASH_OUT_MS })));
    was.current = attention;
  }, [attention, glow]);
  useEffect(() => { present.set(withTiming(leaving ? 0 : 1, { duration: EXIT_MS })); }, [leaving, present]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.get() }));
  const leaveStyle = useAnimatedStyle(() => ({ opacity: present.get(), transform: [{ translateY: (present.get() - 1) * LEAVE_TRAVEL }] }));
  return (
    <Animated.View style={leaveStyle}>
      <Animated.View entering={entering ?? crossFadeIn} style={[styles.outer, last && styles.outerLast, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SliceShadow bottom={last} />
        <View style={[styles.inner, first && styles.innerFirst, last && styles.innerLast, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}>
          {children}
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.warningFill }, glowStyle]} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

export interface InboxNoticesProps {
  connected: boolean;
  updating: boolean;
  /** Listed tasks are showing, so an all-offline account needs saying here. */
  hasRows: boolean;
  hosts: readonly { name: string; online: boolean }[];
  problems: readonly string[];
  retry: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Connection and load state over the list. */
export function InboxNotices({ connected, updating, hasRows, hosts, problems, retry, style }: InboxNoticesProps) {
  const offline = hosts.filter(h => !h.online).map(h => h.name);
  const allOffline = connected && hasRows && hosts.length > 0 && offline.length === hosts.length;
  return (
    <View style={[styles.notices, style]}>
      <Banner visible={!connected} title="Connecting…" body={hasRows ? 'Showing what this phone last saw.' : undefined} icon={{ ios: 'wifi.exclamationmark', android: 'wifi_off' }} />
      <Banner visible={updating} title="Updating…" tone="info" icon={{ ios: 'arrow.clockwise', android: 'refresh' }} />
      <Banner visible={allOffline} title={`${offline.join(', ')} ${offline.length > 1 ? 'are' : 'is'} offline`} body="These tasks are from when it was last seen." icon={{ ios: 'moon.zzz.fill', android: 'bedtime' }} />
      {problems.map(problem => <Banner key={problem} visible title="Couldn't refresh" body={problem} tone="danger" action={{ label: RETRY, onPress: retry }} />)}
    </View>
  );
}

const CHIP_IN = ZoomIn.springify().mass(springs.smooth.mass).stiffness(springs.smooth.stiffness).damping(springs.smooth.damping);

/** "Only this computer", tap to go back to all of them. */
export function ComputerFilter({ name, onClear }: { name: string; onClear: () => void }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? FadeIn : CHIP_IN} exiting={crossFadeOut} style={styles.filter}>
      <Chip label={name} icon={{ ios: 'xmark.circle.fill', android: 'cancel' }} onPress={onClear} accessibilityLabel={`Showing ${name} only. Clear filter`} />
    </Animated.View>
  );
}

/** First load: a card of placeholder rows. */
export function InboxSkeleton({ rows = 4 }: { rows?: number }) {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel="Loading tasks" style={[styles.skeleton, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Skeleton width={72} style={styles.skeletonHead} />
      <View style={[styles.skeletonInner, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}>
        {Array.from({ length: rows }, (_, i) => (
          <View key={i} style={styles.skeletonRow}>
            <Skeleton width={28} height={28} radius={8} />
            <View style={styles.skeletonText}>
              <Skeleton width="70%" />
              <Skeleton width="45%" height={12} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const edge = geometry.hairline;
const pad = geometry.cardPadding;
const styles = StyleSheet.create({
  head: { borderLeftWidth: edge, borderRightWidth: edge, borderTopWidth: edge, borderTopLeftRadius: geometry.cardRadius, borderTopRightRadius: geometry.cardRadius, borderCurve: 'continuous' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: pad + 10, paddingTop: 8, paddingBottom: 7 },
  headClosed: { borderBottomWidth: edge, marginBottom: geometry.sectionGap },
  shadowClip: { position: 'absolute', left: -SHADOW_REACH, right: -SHADOW_REACH, overflow: 'hidden' },
  shadowBox: { position: 'absolute', left: SHADOW_REACH - edge, right: SHADOW_REACH - edge, borderCurve: 'continuous' },
  headTitle: { flex: 1 },
  outer: { paddingHorizontal: pad, borderLeftWidth: edge, borderRightWidth: edge, borderCurve: 'continuous' },
  outerLast: { paddingBottom: pad, borderBottomWidth: edge, borderBottomLeftRadius: geometry.cardRadius, borderBottomRightRadius: geometry.cardRadius, marginBottom: geometry.sectionGap },
  inner: { overflow: 'hidden', borderLeftWidth: edge, borderRightWidth: edge, borderCurve: 'continuous' },
  innerFirst: { borderTopWidth: edge, borderTopLeftRadius: geometry.innerRadius, borderTopRightRadius: geometry.innerRadius, paddingTop: 2 },
  innerLast: { borderBottomWidth: edge, borderBottomLeftRadius: geometry.innerRadius, borderBottomRightRadius: geometry.innerRadius, paddingBottom: 2 },
  notices: { gap: 8 },
  filter: { alignSelf: 'flex-start', marginBottom: 12 },
  skeleton: { padding: pad, borderWidth: edge, borderRadius: geometry.cardRadius, borderCurve: 'continuous' },
  skeletonHead: { marginHorizontal: 10, marginTop: 8, marginBottom: 12 },
  skeletonInner: { borderWidth: edge, borderRadius: geometry.innerRadius, borderCurve: 'continuous', paddingVertical: 4 },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  skeletonText: { flex: 1, gap: 8 },
});
