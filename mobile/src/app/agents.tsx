// Everything working for one task: its team's workers (architect mode, task.team) and its
// subagents (the live subagent state), each with harness, status, elapsed time, what it is doing
// now and a one-line summary. A row opens that agent (agent.tsx).
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { memo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { glanceOf, elapsedLabel } from '../store/inbox.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { subagentActive, subagentName, summarizeTools, traceText, describeTool, type Subagent } from '../store/trace.ts';
import { workerActive, workerLabel, type Team, type TeamWorker } from '../store/team.ts';
import { outdated } from '../connect/rpc.ts';
import { useBackdrop } from '../ui/Backdrop.tsx';
import { HarnessLogo } from '../ui/harness.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ModelBadge } from '../ui/ToolCards.tsx';
import { StatusMark, useNow } from '../ui/Trace.tsx';
import { useColors } from '../ui/theme.ts';
import { useTeam, useWatchWorkers } from '../ui/useTeam.ts';

const NONE: Subagent[] = [];
const firstLine = (text: string) => text.split('\n').find(l => l.trim())?.replace(/[#*`>]/g, '').trim() ?? '';

/** A worker's status as the trace marks draw it (queued: a clock). */
export function WorkerMark({ worker, team }: { worker: TeamWorker; team: Team }) {
  const colors = useColors();
  const label = workerLabel(worker, team);
  if (label === 'Queued' || label === 'Paused') return <Icon ios="clock" android="schedule" size={13} color={colors.secondary} />;
  if (label === 'Skipped') return <Icon ios="forward" android="skip_next" size={13} color={colors.secondary} />;
  return <StatusMark status={worker.status === 'queued' ? 'running' : worker.status} color={colors.green} />;
}

/** The worker's one-line summary: its error, result, checkpoint, else its assignment. */
export const workerLine = (w: TeamWorker) => firstLine(w.error ?? '') || firstLine(w.summary) || firstLine(w.checkpoint?.summary ?? '') || firstLine(w.assignment);

const WorkerRow = memo(function WorkerRow({ deviceId, sessionId, worker, team, now }: { deviceId: string; sessionId: string; worker: TeamWorker; team: Team; now: number }) {
  const colors = useColors();
  const live = useConnect(s => (worker.sessionId ? s.live[taskKey(deviceId, worker.sessionId)] : undefined));
  const active = workerActive(worker);
  const activity = active ? glanceOf(live).activity : '';
  const label = workerLabel(worker, team);
  const elapsed = worker.createdAt ? elapsedLabel((active ? now : worker.updatedAt || now) - worker.createdAt) : '';
  const line = workerLine(worker);
  return (
    <Pressable onPress={() => router.push({ pathname: '/agent', params: { device: deviceId, session: sessionId, kind: 'worker', id: worker.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${worker.name}, ${label}${elapsed ? `, ${elapsed}` : ''}${activity ? `, ${activity}` : ''}`}>
      <View style={styles.logo}><HarnessLogo id={worker.provider} size={22} /></View>
      <View style={styles.flex}>
        <View style={styles.head}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{worker.name}</Text>
          <WorkerMark worker={worker} team={team} />
        </View>
        <View style={styles.head}>
          <ModelBadge provider="" model={worker.model} />
          <Text style={[styles.meta, { color: worker.status === 'failed' ? colors.red : colors.secondary }]} numberOfLines={1}>{[label, elapsed, worker.attempt > 1 && `attempt ${worker.attempt}`].filter(Boolean).join(' · ')}</Text>
        </View>
        {!!activity && <Text style={[styles.activity, { color: colors.tint }]} numberOfLines={1}>{activity}</Text>}
        {!!line && <Text style={[styles.line, { color: colors.secondary }]} numberOfLines={1}>{line}</Text>}
        {!!worker.checkpoint?.blocker && <Text style={[styles.line, { color: colors.orange }]} numberOfLines={1}>Blocked: {worker.checkpoint.blocker}</Text>}
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.tertiary} />
    </Pressable>
  );
});

const SubagentRow = memo(function SubagentRow({ deviceId, sessionId, agent, now }: { deviceId: string; sessionId: string; agent: Subagent; now: number }) {
  const colors = useColors();
  const live = subagentActive(agent);
  const current = agent.tools.findLast(t => t.status === 'running');
  const elapsed = agent.startedAt ? elapsedLabel((live ? now : agent.updatedAt || now) - agent.startedAt) : '';
  const line = !live && agent.response.trim() ? firstLine(agent.response) : firstLine(agent.prompt);
  return (
    <Pressable onPress={() => router.push({ pathname: '/agent', params: { device: deviceId, session: sessionId, kind: 'subagent', id: agent.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${subagentName(agent)}, ${agent.status}`}>
      <View style={styles.logo}><Icon ios="person.2" android="group" size={18} color={colors.secondary} /></View>
      <View style={styles.flex}>
        <View style={styles.head}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{subagentName(agent)}</Text>
          <StatusMark status={agent.status} color={colors.green} />
        </View>
        <Text style={[styles.meta, { color: agent.status === 'failed' ? colors.red : colors.secondary }]} numberOfLines={1}>
          {[elapsed, agent.tools.length ? summarizeTools(agent.tools) : ''].filter(Boolean).join(' · ') || agent.status}
        </Text>
        {current && <Text style={[styles.activity, { color: colors.tint }]} numberOfLines={1}>{traceText(describeTool(current))}</Text>}
        {!!line && <Text style={[styles.line, { color: colors.secondary }]} numberOfLines={1}>{line}</Text>}
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={12} color={colors.tertiary} />
    </Pressable>
  );
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  const backdrop = useBackdrop();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.secondary }]}>{title}</Text>
      <View style={[styles.group, { backgroundColor: backdrop.card }]}>{children}</View>
    </View>
  );
}

export default function AgentsScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const backdrop = useBackdrop();
  const team = useTeam(device, session);
  useWatchWorkers(device, team);
  const subagents = useConnect(s => s.live[taskKey(device, session)]?.subagents ?? NONE);
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const workers = team && team !== 'outdated' ? team.workers : [];
  const now = useNow(workers.some(workerActive) || subagents.some(subagentActive));
  const empty = !workers.length && !subagents.length;
  return (
    <ScrollView style={{ backgroundColor: backdrop.background }} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen options={{ title: 'Agents' }} />
      {team && team !== 'outdated' && workers.length > 0 && (
        <Section title={`Team workers${team.rounds.max ? ` · round ${team.rounds.used} of ${team.rounds.max}` : ''}`}>
          {workers.map(w => <WorkerRow key={w.id} deviceId={device} sessionId={session} worker={w} team={team} now={now} />)}
        </Section>
      )}
      {subagents.length > 0 && (
        <Section title="Subagents">
          {subagents.map(a => <SubagentRow key={a.id} deviceId={device} sessionId={session} agent={a} now={now} />)}
        </Section>
      )}
      {team === 'outdated' && <Text style={[styles.note, { color: colors.secondary }]}>{`Team workers: ${outdated(computer)}`}</Text>}
      {empty && team === undefined && <ActivityIndicator style={styles.spinner} />}
      {empty && team !== undefined && team !== 'outdated' && <Text style={[styles.note, { color: colors.secondary }]}>No agents are working for this task.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 18, paddingBottom: 40 },
  spinner: { marginTop: 80 },
  note: { fontSize: 15, textAlign: 'center', marginTop: 24, paddingHorizontal: 16 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3, paddingHorizontal: 6 },
  group: { borderRadius: 16, paddingHorizontal: 14, borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  pressed: { opacity: 0.6 },
  logo: { width: 28, alignItems: 'center' },
  flex: { flex: 1, gap: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 16, fontWeight: '600' },
  meta: { flexShrink: 1, fontSize: 13, fontVariant: ['tabular-nums'] },
  activity: { fontSize: 13.5, fontWeight: '500' },
  line: { fontSize: 13.5 },
});
