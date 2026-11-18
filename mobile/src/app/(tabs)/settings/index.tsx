import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '../../../connect/client.ts';
import { useStatus } from '../../../store/index.ts';
import { clearLocal } from '../../../store/local.ts';
import { APPEARANCES, setAppearance, useAppearance, type AppearanceChoice } from '../../../ui/appearance.ts';
import { useColors } from '../../../ui/theme.ts';
import { Button, Chip, Group, geometry, Row, Segmented, useScrollEdge, useStagger, type IconName } from '../../../ui/ds/index.ts';
import { Glyph, Note } from '../../../ui/FormParts.tsx';
import { Icon } from '../../../ui/Icon.tsx';
import { enableNotifications, readNotifications } from '../../../ui/push.ts';
import { notificationRow, type PushStatus } from '../../../ui/push-state.ts';

const SOURCE = 'https://github.com/aicodeking/pandacode';
const SUPPORT = `${SOURCE}/issues`;
// The website (website/, Worker pandacode-site) has no domain in the repo; confirm this one before release.
const SITE = 'https://pandacode.bambooed.ai';
const PRIVACY = `${SITE}/privacy`;

const BOTTOM_PADDING = 32;
const AVATAR = 32;
const BELL: IconName = { ios: 'bell', android: 'notifications' };
const APPEARANCE_ICONS: Record<AppearanceChoice, IconName> = {
  system: { ios: 'circle.lefthalf.filled', android: 'contrast' },
  light: { ios: 'sun.max', android: 'light_mode' },
  dark: { ios: 'moon', android: 'dark_mode' },
};
const APPEARANCE_OPTIONS = APPEARANCES.map(a => ({ value: a.id, label: a.label, icon: APPEARANCE_ICONS[a.id] }));
const LINKS: { title: string; url: string; icon: IconName }[] = [
  { title: 'Privacy Policy', url: PRIVACY, icon: { ios: 'hand.raised', android: 'privacy_tip' } },
  { title: 'Support', url: SUPPORT, icon: { ios: 'questionmark.circle', android: 'help' } },
  { title: 'Source code', url: SOURCE, icon: { ios: 'chevron.left.forwardslash.chevron.right', android: 'code' } },
];

export default function Settings() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // Tabs mount before they show, so the entrance waits for the first look.
  const [seen, setSeen] = useState(false);
  useFocusEffect(useCallback(() => setSeen(true), []));
  const enter = useStagger(seen);
  const edge = useScrollEdge();
  const sections: ReactNode[] = [
    <AccountSection key="account" />, <NotificationsSection key="notifications" />, <AppearanceSection key="appearance" />,
    <AboutSection key="about" />, <LeaveSection key="leave" />,
  ];
  return (
    <Animated.ScrollView {...edge} style={{ backgroundColor: colors.grouped }} contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.page, { paddingLeft: geometry.screenMargin + insets.left, paddingRight: geometry.screenMargin + insets.right }]}>
      {seen && sections.map((section, i) => <Animated.View key={i} entering={enter(i)}>{section}</Animated.View>)}
    </Animated.ScrollView>
  );
}

function AccountSection() {
  const colors = useColors();
  const status = useStatus();
  if (status.demo) {
    return (
      <Group footer={<Note>Sample computers and tasks on this phone only. Nothing is sent anywhere.</Note>}>
        <Row leading={<Glyph icon={{ ios: 'play.circle', android: 'play_circle' }} />} title="Exploring the demo"
          trailing={<Chip label="Demo" tone="team" icon={{ ios: 'sparkles', android: 'auto_awesome' }} />} />
      </Group>
    );
  }
  const avatar = status.account?.avatarUrl;
  return (
    <Group>
      <Row leading={avatar ? <Image source={avatar} style={[styles.avatar, { backgroundColor: colors.fill }]} /> : <Glyph icon={{ ios: 'person.crop.circle', android: 'account_circle' }} />}
        title={status.account?.login ?? '—'} subtitle={status.error ?? (status.connected ? 'Connected' : 'Connecting…')} tone={status.error ? 'danger' : undefined} />
    </Group>
  );
}

function usePushStatus() {
  const [push, setPush] = useState<PushStatus | null>(null);
  useEffect(() => {
    const read = () => { readNotifications().then(setPush).catch(() => undefined); };
    read();
    // The answer can change in the system's settings while the app is away.
    const sub = AppState.addEventListener('change', state => { if (state === 'active') read(); });
    return () => sub.remove();
  }, []);
  const enable = () => {
    enableNotifications().then(setPush).catch((error: Error) => Alert.alert('Could not turn on notifications', error.message));
  };
  return { push, enable };
}

