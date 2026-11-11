// The iPhone Duo's empty right pane (split.tsx): "What should we work on?" with project and
// computer pickers, and a composer whose send starts the task (useNewTask) and opens it. The
// project menu matches the New task sheet: Chat (no project) and Add project where served. The
// options menu offers Team (where the computer serves team.start): Auto or a named team, and the
// pickers card then shows the same team summary as the New task sheet's footer. As the sheet, it
// says when this phone's access keeps Start off (AccessNote) and attaches images and text files
// (the + beside the options, where the computer serves image.put), and a Banner with Retry when
// loading the computer's options fails. The options menu's Run on section
// starts it on a connected cloud provider instead (useNewTask). Toasts sit above the measured bar.
import { router, Stack } from 'expo-router';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { useState, type ReactNode } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BLOCKED_TITLE, type MenuGate } from './menu-gate.ts';
import { AccessNote } from './AccessNote.tsx';
import { AttachButton, AttachChips, useComposerAttach } from './ComposerAttach.tsx';
import { teamChoices, teamSummary } from '../connect/api/team.ts';
import { NEW_TASK_DRAFT, setDraft, useDrafts } from '../store/draft.ts';
import { Round, SIZE } from './Composer.tsx';
import { Banner, Card, EmptyState, geometry, InnerCard, type } from './ds/index.ts';
import { useToastClearance } from './ds/Toast.tsx';
import { Glass } from './Glass.tsx';
import { ProjectTile } from './ProjectTile.tsx';
import { HarnessLogo, harnessName } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { Menu, TextMenu, ViewMenu, type MenuItem } from './Menu.tsx';
import { interactiveGlass, nativeGlass } from './NativeGlass.tsx';
import { canStartWith } from './new-task-projects.ts';
import { toggleSidebar, useSidebar } from './split.tsx';
import { MODES } from './status.tsx';
import { useColors } from './theme.ts';
import { useNewTask } from './useNewTask.ts';

/** A picker's row in the card: what it picks on the left, the native menu on the right. */
function PickerRow({ leading, label, children }: { leading: ReactNode; label: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.pickerRow}>
      <View style={styles.leading}>{leading}</View>
      <Text style={[type.callout, styles.spacer, { color: colors.muted }]}>{label}</Text>
      {children}
    </View>
  );
}

