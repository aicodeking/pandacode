import { Stack } from 'expo-router';
import { hasGlass } from '../../../ui/Glass.tsx';

export default function Layout() {
  return (
    <Stack screenOptions={{ headerLargeTitle: true, headerTransparent: hasGlass, headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title: 'Computers' }} />
    </Stack>
  );
}
