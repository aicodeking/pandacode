// Agent usage on one computer (usage.get, usage.limits): a card per installed harness with its limit
// windows as bars, a reset countdown each, and the tokens and estimated cost of the last day and week
// from the desktop's usage ledger. With ?session= it leads with that task's tokens and, when the task
// hit a limit, "Resume at reset". Pushed with ?device= (and optionally &session=).
//
// `UsageResumeToggle` lives in src/ui/UsageResumeToggle.tsx (also mounted by the task screen).
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { usageLimits, usageOverview } from '../connect/api/composer.ts';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import {
  clampPercent, formatCost, formatTokens, resetLabel, resetTime, sortedWindows, totalTokens, usageTone,
  type ProviderUsage, type TokenTotals, type UsageOverview, type UsageWindow,
} from '../store/slash.ts';
import { Banner, CardSection, Chip, EmptyState, geometry, Segmented, Skeleton, springs, type as textStyle, useStagger } from '../ui/ds/index.ts';
import { HarnessLogo, harnessName } from '../ui/harness.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { UsageResumeToggle } from '../ui/UsageResumeToggle.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const TICK_MS = 30_000;
const BAR_HEIGHT = 6;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const SPAN_OPTIONS = [{ value: 'day', label: 'Today' }, { value: 'week', label: '7 days' }] as const;
type Span = (typeof SPAN_OPTIONS)[number]['value'];

