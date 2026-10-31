// Approval and agent-question cards (approval.respond / input.respond).
import * as Haptics from 'expo-haptics';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { PendingRequest } from '../connect/types.ts';
import { Choice } from './Choice.tsx';
import { initial, parseSchema, range, readForm, type Field } from './form-schema.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { mono, useColors, type Colors } from './theme.ts';

interface Question { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean }
type Input = { kind: 'questions'; questions: Question[] } | { kind: 'form'; message: string; schema: unknown } | { kind: 'url'; message: string; url: string };

function useSend() {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); } catch (error) { Alert.alert('Could not send', (error as Error).message); setBusy(false); }
  };
  return [busy, run] as const;
}

type IconName = Pick<Parameters<typeof Icon>[0], 'ios' | 'android'>;

export function Button({ label, onPress, kind = 'plain', disabled, icon }: { label: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean; icon?: IconName }) {
  const colors = useColors();
  const bg = kind === 'primary' ? colors.tint : colors.fill;
  const fg = kind === 'primary' ? colors.onTint : kind === 'danger' ? colors.red : colors.text;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
      {!!icon && <Icon {...icon} size={14} color={fg} />}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function ApprovalCard({ deviceId, sessionId, request }: { deviceId: string; sessionId: string; request: PendingRequest }) {
  const colors = useColors();
  const [busy, send] = useSend();
  const answer = (approve: boolean) => send(async () => {
    void Haptics.notificationAsync(approve ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    await connect.respondApproval(deviceId, sessionId, request.requestId, approve);
  });
  return (
    <Glass style={styles.card}>
      <Heading icon={{ ios: 'hand.raised.fill', android: 'front_hand' }} title="Approval needed" color={colors.orange} />
      <Markdown text={request.text || 'The agent asks to continue.'} />
      {!!request.tool && <Text style={[styles.tool, { color: colors.text, backgroundColor: colors.fill, fontFamily: mono }]} numberOfLines={6} selectable>{request.tool.name}{request.tool.input ? `\n${request.tool.input}` : ''}</Text>}
      <View style={styles.actions}>
        {busy ? <ActivityIndicator /> : <>
          <Button label="Deny" kind="danger" icon={{ ios: 'xmark', android: 'close' }} onPress={() => answer(false)} />
          <Button label="Approve" kind="primary" icon={{ ios: 'checkmark', android: 'check' }} onPress={() => answer(true)} />
        </>}
      </View>
    </Glass>
  );
}

export function InputCard({ deviceId, sessionId, request }: { deviceId: string; sessionId: string; request: PendingRequest }) {
  const colors = useColors();
  const [busy, send] = useSend();
  const input = request.data as Input | undefined;
  const respond = (response: unknown) => send(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await connect.respondInput(deviceId, sessionId, request.requestId, response);
  });
  // As on the desktop (src/agent-input.ts): Cancel always, Decline for forms and links.
  const cancel = () => respond(input?.kind === 'questions' ? { answers: {} } : { action: 'cancel', content: null });
  const decline = () => respond({ action: 'decline', content: null });
  let body;
  if (input?.kind === 'questions' && Array.isArray(input.questions) && input.questions.length) body = <Questions questions={input.questions} busy={busy} colors={colors} onSubmit={answers => respond({ answers })} onCancel={cancel} />;
  else if (input?.kind === 'url' && typeof input.url === 'string') body = (
    <>
      <Markdown text={input.message} />
      <Button label="Open link" onPress={() => { if (/^https?:\/\//i.test(input.url)) void Linking.openURL(input.url); }} />
      <Actions busy={busy}>
        <Button label="Cancel" onPress={cancel} />
        <Button label="Decline" kind="danger" onPress={decline} />
        <Button label="Continue" kind="primary" onPress={() => respond({ action: 'accept' })} />
      </Actions>
    </>
  );
  else if (input?.kind === 'form') body = <Form message={input.message} schema={input.schema} busy={busy} colors={colors} onSubmit={content => respond({ action: 'accept', content })} onDecline={decline} onCancel={cancel} />;
  else body = (
    <>
      <Markdown text={request.text || 'The agent is waiting for an answer.'} />
      <Text style={[styles.error, { color: colors.red }]}>This input format is not supported. Cancel to let the agent continue.</Text>
      <Actions busy={busy}><Button label="Cancel" onPress={cancel} /></Actions>
    </>
  );
  return (
    <Glass style={styles.card}>
      <Heading icon={{ ios: 'questionmark', android: 'question_mark' }} title={input?.kind === 'questions' ? 'A quick question' : 'Input needed'} color={colors.orange} />
      {body}
    </Glass>
  );
}

function Heading({ icon, title, color }: { icon: IconName; title: string; color: Colors[keyof Colors] }) {
  return (
    <View style={styles.heading}>
      <View style={[styles.badge, { backgroundColor: color }]}><Icon {...icon} size={13} color="#ffffff" /></View>
      <Text style={[styles.title, { color }]}>{title}</Text>
    </View>
  );
}

function Actions({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <View style={styles.actions}>{busy ? <ActivityIndicator /> : children}</View>;
}

function Questions({ questions, busy, colors, onSubmit, onCancel }: { questions: Question[]; busy: boolean; colors: Colors; onSubmit: (answers: Record<string, string[]>) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Question, label: string) => {
    void Haptics.selectionAsync();
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
      {questions.map(q => (
        <View key={q.id} style={styles.question}>
          {!!q.header && <Text style={[styles.header, { color: colors.secondary }]}>{q.header}</Text>}
          <Markdown text={q.question} />
          <View style={styles.options}>
            {(q.options ?? []).map(o => {
              const on = picked[q.id]?.includes(o.label);
              return (
                <Pressable key={o.label} onPress={() => toggle(q, o.label)} accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}
                  style={[styles.option, { backgroundColor: on ? colors.tint : colors.fill }]}>
                  <Text style={[styles.optionLabel, { color: on ? colors.onTint : colors.text }]}>{o.label}</Text>
                  {!!o.description && <Text style={[styles.optionDetail, { color: on ? colors.onTint : colors.secondary }]}>{o.description}</Text>}
                </Pressable>
              );
            })}
          </View>
          {(q.isOther || !q.options?.length) && (
            <TextInput value={other[q.id] ?? ''} onChangeText={t => setOther(o => ({ ...o, [q.id]: t }))} placeholder={q.options?.length ? 'Other…' : 'Your answer'}
              placeholderTextColor={colors.tertiary as string} secureTextEntry={q.isSecret} style={[styles.field, { color: colors.text, backgroundColor: colors.fill }]} />
          )}
        </View>
      ))}
      <Actions busy={busy}>
        <Button label="Cancel" onPress={onCancel} />
        <Button label="Send answer" kind="primary" disabled={!ready} onPress={() => onSubmit(answers)} />
      </Actions>
    </>
  );
}

function Form({ message, schema, busy, colors, onSubmit, onDecline, onCancel }: { message: string; schema: unknown; busy: boolean; colors: Colors; onSubmit: (content: Record<string, unknown>) => void; onDecline: () => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  let fields: Field[] = [];
  let unsupported = '';
  try { fields = parseSchema(schema); } catch (e) { unsupported = (e as Error).message; }
  const set = (name: string, value: unknown) => { setValues(v => ({ ...v, [name]: value })); setError(''); };
  const submit = () => {
    try { onSubmit(readForm(fields, values)); } catch (e) { setError((e as Error).message); }
  };
  const field = { color: colors.text, backgroundColor: colors.fill };
  return (
    <>
      <Markdown text={message} />
      {fields.map(f => {
        const value = values[f.name] ?? initial(f);
        const hint = f.kind === 'number' && (typeof f.schema.minimum === 'number' || typeof f.schema.maximum === 'number') ? ` (${range(f.schema)})` : '';
        return (
          <View key={f.name} style={styles.question}>
            <Text style={[styles.header, { color: colors.secondary }]}>{f.title}{f.required ? '' : ' (optional)'}{hint}</Text>
            {!!f.description && <Text style={[styles.optionDetail, { color: colors.secondary }]}>{f.description}</Text>}
            {f.kind === 'boolean' ? <Switch value={value === true} onValueChange={v => set(f.name, v)} accessibilityLabel={f.title} />
              : f.kind === 'enum' ? <Choice value={String(value)} options={[{ value: '', label: 'Choose…' }, ...f.options.map((o, i) => ({ value: String(i), label: o.label }))]} onChange={v => set(f.name, v)} />
              : f.kind === 'multi' ? (
                <View style={styles.options}>
                  {f.options.map(o => {
                    const list = value as string[];
                    const on = list.includes(o.value);
                    return (
                      <Pressable key={o.value} onPress={() => set(f.name, on ? list.filter(v => v !== o.value) : [...list, o.value])} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                        style={[styles.option, { backgroundColor: on ? colors.tint : colors.fill }]}>
                        <Text style={[styles.optionLabel, { color: on ? colors.onTint : colors.text }]}>{o.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <TextInput value={String(value)} onChangeText={t => set(f.name, t)} placeholder={f.title} accessibilityLabel={f.title}
                  keyboardType={f.kind === 'number' ? (f.schema.type === 'integer' ? 'number-pad' : 'decimal-pad') : f.schema.format === 'email' ? 'email-address' : f.schema.format === 'uri' ? 'url' : 'default'}
                  secureTextEntry={f.schema.format === 'password'} autoCapitalize="none" maxLength={typeof f.schema.maxLength === 'number' ? f.schema.maxLength : 8192}
                  placeholderTextColor={colors.tertiary as string} style={[styles.field, field]} />
              )}
          </View>
        );
      })}
      {!!(error || unsupported) && <Text style={[styles.error, { color: colors.red }]} accessibilityRole="alert">{error || unsupported}</Text>}
      <Actions busy={busy}>
        <Button label="Cancel" onPress={onCancel} />
        {!unsupported && <Button label="Decline" kind="danger" onPress={onDecline} />}
        {!unsupported && <Button label="Submit" kind="primary" onPress={submit} />}
      </Actions>
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, padding: 14, gap: 8, marginHorizontal: 12, borderCurve: 'continuous' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14, fontWeight: '600' },
  header: { fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  button: { flexDirection: 'row', gap: 6, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, minHeight: 38, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  question: { gap: 6 },
  options: { gap: 6 },
  option: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  optionLabel: { fontSize: 15, fontWeight: '500' },
  optionDetail: { fontSize: 13, marginTop: 2 },
  field: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { fontSize: 14 },
  tool: { fontSize: 12, borderRadius: 10, padding: 8, overflow: 'hidden' },
});
