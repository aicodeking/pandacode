import { Stack } from 'expo-router';
import { hasGlass } from '../../../ui/Glass.tsx';
import { useT } from '../../../ui/language.ts';

export default function Layout() {
  const t = useT();
  return (
    <Stack screenOptions={{ headerLargeTitle: true, headerTransparent: hasGlass, headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title: t('Settings') }} />
    </Stack>
  );
}
