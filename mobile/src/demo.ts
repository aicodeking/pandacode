// Demo mode, for screenshots only: EXPO_PUBLIC_PANDACODE_DEMO=1 seeds fake computers and tasks
// (src/demo-data.ts) and skips sign-in and the network. Never on by default.
export const DEMO = process.env.EXPO_PUBLIC_PANDACODE_DEMO === '1';
