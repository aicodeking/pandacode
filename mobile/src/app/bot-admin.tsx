// A bot's settings (?device=&bot=), phone-first: status, people and held messages waiting on a decision,
// channels, schedules with Run now, rules, and memory (swipe to forget, with an Undo toast before the
// computer is told, as the queue does; a field to add). Reads bot.detail;
// secrets and channel configs stay on the computer. Actions the host lacks are hidden. A View phone's
// detail is limited (bot.detail sends counts, not schedules, rules or memories): one card shows the
// counts under an AccessNote instead of empty sections.
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { botDetail, decideFailover, decidePairing, forgetForBot, rememberForBot, runBotSchedule } from '../connect/api/admin.ts';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import {
  channelLine, channelName, channelTone, countLines, failoverLine, memoryError, pendingPairings, scheduleLine, untilText, withMemory, withoutFailover, withoutMemory, withoutPairing, type BotDetail,
} from '../store/admin.ts';
import { useConnect } from '../store/index.ts';
import { BotAvatar } from '../ui/BotRow.tsx';
import { Banner, Button, Card, CardSection, EmptyState, geometry, haptic, hideToast, InnerCard, Row, showToast, Skeleton, type as textStyle } from '../ui/ds/index.ts';
import { Decide, MemoryRow, ToneDot } from '../ui/admin/parts.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { ago } from '../ui/status.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const BOT_ICON = { ios: 'person.crop.circle', android: 'smart_toy' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
/** Bot actions a narrow grant keeps off, explained once by an AccessNote. */
const BOT_ACTIONS = ['bot.pairingDecide', 'bot.failoverDecide', 'bot.runSchedule', 'bot.remember', 'bot.forget'] as const;

/** Runs one action with a busy key and turns its error into the banner. */
function useAction(setError: (message: string) => void) {
  const [busy, setBusy] = useState('');
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
      haptic('success');
      setError('');
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return { busy, run };
}

function Status({ detail, now }: { detail: BotDetail; now: number }) {
  const colors = useColors();
  const { bot } = detail;
  const heartbeat = bot.heartbeatMinutes > 0 ? `Checks in every ${bot.heartbeatMinutes} min${bot.nextHeartbeatAt && !bot.paused ? `, next ${untilText(bot.nextHeartbeatAt, now)}` : ''}` : 'No check-ins';
  return (
    <Card>
      <View style={styles.head}>
        <BotAvatar bot={{ name: bot.name, avatar: bot.avatar || null }} size={48} />
        <View style={styles.headText}>
          <Text accessibilityRole="header" style={[textStyle.title3, { color: colors.text }]}>{bot.name}</Text>
          {!!bot.role && <Text numberOfLines={2} style={[textStyle.subhead, { color: colors.muted }]}>{bot.role}</Text>}
        </View>
      </View>
      <InnerCard>
        <Row title={bot.paused ? 'Paused' : 'Active'} tone={bot.paused ? 'warning' : 'success'} subtitle={heartbeat} leading={<ToneDot tone={bot.paused ? 'warning' : 'success'} />} />
        <Row title="Model" trailing={bot.model || bot.provider} />
        <Row title="Permissions" trailing={bot.mode} />
      </InnerCard>
    </Card>
  );
}

/** Forgetting a memory hides it at once and offers Undo; bot.forget goes to the computer only once
 * the toast goes away without Undo (its onDismiss: timed out, however long a screen reader keeps it,
 * or replaced), or another memory is forgotten, or the screen closes. */
function useDeferredForget(device: string, botId: string, change: (next: (d: BotDetail) => BotDetail) => void, reload: () => unknown) {
  const [hidden, setHidden] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  /** The Undo toast showing for the waiting forget, hidden when the screen closes. */
  const toastId = useRef<number | undefined>(undefined);
  /** Sends the waiting forget; with `id`, only if that one is still waiting (its own toast's dismissal). */
  const commit = useCallback((id?: string) => {
    const forgetting = pending.current;
    if (!forgetting || (id !== undefined && id !== forgetting)) return;
    pending.current = null;
    forgetForBot(device, botId, forgetting).then(
      () => { change(d => withoutMemory(d, forgetting)); setHidden(h => (h === forgetting ? null : h)); },
      (e: Error) => { haptic('error'); setHidden(null); Alert.alert('Couldn’t forget that', e.message); void reload(); },
    );
  }, [device, botId, change, reload]);
  // Leaving the screen hides its Undo toast (the root ToastHost outlives the screen) and sends a forget
  // still waiting on it. The toast's onDismiss commits first; commit() after it finds nothing waiting.
  useEffect(() => () => {
    const toast = toastId.current;
    toastId.current = undefined;
    if (toast !== undefined) hideToast(toast);
    commit();
  }, [commit]);
  const undo = () => {
    pending.current = null;
    setHidden(null);
    haptic('selection');
  };
  const forget = (id: string, content: string) => {
    commit();
    haptic('warning');
    setHidden(id);
    pending.current = id;
    toastId.current = showToast({ title: 'Memory forgotten', body: content.slice(0, 120), tone: 'info', icon: { ios: 'trash', android: 'delete' }, action: { label: 'Undo', onPress: undo }, onDismiss: () => commit(id) });
  };
  return { hidden, forget };
}

export default function BotAdminScreen() {
  const { device = '', bot: botId = '' } = useLocalSearchParams<{ device: string; bot: string }>();
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'that computer');
  const supported = useHostSupports(device, 'bot.detail');
  const can = {
    remember: useHostAllows(device, 'bot.remember'), forget: useHostAllows(device, 'bot.forget'), run: useHostAllows(device, 'bot.runSchedule'),
    pairing: useHostAllows(device, 'bot.pairingDecide'), failover: useHostAllows(device, 'bot.failoverDecide'),
  };
  const accessNote = useAccessNote(device, BOT_ACTIONS);
  const [detail, setDetail] = useState<BotDetail | null>(null);
  /** When the detail was read: "next in 5 min" counts from there. */
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState('');
  const { busy, run } = useAction(setActionError);
  const release = useDiscardGuard(!!draft.trim(), { message: 'The memory you typed isn’t added.' });

  const load = useCallback(() => botDetail(device, botId).then(d => { setDetail(d); setNow(Date.now()); setError(''); }, (e: Error) => setError(e.message)), [device, botId]);
  useFocusEffect(useCallback(() => { if (supported) void load(); }, [load, supported]));
  useReloadOnReconnect(device, () => (supported ? load() : undefined));
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  // Stable: useDeferredForget commits on unmount through it.
  const change = useCallback((next: (d: BotDetail) => BotDetail) => setDetail(d => (d ? next(d) : d)), []);

  const remember = () => run('remember', async () => {
    const problem = memoryError(draft);
    if (problem) throw new Error(problem);
    const memory = await rememberForBot(device, botId, draft.trim());
    change(d => withMemory(d, memory));
    release();
    setDraft('');
  });

  const { hidden: forgetting, forget } = useDeferredForget(device, botId, change, load);

  const pairings = detail ? pendingPairings(detail) : [];
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: detail?.bot.name ?? 'Bot settings' }} />
      <HeaderActions />
      {!supported && <EmptyState icon={BOT_ICON} title={outdated(computer)} style={styles.empty} />}
      {supported && !detail && !error && <Card><InnerCard style={styles.loading}><Skeleton width="60%" /><Skeleton width="40%" /><Skeleton width="70%" /></InnerCard></Card>}
      {supported && !detail && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the bot" body={error} action={{ label: 'Retry', onPress: () => void load() }} style={styles.empty} />}
      <Banner visible={!!detail && !!(error || actionError)} tone="danger" title={actionError ? 'That didn’t work' : 'Couldn’t refresh'} body={actionError || error} />
      {detail && <Status detail={detail} now={now} />}
      {detail && !detail.limited && <AccessNote device={device} methods={BOT_ACTIONS} />}

      {detail && (pairings.length > 0 || detail.failovers.length > 0) && (
        <CardSection title="Waiting for you">
          {pairings.map(p => {
            const channel = detail.channels.find(c => c.id === p.channelId);
            const key = `pair:${p.channelId}:${p.senderId}`;
            const decide = (decision: 'approved' | 'blocked') => run(key, async () => {
              await decidePairing(device, botId, p.channelId, p.senderId, decision);
              change(d => (decision === 'approved' ? { ...d, pairings: d.pairings.map(x => (x === p ? { ...x, status: 'approved' } : x)) } : withoutPairing(d, p.channelId, p.senderId)));
            });
            return (
              <View key={key}>
                <Row title={`${p.senderName || p.senderId} wants to talk`} subtitle={[channel ? channelName(channel) : '', p.code ? `code ${p.code}` : 'Approve on the computer or from a phone with Full access', ago(p.createdAt)].filter(Boolean).join(' · ')} />
                {/* Hosts send the code (and the whole sender id) only to devices that may decide. */}
                {can.pairing && !!p.code && <Decide yes="Approve" no="Block" busy={busy === key} onYes={() => void decide('approved')} onNo={() => void decide('blocked')} />}
              </View>
            );
          })}
          {detail.failovers.map(ask => {
            const key = `fail:${ask.sessionId}`;
            const decide = (action: 'send' | 'wait') => run(key, async () => {
              await decideFailover(device, ask.sessionId, action);
              change(d => withoutFailover(d, ask.sessionId));
            });
            return (
              <View key={key}>
                <Row title="A message is on hold" subtitle={failoverLine(ask, now)} />
                {can.failover && <Decide yes={`Send with ${ask.target.model}`} no="Wait" busy={busy === key} onYes={() => void decide('send')} onNo={() => void decide('wait')} />}
              </View>
            );
          })}
        </CardSection>
      )}

      {detail && (
        <CardSection title="Channels">
          {detail.channels.length === 0 && <Row title="No channels" subtitle="Connect Telegram, Slack and more on the computer." />}
          {detail.channels.map(c => <Row key={c.id} title={channelName(c)} subtitle={channelLine(c)} leading={<ToneDot tone={channelTone(c)} />} />)}
        </CardSection>
      )}

      {detail?.counts && (
        <CardSection title="Schedules, rules and memory">
          <AccessNote device={device} methods={BOT_ACTIONS} style={styles.limitedNote} />
          {countLines(detail.counts).map(line => <Row key={line} title={line} />)}
          {/* Without a grant note (the host didn't say which), still say why the lists are missing. */}
          {!accessNote && <Text style={[textStyle.footnote, styles.limitedText, { color: colors.muted }]}>This phone sees these only as counts. Give it Control or Full access on {computer} to see them.</Text>}
        </CardSection>
      )}

      {detail && !detail.limited && detail.schedules.length > 0 && (
        <CardSection title="Schedules">
          {detail.schedules.map(s => {
            const key = `run:${s.id}`;
            return (
              <Row key={s.id} title={s.title || s.prompt} subtitle={scheduleLine(s, now)}
                trailing={can.run ? <Button label="Run now" size="small" loading={busy === key} disabled={!!busy} onPress={() => void run(key, () => runBotSchedule(device, botId, s.id).then(() => undefined))} /> : undefined} />
            );
          })}
        </CardSection>
      )}

      {detail && !detail.limited && detail.rules.length > 0 && (
        <CardSection title="Rules">
          {detail.rules.map(r => <Row key={r.id} title={r.pattern} trailing={r.decision === 'allow' ? 'Allow' : r.decision === 'deny' ? 'Deny' : 'Ask'} />)}
        </CardSection>
      )}

      {detail && !detail.limited && (
        <CardSection title="Memory" trailing={<Text style={[textStyle.footnote, { color: colors.faint }]}>{detail.memories.length}</Text>}>
          {detail.memories.every(m => m.id === forgetting) && <Row title="Nothing remembered yet" />}
          {detail.memories.filter(m => m.id !== forgetting).map(m => (
            <MemoryRow key={m.id} content={m.content} meta={[m.source === 'agent' ? 'Learned' : 'Added', ago(m.createdAt)].join(' · ')}
              onForget={can.forget ? () => forget(m.id, m.content) : undefined} />
          ))}
          {can.remember && (
            <View style={styles.add}>
              <TextInput value={draft} onChangeText={setDraft} placeholder="Something to remember…" placeholderTextColor={colors.faint} multiline maxLength={2000}
                style={[textStyle.body, styles.input, { color: colors.text }]} accessibilityLabel="New memory" />
              <Button label="Add" size="small" variant="primary" loading={busy === 'remember'} disabled={!draft.trim()} onPress={() => void remember()} />
            </View>
          )}
        </CardSection>
      )}
      <Banner visible={!!detail?.truncated} tone="info" title="Some items were left out to fit." />
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  empty: { marginTop: geometry.emptyTop },
  loading: { padding: geometry.rowInset, gap: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: geometry.rowInset },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  add: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
  input: { flex: 1, minHeight: 36, maxHeight: 120 },
  limitedNote: { margin: geometry.rowInset, marginBottom: 0 },
  limitedText: { paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
});
