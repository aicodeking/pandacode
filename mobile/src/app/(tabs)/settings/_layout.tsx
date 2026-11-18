import { Stack } from 'expo-router';
import { NO_SYSTEM_EDGES, TabEdges } from '../../../ui/ds/index.ts';
import { TabBarProbe } from '../../../ui/ds/Toast.tsx';

export default function Layout() {
  // The probe measures the real tab bar so toasts clear it (none on the Duo's rail).
  return (
    <>
      <Stack screenLayout={TabEdges} screenOptions={{ headerShown: false, scrollEdgeEffects: NO_SYSTEM_EDGES }}>
        <Stack.Screen name="index" options={{ title: 'Settings' }} />
      </Stack>
      <TabBarProbe />
    </>
  );
}
