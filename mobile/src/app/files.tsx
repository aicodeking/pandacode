// One folder of a project's checkout (?device=&project=, or &session= for a task's own checkout,
// &path= the folder): folders first, then files, as on the desktop. A folder pushes another of
// these, so the native back button walks up and the bar's title is the folder; the title menu jumps
// to any folder above. Files open file.tsx; the bar's magnifying glass opens Search.
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text } from 'react-native';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { listFiles } from '../connect/api/files.ts';
import { outdated } from '../connect/rpc.ts';
import { crumbs, fileIcon, folderTitle } from '../store/files.ts';
import { EmptyState, geometry, Row, type } from '../ui/ds/index.ts';
import { Failed, glyph, Loading, ProjectPicker, styles as hub, useComputerName, useLoad, useProjects } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { CardSlice, PUSHED_HEADER, PushedList, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useIconSize } from '../ui/usePagePadding.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const FOLDER_ICON = glyph({ ios: 'folder', android: 'folder' });

interface StackRoute { name: string; params?: object }

/**
 * How to reach the folder `target` above this one: how many Files screens to pop, and whether the
 * screen then reached must be replaced (the folder lies above the first one pushed). Folders push
 * one screen each, so the folder is usually on the back stack; popping it keeps the stack true
 * (dismissTo's POP_TO rewrote this screen and left the deeper folders behind it).
 */
function foldersUp(routes: readonly StackRoute[], index: number, target: string): { pop: number; replace: boolean } {
  const pathOf = (route: StackRoute) => String((route.params as { path?: string } | undefined)?.path ?? '');
  let pop = 0;
  for (let at = index - 1; at >= 0 && routes[at]?.name === 'files'; at--) {
    pop++;
    if (pathOf(routes[at]) === target) return { pop, replace: false };
  }
  return { pop, replace: true };
}

export default function FilesScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string; path?: string }>();
  const device = params.device ?? '';
  const path = params.path ?? '';
  const session = params.session || undefined;
  const scroll = usePushedScroll();
  const colors = useColors();
  const size = useIconSize(20);
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'files.list');
  const searchable = useHostSupports(device, 'files.search');
  const [project, setProject] = useState(params.project || undefined);
  const { projects } = useProjects(device);
  const rootName = projects?.find(p => p.id === project)?.name ?? 'Files';
  const load = useCallback(() => listFiles(device, { projectId: project, sessionId: session }, path), [device, project, session, path]);
  const { value, error, reload } = useLoad(supported && (project || session) ? load : null, `${device}/${project}/${session}/${path}`);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };
  const base = { device, ...(project ? { project } : {}), ...(session ? { session } : {}) };
  const open = (entry: { path: string; dir: boolean }) =>
    router.push({ pathname: entry.dir ? '/files' : '/file', params: { ...base, path: entry.path } });
  const trail = crumbs(path, rootName).slice(0, -1);
  const navigation = useNavigation();
  const goUp = (target: string) => {
    const state = navigation.getState();
    const { pop, replace } = state ? foldersUp(state.routes as StackRoute[], state.index ?? state.routes.length - 1, target) : { pop: 0, replace: true };
    if (pop) router.dismiss(pop);
    if (replace) router.replace({ pathname: '/files', params: { ...base, path: target } });
  };

  const header = (
    <>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: folderTitle(path, rootName) }} />
      <HeaderActions right={[
        { kind: 'menu', label: 'Folders above', icon: { ios: 'arrow.turn.left.up', android: 'drive_folder_upload' }, hidden: !(project || session) || !trail.length,
          items: [...trail].reverse().map(c => ({ label: c.name, onPress: () => goUp(c.path) })) },
        { label: 'Search files', icon: { ios: 'magnifyingglass', android: 'search' }, hidden: !(project || session) || !searchable, onPress: () => router.push({ pathname: '/search', params: base }) },
      ]} />
    </>
  );
  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>{header}{children}</PushedScroll>
  );

  if (!supported) return page(<EmptyState icon={FOLDER_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project && !session) return page(<ProjectPicker device={device} onPick={setProject} purpose={`Browse a project on ${computer}`} />);
  if (!value) return page(error ? <Failed title="Couldn’t open this folder" error={error} retry={() => void reload()} /> : <Loading rows={6} />);
  if (!value.entries.length) return page(<EmptyState icon={FOLDER_ICON} title="This folder is empty" style={hub.empty} />);
  const entries = value.entries;
  // Up to 500 rows: only those on screen are mounted.
  return (
    <PushedList scroll={scroll} data={entries} keyExtractor={entry => entry.path} header={header}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      footer={value.truncated ? <Text style={[type.footnote, styles.note, { color: colors.muted }]}>Showing the first 500 items. Use Search to find the rest.</Text> : undefined}
      renderItem={({ item: entry, index }) => (
        <CardSlice first={index === 0} last={index === entries.length - 1}>
          <Row title={entry.name} chevron={entry.dir} onPress={() => open(entry)}
            leading={<Icon {...glyph(fileIcon(entry.name, entry.dir))} size={size} color={entry.dir ? colors.info : colors.muted} />}
            accessibilityHint={entry.dir ? 'Opens the folder' : 'Opens the file'} />
        </CardSlice>
      )} />
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: geometry.rowInset },
});
