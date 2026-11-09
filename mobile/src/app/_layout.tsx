import '../connect/polyfill.ts';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect, useMemo, type ReactElement, type ReactNode } from 'react';
import { LogBox, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { connect } from '../connect/client.ts';
import { LiveActivityHost } from '../live/LiveActivityHost.tsx';
import { HOME, SIGN_IN } from '../routes.ts';
import { useStatus } from '../store/index.ts';
import { useOutboxFlusher } from '../store/local.ts';
import { usePushNotifications } from '../ui/push.ts';
import { loadAppearance } from '../ui/appearance.ts';
import { hasGlass } from '../ui/Glass.tsx';
import { MenuHost } from '../ui/Menu.tsx';
import { Sidebar } from '../ui/Sidebar.tsx';
import { useSidebar, useSplit } from '../ui/split.tsx';
import { ScrollEdge } from '../ui/ds/index.ts';
import { ThemeFade } from '../ui/ThemeFade.tsx';
import { useColors, type Colors } from '../ui/theme.ts';
import { SplashIntro } from '../ui/splash/SplashIntro.tsx';
import { BUILD_DEMO } from '../demo.ts';

// Screenshot builds: dev warning toasts would cover the tab bar.
if (BUILD_DEMO) LogBox.ignoreAllLogs();

// A task opened from a deep link still has the tabs under it to go back to.
// Every guard names its redirect: the default is this anchor, `/(tabs)`, which is `/` and has no
// index in the group, so a guard flip (sign-in, entering or leaving the demo) hit Unmatched Route.
export const unstable_settings = { anchor: '(tabs)' };

// Native bars and screens take the page tone, with monochrome bar items.
function navigationTheme(base: typeof DefaultTheme, colors: Colors) {
  return { ...base, colors: { ...base.colors, background: colors.page, card: colors.page, text: colors.text, border: colors.border, primary: colors.text } };
}

/** The routes that push over a task with a transparent bar: they get the app's scroll edge, under the bar. */
const PUSHED_ROUTES = new Set(['pull', 'changes', 'diff', 'agents', 'agent']);
function RootScreenLayout({ route, children }: { route: { name: string }; children: ReactNode }): ReactElement {
  return <>{children}{PUSHED_ROUTES.has(route.name) && <ScrollEdge />}</>;
}

/** Pull request, Changes and a diff push over the task with a native header (Liquid Glass where available). */
const pushed = { headerShown: true, headerTransparent: hasGlass, headerBackButtonDisplayMode: 'minimal' } as const;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { ready, signedIn } = useStatus();
  const colors = useColors();
  // Screens keep clear of every inset themselves: on the iPhone Duo iOS moves the status bar, tab
  // bar and native header items into a rail on one side, which only reaches the edge when nothing
  // here pads the window.
  const collapsed = useSidebar(s => s.collapsed);
  // iPhone Duo, open wide with the rail: the inbox is a sidebar beside the stack, which shows the
  // New thread pane, the open task or another tab (split.tsx). It stays on every route: if the
  // stack changes width in the same update as a tab switch or sheet, iOS drops the tabs from the rail.
  const split = useSplit() && signedIn;
  const sidebar = split && !collapsed;
  const theme = useMemo(() => navigationTheme(colorScheme === 'dark' ? DarkTheme : DefaultTheme, colors), [colorScheme, colors]);
  const sheet = { presentation: 'formSheet', sheetGrabberVisible: true, headerShown: true, headerShadowVisible: false, headerStyle: { backgroundColor: colors.page }, contentStyle: { backgroundColor: colors.page } } as const;
  useEffect(() => {
    void loadAppearance();
    void connect.init(); // or demo mode (src/demo.ts)
  }, []);
  useOutboxFlusher();
  usePushNotifications(signedIn);
  // The intro covers the launch while the app initialises underneath.
  const intro = <SplashIntro ready={ready} signedIn={signedIn} />;
  // One shape whether or not the app is ready, so the intro stays mounted when it becomes ready.
  return (
    <>
    {ready && <GestureHandlerRootView style={[styles.root, { backgroundColor: colors.background }]}>
      <KeyboardProvider>
      <ThemeProvider value={theme}>
        <View style={styles.split}>
          {sidebar && <Sidebar />}
          <View style={styles.pane}>
            <Stack screenLayout={RootScreenLayout} screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Protected guard={signedIn} redirectTo={SIGN_IN}>
                {/* The title is what a back button over the tabs reads out; the tabs draw their own headers. */}
                <Stack.Screen name="(tabs)" options={{ title: 'Inbox', animation: 'fade' }} />
                <Stack.Screen name="task/[device]/[session]" />
                <Stack.Screen name="new-task" options={{ ...sheet, sheetAllowedDetents: [0.75, 1], title: 'New task' }} />
                <Stack.Screen name="task-settings" options={{ ...sheet, sheetAllowedDetents: 'fitToContents', title: 'Model & permissions' }} />
                <Stack.Screen name="task-info" options={{ ...sheet, sheetAllowedDetents: 'fitToContents', title: 'Task info' }} />
                <Stack.Screen name="pull" options={{ ...pushed, title: 'Pull request' }} />
                <Stack.Screen name="changes" options={{ ...pushed, title: 'Changes' }} />
                <Stack.Screen name="diff" options={{ ...pushed, title: 'Diff' }} />
                <Stack.Screen name="agents" options={{ ...pushed, title: 'Agents' }} />
                <Stack.Screen name="agent" options={{ ...pushed, title: 'Agent' }} />
              </Stack.Protected>
              <Stack.Protected guard={!signedIn} redirectTo={HOME}>
                <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
              </Stack.Protected>
            </Stack>
          </View>
        </View>
        <MenuHost />
        <LiveActivityHost />
      </ThemeProvider>
      </KeyboardProvider>
      <ThemeFade />
    </GestureHandlerRootView>}
    {intro}
    </>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 }, split: { flex: 1, flexDirection: 'row' }, pane: { flex: 1 } });
