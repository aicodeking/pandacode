// Add project sheet (?device=): clone a GitHub repository onto the computer as a new project.
// Type owner/name or paste a github.com link, or pick one of the account's recent repositories
// (projects.recentRepos). The computer always clones into ~/PandaCode/<folder>: the phone names a
// folder, never a path. The clone runs in the background there (projects.clone), so the sheet asks
// projects.cloneStatus until it's done, then refreshes the computer's projects, selects the new project
// in the New task form underneath (sheet or Duo pane) and closes. A repository already on the computer
// is never cloned again: tapping it, or typing its name, selects that project and closes.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FEATURE_SHEET_DETENTS, sheetKeyboardPadding } from '../ui/sheet-keyboard.ts';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { useAccessNote } from '../ui/AccessNote.tsx';
import { cloneRepo, cloneStatus, recentRepos, type RecentRepo } from '../connect/api/projects.ts';
import { connect } from '../connect/client.ts';
import { outdated } from '../connect/rpc.ts';
import { Banner, EmptyState, geometry, Group, haptic, Row, type as text } from '../ui/ds/index.ts';
import { Glyph, Note, useSheetTop } from '../ui/FormParts.tsx';
import { useComputerName, useLoad } from '../ui/hub/common.tsx';
import { selectAddedProject } from '../ui/useNewTask.ts';
import { filterRepos, folderFor, parseRepoInput, waitForClone } from '../ui/new-task-projects.ts';
import { HeaderActions, type HeaderItem } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

/** JS keyboard padding only where the native sheet doesn't lift it (src/ui/sheet-keyboard.ts). */
const SHEET_KEYBOARD = sheetKeyboardPadding(Platform.OS, FEATURE_SHEET_DETENTS);

const REPO_ICON = { ios: 'book.closed', android: 'book' } as const;
const HAVE_ICON = { ios: 'checkmark.circle', android: 'check_circle' } as const;
const MAX_SHOWN = 30;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function repoSubtitle(repo: RecentRepo): string {
  const flags = [repo.private && 'Private', repo.fork && 'Fork', repo.archived && 'Archived', repo.language].filter(Boolean);
  return [repo.projectId ? 'Already on this computer' : '', repo.description, flags.join(' · ')].filter(Boolean).join(' — ');
}

const CANCEL: HeaderItem = { label: 'Cancel', onPress: () => router.back() };

