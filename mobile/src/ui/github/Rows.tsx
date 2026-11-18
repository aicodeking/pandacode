// Rows and small parts of the GitHub screens (src/app/github.tsx, github-item.tsx): one card of
// issue, pull request, run or search rows with state chips, and the head of an item.
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type { HubIssue, HubPull, HubRun, SearchItem } from '../../connect/api/github.ts';
import { Card, Chip, InnerCard, Row, type as text, useStagger } from '../ds/index.ts';
import { useColors } from '../theme.ts';
import { itemBadge, issueLine, pullBadge, pullLine, runBadge, runLine, type Badge } from './model.ts';

export interface ItemRoute { device: string; project: string; kind: 'issue' | 'pull' | 'run'; id: number; title?: string; url?: string }

/** Pushes the item's detail screen. */
export function openItem({ device, project, kind, id, title, url }: ItemRoute) {
  router.push({ pathname: '/github-item', params: { device, project, kind, id: String(id), ...(title && { title }), ...(url && { url }) } });
}

export function BadgeChip({ badge }: { badge: Badge }) {
  return <Chip label={badge.label} tone={badge.tone} />;
}

/** One card of rows, staggered in on first show. */
export function RowsCard<T>({ rows, keyOf, render }: { rows: readonly T[]; keyOf: (row: T) => string; render: (row: T) => ReactNode }) {
  const enter = useStagger();
  return (
    <Card>
      <InnerCard>
        {rows.map((row, i) => <Animated.View key={keyOf(row)} entering={enter(i)}>{render(row)}</Animated.View>)}
      </InnerCard>
    </Card>
  );
}

type Target = Pick<ItemRoute, 'device' | 'project'>;

export const IssueRow = ({ issue, to }: { issue: HubIssue; to: Target }) => (
  <Row title={issue.title} subtitle={issueLine(issue)} trailing={issue.labels[0] ? <Chip label={issue.labels[0]} /> : undefined} chevron
    accessibilityLabel={`Issue ${issue.number}, ${issue.title}`} onPress={() => openItem({ ...to, kind: 'issue', id: issue.number })} />
);

export const PullRow = ({ pull, to }: { pull: HubPull; to: Target }) => (
  <Row title={pull.title} subtitle={pullLine(pull)} trailing={<BadgeChip badge={pullBadge(pull)} />} chevron
    accessibilityLabel={`Pull request ${pull.number}, ${pull.title}, ${pullBadge(pull).label}`} onPress={() => openItem({ ...to, kind: 'pull', id: pull.number })} />
);

export const RunRow = ({ run, to }: { run: HubRun; to: Target }) => (
  <Row title={run.title || run.workflow} subtitle={runLine(run)} trailing={<BadgeChip badge={runBadge(run.state)} />} chevron
    accessibilityLabel={`${run.workflow} run, ${run.title}, ${runBadge(run.state).label}`}
    onPress={() => openItem({ ...to, kind: 'run', id: run.id, title: `${run.workflow} · ${run.branch}`, url: run.url })} />
);

export const SearchRow = ({ item, to }: { item: SearchItem; to: Target }) => (
  <Row title={item.title} subtitle={`${item.kind === 'pull' ? 'Pull request' : 'Issue'} #${item.number} · ${item.author}`} trailing={<BadgeChip badge={itemBadge(item.state)} />} chevron
    onPress={() => openItem({ ...to, kind: item.kind, id: item.number })} />
);

/** A section label above a card. */
export function SectionLabel({ children }: { children: string }) {
  const colors = useColors();
  return <Text accessibilityRole="header" style={[text.footnoteMedium, styles.label, { color: colors.muted }]}>{children}</Text>;
}

/** An item's title, state chip and byline. */
export function ItemHead({ title, badge, byline, labels }: { title: string; badge?: Badge; byline: string; labels?: readonly string[] }) {
  const colors = useColors();
  return (
    <View style={styles.head}>
      <Text selectable accessibilityRole="header" style={[text.title3, { color: colors.text }]}>{title}</Text>
      <View style={styles.line}>
        {badge && <BadgeChip badge={badge} />}
        <Text numberOfLines={2} style={[text.subhead, styles.byline, { color: colors.muted }]}>{byline}</Text>
      </View>
      {!!labels?.length && <View style={styles.labels}>{labels.map(label => <Chip key={label} label={label} />)}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { paddingHorizontal: 12, marginBottom: -4 },
  head: { gap: 8, paddingHorizontal: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  byline: { flex: 1, minWidth: 0 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
