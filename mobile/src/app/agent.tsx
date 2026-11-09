// One agent working for a task. A team worker: its assignment, checkpoint, result, files and its
// own transcript (task.workerMessages, refreshed while it runs, plus its live tools). A subagent:
// its prompt, tools and reply from the task's live subagent state.
import { Stack, useLocalSearchParams } from 'expo-router';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { connect } from '../connect/client.ts';
import type { Message, ToolActivity } from '../connect/types.ts';
import { elapsedLabel } from '../store/inbox.ts';
import { taskKey, useConnect, useModels, type LiveItem } from '../store/index.ts';
import { mergeMessages, prependMessages } from '../store/reduce.ts';
import { workerClockEnd, workerLabel, workerRunning, type Team, type TeamWorker } from '../store/team.ts';
import { parseToolMessage, subagentActive, subagentName, type Subagent } from '../store/trace.ts';
import { useColors } from '../ui/theme.ts';
import { Button, Card, CardSection, Chip, EmptyState, geometry, InnerCard, Skeleton, type as text } from '../ui/ds/index.ts';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { WorkerNamesContext } from '../ui/ToolCards.tsx';
import { ToolRow, useNow } from '../ui/Trace.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { modelLabel } from '../ui/models.ts';
import { useNames, useTeamLoad } from '../ui/useTeam.ts';
import { StateMark, WorkerMark } from './agents.tsx';

