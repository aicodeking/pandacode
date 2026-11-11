// The Design canvas's artboards (?device=&project=, or &session= for a task's own checkout, where
// agents usually draw them): one row per artboard with its open comments; a row opens design.tsx.
// The bar's menu switches between the project's checkout and its recent tasks' checkouts.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text } from 'react-native';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { listDesigns } from '../connect/api/design.ts';
import { outdated } from '../connect/rpc.ts';
import { EmptyState, geometry, Row, type } from '../ui/ds/index.ts';
import { artboardSubtitle, artboardTitle } from '../ui/design/geometry.ts';
import { Failed, glyph, Loading, ProjectPicker, RowsCard, styles as hub, useComputerName, useDeviceTasks, useLoad, useProjects } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useIconSize } from '../ui/usePagePadding.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const DESIGN_ICON = glyph({ ios: 'paintbrush.pointed', android: 'brush' });
/** Recent tasks the checkout menu offers. */
const MAX_TASKS = 12;

export default function DesignsScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const colors = useColors();
  const size = useIconSize(20);
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'design.list');
  const [project, setProject] = useState(params.project || undefined);
  const [session, setSession] = useState(params.session || undefined);
  const { projects } = useProjects(device);
  const tasks = useDeviceTasks(device, project).slice(0, MAX_TASKS);
  const where = session ? tasks.find(t => t.sessionId === session)?.title || 'Task' : projects?.find(p => p.id === project)?.name;
  const load = useCallback(() => listDesigns(device, { projectId: project, sessionId: session }), [device, project, session]);
  const { value, error, reload } = useLoad(supported && (project || session) ? load : null, `${device}/${project}/${session}`);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };
  const base = { device, ...(project ? { project } : {}), ...(session ? { session } : {}) };

  const header = (
    <>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Designs' }} />
      <HeaderActions right={[{ kind: 'menu', label: 'Checkout', icon: { ios: 'arrow.triangle.branch', android: 'account_tree' }, hidden: !project || !tasks.length, items: [
        { label: 'Project checkout', checked: !session, onPress: () => setSession(undefined) },
        ...tasks.map(t => ({ label: t.title || 'Untitled task', checked: t.sessionId === session, onPress: () => setSession(t.sessionId) })),
      ] }]} />
    </>
  );
  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>{header}{children}</PushedScroll>
  );

  if (!supported) return page(<EmptyState icon={DESIGN_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project && !session) return page(<ProjectPicker device={device} onPick={setProject} purpose={`Designs in a project on ${computer}`} />);
  if (!value) return page(error ? <Failed title="Couldn’t list the artboards" error={error} retry={() => void reload()} /> : <Loading rows={4} />);
  const whereNote = where ? <Text style={[type.footnote, styles.note, { color: colors.muted }]}>In {where}</Text> : null;
  if (!value.artboards.length) {
    return page(
      <>
        {whereNote}
        <EmptyState icon={DESIGN_ICON} title="No artboards here" body={tasks.length ? 'Agents draw artboards in their task’s checkout: pick a task from the menu above.' : 'Ask an agent to design something on the Design canvas.'} style={hub.empty} />
      </>,
    );
  }
  return page(
    <>
      {whereNote}
      <RowsCard>
        {value.artboards.map(board => {
          const open = value.open[board.name] ?? 0;
          return (
            <Row key={board.name} title={artboardTitle(board.name)} subtitle={artboardSubtitle(open, board.size)} chevron
              onPress={() => router.push({ pathname: '/design', params: { ...base, name: board.name } })}
              leading={<Icon {...DESIGN_ICON} size={size} color={open ? colors.orange : colors.muted} />}
              accessibilityHint="Opens the artboard" />
          );
        })}
      </RowsCard>
      {!value.preview && <Text style={[type.footnote, styles.note, { color: colors.muted }]}>Previews need PandaCode on a Mac. You can still read and resolve comments.</Text>}
    </>,
  );
}

const styles = StyleSheet.create({ note: { paddingHorizontal: geometry.rowInset } });
