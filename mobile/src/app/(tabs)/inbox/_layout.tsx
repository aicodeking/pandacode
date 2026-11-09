import { Stack } from 'expo-router';
import { NO_SYSTEM_EDGES, TabEdges } from '../../../ui/ds/index.ts';
import { hasGlass } from '../../../ui/Glass.tsx';

export default function Layout() {
  return (
    <Stack screenLayout={TabEdges} screenOptions={{ headerTransparent: hasGlass, headerShadowVisible: false, scrollEdgeEffects: NO_SYSTEM_EDGES }}>
      <Stack.Screen name="index" options={{ title: 'Inbox' }} />
    </Stack>
  );
}
