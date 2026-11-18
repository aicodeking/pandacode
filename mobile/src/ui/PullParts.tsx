// The pull request screen's parts (src/app/pull.tsx): head, summary card, merge control, description,
// commits and timeline, all as nested cards.
import { SymbolView } from 'expo-symbols';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import type { MergeMethod, PullCheck, PullComment, PullCommit, PullDetail } from '../connect/types.ts';
import { checksLine, conflictsLine, reviewLine, type SummaryLine, type SummaryTone } from '../store/pull-summary.ts';
import { useColors } from './theme.ts';
import { BranchChip, Card, CardSection, Chevron, Chip, CHROME_FONT_SCALE, Collapse, crossFadeIn, crossFadeOut, geometry, InnerCard, PressScale, Row, springs, type as text, type IconName, type Tone, useMotion, useStagger } from './ds/index.ts';
import { Counts } from './FileRow.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { Menu } from './Menu.tsx';
import { ago } from './status.tsx';
import { useIconSize } from './usePagePadding.ts';

export const METHODS: { method: MergeMethod; label: string; menu: string; verb: string }[] = [
  { method: 'squash', label: 'Squash and merge', menu: 'Squash and merge', verb: 'Squash and merge' },
  { method: 'merge', label: 'Create a merge commit', menu: 'Merge commit', verb: 'Merge' },
  { method: 'rebase', label: 'Rebase and merge', menu: 'Rebase and merge', verb: 'Rebase and merge' },
];

const REVIEW: Record<string, string> = { approved: 'approved', changes_requested: 'requested changes', review_required: 'requested a review', commented: 'commented' };
const AVATAR = 24;
/** Between one summary mark and the next as they arrive. */
const TICK_MS = 70;
/** The first marks wait for the push to bring the row on screen. */
const ARRIVAL_MS = 300;
const DRAW = { duration: 260, easing: Easing.out(Easing.cubic) };
const POP_FROM = 0.6;
/** How far the merged note must open before its label fades in. */
const LABEL_AFTER = 0.55;
/** The merge button's edge beside the method menu: its width plus the gap. */
const MENU_ROOM = geometry.rowHeight + 6;
const MENU_SHRINK = 0.2;
/** Label gone by busy 1/2, spinner in from there. */
const CONTENT_FADE = 2;
const LONG_LABEL_SCALE = 1.3;

const TONE_ICONS: Record<SummaryTone, IconName> = {
  success: { ios: 'checkmark.circle', android: 'check_circle' },
  danger: { ios: 'xmark.circle', android: 'cancel' },
  warning: { ios: 'clock', android: 'schedule' },
  neutral: { ios: 'minus.circle', android: 'remove_circle' },
};

const toneOf = (state: PullCheck['state']): SummaryTone => (state === 'success' ? 'success' : state === 'failure' ? 'danger' : state === 'pending' ? 'warning' : 'neutral');

function age(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return '';
  const label = ago(at);
  return label === 'now' ? 'just now' : `${label} ago`;
}

function stateChip(pull: PullDetail): { label: string; tone?: Tone } {
  if (pull.state === 'merged' || pull.mergedAt) return { label: 'Merged', tone: 'team' };
  if (pull.state === 'closed') return { label: 'Closed', tone: 'danger' };
  if (pull.state === 'draft') return { label: 'Draft' };
  return { label: 'Open', tone: 'success' };
}

function Avatar({ name }: { name: string }) {
  const colors = useColors();
  const size = useIconSize(AVATAR);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.teamFill }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[text.footnoteMedium, { color: colors.team }]}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export function PullHead({ pull, onTitleLayout }: { pull: PullDetail; onTitleLayout?: (event: LayoutChangeEvent) => void }) {
  const colors = useColors();
  const chip = stateChip(pull);
  return (
    <View style={styles.head}>
      <Text selectable accessibilityRole="header" onLayout={onTitleLayout} style={[text.title3, { color: colors.text }]}>{pull.title}</Text>
      <View style={[styles.line, styles.wrap]}>
        <Avatar name={pull.author} />
        <Text numberOfLines={1} style={[text.subhead, styles.author, { color: colors.text }]}>{pull.author}</Text>
        <Text numberOfLines={1} style={[text.subhead, styles.age, { color: colors.muted }]}>{[`#${pull.number}`, age(pull.createdAt)].filter(Boolean).join(' · ')}</Text>
        <LayoutAnimationConfig skipEntering>
          <Animated.View key={chip.label} entering={crossFadeIn} exiting={crossFadeOut} style={styles.chip}>
            <Chip label={chip.label} tone={chip.tone} />
          </Animated.View>
        </LayoutAnimationConfig>
      </View>
      <View style={[styles.line, styles.wrap]} accessible accessibilityLabel={`Into ${pull.base} from ${pull.head}`}>
        <BranchChip branch={pull.base} style={styles.base} />
        <Icon ios="arrow.left" android="arrow_back" size={12} color={colors.faint} />
        <BranchChip branch={pull.head} style={styles.branch} />
        <View style={styles.gap} />
        <Counts additions={pull.additions} deletions={pull.deletions} />
      </View>
      {pull.labels.length > 0 && <View style={styles.labels}>{pull.labels.map(label => <Chip key={label} label={label} />)}</View>}
    </View>
  );
}

