// Approval and agent-question cards (approval.respond / input.respond): nested cards on glass, since
// they float over the transcript, with a monochrome primary.
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Alert, Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { PendingRequest } from '../connect/types.ts';
import { Choice } from './Choice.tsx';
import { Button as DsButton, Chevron, geometry, haptic, InnerCard, PressScale, Toggle, type as textStyle, type IconName } from './ds/index.ts';
import { parseFields, shellCommand } from '../store/trace.ts';
import { initial, parseSchema, range, readForm, type Field } from './form-schema.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { type Colors, mono, useColors } from './theme.ts';

interface Question { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean }
type Input = { kind: 'questions'; questions: Question[] } | { kind: 'form'; message: string; schema: unknown } | { kind: 'url'; message: string; url: string };

/** A tool's input folds to this many lines; "Show all" opens the rest. */
const INPUT_LINES = 6;
/** Beyond this many characters even a single line wraps past INPUT_LINES on a phone. */
const INPUT_CHARS = 240;
/** The card leaves when the host drops the request; if it keeps it this long, the buttons come back. */
const ANSWER_TIMEOUT_MS = 12_000;

/** Runs an answer: a light tap at once, success or error when the host replies. `pending` names the button in
 * flight until the card goes away, or for ANSWER_TIMEOUT_MS if the host keeps the request, so an answer can be tried again. */
