// The composer's slash menu: typing `/` at the start of the draft lists the task's commands (slash.list)
// inside the composer's glass, above the input, so it moves with the keyboard and keeps the dock's Duo
// insets. Taps never dismiss the keyboard; picking a command puts `/name ` in the draft. A failed
// listing shows why with a Retry row.
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { runsOnPhone, type SlashCommand } from '../store/slash.ts';
import { useColors } from './theme.ts';
import { crossFadeIn, crossFadeOut, geometry, PressScale, Skeleton, type as textStyle } from './ds/index.ts';

/** The menu never covers more than this share of the window, so the transcript stays in view. */
const MAX_SHARE = 0.32;
const MAX_HEIGHT = 280;
const DISABLED_OPACITY = 0.45;

function CommandRow({ command, onPick }: { command: SlashCommand; onPick: (command: SlashCommand) => void }) {
  const colors = useColors();
  const phone = runsOnPhone(command);
  const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
  const note = !command.available ? (command.reason ?? 'Only in the harness’s terminal') : !phone ? 'On your computer only' : command.description;
  return (
    <PressScale onPress={() => onPick(command)} accessibilityRole="button" accessibilityLabel={`${command.name}${hint}. ${note}`}
      accessibilityState={{ disabled: !phone }} style={[styles.row, !phone && styles.dim]}>
      <Text numberOfLines={1} style={[textStyle.subhead, { color: colors.text }]}>
        <Text style={styles.name}>{command.name}</Text>
        <Text style={{ color: colors.faint }}>{hint}</Text>
      </Text>
      <Text numberOfLines={1} style={[textStyle.footnote, { color: colors.muted }]}>{note}</Text>
    </PressScale>
  );
}

function RetryRow({ error, onRetry }: { error: string; onRetry: () => void }) {
  const colors = useColors();
  return (
    <PressScale onPress={onRetry} accessibilityRole="button" accessibilityLabel={`Couldn’t list commands. ${error}`} accessibilityHint="Tries again" style={styles.row}>
      <Text numberOfLines={1} style={[textStyle.subhead, styles.name, { color: colors.tint }]}>Retry</Text>
      <Text numberOfLines={2} style={[textStyle.footnote, { color: colors.muted }]}>{`Couldn’t list commands: ${error}`}</Text>
    </PressScale>
  );
}

export function SlashMenu({ commands, loading, error, onPick, onRetry }: { commands: readonly SlashCommand[]; loading: boolean; error: string; onPick: (command: SlashCommand) => void; onRetry: () => void }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const maxHeight = Math.min(MAX_HEIGHT, Math.round(height * MAX_SHARE));
  return (
    <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={[styles.menu, { maxHeight, borderColor: colors.border, backgroundColor: colors.cardInner }]}
      accessibilityLabel="Slash commands">
      {loading && !commands.length ? (
        <View style={styles.loading}><Skeleton width="40%" /><Skeleton width="70%" /></View>
      ) : error ? (
        <RetryRow error={error} onRetry={onRetry} />
      ) : !commands.length ? (
        <Text style={[textStyle.footnote, styles.empty, { color: colors.muted }]}>No matching commands</Text>
      ) : (
        <ScrollView keyboardShouldPersistTaps="always" keyboardDismissMode="none" nestedScrollEnabled contentContainerStyle={styles.list}>
          {commands.map(command => <CommandRow key={command.name} command={command} onPick={onPick} />)}
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  menu: { borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, marginBottom: 6, overflow: 'hidden' },
  list: { paddingVertical: 4 },
  row: { paddingHorizontal: 12, paddingVertical: 7, gap: 1 },
  name: { fontWeight: '600' },
  dim: { opacity: DISABLED_OPACITY },
  loading: { padding: 12, gap: 8 },
  empty: { padding: 12 },
});
