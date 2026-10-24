// The task screen's native header: the title, a system back button (the sidebar toggle and New
// task in the Duo's split view) and bar button items for Model & permissions, Task info and Stop
// while running. They are real UIBarButtonItems, so on the iPhone Duo iOS moves them into the
// side rail with the status bar; Android draws the same buttons in its app bar.
// With Liquid Glass the header is transparent, so the wallpaper shows behind the title; the task
// screen starts the transcript below it, because an inverted list scrolling under the bar gets a
// scroll edge effect that blurs most of it. `headerStyle: transparent` on a solid header does
// not work: a non-translucent UINavigationBar always paints an opaque background.
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { connect } from '../connect/client.ts';
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

export function stopTask(deviceId: string, sessionId: string) {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  connect.stopTask(deviceId, sessionId).catch(error => Alert.alert('Could not stop', (error as Error).message));
}

/** In the split view New task is the Inbox tab's New thread pane. */
export function openNewThread() {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/inbox');
}

export function TaskHeader({ deviceId, sessionId, title, running }: { deviceId: string; sessionId: string; title: string; running: boolean }) {
  const colors = useColors();
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  const params = { device: deviceId, session: sessionId };
  const settings = () => router.push({ pathname: '/task-settings', params });
  const info = () => router.push({ pathname: '/task-info', params });
  const stop = () => stopTask(deviceId, sessionId);
  const options = { headerShown: true, headerTransparent: hasGlass, headerShadowVisible: false, title, headerBackButtonDisplayMode: 'minimal' } as const;
  if (Platform.OS !== 'ios') {
    return <Stack.Screen options={{ ...options, headerRight: () => (
      <View style={styles.row}>
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
        <Stack.Toolbar.Button icon="slider.horizontal.3" accessibilityLabel="Model and permissions" onPress={settings} />
        <Stack.Toolbar.Button icon="info.circle" accessibilityLabel="Task info" onPress={info} />
        <Stack.Toolbar.Button icon="stop.circle.fill" accessibilityLabel="Stop" tintColor={colors.red} hidden={!running} onPress={stop} />
      </Stack.Toolbar>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