const REFRESH_MS = 5000;
const SHOWN_ROLES = new Set(['user', 'assistant', 'tool', 'system']);
const NO_TOOLS: readonly ToolItem[] = [];
const GONE_ICON = { ios: 'person.crop.circle.badge.questionmark', android: 'person_off' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

type ToolItem = Extract<LiveItem, { kind: 'tool' }>;
/** The tool items alone, so a streamed text delta doesn't change the selection. */
const toolItems = (items: readonly LiveItem[] | undefined): readonly ToolItem[] => items?.filter((i): i is ToolItem => i.kind === 'tool') ?? NO_TOOLS;

function Plain({ value, tone }: { value: string; tone?: 'muted' | 'warning' }) {
  const colors = useColors();
  return <Text selectable style={[text.subhead, { color: tone ? colors[tone] : colors.text }]}>{value}</Text>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <CardSection title={title}><View style={styles.inner}>{children}</View></CardSection>;
}

/** Parses a tool message only when that message changes. */
const TranscriptRow = memo(function TranscriptRow({ message }: { message: Message }) {
  const colors = useColors();
  const tool = useMemo(() => (message.role === 'tool' ? parseToolMessage(message.content) : null), [message]);
  if (tool) return <ToolRow tool={tool} />;
  if (message.role === 'user') return <View style={[styles.prompt, { backgroundColor: colors.fill }]}><Text selectable numberOfLines={12} style={[text.subhead, { color: colors.text }]}>{message.content}</Text></View>;
  return <Markdown text={message.content} />;
});

/** The worker's transcript: stored messages, then live tools the store doesn't hold yet. */
const Transcript = memo(function Transcript({ deviceId, sessionId, worker, team }: { deviceId: string; sessionId: string; worker: TeamWorker; team: Team }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState('');
  const running = workerRunning(worker, team);
  const live = useConnect(useShallow(s => toolItems(worker.sessionId ? s.live[taskKey(deviceId, worker.sessionId)]?.items : undefined)));
  const [hasOlder, setHasOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The newest id held, across refreshes (the component is keyed by worker).
  const last = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const after = last.current;
      return connect.workerMessages(deviceId, sessionId, worker.id, after).then(page => {
        if (!alive) return;
        if (!after) setHasOlder(page.hasOlder);
        setHasMore(page.hasMore);
        setError('');
        if (!page.messages.length) { setMessages(m => m ?? []); return; }
        last.current = Math.max(last.current, page.messages[page.messages.length - 1].id);
        setMessages(m => mergeMessages(m ?? [], page.messages));
      }, (e: Error) => { if (alive) setError(e.message); });
    };
    void load();
    const timer = running ? setInterval(load, REFRESH_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [deviceId, sessionId, worker.id, running]);
  const loadOlder = () => {
    const first = messages?.[0]?.id;
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    connect.olderWorkerMessages(deviceId, sessionId, worker.id, first).then(page => {
      setHasOlder(page.hasOlder);
      setMessages(m => prependMessages(m ?? [], page.messages));
      setError('');
    }, (e: Error) => setError(e.message)).finally(() => setLoadingOlder(false));
  };
  // The status card already says why it failed, so the transcript's closing line doesn't repeat it.
  const failure = worker.status === 'failed' ? worker.error?.trim() : undefined;
  const rows = useMemo(() => {
    const shown = (messages ?? []).filter(m => SHOWN_ROLES.has(m.role));
    return failure && shown.at(-1)?.content.trim() === failure ? shown.slice(0, -1) : shown;
  }, [messages, failure]);
  const stored = useMemo(() => new Set(rows.filter(m => m.role === 'tool').map(m => parseToolMessage(m.content).id).filter(Boolean)), [rows]);
  const liveTools = useMemo(() => live.filter(i => !stored.has(i.tool.id)), [live, stored]);
  if (error && !messages) return <Plain value={error} tone="muted" />;
  if (!messages) return <View style={styles.inner}><Skeleton width="80%" /><Skeleton width="60%" /></View>;
  if (!rows.length && !liveTools.length) return <Plain value="No messages yet." tone="muted" />;
  return (
    <>
      {hasOlder && <Button variant="plain" size="small" label="Load older messages" loading={loadingOlder} onPress={loadOlder} />}
      {!!error && <Plain value={error} tone="muted" />}
      {rows.map(m => <TranscriptRow key={m.id} message={m} />)}
      {liveTools.map(i => <ToolRow key={i.tool.id} tool={i.tool} startedAt={i.startedAt} endedAt={i.endedAt} />)}
      {hasMore && <Plain value="Newer messages were left out. Open this task on the computer to see them." tone="muted" />}
    </>
  );
});

/** The agent's state in one card: its status line and, when it failed, why. */
function StatusCard({ leading, label, failed, model, error }: { leading: ReactNode; label: string; failed: boolean; model?: string; error?: string }) {
  const colors = useColors();
  return (
    <Card>
      <InnerCard>
        <View style={styles.status}>
          {leading}
          <Text numberOfLines={1} style={[text.subhead, styles.statusText, { color: failed ? colors.danger : colors.muted }]}>{label}</Text>
          {!!model && <Chip label={model} style={styles.model} />}
        </View>
        {!!error && <View style={styles.statusError}><Plain value={error} /></View>}
      </InnerCard>
    </Card>
  );
}

function WorkerDetail({ deviceId, sessionId, worker, team }: { deviceId: string; sessionId: string; worker: TeamWorker; team: Team }) {
  const colors = useColors();
  const now = useNow(workerRunning(worker, team));
  const elapsed = worker.createdAt ? elapsedLabel(workerClockEnd(worker, team, now) - worker.createdAt) : '';
  const names = useNames(team);
  const deps = worker.dependsOn.map(id => names[id] || id);
  const checkpoint = worker.checkpoint;
  const models = useModels(deviceId, worker.provider);
  return (
    <>
      <Stack.Screen options={{ title: worker.name }} />
      <StatusCard failed={worker.status === 'failed'} model={worker.model ? modelLabel(worker.model, models) : harnessName(worker.provider)}
        label={[workerLabel(worker, team), elapsed, worker.attempt > 1 && `attempt ${worker.attempt}`].filter(Boolean).join(' · ')}
        leading={<><HarnessLogo id={worker.provider} size={20} /><WorkerMark worker={worker} team={team} /></>} error={worker.error ?? undefined} />
      {!!checkpoint && (
        <Section title="Checkpoint">
          {!!checkpoint.summary && <Plain value={checkpoint.summary} />}
          {!!checkpoint.nextSteps && <><Text style={[text.footnoteMedium, { color: colors.muted }]}>Next</Text><Plain value={checkpoint.nextSteps} /></>}
          {!!checkpoint.blocker && <><Text style={[text.footnoteMedium, { color: colors.warning }]}>Blocker</Text><Plain value={checkpoint.blocker} /></>}
        </Section>
      )}
      {!!worker.summary && <Section title="Summary"><Markdown text={worker.summary} /></Section>}
      {(worker.files.length > 0 || worker.readOnly || deps.length > 0) && (
        <Section title={worker.readOnly ? 'Files · read-only' : 'Files'}>
          <Text selectable style={[text.code, { color: colors.text }]}>{worker.files.length ? worker.files.join('\n') : 'Whole checkout'}</Text>
          {deps.length > 0 && <Text style={[text.footnote, { color: colors.muted }]}>{`After ${deps.join(', ')}`}</Text>}
        </Section>
      )}
      <Section title="Transcript">
        <WorkerNamesContext.Provider value={names}>
          <Transcript key={worker.id} deviceId={deviceId} sessionId={sessionId} worker={worker} team={team} />
        </WorkerNamesContext.Provider>
      </Section>
    </>
  );
}

function SubagentDetail({ agent }: { agent: Subagent }) {
  const active = subagentActive(agent);
  const now = useNow(active);
  const elapsed = agent.startedAt ? elapsedLabel((active ? now : agent.updatedAt || now) - agent.startedAt) : '';
  return (
    <>
      <Stack.Screen options={{ title: subagentName(agent) }} />
      <StatusCard failed={agent.status === 'failed'} label={[agent.status, elapsed].filter(Boolean).join(' · ')}
        leading={<StateMark status={agent.status} active={active} />} />
      {!!agent.prompt && <Section title="Prompt"><Plain value={agent.prompt} /></Section>}
      {agent.tools.length > 0 && <Section title="Tools">{agent.tools.map((t: ToolActivity) => <ToolRow key={t.id} tool={t} />)}</Section>}
      {!!agent.response.trim() && <Section title="Reply"><Markdown text={agent.response} /></Section>}
    </>
  );
}

export default function AgentScreen() {
  const { device = '', session = '', kind = 'worker', id = '' } = useLocalSearchParams<{ device: string; session: string; kind: string; id: string }>();
  const scroll = usePushedScroll();
  const { team, error, retry } = useTeamLoad(device, session, kind === 'worker');
  const worker = team && team !== 'outdated' ? team.workers.find(w => w.id === id) : undefined;
  const agent = useConnect(s => (kind === 'subagent' ? s.live[taskKey(device, session)]?.subagents?.find(a => a.id === id) : undefined));
  const asked = kind === 'worker' && team === undefined;
  return (
    <PushedScroll scroll={scroll}>
      <Stack.Screen options={PUSHED_HEADER} />
      {worker && team && team !== 'outdated' && <WorkerDetail deviceId={device} sessionId={session} worker={worker} team={team} />}
      {agent && <SubagentDetail agent={agent} />}
      {!worker && !agent && (
        asked && error ? <EmptyState icon={ERROR_ICON} title="Couldn’t load this agent" body={error} action={{ label: 'Retry', onPress: retry }} style={styles.empty} />
        : asked ? <Card><InnerCard style={styles.inner}><Skeleton width="60%" height={16} /><Skeleton width="85%" /></InnerCard></Card>
        : <EmptyState icon={GONE_ICON} title="This agent is no longer listed." style={styles.empty} />
      )}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: 48 },
  inner: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: geometry.rowHeight, paddingHorizontal: 12, paddingVertical: 6 },
  statusError: { paddingHorizontal: 12, paddingBottom: 10 },
  statusText: { flex: 1, fontVariant: ['tabular-nums'], textTransform: 'capitalize' },
  model: { alignSelf: 'center', flexShrink: 1, maxWidth: '45%' },
  prompt: { borderRadius: geometry.innerRadius, borderCurve: 'continuous', padding: 12 },
});
