// The task's pull request, like the desktop's PR tab: title, author, branches and counts, then
// Summary (checks, approval, conflicts, Merge confirmed natively, description), Files (each opens
// its diff), Commits and Timeline. Refreshed on open. The header's Review menu (pull.review) opens a
// small card: Approve (confirmed), Request changes or Comment, the latter two with required text;
// the timeline refreshes and a toast confirms once GitHub has it.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { REVIEW_EVENTS, reviewDone, reviewErrorMessage, reviewProblem, reviewPull, type ReviewEvent } from '../connect/api/github.ts';
import { connect } from '../connect/client.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import type { MergeMethod, PullDetail } from '../connect/types.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { useColors } from '../ui/theme.ts';
import { Banner, Button, Card, EmptyState, EXIT_MS, FADE_MS, geometry, Group, haptic, InnerCard, Segmented, showToast, Skeleton, springs, type as text, useMotion } from '../ui/ds/index.ts';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useComputerName } from '../ui/hub/common.tsx';
import { BLOCKED_TITLE, menuGate } from '../ui/menu-gate.ts';
import { FileGroups, type ListedFile } from '../ui/FileRow.tsx';
import { Commits, Description, METHODS, OpenOnGitHub, PullHead, SummaryCard, Timeline } from '../ui/PullParts.tsx';
import { FadingTitle, PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { DISCARD_TITLE, useDiscardGuard } from '../ui/useDiscardGuard.ts';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

type Tab = 'summary' | 'files' | 'commits' | 'timeline';
const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'summary', label: 'Summary' }, { value: 'files', label: 'Files' }, { value: 'commits', label: 'Commits' }, { value: 'timeline', label: 'Timeline' },
];

const PULL_ICON = { ios: 'arrow.triangle.pull', android: 'merge' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const FILES_ICON = { ios: 'doc', android: 'description' } as const;
const COMMITS_ICON = { ios: 'point.3.connected.trianglepath.dotted', android: 'commit' } as const;
const TIMELINE_ICON = { ios: 'text.bubble', android: 'comment' } as const;
const REVIEW_ICON = { ios: 'checkmark.bubble', android: 'rate_review' } as const;
const REVIEWED_ICON = { ios: 'checkmark.circle', android: 'check_circle' } as const;
const REVIEW_INPUT_HEIGHT = 96;

/** How far through the page title (0 to 1) the nav title starts to appear. */
const TITLE_FADE_START = 0.4;
const TAB_SLIDE = 10;
const IN_DELAY = 70;
const OUT = { duration: EXIT_MS, easing: Easing.out(Easing.cubic) };
const IN = { duration: FADE_MS, easing: Easing.out(Easing.cubic) };

/** One tab's content, kept mounted once seen. It cross-fades and moves a few points the way the thumb went. */
function TabPane({ active, side, onHeight, children }: { active: boolean; side: number; onHeight: (height: number) => void; children: ReactNode }) {
  const reduced = useReducedMotion();
  const shown = useSharedValue(active ? 1 : 0);
  const away = useSharedValue(reduced ? 0 : side * TAB_SLIDE);
  useEffect(() => {
    if (!active) away.set(reduced ? 0 : side * TAB_SLIDE);
    // The incoming pane waits for most of the outgoing one, so two sets of text never read over each other.
    shown.set(active ? withDelay(IN_DELAY, withTiming(1, IN)) : withTiming(0, OUT));
  }, [active, side, reduced, away, shown]);
  const style = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateX: (1 - shown.get()) * away.get() }] }));
  return (
    <Animated.View pointerEvents={active ? 'auto' : 'none'} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      onLayout={event => onHeight(event.nativeEvent.layout.height)} style={[styles.pane, style]}>
      {children}
    </Animated.View>
  );
}

/** The tabs' stack: its height springs to the active pane's, so the page below never jumps. */
function TabPanes({ tab, render }: { tab: Tab; render: (tab: Tab) => ReactNode }) {
  const [seen, setSeen] = useState<readonly Tab[]>([tab]);
  if (!seen.includes(tab)) setSeen([...seen, tab]);
  const height = useSharedValue(0);
  const heights = useRef<Partial<Record<Tab, number>>>({});
  const place = useCallback((value: number) => {
    // The first measure lands at once; only later changes travel.
    height.set(height.get() === 0 ? value : withSpring(value, springs.smooth));
  }, [height]);
  useEffect(() => {
    const known = heights.current[tab];
    if (known !== undefined) place(known);
  }, [tab, place]);
  const frame = useAnimatedStyle(() => ({ height: height.get() }));
  const at = TABS.findIndex(t => t.value === tab);
  return (
    <Animated.View style={frame}>
      {TABS.filter(t => seen.includes(t.value)).map((t, i) => (
        <TabPane key={t.value} active={t.value === tab} side={Math.sign(TABS.indexOf(t) - at)} onHeight={value => {
          heights.current = { ...heights.current, [t.value]: value };
          if (t.value === tab) place(value);
        }}>{render(t.value)}</TabPane>
      ))}
    </Animated.View>
  );
}

