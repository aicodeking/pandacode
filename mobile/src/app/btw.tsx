// By the way (docs/btw.md): a side question beside a task that keeps working. The sheet asks on the
// task's side thread (btw.ask; the host creates it the first time, in the same project, harness, model
// and checkout, and adds the main thread's news to every question) and shows that thread's answers.
// Opened by `/btw …` in the composer with ?device=&session=&q=; follow-ups are asked from here.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { FEATURE_SHEET_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { connect } from '../connect/client.ts';
import { askBtw, forgetBtw, useBtwLinks } from '../connect/api/composer.ts';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { outdated } from '../connect/rpc.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { Banner, Button, crossFadeIn, EmptyState, geometry, haptic, InnerCard, Skeleton, type as textStyle } from '../ui/ds/index.ts';
import { useSheetTop } from '../ui/FormParts.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { usePagePadding } from '../ui/usePagePadding.ts';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, FEATURE_SHEET_DETENTS);

const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const ASK_ICON = { ios: 'questionmark.bubble', android: 'contact_support' } as const;
/** The block the host adds to each question; the sheet shows the question alone. */
const CONTEXT_MARK = '\n\nMain thread context:';

/** A sheet with nothing to confirm closes with Done, leading as the other sheets' Cancel does. */
const DONE: HeaderItem = { label: 'Done', onPress: () => router.back() };

const questionOf = (content: string) => content.split(CONTEXT_MARK)[0].trim();

