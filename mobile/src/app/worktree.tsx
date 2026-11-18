// The task's own worktree (worktree.status): its branch, changes and how far it is ahead, with
// Merge into the project's default branch (named from git.branches, else "the main branch") and Remove at the bottom, each behind a native confirm
// (worktree.merge, worktree.remove). Git refuses either if work would be lost. A task on the main
// checkout offers Move to a worktree (worktree.create): an unstarted task moves in place; a started one
// gets a new task in the worktree, which opens in its place.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { createWorktree, listBranches, mergeWorktree, removeWorktree, worktreeStatus } from '../connect/api/git.ts';
import { worktreeLine, type WorktreeState } from '../store/git.ts';
import { Banner, Button, Card, Chip, EmptyState, geometry, haptic, InnerCard, Row, Skeleton, useStagger } from '../ui/ds/index.ts';
import { ActionBar, BranchRow } from '../ui/GitParts.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useIconSize } from '../ui/usePagePadding.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const MAIN_ICON = { ios: 'square.stack.3d.down.right', android: 'account_tree' } as const;
const MERGE_ICON = { ios: 'arrow.triangle.merge', android: 'merge' } as const;
const REMOVE_ICON = { ios: 'trash', android: 'delete' } as const;

/** The branch a merge goes into: the project's default branch (the host merges into it), from
 * git.branches where this phone may read it; null until known, and on older hosts. */
function useMergeTarget(device: string, session: string): [string | null, (branch: string) => void] {
  const supported = useHostSupports(device, 'git.branches');
  const allowed = useHostAllows(device, 'git.branches');
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!supported || !allowed) return undefined;
    let live = true;
    listBranches(device, session).then(list => { if (live && list.defaultBranch) setTarget(list.defaultBranch); }, () => undefined);
    return () => { live = false; };
  }, [device, session, supported, allowed]);
  return [target, setTarget];
}

