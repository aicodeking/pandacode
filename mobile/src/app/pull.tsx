// The task's pull request, like the desktop's PR tab: title, state, author, branches, counts,
// review decision, checks, labels, body, changed files (each opens its diff), commits and the
// timeline, with Merge (merge/squash/rebase, confirmed) and Open on GitHub.
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { connect } from '../connect/client.ts';
import type { MergeMethod, PullCheck, PullDetail } from '../connect/types.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { useBackdrop } from '../ui/Backdrop.tsx';
import { Counts, FileRow } from '../ui/FileRow.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { showActions } from '../ui/Menu.tsx';
import { mono, useColors, type Colors } from '../ui/theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;

const METHODS: { method: MergeMethod; label: string; verb: string }[] = [
  { method: 'merge', label: 'Create a merge commit', verb: 'Merge' },
  { method: 'squash', label: 'Squash and merge', verb: 'Squash and merge' },
  { method: 'rebase', label: 'Rebase and merge', verb: 'Rebase and merge' },
];
const REVIEW: Record<string, string> = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required', commented: 'Commented' };

function stateBadge(pull: PullDetail, colors: Colors): { label: string; color: ColorValue } {
  if (pull.state === 'merged' || pull.mergedAt) return { label: 'Merged', color: '#8250df' };
  if (pull.state === 'closed') return { label: 'Closed', color: colors.red };
  if (pull.state === 'draft') return { label: 'Draft', color: colors.secondary };
  return { label: 'Open', color: colors.green };
}

function checkIcon(state: PullCheck['state'], colors: Colors): IconName & { color: ColorValue } {
  if (state === 'success') return { ios: 'checkmark.circle.fill', android: 'check_circle', color: colors.green };
  if (state === 'failure') return { ios: 'xmark.circle.fill', android: 'cancel', color: colors.red };
  if (state === 'pending') return { ios: 'clock.fill', android: 'schedule', color: colors.orange };
  return { ios: 'minus.circle.fill', android: 'remove_circle', color: colors.tertiary };
}

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');

