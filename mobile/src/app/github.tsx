// GitHub on one computer (?device=, optional ?project=), like the desktop's GitHub view: the
// project's repository (picked from the bar's menu among the computer's projects with a GitHub
// remote), then Issues / Pull requests / Actions. The native search filters the loaded rows; its
// Search button also asks GitHub (github.search). Rows open github-item.tsx.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet } from 'react-native';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { githubIssues, githubPulls, githubRepos, githubRuns, githubSearch, type GithubRepo, type HubIssue, type HubPull, type HubRun, type SearchItem } from '../connect/api/github.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import { Banner, Card, EmptyState, geometry, InnerCard, Segmented, Skeleton } from '../ui/ds/index.ts';
import { filterRows, TABS, type GithubTab } from '../ui/github/model.ts';
import { IssueRow, ItemHead, PullRow, RowsCard, RunRow, SearchRow, SectionLabel } from '../ui/github/Rows.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const GITHUB_ICON = { ios: 'chevron.left.forwardslash.chevron.right', android: 'code' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const EMPTY_ICON = { ios: 'tray', android: 'inbox' } as const;

type Rows = { issues: HubIssue[]; pulls: HubPull[]; runs: HubRun[] };
type Loaded<K extends GithubTab> = { project: string; items: Rows[K] } | { project: string; error: string };
type Loads = { [K in GithubTab]?: Loaded<K> };
const LOADERS: { [K in GithubTab]: (device: string, project: string) => Promise<Rows[K]> } = { issues: githubIssues, pulls: githubPulls, runs: githubRuns };
const EMPTY: Record<GithubTab, string> = { issues: 'No open issues.', pulls: 'No open pull requests.', runs: 'No workflow runs yet.' };

function Loading() {
  return <Card><InnerCard style={styles.loading}><Skeleton width="80%" /><Skeleton width="55%" /><Skeleton width="70%" /><Skeleton width="45%" /></InnerCard></Card>;
}

export default function GithubScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const supported = useHostSupports(device, 'github.repos');
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState('');
  const [pick, setPick] = useState(params.project);
  const [tab, setTab] = useState<GithubTab>('issues');
  const [loads, setLoads] = useState<Loads>({});
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; items: SearchItem[] } | null>(null);
  const [searchError, setSearchError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const repo = repos?.find(r => r.projectId === pick) ?? repos?.[0];
  const project = repo?.projectId ?? '';

  const loadRepos = useCallback(() => githubRepos(device).then(list => { setRepos(list); setReposError(''); }, (e: Error) => setReposError(e.message)), [device]);
  useEffect(() => { if (supported) void loadRepos(); }, [loadRepos, supported]);

  const loadTab = useCallback(async <K extends GithubTab>(name: K, id: string) => {
    try {
      const items = await LOADERS[name](device, id);
      setLoads(l => ({ ...l, [name]: { project: id, items } }));
    } catch (e) {
      setLoads(l => ({ ...l, [name]: { project: id, error: (e as Error).message } }));
    }
  }, [device]);
  const current = loads[tab];
  const stale = !current || current.project !== project;
  useEffect(() => { if (project && stale) void loadTab(tab, project); }, [project, tab, stale, loadTab]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadRepos(), project ? loadTab(tab, project) : undefined]);
    setRefreshing(false);
  };
  useReloadOnReconnect(device, () => (supported ? Promise.all([loadRepos(), project ? loadTab(tab, project) : undefined]) : undefined));
  const search = async (text: string) => {
    const q = text.trim();
    if (!q || !project) return;
    try {
      setFound({ query: q, items: await githubSearch(device, project, q) });
      setSearchError('');
    } catch (e) {
      setSearchError((e as Error).message);
    }
  };
  const choose = (id: string) => { setPick(id); setLoads({}); setFound(null); };

  const header = (
    <>
      <Stack.Screen options={{
        ...PUSHED_HEADER, title: 'GitHub',
        headerSearchBarOptions: project ? {
          placeholder: 'Filter or search GitHub', autoCapitalize: 'none', hideWhenScrolling: false,
          onChangeText: event => { setQuery(event.nativeEvent.text); if (!event.nativeEvent.text) setFound(null); },
          onSearchButtonPress: event => void search(event.nativeEvent.text),
          onCancelButtonPress: () => { setQuery(''); setFound(null); },
        } : undefined,
      }} />
      <HeaderActions right={[{ kind: 'menu', label: 'Repository', icon: { ios: 'folder', android: 'folder' }, hidden: !repos || repos.length < 2,
        items: (repos ?? []).map(r => ({ label: r.projectName, subtitle: r.repo, checked: r.projectId === project, onPress: () => choose(r.projectId) })) }]} />
    </>
  );
  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>{header}{children}</PushedScroll>
  );

  if (!supported) return page(<EmptyState icon={GITHUB_ICON} title={outdated(computer)} style={styles.empty} />);
  if (!repos) return page(reposError ? <EmptyState icon={ERROR_ICON} title="Couldn’t read the projects" body={reposError} action={{ label: 'Retry', onPress: () => void loadRepos() }} style={styles.empty} /> : <Loading />);
  if (!repo) return page(<EmptyState icon={GITHUB_ICON} title="No GitHub projects" body={`None of the projects on ${computer} has a GitHub remote.`} style={styles.empty} />);

  const to = { device, project };
  const body = () => {
    if (stale) return <Loading />;
    if ('error' in current) return <EmptyState icon={ERROR_ICON} title="Couldn’t reach GitHub" body={current.error} action={{ label: 'Retry', onPress: () => void loadTab(tab, project) }} style={styles.empty} />;
    const rows = filterRows<HubIssue | HubPull | HubRun>(current.items, query);
    if (!rows.length) return <EmptyState icon={EMPTY_ICON} title={query ? 'Nothing here matches.' : EMPTY[tab]} body={query && tab !== 'runs' ? 'Tap Search to ask GitHub.' : undefined} style={styles.empty} />;
    return <RowsCard rows={rows} keyOf={row => String('id' in row ? row.id : row.number)} render={row => (
      tab === 'issues' ? <IssueRow issue={row as HubIssue} to={to} /> : tab === 'pulls' ? <PullRow pull={row as HubPull} to={to} /> : <RunRow run={row as HubRun} to={to} />
    )} />;
  };
  return page(
    <>
      <ItemHead title={repo.repo} byline={repo.projectName === repo.repo.split('/')[1] ? computer : `${repo.projectName} on ${computer}`} />
      <Segmented options={TABS} value={tab} onChange={setTab} accessibilityLabel="GitHub sections" />
      <Banner visible={!!searchError} tone="danger" title="Couldn’t search GitHub" body={searchError} />
      {found && found.query === query.trim() && (
        <>
          <SectionLabel>{found.items.length ? `On GitHub for “${found.query}”` : `Nothing on GitHub for “${found.query}”`}</SectionLabel>
          {found.items.length > 0 && <RowsCard rows={found.items} keyOf={item => `${item.kind}${item.number}`} render={item => <SearchRow item={item} to={to} />} />}
        </>
      )}
      {body()}
    </>,
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: geometry.rowInset, marginTop: geometry.sectionGap / 2 },
});