/** The clock for countdowns: ticks every 30 s while shown. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Bar({ percent }: { percent: number }) {
  const colors = useColors();
  const share = useSharedValue(0);
  useEffect(() => { share.set(withSpring(percent / 100, springs.smooth)); }, [percent, share]);
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: share.get() }] }));
  return (
    <View style={[styles.bar, { backgroundColor: colors.track }]}>
      <Animated.View style={[styles.barFill, { backgroundColor: colors[usageTone(percent)] }, fill]} />
    </View>
  );
}

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const colors = useColors();
  const percent = clampPercent(window.usedPercent);
  const reset = resetLabel(resetTime(window.resetsAt), now);
  return (
    <View style={styles.window} accessible accessibilityLabel={`${window.label}: ${Math.round(percent)}% used. ${reset}`}>
      <View style={styles.windowHead}>
        <Text numberOfLines={1} style={[textStyle.subheadMedium, styles.flex, { color: colors.text }]}>{window.label}</Text>
        <Text style={[textStyle.subhead, { color: percent >= 70 ? colors[usageTone(percent)] : colors.muted }]}>{Math.round(percent)}%</Text>
      </View>
      <Bar percent={percent} />
      {(!!reset || !!window.detail) && <Text numberOfLines={1} style={[textStyle.footnote, { color: colors.muted }]}>{[reset, window.detail].filter(Boolean).join(' · ')}</Text>}
    </View>
  );
}

function Tokens({ totals }: { totals: TokenTotals | undefined }) {
  const colors = useColors();
  if (!totals || !totalTokens(totals)) return <Text style={[textStyle.footnote, styles.pad, { color: colors.muted }]}>No token activity recorded.</Text>;
  const parts = [`${formatTokens(totals.input)} in`, `${formatTokens(totals.output)} out`, totals.cacheRead ? `${formatTokens(totals.cacheRead)} cached` : ''].filter(Boolean);
  return (
    <View style={[styles.tokens, styles.pad]} accessible accessibilityLabel={`${formatTokens(totalTokens(totals))} tokens, ${parts.join(', ')}, about ${formatCost(totals.cost)}`}>
      <Text style={[textStyle.title3, { color: colors.text }]}>{formatTokens(totalTokens(totals))}</Text>
      <Text numberOfLines={1} style={[textStyle.footnote, styles.flex, { color: colors.muted }]}>tokens · {parts.join(' · ')}</Text>
      <Text style={[textStyle.subheadMedium, { color: colors.text }]}>{formatCost(totals.cost)}</Text>
    </View>
  );
}

function ProviderCard({ id, name, limits, error, totals, now }: { id: string; name: string; limits?: ProviderUsage; error?: string; totals?: TokenTotals; now: number }) {
  const colors = useColors();
  const windows = limits ? sortedWindows(limits.windows) : [];
  const note = error || (limits && limits.status !== 'ok' && limits.message) || (limits && !windows.length ? limits.message || 'This agent doesn’t report limits.' : '');
  return (
    <CardSection title={name || harnessName(id)} trailing={<View style={styles.trailing}>{!!limits?.plan && <Chip label={limits.plan} />}<HarnessLogo id={id} size={18} /></View>}
      footer={<Tokens totals={totals} />}>
      {!limits && !error && <View style={styles.loading}><Skeleton width="45%" /><Skeleton width="90%" height={BAR_HEIGHT} /></View>}
      {windows.map(window => <WindowRow key={window.label} window={window} now={now} />)}
      {!!note && <Text style={[textStyle.footnote, styles.pad, { color: error ? colors.danger : colors.muted }]}>{note}{limits?.stale ? ' (cached)' : ''}</Text>}
    </CardSection>
  );
}

function TaskCard({ deviceId, task, now }: { deviceId: string; task: NonNullable<UsageOverview['task']>; now: number }) {
  const colors = useColors();
  const title = useConnect(s => s.tasks[deviceId]?.tasks.find(t => t.sessionId === task.sessionId)?.title);
  const limited = task.limitedAt !== null && (task.limitedUntil === null || task.limitedUntil > now);
  const tokens = task.tokens;
  return (
    <CardSection title={title ? `This task · ${title}` : 'This task'} trailing={<HarnessLogo id={task.provider} size={18} />}>
      {tokens
        ? <Tokens totals={{ ...tokens, cost: 0 }} />
        : <Text style={[textStyle.footnote, styles.pad, { color: colors.muted }]}>No token logs for this task yet.</Text>}
      {limited && (
        <>
          <Text style={[textStyle.subheadMedium, styles.pad, { color: colors.warning }]}>
            Usage limit reached{task.limitedUntil ? ` · ${resetLabel(task.limitedUntil, now)}` : ''}
          </Text>
          <UsageResumeToggle deviceId={deviceId} sessionId={task.sessionId} resetsAt={task.limitedUntil} />
        </>
      )}
    </CardSection>
  );
}

export default function UsageScreen() {
  const { device = '', session } = useLocalSearchParams<{ device: string; session?: string }>();
  const colors = useColors();
  const scroll = usePushedScroll();
  const now = useNow();
  const supported = useHostSupports(device, 'usage.get');
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'your computer');
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [limits, setLimits] = useState<Record<string, ProviderUsage>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [span, setSpan] = useState<Span>('day');
  const enter = useStagger(!!overview);

  // Each harness on its own, so a slow account never holds up the others.
  const loadLimits = useCallback((next: UsageOverview, refresh: boolean) => Promise.all(next.providers.map(p => usageLimits(device, p.id, refresh).then(
    usage => setLimits(l => ({ ...l, [p.id]: usage })),
    (e: Error) => setErrors(x => ({ ...x, [p.id]: e.message })),
  ))), [device]);
  const load = useCallback((refresh: boolean) => usageOverview(device, session || undefined, refresh).then(
    next => { setOverview(next); setError(''); return loadLimits(next, refresh); },
    (e: Error) => setError(e.message),
  ), [device, session, loadLimits]);
  useEffect(() => { if (supported) void load(false); }, [load, supported]);
  useReloadOnReconnect(device, () => (supported ? load(false) : undefined));
  const refresh = async () => { setRefreshing(true); setErrors({}); await load(true); setRefreshing(false); };
  const totals = overview?.ledger?.[span];

  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Usage' }} />
      <HeaderActions />
      {!supported && <EmptyState icon={ERROR_ICON} title="Usage unavailable" body={outdated(computer)} />}
      {supported && !overview && !error && <CardSection><View style={styles.loading}><Skeleton width="40%" /><Skeleton width="85%" height={BAR_HEIGHT} /><Skeleton width="60%" /></View></CardSection>}
      {supported && !overview && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load usage" body={error} action={{ label: 'Retry', onPress: () => void load(false) }} />}
      <Banner visible={!!overview && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: () => void load(false) }} />
      {overview?.task && <Animated.View entering={enter(0)}><TaskCard deviceId={device} task={overview.task} now={now} /></Animated.View>}
      {!!overview?.ledger && overview.providers.length > 0 && (
        <Animated.View entering={enter(1)}>
          <Segmented options={SPAN_OPTIONS} value={span} onChange={setSpan} accessibilityLabel="Token totals for" />
        </Animated.View>
      )}
      {overview && !overview.providers.length && <EmptyState icon={ERROR_ICON} title="No agents installed" body={`Install a harness on ${computer} to see its usage.`} />}
      {overview?.providers.map((p, i) => (
        <Animated.View key={p.id} entering={enter(i + 2)}>
          <ProviderCard id={p.id} name={p.name} limits={limits[p.id]} error={errors[p.id]} totals={totals?.[p.id]} now={now} />
        </Animated.View>
      ))}
      {!!overview && !overview.ledger && <Text style={[textStyle.footnote, styles.pad, { color: colors.muted }]}>Token estimates need PandaCode’s window open on {computer}.</Text>}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loading: { padding: geometry.rowInset, gap: geometry.sectionGap },
  window: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.screenMargin, gap: geometry.cardPadding },
  windowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, overflow: 'hidden' },
  barFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, transformOrigin: 'left' },
  tokens: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
});
