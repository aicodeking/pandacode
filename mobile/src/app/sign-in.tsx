// GitHub device flow: show the code, copy it, open the verification page, wait for approval.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { connect } from '../connect/client.ts';
import type { SignInCode } from '../connect/auth.ts';
import { useStatus } from '../store/index.ts';
import { Glass } from '../ui/Glass.tsx';
import { Button } from '../ui/requests.tsx';
import { mono, useColors } from '../ui/theme.ts';
import { configProblem } from '../connect/config.ts';

const icon = require('../../assets/images/icon.png');

export default function SignIn() {
  const colors = useColors();
  const status = useStatus();
  const [code, setCode] = useState<SignInCode | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; connect.signInCancel(); }, []);

  const start = async () => {
    setError('');
    setStarting(true);
    try {
      const next = await connect.signInStart();
      setCode(next);
      setStarting(false);
      await connect.signInFinish(next);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (!alive.current) return;
      setCode(null);
      setStarting(false);
      setError((e as Error).message);
    }
  };
  const cancel = () => { connect.signInCancel(); setCode(null); };
  const demo = () => connect.enterDemo().catch(e => setError((e as Error).message));
  const explore = <Button label="Explore the demo" onPress={demo} />;
  const copy = async () => {
    if (!code) return;
    await Clipboard.setStringAsync(code.userCode);
    void Haptics.selectionAsync();
    setCopied(true);
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.top}>
        <Image source={icon} style={styles.icon} accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { color: colors.text }]}>PandaCode</Text>
        <Text style={[styles.lead, { color: colors.secondary }]}>See and steer the tasks running on your computers. Tasks never run on this phone.</Text>
      </View>
      {!status.configured ? (
        <Glass style={styles.card}>
          <Text style={[styles.body, { color: colors.text }]}>PandaCode Connect is not configured in this build.</Text>
          <Text style={[styles.small, { color: colors.secondary }]}>{configProblem} Put PANDACODE_RELAY_URL and PANDACODE_GITHUB_CLIENT_ID in mobile/.env (or the shell), then restart Metro with npx expo start --clear.</Text>
          {explore}
        </Glass>
      ) : code ? (
        <Glass style={styles.card}>
          <Text style={[styles.small, { color: colors.secondary }]}>Enter this code on GitHub</Text>
          <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel={`Code ${code.userCode}. Copy`}>
            <Text selectable style={[styles.code, { color: colors.text }]}>{code.userCode}</Text>
          </Pressable>
          <View style={styles.actions}>
            <Button label={copied ? 'Copied' : 'Copy code'} onPress={copy} />
            <Button label="Open GitHub" kind="primary" onPress={() => { void copy(); void WebBrowser.openBrowserAsync(code.verificationUri); }} />
          </View>
          <View style={styles.waiting}>
            <ActivityIndicator />
            <Text style={[styles.small, { color: colors.secondary }]}>Waiting for GitHub…</Text>
          </View>
          <Button label="Cancel" onPress={cancel} />
        </Glass>
      ) : (
        <View style={styles.bottom}>
          {!!(error || status.error) && <Text style={[styles.small, { color: colors.red, textAlign: 'center' }]}>{error || status.error}</Text>}
          {starting ? <ActivityIndicator /> : <Button label="Sign in with GitHub" kind="primary" onPress={start} />}
          {!starting && explore}
          <Text style={[styles.small, styles.hint, { color: colors.secondary }]}>No computer yet? The demo shows sample computers and tasks, with nothing sent anywhere.</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'space-between' },
  top: { alignItems: 'center', gap: 10, marginTop: 48 },
  icon: { width: 96, height: 96, borderRadius: 22 },
  title: { fontSize: 34, fontWeight: '700' },
  lead: { fontSize: 17, textAlign: 'center', lineHeight: 23 },
  card: { borderRadius: 28, padding: 20, gap: 14, alignItems: 'center' },
  body: { fontSize: 17, textAlign: 'center' },
  small: { fontSize: 14, lineHeight: 19 },
  code: { fontFamily: mono, fontSize: 34, fontWeight: '600', letterSpacing: 4 },
  actions: { flexDirection: 'row', gap: 10 },
  waiting: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  bottom: { gap: 14, marginBottom: 12 },
  hint: { textAlign: 'center' },
});
