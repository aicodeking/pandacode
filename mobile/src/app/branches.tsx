// The task checkout's local branches (git.branches), current first; tapping another one switches to
// it after a native confirm (git.switchBranch). A worktree task keeps its branch, so the list is
// read-only there, as it is while the agent works.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { listBranches, switchBranch } from '../connect/api/git.ts';
import { branchChoices, type BranchList } from '../store/git.ts';
import { Banner, Card, Chip, EmptyState, geometry, haptic, InnerCard, Row, showToast, Skeleton, useStagger } from '../ui/ds/index.ts';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useIconSize } from '../ui/usePagePadding.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

/** The host refuses a git change while another runs on the checkout (git.rs CHECKOUT_BUSY): a moment's wait, not a failure. */
const GIT_BUSY_PREFIX = 'Another git change is running';
const GIT_BUSY_NOTE = 'Another git change is running — try again in a moment';
const gitBusy = (e: unknown) => e instanceof Error && e.message.startsWith(GIT_BUSY_PREFIX);
const showGitBusy = () => showToast({ title: GIT_BUSY_NOTE, tone: 'info', icon: { ios: 'clock', android: 'schedule' } });

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const EMPTY_ICON = { ios: 'arrow.triangle.branch', android: 'call_split' } as const;

export default function BranchesScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const scroll = usePushedScroll();
  const colors = useColors();
  const iconSize = useIconSize(18);
  const canSwitch = useHostAllows(device, 'git.switchBranch');
  const [listed, setListed] = useState<BranchList | null>(null);
  // Load (and refresh) errors apart from switch errors, so each banner says what failed.
  const [error, setError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const [switching, setSwitching] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const enter = useStagger(!!listed);
  const load = useCallback(() => listBranches(device, session).then(list => { setListed(list); setError(''); }, (e: Error) => setError(e.message)), [device, session]);
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const switchTo = async (branch: string) => {
    setSwitching(branch);
    setSwitchError('');
    try {
      setListed(await switchBranch(device, session, branch));
      haptic('success');
      setSwitchError('');
      setError('');
    } catch (e) {
      haptic('error');
      if (gitBusy(e)) showGitBusy();
      else setSwitchError((e as Error).message);
    } finally {
      setSwitching('');
    }
  };
  const confirm = (branch: string) => Alert.alert(`Switch to ${branch}?`, 'The task’s checkout moves to this branch. Git refuses if uncommitted changes would be overwritten.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Switch', onPress: () => void switchTo(branch) },
  ]);

  const locked = !listed || listed.worktree || listed.running || !canSwitch;
  const note = listed?.worktree ? 'This task works in its own worktree; its branch stays as it is.' : listed?.running ? 'Wait for the agent to finish before switching branches.' : '';
  const branches = listed ? branchChoices(listed, query) : [];
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Branches', headerSearchBarOptions: listed && listed.branches.length > 8 ? { placeholder: 'Find a branch', onChangeText: event => setQuery(event.nativeEvent.text), hideWhenScrolling: false } : undefined }} />
      <HeaderActions />
      {!listed && !error && <Card><InnerCard style={styles.loading}><Skeleton width="60%" /><Skeleton width="45%" /><Skeleton width="70%" /></InnerCard></Card>}
      {!listed && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the branches" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />}
      <Banner visible={!!listed && !!error} tone="danger" title="Couldn’t refresh the branches" body={error} />
      <Banner visible={!!switchError} tone="danger" title="Couldn’t switch" body={switchError} />
      <Banner visible={!!note} tone="info" title={note} />
      <AccessNote device={device} methods={['git.switchBranch']} />
      {listed && !branches.length && <EmptyState icon={EMPTY_ICON} title={query ? 'No branch matches.' : 'No local branches.'} style={styles.empty} />}
      {listed && branches.length > 0 && (
        <Animated.View entering={enter(0)}>
          <Card>
            <InnerCard>
              {branches.map(branch => {
                const current = branch === listed.current;
                return (
                  <Row key={branch} title={branch} disabled={!current && (locked || !!switching)}
                    leading={<Icon ios={current ? 'checkmark.circle.fill' : 'circle'} android={current ? 'check_circle' : 'radio_button_unchecked'} size={iconSize} color={current ? colors.primary : colors.faint} />}
                    trailing={branch === listed.defaultBranch ? <Chip label="default" /> : switching === branch ? 'Switching…' : undefined}
                    onPress={current || locked ? undefined : () => confirm(branch)}
                    accessibilityLabel={[branch, current && 'current branch', branch === listed.defaultBranch && 'default branch'].filter(Boolean).join(', ')}
                    accessibilityHint={current || locked ? undefined : 'Switches the task to this branch'} />
                );
              })}
            </InnerCard>
          </Card>
        </Animated.View>
      )}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
});