/** A summary mark. It arrives once, `delay` after its row: a check draws on from the left, the rest
 * pop in, and a new state plays again (the key follows the tone). Reduce Motion just shows it. */
function SummaryIcon({ tone, size = 20, delay = 0 }: { tone: SummaryTone; size?: number; delay?: number }) {
  const scaled = useIconSize(size);
  return <ToneMark key={tone} tone={tone} size={scaled} delay={delay} />;
}

function ToneMark({ tone, size, delay }: { tone: SummaryTone; size: number; delay: number }) {
  const colors = useColors();
  const { reduced } = useMotion();
  const drawn = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    drawn.set(withDelay(delay, tone === 'success' ? withTiming(1, DRAW) : withSpring(1, springs.momentum)));
  }, [delay, drawn, reduced, tone]);
  const wipe = useAnimatedStyle(() => (tone === 'success'
    ? { width: size * drawn.get() }
    : { width: size, opacity: Math.min(1, drawn.get() * 2), transform: [{ scale: POP_FROM + (1 - POP_FROM) * drawn.get() }] }));
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={[styles.mark, { height: size }, wipe]}>
        <View style={{ width: size }}>
          <Icon {...TONE_ICONS[tone]} size={size} color={tone === 'neutral' ? colors.muted : colors[tone]} />
        </View>
      </Animated.View>
    </View>
  );
}

