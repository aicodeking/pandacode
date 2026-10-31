import '../connect/polyfill.ts';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { connect } from '../connect/client.ts';
import { LiveActivityHost } from '../live/LiveActivityHost.tsx';
import { HOME, SIGN_IN } from '../routes.ts';
import { useStatus } from '../store/index.ts';
import { useOutboxFlusher } from '../store/local.ts';
import { usePushNotifications } from '../ui/push.ts';
import { loadAppearance } from '../ui/appearance.ts';
import { useWallpaperShown, WallpaperLayer } from '../ui/Backdrop.tsx';
import { hasGlass } from '../ui/Glass.tsx';
import { MenuHost } from '../ui/Menu.tsx';
import { Sidebar } from '../ui/Sidebar.tsx';
import { useSidebar, useSplit } from '../ui/split.tsx';
import { useColors } from '../ui/theme.ts';

// A task opened from a deep link still has the tabs under it to go back to.
// Every guard names its redirect: the default is this anchor, `/(tabs)`, which is `/` and has no
// index in the group, so a guard flip (sign-in, entering or leaving the demo) hit Unmatched Route.
export const unstable_settings = { anchor: '(tabs)' };

// While the wallpaper shows, screens draw no background of their own so it reaches every pane.
const clear = (theme: typeof DefaultTheme) => ({ ...theme, colors: { ...theme.colors, background: 'transparent' } });
const THEMES = { light: DefaultTheme, dark: DarkTheme, clearLight: clear(DefaultTheme), clearDark: clear(DarkTheme) };

const sheet = { presentation: 'formSheet', sheetGrabberVisible: true, headerShown: true } as const;
/** Pull request, Changes and a diff push over the task with a native header (Liquid Glass where available). */
const pushed = { headerShown: true, headerTransparent: hasGlass, headerBackButtonDisplayMode: 'minimal' } as const;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { ready, signedIn } = useStatus();
  const colors = useColors();
  const wallpaper = useWallpaperShown();
  // Screens keep clear of every inset themselves: on the iPhone Duo iOS moves the status bar, tab
  // bar and native header items into a rail on one side, which only reaches the edge when nothing
  // here pads the window.
  const collapsed = useSidebar(s => s.collapsed);
  // iPhone Duo, open wide with the rail: the inbox is a sidebar beside the stack, which shows the
  // New thread pane, the open task or another tab (split.tsx). It stays on every route: if the
  // stack changes width in the same update as a tab switch or sheet, iOS drops the tabs from the rail.
  const split = useSplit() && signedIn;
  const sidebar = split && !collapsed;
  useEffect(() => {
    void loadAppearance();
    void connect.init(); // or demo mode (src/demo.ts)
  }, []);
  useOutboxFlusher();
  usePushNotifications(signedIn);
  if (!ready) return null;
  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: colors.background }]}>
      <WallpaperLayer />
      <ThemeProvider value={THEMES[wallpaper ? (colorScheme === 'dark' ? 'clearDark' : 'clearLight') : (colorScheme === 'dark' ? 'dark' : 'light')]}>
        <View style={styles.split}>
          {sidebar && <Sidebar />}
          <View style={styles.pane}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Protected guard={signedIn} redirectTo={SIGN_IN}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="task/[device]/[session]" />
                <Stack.Screen name="new-task" options={{ ...sheet, sheetAllowedDetents: [0.75, 1], title: 'New task' }} />
                <Stack.Screen name="task-settings" options={{ ...sheet, sheetAllowedDetents: [0.5, 0.9], title: 'Model & permissions' }} />
                <Stack.Screen name="task-info" options={{ ...sheet, sheetAllowedDetents: [0.45, 0.8], title: 'Task info' }} />
                <Stack.Screen name="pull" options={{ ...pushed, title: 'Pull request' }} />
                <Stack.Screen name="changes" options={{ ...pushed, title: 'Changes' }} />
                <Stack.Screen name="diff" options={{ ...pushed, title: 'Diff' }} />
                <Stack.Screen name="agents" options={{ ...pushed, title: 'Agents' }} />
                <Stack.Screen name="agent" options={{ ...pushed, title: 'Agent' }} />
              </Stack.Protected>
              <Stack.Protected guard={!signedIn} redirectTo={HOME}>
                <Stack.Screen name="sign-in" />
              </Stack.Protected>
            </Stack>
          </View>
        </View>
        <MenuHost />
        <LiveActivityHost />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 }, split: { flex: 1, flexDirection: 'row' }, pane: { flex: 1 } });
