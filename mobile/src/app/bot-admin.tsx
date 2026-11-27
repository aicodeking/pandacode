// A bot's settings (?device=&bot=), phone-first: status, people and held messages waiting on a decision,
// channels, schedules (Run now, add, delete), rules (add, delete), memory (swipe to forget, with an Undo
// toast before the computer is told, as the queue does; a field to add), the audit trail, and the bot's
// own settings with Reset and Delete. Reads bot.detail and bot.activity; secrets and channel configs stay
// on the computer. Actions the host lacks are hidden. A View phone's detail is limited (bot.detail sends
// counts, not schedules, rules or memories): one card shows the counts under an AccessNote instead of
// empty sections.
//
// Every managing action is in the `bots` group (`src-tauri/src/remote/methods/bots.rs`) and needs BOTH a
// Full grant and the computer's "Full access for remote tasks" switch, because a bot takes untrusted
// input from outside and then acts on the computer. The bot's brief (instructions, goals, soul) is not
// editable here at all: the host refuses it from a phone, so the Edit sheet offers only the safe settings
// and shows the brief read-only.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  addBotRule, botActivity, botDetail, createBotSchedule, decideFailover, decidePairing, deleteBot, deleteBotRule, deleteBotSchedule,
  editBot, forgetForBot, rememberForBot, resetBot, runBotSchedule, setBotScheduleEnabled, type BotScheduleInput, type RuleDecision,
} from '../connect/api/admin.ts';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import {
  activityLine, activityTone, BOT_MODES, changedPatch, channelLine, channelName, channelTone, countLines, failoverLine, fullModeNote, memoryError,
  patchEmpty, pendingPairings, scheduleLine, untilText, withMemory, withoutFailover, withoutMemory, withoutPairing,
  type BotActivity, type BotDetail, type BotEditPatch,
} from '../store/admin.ts';
import { useConnect } from '../store/index.ts';
import { BotAvatar } from '../ui/BotRow.tsx';
import { Banner, Button, Card, CardSection, EmptyState, geometry, haptic, hideToast, InnerCard, Row, showToast, Skeleton, type as textStyle } from '../ui/ds/index.ts';
import { Decide, MemoryRow, ToneDot } from '../ui/admin/parts.tsx';
import { Choice } from '../ui/Choice.tsx';
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
/** Managing a bot: worse than a narrow grant — these need Full AND the computer's switch. */
const MANAGE_ACTIONS = ['bot.edit', 'bot.reset', 'bot.delete', 'bot.ruleAdd', 'bot.ruleDelete', 'bot.scheduleCreate', 'bot.scheduleSetEnabled', 'bot.scheduleDelete'] as const;
/** Activity rows asked for at a time. */
const ACTIVITY_PAGE = 50;
/** A rule's longest pattern (the desktop caps it at 200). */
const MAX_PATTERN = 200;
const MAX_SCHEDULE_PROMPT = 8000;
const SCHEDULE_KINDS = [
  { value: 'interval', label: 'Every N minutes' }, { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' }, { value: 'once', label: 'Once' },
];
const RULE_DECISIONS = [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }];
const MODES = BOT_MODES.map(mode => ({ value: mode.value, label: mode.label }));

