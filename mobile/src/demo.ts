// Demo mode: fake computers and tasks (src/demo-data.ts) answered by a fake host (src/demo-host.ts),
// with no network at all. Sign-in's "Explore the demo" turns it on (App Review has no desktop);
// it stays on across launches until Settings → Leave demo. EXPO_PUBLIC_PANDACODE_DEMO=1 starts
// every launch in it, for screenshots. client.ts owns the switch (`connect.enterDemo/leaveDemo`).
export const BUILD_DEMO = process.env.EXPO_PUBLIC_PANDACODE_DEMO === '1';
/** File in the app's documents holding '1' while demo mode is on. Not the Keychain: Keychain items
 *  outlive an uninstall, so a reinstalled app would open in the demo instead of on sign-in. */
export const DEMO_FILE = 'demo-on';

/** Whether a launch starts in demo mode: the build flag (until left this launch) or the saved switch. */
export const demoAtStart = (buildDemo: boolean, saved: string | null) => buildDemo || saved === '1';
