// Everything working for one task: its team's workers (architect mode, task.team) and its
// subagents (the live subagent state), as cards with harness, status, model, elapsed time, what it
// is doing now and a one-line summary. A card opens that agent (agent.tsx).
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, Keyframe, LayoutAnimationConfig, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { connect } from '../connect/client.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import { elapsedLabel, glanceOf } from '../store/inbox.ts';
import { taskKey, useConnect, useModels } from '../store/index.ts';
import { cutNote, teamResumable, workerClockEnd, workerLabel, workerActive, workerRunning, workersTitle, type Team, type TeamWorker } from '../store/team.ts';
import { describeTool, subagentActive, subagentName, summarizeTools, traceText, type Subagent } from '../store/trace.ts';
import { useColors } from '../ui/theme.ts';
import { alpha, Banner, Button, Card, Chip, crossFadeIn, FADE_MS, useMotion, EmptyState, geometry, InnerCard, PressScale, Skeleton, springs, StatusDot, type as text, useStagger } from '../ui/ds/index.ts';
import { HarnessLogo } from '../ui/harness.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useNow } from '../ui/Trace.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useIconSize } from '../ui/usePagePadding.ts';
import { modelLabel } from '../ui/models.ts';
import { useTeamLoad, useWatchWorkers } from '../ui/useTeam.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const NONE: Subagent[] = [];
const MARK_POP = new Keyframe({ from: { opacity: 0, transform: [{ scale: 0.5 }] }, to: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.back(2)) } }).duration(FADE_MS).reduceMotion(ReduceMotion.Never);
const WRAP_SCALE = 1.3;
const METER_OPACITY = 0.6;
const WRAPPED_LINES = 3;
const firstLine = (value: string) => value.split('\n').find(l => l.trim())?.replace(/[#*`>]/g, '').trim() ?? '';
const AGENTS_ICON = { ios: 'person.2', android: 'group' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

/** A worker's status as a dot; a clock or a skip mark when it isn't doing anything. */
export function WorkerMark({ worker, team }: { worker: TeamWorker; team: Team }) {
  const colors = useColors();
  const size = useIconSize(15);
  const label = workerLabel(worker, team);
  if (label === 'Queued' || label === 'Paused') return <Icon ios="clock" android="schedule" size={size} color={colors.muted} />;
  if (label === 'Skipped') return <Icon ios="forward" android="skip_next" size={size} color={colors.muted} />;
  return <StateMark status={worker.status} active={workerActive(worker)} />;
}

/** Shape as well as colour: only live work pulses, done is a check and failed a cross. */
export function StateMark({ status, active }: { status: string; active: boolean }) {
  const colors = useColors();
  const size = useIconSize(15);
  if (status === 'failed') return <Icon ios="xmark.circle.fill" android="cancel" size={size} color={colors.danger} />;
  if (status === 'stopped') return <Icon ios="stop.circle" android="stop_circle" size={size} color={colors.muted} />;
  if (status === 'waiting') return <StatusDot tone="warning" pulse />;
  if (active) return <StatusDot tone="running" pulse />;
  return <Icon ios="checkmark.circle" android="check_circle" size={size} color={colors.success} />;
}

/** The worker's one-line summary: its error, result, checkpoint, else its assignment. */
export const workerLine = (w: TeamWorker) => firstLine(w.error ?? '') || firstLine(w.summary) || firstLine(w.checkpoint?.summary ?? '') || firstLine(w.assignment);

interface AgentCardProps {
  leading: ReactNode; name: string; mark: ReactNode; /** Changes when the status does, so the mark and its word animate. */ state: string; model?: string; meta: string; failed: boolean;
  activity?: string; line?: string; blocker?: string; label: string; onPress: () => void;
}

function AgentCard({ leading, name, mark, state, model, meta, failed, activity, line, blocker, label, onPress }: AgentCardProps) {
  const colors = useColors();
  // Large text gets the room to wrap rather than cut every line to a word or two.
  const { fontScale } = useWindowDimensions();
  const lines = fontScale > WRAP_SCALE ? WRAPPED_LINES : 1;
  const { reduced } = useMotion();
  return (
    <PressScale onPress={onPress} accessibilityLabel={label}>
      <InnerCard style={styles.agent}>
        <View style={styles.logo}>{leading}</View>
        <View style={styles.body}>
          <View style={styles.title}>
            <Text numberOfLines={lines} style={[text.bodyMedium, styles.name, { color: colors.text }]}>{name}</Text>
            <LayoutAnimationConfig skipEntering>
              <Animated.View key={state} entering={reduced ? crossFadeIn : MARK_POP}>{mark}</Animated.View>
            </LayoutAnimationConfig>
            <Icon ios="chevron.right" android="chevron_right" size={13} color={colors.glyphFaint} />
          </View>
          <View style={[styles.title, styles.wrap]}>
            {!!model && <Chip label={model} style={styles.model} />}
            <LayoutAnimationConfig skipEntering>
              <Animated.Text key={state} entering={crossFadeIn} numberOfLines={1} style={[text.footnote, styles.meta, { color: failed ? colors.danger : colors.muted }]}>{meta}</Animated.Text>
            </LayoutAnimationConfig>
          </View>
          {!!activity && <Text numberOfLines={lines} style={[text.footnoteMedium, { color: colors.running }]}>{activity}</Text>}
          {!!line && <Text numberOfLines={lines} style={[text.footnote, { color: colors.muted }]}>{line}</Text>}
          {!!blocker && <Text numberOfLines={lines} style={[text.footnote, { color: colors.warning }]}>{`Blocked: ${blocker}`}</Text>}
        </View>
      </InnerCard>
    </PressScale>
  );
}

const WorkerRow = memo(function WorkerRow({ deviceId, sessionId, worker, team, now }: { deviceId: string; sessionId: string; worker: TeamWorker; team: Team; now: number }) {
  const running = workerRunning(worker, team);
  const models = useModels(deviceId, worker.provider);
  const activity = useConnect(s => (running && worker.sessionId ? glanceOf(s.live[taskKey(deviceId, worker.sessionId)]).activity : ''));
  const label = workerLabel(worker, team);
  const elapsed = worker.createdAt ? elapsedLabel(workerClockEnd(worker, team, now) - worker.createdAt) : '';
  return (
    <AgentCard leading={<HarnessLogo id={worker.provider} size={22} />} name={worker.name} mark={<WorkerMark worker={worker} team={team} />} state={label} model={worker.model ? modelLabel(worker.model, models) : undefined}
      meta={[label, elapsed, worker.attempt > 1 && `attempt ${worker.attempt}`].filter(Boolean).join(' · ')} failed={worker.status === 'failed'}
      activity={activity} line={workerLine(worker)} blocker={worker.checkpoint?.blocker ?? undefined}
      label={`${worker.name}, ${label}${elapsed ? `, ${elapsed}` : ''}${activity ? `, ${activity}` : ''}`}
      onPress={() => router.push({ pathname: '/agent', params: { device: deviceId, session: sessionId, kind: 'worker', id: worker.id } })} />
  );
});

const SubagentRow = memo(function SubagentRow({ deviceId, sessionId, agent, now }: { deviceId: string; sessionId: string; agent: Subagent; now: number }) {
  const colors = useColors();
  const live = subagentActive(agent);
  const current = agent.tools.findLast(t => t.status === 'running');
  const elapsed = agent.startedAt ? elapsedLabel((live ? now : agent.updatedAt || now) - agent.startedAt) : '';
  const line = !live && agent.response.trim() ? firstLine(agent.response) : firstLine(agent.prompt);
  return (
    <AgentCard leading={<Icon ios="person.2" android="group" size={18} color={colors.muted} />} name={subagentName(agent)} mark={<StateMark status={agent.status} active={live} />} state={agent.status}
      meta={[elapsed, agent.tools.length ? summarizeTools(agent.tools) : ''].filter(Boolean).join(' · ') || agent.status} failed={agent.status === 'failed'}
      activity={current ? traceText(describeTool(current)) : undefined} line={line} label={`${subagentName(agent)}, ${agent.status}`}
      onPress={() => router.push({ pathname: '/agent', params: { device: deviceId, session: sessionId, kind: 'subagent', id: agent.id } })} />
  );
});

/** How much of the team is done; the fill follows a spring on transform only. */
function TeamProgress({ workers }: { workers: readonly TeamWorker[] }) {
  const colors = useColors();
  const counted = workers.filter(w => !w.abandoned);
  const done = counted.filter(w => w.status === 'completed').length;
  const failed = counted.filter(w => w.status === 'failed').length;
  const share = counted.length ? done / counted.length : 0;
  const fill = useSharedValue(share);
  useEffect(() => { fill.set(withSpring(share, springs.smooth)); }, [share, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.get() }] }));
  return (
    <View style={styles.progress}>
      <View accessible accessibilityRole="progressbar" accessibilityLabel="Workers finished" accessibilityValue={{ min: 0, max: counted.length, now: done }} style={[styles.meter, { backgroundColor: colors.fill }]}>
        <Animated.View style={[styles.meterFill, { backgroundColor: alpha(colors.text, METER_OPACITY) }, style]} />
      </View>
      <Text style={[text.footnote, styles.meta, { color: colors.faint }]}>
        {`${done} of ${counted.length} done`}
        {failed > 0 && <Text style={{ color: colors.danger }}>{` · ${failed} failed`}</Text>}
      </Text>
    </View>
  );
}

