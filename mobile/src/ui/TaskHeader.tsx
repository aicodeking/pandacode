// The task screen's native header: the title, a system back button (the sidebar toggle and New task in
// the Duo's split view) and one bar button item so the title keeps its room: a More menu (Changes, Pull
// request and Agents when the task has them, Pause/Resume for a bot, Model & permissions, Task info). Stop lives in the composer. A bot's conversation shows the bot's avatar and name. They are
// real UIBarButtonItems, so on the iPhone Duo iOS moves them into the side rail with the status bar;
// Android draws the same buttons in its app bar.
// With Liquid Glass the header is transparent and the transcript scrolls under it, over the app's ScrollEdge.
// iOS's own scroll edge effect is hidden by the transcript itself (see NO_EDGE_EFFECTS in transcript.tsx).
// `headerStyle: transparent` on a solid header does not work: a non-translucent
// UINavigationBar always paints an opaque background.
import { router, Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import { Alert, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { connect } from '../connect/client.ts';
import type { Bot } from '../connect/types.ts';
import { BotAvatar } from './BotRow.tsx';
import { taskKey, useConnect } from '../store/index.ts';
import { haptic, PressScale, ScrollEdge, type as textStyle } from './ds/index.ts';
import { hasGlass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { showActions, type MenuItem } from './Menu.tsx';
import { toggleSidebar, useSidebar, useSplit } from './split.tsx';
import { useColors } from './theme.ts';

type IconName = Pick<ComponentProps<typeof Icon>, 'ios' | 'android'>;

function Button({ icon, label, onPress, color }: { icon: IconName; label: string; onPress: () => void; color?: string }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityLabel={label} hitSlop={4} style={styles.icon}>
      <Icon {...icon} size={20} color={color ?? colors.text} />
    </PressScale>
  );
}

/** In the split view New task is the Inbox tab's New thread pane. */
export function openNewThread() {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/inbox');
}

/** Behind the transparent Liquid Glass header: the app's scroll edge. `height` = header height. */
export function HeaderBlur({ height }: { height: number }) {
  return <ScrollEdge bar={height} />;
}

/** How far past the composer's lower edge the dock's fade runs. */
const DOCK_RAMP = 32;

/** Under the composer: rows scrolling past it fade before the home indicator. `height` includes what's behind the composer's lower edge. */
export function DockFade({ height }: { height: number }) {
  return <ScrollEdge edge="bottom" bar={height - DOCK_RAMP} />;
}

/** Pause/Resume shows at once (the client rolls it back if the host refuses). */
export function pauseBot(deviceId: string, bot: Bot) {
  haptic('selection');
  connect.pauseBot(deviceId, bot.id, !bot.paused).catch(error => Alert.alert(bot.paused ? 'Could not resume' : 'Could not pause', (error as Error).message));
}

/** The bot's avatar beside its name, as the header title. */
function BotTitle({ bot }: { bot: Bot }) {
  const colors = useColors();
  return (
    <View style={styles.botTitle} accessible accessibilityRole="header" accessibilityLabel={`${bot.name}${bot.paused ? ', paused' : ''}`}>
      <BotAvatar bot={bot} size={24} />
      <Text style={[textStyle.headline, styles.botName, { color: colors.text }]} numberOfLines={1}>{bot.name}</Text>
    </View>
  );
}

const STATUS: Record<string, string> = { running: 'Working', waiting: 'Needs you', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
/** The back button and the More item, with their gaps. */
const BAR_ITEMS_WIDTH = 150;
/** A bar title stays bar-sized at any Dynamic Type size, as the system's does. */
const TITLE_FONT_SCALE = 1.2;

/** The task, then its project and status: a title view, so never in the Duo's rail. */
function TaskTitle({ title, detail }: { title: string; detail: string }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.taskTitle, { maxWidth: width - BAR_ITEMS_WIDTH }]} accessible accessibilityRole="header" accessibilityLabel={detail ? `${title}, ${detail}` : title}>
      <Text numberOfLines={1} maxFontSizeMultiplier={TITLE_FONT_SCALE} style={[textStyle.headline, { color: colors.text }]}>{title}</Text>
      {!!detail && <Text numberOfLines={1} maxFontSizeMultiplier={TITLE_FONT_SCALE} style={[textStyle.caption, { color: colors.muted }]}>{detail}</Text>}
    </View>
  );
}

/** `quiet`: the screen already says the run's state (the pill, a request card), so the subtitle names only the project. */
export function TaskHeader({ deviceId, sessionId, title, pull, agents, bot, quiet }: { deviceId: string; sessionId: string; title: string; pull: boolean; agents: boolean; bot?: Bot; quiet?: boolean }) {
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  const params = { device: deviceId, session: sessionId };
  const settings = () => router.push({ pathname: '/task-settings', params });
  const info = () => router.push({ pathname: '/task-info', params });
  const openPull = () => router.push({ pathname: '/pull', params });
  const changes = () => router.push({ pathname: '/changes', params });
  const openAgents = () => router.push({ pathname: '/agents', params });
  const pause = () => bot && pauseBot(deviceId, bot);
  const detail = useConnect(s => {
    const task = s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
    const live = s.live[taskKey(deviceId, sessionId)]?.status;
    const status = live && live !== 'idle' ? live : task?.status;
    return [task?.chat ? 'Chat' : task?.projectName, !quiet && status && STATUS[status]].filter(Boolean).join(' · ');
  });
  // A custom title view can't go in the Duo's rail, so the split view keeps the plain title.
  const headerTitle = split ? undefined : bot ? () => <BotTitle bot={bot} /> : () => <TaskTitle title={title} detail={detail} />;
  const options = { headerShown: true, headerTransparent: hasGlass, headerShadowVisible: false, title: bot?.name ?? title, headerTitle, headerBackButtonDisplayMode: 'minimal' } as const;
  if (Platform.OS !== 'ios') {
    const more: MenuItem[] = [
      ...(bot ? [{ label: bot.paused ? 'Resume bot' : 'Pause bot', android: bot.paused ? 'play_circle' : 'pause_circle', onPress: pause } as const] : []),
      { label: 'Changes', android: 'difference', onPress: changes },
      ...(pull ? [{ label: 'Pull request', android: 'merge', onPress: openPull } as const] : []),
      ...(agents ? [{ label: 'Agents', android: 'groups', onPress: openAgents } as const] : []),
      { label: 'Model & permissions', android: 'tune', onPress: settings },
      { label: 'Task info', android: 'info', onPress: info },
    ];
    return <Stack.Screen options={{ ...options, headerRight: () => (
      <View style={styles.row}>
        <Button icon={{ ios: 'ellipsis.circle', android: 'more_vert' }} label="More" onPress={() => showActions(undefined, more)} />
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
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="More">
          <Stack.Toolbar.MenuAction icon={bot?.paused ? 'play.circle' : 'pause.circle'} hidden={!bot} onPress={pause}>{bot?.paused ? 'Resume bot' : 'Pause bot'}</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="arrow.triangle.branch" onPress={changes}>Changes</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="arrow.triangle.pull" hidden={!pull} onPress={openPull}>Pull request</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="person.2" hidden={!agents} onPress={openAgents}>Agents</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="slider.horizontal.3" onPress={settings}>Model & permissions</Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="info.circle" onPress={info}>Task info</Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  taskTitle: { alignItems: 'center' },
  botTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 220 },
  botName: { flexShrink: 1 },
});
