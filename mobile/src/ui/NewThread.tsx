// The iPhone Duo's empty right pane (split.tsx): "What should we work on?" with project and
// computer pickers, and a composer whose send starts the task (useNewTask) and opens it.
import { router, Stack } from 'expo-router';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { useState, type ReactNode } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Round, SIZE } from './Composer.tsx';
import { Card, EmptyState, geometry, InnerCard, type } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { ProjectTile } from './ProjectTile.tsx';
import { HarnessLogo, harnessName } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { Menu, TextMenu, ViewMenu, type MenuItem } from './Menu.tsx';
import { interactiveGlass, nativeGlass } from './NativeGlass.tsx';
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
  const [prompt, setPrompt] = useState('');
  const host = hosts.find(h => h.id === deviceId);
  const project = projects.find(p => p.id === projectId);
  const collapsed = useSidebar(s => s.collapsed);

  const send = async () => {
    if (!form.canStart(prompt)) return;
    try {
      const { sessionId: session, note } = await form.start(prompt);
      setPrompt('');
      form.setStarting(false);
      router.push({ pathname: '/task/[device]/[session]', params: { device: deviceId, session } });
      if (note) Alert.alert('Started in a worktree', note.replace(/^Started in a worktree: /, ''));
    } catch (e) {
      Alert.alert('Could not start the task', (e as Error).message);
    }
  };

  const projectItems: MenuItem[] = projects.map(p => ({ label: p.name, ios: 'folder', android: 'folder', checked: p.id === projectId, onPress: () => pick({ projectId: p.id }) }));
  const computerItems: MenuItem[] = hosts.map(h => ({ label: h.name, ios: 'desktopcomputer', android: 'computer', checked: h.id === deviceId, onPress: () => form.pickDevice(h.id) }));
  const optionItems: MenuItem[] = [
    { label: 'New worktree', ios: 'arrow.triangle.branch', android: 'call_split', checked: worktree, onPress: () => form.setWorktree(w => !w) },
    ...MODES.map(m => ({ label: m.label, section: 'Permissions', checked: m.id === mode, onPress: () => pick({ mode: m.id }) })),
    ...efforts.map(e => ({ label: e.label, section: 'Effort', checked: e.value === effort, onPress: () => pick({ effort: e.value }) })),
  ];
  const harnessItems: MenuItem[] = [
    ...options.harnesses.map(h => ({ label: h.label, section: 'Harness', checked: h.value === provider, onPress: () => form.pickProvider(h.value) })),
    ...[{ value: 'default', label: 'Default' }, ...options.models.filter(m => m.value !== 'default')]
      .map(m => ({ label: m.label, section: 'Model', checked: m.value === model, onPress: () => form.pickModel(m.value) })),
  ];
  const ready = form.canStart(prompt);

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.pane, { paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: colors.background }]}>
      {/* The Inbox route's own options stay on the screen; this pane has no large title or search. */}
      <Stack.Screen options={{ title: 'New thread', headerLargeTitle: false, headerSearchBarOptions: undefined }} />
      {/* Native items, so iOS puts them in the rail; only the Duo's split view shows this pane. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'} onPress={toggleSidebar} />
      </Stack.Toolbar>
      <View style={styles.center}>
        <Text accessibilityRole="header" style={[type.largeTitle, styles.title, { color: colors.text }]}>What should we work on?</Text>
        {hosts.length ? (
          <Card style={styles.pickers}>
            <InnerCard>
              <PickerRow label="Project" leading={project ? <ProjectTile deviceId={deviceId} projectId={project.id} name={project.name} size={20} /> : <Icon ios="folder" android="folder" size={18} color={colors.muted} />}>
                <TextMenu text={project?.name ?? 'Pick a project'} label="Project" items={projectItems} color={colors.muted} />
              </PickerRow>
              <PickerRow label="Computer" leading={<Icon ios="desktopcomputer" android="computer" size={18} color={colors.muted} />}>
                <TextMenu text={host?.name ?? ''} label="Computer" items={computerItems} color={colors.muted} />
              </PickerRow>
            </InnerCard>
          </Card>
        ) : <EmptyState icon={{ ios: 'desktopcomputer', android: 'computer' }} title="No computer online" body="No computer with remote access is online." />}
      </View>
      <Glass style={[styles.bar, { marginBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput value={prompt} onChangeText={setPrompt} placeholder={starting ? 'Starting on the computer…' : 'Ask the agent…'} placeholderTextColor={colors.faint}
          multiline editable={!starting} style={[type.callout, styles.input, { color: colors.text }]} accessibilityLabel="Message" />
        <View style={styles.row}>
          <Menu ios="plus" android="add" color={colors.text} label="More options" items={optionItems}
            modifiers={nativeGlass ? [frame({ width: SIZE, height: SIZE }), interactiveGlass('circle')] : undefined}>
            {icon => (nativeGlass ? icon : <View style={[styles.round, { backgroundColor: colors.fill }]}>{icon}</View>)}
          </Menu>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 24 },
  title: { textAlign: 'center' },
  pickers: { width: '100%', maxWidth: 440 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 12, paddingVertical: 6 },
  leading: { minWidth: 22, alignItems: 'center' },
  bar: { borderRadius: 26, marginHorizontal: geometry.screenMargin, padding: 8, gap: 4, borderCurve: 'continuous' },
  input: { maxHeight: 140, minHeight: SIZE, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spacer: { flex: 1 },
  harness: { flexDirection: 'row', alignItems: 'center', gap: 4, height: SIZE, paddingHorizontal: 6 },
  round: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
});