function Meta({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <Text numberOfLines={1} style={[text.subhead, styles.meta, { color: colors.faint }]}>{children}</Text>;
}

function ChecksRows({ line, checks }: { line: SummaryLine; checks: PullCheck[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row title={line.title} leading={<SummaryIcon tone={line.tone} delay={ARRIVAL_MS} />} onPress={() => setOpen(o => !o)} haptic="selection"
        accessibilityState={{ expanded: open }} accessibilityLabel={`${line.title}, ${line.meta}`}
        trailing={<View style={styles.trail}><Meta>{line.meta}</Meta><Chevron expanded={open} /></View>} />
      <Collapse expanded={open}>
        {checks.map((check, i) => {
          const link = /^https:\/\//.test(check.url) ? () => void Linking.openURL(check.url) : undefined;
          return <Row key={`${i}/${check.name}`} title={check.name} style={styles.check} leading={<SummaryIcon tone={toneOf(check.state)} size={16} delay={i * TICK_MS} />} onPress={link} chevron={!!link} />;
        })}
      </Collapse>
    </>
  );
}

/** The state after a merge. When it just happened here it opens out of the merge button's spinner circle, the mark bouncing in. */
function MergedNote({ base, justMerged }: { base: string; justMerged: boolean }) {
  const colors = useColors();
  const { reduced } = useMotion();
  const full = useSharedValue(0);
  const open = useSharedValue(justMerged ? 0 : 1);
  const measure = (event: LayoutChangeEvent) => {
    full.set(event.nativeEvent.layout.width);
    if (justMerged && open.get() === 0) open.set(withSpring(1, springs.momentum));
  };
  const frame = useAnimatedStyle(() => {
    const at = Math.min(1, open.get());
    return { borderRadius: geometry.rowHeight / 2 + (geometry.controlRadius - geometry.rowHeight / 2) * at, ...(full.get() > 0 ? { width: geometry.rowHeight + (full.get() - geometry.rowHeight) * at } : justMerged ? { width: geometry.rowHeight } : {}) };
  });
  const label = useAnimatedStyle(() => ({ opacity: Math.max(0, Math.min(1, (open.get() - LABEL_AFTER) / (1 - LABEL_AFTER))) }));
  return (
    <View onLayout={measure} style={styles.mergedTrack}>
      <Animated.View accessible accessibilityLiveRegion="polite" accessibilityLabel={`Merged into ${base}`} style={[styles.merged, { backgroundColor: colors.teamFill }, frame]}>
        <SymbolView name={{ ios: 'checkmark.seal.fill', android: 'verified' }} size={18} tintColor={colors.team} animationSpec={justMerged && !reduced ? { effect: { type: 'bounce', direction: 'up' } } : undefined} />
        <Animated.Text numberOfLines={1} style={[text.calloutMedium, { color: colors.team }, label]}>{`Merged into ${base}`}</Animated.Text>
      </Animated.View>
    </View>
  );
}

export interface MergeControlProps { pull: PullDetail; method: MergeMethod; onMethod: (method: MergeMethod) => void; merging: boolean; onMerge: () => void }

/** The primary button narrows to a spinner circle while it merges; MergedNote opens out of that circle. */
function MergeControl({ pull, method, onMethod, merging, onMerge }: MergeControlProps) {
  const colors = useColors();
  const chosen = METHODS.find(m => m.method === method) ?? METHODS[0];
  // Past this size the full label would truncate beside the menu; VoiceOver still hears it.
  const { fontScale } = useWindowDimensions();
  const label = fontScale > LONG_LABEL_SCALE ? 'Merge' : chosen.label;
  const blocked = pull.mergeable === 'conflicting';
  const full = useSharedValue(0);
  const busy = useSharedValue(merging ? 1 : 0);
  useEffect(() => { busy.set(withSpring(merging ? 1 : 0, springs.smooth)); }, [merging, busy]);
  const sideMargin = () => {
    'worklet';
    return Math.max(0, (full.get() - geometry.rowHeight) / 2);
  };
  const button = useAnimatedStyle(() => ({
    marginLeft: sideMargin() * busy.get(),
    marginRight: MENU_ROOM + (sideMargin() - MENU_ROOM) * busy.get(),
  }));
  const face = useAnimatedStyle(() => ({ borderRadius: geometry.controlRadius + (geometry.rowHeight / 2 - geometry.controlRadius) * busy.get() }));
  const content = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - busy.get() * CONTENT_FADE) }));
  const spinner = useAnimatedStyle(() => ({ opacity: Math.max(0, busy.get() * CONTENT_FADE - 1) }));
  const menu = useAnimatedStyle(() => ({ opacity: 1 - busy.get(), transform: [{ scale: 1 - busy.get() * MENU_SHRINK }] }));
  return (
    <View style={styles.merge} onLayout={event => full.set(event.nativeEvent.layout.width)}>
      <Animated.View style={[styles.mergeButton, button]}>
        <PressScale onPress={onMerge} disabled={blocked || merging} accessibilityLabel={merging ? `${chosen.label}, merging` : chosen.label} accessibilityState={{ disabled: blocked || merging, busy: merging }}
          style={[styles.pressable, blocked && styles.blocked]}>
          <Animated.View style={[styles.primary, { backgroundColor: colors.primary, boxShadow: colors.shadowRaised }, face]}>
          <Animated.View style={[styles.primaryContent, content]}>
            <Icon ios="arrow.triangle.merge" android="merge" size={17} color={colors.onPrimary} />
            <Text numberOfLines={1} style={[text.calloutMedium, { color: colors.onPrimary }]}>{label}</Text>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.spinner, spinner]}><ActivityIndicator size="small" color={colors.onPrimary} /></Animated.View>
          </Animated.View>
        </PressScale>
      </Animated.View>
      <Animated.View pointerEvents={merging ? 'none' : 'auto'} style={[styles.menuSlot, menu]}>
        <Menu ios="chevron.down" android="expand_more" size={15} color={colors.text} label="Merge method"
          items={METHODS.map(m => ({ label: m.menu, checked: m.method === method, onPress: () => onMethod(m.method) }))}>
          {icon => <View style={[styles.methods, { backgroundColor: colors.raised, borderColor: colors.border, boxShadow: colors.shadowRaised }]}>{icon}</View>}
        </Menu>
      </Animated.View>
    </View>
  );
}

export function SummaryCard({ pull, justMerged, onReview, onCommits, ...merge }: Omit<MergeControlProps, 'pull'> & { pull: PullDetail; justMerged: boolean; onReview: () => void; onCommits: () => void }) {
  const open = pull.state === 'open';
  const merged = pull.state === 'merged' || !!pull.mergedAt;
  const checks = checksLine(pull.checks);
  const review = reviewLine(pull);
  const conflicts = open ? conflictsLine(pull, merge.method) : null;
  return (
    <CardSection footer={open || merged ? (
      <>
        {open && <MergeControl pull={pull} {...merge} />}
        {/* The store turns merged while the merge call is still finishing: `merging` is what's true at mount. */}
        {merged && <MergedNote base={pull.base} justMerged={justMerged || merge.merging} />}
      </>
    ) : undefined}>
      {checks && <ChecksRows line={checks} checks={pull.checks} />}
      {review && <Row title={review.title} leading={<SummaryIcon tone={review.tone} delay={ARRIVAL_MS + TICK_MS} />} chevron onPress={onReview} />}
      {conflicts && <Row title={conflicts.title} leading={<SummaryIcon tone={conflicts.tone} delay={ARRIVAL_MS + TICK_MS * 2} />} trailing={conflicts.meta} chevron onPress={onCommits} />}
      {!checks && !review && !conflicts && <Row title={merged ? 'Merged' : 'Closed'} leading={<SummaryIcon tone="neutral" />} />}
    </CardSection>
  );
}