function NotificationsSection() {
  const { push, enable } = usePushStatus();
  const kind = notificationRow(push);
  const openSettings = () => { Linking.openSettings().catch((error: Error) => Alert.alert('Could not open Settings', error.message)); };
  return (
    <Group footer={<Note>Wake this phone when a task needs approval or finishes. The relay learns that something happened, never what.</Note>}>
      {kind === 'on' && <Row leading={<Glyph icon={{ ios: 'bell.badge', android: 'notifications_active' }} />} title="Notifications" trailing="On" />}
      {kind === 'loading' && <Row leading={<Glyph icon={BELL} />} title="Notifications" />}
      {kind === 'ask' && <Row leading={<Glyph icon={BELL} />} title="Notifications" trailing={<Button label="Enable" size="small" onPress={enable} />} />}
      {kind === 'denied' && (
        <Row leading={<Glyph icon={{ ios: 'bell.slash', android: 'notifications_off' }} />} title="Notifications" subtitle="Off in system settings"
          trailing={<Button label="Open Settings" size="small" onPress={openSettings} />} />
      )}
      {kind === 'failed' && (
        <Row leading={<Glyph icon={BELL} />} title="Notifications" subtitle="Couldn't register this phone" tone="danger"
          trailing={<Button label="Retry" size="small" onPress={enable} />} />
      )}
      {kind === 'unsupported' && <Row leading={<Glyph icon={{ ios: 'bell.slash', android: 'notifications_off' }} />} title="Notifications" subtitle="Your relay doesn't send them yet" />}
    </Group>
  );
}

function AppearanceSection() {
  const appearance = useAppearance(s => s.choice);
  return (
    <Group title="Appearance" footer={<Note>Applies to this app only. System follows the phone&apos;s light or dark setting.</Note>}>
      <Segmented accessibilityLabel="Appearance" options={APPEARANCE_OPTIONS} value={appearance} onChange={setAppearance} style={styles.segmented} />
    </Group>
  );
}

function AboutSection() {
  const colors = useColors();
  return (
    <Group title="About" stagger footer={<Note>PandaCode is open source. This app has no telemetry; it talks only to the PandaCode Connect relay and GitHub sign-in.</Note>}>
      <Row leading={<Glyph icon={{ ios: 'info.circle', android: 'info' }} />} title="Version" trailing={Constants.expoConfig?.version ?? '—'} />
      {LINKS.map(link => (
        <Row key={link.title} leading={<Glyph icon={link.icon} />} title={link.title} accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(link.url)}
          trailing={<Icon ios="arrow.up.right" android="north_east" size={13} color={colors.glyphFaint} />} />
      ))}
    </Group>
  );
}

/** Whatever ends this session sits last: Leave demo, or Sign out and Delete account. */
function LeaveSection() {
  const colors = useColors();
  const status = useStatus();
  const [deleting, setDeleting] = useState(false);
  const signOut = () => Alert.alert('Sign out?', 'This phone stops seeing your computers until you sign in again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: () => void connect.signOut() },
  ]);
  const remove = async () => {
    setDeleting(true);
    try {
      await connect.deleteAccount();
      await clearLocal();
    } catch (error) {
      setDeleting(false);
      Alert.alert('Could not delete the account', (error as Error).message);
    }
  };
  const deleteAccount = () => Alert.alert(
    'Delete your account?',
    'This removes your account and every device signed in to it, phones and computers, from the PandaCode Connect relay, and erases this phone\'s keys and saved data. Your computers then need to sign in to PandaCode Connect again. Tasks on your computers and your GitHub account are not affected.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete account', style: 'destructive', onPress: () => void remove() }],
  );
  if (status.demo) {
    return (
      <Group>
        <Row leading={<Glyph icon={{ ios: 'arrow.uturn.backward', android: 'undo' }} />} title="Leave demo" onPress={() => void connect.leaveDemo()} />
      </Group>
    );
  }
  return (
    <Group stagger>
      <Row leading={<Glyph icon={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout' }} tone={colors.danger} />} title="Sign out" tone="danger" onPress={signOut} />
      <Row leading={<Glyph icon={{ ios: 'trash', android: 'delete' }} tone={colors.danger} />} title="Delete account…" tone="danger" onPress={deleteAccount} disabled={deleting}
        trailing={deleting ? <ActivityIndicator accessibilityLabel="Deleting the account" /> : undefined} />
    </Group>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 4, paddingBottom: BOTTOM_PADDING, gap: geometry.sectionGap },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  segmented: { marginHorizontal: 8, marginVertical: 4 },
});
