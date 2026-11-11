// Commit sheet (git.commit), opened from Changes: what's staged, a message (prefilled from the
// task's title), then Commit or Commit & Push in the native header, where the keyboard can't cover them
// (on the iPhone Duo they move into the side rail). Why the commit can't happen yet stays inline.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FEATURE_SHEET_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { commitChanges, gitStatus } from '../connect/api/git.ts';
import { commitBlocker, stageRows, stageSummary, suggestCommitMessage, type GitStatus, type StageRow } from '../store/git.ts';
import { Banner, EmptyState, geometry, Group, haptic, Skeleton, type as text } from '../ui/ds/index.ts';
import { Note, useSheetTop } from '../ui/FormParts.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, FEATURE_SHEET_DETENTS);

/** Every sheet dismisses the same way: Cancel on the left, as New task, Add project and New schedule. */
const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };
const MAX_MESSAGE = 16 * 1024;
const SHOWN_FILES = 6;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;

export default function CommitSheet() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const top = useSheetTop();
  const canCommit = useHostAllows(device, 'git.commit');
  const canPush = useHostAllows(device, 'git.push');
  const accessNote = useAccessNote(device, ['git.commit']);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [rows, setRows] = useState<StageRow[]>([]);
  const [message, setMessage] = useState('');
  /** The suggested message the field was filled with: only a message the user wrote asks before closing. */
  const [suggested, setSuggested] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<'' | 'commit' | 'push'>('');
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  // autoFocus only applies at mount, when the status hasn't loaded yet: focus once it has (only when
  // this phone may commit, so the keyboard doesn't cover the reason it can't).
  const loaded = !!status;
  useEffect(() => {
    if (loaded && canCommit) input.current?.focus();
  }, [loaded, canCommit]);

  useEffect(() => {
    let live = true;
    gitStatus(device, session).then(git => {
      if (!live) return;
      const listed = stageRows(git);
      setStatus(git);
      setRows(listed);
      const suggestion = suggestCommitMessage(git.title, listed);
      setSuggested(suggestion);
      setMessage(m => m || suggestion);
    }, (e: Error) => live && setLoadError(e.message));
    return () => { live = false; };
  }, [device, session, attempt]);

  const release = useDiscardGuard(!!message.trim() && message !== suggested, { message: 'Your commit message isn’t saved.' });
  const blocker = status ? commitBlocker(message, rows, status.running) : null;
  const commit = async (push: boolean) => {
    setBusy(push ? 'push' : 'commit');
    setError('');
    try {
      const result = await commitChanges(device, session, message.trim(), push);
      haptic('success');
      if (push && result.pushError) Alert.alert('Committed, but the push failed', result.pushError);
      release();
      router.back();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
      setBusy('');
    }
  };

  const ready = canCommit && !!status && !blocker && !busy;
  const actions: HeaderItem[] = [
    { label: busy === 'commit' ? 'Committing…' : 'Commit', primary: !canPush, disabled: !ready, onPress: () => void commit(false) },
    { label: busy === 'push' ? 'Pushing…' : 'Commit & Push', primary: true, disabled: !ready, hidden: !canCommit || !canPush, onPress: () => void commit(true) },
  ];
  const note = accessNote ?? (status ? blocker ?? undefined : undefined);

  if (loadError) return <><HeaderActions left={[CANCEL]} right={[]} sidebar={false} /><EmptyState icon={ERROR_ICON} title="Couldn’t load the changes" body={loadError} action={{ label: 'Retry', onPress: () => { setLoadError(''); setAttempt(n => n + 1); } }} style={styles.empty} /></>;
  const staged = rows.filter(row => row.stage !== 'none');
  return (
    <View style={styles.screen}>
      <HeaderActions left={[CANCEL]} right={actions} sidebar={false} />
      <KeyboardAwareScrollView enabled={SHEET_KEYBOARD} style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top + geometry.screenMargin }]} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive" bottomOffset={geometry.sectionGap}>
        <Banner visible={!!error} tone="danger" title="Couldn’t commit" body={error} />
        {!!note && <View style={styles.note}><Note>{note}</Note></View>}
        <Group title="Message">
          <TextInput value={message} onChangeText={setMessage} ref={input} multiline maxLength={MAX_MESSAGE} placeholder="Describe the change"
            placeholderTextColor={colors.faint} accessibilityLabel="Commit message"
            style={[text.body, styles.input, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
        </Group>
        <Group title={status ? stageSummary(rows) : 'Staged'} footer={status?.branch ? <Note>{`On ${status.branch}`}</Note> : undefined}>
          {!status && <View style={styles.loading}><Skeleton width="70%" /><Skeleton width="50%" /></View>}
          {status && !staged.length && <View style={styles.files}><Note>Nothing is staged. Turn on the files to commit in Changes.</Note></View>}
          {staged.length > 0 && (
            <View style={styles.files}>
              {staged.slice(0, SHOWN_FILES).map(row => (
                <Text key={row.path} numberOfLines={1} ellipsizeMode="head" style={[text.code, { color: colors.muted }]}>{row.path}</Text>
              ))}
              {staged.length > SHOWN_FILES && <Note>{`and ${staged.length - SHOWN_FILES} more`}</Note>}
            </View>
          )}
        </Group>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  page: { paddingHorizontal: geometry.screenMargin, gap: geometry.sectionGap, paddingBottom: geometry.screenMargin },
  input: { minHeight: 96, maxHeight: 220, margin: geometry.cardPadding, padding: geometry.rowInset, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, textAlignVertical: 'top' },
  files: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding, gap: geometry.cardPadding / 2 },
  loading: { padding: geometry.rowInset, gap: geometry.cardPadding },
  note: { paddingHorizontal: geometry.rowInset },
  empty: { marginTop: geometry.emptyTop },
});
