import Constants from 'expo-constants';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { useStatus } from '../../../store/index.ts';
import { APPEARANCES, setAppearance, useAppearance } from '../../../ui/appearance.ts';
import { useBackdrop } from '../../../ui/Backdrop.tsx';
import { WallpaperSettings } from '../../../ui/WallpaperSettings.tsx';

const SOURCE = 'https://github.com/aicodeking/pandacode';

export default function Settings() {
  const colors = useBackdrop();
  const status = useStatus();
  const insets = useSafeAreaInsets();
  const appearance = useAppearance(s => s.choice);
  const signOut = () => Alert.alert('Sign out?', 'This phone stops seeing your computers until you sign in again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: () => void connect.signOut() },
  ]);
  return (
    <ScrollView style={{ backgroundColor: colors.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.page, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right }]}>
      <Section title="Account">
        <View style={styles.row}>
          {!!status.account?.avatarUrl && <Image source={status.account.avatarUrl} style={styles.avatar} />}
          <View style={{ flex: 1 }}>
            <Text style={[styles.value, { color: colors.text }]}>{status.account?.login ?? '—'}</Text>
            <Text style={[styles.small, { color: status.error ? colors.red : colors.secondary }]}>{status.error ?? (status.connected ? 'Connected' : 'Connecting…')}</Text>
          </View>
        </View>
      </Section>
      <Section title="Appearance" footer="Applies to this app only. System follows the phone's light or dark setting.">
        <View style={styles.chips} accessibilityRole="radiogroup">
          {APPEARANCES.map(a => {
            const selected = appearance === a.id;
            return (
              <Pressable key={a.id} onPress={() => setAppearance(a.id)} accessibilityRole="radio" accessibilityState={{ selected }}
                style={[styles.chip, { backgroundColor: selected ? colors.tint : colors.fill }]}>
                <Text style={[styles.chipText, { color: selected ? colors.onTint : colors.text }]}>{a.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>
      <Section title="Wallpaper" footer="The desktop's daily scenes, in step with your computer: each day has a morning, afternoon and night scene. Tap a scene to keep it.">
        <WallpaperSettings />
      </Section>
      <Section>
        <Pressable onPress={signOut} accessibilityRole="button"><Text style={[styles.value, { color: colors.red }]}>Sign out</Text></Pressable>
      </Section>
      <Section title="About" footer="PandaCode is open source. This app has no telemetry; it talks only to the PandaCode Connect relay and GitHub sign-in.">
        <Text style={[styles.value, { color: colors.text }]}>PandaCode {Constants.expoConfig?.version ?? ''}</Text>
        <Pressable onPress={() => void WebBrowser.openBrowserAsync(SOURCE)} accessibilityRole="link"><Text style={[styles.value, { color: colors.tint }]}>Source code</Text></Pressable>
      </Section>
    </ScrollView>
  );
}

function Section({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const colors = useBackdrop();
  return (
    <View style={styles.section}>
      {!!title && <Text style={[styles.header, { color: colors.secondary }]}>{title}</Text>}
      <View style={[styles.card, { backgroundColor: colors.card }]}>{children}</View>
      {!!footer && <Text style={[styles.small, styles.footer, { color: colors.secondary }]}>{footer}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 24 },
  section: { gap: 6 },
  header: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginLeft: 14 },
  card: { borderRadius: 16, padding: 14, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  value: { fontSize: 17 },
  small: { fontSize: 13, lineHeight: 18 },
  footer: { marginHorizontal: 14 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, alignItems: 'center', borderRadius: 16, paddingVertical: 8 },
  chipText: { fontSize: 15, fontWeight: '500' },
});
