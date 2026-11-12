// Skills and rules on one computer (?device=, optional &project= for project scope): the library
// PandaCode keeps, each with a switch per installed harness, as the desktop's Skills matrix. A skill
// with unreviewed safety findings can't be turned on from the phone: that review stays at the computer.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { setSkill, skillsList, type HarnessRow, type SkillItem, type SkillsList } from '../connect/api/tools.ts';
import { outdated } from '../connect/rpc.ts';
import { Banner, EmptyState, geometry, haptic, Row, Segmented, Toggle, type } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, styles as hub, useComputerName, useLoad, useProjects } from '../ui/hub/common.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const SKILL_ICON = glyph({ ios: 'sparkles', android: 'auto_awesome' });
type Scope = 'user' | 'project';
const SCOPES = [{ value: 'user', label: 'Everywhere' }, { value: 'project', label: 'This project' }] as const;
/** Off and missing are off; outdated or drifted copies still count as on. */
const isOn = (status: string | undefined) => !!status && status !== 'off';

/** A harness's name as the desktop shows it. */
const harnessName = (id: string) => ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', 'github-copilot': 'GitHub Copilot' } as Record<string, string>)[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

function SkillCard({ item, harnesses, scope, busy, readOnly, onToggle }: { item: SkillItem; harnesses: HarnessRow[]; scope: Scope; busy: string; readOnly: boolean; onToggle: (item: SkillItem, harness: string, on: boolean) => void }) {
  const colors = useColors();
  const blocked = !item.acknowledged;
  return (
    <CardTitled title={item.name} trailing={<Text style={[type.footnote, { color: colors.faint }]}>{item.kind === 'rule' ? 'Rule' : 'Skill'}</Text>}
      footer={blocked ? <Text style={[type.footnote, { color: colors.warning }]}>{`${item.findings} safety ${item.findings === 1 ? 'finding' : 'findings'} to review in PandaCode on the computer before turning it on.`}</Text> : undefined}>
      {!!item.description && <Text style={[type.subhead, styles.description, { color: colors.muted }]}>{item.description}</Text>}
      {harnesses.map(h => {
        const cell = h.cells.find(c => c.id === item.id && c.scope === scope);
        const on = isOn(cell?.status);
        const key = `${item.id}/${h.harness}`;
        return (
          <Row key={h.harness} title={harnessName(h.harness)} subtitle={cell && on && cell.status !== 'active' ? cell.status.charAt(0).toUpperCase() + cell.status.slice(1) : undefined} tone={cell?.status === 'drifted' || cell?.status === 'missing' ? 'warning' : undefined}
            trailing={<Toggle value={on} disabled={readOnly || busy === key || (blocked && !on)} onValueChange={next => onToggle(item, h.harness, next)} accessibilityLabel={`${item.name} for ${harnessName(h.harness)}`} />} />
        );
      })}
    </CardTitled>
  );
}

export default function SkillsScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'skills.list');
  const canSet = useHostAllows(device, 'skills.activate');
  const accessNote = useAccessNote(device, ['skills.activate']);
  const { projects } = useProjects(device);
  const project = params.project || undefined;
  const projectName = projects?.find(p => p.id === project)?.name;
  const [scope, setScope] = useState<Scope>('user');
  const load = useCallback(() => skillsList(device, project), [device, project]);
  const { value, error, reload } = useLoad(supported ? load : null, `${device}/${project}`);
  const [local, setLocal] = useState<SkillsList | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const shown = local && value && local.items === value.items ? local : value;
  const refresh = async () => { setRefreshing(true); setLocal(null); await reload(); setRefreshing(false); };

  const toggle = async (item: SkillItem, harness: string, on: boolean) => {
    if (!shown) return;
    const key = `${item.id}/${harness}`;
    setBusy(key);
    haptic('selection');
    // Shown at once; the host's answer (a reload) settles it.
    const status = on ? 'active' : 'off';
    setLocal({ ...shown, harnesses: shown.harnesses.map(h => (h.harness !== harness ? h : {
      ...h, cells: h.cells.some(c => c.id === item.id && c.scope === scope)
        ? h.cells.map(c => (c.id === item.id && c.scope === scope ? { ...c, status } : c))
        : [...h.cells, { id: item.id, scope, status, surface: '' }],
    })) });
    try {
      const result = await setSkill(device, { id: item.id, harness, scope, ...(scope === 'project' && project ? { projectId: project } : {}), active: on });
      setActionError(result.kept.length ? `Left ${result.kept.length} edited ${result.kept.length === 1 ? 'file' : 'files'} in place.` : '');
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy('');
      setLocal(null);
      void reload();
    }
  };

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Skills' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={SKILL_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!shown) return page(error ? <Failed title="Couldn’t read the skills" error={error} retry={() => void reload()} /> : <Loading rows={4} />);
  const installed = shown.harnesses.filter(h => h.installed && !h.prompt);
  if (!shown.items.length) return page(<EmptyState icon={SKILL_ICON} title="No skills yet" body={`Import skills and rules in PandaCode on ${computer}, then turn them on per harness here.`} style={hub.empty} />);
  return page(
    <>
      {project && <Segmented options={SCOPES.map(s => (s.value === 'project' && projectName ? { ...s, label: projectName } : s))} value={scope} onChange={setScope} accessibilityLabel="Where skills apply" />}
      <Banner visible={!!actionError} tone="danger" title="Couldn’t change that" body={actionError} />
      {!canSet && <Banner visible tone="info" title={accessNote ?? outdated(computer)} />}
      {shown.items.map(item => <SkillCard key={item.id} item={item} harnesses={installed} scope={scope} busy={busy} readOnly={!canSet} onToggle={toggle} />)}
      {shown.truncated && <Text style={[type.footnote, styles.description]}>Some skills are only listed on the computer.</Text>}
    </>,
  );
}

const styles = StyleSheet.create({
  description: { paddingHorizontal: geometry.rowInset, paddingTop: 8, paddingBottom: 4 },
});
