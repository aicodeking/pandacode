// Workflow recipes for a project (?device=&project=, or &session= from a task): the saved recipes,
// project and global. Pick one and a task of that project to see the dry run against the task's
// harness (supported, fallback, manual or blocked per step), then Run queues one message per step,
// as the desktop's Run does. Recipes are written on the computer.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { recipePlan, recipesList, runRecipe, type Recipe, type RecipePlan, type StepReport } from '../connect/api/tools.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import { Banner, Button, EmptyState, geometry, haptic, Row, type, type Tone } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, ProjectPicker, styles as hub, TaskPicker, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const RECIPE_ICON = glyph({ ios: 'list.bullet.rectangle', android: 'checklist' });
const STATUS: Record<StepReport['status'], { label: string; tone?: Tone }> = {
  supported: { label: 'Supported', tone: 'success' }, fallback: { label: 'Fallback', tone: 'warning' }, manual: { label: 'Manual', tone: 'info' }, blocked: { label: 'Blocked', tone: 'danger' },
};
const STEP_KIND: Record<string, string> = { prompt: 'Prompt', slash: 'Command', check: 'Check', approval: 'Approval' };

function Steps({ recipe, plan }: { recipe: Recipe; plan: RecipePlan | null }) {
  const colors = useColors();
  return recipe.steps.map((step, i) => {
    const report = plan?.steps[i];
    const status = report ? STATUS[report.status] : null;
    return (
      <Row key={i} title={(step.kind === 'slash' ? step.command : step.text) || STEP_KIND[step.kind] || step.kind}
        subtitle={[`${i + 1}. ${STEP_KIND[step.kind] ?? step.kind}`, status?.label, report?.reason].filter(Boolean).join(' · ')} tone={status?.tone}
        leading={<Text style={[type.subhead, { color: colors.faint }]}>{i + 1}</Text>} />
    );
  });
}

export default function RecipesScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'recipes.list');
  const canRun = useHostAllows(device, 'recipes.run');
  const sessionProject = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === params.session)?.projectId);
  const [project, setProject] = useState(params.project || sessionProject || undefined);
  const [session, setSession] = useState(params.session || '');
  const [picked, setPicked] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ key: string; plan?: RecipePlan; error?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState('');
  const [runError, setRunError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => recipesList(device, { projectId: project }), [device, project]);
  const { value, error, reload } = useLoad(supported && project ? load : null, `${device}/${project}`);
  const recipe = value?.find(r => r.name === picked) ?? null;
  const planKey = `${session}/${picked}`;
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };

  useEffect(() => {
    if (!session || !picked) return;
    let live = true;
    recipePlan(device, session, picked).then(p => { if (live) setPlan({ key: planKey, plan: p }); }, (e: Error) => { if (live) setPlan({ key: planKey, error: e.message }); });
    return () => { live = false; };
  }, [device, session, picked, planKey]);
  const current = plan?.key === planKey ? plan : null;

  const run = async () => {
    if (!picked || !session) return;
    setRunning(true); setRunError(''); setResult('');
    try {
      const { sent, queued } = await runRecipe(device, session, picked);
      haptic('success');
      setResult(`Sent ${sent} and queued ${queued} ${queued === 1 ? 'message' : 'messages'}.`);
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={project ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: recipe ? recipe.name : 'Recipes' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={RECIPE_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project) return page(<ProjectPicker device={device} onPick={setProject} purpose="Recipes of" />);
  if (!value) return page(error ? <Failed title="Couldn’t read the recipes" error={error} retry={() => void reload()} /> : <Loading rows={3} />);
  if (!value.length) return page(<EmptyState icon={RECIPE_ICON} title="No recipes yet" body={`Recipes are saved in PandaCode on ${computer} (a task’s Recipes panel), or as JSON in .pandacode/recipes.`} style={hub.empty} />);

  if (!recipe) {
    return page(
      <CardTitled title="Recipes">
        {value.map(r => (
          <Row key={`${r.scope}/${r.name}`} title={r.name} subtitle={[r.description, `${r.steps.length} ${r.steps.length === 1 ? 'step' : 'steps'}`].filter(Boolean).join(' · ')}
            trailing={r.scope === 'global' ? 'Global' : 'Project'} chevron onPress={() => { setPicked(r.name); setResult(''); setRunError(''); }}
            leading={<Icon ios="list.bullet.rectangle" android="checklist" size={20} color={colors.muted} />} />
        ))}
      </CardTitled>,
    );
  }
  const blocked = !current?.plan || current.plan.blocked;
  return page(
    <>
      {!!recipe.description && <Text style={[type.subhead, styles.description, { color: colors.muted }]}>{recipe.description}</Text>}
      <CardTitled title={session ? 'Dry run' : 'Steps'}><Steps recipe={recipe} plan={current?.plan ?? null} /></CardTitled>
      {current?.error && <Banner visible tone="danger" title="Couldn’t check this recipe" body={current.error} />}
      {session && canRun && (
        <Button label={running ? 'Queuing…' : `Run ${current?.plan ? current.plan.count : ''} ${current?.plan?.count === 1 ? 'step' : 'steps'}`.replace('  ', ' ')} variant="primary" loading={running || (!current?.plan && !current?.error)}
          disabled={blocked} onPress={() => void run()} icon={{ ios: 'play.fill', android: 'play_arrow' }} />
      )}
      {session && !canRun && <AccessNote device={device} methods={['recipes.run']} />}
      <Banner visible={!!runError} tone="danger" title="Couldn’t run the recipe" body={runError} />
      <Banner visible={!!result} tone="success" title={result} icon={{ ios: 'checkmark.circle', android: 'check_circle' }}
        action={{ label: 'Open task', onPress: () => router.push({ pathname: '/task/[device]/[session]', params: { device, session } }) }} />
      <TaskPicker device={device} projectId={project} selected={session} onPick={id => { setSession(id); setResult(''); setRunError(''); }} purpose={session ? 'Run in' : 'Choose a task to run it in'} />
      <Button label="All recipes" variant="plain" onPress={() => setPicked(null)} />
    </>,
  );
}

const styles = StyleSheet.create({
  description: { paddingHorizontal: geometry.rowInset },
});
