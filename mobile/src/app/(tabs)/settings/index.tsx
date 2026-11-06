import Constants from 'expo-constants';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { enableNotifications, notificationsGranted } from '../../../ui/push.ts';
import { useStatus } from '../../../store/index.ts';
import { clearLocal } from '../../../store/local.ts';
import { APPEARANCES, setAppearance, useAppearance } from '../../../ui/appearance.ts';
import { useBackdrop } from '../../../ui/Backdrop.tsx';
import { setLanguage, useLanguage, useT } from '../../../ui/language.ts';
import { LANGUAGES } from '../../../i18n/core.ts';
import { WallpaperSettings } from '../../../ui/WallpaperSettings.tsx';

const SOURCE = 'https://github.com/aicodeking/pandacode';
const SUPPORT = `${SOURCE}/issues`;
// The website (website/, Worker pandacode-site) has no domain in the repo; confirm this one before release.
const SITE = 'https://pandacode.bambooed.ai';
const PRIVACY = `${SITE}/privacy`;

export default function Settings() {
  const colors = useBackdrop();
  const t = useT();
  const status = useStatus();
  const insets = useSafeAreaInsets();
  const appearance = useAppearance(s => s.choice);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  useEffect(() => { void notificationsGranted().then(setPushOn).catch(() => undefined); }, []);
  const enable = () => { void (async () => {
    try {
      const ok = await enableNotifications();
      setPushOn(ok);
      if (!ok) Alert.alert('Notifications are off', 'Allow them in iOS Settings to hear when a task needs you.');
    } catch { setPushOn(false); }
  })(); };
  const language = useLanguage(s => s.choice);
  const [deleting, setDeleting] = useState(false);
  const signOut = () => Alert.alert(t('Sign out?'), t('This phone stops seeing your computers until you sign in again.'), [
    { text: t('Cancel'), style: 'cancel' },
    { text: t('Sign out'), style: 'destructive', onPress: () => void connect.signOut() },
  ]);
  const remove = async () => {
    setDeleting(true);
    try {
      await connect.deleteAccount();
      await clearLocal();
    } catch (error) {
      setDeleting(false);
      Alert.alert(t('Could not delete the account'), (error as Error).message);
    }
  };
  const deleteAccount = () => Alert.alert(
    t('Delete your account?'),
    t('This removes your account and every device signed in to it, phones and computers, from the PandaCode Connect relay, and erases this phone\'s keys and saved data. Your computers then need to sign in to PandaCode Connect again. Tasks on your computers and your GitHub account are not affected.'),
    [{ text: t('Cancel'), style: 'cancel' }, { text: t('Delete account'), style: 'destructive', onPress: () => void remove() }],
  );
  const link = (label: string, url: string) => (
    <Pressable onPress={() => void WebBrowser.openBrowserAsync(url)} accessibilityRole="link"><Text style={[styles.value, { color: colors.tint }]}>{label}</Text></Pressable>
  );
  return (
    <ScrollView style={{ backgroundColor: colors.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.page, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right }]}>
      {status.demo ? (
        <Section title={t('Account')} footer={t('Sample computers and tasks on this phone only. Nothing is sent anywhere.')}>
          <View style={styles.row}>
            <Text style={[styles.badge, { backgroundColor: colors.tint, color: colors.onTint }]}>{t('Demo')}</Text>
            <Text style={[styles.value, { flex: 1, color: colors.text }]}>{t('Exploring the demo')}</Text>
          </View>
          <Pressable onPress={() => void connect.leaveDemo()} accessibilityRole="button"><Text style={[styles.value, { color: colors.tint }]}>{t('Leave demo')}</Text></Pressable>
        </Section>
      ) : (
      <Section title={t('Account')}>
        <View style={styles.row}>
          {!!status.account?.avatarUrl && <Image source={status.account.avatarUrl} style={styles.avatar} />}
          <View style={{ flex: 1 }}>
            <Text style={[styles.value, { color: colors.text }]}>{status.account?.login ?? '—'}</Text>
            <Text style={[styles.small, { color: status.error ? colors.red : colors.secondary }]}>{status.error ?? (status.connected ? t('Connected') : t('Connecting…'))}</Text>
          </View>
        </View>
        {deleting ? <ActivityIndicator /> : (
          <Pressable onPress={deleteAccount} accessibilityRole="button"><Text style={[styles.value, { color: colors.red }]}>{t('Delete account…')}</Text></Pressable>
        )}
      </Section>
      )}
      <Section title={t('Notifications')} footer={t('Wake this phone when a task needs approval or finishes. The relay learns that something happened, never what.')}>
        <Pressable onPress={enable} accessibilityRole="button">
          <View style={styles.row}>
            <Text style={[styles.value, { color: colors.text, flex: 1 }]}>{pushOn ? t('Enabled') : t('Enable notifications')}</Text>
            {!pushOn && <Text style={[styles.badge, { color: colors.tint }]}>{t('Enable')}</Text>}
          </View>
        </Pressable>
      </Section>
      <Section title={t('Appearance')} footer={t("Applies to this app only. System follows the phone's light or dark setting.")}>
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
      <Section title={t('Language')} footer={t('Follows the system language until you pick one here.')}>
        <View accessibilityRole="radiogroup">
          <Pressable onPress={() => setLanguage('system')} accessibilityRole="radio" accessibilityState={{ selected: language === 'system' }}
            style={styles.languageRow}>
            <Text style={[styles.value, { color: colors.text }]}>{t('System default')}</Text>
            {language === 'system' && <Text style={{ color: colors.tint }}>✓</Text>}
          </Pressable>
          {LANGUAGES.map(l => (
            <Pressable key={l.id} onPress={() => setLanguage(l.id)} accessibilityRole="radio" accessibilityState={{ selected: language === l.id }}
              style={styles.languageRow}>
              <Text style={[styles.value, { color: colors.text }]}>{l.native}</Text>
              {language === l.id && <Text style={{ color: colors.tint }}>✓</Text>}
            </Pressable>
          ))}
        </View>
      </Section>
      <Section title={t('Wallpaper')} footer={t("The desktop's daily scenes, in step with your computer: each day has a morning, afternoon and night scene. Tap a scene to keep it.")}>
        <WallpaperSettings />
      </Section>
      {!status.demo && <Section>
        <Pressable onPress={signOut} accessibilityRole="button"><Text style={[styles.value, { color: colors.red }]}>{t('Sign out')}</Text></Pressable>
      </Section>}
      <Section title={t('About')} footer={t('PandaCode is open source. This app has no telemetry; it talks only to the PandaCode Connect relay and GitHub sign-in.')}>
        <Text style={[styles.value, { color: colors.text }]}>PandaCode {Constants.expoConfig?.version ?? ''}</Text>
        {link(t('Privacy Policy'), PRIVACY)}
        {link(t('Support'), SUPPORT)}
        {link(t('Source code'), SOURCE)}
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
  badge: { fontSize: 13, fontWeight: '600', borderRadius: 8, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 2 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  value: { fontSize: 17 },
  small: { fontSize: 13, lineHeight: 18 },
  footer: { marginHorizontal: 14 },
  chips: { flexDirection: 'row', gap: 8 },
  languageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  chip: { flex: 1, alignItems: 'center', borderRadius: 16, paddingVertical: 8 },
  chipText: { fontSize: 15, fontWeight: '500' },
});