export function OpenOnGitHub({ url }: { url: string }) {
  const colors = useColors();
  const web = /^https:\/\//.test(url);
  const iconSize = useIconSize(20);
  return (
    <Card>
      <InnerCard>
        <Row title="Open on GitHub" disabled={!web} onPress={() => void Linking.openURL(url)} accessibilityRole="link"
          leading={<Icon ios="safari" android="open_in_new" size={iconSize} color={colors.muted} />}
          trailing={<Icon ios="arrow.up.right" android="north_east" size={13} color={colors.glyphFaint} />} />
      </InnerCard>
    </Card>
  );
}

export function Description({ body }: { body: string }) {
  return <CardSection title="Description"><View style={styles.prose}><Markdown text={body} /></View></CardSection>;
}

export function Commits({ commits }: { commits: PullCommit[] }) {
  const colors = useColors();
  const enter = useStagger();
  return (
    <CardSection title="Commits" trailing={<Meta>{commits.length}</Meta>}>
      {commits.map((commit, i) => (
        <Animated.View key={commit.oid} entering={enter(i)} style={styles.commit}>
          <Text selectable style={[text.subhead, { color: colors.text }]} numberOfLines={2}>{commit.headline}</Text>
          <Text numberOfLines={1} style={[text.footnote, { color: colors.muted }]}>
            <Text style={text.code}>{commit.oid.slice(0, 7)}</Text>{[commit.author, age(commit.date)].filter(Boolean).map(part => ` · ${part}`).join('')}
          </Text>
        </Animated.View>
      ))}
    </CardSection>
  );
}

export function Timeline({ entries }: { entries: PullComment[] }) {
  const colors = useColors();
  const enter = useStagger();
  return (
    <Card style={styles.timeline}>
      {entries.map((entry, i) => (
        <Animated.View key={i} entering={enter(i)}>
        <InnerCard style={styles.prose}>
          <View style={styles.line}>
            <Avatar name={entry.author} />
            <Text numberOfLines={1} style={[text.subhead, styles.fill, { color: colors.muted }]}>
              <Text style={[text.subheadMedium, { color: colors.text }]}>{entry.author}</Text>
              {entry.kind === 'review' && entry.state ? ` ${REVIEW[entry.state.toLowerCase()] ?? entry.state.toLowerCase()}` : ''}
            </Text>
            <Text style={[text.footnote, { color: colors.faint }]}>{age(entry.createdAt)}</Text>
          </View>
          {!!entry.body.trim() && <Markdown text={entry.body} />}
        </InnerCard>
        </Animated.View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { gap: 10, paddingHorizontal: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  wrap: { flexWrap: 'wrap' },
  author: { flexShrink: 1 },
  age: { flexShrink: 1, marginRight: 'auto' },
  fill: { flex: 1, minWidth: 0 },
  gap: { flexGrow: 1 },
  chip: { alignSelf: 'center' },
  base: { alignSelf: 'center', flexShrink: 0, maxWidth: '35%' },
  branch: { alignSelf: 'center', flexShrink: 1 },
  meta: { flexShrink: 0 },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { paddingLeft: 24 },
  mark: { overflow: 'hidden' },
  merge: { minHeight: geometry.rowHeight, justifyContent: 'center' },
  mergeButton: { minHeight: geometry.rowHeight },
  pressable: { flex: 1 },
  primary: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous', overflow: 'hidden', paddingVertical: 8 },
  blocked: { opacity: 0.45 },
  primaryContent: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  spinner: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  menuSlot: { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  mergedTrack: { alignItems: 'center' },
  methods: { width: geometry.rowHeight, height: geometry.rowHeight, alignItems: 'center', justifyContent: 'center', borderRadius: geometry.controlRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  merged: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: geometry.rowHeight, width: '100%', overflow: 'hidden', borderCurve: 'continuous' },
  prose: { paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  commit: { paddingHorizontal: 12, paddingVertical: 9, gap: 2 },
  timeline: { gap: 6 },
});
