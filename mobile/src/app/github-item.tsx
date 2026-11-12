// One GitHub issue, pull request or workflow run (?device=&project=&kind=&id=, runs also ?title=&url=):
// an issue or pull request shows its description (Markdown that never loads images), checks,
// comments and a comment box; a run its jobs, steps, summaries, earlier attempts and artifacts.
// Actions: Start a task from an issue (the desktop's Solve, with this computer's last agent and
// model), Comment, Open on GitHub. The desktop has no workflow re-run, so neither does the phone.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet } from 'react-native';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { githubComment, githubItem, githubStartTask, type IssueDetail, type RunDetail } from '../connect/api/github.ts';
import { Banner, Card, EmptyState, geometry, haptic, InnerCard, Row, Skeleton } from '../ui/ds/index.ts';
import { Glyph } from '../ui/FormParts.tsx';
import { Checks, CommentBox, RunJobs } from '../ui/github/ItemParts.tsx';
import { age, itemBadge, safeMarkdown } from '../ui/github/model.ts';
import { ItemHead } from '../ui/github/Rows.tsx';
import { harnessName } from '../ui/harness.tsx';
import { Description, OpenOnGitHub, Timeline } from '../ui/PullParts.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { noteUnsentStart, useNewTask } from '../ui/useNewTask.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
type Kind = 'issue' | 'pull' | 'run';
type Params = { device: string; project: string; kind: Kind; id: string; title?: string; url?: string };

function Loading() {
  return <Card><InnerCard style={styles.loading}><Skeleton width="85%" height={22} /><Skeleton width="50%" /><Skeleton width="70%" /></InnerCard></Card>;
}

function useItem(device: string, project: string, kind: Kind, id: number) {
  const [item, setItem] = useState<IssueDetail | RunDetail | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => (kind === 'run' ? githubItem(device, project, 'run', id) : githubItem(device, project, kind, id))
    .then((next: IssueDetail | RunDetail) => { setItem(next); setError(''); }, (e: Error) => setError(e.message)), [device, project, kind, id]);
  useEffect(() => { void load(); }, [load]);
  useReloadOnReconnect(device, load);
  return { item, error, load };
}

/** Start task from an issue with what New task would pick on this computer; confirmed first. */
function useStartFromIssue(device: string, project: string) {
  const form = useNewTask(device);
  const [starting, setStarting] = useState(false);
  const start = async (issue: IssueDetail) => {
    setStarting(true);
    haptic('medium');
    try {
      const effort = form.efforts.some(e => e.value === form.effort) ? form.effort ?? undefined : undefined;
      // One start per draft: a retry after a lost reply reuses its startId and follows it.
      const reply = await githubStartTask(device, project, issue.number, { provider: form.provider, model: form.model, mode: form.mode, effort });
      const { sessionId, note } = reply;
      router.push({ pathname: '/task/[device]/[session]', params: { device, session: sessionId } });
      // The host writes the issue's prompt itself, so there is no text to keep; the toast says what happened.
      noteUnsentStart(device, reply, '');
      if (note) Alert.alert('Started in a worktree', note.replace(/^Started in a worktree: /, ''));
    } catch (e) {
      haptic('error');
      Alert.alert('Could not start the task', (e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const confirm = (issue: IssueDetail) => {
    if (!form.provider) return Alert.alert('No agent to start', 'Install a coding agent on this computer, or start one from New task first.');
    const agent = [harnessName(form.provider), form.model === 'default' ? '' : form.model].filter(Boolean).join(' · ');
    Alert.alert(`Fix #${issue.number}?`, `${agent} starts a task on this issue: a new branch, the change, tests, and a summary.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start', onPress: () => void start(issue) },
    ]);
  };
  return { confirm, starting };
}

function IssueBody({ item, device, project, reload }: { item: IssueDetail; device: string; project: string; reload: () => Promise<void> }) {
  const canComment = useHostAllows(device, 'github.comment');
  const canStart = useHostAllows(device, 'github.startTask');
  const solve = useStartFromIssue(device, project);
  const comment = async (body: string) => {
    try {
      await githubComment(device, project, item.kind, item.number, body);
      haptic('success');
      await reload();
    } catch (e) {
      haptic('error');
      Alert.alert('Could not comment', (e as Error).message);
      throw e;
    }
  };
  const byline = [`#${item.number}`, item.author, age(item.createdAt) && `opened ${age(item.createdAt)} ago`, item.head && `${item.head} → ${item.base}`].filter(Boolean).join(' · ');
  const comments = item.comments.map(c => ({ kind: 'comment', author: c.author, body: safeMarkdown(c.body), state: '', createdAt: c.createdAt }));
  return (
    <>
      <ItemHead title={item.title} badge={itemBadge(item.state)} byline={byline} labels={item.labels} />
      {item.kind === 'issue' && item.state === 'open' && canStart && (
        <Card><InnerCard>
          <Row title={solve.starting ? 'Starting…' : 'Start task from issue'} disabled={solve.starting} leading={<Glyph icon={{ ios: 'sparkles', android: 'auto_awesome' }} />} onPress={() => solve.confirm(item)} chevron />
        </InnerCard></Card>
      )}
      {!!item.body.trim() && <Description body={safeMarkdown(item.body)} />}
      {item.checks && <Checks checks={item.checks} />}
      <Banner visible={item.earlierComments > 0} tone="info" title={`${item.earlierComments} earlier comment${item.earlierComments === 1 ? '' : 's'} on GitHub`} />
      {comments.length > 0 && <Timeline entries={comments} />}
      {canComment && <CommentBox onSend={comment} />}
      <AccessNote device={device} methods={item.kind === 'issue' && item.state === 'open' ? ['github.comment', 'github.startTask'] : ['github.comment']} />
      <OpenOnGitHub url={item.url} />
      <Banner visible={item.truncated} tone="info" title="Some of this was left out to fit. Open it on GitHub for the rest." />
    </>
  );
}

export default function GithubItemScreen() {
  const params = useLocalSearchParams<Params>();
  const { device = '', project = '' } = params;
  const kind: Kind = params.kind === 'pull' || params.kind === 'run' ? params.kind : 'issue';
  const id = Number(params.id);
  const scroll = usePushedScroll();
  const { item, error, load } = useItem(device, project, kind, id);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const navTitle = kind === 'run' ? 'Workflow run' : `#${id}`;

  const content = () => {
    if (!item) return error ? <EmptyState icon={ERROR_ICON} title="Couldn’t load this from GitHub" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} /> : <Loading />;
    if (item.kind === 'run') {
      return (
        <>
          <ItemHead title={params.title ?? `Run ${item.runId}`} byline={`Run ${item.runId}`} />
          <RunJobs run={item} />
          {params.url && <OpenOnGitHub url={params.url} />}
          <Banner visible={item.truncated} tone="info" title="Some jobs were left out to fit. Open the run on GitHub for the rest." />
        </>
      );
    }
    return <IssueBody item={item} device={device} project={project} reload={load} />;
  };
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: navTitle }} />
      <HeaderActions />
      <Banner visible={!!item && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: () => void load() }} />
      {content()}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset },
});