function useSend(failure = 'Could not send') {
  const [pending, setPending] = useState('');
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(() => setPending(''), ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const run = async (id: string, action: () => Promise<unknown>, done: 'success' | 'warning' = 'success') => {
    if (pending) return;
    setPending(id);
    haptic('light');
    try {
      await action();
      haptic(done);
    } catch (error) {
      haptic('error');
      Alert.alert(failure, (error as Error).message);
      setPending('');
    }
  };
  return [pending, run] as const;
}

/** Says what just appeared, once, for VoiceOver. */
function useAnnounce(text: string) {
  const [first] = useState(text);
  useEffect(() => { AccessibilityInfo.announceForAccessibility(first); }, [first]);
}

const VARIANTS = { primary: 'primary', plain: 'raised', danger: 'destructive' } as const;

export function Button({ label, onPress, kind = 'plain', disabled, icon, loading }: { label: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean; icon?: IconName; loading?: boolean }) {
  return <DsButton label={label} variant={VARIANTS[kind]} icon={icon} disabled={disabled} loading={loading} onPress={onPress} />;
}

/** What the agent wants to run: a small label (`Run command` for a shell, else the tool's name), then the
 * command alone in a code box. Long input folds, and opens so all of it can be read before approving. */
function ToolInput({ tool }: { tool: NonNullable<PendingRequest['tool']> }) {
  const colors = useColors();
  const command = tool.input ? shellCommand(tool.input, parseFields(tool.input)) : '';
  const label = command ? 'Run command' : tool.name;
  const text = command || tool.input || tool.name;
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  const long = lines > INPUT_LINES || text.length > INPUT_CHARS;
  return (
    <View style={styles.toolGroup}>
    <Text style={[textStyle.footnoteMedium, { color: colors.muted }]}>{label}</Text>
    <InnerCard style={[styles.tool, { backgroundColor: colors.fill, borderColor: colors.border }]}>
      <Text style={[styles.toolText, { color: colors.text }]} numberOfLines={long && !open ? INPUT_LINES : undefined} selectable>{text}</Text>
      {long && (
        <PressScale onPress={() => setOpen(o => !o)} accessibilityState={{ expanded: open }} hitSlop={8} style={styles.more}>
          <Text style={[textStyle.footnoteMedium, { color: colors.muted }]}>{open ? 'Show less' : lines > INPUT_LINES ? `Show all ${lines} lines` : 'Show all'}</Text>
          <Chevron expanded={open} size={10} color={colors.muted} />
        </PressScale>
      )}
    </InnerCard>
    </View>
  );
}

/** Whether the agent's prose only restates the command shown in the block below it. */
function repeatsTool(text: string, tool: PendingRequest['tool']): boolean {
  if (!tool?.input) return false;
  const command = (shellCommand(tool.input, parseFields(tool.input)) || tool.input).trim();
  return !!command && text.includes(command);
}

export function ApprovalCard({ deviceId, sessionId, request }: { deviceId: string; sessionId: string; request: PendingRequest }) {
  const [pending, send] = useSend();
  useAnnounce(`Approval needed. ${request.text || 'The agent asks to continue.'}`);
  const answer = (approve: boolean) => send(approve ? 'approve' : 'deny', () => connect.respondApproval(deviceId, sessionId, request.requestId, approve), approve ? 'success' : 'warning');
  const colors = useColors();
  return (
    <Glass style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Heading icon={{ ios: 'hand.raised.fill', android: 'front_hand' }} title="Approval needed" />
      {/* Two surfaces: the card, and the code box as its inner one. */}
      <View style={styles.approval}>
        {(!request.tool || !repeatsTool(request.text, request.tool)) && <Markdown text={request.text || 'The agent asks to continue.'} />}
        {!!request.tool && <ToolInput tool={request.tool} />}
      </View>
      <Actions>
        <Button label="Deny" kind="danger" icon={{ ios: 'xmark', android: 'close' }} loading={pending === 'deny'} disabled={!!pending} onPress={() => answer(false)} />
        <Button label="Approve" kind="primary" icon={{ ios: 'checkmark', android: 'check' }} loading={pending === 'approve'} disabled={!!pending} onPress={() => answer(true)} />
      </Actions>
    </Glass>
  );
}

export function InputCard({ deviceId, sessionId, request }: { deviceId: string; sessionId: string; request: PendingRequest }) {
  const colors = useColors();
  const [pending, send] = useSend();
  const input = request.data as Input | undefined;
  useAnnounce(input?.kind === 'questions' ? 'The agent has a question.' : 'The agent needs input.');
  const respond = (id: string, response: unknown) => send(id, () => connect.respondInput(deviceId, sessionId, request.requestId, response));
  // As on the desktop (src/agent-input.ts): Cancel always, Decline for forms and links.
  const cancel = () => respond('cancel', input?.kind === 'questions' ? { answers: {} } : { action: 'cancel', content: null });
  const decline = () => respond('decline', { action: 'decline', content: null });
  let body;
  if (input?.kind === 'questions' && Array.isArray(input.questions) && input.questions.length) body = <Questions questions={input.questions} pending={pending} colors={colors} onSubmit={answers => respond('submit', { answers })} onCancel={cancel} />;
  else if (input?.kind === 'url' && typeof input.url === 'string') body = (
    <>
      <InnerCard style={styles.panel}>
        <Markdown text={input.message} />
        <Button label="Open link" onPress={() => { if (/^https?:\/\//i.test(input.url)) void Linking.openURL(input.url); }} />
      </InnerCard>
      <Actions>
        <Button label="Cancel" loading={pending === 'cancel'} disabled={!!pending} onPress={cancel} />
        <Button label="Decline" kind="danger" loading={pending === 'decline'} disabled={!!pending} onPress={decline} />
        <Button label="Continue" kind="primary" loading={pending === 'submit'} disabled={!!pending} onPress={() => respond('submit', { action: 'accept' })} />
      </Actions>
    </>
  );
  else if (input?.kind === 'form') body = <Form message={input.message} schema={input.schema} pending={pending} colors={colors} onSubmit={content => respond('submit', { action: 'accept', content })} onDecline={decline} onCancel={cancel} />;
  else body = (
    <>
      <InnerCard style={styles.panel}>
        <Markdown text={request.text || 'The agent is waiting for an answer.'} />
        <Text style={[textStyle.subhead, { color: colors.danger }]}>This input format is not supported. Cancel to let the agent continue.</Text>
      </InnerCard>
      <Actions><Button label="Cancel" loading={pending === 'cancel'} disabled={!!pending} onPress={cancel} /></Actions>
    </>
  );
  return (
    <Glass style={styles.card}>
      <Heading icon={{ ios: 'questionmark.bubble.fill', android: 'help' }} title={input?.kind === 'questions' ? 'A quick question' : 'Input needed'} />
      {body}
    </Glass>
  );
}

function Heading({ icon, title }: { icon: IconName; title: string }) {
  const colors = useColors();
  return (
    <View style={styles.heading}>
      <Icon {...icon} size={15} color={colors.warning} />
      <Text accessibilityRole="header" style={[textStyle.subhead, { color: colors.muted }]}>{title}</Text>
    </View>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

function Option({ label, detail, on, role, onPress, colors }: { label: string; detail?: string; on: boolean; role: 'checkbox' | 'radio'; onPress: () => void; colors: Colors }) {
  return (
    <PressScale onPress={onPress} accessibilityRole={role} accessibilityState={{ checked: on }} style={[styles.option, { backgroundColor: on ? colors.primary : colors.fill, borderColor: colors.border }]}>
      <Text style={[textStyle.subheadMedium, { color: on ? colors.onPrimary : colors.text }]}>{label}</Text>
      {!!detail && <Text style={[textStyle.footnote, { color: on ? colors.onPrimary : colors.muted }]}>{detail}</Text>}
    </PressScale>
  );
}

function Questions({ questions, pending, colors, onSubmit, onCancel }: { questions: Question[]; pending: string; colors: Colors; onSubmit: (answers: Record<string, string[]>) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Question, label: string) => {
    haptic('selection');
    setPicked(p => {
      const now = p[q.id] ?? [];
      const next = q.multiSelect ? (now.includes(label) ? now.filter(l => l !== label) : [...now, label]) : [label];
      return { ...p, [q.id]: next };
    });
  };
  const answers = Object.fromEntries(questions.map(q => [q.id, [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])]]));
  const ready = questions.every(q => answers[q.id].length > 0);
  return (
    <>
      <InnerCard style={styles.panel}>
        {questions.map(q => (
          <View key={q.id} style={styles.question}>
            {!!q.header && <Text style={[textStyle.footnoteMedium, { color: colors.muted }]}>{q.header}</Text>}
            <Markdown text={q.question} />
            <View style={styles.options}>
              {(q.options ?? []).map(o => <Option key={o.label} label={o.label} detail={o.description} on={!!picked[q.id]?.includes(o.label)} role={q.multiSelect ? 'checkbox' : 'radio'} colors={colors} onPress={() => toggle(q, o.label)} />)}
            </View>
            {(q.isOther || !q.options?.length) && (
              <TextInput value={other[q.id] ?? ''} onChangeText={t => setOther(o => ({ ...o, [q.id]: t }))} placeholder={q.options?.length ? 'Other…' : 'Your answer'} accessibilityLabel={`${q.options?.length ? 'Other answer' : 'Your answer'}: ${q.header || q.question}`}
                placeholderTextColor={colors.faint} secureTextEntry={q.isSecret} style={[styles.field, { color: colors.text, backgroundColor: colors.fill, borderColor: colors.border }]} />
            )}
          </View>
        ))}
      </InnerCard>
      <Actions>
        <Button label="Cancel" loading={pending === 'cancel'} disabled={!!pending} onPress={onCancel} />
        <Button label="Send answer" kind="primary" loading={pending === 'submit'} disabled={!ready || !!pending} onPress={() => onSubmit(answers)} />
      </Actions>
    </>
  );
}

function Form({ message, schema, pending, colors, onSubmit, onDecline, onCancel }: { message: string; schema: unknown; pending: string; colors: Colors; onSubmit: (content: Record<string, unknown>) => void; onDecline: () => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  let fields: Field[] = [];
  let unsupported = '';
  try { fields = parseSchema(schema); } catch (e) { unsupported = (e as Error).message; }
  const set = (name: string, value: unknown) => { setValues(v => ({ ...v, [name]: value })); setError(''); };
  const submit = () => {
    try { onSubmit(readForm(fields, values)); } catch (e) { setError((e as Error).message); }
  };
  const field = { color: colors.text, backgroundColor: colors.fill, borderColor: colors.border };
  return (
    <>
      <InnerCard style={styles.panel}>
        <Markdown text={message} />
        {fields.map(f => {
          const value = values[f.name] ?? initial(f);
          const hint = f.kind === 'number' && (typeof f.schema.minimum === 'number' || typeof f.schema.maximum === 'number') ? ` (${range(f.schema)})` : '';
          return (
            <View key={f.name} style={styles.question}>
              <Text style={[textStyle.footnoteMedium, { color: colors.muted }]}>{f.title}{f.required ? '' : ' (optional)'}{hint}</Text>
              {!!f.description && <Text style={[textStyle.footnote, { color: colors.muted }]}>{f.description}</Text>}
              {f.kind === 'boolean' ? <Toggle value={value === true} onValueChange={v => set(f.name, v)} accessibilityLabel={f.title} />
                : f.kind === 'enum' ? <Choice value={String(value)} options={[{ value: '', label: 'Choose…' }, ...f.options.map((o, i) => ({ value: String(i), label: o.label }))]} onChange={v => set(f.name, v)} />
                : f.kind === 'multi' ? (
                  <View style={styles.options}>
                    {f.options.map(o => {
                      const list = value as string[];
                      const on = list.includes(o.value);
                      return <Option key={o.value} label={o.label} on={on} role="checkbox" colors={colors} onPress={() => set(f.name, on ? list.filter(v => v !== o.value) : [...list, o.value])} />;
                    })}
                  </View>
                ) : (
                  <TextInput value={String(value)} onChangeText={t => set(f.name, t)} placeholder={f.title} accessibilityLabel={f.title}
                    keyboardType={f.kind === 'number' ? (f.schema.type === 'integer' ? 'number-pad' : 'decimal-pad') : f.schema.format === 'email' ? 'email-address' : f.schema.format === 'uri' ? 'url' : 'default'}
                    secureTextEntry={f.schema.format === 'password'} autoCapitalize="none" maxLength={typeof f.schema.maxLength === 'number' ? f.schema.maxLength : 8192}
                    placeholderTextColor={colors.faint} style={[styles.field, field]} />
                )}
            </View>
          );
        })}
        {!!(error || unsupported) && <Text style={[textStyle.subhead, { color: colors.danger }]} accessibilityRole="alert">{error || unsupported}</Text>}
      </InnerCard>
      <Actions>
        <Button label="Cancel" loading={pending === 'cancel'} disabled={!!pending} onPress={onCancel} />
        {!unsupported && <Button label="Decline" kind="danger" loading={pending === 'decline'} disabled={!!pending} onPress={onDecline} />}
        {!unsupported && <Button label="Submit" kind="primary" loading={pending === 'submit'} disabled={!!pending} onPress={submit} />}
      </Actions>
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: geometry.cardRadius, borderWidth: geometry.hairline, padding: geometry.cardPadding, marginHorizontal: geometry.screenMargin, borderCurve: 'continuous' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34, paddingHorizontal: 10 },
  panel: { padding: 12, gap: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: 6, flexWrap: 'wrap' },
  question: { gap: 6 },
  options: { gap: 6 },
  option: { borderRadius: geometry.controlRadius, borderWidth: geometry.hairline, paddingHorizontal: 12, paddingVertical: 9, borderCurve: 'continuous' },
  field: { borderRadius: geometry.controlRadius, borderWidth: geometry.hairline, paddingHorizontal: 12, paddingVertical: 10, fontSize: textStyle.callout.fontSize, borderCurve: 'continuous' },
  approval: { paddingHorizontal: 10, paddingBottom: 4, gap: 10 },
  toolGroup: { gap: 6 },
  tool: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  toolText: { ...textStyle.caption, fontFamily: mono },
  more: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', minHeight: 28 },
});
