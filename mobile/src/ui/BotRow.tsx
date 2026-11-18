// Bots in the inbox and the Duo sidebar: avatar, name, paused/working state, computer and the
// last message time. Tapping opens the bot's desktop conversation (bot.thread) as a task; a long press
// offers Bot settings (bot-admin.tsx) when the computer serves bot.detail.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { memo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { capabilitiesOf } from '../connect/api/capabilities.ts';
import { allows } from '../connect/api/hello.ts';
import { connect } from '../connect/client.ts';
import type { Bot } from '../connect/types.ts';
import type { BotRow as Row } from '../store/inbox.ts';
import { ROW_PRESS_DELAY_MS } from './InboxCard.tsx';
import { showActions } from './Menu.tsx';
import type { SidebarOpen } from './sidebar-nav.ts';
import { openFromSidebar } from './sidebar-open.ts';
import { CrossFadeText, PressScale, StatusDot, type, VIEWER } from './ds/index.ts';
import { ago } from './status.tsx';
import { projectColor, useColors } from './theme.ts';

/** The bot's stored image (a data: URL), else its coloured initial. Decorative. */
export function BotAvatar({ bot, size = 32 }: { bot: Pick<Bot, 'avatar' | 'name'>; size?: number }) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (bot.avatar?.startsWith('data:image/')) return <Image source={{ uri: bot.avatar }} style={[styles.avatar, box]} contentFit="cover" accessible={false} />;
  return (
    <View style={[styles.avatar, box, { backgroundColor: projectColor(bot.name) }]} accessible={false}>
      <Text allowFontScaling={false} style={[styles.initial, { fontSize: size * 0.48 }]}>{bot.name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/** Opens the bot's conversation; `how` is the Duo sidebar's decision (sidebar-nav.ts), else a push. */
export async function openBot(deviceId: string, bot: Bot, how?: SidebarOpen) {
  const sessionId = await connect.botThread(deviceId, bot.id);
  const href = { pathname: '/task/[device]/[session]' as const, params: { device: deviceId, session: sessionId } };
  openFromSidebar(href, how);
}

/** Opens the bot's settings screen. */
export const openBotSettings = (deviceId: string, botId: string) => router.push({ pathname: '/bot-admin', params: { device: deviceId, bot: botId } });

/** The long-press menu; Bot settings only while this phone may use bot.detail there (unknown counts as yes). */
function botMenu(deviceId: string, bot: Bot, open: () => void) {
  const settings = allows(capabilitiesOf(deviceId), 'bot.detail');
  showActions(bot.name, [
    { label: 'Open conversation', ios: 'bubble.left', android: 'chat', onPress: open },
    ...(settings ? [{ label: 'Bot settings', ios: 'gearshape' as const, android: 'settings' as const, onPress: () => openBotSettings(deviceId, bot.id) }] : []),
  ]);
}

/** Matches InboxRow: accessibility sizes wrap instead of truncating. */
const LARGE_TEXT = 1.35;

export const BotRow = memo(function BotRow({ row, showComputer, sidebar, selected, how }: { row: Row; showComputer: boolean; minute: number; sidebar?: boolean; selected?: boolean; how?: SidebarOpen }) {
  const colors = useColors();
  const { bot } = row;
  const [opening, setOpening] = useState(false);
  const [pressed, setPressed] = useState(false);
  const open = async () => {
    setOpening(true);
    try {
      await openBot(row.deviceId, bot, how);
    } catch (error) {
      Alert.alert('Could not open the bot', (error as Error).message);
    } finally {
      setOpening(false);
    }
  };
  const working = bot.state === 'working' && !bot.paused;
  const state = bot.paused ? 'Paused' : working ? 'Working' : '';
  const subtitle = [state, showComputer ? row.computer : ''].filter(Boolean).join(' · ');
  const large = useWindowDimensions().fontScale >= LARGE_TEXT;
  return (
    <PressScale scale={1} unstable_pressDelay={ROW_PRESS_DELAY_MS} onPress={open} onLongPress={() => botMenu(row.deviceId, bot, () => void open())} disabled={opening} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
      accessibilityLabel={[bot.name, state, row.computer].filter(Boolean).join(', ')} accessibilityHint="Opens the bot's conversation"
      accessibilityActions={[{ name: 'longpress', label: 'Bot settings' }]} onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'longpress') openBotSettings(row.deviceId, bot.id); }}
      accessibilityState={{ selected: !!selected, busy: opening }}
      style={[styles.row, large && styles.rowLarge, (selected || pressed) && [styles.selected, { backgroundColor: colors.fill }]]}>
      <BotAvatar bot={bot} size={sidebar ? 24 : 28} />
      <View style={styles.text}>
        <View style={styles.line}>
          <Text numberOfLines={large ? 3 : 1} style={[type.calloutMedium, styles.grow, { color: colors.text }]}>{bot.name}</Text>
          {opening ? <ActivityIndicator size="small" /> : working ? <StatusDot tone="running" pulse /> : row.at ? <CrossFadeText text={ago(row.at)} numberOfLines={1} style={[type.footnote, { color: colors.muted }]} /> : null}
        </View>
        {!!subtitle && <CrossFadeText text={subtitle} numberOfLines={large ? 3 : 1} style={[type.footnote, { color: bot.paused ? colors.warning : colors.muted }]} />}
      </View>
    </PressScale>
  );
}, (a, b) => a.row.bot === b.row.bot && a.row.at === b.row.at && a.row.computer === b.row.computer && a.showComputer === b.showComputer && a.minute === b.minute
  && a.sidebar === b.sidebar && a.selected === b.selected && a.how === b.how);

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // White on the saturated tile colour in every scheme, as over a photo.
  initial: { color: VIEWER.text, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 9 },
  rowLarge: { alignItems: 'flex-start' },
  selected: { borderRadius: 12, borderCurve: 'continuous' },
  text: { flex: 1, minWidth: 0, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
});