function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  const colors = useColors();
  return (
    <Card style={styles.section}>
      <Text accessibilityRole="header" numberOfLines={2} style={[text.subhead, styles.head, { color: colors.muted }]}>{title}</Text>
      {children}
      {footer}
    </Card>
  );
}

/** Why the team stopped or its lead is quiet, with Resume when it applies. */
function TeamStatus({ deviceId, sessionId, team }: { deviceId: string; sessionId: string; team: Team }) {
  const colors = useColors();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const canResume = useHostAllows(deviceId, 'task.teamResume');
  const resumable = teamResumable(team);
  if (!team.error && !resumable && !refused) return null;
  const resume = () => {
    setBusy(true);
    setRefused('');
    connect.resumeTeam(deviceId, sessionId).catch((error: Error) => setRefused(error.message)).finally(() => setBusy(false));
  };
  return (
    <Card>
      <InnerCard style={styles.status}>
        {!!team.error && <Text selectable style={[text.subhead, { color: team.status === 'failed' ? colors.danger : colors.muted }]}>{team.error}</Text>}
        {!!refused && <Text selectable style={[text.subhead, { color: colors.danger }]}>{refused}</Text>}
        {resumable && !canResume && <AccessNote device={deviceId} methods={['task.teamResume']} />}
        {resumable && canResume && <Button label={busy ? 'Resuming…' : 'Resume team'} icon={{ ios: 'play', android: 'play_arrow' }} loading={busy} onPress={resume} />}
      </InnerCard>
    </Card>
  );
}

