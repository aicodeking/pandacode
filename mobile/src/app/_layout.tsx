import '../connect/polyfill.ts';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { connect } from '../connect/client.ts';
import { DEMO } from '../demo.ts';
import { useStatus } from '../store/index.ts';
import { useOutboxFlusher } from '../store/local.ts';
import { loadAppearance } from '../ui/appearance.ts';
import { useWallpaperShown, WallpaperLayer } from '../ui/Backdrop.tsx';
import { MenuHost } from '../ui/Menu.tsx';
import { Sidebar } from '../ui/Sidebar.tsx';
import { useSidebar, useSplit } from '../ui/split.tsx';
import { useColors } from '../ui/theme.ts';

// A task opened from a deep link still has the tabs under it to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

// While the wallpaper shows, screens draw no background of their own so it reaches every pane.
const clear = (theme: typeof DefaultTheme) => ({ ...theme, colors: { ...theme.colors, background: 'transparent' } });
const THEMES = { light: DefaultTheme, dark: DarkTheme, clearLight: clear(DefaultTheme), clearDark: clear(DarkTheme) };

const sheet = { presentation: 'formSheet', sheetGrabberVisible: true, headerShown: true } as const;

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
    if (DEMO) void import('../demo-data.ts').then(m => m.seedDemo());
    else void connect.init();
  }, []);
  useOutboxFlusher();
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
              <Stack.Protected guard={signedIn}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="task/[device]/[session]" />
                <Stack.Screen name="new-task" options={{ ...sheet, sheetAllowedDetents: [0.75, 1], title: 'New task' }} />
                <Stack.Screen name="task-settings" options={{ ...sheet, sheetAllowedDetents: [0.5, 0.9], title: 'Model & permissions' }} />
                <Stack.Screen name="task-info" options={{ ...sheet, sheetAllowedDetents: [0.45, 0.8], title: 'Task info' }} />
              </Stack.Protected>
              <Stack.Protected guard={!signedIn}>
                <Stack.Screen name="sign-in" />
              </Stack.Protected>
            </Stack>
          </View>
        </View>
        <MenuHost />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 }, split: { flex: 1, flexDirection: 'row' }, pane: { flex: 1 } });
