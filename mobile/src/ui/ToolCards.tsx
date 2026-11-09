// Expanded views for MCP tool calls: PandaCode's team tools get proper cards (a card per
// dispatched assignment, the finish summary as Markdown, a message with its recipient), screenshot
// tools show their image when the result carries the bytes, and any other MCP call shows
// `server › tool` with its arguments pretty-printed.
import { Image } from 'expo-image';
import { createContext, useContext, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ToolActivity } from '../connect/types.ts';
import { assignmentsOf, imageOf, type Assignment, type WorkerNames } from '../store/pandacode-tools.ts';
import { mcpParts } from '../store/trace.ts';
import { HarnessLogo, harnessName } from './harness.tsx';
import { Markdown } from './Markdown.tsx';
import { modelLabel } from './model-label.ts';
import { mono, useColors } from './theme.ts';
import { Chevron, Collapse, geometry, InnerCard, PressScale, type as textStyle } from './ds/index.ts';

/** Worker id → name for the task on screen (from its team), so sentences read `Asked GPT-6…`. */
export const WorkerNamesContext = createContext<WorkerNames>({});
export const useWorkerNames = () => useContext(WorkerNamesContext);

type Fields = Record<string, unknown>;
const MAX_ARGS = 6000;
const str = (f: Fields, key: string) => (typeof f[key] === 'string' ? f[key] as string : '');