export function NewThread() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const form = useNewTask();
  const { hosts, deviceId, projects, projectId, provider, options, model, effort, efforts, mode, worktree, starting, pick } = form;
  // Kept in the draft store with the New task sheet's, so leaving the pane loses nothing.
  const prompt = useDrafts(s => s.text[NEW_TASK_DRAFT] ?? '');
  const setPrompt = (next: string) => setDraft(NEW_TASK_DRAFT, next);
  const host = hosts.find(h => h.id === deviceId);
  const project = projects.find(p => p.id === projectId);
  const collapsed = useSidebar(s => s.collapsed);
  const { chat, setChatPick, gates } = form;
  /** A menu item's subtitle and press for a gate: blocked items stay, say why, and explain when tapped. */
  const gated = (gate: MenuGate, run: () => void) => ({
    ...(gate.note ? { subtitle: gate.note } : {}),
    onPress: () => (gate.note ? Alert.alert(BLOCKED_TITLE, gate.note) : run()),
  });
  const attach = useComposerAttach(deviceId, false);
  // Toasts sit above the bar: its height plus its margin over the safe area.
  const [barHeight, setBarHeight] = useState(0);
  // With the keyboard up the home indicator is covered, so its inset would double the gap.
  const keyboardUp = useKeyboardState(state => state.isVisible);
  const barMargin = keyboardUp ? geometry.screenMargin : Math.max(insets.bottom, 10);
  // ToastHost stands on the keyboard while it's up, else on the bottom inset: measure from the same edge.
  useToastClearance(barHeight ? barHeight + (keyboardUp ? geometry.screenMargin : barMargin - insets.bottom) : 0);
  const ready = canStartWith({ deviceId, projectId, provider, prompt, starting, chat, allowed: form.allowed, attachments: attach.pending.length > 0 });

  const send = async () => {
    if (!ready) return;
    try {
      const prepared = attach.prepare(prompt);
      if (!prepared) return;
      const { sessionId: session, note } = await form.begin(prepared.text, prepared.images);
      setPrompt('');
      attach.clear();
      form.setStarting(false);
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
      if (typeof note === 'string' && note) Alert.alert('Started in a worktree', note.replace(/^Started in a worktree: /, ''));
    } catch (e) {
      Alert.alert('Could not start the task', (e as Error).message);
    }
  };

  const projectItems: MenuItem[] = [
    ...projects.map((p): MenuItem => ({ label: p.name, ios: 'folder', android: 'folder', checked: !chat && p.id === projectId, onPress: () => { setChatPick(false); pick({ projectId: p.id }); } })),
    ...(gates.chat.shown ? [{ label: 'Chat (no project)', ios: 'bubble.left', android: 'chat_bubble', checked: chat, ...gated(gates.chat, () => setChatPick(true)) } satisfies MenuItem] : []),
    ...(gates.addProject.shown ? [{ label: 'Add project…', ios: 'plus', android: 'add', section: 'More', ...gated(gates.addProject, () => router.push({ pathname: '/add-project', params: { device: deviceId } })) } satisfies MenuItem] : []),
  ];
  const computerItems: MenuItem[] = hosts.map(h => ({ label: h.name, ios: 'desktopcomputer', android: 'computer', checked: h.id === deviceId, onPress: () => form.pickDevice(h.id) }));
  const optionItems: MenuItem[] = [
    ...(chat || form.team || form.cloud ? [] : [{ label: 'New worktree', ios: 'arrow.triangle.branch', android: 'call_split', checked: worktree, onPress: () => form.setWorktree(w => !w) } satisfies MenuItem]),
    ...(chat || form.cloud || !gates.team.shown ? [] : [{ label: 'Team', ios: 'person.3', android: 'groups', checked: form.team, ...gated(gates.team, () => form.setTeamOn(on => !on)) } satisfies MenuItem]),
    ...(form.team ? teamChoices(form.teamRoster).map(t => ({ label: t.label, section: 'Team', checked: t.value === form.profileId, onPress: () => form.setTeamPick(t.value) })) : []),
    ...(form.runOnOptions.length > 1 ? form.runOnOptions.map(r => ({ label: r.label, section: 'Run on', checked: r.value === form.runOn, onPress: () => form.setRunOn(r.value) })) : []),
    ...MODES.map(m => ({ label: m.label, section: 'Permissions', checked: m.id === mode, onPress: () => pick({ mode: m.id }) })),
    ...efforts.map(e => ({ label: e.label, section: 'Effort', checked: e.value === effort, onPress: () => pick({ effort: e.value }) })),
  ];
  const harnessItems: MenuItem[] = [
    ...options.harnesses.map(h => ({ label: h.label, section: 'Harness', checked: h.value === provider, onPress: () => form.pickProvider(h.value) })),
    ...[{ value: 'default', label: 'Default' }, ...options.models.filter(m => m.value !== 'default')]
      .map(m => ({ label: m.label, section: 'Model', checked: m.value === model, onPress: () => form.pickModel(m.value) })),
  ];

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.pane, { paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
      {/* The Inbox route's own options stay on the screen; this pane has no large title or search. */}
      <Stack.Screen options={{ title: 'New thread', headerTitle: 'New thread', headerLargeTitle: false, headerSearchBarOptions: undefined }} />
      {/* Native items, so iOS puts them in the rail; only the Duo's split view shows this pane. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'} onPress={toggleSidebar} />
      </Stack.Toolbar>
      <View style={styles.center}>
        <Text accessibilityRole="header" style={[type.largeTitle, styles.title, { color: colors.text }]}>What should we work on?</Text>
        {/* As the New task sheet: a failed load says so, with Retry, instead of empty pickers. */}
        <Banner visible={!!form.problem} tone="danger" title="Couldn't load this computer's options" body={form.problem ?? undefined} action={{ label: 'Retry', onPress: form.retry }} style={styles.pickers} />
        {hosts.length ? (
          <>
            <Card style={styles.pickers}>
              <InnerCard>
                <PickerRow label="Project" leading={chat ? <Icon ios="bubble.left" android="chat_bubble" size={18} color={colors.muted} /> : project ? <ProjectTile deviceId={deviceId} projectId={project.id} name={project.name} size={20} /> : <Icon ios="folder" android="folder" size={18} color={colors.muted} />}>
                  <TextMenu text={chat ? 'Chat (no project)' : project?.name ?? 'Pick a project'} label="Project" items={projectItems} color={colors.muted} />
                </PickerRow>
                <PickerRow label="Computer" leading={<Icon ios="desktopcomputer" android="computer" size={18} color={colors.muted} />}>
                  <TextMenu text={host?.name ?? ''} label="Computer" items={computerItems} color={colors.muted} />
                </PickerRow>
              </InnerCard>
              {!!form.cloud && (
                <Text style={[type.footnote, styles.teamNote, { color: colors.muted }]} accessibilityLiveRegion="polite">{`Runs on a ${form.cloud.label} cloud machine with a copy of the project.`}</Text>
              )}
              {form.team && (
                <Text style={[type.footnote, styles.teamNote, { color: colors.muted }]} accessibilityLiveRegion="polite">{teamSummary(form.teamRoster, form.profileId)}</Text>
              )}
            </Card>
            {form.cloud
              ? !!form.cloudNote && <Text style={[type.footnote, styles.pickers, { color: colors.muted }]} accessibilityLiveRegion="polite">{form.cloudNote}</Text>
              : <AccessNote device={deviceId} methods={[form.method]} style={styles.pickers} />}
          </>
        ) : <EmptyState icon={{ ios: 'desktopcomputer', android: 'computer' }} title="No computer online" body="No computer with remote access is online." />}
      </View>
      <Glass style={[styles.bar, { marginBottom: barMargin }]} onLayout={e => setBarHeight(Math.ceil(e.nativeEvent.layout.height))}>
        <AttachChips pending={attach.pending} onRemove={attach.remove} uploading={starting && attach.hasImages} />
        <TextInput value={prompt} onChangeText={setPrompt} placeholder={starting ? 'Starting on the computer…' : form.team ? 'Ask the team…' : 'Ask the agent…'} placeholderTextColor={colors.faint}
          multiline editable={!starting} style={[type.callout, styles.input, { color: colors.text }]} accessibilityLabel="Message" />
        <View style={styles.row}>
          <Menu ios="plus" android="add" color={colors.text} label="More options" items={optionItems}
            modifiers={nativeGlass ? [frame({ width: SIZE, height: SIZE }), interactiveGlass('circle')] : undefined}>
            {icon => (nativeGlass ? icon : <View style={[styles.round, { backgroundColor: colors.fill }]}>{icon}</View>)}
          </Menu>
          <AttachButton items={attach.items} disabled={starting} />
          <View style={styles.spacer} />
          {!!provider && (
            <ViewMenu label={`${harnessName(provider)} model`} items={harnessItems}>
              <View style={styles.harness}>
                <HarnessLogo id={provider} size={18} />
                <Icon ios="chevron.down" android="expand_more" size={11} color={colors.muted} />
              </View>
            </ViewMenu>
          )}
          <Round label="Send" ios="arrow.up" android="arrow_upward" onPress={send} disabled={!ready}
            bg={ready ? colors.primary : colors.fill} fg={ready ? colors.onPrimary : colors.faint} />
        </View>
      </Glass>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 2 * geometry.rowInset },
  title: { textAlign: 'center' },
  pickers: { width: '100%', maxWidth: 440 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: geometry.rowInset, minHeight: geometry.rowHeight, paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding },
  leading: { minWidth: 22, alignItems: 'center' },
  teamNote: { paddingHorizontal: geometry.rowInset, paddingTop: geometry.cardPadding, paddingBottom: geometry.cardPadding / 2 },
  bar: { borderRadius: 26, marginHorizontal: geometry.screenMargin, padding: geometry.cardPadding, gap: geometry.cardPadding / 2, borderCurve: 'continuous' },
  input: { maxHeight: 140, minHeight: SIZE, paddingVertical: geometry.cardPadding, paddingHorizontal: geometry.cardPadding },
  row: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
  spacer: { flex: 1 },
  harness: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding / 2, height: SIZE, paddingHorizontal: geometry.cardPadding },
  round: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
});