export default function BtwSheet() {
  const { device = '', session = '', q = '' } = useLocalSearchParams<{ device: string; session: string; q?: string }>();
  const colors = useColors();
  const top = useSheetTop();
  const page = usePagePadding();
  // Clear of the home indicator, which the keyboard covers once it is up.
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardState(state => state.isVisible);
  const supported = useHostAllows(device, 'btw.ask');
  const accessNote = useAccessNote(device, ['btw.ask']);
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'your computer');
  const link = useBtwLinks(s => s[taskKey(device, session)]);
  const sideId = link?.sideId ?? '';
  const messages = useConnect(s => (sideId ? s.messages[taskKey(device, sideId)] : undefined));
  const live = useConnect(s => (sideId ? s.live[taskKey(device, sideId)] : undefined));
  const answering = live?.status === 'running';
  const [sending, setSending] = useState(!!q.trim());
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // A typed question not yet asked; an asked one is cleared from the field, so it never asks.
  const release = useDiscardGuard(!!draft.trim() && !sending, { message: 'Your question isn’t asked yet.' });

  // The question from the composer, asked once when the sheet opens.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !q.trim() || !supported) return;
    asked.current = true;
    askBtw(device, session, q.trim()).then(
      () => { setSending(false); haptic('light'); },
      (e: Error) => { setSending(false); setError(e.message); setDraft(q.trim()); haptic('error'); },
    );
  }, [device, session, q, supported]);

  // The side thread is an ordinary task: watch it like the task screen does.
  useEffect(() => {
    if (!sideId) return;
    connect.watch(device, [sideId]);
    connect.loadMessages(device, sideId).catch(() => undefined);
    return () => connect.unwatch(device, [sideId]);
  }, [device, sideId]);
  // The saved answer replaces the live one when a run ends.
  const wasAnswering = useRef(answering);
  useEffect(() => {
    if (wasAnswering.current && !answering && sideId) connect.loadMessages(device, sideId).catch(() => undefined);
    wasAnswering.current = answering;
  }, [answering, device, sideId]);

  const ask = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    setDraft('');
    try {
      await askBtw(device, session, text);
      haptic('light');
    } catch (e) {
      setDraft(text);
      setError((e as Error).message);
      haptic('error');
    } finally {
      setSending(false);
    }
  };
  const fresh = () => { haptic('selection'); forgetBtw(device, session); };
  // Open as thread: the side thread opens once this sheet has gone, never over it. The guard is released
  // first (a typed follow-up can still be asked there), so the back can't be blocked and leave a push behind.
  const openAfter = useRef('');
  useEffect(() => () => {
    if (openAfter.current) router.push({ pathname: '/task/[device]/[session]', params: { device, session: openAfter.current } });
  }, [device]);
  const openFull = () => {
    if (!sideId || openAfter.current) return;
    release();
    openAfter.current = sideId;
    router.back();
  };

  const header = <HeaderActions left={[DONE]} sidebar={false} />;
  if (!supported) return <>{header}<EmptyState icon={ERROR_ICON} title="By the way is unavailable" body={accessNote ?? outdated(computer)} style={{ marginTop: top }} /></>;
  const shown = (messages ?? []).filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim());
  const waiting = sending || answering;
  return (
    <KeyboardAvoidingView enabled={SHEET_KEYBOARD} behavior="padding" style={[styles.sheet, { paddingTop: top }]}>
      {header}
      <ScrollView ref={scroll} style={styles.flex} contentContainerStyle={[page, styles.log]} keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        <Text numberOfLines={2} style={[textStyle.headline, { color: colors.text }]}>{link?.title ?? 'By the way'}</Text>
        <Text style={[textStyle.footnote, { color: colors.muted }]}>A side thread: the task keeps working while you ask here.</Text>
        <Banner visible={!!error} title="Couldn’t ask" body={error} />
        {!sideId && !sending && !error && <EmptyState icon={ASK_ICON} title="Ask on the side" body="Questions here go to a side thread with the task’s latest news, never to the task itself." />}
        {shown.map(m => m.role === 'user' ? (
          <Animated.View key={m.id} entering={crossFadeIn} style={[styles.question, { backgroundColor: colors.bubble }]}>
            <Text selectable style={[textStyle.body, { color: colors.text }]}>{questionOf(m.content)}</Text>
          </Animated.View>
        ) : (
          <Animated.View key={m.id} entering={crossFadeIn}><Markdown text={m.content} /></Animated.View>
        ))}
        {waiting && (
          <View style={styles.pending} accessibilityLabel="Answering">
            <Text style={[textStyle.footnote, { color: colors.muted }]}>{sending ? 'Asking…' : live?.activity || 'Answering…'}</Text>
            <Skeleton width="70%" />
            <Skeleton width="45%" />
          </View>
        )}
      </ScrollView>
      <View style={[styles.dock, { paddingLeft: page.paddingLeft, paddingRight: page.paddingRight, paddingBottom: (keyboardUp ? 0 : insets.bottom) + geometry.screenMargin }]}>
        <InnerCard style={styles.field}>
          <TextInput value={draft} onChangeText={setDraft} placeholder={sideId ? 'Ask a follow-up…' : 'Ask on the side…'} placeholderTextColor={colors.faint}
            multiline style={[textStyle.body, styles.input, { color: colors.text }]} accessibilityLabel="Side question" />
        </InnerCard>
        <View style={styles.actions}>
          {!!sideId && <Button label="New side thread" variant="plain" size="small" onPress={fresh} disabled={waiting} />}
          {!!sideId && <Button label="Open as thread" variant="plain" size="small" onPress={openFull} />}
          <View style={styles.flex} />
          <Button label="Ask" variant="primary" size="small" onPress={() => void ask()} disabled={!draft.trim() || waiting}
            accessibilityHint={answering ? 'Wait for the side thread to answer' : undefined} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  flex: { flex: 1 },
  log: { gap: geometry.rowInset },
  question: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: geometry.innerRadius, borderCurve: 'continuous', paddingHorizontal: geometry.rowInset, paddingVertical: 8 },
  pending: { gap: 8 },
  dock: { paddingTop: geometry.cardPadding, paddingBottom: geometry.screenMargin, gap: geometry.cardPadding },
  field: { padding: 4 },
  input: { minHeight: 40, maxHeight: 140, paddingHorizontal: 8, paddingVertical: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
});
