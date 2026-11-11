// The task's uncommitted changes: branch, ahead/behind and each file with its Git status and +/−
// counts (from task.diff, which notes how many secret files it left out for a phone below Full). Tapping a file opens its diff. Pull to refresh; it also refreshes when a
// run ends. With `turn` (a message id) it shows only that turn's changes (ui/TurnChanges.tsx). Hosts with the git methods (git.status) add shipping: a switch per file to stage it,
// the branch row opening Branches, a worktree banner, and a bottom bar with Commit…, Push and
// Create pull request, each only when this phone's grant allows it (useHostAllows; an AccessNote says
// why not). Hosts with git.discard add Discard changes on a file's long press and Discard all under the list,
// each after a destructive confirm. A jj checkout adds a read-only card with its working-copy change. Older hosts keep the read-only list.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { discardFiles, gitStatus, pushBranch, stageFiles } from '../connect/api/git.ts';
import { connect, hostCall } from '../connect/client.ts';
import type { Changes } from '../connect/types.ts';
import { fileCounts, statusLetter } from '../store/diff.ts';
import { canDiscardAll, discardAllPaths, discardNote, openPull, stageRows, stageSummary, stagedCount, syncLine, withStage, type GitStatus, type StageRow } from '../store/git.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { useColors } from '../ui/theme.ts';
import { Banner, Button, Card, crossFadeIn, crossFadeOut, EmptyState, geometry, haptic, InnerCard, Row, showToast, Skeleton, springs, useStagger } from '../ui/ds/index.ts';
import { statusTally } from '../ui/file-groups.ts';
import { Counts, FileGroups, StageFiles, type ListedFile } from '../ui/FileRow.tsx';
import { ActionBar, BranchRow, WorktreeBanner } from '../ui/GitParts.tsx';
import { SecretsNote, TurnChanges } from '../ui/TurnChanges.tsx';
import { AccessNote } from '../ui/AccessNote.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { JjCard } from '../ui/JjCard.tsx';
import { Icon } from '../ui/Icon.tsx';
import { isActive } from '../ui/status.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useIconSize } from '../ui/usePagePadding.ts';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

type Loaded = Changes & { counts: ReturnType<typeof fileCounts>; git: GitStatus | null; hiddenSecrets: number };

/** The whole task.diff, with `hiddenSecrets`: secret files the host left out for a phone below Full. */
interface FullDiff { diff?: string; truncated?: boolean; hiddenSecrets?: number }
const wholeDiff = (device: string, session: string) => hostCall<FullDiff>(device, 'task.diff', { sessionId: session, staged: false });

const CLEAN_ICON = { ios: 'checkmark.circle', android: 'check_circle' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const COMMIT_ICON = { ios: 'checkmark.seal', android: 'task_alt' } as const;
const PUSH_ICON = { ios: 'arrow.up.circle', android: 'upload' } as const;
const PULL_ICON = { ios: 'arrow.triangle.pull', android: 'merge' } as const;

/** Shipping actions a narrow grant keeps off, noted once above the list. */
const SHIP_METHODS = ['git.stage', 'git.discard', 'git.commit', 'git.push', 'pull.create'] as const;

/** git.discard's per-call limit (git.rs MAX_STAGE_PATHS): Discard all sends bigger lists in parts. */
const DISCARD_BATCH = 500;
const DISCARD_ICON = { ios: 'arrow.uturn.backward', android: 'undo' } as const;

/** Shown instead of Discard all when git.status cut its lists: discarding only the listed files would surprise. */
const DISCARD_ALL_TRUNCATED = 'Too many changes to list here, so Discard all is off. Discard files one at a time, or use the computer.';

/** The host refuses a git change while another runs on the checkout (git.rs CHECKOUT_BUSY): a moment's wait, not a failure. */
const GIT_BUSY_PREFIX = 'Another git change is running';
const GIT_BUSY_NOTE = 'Another git change is running — try again in a moment';
const gitBusy = (e: unknown) => e instanceof Error && e.message.startsWith(GIT_BUSY_PREFIX);
const showGitBusy = () => showToast({ title: GIT_BUSY_NOTE, tone: 'info', icon: { ios: 'clock', android: 'schedule' } });

const stagedFlag = (file: ListedFile) => (file.note ? '1' : '0');

/** task.changes' shape from git.status, so the branch card and counts read either. */
function changesOf(git: GitStatus): Changes {
  return {
    branch: git.branch, ahead: git.ahead, behind: git.behind,
    files: [
      ...git.staged.map(e => ({ path: e.path, status: e.status, staged: true })),
      ...git.unstaged.map(e => ({ path: e.path, status: e.status, staged: false })),
      ...git.untracked.map(path => ({ path, status: '??', staged: false })),
    ],
  };
}

function Loading() {
  return (
    <Card>
      <InnerCard style={styles.loading}>
        <Skeleton width="55%" height={16} />
        <Skeleton width="80%" />
        <Skeleton width="70%" />
      </InnerCard>
    </Card>
  );
}

/** Added against removed lines, sliding to the new balance when a refresh changes it. */
function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const colors = useColors();
  const share = additions / Math.max(1, additions + deletions);
  const added = useSharedValue(share);
  useEffect(() => { added.set(withSpring(share, springs.smooth)); }, [share, added]);
  const green = useAnimatedStyle(() => ({ transform: [{ scaleX: added.get() }] }));
  const red = useAnimatedStyle(() => ({ transform: [{ scaleX: 1 - added.get() }] }));
  return (
    <View style={[styles.bar, { backgroundColor: colors.fill }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.barPart, styles.barAdded, { backgroundColor: colors.success }, green]} />
      <Animated.View style={[styles.barPart, styles.barRemoved, { backgroundColor: colors.danger }, red]} />
    </View>
  );
}

