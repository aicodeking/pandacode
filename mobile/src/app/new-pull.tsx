// New pull request sheet (pull.create), opened from Changes when the task has no open one: title
// and description prefilled from the task's title and its newest reply, a base branch picker and
// a draft switch. The host pushes the branch, opens it with gh and links it to the task; the sheet
// then hands over to the pull request screen. Create sits in the native header, where the keyboard
// can't cover it (on the iPhone Duo it moves into the side rail); why it can't yet stays inline.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FEATURE_SHEET_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';
import { createPull, gitStatus, listBranches } from '../connect/api/git.ts';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { connect } from '../connect/client.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { baseChoices, pullBlocker, pullDraft, type BranchList, type GitStatus } from '../store/git.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { Choice } from '../ui/Choice.tsx';
import { Banner, EmptyState, geometry, Group, haptic, Row, Skeleton, Toggle, type as text } from '../ui/ds/index.ts';
import { Glyph, Note, useSheetTop } from '../ui/FormParts.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, FEATURE_SHEET_DETENTS);

const MAX_TITLE = 256;
const MAX_BODY = 64 * 1024;
/** The newest reply is a starting point for the description, not all of it. */
const SUMMARY_CHARS = 4000;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
/** Every sheet dismisses the same way: Cancel on the left, as New task, Add project and New schedule. */
const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };

/** The task's newest assistant reply, cut to a description-sized start. */
function useNewestReply(device: string, session: string): string {
  return useConnect(s => {
    const messages = s.messages[taskKey(device, session)] ?? [];
    const reply = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
    return reply ? reply.content.trim().slice(0, SUMMARY_CHARS) : '';
  });
}

export default function NewPullSheet() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const top = useSheetTop();
  const demo = useConnect(s => s.demo);
  const summary = useNewestReply(device, session);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const allowed = useHostAllows(device, 'pull.create');
  const accessNote = useAccessNote(device, ['pull.create']);
  const [busy, setBusy] = useState(false);
  /** The prefilled title and description: only text the user changed asks before closing. */
  const [suggested, setSuggested] = useState({ title: '', body: '' });
  const changed = (title.trim() !== '' && title !== suggested.title) || (body.trim() !== '' && body !== suggested.body);
  const release = useDiscardGuard(changed, { message: 'This pull request isn’t created yet.' });

  useEffect(() => {
    let live = true;
    Promise.all([gitStatus(device, session), listBranches(device, session)]).then(([git, list]) => {
      if (!live) return;
      const suggested = pullDraft(git.title, summary, git.branch);
      setStatus(git);
      setBranches(list);
      setSuggested({ title: suggested.title, body: suggested.body });
      setTitle(t => t || suggested.title);
      setBody(b => b || suggested.body);
      setBase(b => b || baseChoices(list, git.branch)[0] || '');
    }, (e: Error) => live && setLoadError(e.message));
    return () => { live = false; };
    // The reply only seeds the first fill; a later one must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, session, attempt]);

  const blocker = status ? pullBlocker(status, base) ?? (!title.trim() ? 'Give the pull request a title.' : !base ? 'Choose a base branch.' : null) : null;
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await createPull(device, session, { title: title.trim(), body: body.trim(), base, draft });
      haptic('success');
      // The demo host already holds the new pull request; a real one is fetched fresh.
      if (!demo) await connect.loadPull(device, session, true).catch(() => null);
      release();
      router.back();
      router.push({ pathname: '/pull', params: { device, session } });
      if (result.note) Alert.alert('Pull request opened', result.note);
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const ready = allowed && !!status && !blocker && !busy;
  const note = accessNote ?? blocker ?? undefined;
  const actions = [{ label: busy ? 'Creating…' : 'Create', accessibilityLabel: draft ? 'Create draft pull request' : 'Create pull request', primary: true, disabled: !ready, onPress: () => void create() }];

  if (loadError) return <><HeaderActions left={[CANCEL]} right={[]} sidebar={false} /><EmptyState icon={ERROR_ICON} title="Couldn’t load the branch" body={loadError} action={{ label: 'Retry', onPress: () => { setLoadError(''); setAttempt(n => n + 1); } }} style={styles.empty} /></>;
  const options = branches && status ? baseChoices(branches, status.branch).map(value => ({ value, label: value })) : [];
  return (
    <View style={styles.screen}>
      <HeaderActions left={[CANCEL]} right={actions} sidebar={false} />
      <KeyboardAwareScrollView enabled={SHEET_KEYBOARD} style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top + geometry.screenMargin }]} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive" bottomOffset={geometry.sectionGap}>
        <Banner visible={!!error} tone="danger" title="Couldn’t open the pull request" body={error} />
        {!!note && <View style={styles.note}><Note>{note}</Note></View>}
        <Group title="Title">
          <TextInput value={title} onChangeText={setTitle} maxLength={MAX_TITLE} placeholder="What this change does" placeholderTextColor={colors.faint} accessibilityLabel="Pull request title"
            style={[text.body, styles.input, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
        </Group>
        <Group title="Description">
          <TextInput value={body} onChangeText={setBody} multiline maxLength={MAX_BODY} placeholder="Optional" placeholderTextColor={colors.faint} accessibilityLabel="Pull request description"
            style={[text.body, styles.input, styles.body, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
        </Group>
        <Group footer={status ? <Note>{`From ${status.branch || 'no branch'}. The branch is pushed first.`}</Note> : undefined}>
          {!status && <View style={styles.loading}><Skeleton width="60%" /></View>}
          {status && (
            <>
              <Row leading={<Glyph icon={{ ios: 'arrow.triangle.branch', android: 'call_split' }} />} title="Base"
                trailing={options.length ? <Choice label="Base branch" value={base} options={options} onChange={setBase} /> : 'No other branch'} />
              <Row leading={<Glyph icon={{ ios: 'doc.badge.ellipsis', android: 'draft' }} />} title="Draft"
                trailing={<Toggle value={draft} onValueChange={setDraft} accessibilityLabel="Open as a draft" />} />
            </>
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
  input: { margin: geometry.cardPadding, paddingHorizontal: geometry.screenMargin, paddingVertical: geometry.screenMargin, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  body: { minHeight: 120, maxHeight: 260, textAlignVertical: 'top' },
  loading: { padding: geometry.rowInset },
  note: { paddingHorizontal: geometry.rowInset },
  empty: { marginTop: geometry.emptyTop },
});
