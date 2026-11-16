// Rename sheet (thread.rename), from a row's long press or the task's More menu: one field prefilled
// with the title (seeded once it arrives, unless the user has typed), Save in the keyboard's return key
// and in the native header, where the keyboard can't cover it (the side rail on the iPhone Duo). The title changes in the
// lists at once and goes back if the computer refuses.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput } from 'react-native';
import { useHostAllows, useHostBlock } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { cleanTitle, MAX_TITLE, renameThread } from '../connect/api/threads.ts';
import { useConnect } from '../store/index.ts';
import { Banner, EmptyState, geometry, Group, haptic, type as text } from '../ui/ds/index.ts';
import { Note, useSheetTop } from '../ui/FormParts.tsx';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

const LOCK_ICON = { ios: 'lock.fill', android: 'lock' } as const;
const UPDATE_ICON = { ios: 'arrow.down.circle', android: 'system_update' } as const;
/** Every sheet dismisses the same way: Cancel on the left, as New task, Add project and New schedule. */
const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };

/** Room for a long title's characters beyond MAX_TITLE while typing; cleanTitle decides. */
const INPUT_SLACK = 40;

export default function RenameSheet() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const top = useSheetTop();
  const supported = useHostAllows(device, 'thread.rename');
  const block = useHostBlock(device, 'thread.rename');
  const accessNote = useAccessNote(device, ['thread.rename']);
  const current = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session)?.title);
  const [title, setTitle] = useState(current ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const typed = useRef(false);
  // The task list can arrive after the sheet opens: fill the field then, unless the user has typed.
  useEffect(() => {
    if (current !== undefined && !typed.current) setTitle(current);
  }, [current]);
  const edit = (next: string) => { typed.current = true; setTitle(next); };
  const release = useDiscardGuard(current !== undefined && title.trim() !== current.trim(), { message: 'The new name isn’t saved.' });
  // Every state keeps its header buttons, so the sheet always has a Cancel (Android keeps a side's views until set again).
  const cancelOnly = <HeaderActions left={[CANCEL]} right={[]} sidebar={false} />;
  if (current === undefined) return <>{cancelOnly}<EmptyState icon={{ ios: 'hourglass', android: 'hourglass_empty' }} title="This task is not loaded yet." style={styles.empty} /></>;
  // This phone's grant or the computer's Full access switch reads as a lock; an older PandaCode as an update.
  if (!supported) {
    const refused = block === 'access' || block === 'switch';
    return <>{cancelOnly}<EmptyState icon={refused ? LOCK_ICON : UPDATE_ICON} title={refused && accessNote ? accessNote : 'Update PandaCode on that computer to rename tasks.'} style={styles.empty} /></>;
  }

  const clean = cleanTitle(title);
  const unchanged = clean === current;
  const save = async () => {
    // Return fires only once a composition is committed; a second tap while saving does nothing.
    if (!clean || busy) return;
    if (unchanged) return void router.back();
    setBusy(true);
    setError('');
    try {
      await renameThread(device, session, clean);
      haptic('success');
      release();
      router.back();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
    <HeaderActions left={[CANCEL]} right={[{ label: busy ? 'Saving…' : 'Save', primary: true, disabled: !clean || busy, onPress: () => void save() }]} sidebar={false} />
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.page, { paddingTop: top + geometry.screenMargin }]} keyboardShouldPersistTaps="handled">
      <Banner visible={!!error} tone="danger" title="Couldn’t rename" body={error} />
      <Group title="Name" footer={<Note>{clean || !title.trim() ? 'The desktop’s sidebar shows the new name too.' : `Use at most ${MAX_TITLE} characters.`}</Note>}>
        <TextInput value={title} onChangeText={edit} autoFocus selectTextOnFocus maxLength={MAX_TITLE + INPUT_SLACK} returnKeyType="done" enablesReturnKeyAutomatically
          onSubmitEditing={save} submitBehavior="blurAndSubmit" placeholder="Task name" placeholderTextColor={colors.faint} accessibilityLabel="Task name" editable={!busy}
          style={[text.body, styles.input, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
      </Group>
    </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  page: { paddingHorizontal: geometry.screenMargin, gap: geometry.sectionGap, paddingBottom: geometry.screenMargin },
  input: { margin: geometry.cardPadding, paddingHorizontal: geometry.screenMargin, paddingVertical: geometry.screenMargin, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  empty: { marginTop: geometry.emptyTop },
});