function BranchCard({ changes, letters, onBranches }: { changes: Loaded; letters: readonly string[]; onBranches?: () => void }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  const totals = Object.values(changes.counts);
  const additions = totals.reduce((n, c) => n + c.additions, 0);
  const deletions = totals.reduce((n, c) => n + c.deletions, 0);
  const tally = statusTally(letters);
  const sync = changes.git ? syncLine(changes.git) : [changes.ahead > 0 && `${changes.ahead} ahead`, changes.behind > 0 && `${changes.behind} behind`].filter(Boolean).join(' · ');
  const subtitle = [tally || 'No uncommitted changes', sync].filter(Boolean).join(' · ');
  const label = `${additions}/${deletions}`;
  const counts = additions + deletions > 0 ? (
    // The numbers cross-fade when a refresh changes them.
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={label} entering={crossFadeIn} exiting={crossFadeOut}><Counts additions={additions} deletions={deletions} /></Animated.View>
    </LayoutAnimationConfig>
  ) : undefined;
  return (
    <Card>
      <InnerCard accessible={!onBranches} accessibilityLabel={onBranches ? undefined : [changes.branch || 'No branch', subtitle].join(', ')}>
        {onBranches
          ? <BranchRow branch={changes.branch} detail={subtitle} onPress={onBranches} trailing={counts} />
          : <Row title={changes.branch || 'No branch'} subtitle={subtitle} leading={<Icon ios="arrow.triangle.branch" android="call_split" size={iconSize} color={colors.muted} />} trailing={counts} />}
        {additions + deletions > 0 && <StatBar additions={additions} deletions={deletions} />}
      </InnerCard>
    </Card>
  );
}

/** Commit…, Push and Create pull request, as the checkout allows. */
function ShipBar({ git, rows, device, session, busy, canStage, onPush, onStageAll }: {
  git: GitStatus; rows: readonly StageRow[]; device: string; session: string; busy: string; canStage: boolean; onPush: () => void; onStageAll: (unstage: boolean) => void;
}) {
  const params = { device, session };
  const canCommit = useHostAllows(device, 'git.commit');
  const canPush = useHostAllows(device, 'git.push');
  const canPull = useHostAllows(device, 'pull.create');
  const staged = stagedCount(rows);
  const linked = openPull(git.pull);
  const clean = !rows.length;
  if (git.running) return <ActionBar note="The agent is working. Commit when it finishes." />;
  if (!clean) {
    const allStaged = staged === rows.length;
    return (
      <ActionBar note={stageSummary(rows)}>
        {canStage && <Button label={allStaged ? 'Unstage all' : 'Stage all'} loading={busy === 'stage'} disabled={!!busy} onPress={() => onStageAll(allStaged)} style={styles.grow} />}
        {canCommit && <Button label="Commit…" variant="primary" icon={COMMIT_ICON} disabled={!staged || !!busy} onPress={() => router.push({ pathname: '/commit', params })} style={styles.grow} />}
      </ActionBar>
    );
  }
  const push = canPush && git.ahead > 0 && !!git.upstream;
  const pull = canPull && !linked && !!git.branch;
  if (!push && !pull && !linked) return null;
  return (
    <ActionBar>
      {push && <Button label={`Push ${git.ahead}`} icon={PUSH_ICON} loading={busy === 'push'} disabled={!!busy} onPress={onPush} style={styles.grow} />}
      {pull && <Button label="Create pull request" variant="primary" icon={PULL_ICON} disabled={!!busy} onPress={() => router.push({ pathname: '/new-pull', params })} style={styles.grow} />}
      {linked && <Button label={`Pull request #${git.pull?.number}`} icon={PULL_ICON} onPress={() => router.push({ pathname: '/pull', params })} style={styles.grow} />}
    </ActionBar>
  );
}