function Loading() {
  return (
    <View style={styles.tab}>
      <Skeleton width="85%" height={22} />
      <Skeleton width="50%" />
      <Card>
        <InnerCard style={styles.loading}>
          <Skeleton width="65%" />
          <Skeleton width="55%" />
          <Skeleton width="70%" />
        </InnerCard>
      </Card>
    </View>
  );
}

/** The Review card: a verdict, its text (required unless approving) and Submit; Approve asks first. */
function ReviewCard({ number, event, onEvent, onSubmit, onCancel }: {
  number: number; event: ReviewEvent; onEvent: (event: ReviewEvent) => void; onSubmit: (event: ReviewEvent, body: string) => Promise<void>; onCancel: () => void;
}) {
  const colors = useColors();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const problem = reviewProblem(event, body);
  // Leaving with review text asks first; a posted review closes the card, which ends the guard.
  useDiscardGuard(!!body.trim(), { message: 'Your review isn’t posted.' });
  const verb = REVIEW_EVENTS.find(e => e.value === event)?.verb ?? 'Submit';
  const send = async () => {
    setSending(true);
    try {
      await onSubmit(event, body);
    } catch {
      // The caller showed the error; the text stays for another try.
    } finally {
      setSending(false);
    }
  };
  const submit = () => {
    if (problem || sending) return;
    if (event !== 'approve') return void send();
    Alert.alert(`Approve #${number}?`, 'Your approval is posted on GitHub as the computer’s GitHub CLI account.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: () => void send() },
    ]);
  };
  // Cancel drops the card and its text: ask first when there is any.
  const cancel = () => {
    if (!body.trim()) return onCancel();
    Alert.alert(DISCARD_TITLE, 'Your review isn’t posted.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onCancel },
    ]);
  };
  return (
    <Group title="Review" footer={<Text style={[text.footnote, { color: colors.muted }]}>Posted on GitHub as the computer’s GitHub CLI account.</Text>}>
      <Segmented options={REVIEW_EVENTS} value={event} onChange={onEvent} accessibilityLabel="Review verdict" style={styles.reviewSeg} />
      <TextInput value={body} onChangeText={setBody} multiline editable={!sending} placeholderTextColor={colors.faint} accessibilityLabel="Review comment"
        placeholder={event === 'approve' ? 'Add a comment (optional)' : 'Leave a comment (required)'} style={[text.body, styles.reviewInput, { color: colors.text }]} />
      <View style={styles.reviewActions}>
        <Button label="Cancel" size="small" variant="plain" disabled={sending} onPress={cancel} />
        <Button label={sending ? 'Sending…' : verb} size="small" variant="primary" loading={sending} disabled={!!problem || sending} onPress={submit} />
      </View>
    </Group>
  );
}

/** The header's Review menu, gated like the computer hub's menus (menu-gate.ts), and the card's state. */
function useReview(device: string, session: string, reload: () => Promise<void>) {
  const caps = useHostCapabilities(device);
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'pull.review');
  const allowed = useHostAllows(device, 'pull.review');
  const gate = menuGate(caps, 'pull.review', computer);
  const [event, setEvent] = useState<ReviewEvent | null>(null);
  const choose = (next: ReviewEvent) => {
    if (gate.note) return void Alert.alert(BLOCKED_TITLE, gate.note);
    haptic('light');
    setEvent(next);
  };
  const submit = async (chosen: ReviewEvent, body: string, number: number) => {
    try {
      await reviewPull(device, session, chosen, body);
      haptic('success');
      setEvent(null);
      showToast({ title: reviewDone(chosen, number), tone: 'success', icon: REVIEWED_ICON });
      await reload();
    } catch (e) {
      haptic('error');
      Alert.alert(`Could not review #${number}`, reviewErrorMessage((e as Error).message));
      throw e;
    }
  };
  const menu = (open: boolean): HeaderItem => ({
    kind: 'menu', label: 'Review', icon: REVIEW_ICON, hidden: !supported || !open,
    items: REVIEW_EVENTS.map(e => ({ label: e.label, checked: event === e.value, ...(gate.note && { subtitle: gate.note }), onPress: () => choose(e.value) })),
  });
  return { event: allowed ? event : null, setEvent, submit, menu };
}

function PullFiles({ pull, device, session }: { pull: PullDetail; device: string; session: string }) {
  if (!pull.files.length) return <EmptyState icon={FILES_ICON} title="No files to show." />;
  const files: ListedFile[] = pull.files.map(f => ({ key: f.path, path: f.path, additions: f.additions, deletions: f.deletions }));
  return <FileGroups files={files} diff={() => ({ device, session, source: 'pull' })} />;
}