/** Pretty JSON for arguments, else the raw text. */
function pretty(input: string, fields: Fields): string {
  const text = Object.keys(fields).length ? JSON.stringify(fields, null, 2) : input;
  return text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS)}\n…` : text;
}

function Label({ children }: { children: string }) {
  const colors = useColors();
  return <Text style={[styles.label, { color: colors.muted }]}>{children}</Text>;
}

function Mono({ text }: { text: string }) {
  const colors = useColors();
  return <Text selectable style={[styles.code, { color: colors.text }]}>{text}</Text>;
}

/** A model badge: the harness logo, then the model (or profile) name. */
export function ModelBadge({ provider, model }: { provider: string; model: string }) {
  const colors = useColors();
  if (!provider && !model) return null;
  return (
    <View style={[styles.badge, { backgroundColor: colors.fill, borderColor: colors.chipBorder }]} accessible accessibilityLabel={[model && modelLabel(model), provider && harnessName(provider)].filter(Boolean).join(', ')}>
      {!!provider && <HarnessLogo id={provider} size={12} />}
      <Text style={[styles.badgeText, { color: colors.muted }]} numberOfLines={1}>{model ? modelLabel(model) : harnessName(provider)}</Text>
    </View>
  );
}

function AssignmentCard({ a, names }: { a: Assignment; names: WorkerNames }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const deps = a.dependsOn.map(id => names[id] || id);
  return (
    <InnerCard style={styles.card}>
      <View style={styles.row}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{a.name}</Text>
        <ModelBadge provider={a.provider} model={a.model || a.profileId} />
      </View>
      <Text style={[styles.meta, { color: colors.faint }]} numberOfLines={3}>
        {[a.key && `key ${a.key}`, a.readOnly && 'read-only', a.files.length ? a.files.join(', ') : 'whole checkout', deps.length && `after ${deps.join(', ')}`].filter(Boolean).join(' · ')}
      </Text>
      {!!a.prompt && (
        <PressScale onPress={() => setOpen(o => !o)} accessibilityState={{ expanded: open }} style={styles.fold}>
          <Chevron expanded={open} size={10} color={colors.muted} />
          <Text style={[styles.meta, { color: colors.muted }]}>Assignment</Text>
        </PressScale>
      )}
      <Collapse expanded={open}><Markdown text={a.prompt} /></Collapse>
    </InnerCard>
  );
}

/** Whether OwnCard draws something for this call (else the generic arguments view). */
function hasOwnCard(own: string, fields: Fields): boolean {
  switch (own) {
    case 'dispatch_workers': return assignmentsOf(fields).length > 0;
    case 'finish_team': return !!str(fields, 'summary');
    case 'followup_worker': case 'send_team_message': case 'checkpoint_worker': return true;
    default: return false;
  }
}

/** The tool's own card (only where hasOwnCard). */
function OwnCard({ own, fields, names }: { own: string; fields: Fields; names: WorkerNames }) {
  const colors = useColors();
  switch (own) {
    case 'dispatch_workers': {
      const list = assignmentsOf(fields);
      return list.length ? <View style={styles.gap}>{list.map((a, i) => <AssignmentCard key={a.key || i} a={a} names={names} />)}</View> : null;
    }
    case 'finish_team':
      return str(fields, 'summary') ? <Markdown text={str(fields, 'summary')} /> : null;
    case 'followup_worker':
      return (
        <View style={styles.gap}>
          <Label>{`To ${names[str(fields, 'workerId')] || 'worker'}${fields.readOnly === true ? ' · read-only' : ''}`}</Label>
          {!!str(fields, 'prompt') && <Markdown text={str(fields, 'prompt')} />}
        </View>
      );
    case 'send_team_message': {
      const to = str(fields, 'recipient');
      return (
        <View style={styles.gap}>
          <Label>{`To ${to === 'architect' ? 'the architect' : names[to] || to || 'teammate'}`}</Label>
          <Markdown text={str(fields, 'message')} />
        </View>
      );
    }
    case 'checkpoint_worker':
      return (
        <View style={styles.gap}>
          {!!str(fields, 'summary') && <Text selectable style={[styles.body, { color: colors.text }]}>{str(fields, 'summary')}</Text>}
          {!!str(fields, 'nextSteps') && <><Label>Next</Label><Text selectable style={[styles.body, { color: colors.text }]}>{str(fields, 'nextSteps')}</Text></>}
          {!!str(fields, 'blocker') && <><Label>Blocker</Label><Text selectable style={[styles.body, { color: colors.danger }]}>{str(fields, 'blocker')}</Text></>}
        </View>
      );
    default: return null;
  }
}

/** The expanded body of an MCP tool call. */
export function McpBody({ tool, fields, own }: { tool: ToolActivity; fields: Fields; own?: string }) {
  const colors = useColors();
  const names = useWorkerNames();
  const image = useMemo(() => (own && /screenshot|control/.test(own) ? imageOf(tool.output) : undefined), [own, tool.output]);
  const { server, tool: name } = mcpParts(tool.name);
  const hasCard = !!own && hasOwnCard(own, fields);
  const card = hasCard ? <OwnCard own={own!} fields={fields} names={names} /> : null;
  return (
    <View style={styles.gap}>
      {!own && <Label>{`${server} › ${name}`}</Label>}
      {hasCard ? card : !!tool.input.trim() && tool.input.trim() !== '{}' && <Mono text={pretty(tool.input, fields)} />}
      {image ? <Image source={{ uri: image }} style={styles.shot} contentFit="contain" accessibilityLabel="Screenshot" />
        : !hasCard && !!tool.output.trim() && <Mono text={tool.output.length > MAX_ARGS ? `${tool.output.slice(0, MAX_ARGS)}\n…` : tool.output} />}
      {!tool.output.trim() && !hasCard && <Text style={[styles.body, { color: colors.muted }]}>{tool.status === 'running' ? 'Waiting for output…' : 'No output was returned.'}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { padding: 10, gap: 4 },
  title: { ...textStyle.subheadMedium, flex: 1 },
  meta: textStyle.footnote,
  fold: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2, alignSelf: 'flex-start' },
  label: textStyle.footnoteMedium,
  body: textStyle.subhead,
  code: { ...textStyle.caption, fontFamily: mono },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: geometry.chipRadius, borderWidth: geometry.hairline, borderCurve: 'continuous', maxWidth: 150 },
  badgeText: { ...textStyle.caption, flexShrink: 1 },
  shot: { width: '100%', aspectRatio: 0.5, borderRadius: 8 },
});