export default function ChangesScreen() {
  const { device = '', session = '', turn } = useLocalSearchParams<{ device: string; session: string; turn?: string }>();
  // From a transcript's turn footer: only what that turn changed.
  return turn ? <TurnChanges device={device} session={session} turn={turn} /> : <TaskChanges device={device} session={session} />;
}

function TaskChanges({ device, session }: { device: string; session: string }) {
  const scroll = usePushedScroll();
  const running = useConnect(s => isActive(s.live[taskKey(device, session)]?.status ?? 'idle'));
  const shipping = useHostSupports(device, 'git.status');
  const canStage = useHostAllows(device, 'git.stage');
  const canBranches = useHostSupports(device, 'git.branches');
  const discardServed = useHostSupports(device, 'git.discard');
  const discardAllowed = useHostAllows(device, 'git.discard');
  const [changes, setChanges] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<StageRow[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!changes);
  // One full diff gives every file's counts; staged-only files have none.
  const load = useCallback(() => {
    const listed = shipping
      ? gitStatus(device, session).then(git => ({ ...changesOf(git), git }))
      : connect.taskChanges(device, session).then(list => ({ ...list, git: null }));
    return Promise.all([listed, wholeDiff(device, session).catch(() => null)])
      .then(([list, diff]) => {
        const text = typeof diff?.diff === 'string' ? diff.diff : '';
        setChanges({ ...list, counts: diff ? fileCounts(text) : {}, hiddenSecrets: diff?.hiddenSecrets ?? 0 });
        setRows(list.git ? stageRows(list.git) : []);
        setError('');
      }, (e: Error) => setError(e.message));
  }, [device, session, shipping]);
  const [refreshed, setRefreshed] = useState(0);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); setRefreshed(n => n + 1); };
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  // Again whenever a run ends, and when a sheet (commit, new pull request) or Branches comes back.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [running, load]);
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focused.current) void load();
    focused.current = true;
  }, [load]));

  const toggle = async (path: string, staged: boolean) => {
    const before = rows;
    setRows(withStage(rows, path, staged));
    setPending(p => new Set([...p, path]));
    haptic('selection');
    try {
      await stageFiles(device, session, [path], !staged);
      setActionError('');
    } catch (e) {
      setRows(before);
      if (gitBusy(e)) showGitBusy();
      else setActionError((e as Error).message);
    } finally {
      setPending(p => new Set([...p].filter(item => item !== path)));
    }
    void load();
  };
  const stageAll = async (unstage: boolean) => {
    setBusy('stage');
    try {
      const reply = await stageFiles(device, session, 'all', unstage) as { count: number; skipped?: number };
      noteSkipped(reply?.skipped, unstage ? 'unstaged' : 'staged');
      setActionError('');
    } catch (e) {
      if (gitBusy(e)) showGitBusy();
      else setActionError((e as Error).message);
    }
    await load();
    setBusy('');
  };
  // Folders and submodules (a nested repository's `sub/` row, a changed submodule pointer) can't move file by file;
  // the host leaves them out of an *all* action and says how many.
  const noteSkipped = (skipped: number | undefined, verb: string) => {
    if (skipped && skipped > 0) showToast({ title: `${skipped} folder${skipped === 1 ? '' : 's'} or submodule${skipped === 1 ? '' : 's'} not ${verb}`, tone: 'info' });
  };
  const discardBatch = (paths: readonly string[], all: boolean) =>
    discardFiles(device, session, paths, all);
  const discard = async (paths: readonly string[], all = false) => {
    setBusy('discard');
    setPending(p => new Set([...p, ...paths]));
    try {
      let skipped = 0;
      for (let at = 0; at < paths.length; at += DISCARD_BATCH) {
        const reply = await discardBatch(paths.slice(at, at + DISCARD_BATCH), all) as { skipped?: number } | undefined;
        skipped += reply?.skipped ?? 0;
      }
      noteSkipped(skipped + (all ? rows.length - paths.length : 0), 'discarded');
      haptic('success');
      setActionError('');
    } catch (e) {
      if (gitBusy(e)) showGitBusy();
      else setActionError((e as Error).message);
    }
    await load();
    setPending(p => new Set([...p].filter(item => !paths.includes(item))));
    setBusy('');
  };
  const confirmDiscard = (path: string) => {
    const row = rows.find(r => r.path === path);
    if (!row) return;
    haptic('selection');
    Alert.alert(`Discard changes to ${path.slice(path.lastIndexOf('/') + 1)}?`, discardNote(row), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => void discard([path]) },
    ]);
  };
  const confirmDiscardAll = () => {
    const paths = discardAllPaths(rows);
    const count = paths.length;
    if (!count) return;
    // Folder rows (untracked nested repositories, submodules) aren't discarded file by file.
    const kept = new Set(rows.map(row => row.path).filter(path => path.endsWith('/'))).size;
    const keptNote = kept ? ` ${kept} folder${kept === 1 ? '' : 's'} or submodule${kept === 1 ? ' is' : 's are'} kept.` : '';
    Alert.alert(`Discard all ${count} change${count === 1 ? '' : 's'}?`, `Every changed file goes back to the last commit and new files are deleted from the computer.${keptNote} This can’t be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard all', style: 'destructive', onPress: () => void discard(paths, true) },
    ]);
  };
  const push = async () => {
    setBusy('push');
    try {
      await pushBranch(device, session);
      haptic('success');
      setActionError('');
    } catch (e) {
      Alert.alert('Could not push', (e as Error).message);
    }
    await load();
    setBusy('');
  };

  const retry = () => { setError(''); void load(); };
  const git = changes?.git ?? null;
  const files: ListedFile[] = (changes?.files ?? []).map(f => ({
    key: `${f.staged}/${f.path}`, path: f.path, letter: statusLetter(f.status), note: f.staged ? 'Staged' : undefined,
    additions: changes?.counts[f.path]?.additions, deletions: changes?.counts[f.path]?.deletions,
  }));
  const stageable = !!git && canStage && !git.running;
  // Hidden on older hosts (no git.discard) and while the agent works (the host refuses then); AccessNote explains a narrow grant.
  const discardable = !!git && !git.running && discardServed && discardAllowed;
  return (
    <View style={styles.screen}>
      <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Changes' }} />
        <HeaderActions />
        {!changes && !error && <Loading />}
        {!changes && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the changes" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />}
        <Banner visible={!!changes && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: retry }} />
        <Banner visible={!!actionError} tone="danger" title="That didn’t work" body={actionError} action={{ label: 'Dismiss', onPress: () => setActionError('') }} />
        {changes && (
          <>
            <Animated.View entering={enter(0)}>
              <BranchCard changes={changes} letters={files.flatMap(f => f.letter ?? [])}
                onBranches={git && canBranches ? () => router.push({ pathname: '/branches', params: { device, session } }) : undefined} />
            </Animated.View>
            {git?.worktree && <Animated.View entering={enter(1)}><WorktreeBanner device={device} session={session} /></Animated.View>}
            <SecretsNote count={changes.hiddenSecrets} />
            <JjCard device={device} session={session} />
            {git && <AccessNote device={device} methods={SHIP_METHODS} />}
            {git && rows.length > 0 && (
              <Animated.View entering={enter(2)}>
                <StageFiles rows={rows} device={device} session={session} pending={pending} disabled={!stageable} onToggle={toggle}
                  onDiscard={discardable && !busy ? confirmDiscard : undefined} />
              </Animated.View>
            )}
            {discardable && git.truncated && rows.length > 0 && <Banner visible tone="info" title="Discard all is off" body={DISCARD_ALL_TRUNCATED} />}
            {discardable && canDiscardAll(git, rows) && (
              <Button label="Discard all" variant="destructive" icon={DISCARD_ICON} loading={busy === 'discard'} disabled={!!busy}
                accessibilityHint="Asks first, then discards every uncommitted change" onPress={confirmDiscardAll} />
            )}
            {!git && files.length > 0 && (
              <Animated.View entering={enter(1)}>
                <FileGroups files={files} refreshed={refreshed} diff={file => ({ device, session, source: 'changes', staged: stagedFlag(file) })} />
              </Animated.View>
            )}
            {!files.length && <View><EmptyState icon={CLEAN_ICON} title="No uncommitted changes." style={styles.empty} /></View>}
          </>
        )}
      </PushedScroll>
      {git && <ShipBar git={git} rows={rows} device={device} session={session} busy={busy} canStage={canStage} onPush={push} onStageAll={stageAll} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: 12 },
  grow: { flex: 1 },
  bar: { height: 3, marginHorizontal: geometry.rowInset, marginBottom: 8, borderRadius: 1.5, overflow: 'hidden' },
  barPart: { ...StyleSheet.absoluteFill },
  barAdded: { transformOrigin: 'left' },
  barRemoved: { transformOrigin: 'right' },
});