export default function PullScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const backdrop = useBackdrop();
  const pull = useConnect(s => s.pulls[taskKey(device, session)]);
  const [refreshing, setRefreshing] = useState(false);
  const [merging, setMerging] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await connect.loadPull(device, session, true).catch(e => Alert.alert('Could not refresh', (e as Error).message));
    setRefreshing(false);
  };
  if (!pull) return <Text style={[styles.empty, { color: colors.secondary }]}>No pull request is linked to this task.</Text>;

  const badge = stateBadge(pull, colors);
  const open = pull.state === 'open';
  const merge = (m: (typeof METHODS)[number]) => Alert.alert(`${m.verb} #${pull.number}?`, `Into ${pull.base} on GitHub. This can't be undone from here.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: m.verb, style: 'destructive', onPress: async () => {
      setMerging(true);
      try {
        await connect.mergePull(device, session, m.method);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        Alert.alert('Could not merge', (e as Error).message);
      } finally {
        setMerging(false);
      }
    } },
  ]);
  const card = { backgroundColor: backdrop.card };
  return (
    <ScrollView style={{ backgroundColor: backdrop.background }} contentContainerStyle={styles.page} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: `#${pull.number}` }} />
      <Text style={[styles.title, { color: colors.text }]} selectable>{pull.title}</Text>
      <View style={styles.line}>
        <View style={[styles.badge, { backgroundColor: badge.color }]}><Text style={styles.badgeText}>{badge.label}</Text></View>
        <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>{pull.author} · {when(pull.createdAt)}</Text>
      </View>
      <View style={styles.line}>
        <Text style={[styles.branches, { color: colors.secondary }]} numberOfLines={1} ellipsizeMode="middle">{pull.base} ← {pull.head}</Text>
        <Counts additions={pull.additions} deletions={pull.deletions} />
      </View>
      {!!REVIEW[pull.reviewDecision] && (
        <View style={styles.line}>
          <Icon ios={pull.reviewDecision === 'approved' ? 'checkmark.seal.fill' : 'exclamationmark.bubble.fill'} android={pull.reviewDecision === 'approved' ? 'verified' : 'rate_review'} size={15}
            color={pull.reviewDecision === 'approved' ? colors.green : colors.orange} />
          <Text style={[styles.meta, { color: colors.text }]}>{REVIEW[pull.reviewDecision]}</Text>
        </View>
      )}
      {!!pull.labels.length && (
        <View style={styles.labels}>
          {pull.labels.map(l => <Text key={l} style={[styles.label, { color: colors.text, backgroundColor: colors.fill }]}>{l}</Text>)}
        </View>
      )}

      <View style={styles.actions}>
        {open && (
          <Button label={merging ? 'Merging…' : 'Merge'} icon={{ ios: 'arrow.triangle.merge', android: 'merge' }} primary disabled={merging || pull.mergeable === 'conflicting'}
            onPress={() => showActions(`Merge #${pull.number}`, METHODS.map(m => ({ label: m.label, onPress: () => merge(m) })))} />
        )}
        <Button label="Open on GitHub" icon={{ ios: 'safari', android: 'open_in_new' }} onPress={() => void Linking.openURL(pull.url)} disabled={!/^https:\/\//.test(pull.url)} />
      </View>
      {open && pull.mergeable === 'conflicting' && <Text style={[styles.meta, { color: colors.orange }]}>This branch has conflicts to resolve before it can merge.</Text>}

      {!!pull.checks.length && (
        <Group title="Checks" style={card}>
          {pull.checks.map((c, i) => {
            const icon = checkIcon(c.state, colors);
            return (
              <Row key={`${i}/${c.name}`} last={i === pull.checks.length - 1}>
                <Icon ios={icon.ios} android={icon.android} size={16} color={icon.color} />
                <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={1}>{c.name}</Text>
              </Row>
            );
          })}
        </Group>
      )}
      {!!pull.body.trim() && <Group title="Description" style={[card, styles.body]}><Markdown text={pull.body} /></Group>}
      {!!pull.files.length && (
        <Group title={`Files (${pull.changedFiles || pull.files.length})`} style={card}>
          {pull.files.map((f, i) => <FileRow key={f.path} path={f.path} additions={f.additions} deletions={f.deletions} last={i === pull.files.length - 1} diff={{ device, session, source: 'pull' }} />)}
        </Group>
      )}
      {!!pull.commits.length && (
        <Group title={`Commits (${pull.commits.length})`} style={card}>
          {pull.commits.map((c, i) => (
            <Row key={c.oid} last={i === pull.commits.length - 1}>
              <Text style={[styles.oid, { color: colors.secondary }]}>{c.oid.slice(0, 7)}</Text>
              <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={2}>{c.headline}</Text>
            </Row>
          ))}
        </Group>
      )}
      {pull.timeline.map((c, i) => (
        <View key={i} style={[styles.group, styles.comment, card]}>
          <Text style={[styles.meta, { color: colors.secondary }]}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{c.author}</Text>
            {c.kind === 'review' && c.state ? ` ${(REVIEW[c.state] ?? c.state).toLowerCase()}` : ''} · {when(c.createdAt)}
          </Text>
          {!!c.body.trim() && <Markdown text={c.body} />}
        </View>
      ))}
      {pull.truncated && <Text style={[styles.meta, { color: colors.secondary }]}>Some of this pull request was left out to fit. Open it on GitHub for the rest.</Text>}
    </ScrollView>
  );
}

function Group({ title, style, children }: { title: string; style: object; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.secondary }]} accessibilityRole="header">{title}</Text>
      <View style={[styles.group, style]}>{children}</View>
    </View>
  );
}

function Row({ last, children }: { last?: boolean; children: ReactNode }) {
  const colors = useColors();
  return <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }]}>{children}</View>;
}

function Button({ label, icon, onPress, primary, disabled }: { label: string; icon: IconName; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const colors = useColors();
  const fg = primary ? colors.onTint : colors.tint;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.button, { backgroundColor: primary ? colors.tint : colors.fill, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
      <Icon {...icon} size={15} color={fg} />
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10, paddingBottom: 48 },
  empty: { fontSize: 15, textAlign: 'center', marginTop: 120, paddingHorizontal: 32 },
  title: { fontSize: 21, fontWeight: '700', marginHorizontal: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 4 },
  badge: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  meta: { flexShrink: 1, fontSize: 14, marginHorizontal: 4 },
  branches: { flex: 1, fontFamily: mono, fontSize: 13 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginHorizontal: 4 },
  label: { fontSize: 12, fontWeight: '600', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 9, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  button: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 44, borderRadius: 22, borderCurve: 'continuous' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  section: { gap: 6, marginTop: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '600', marginHorizontal: 18 },
  group: { borderRadius: 16, paddingHorizontal: 14, borderCurve: 'continuous' },
  body: { paddingTop: 12, paddingBottom: 4 },
  comment: { paddingVertical: 12, gap: 6, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingVertical: 6 },
  rowText: { flex: 1, fontSize: 15 },
  oid: { fontFamily: mono, fontSize: 13 },
});