function Loading() {
  return (
    <Card style={styles.section}>
      {[0, 1, 2].map(i => (
        <InnerCard key={i} style={styles.loading}>
          <Skeleton width="50%" height={16} />
          <Skeleton width="75%" />
        </InnerCard>
      ))}
    </Card>
  );
}

export default function AgentsScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const scroll = usePushedScroll();
  const { team, error, retry } = useTeamLoad(device, session);
  useWatchWorkers(device, team);
  const subagents = useConnect(s => s.live[taskKey(device, session)]?.subagents ?? NONE);
  const subagentsCut = useConnect(s => s.live[taskKey(device, session)]?.subagentsCut);
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const shown = team && team !== 'outdated' ? team : undefined;
  const workers = shown?.workers ?? [];
  const now = useNow(workers.some(w => workerRunning(w, shown)) || subagents.some(subagentActive));
  const empty = !workers.length && !subagents.length;
  const failed = team === undefined && !!error;
  const enter = useStagger(team !== undefined || !empty);
  const note = cutNote(team, subagentsCut);
  return (
    <PushedScroll scroll={scroll}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Agents' }} />
      <HeaderActions />
      {shown && <TeamStatus deviceId={device} sessionId={session} team={shown} />}
      <Banner visible={failed && !empty} title="Couldn’t load the team" body={error} action={{ label: 'Retry', onPress: retry }} />
      <Banner visible={team === 'outdated' && !empty} tone="info" title={`Team workers: ${outdated(computer)}`} />
      {shown && workers.length > 0 && (
        <Animated.View entering={enter(0)}>
          <Section title={workersTitle(shown)} footer={<TeamProgress workers={workers} />}>
            {workers.map(w => <WorkerRow key={w.id} deviceId={device} sessionId={session} worker={w} team={shown} now={now} />)}
          </Section>
        </Animated.View>
      )}
      {subagents.length > 0 && (
        <Animated.View entering={enter(1)}>
          <Section title="Subagents">
            {subagents.map(a => <SubagentRow key={a.id} deviceId={device} sessionId={session} agent={a} now={now} />)}
          </Section>
        </Animated.View>
      )}
      {!!note && <Text style={[text.footnote, styles.note, { color: colors.muted }]}>{note}</Text>}
      {empty && failed && <EmptyState icon={ERROR_ICON} title="Couldn’t load the agents" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />}
      {empty && !failed && team === undefined && <Loading />}
      {empty && team === 'outdated' && <EmptyState icon={AGENTS_ICON} title={`Team workers: ${outdated(computer)}`} style={styles.empty} />}
      {empty && team !== undefined && team !== 'outdated' && <EmptyState icon={AGENTS_ICON} title="No agents are working for this task." style={styles.empty} />}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  note: { textAlign: 'center', paddingHorizontal: geometry.rowInset },
  status: { padding: geometry.rowInset, gap: 10 },
  section: { gap: 6 },
  head: { paddingHorizontal: geometry.screenMargin, paddingTop: 6, paddingBottom: 4 },
  agent: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
  logo: { width: 26, height: text.bodyMedium.lineHeight, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 3 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexWrap: 'wrap' },
  name: { flex: 1 },
  model: { alignSelf: 'center', flexShrink: 1 },
  meta: { flexShrink: 1, fontVariant: ['tabular-nums'] },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: geometry.screenMargin, minHeight: 32 },
  meter: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { width: '100%', height: '100%', transformOrigin: 'left' },
  loading: { padding: geometry.rowInset, gap: 10 },
});
