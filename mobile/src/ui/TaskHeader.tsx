// The task screen's native header: the title, a system back button (the sidebar toggle and New
// task in the Duo's split view) and bar button items for the pull request (when one is linked),
// Changes, Agents (person.3, when the task has subagents or a team), a More menu (Model & permissions, Task info; folded so the title keeps its room) and
// Stop while running. A bot's conversation shows the
// bot's avatar and name and a Pause/Resume item. They are real UIBarButtonItems, so on the iPhone Duo iOS moves them into the
// side rail with the status bar; Android draws the same buttons in its app bar.
// With Liquid Glass the header is transparent and the transcript scrolls under it. iOS's own
// scroll edge effect is hidden: the inverted list is flipped, so UIKit sized it from the wrong
// edge and blurred most of the transcript. HeaderBlur draws the bar's material instead.
// `headerStyle: transparent` on a solid header does not work: a non-translucent
// UINavigationBar always paints an opaque background.
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import { BlurView } from 'expo-blur';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Material } from './Backdrop.tsx';
import { connect } from '../connect/client.ts';
import type { Bot } from '../connect/types.ts';
import { BotAvatar } from './BotRow.tsx';
import { hasGlass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { toggleSidebar, useSidebar, useSplit } from './split.tsx';
import { useColors } from './theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;

function Button({ icon, label, onPress, color }: { icon: IconName; label: string; onPress: () => void; color?: string }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4} style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
      <Icon {...icon} size={20} color={color ?? colors.text} />
    </Pressable>
  );
}

/** "Stopping…" shows at once (the client rolls it back if the host refuses). */
export function stopTask(deviceId: string, sessionId: string) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  connect.stopTask(deviceId, sessionId).catch(error => Alert.alert('Could not stop', (error as Error).message));
}

/** In the split view New task is the Inbox tab's New thread pane. */
export function openNewThread() {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/inbox');
}

/** Softer blur bands under the material (offset below it, height), so the bar's edge fades instead of cutting off. */
const BAND = 6;
const EDGE = [45, 25, 10].map((intensity, i) => ({ intensity, offset: i * BAND }));

/** The bar's blur behind the transparent Liquid Glass header (iOS 26), `height` = header height. */
export function HeaderBlur({ height }: { height: number }) {
  const colors = useColors();
  if (!hasGlass) return null;
  return (
    <View style={[styles.blur, { height: height + EDGE.length * BAND }]} pointerEvents="none" accessible={false}>
      <Material material="systemChromeMaterial" style={{ height }} />
      {EDGE.map(band => <BlurView key={band.intensity} tint="systemChromeMaterial" intensity={band.intensity} style={[styles.band, { top: height + band.offset }]} />)}
      <View style={[styles.hairline, { top: height, backgroundColor: colors.separator }]} />
    </View>
  );
}

/** Pause/Resume shows at once (the client rolls it back if the host refuses). */
export function pauseBot(deviceId: string, bot: Bot) {
  void Haptics.selectionAsync();
  connect.pauseBot(deviceId, bot.id, !bot.paused).catch(error => Alert.alert(bot.paused ? 'Could not resume' : 'Could not pause', (error as Error).message));
}

/** The bot's avatar beside its name, as the header title. */
function BotTitle({ bot }: { bot: Bot }) {
  const colors = useColors();
  return (
    <View style={styles.botTitle} accessible accessibilityRole="header" accessibilityLabel={`${bot.name}${bot.paused ? ', paused' : ''}`}>
      <BotAvatar bot={bot} size={24} />
      <Text style={[styles.botName, { color: colors.text }]} numberOfLines={1}>{bot.name}</Text>
    </View>
  );
}

export function TaskHeader({ deviceId, sessionId, title, running, pull, agents, bot }: { deviceId: string; sessionId: string; title: string; running: boolean; pull: boolean; agents: boolean; bot?: Bot }) {
  const colors = useColors();
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  const params = { device: deviceId, session: sessionId };
  const settings = () => router.push({ pathname: '/task-settings', params });
  const info = () => router.push({ pathname: '/task-info', params });
  const openPull = () => router.push({ pathname: '/pull', params });
  const changes = () => router.push({ pathname: '/changes', params });
  const openAgents = () => router.push({ pathname: '/agents', params });
  const stop = () => stopTask(deviceId, sessionId);
  const pause = () => bot && pauseBot(deviceId, bot);
  // A custom title view can't go in the Duo's rail, so the split view keeps the plain title.
  const headerTitle = bot && !split ? () => <BotTitle bot={bot} /> : undefined;
  const options = { headerShown: true, headerTransparent: hasGlass, headerShadowVisible: false, title: bot?.name ?? title, headerTitle, headerBackButtonDisplayMode: 'minimal', scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' } } as const;
  if (Platform.OS !== 'ios') {
    return <Stack.Screen options={{ ...options, headerRight: () => (
      <View style={styles.row}>
        {!!bot && <Button icon={bot.paused ? { ios: 'play.circle', android: 'play_circle' } : { ios: 'pause.circle', android: 'pause_circle' }} label={bot.paused ? 'Resume bot' : 'Pause bot'} onPress={pause} />}
        {pull && <Button icon={{ ios: 'arrow.triangle.pull', android: 'merge' }} label="Pull request" onPress={openPull} />}
        {agents && <Button icon={{ ios: 'person.3', android: 'groups' }} label="Agents" onPress={openAgents} />}
        <Button icon={{ ios: 'plus.forwardslash.minus', android: 'difference' }} label="Changes" onPress={changes} />
        <Button icon={{ ios: 'slider.horizontal.3', android: 'tune' }} label="Model and permissions" onPress={settings} />
        <Button icon={{ ios: 'info.circle', android: 'info' }} label="Task info" onPress={info} />
        {running && <Button icon={{ ios: 'stop.circle.fill', android: 'stop_circle' }} label="Stop" onPress={stop} color={colors.red as string} />}
      </View>
    ) }} />;
  }
  return (
    <>
      <Stack.Screen options={options} />
      {split && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'} onPress={toggleSidebar} />
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New task" onPress={openNewThread} />
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={bot?.paused ? 'play.circle' : 'pause.circle'} accessibilityLabel={bot?.paused ? 'Resume bot' : 'Pause bot'} hidden={!bot} onPress={pause} />
        <Stack.Toolbar.Button icon="arrow.triangle.pull" accessibilityLabel="Pull request" hidden={!pull} onPress={openPull} />
        <Stack.Toolbar.Button icon="person.3" accessibilityLabel="Agents" hidden={!agents} onPress={openAgents} />
        <Stack.Toolbar.Button icon="plus.forwardslash.minus" accessibilityLabel="Changes" onPress={changes} />
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="More">
          <Stack.Toolbar.MenuAction icon="slider.horizontal.3" onPress={settings}>Model & permissions</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="info.circle" onPress={info}>Task info</Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon="stop.circle.fill" accessibilityLabel="Stop" tintColor={colors.red} hidden={!running} onPress={stop} />
      </Stack.Toolbar>
    </>
  );
}

const styles = StyleSheet.create({
  blur: { position: 'absolute', top: 0, left: 0, right: 0 },
  band: { position: 'absolute', left: 0, right: 0, height: BAND },
  hairline: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  botTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 220 },
  botName: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
});