export default function WorktreeScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const scroll = usePushedScroll();
  const colors = useColors();
  const iconSize = useIconSize(20);
  const canMerge = useHostAllows(device, 'worktree.merge');
  const canRemove = useHostAllows(device, 'worktree.remove');
  const canCreate = useHostAllows(device, 'worktree.create');
  const accessNote = useAccessNote(device, ['worktree.merge', 'worktree.remove']);
  const createNote = useAccessNote(device, ['worktree.create']);
  const [state, setState] = useState<WorktreeState | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState<'' | 'merge' | 'remove' | 'create'>('');
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!state);
  const load = useCallback(() => worktreeStatus(device, session).then(next => { setState(next); setError(''); }, (e: Error) => setError(e.message)), [device, session]);
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  const [target, setTarget] = useMergeTarget(device, session);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const merge = async () => {
    setBusy('merge');
    try {
      const result = await mergeWorktree(device, session);
      haptic('success');
      if (result.target) setTarget(result.target);
      setDone(result.commits ? `Merged ${result.commits} ${result.commits === 1 ? 'commit' : 'commits'} from ${result.branch} into ${result.target}.` : `${result.target} already had ${result.branch}’s work.`);
      setError('');
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    }
    await load();
    setBusy('');
  };
  const remove = async (deleteBranch: boolean) => {
    setBusy('remove');
    try {
      const result = await removeWorktree(device, session, deleteBranch);
      haptic('success');
      setDone([result.branchDeleted ? `Removed the worktree and the ${result.branch} branch.` : 'Removed the worktree.', result.note].filter(Boolean).join(' '));
      setError('');
      await load();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    }
    setBusy('');
  };
  const create = async () => {
    setBusy('create');
    try {
      const result = await createWorktree(device, session);
      haptic('success');
      setError('');
      if (!result.moved) {
        // A started task stays on the main checkout; its worktree belongs to the new task.
        router.replace({ pathname: '/task/[device]/[session]', params: { device, session: result.sessionId } });
        return;
      }
      setDone(result.branch ? `This task now works in ${result.branch}.` : 'This task now works in its own worktree.');
      await load();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    }
    setBusy('');
  };
  const confirmCreate = () => Alert.alert('Move to a worktree?', 'A new branch named after the task is checked out beside the project. A task that hasn’t started moves into it; one that has gets a new task there with the same harness and model.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Create worktree', onPress: () => void create() },
  ]);
  const confirmMerge = () => state && Alert.alert(`Merge ${state.branch}?`, `Its commits are merged into ${target ?? 'the main branch'} in the project’s own checkout. A conflict stops the merge and changes nothing.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Merge', onPress: () => void merge() },
  ]);
  const confirmRemove = () => state && Alert.alert('Remove the worktree?', state.merged ? 'Its folder is deleted. The branch can go too: its work is merged.' : 'Its folder is deleted. The branch stays, with its commits.', [
    { text: 'Cancel', style: 'cancel' },
    ...(state.merged ? [{ text: 'Remove and delete branch', style: 'destructive' as const, onPress: () => void remove(true) }] : []),
    { text: 'Remove', style: 'destructive', onPress: () => void remove(false) },
  ]);

  const present = !!state?.worktree;
  const blocked = !state || state.running || !!busy;
  return (
    <View style={styles.screen}>
      <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Worktree' }} />
        <HeaderActions />
        {!state && !error && <Card><InnerCard style={styles.loading}><Skeleton width="60%" /><Skeleton width="40%" /></InnerCard></Card>}
        {!state && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the worktree" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />}
        <Banner visible={!!state && !!error} tone="danger" title="That didn’t work" body={error} />
        <Banner visible={!!done} tone="success" title={done} action={{ label: 'OK', onPress: () => setDone('') }} />
        <Banner visible={!!state?.running} tone="info" title="The agent is working. Merge or remove its worktree when it finishes." />
        {state && !present && (
          <EmptyState icon={MAIN_ICON} title="This task uses the main checkout."
            body={canCreate ? 'Give it its own worktree to keep its changes apart from the project’s checkout.' : createNote ?? undefined}
            action={canCreate ? { label: busy === 'create' ? 'Creating…' : 'Move to a worktree', onPress: () => { if (!busy) confirmCreate(); } } : { label: 'Back to Changes', onPress: () => router.back() }}
            style={styles.empty} />
        )}
        {state && present && (
          <Animated.View entering={enter(0)}>
            <Card>
              <InnerCard>
                <BranchRow branch={state.branch} detail={worktreeLine(state)} trailing={state.merged ? <Chip label="Merged" tone="success" /> : undefined} />
                <Row title="Uncommitted changes" trailing={String(state.changes)} leading={<Icon ios="pencil.line" android="edit" size={iconSize} color={colors.muted} />} />
                <Row title="Commits to merge" trailing={String(state.ahead)} leading={<Icon ios="point.3.connected.trianglepath.dotted" android="commit" size={iconSize} color={colors.muted} />} />
                <Row title="Pushed" trailing={state.hasUpstream ? 'Yes' : 'No'} leading={<Icon ios="icloud.and.arrow.up" android="cloud_upload" size={iconSize} color={colors.muted} />} />
              </InnerCard>
            </Card>
          </Animated.View>
        )}
      </PushedScroll>
      {state && present && (canMerge || canRemove || !!accessNote) && (
        <ActionBar note={accessNote ?? (!state.clean ? 'Commit the worktree’s changes before merging or removing it.' : undefined)}>
          {canRemove && <Button label="Remove" variant="destructive" icon={REMOVE_ICON} loading={busy === 'remove'} disabled={blocked || !state.clean} onPress={confirmRemove} style={styles.grow} />}
          {canMerge && !state.merged && <Button label={`Merge into ${target ?? 'main'}`} variant="primary" icon={MERGE_ICON} loading={busy === 'merge'} disabled={blocked || !state.clean || !state.exists} onPress={confirmMerge} style={styles.grow} />}
        </ActionBar>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
  grow: { flex: 1 },
});