export default function PullScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const { enter, layout } = useMotion();
  const scroll = usePushedScroll();
  const titleFrom = useSharedValue(Number.MAX_SAFE_INTEGER - 1);
  const titleTo = useSharedValue(Number.MAX_SAFE_INTEGER);
  const pull = useConnect(s => s.pulls[taskKey(device, session)]);
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const isOutdated = useConnect(s => !!s.outdated[device]);
  const [tab, setTab] = useState<Tab>('summary');
  const [method, setMethod] = useState<MergeMethod>('squash');
  const canMerge = useHostAllows(device, 'task.pullMerge');
  const mergeNote = useAccessNote(device, ['task.pullMerge']);
  const [refreshing, setRefreshing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [justMerged, setJustMerged] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => connect.loadPull(device, session, true).then(() => setError(''), (e: Error) => setError(e.message)), [device, session]);
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const review = useReview(device, session, load);
  const retry = () => { setError(''); void load(); };

  const runMerge = async (number: number) => {
    setMerging(true);
    try {
      await connect.mergePull(device, session, method);
      haptic('success');
      setJustMerged(true);
    } catch (e) {
      haptic('error');
      Alert.alert(`Could not merge #${number}`, (e as Error).message);
    } finally {
      setMerging(false);
    }
  };
  const confirmMerge = (detail: PullDetail) => {
    if (!canMerge) return void Alert.alert('Can’t merge from this phone', mergeNote ?? undefined);
    const verb = METHODS.find(m => m.method === method)?.verb ?? 'Merge';
    Alert.alert(`${verb} #${detail.number}?`, `Into ${detail.base} on GitHub. This can't be undone from here.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: verb, style: 'destructive', onPress: () => void runMerge(detail.number) },
    ]);
  };

  const title = pull?.title;
  const headerTitle = useMemo(() => (title ? () => <FadingTitle title={title} scrolled={scroll.scrolled} from={titleFrom} to={titleTo} /> : undefined), [title, scroll.scrolled, titleFrom, titleTo]);
  const screen = (children: ReactNode, navTitle = 'Pull request') => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: navTitle, ...(headerTitle && { headerTitle }) }} />
      <HeaderActions right={[review.menu(pull?.state === 'open' || pull?.state === 'draft')]} />
      {children}
    </PushedScroll>
  );
  if (!pull) {
    if (error) return screen(<EmptyState icon={ERROR_ICON} title="Couldn’t load the pull request" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />);
    if (pull === null) return screen(<EmptyState icon={PULL_ICON} title="No pull request is linked to this task." style={styles.empty} />);
    if (isOutdated) return screen(<EmptyState icon={PULL_ICON} title={outdated(computer)} style={styles.empty} />);
    return screen(<Loading />);
  }
  const renderTab = (name: Tab) => {
    if (name === 'files') return <PullFiles pull={pull} device={device} session={session} />;
    if (name === 'commits') return pull.commits.length ? <Commits commits={pull.commits} /> : <EmptyState icon={COMMITS_ICON} title="No commits to show." />;
    if (name === 'timeline') return pull.timeline.length ? <Timeline entries={pull.timeline} /> : <EmptyState icon={TIMELINE_ICON} title="No comments or reviews yet." />;
    return (
      <>
        <SummaryCard pull={pull} method={method} onMethod={setMethod} merging={merging} justMerged={justMerged} onMerge={() => confirmMerge(pull)}
          onReview={() => setTab('timeline')} onCommits={() => setTab('commits')} />
        <AccessNote device={device} methods={['task.pullMerge', 'pull.review']} />
        {!!pull.body.trim() && <Animated.View entering={enter(1)} layout={layout}><Description body={pull.body} /></Animated.View>}
        <Animated.View entering={enter(2)} layout={layout}><OpenOnGitHub url={pull.url} /></Animated.View>
      </>
    );
  };
  return screen(
    <>
      <Banner visible={!!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: retry }} />
      <PullHead pull={pull} onTitleLayout={event => {
        const { y, height } = event.nativeEvent.layout;
        titleFrom.set(y + height * TITLE_FADE_START);
        titleTo.set(y + height);
      }} />
      {review.event && (
        <Animated.View entering={enter(0)} layout={layout}>
          <ReviewCard number={pull.number} event={review.event} onEvent={review.setEvent} onCancel={() => review.setEvent(null)}
            onSubmit={async (event, body) => { await review.submit(event, body, pull.number); setTab('timeline'); }} />
        </Animated.View>
      )}
      <Segmented options={TABS} value={tab} onChange={setTab} accessibilityLabel="Pull request sections" />
      <TabPanes tab={tab} render={renderTab} />
      {pull.truncated && <Text style={[text.footnote, { color: colors.muted }]}>Some of this pull request was left out to fit. Open it on GitHub for the rest.</Text>}
    </>,
    `#${pull.number}`,
  );
}

const styles = StyleSheet.create({
  pane: { position: 'absolute', top: 0, left: 0, right: 0, gap: geometry.sectionGap },
  empty: { marginTop: geometry.emptyTop },
  tab: { gap: geometry.sectionGap },
  loading: { padding: geometry.rowInset, gap: 14 },
  reviewSeg: { marginHorizontal: geometry.screenMargin, marginBottom: geometry.cardPadding },
  reviewInput: { minHeight: REVIEW_INPUT_HEIGHT, paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding, textAlignVertical: 'top' },
  reviewActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: geometry.cardPadding, paddingHorizontal: geometry.screenMargin, paddingBottom: geometry.cardPadding },
});
