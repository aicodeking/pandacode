// The task composer: a floating glass panel with the prompt over a row of a + menu, the task's
// branch chip, the harness (opens the model picker) and a round send button. Send queues while
// running (like the desktop's Enter) and a long press steers; "Steer instead of queue" swaps
// them. An empty field while running shows Stop. Unreachable computers keep the message in the outbox.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View, type ColorValue } from 'react-native';
import { connect } from '../connect/client.ts';
import { useConnect } from '../store/index.ts';
import { markSteered, sendOrQueue } from '../store/local.ts';
import { Glass } from './Glass.tsx';
import { GlassIcon, interactiveGlass, nativeGlass } from './NativeGlass.tsx';
import { HarnessLogo, harnessName } from './harness.tsx';
import { Icon } from './Icon.tsx';
import { Menu } from './Menu.tsx';
import { useColors } from './theme.ts';

export const SIZE = 36;

export function Composer({ deviceId, sessionId, running }: { deviceId: string; sessionId: string; running: boolean }) {
  const colors = useColors();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [steer, setSteer] = useState(false);
  const branch = useConnect(s => s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.branch ?? '');
  const provider = useConnect(s => s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId)?.provider ?? '');
  const act = async (kind: 'send' | 'steer' | 'stop') => {
    const prompt = text.trim();
    if (kind !== 'stop' && !prompt) return;
    setBusy(true);
    try {
      if (kind === 'stop') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        await connect.stopTask(deviceId, sessionId);
      } else if (running && kind === 'steer') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        await connect.steerTask(deviceId, sessionId, prompt);
        markSteered(prompt);
        setText('');
        setNote('Steering…');
      } else {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        const result = await sendOrQueue(deviceId, sessionId, prompt);
        setText('');
        setNote(result.outbox ? 'Saved. Sends when the computer is back' : result.queued ? 'Queued for after this run' : '');
      }
    } catch (error) {
      Alert.alert(kind === 'stop' ? 'Could not stop' : 'Could not send', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const settings = (focus: string) => () => router.push({ pathname: '/task-settings', params: { device: deviceId, session: sessionId, focus } });
  const hasText = !!text.trim();
  // While running, a tap does the preferred action and a long press the other one.
  const tap = running && steer ? 'steer' : 'send';
  const hold = running ? (steer ? 'send' : 'steer') : undefined;
  return (
    <Glass style={styles.bar}>
      <TextInput
        value={text}
        onChangeText={t => { setText(t); if (note) setNote(''); }}
        placeholder={note || (running && steer ? 'Steer the agent…' : 'Ask the agent…')}
        placeholderTextColor={colors.tertiary as string}
        multiline
        style={[styles.input, { color: colors.text }]}
        accessibilityLabel="Message"
      />
      <View style={styles.row}>
        <Menu ios="plus" android="add" color={colors.text} label="More options" modifiers={nativeGlass ? [frame({ width: SIZE, height: SIZE }), interactiveGlass('circle')] : undefined} items={[
          { label: 'Steer instead of queue', ios: 'arrow.uturn.right', android: 'alt_route', checked: steer, onPress: () => setSteer(s => !s) },
          { label: 'Model…', ios: 'cpu', android: 'memory', onPress: settings('model') },
          { label: 'Permissions…', ios: 'lock.shield', android: 'shield', onPress: settings('mode') },
          { label: 'Effort…', ios: 'gauge.with.dots.needle.67percent', android: 'speed', onPress: settings('effort') },
        ]}>
          {icon => (nativeGlass ? icon : <View style={[styles.round, { backgroundColor: colors.fill }]}>{icon}</View>)}
        </Menu>
        {!!branch && (
          <Pressable onPress={() => router.push({ pathname: '/task-info', params: { device: deviceId, session: sessionId } })} accessibilityRole="button" accessibilityLabel={`Branch ${branch}`} accessibilityHint="Shows task info"
            style={({ pressed }) => [styles.chip, { backgroundColor: colors.fill, opacity: pressed ? 0.7 : 1 }]}>
            <Icon ios="arrow.triangle.branch" android="call_split" size={13} color={colors.green} />
            <Text style={[styles.chipText, { color: colors.green }]} numberOfLines={1}>{branch}</Text>
          </Pressable>
        )}
        <View style={styles.spacer} />
        {!!provider && (
          <Pressable onPress={settings('model')} accessibilityRole="button" accessibilityLabel={`${harnessName(provider)} model`} hitSlop={6} style={({ pressed }) => [styles.harness, pressed && { opacity: 0.6 }]}>
            <HarnessLogo id={provider} size={18} />
            <Icon ios="chevron.down" android="expand_more" size={11} color={colors.secondary} />
          </Pressable>
        )}
        {running && !hasText
          ? <Round label="Stop" ios="stop.fill" android="stop" onPress={() => act('stop')} disabled={busy} bg={colors.text} fg={colors.background} />
          : <Round label={tap === 'steer' ? 'Steer' : running ? 'Queue' : 'Send'} hint={hold && (hold === 'steer' ? 'Long press to steer' : 'Long press to queue')}
              ios={running ? (tap === 'steer' ? 'arrow.uturn.right' : 'list.number') : 'arrow.up'} android={running ? (tap === 'steer' ? 'alt_route' : 'format_list_numbered') : 'arrow_upward'}
              onPress={() => act(tap)} onLongPress={hold && (() => act(hold))} disabled={busy || !hasText} bg={hasText ? colors.tint : colors.fill} fg={hasText ? colors.onTint : colors.tertiary} />}
      </View>
    </Glass>
  );
}

export function Round({ label, hint, ios, android, onPress, onLongPress, disabled, bg, fg }: { label: string; hint?: string; ios: Parameters<typeof Icon>[0]['ios']; android: Parameters<typeof Icon>[0]['android']; onPress: () => void; onLongPress?: () => void; disabled?: boolean; bg: ColorValue; fg: ColorValue }) {
  if (nativeGlass) return <GlassIcon icon={ios} label={label} hint={hint} onPress={onPress} onLongPress={onLongPress} disabled={disabled} size={SIZE} iconSize={15} color={fg} tint={bg} />;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} hitSlop={6}
      style={({ pressed }) => [styles.round, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}>
      <Icon ios={ios} android={android} size={15} color={fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: 26, marginHorizontal: 12, padding: 8, gap: 4, borderCurve: 'continuous' },
  input: { fontSize: 16, maxHeight: 140, minHeight: SIZE, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: SIZE - 4, maxWidth: 180, borderRadius: (SIZE - 4) / 2, paddingHorizontal: 11 },
  chipText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  spacer: { flex: 1 },
  harness: { flexDirection: 'row', alignItems: 'center', gap: 4, height: SIZE, paddingHorizontal: 6 },
  round: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
});