export default function AddProject() {
  const colors = useColors();
  const top = useSheetTop();
  const params = useLocalSearchParams<{ device: string }>();
  const device = params.device ?? '';
  const computer = useComputerName(device);
  const supported = useHostAllows(device, 'projects.clone');
  const accessNote = useAccessNote(device, ['projects.clone']);
  const listed = useHostSupports(device, 'projects.recentRepos');
  const loadRepos = useCallback(() => recentRepos(device), [device]);
  const repos = useLoad(supported && listed ? loadRepos : null, device);
  const [input, setInput] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closed = useRef(false);
  // A clone already running keeps going on the computer, so only typed input not yet sent asks.
  const release = useDiscardGuard(!busy && (!!input.trim() || !!folder.trim()), { message: 'The repository isn’t added yet.' });
  useEffect(() => () => { closed.current = true; }, []);

  const repo = parseRepoInput(input);
  const shown = useMemo(() => filterRepos(repos.value ?? [], parseRepoInput(input) ?? input).slice(0, MAX_SHOWN), [repos.value, input]);

  /** Selects `projectId` in the New task form and closes. */
  const chooseProject = (projectId: string) => {
    haptic('success');
    selectAddedProject(device, projectId);
    release();
    router.back();
  };
  const existingId = (target: string | null) => (target && repos.value?.find(r => r.repo.toLowerCase() === target.toLowerCase())?.projectId) || null;
  const have = existingId(repo);

  const clone = async (target: string) => {
    if (busy) return;
    const known = existingId(target);
    if (known) return chooseProject(known);
    setBusy(true);
    setError('');
    try {
      const first = await cloneRepo(device, target, folder.trim() || undefined);
      const result = await waitForClone(first, () => cloneStatus(device, target), { sleep, cancelled: () => closed.current, now: Date.now });
      if (!result || closed.current) return;
      if (result.state === 'done') {
        await connect.listTasks(device).catch(() => undefined);
        if (!closed.current) chooseProject(result.projectId);
        return;
      }
      throw new Error(result.state === 'failed' ? result.error : 'The computer lost track of this clone. Try again.');
    } catch (e) {
      if (closed.current) return;
      haptic('error');
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (!supported) return <><HeaderActions left={[CANCEL]} right={[]} /><EmptyState icon={REPO_ICON} title={accessNote ?? outdated(computer)} /></>;

  const ready = !!repo && !busy;
  return (
    <>
      <Stack.Screen options={{ title: 'Add project' }} />
      <HeaderActions left={[CANCEL]} right={[{ label: busy ? 'Cloning…' : have ? 'Use' : 'Clone', primary: true, disabled: !ready, onPress: () => repo && void clone(repo) }]} />
      <KeyboardAwareScrollView enabled={SHEET_KEYBOARD} contentContainerStyle={[styles.form, { paddingTop: top }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" bottomOffset={geometry.sectionGap}>
        <Banner visible={!!error} tone="danger" title="Couldn’t add the project" body={error} />
        {busy && (
          <View style={styles.busy} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.muted} />
            <Text style={[text.footnote, { color: colors.muted }]}>Cloning on {computer}. You can close this; it keeps going there.</Text>
          </View>
        )}
        <Group footer={<Note>owner/name or a github.com link</Note>}>
          <TextInput value={input} onChangeText={value => { setInput(value); setError(''); }} placeholder="Repository" placeholderTextColor={colors.faint}
            autoCapitalize="none" autoCorrect={false} autoFocus editable={!busy} returnKeyType="go" onSubmitEditing={() => repo && void clone(repo)}
            style={[text.body, styles.line, { color: colors.text }]} accessibilityLabel="Repository" />
        </Group>
        <Group footer={<Note>{have ? `Already on ${computer}; Use selects it.` : `Cloned into ~/PandaCode/${folder.trim() || (repo ? folderFor(repo) : '<name>')} on ${computer}.`}</Note>}>
          <TextInput value={folder} onChangeText={setFolder} placeholder={repo ? `Folder (${folderFor(repo)})` : 'Folder (optional)'} placeholderTextColor={colors.faint}
            autoCapitalize="none" autoCorrect={false} maxLength={100} editable={!busy && !have}
            style={[text.body, styles.line, { color: colors.text }]} accessibilityLabel="Folder name" />
        </Group>
        {listed && (
          <Group title="Your repositories">
            {repos.value ? (
              shown.length ? shown.map(r => (
                <Row key={r.repo} title={r.repo} subtitle={repoSubtitle(r)} disabled={busy}
                  leading={<Glyph icon={r.projectId ? HAVE_ICON : REPO_ICON} tone={r.projectId ? colors.green : undefined} />}
                  onPress={r.projectId ? () => chooseProject(r.projectId!) : () => { haptic('selection'); setInput(r.repo); }}
                  accessibilityHint={r.projectId ? 'Selects this project' : 'Fills in the repository'} />
              )) : <Text style={[text.footnote, styles.note, { color: colors.muted }]}>No matching repositories.</Text>
            ) : repos.error ? (
              <Row title="Couldn’t list your repositories" subtitle={repos.error} tone="danger" onPress={() => void repos.reload()} accessibilityHint="Tries again" />
            ) : <ActivityIndicator style={styles.loading} color={colors.muted} />}
          </Group>
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  form: { paddingHorizontal: geometry.screenMargin, paddingBottom: geometry.screenMargin, gap: geometry.sectionGap },
  line: { minHeight: geometry.rowHeight, paddingHorizontal: geometry.rowInset },
  busy: { flexDirection: 'row', alignItems: 'center', gap: geometry.sectionGap, paddingHorizontal: geometry.rowInset },
  note: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.sectionGap },
  loading: { paddingVertical: geometry.rowInset },
});
