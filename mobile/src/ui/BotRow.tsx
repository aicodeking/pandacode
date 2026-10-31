// Bots in the inbox and the Duo sidebar: avatar, name, paused/working state, computer and the
// last message time. Tapping opens the bot's desktop conversation (bot.thread) as a task.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { memo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { Bot } from '../connect/types.ts';
import type { BotRow as Row } from '../store/inbox.ts';
import { useBackdrop } from './Backdrop.tsx';
import { Icon } from './Icon.tsx';
import { ago } from './status.tsx';
import { projectColor, useColors } from './theme.ts';

/** The bot's stored image (a data: URL), else its coloured initial. Decorative. */
export function BotAvatar({ bot, size = 32 }: { bot: Pick<Bot, 'avatar' | 'name'>; size?: number }) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (bot.avatar?.startsWith('data:image/')) return <Image source={{ uri: bot.avatar }} style={[styles.avatar, box]} contentFit="cover" accessible={false} />;
  return (
    <View style={[styles.avatar, box, { backgroundColor: projectColor(bot.name) }]} accessible={false}>
      <Text style={[styles.initial, { fontSize: size * 0.48 }]}>{bot.name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/** Opens the bot's conversation; `replace` swaps the open task (the Duo's sidebar). */
export async function openBot(deviceId: string, bot: Bot, replace?: boolean) {
  const sessionId = await connect.botThread(deviceId, bot.id);
  const href = { pathname: '/task/[device]/[session]' as const, params: { device: deviceId, session: sessionId } };
  if (replace) router.replace(href);
  else router.push(href);
}

export const BotRow = memo(function BotRow({ row, last, sidebar, selected, replace }: { row: Row; last: boolean; minute: number; sidebar?: boolean; selected?: boolean; replace?: boolean }) {
  const colors = useColors();
  const backdrop = useBackdrop();
  const { bot } = row;
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    try {
      await openBot(row.deviceId, bot, replace);
    } catch (error) {
      Alert.alert('Could not open the bot', (error as Error).message);
    } finally {
      setOpening(false);
    }
  };
  const state = bot.paused ? 'Paused' : bot.state === 'working' ? 'Working' : '';
  return (
    <Pressable onPress={open} disabled={opening} accessibilityRole="button" accessibilityHint="Opens the bot's conversation" accessibilityState={{ selected: !!selected, busy: opening }}
      style={({ pressed }) => [styles.row, sidebar ? [styles.sidebarRow, { backgroundColor: selected ? colors.fill : backdrop.grouped }] : { backgroundColor: backdrop.background }, pressed && { opacity: 0.7 }]}>
      <BotAvatar bot={bot} size={sidebar ? 30 : 34} />
      <View style={styles.text}>
        <View style={styles.line}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{bot.name}</Text>
          {opening ? <ActivityIndicator size="small" />
            : bot.state === 'working' && !bot.paused ? <ActivityIndicator size="small" color={colors.tint} style={styles.spinner} />
            : row.at ? <Text style={[styles.time, { color: colors.secondary }]}>{ago(row.at)}</Text> : null}
        </View>
        <View style={styles.line}>
          {bot.paused && <Icon ios="pause.circle.fill" android="pause_circle" size={12} color={colors.orange} />}
          <Text style={[styles.meta, { color: bot.paused ? colors.orange : colors.secondary }]} numberOfLines={1}>{[state, row.computer].filter(Boolean).join(' · ')}</Text>
        </View>
      </View>
      {!last && !sidebar && <View style={[styles.separator, { backgroundColor: colors.separator }]} />}
    </Pressable>
  );
}, (a, b) => a.row.bot === b.row.bot && a.row.at === b.row.at && a.row.computer === b.row.computer && a.last === b.last && a.minute === b.minute
  && a.sidebar === b.sidebar && a.selected === b.selected && a.replace === b.replace);

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initial: { color: '#ffffff', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 20, paddingRight: 18, paddingVertical: 10 },
  sidebarRow: { marginHorizontal: 8, paddingLeft: 12, paddingRight: 12, borderRadius: 14, borderCurve: 'continuous' },
  text: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 16, fontWeight: '600' },
  time: { fontSize: 14, fontVariant: ['tabular-nums'] },
  spinner: { transform: [{ scale: 0.75 }] },
  meta: { flex: 1, fontSize: 13 },
  separator: { position: 'absolute', left: 66, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