/** A destructive action behind a native confirm, so nothing irreversible happens on one tap. */
function confirmThen(title: string, body: string, confirm: string, action: () => void) {
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirm, style: 'destructive', onPress: action },
  ]);
}

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
  // Managing the bot is a separate bar: Full grant AND the computer's "Full access for remote tasks".
  const manage = {
    edit: useHostAllows(device, 'bot.edit'), reset: useHostAllows(device, 'bot.reset'), delete: useHostAllows(device, 'bot.delete'),
    ruleAdd: useHostAllows(device, 'bot.ruleAdd'), ruleDelete: useHostAllows(device, 'bot.ruleDelete'),
    scheduleCreate: useHostAllows(device, 'bot.scheduleCreate'), scheduleDelete: useHostAllows(device, 'bot.scheduleDelete'),
    scheduleToggle: useHostAllows(device, 'bot.scheduleSetEnabled'),
  };
  const manageNote = useAccessNote(device, MANAGE_ACTIONS);
  const canManage = manage.edit;
  // Raising a bot to full access needs the computer's switch, not just this phone's grant.
  const caps = useHostCapabilities(device);
  const canManageFullMode = caps?.kind === 'hello' ? caps.remoteFullAccess : false;
  const accessNote = useAccessNote(device, BOT_ACTIONS);
  const [detail, setDetail] = useState<BotDetail | null>(null);
  /** When the detail was read: "next in 5 min" counts from there. */
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState<BotActivity[] | null>(null);
  const [activityMore, setActivityMore] = useState(false);
  const [pattern, setPattern] = useState('');
  const [decision, setDecision] = useState<RuleDecision>('ask');
  const [schedule, setSchedule] = useState<{ title: string; prompt: string; kind: BotScheduleInput['kind']; timeOfDay: string }>({ title: '', prompt: '', kind: 'daily', timeOfDay: '09:00' });
  const [editing, setEditing] = useState<BotEditPatch | null>(null);
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

  // ---- managing the bot (every one needs the manage bar) ----
  // The trail is read once the bot's detail arrives. The fetch resolves asynchronously, so this effect
  // never sets state during render; `activity === null` is the "not asked yet" marker.
  useEffect(() => {
    if (!supported || !detail || activity !== null) return;
    let live = true;
    void botActivity(device, botId, undefined, ACTIVITY_PAGE).then(
      page => { if (!live) return; setActivity(page.activity); setActivityMore(page.truncated); },
      (e: Error) => { if (!live) return; setActivity([]); setActionError(e.message); },
    );
    return () => { live = false; };
  }, [supported, detail, activity, device, botId]);

  const older = () => run('activity', async () => {
    const oldest = activity?.at(-1)?.id;
    if (!oldest) return;
    const page = await botActivity(device, botId, oldest, ACTIVITY_PAGE);
    setActivity(current => [...(current ?? []), ...page.activity]);
    setActivityMore(page.truncated);
  });

  const saveRules = () => run('rule', async () => {
    const text = pattern.trim();
    if (text.length < 2) throw new Error('A rule needs a pattern of at least two characters.');
    await addBotRule(device, botId, text.slice(0, MAX_PATTERN), decision);
    setPattern('');
    await load();
  });
  const removeRule = (ruleId: string) => run(`rule:${ruleId}`, async () => { await deleteBotRule(device, botId, ruleId); await load(); });

  const addSchedule = () => run('schedule', async () => {
    if (!schedule.prompt.trim()) throw new Error('A schedule needs a prompt: what should the bot do?');
    const input: BotScheduleInput = { title: schedule.title.trim(), prompt: schedule.prompt.trim().slice(0, MAX_SCHEDULE_PROMPT), kind: schedule.kind };
    if (schedule.kind === 'daily' || schedule.kind === 'weekdays') input.timeOfDay = schedule.timeOfDay;
    await createBotSchedule(device, botId, input);
    setSchedule({ title: '', prompt: '', kind: 'daily', timeOfDay: '09:00' });
    await load();
  });
  const toggleSchedule = (scheduleId: string, enabled: boolean) => run(`toggle:${scheduleId}`, async () => { await setBotScheduleEnabled(device, botId, scheduleId, enabled); await load(); });
  const removeSchedule = (scheduleId: string) => run(`schedule:${scheduleId}`, async () => { await deleteBotSchedule(device, botId, scheduleId); await load(); });

  const saveEdit = () => run('edit', async () => {
    if (!detail || !editing) return;
    const patch = changedPatch(detail.bot, editing);
    if (patchEmpty(patch)) throw new Error('Nothing changed.');
    const note = patch.mode ? fullModeNote(patch.mode, canManageFullMode) : null;
    if (note) throw new Error(note);
    await editBot(device, botId, patch);
    setEditing(null);
    await load();
  });

  const reset = () => confirmThen(
    'Reset this bot?',
    'Its conversations, memories, schedules and activity are deleted. The bot itself, its settings and its workspace stay.',
    'Reset',
    () => run('reset', async () => { await resetBot(device, botId); await load(); setActivity(null); }),
  );
  const remove = () => confirmThen(
    'Delete this bot?',
    'The bot and its records are removed. Its workspace folder stays on disk.',
    'Delete',
    () => run('delete', async () => { await deleteBot(device, botId); router.back(); }),
  );

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

      {detail && !detail.limited && (
        <CardSection title="Schedules" trailing={<Text style={[textStyle.footnote, { color: colors.faint }]}>{detail.schedules.length}</Text>}>
          {detail.schedules.length === 0 && <Row title="No schedules" subtitle={manage.scheduleCreate ? 'Add one below.' : 'Add one on the computer.'} />}
          {detail.schedules.map(s => {
            const runKey = `run:${s.id}`, delKey = `schedule:${s.id}`, toggleKey = `toggle:${s.id}`;
            return (
              <Row key={s.id} title={s.title || s.prompt} subtitle={scheduleLine(s, now)}
                trailing={
                  <View style={styles.rowActions}>
                    {can.run && <Button label="Run now" size="small" loading={busy === runKey} disabled={!!busy} onPress={() => void run(runKey, () => runBotSchedule(device, botId, s.id).then(() => undefined))} />}
                    {manage.scheduleToggle && <Button label={s.enabled ? 'Turn off' : 'Turn on'} size="small" loading={busy === toggleKey} disabled={!!busy} onPress={() => toggleSchedule(s.id, !s.enabled)} />}
                    {manage.scheduleDelete && <Button label="Delete" size="small" variant="destructive" loading={busy === delKey} disabled={!!busy} onPress={() => removeSchedule(s.id)} />}
                  </View>
                } />
            );
          })}
          {manage.scheduleCreate && (
            <View style={styles.form}>
              <TextInput value={schedule.title} onChangeText={title => setSchedule(v => ({ ...v, title }))} placeholder="Title (optional)" placeholderTextColor={colors.faint}
                maxLength={120} style={[textStyle.body, styles.input, { color: colors.text }]} accessibilityLabel="Schedule title" />
              <TextInput value={schedule.prompt} onChangeText={prompt => setSchedule(v => ({ ...v, prompt }))} placeholder="What should the bot do?" placeholderTextColor={colors.faint}
                multiline maxLength={MAX_SCHEDULE_PROMPT} style={[textStyle.body, styles.input, styles.multiline, { color: colors.text }]} accessibilityLabel="Schedule prompt" />
              <View style={styles.inlineRow}>
                <Choice value={schedule.kind} label="When" options={SCHEDULE_KINDS} onChange={kind => setSchedule(v => ({ ...v, kind: kind as BotScheduleInput['kind'] }))} />
                {(schedule.kind === 'daily' || schedule.kind === 'weekdays') && (
                  <TextInput value={schedule.timeOfDay} onChangeText={timeOfDay => setSchedule(v => ({ ...v, timeOfDay }))} placeholder="09:00" placeholderTextColor={colors.faint}
                    maxLength={5} style={[textStyle.body, styles.time, { color: colors.text }]} accessibilityLabel="Time of day" />
                )}
                <View style={styles.grow} />
                <Button label="Add" size="small" variant="primary" loading={busy === 'schedule'} disabled={!schedule.prompt.trim() || !!busy} onPress={addSchedule} />
              </View>
            </View>
          )}
          {manageNote && <AccessNote device={device} methods={MANAGE_ACTIONS} style={styles.limitedNote} />}
        </CardSection>
      )}

      {detail && !detail.limited && (
        <CardSection title="Rules" trailing={<Text style={[textStyle.footnote, { color: colors.faint }]}>{detail.rules.length}</Text>}>
          {detail.rules.length === 0 && <Row title="No rules" subtitle="Every approval is asked. Add one below to allow or deny a pattern." />}
          {detail.rules.map(r => (
            <Row key={r.id} title={r.pattern} subtitle={r.decision === 'allow' ? 'Allow' : r.decision === 'deny' ? 'Deny' : 'Ask'}
              trailing={manage.ruleDelete ? <Button label="Delete" size="small" variant="destructive" loading={busy === `rule:${r.id}`} disabled={!!busy} onPress={() => removeRule(r.id)} /> : undefined} />
          ))}
          {manage.ruleAdd && (
            <View style={styles.form}>
              <TextInput value={pattern} onChangeText={setPattern} placeholder="Pattern, e.g. git push*" placeholderTextColor={colors.faint}
                maxLength={MAX_PATTERN} autoCapitalize="none" style={[textStyle.body, styles.input, { color: colors.text }]} accessibilityLabel="Rule pattern" />
              <View style={styles.inlineRow}>
                <Choice value={decision} label="Then" options={RULE_DECISIONS} onChange={value => setDecision(value as RuleDecision)} />
                <View style={styles.grow} />
                <Button label="Add" size="small" variant="primary" loading={busy === 'rule'} disabled={pattern.trim().length < 2 || !!busy} onPress={saveRules} />
              </View>
            </View>
          )}
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
      {detail && !detail.limited && (
        <CardSection title="Activity" trailing={activity && activity.length > 0 ? <Text style={[textStyle.footnote, { color: colors.faint }]}>{activity.length}{activityMore ? '+' : ''}</Text> : undefined}>
          {activity === null && <Row title="Loading…" />}
          {activity?.length === 0 && <Row title="Nothing yet" subtitle="Messages, decisions and schedule runs appear here." />}
          {(activity ?? []).map(row => <Row key={row.id} title={activityLine(row)} subtitle={ago(row.at)} leading={<ToneDot tone={activityTone(row)} />} />)}
          {activityMore && <Button label="Load older" size="small" loading={busy === 'activity'} disabled={!!busy} onPress={older} style={styles.sectionButton} />}
        </CardSection>
      )}

      {detail && canManage && (
        <CardSection title="Bot settings" footer={manageNote ?? undefined}>
          {/* The brief is read-only here by design: the host refuses it from a phone. */}
          <Row title="Brief" subtitle={detail.bot.role || 'Name, role, instructions and goals'} trailing="On the computer" />
          {editing ? (
            <View style={styles.form}>
              <TextInput value={editing.name ?? detail.bot.name} onChangeText={name => setEditing(v => ({ ...(v ?? {}), name }))} accessibilityLabel="Bot name"
                maxLength={60} style={[textStyle.body, styles.input, { color: colors.text }]} />
              <TextInput value={editing.role ?? detail.bot.role} onChangeText={role => setEditing(v => ({ ...(v ?? {}), role }))} accessibilityLabel="Bot role"
                maxLength={200} style={[textStyle.body, styles.input, { color: colors.text }]} />
              <TextInput value={editing.model ?? detail.bot.model} onChangeText={model => setEditing(v => ({ ...(v ?? {}), model }))} accessibilityLabel="Bot model"
                maxLength={200} autoCapitalize="none" style={[textStyle.body, styles.input, { color: colors.text }]} />
              <View style={styles.inlineRow}>
                <Choice value={editing.mode ?? detail.bot.mode} label="Permissions" options={MODES} onChange={mode => setEditing(v => ({ ...(v ?? {}), mode }))} />
              </View>
              {!!fullModeNote(editing.mode ?? detail.bot.mode, canManageFullMode) && (
                <Text style={[textStyle.footnote, { color: colors.warning }]}>{fullModeNote(editing.mode ?? detail.bot.mode, canManageFullMode)}</Text>
              )}
              <View style={styles.inlineRow}>
                <Button label="Cancel" size="small" disabled={!!busy} onPress={() => setEditing(null)} />
                <View style={styles.grow} />
                <Button label="Save" size="small" variant="primary" loading={busy === 'edit'} disabled={!!busy} onPress={saveEdit} />
              </View>
            </View>
          ) : (
            <View style={styles.inlineRow}>
              <Button label="Edit settings" size="small" disabled={!manage.edit || !!busy} onPress={() => setEditing({})} />
            </View>
          )}
        </CardSection>
      )}

      {detail && canManage && (
        <CardSection title="Manage" footer="Reset clears what the bot has learned and scheduled; delete removes it. Both are confirmed first.">
          <Row title="Reset bot" subtitle="Deletes conversations, memories, schedules and activity" trailing={manage.reset ? <Button label="Reset" size="small" variant="destructive" loading={busy === 'reset'} disabled={!!busy} onPress={reset} /> : undefined} />
          <Row title="Delete bot" subtitle="Removes the bot and its records; its workspace folder stays" trailing={manage.delete ? <Button label="Delete" size="small" variant="destructive" loading={busy === 'delete'} disabled={!!busy} onPress={remove} /> : undefined} />
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
  form: { gap: 8, paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  grow: { flex: 1 },
  multiline: { minHeight: 64, maxHeight: 160 },
  time: { width: 72, minHeight: 32 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
  sectionButton: { alignSelf: 'flex-start', marginHorizontal: geometry.rowInset, marginVertical: 8 },
  input: { flex: 1, minHeight: 36, maxHeight: 120 },
  limitedNote: { margin: geometry.rowInset, marginBottom: 0 },
  limitedText: { paddingHorizontal: geometry.rowInset, paddingVertical: 10 },
});
