// GitHub device flow: show the code, copy it, open the verification page, wait for approval.
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SignInCode } from '../connect/auth.ts';
import { connect } from '../connect/client.ts';
import { configProblem } from '../connect/config.ts';
import { useStatus } from '../store/index.ts';
import { Banner, Button, Card, CardSection, crossFadeIn, CrossFadeText, geometry, haptic, PressScale, STAGGER_CAP, type as text, useMotion } from '../ui/ds/index.ts';
import { Icon } from '../ui/Icon.tsx';
import { mono, useColors } from '../ui/theme.ts';

const icon = require('../../assets/images/icon.png');

const MARK = 72;
const COPIED_MS = 2000;
const CODE_SIZE = 34;
const CODE_TRACKING = 3;
const CODE_FONT_SCALE = 1.3;
const CHECK_SIZE = 14;
const CHECK_DRAW_MS = 260;

export default function SignIn() {
  const colors = useColors();
  const status = useStatus();
  const { enter, layout } = useMotion();
  const [code, setCode] = useState<SignInCode | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  // Only the newest attempt may touch the screen: a cancelled one still rejects on its way out.
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; connect.signInCancel(); }, []);

  const start = async () => {
    attempt.current += 1;
    const mine = attempt.current;
    setError('');
    setStarting(true);
    try {
      const next = await connect.signInStart();
      if (mine !== attempt.current) return;
      setCode(next);
      setStarting(false);
      await connect.signInFinish(next);
      haptic('success');
    } catch (e) {
      if (mine !== attempt.current) return;
      setCode(null);
      setStarting(false);
      setError((e as Error).message);
    }
  };
  const cancel = () => {
    attempt.current += 1;
    connect.signInCancel();
    setCode(null);
  };
  const demo = () => connect.enterDemo().catch((e: Error) => setError(e.message));
  const problem = error || status.error || '';

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Animated.View layout={layout} style={styles.hero}>
          <Animated.View entering={enter(0)}>
            <Image source={icon} style={[styles.mark, { borderColor: colors.border }]} accessibilityIgnoresInvertColors />
          </Animated.View>
          <Animated.Text entering={enter(1)} accessibilityRole="header" style={[text.largeTitle, { color: colors.text }]}>PandaCode</Animated.Text>
          <Animated.Text entering={enter(2)} style={[text.body, styles.center, { color: colors.muted }]}>See and steer the tasks running on your computers.</Animated.Text>
        </Animated.View>
        {!status.configured ? (
          <Animated.View key="unconfigured" entering={enter(3)}>
            <NotConfigured onDemo={demo} />
          </Animated.View>
        ) : code ? (
          <Animated.View key="code" entering={enter(0)}>
            {/* Keyed: a new code starts uncopied. */}
            <CodeCard key={code.userCode} code={code} onCancel={cancel} />
          </Animated.View>
        ) : (
          <Animated.View key="start" entering={enter(3)} style={styles.actions}>
            <Banner visible={!!problem} tone="danger" title={problem} />
            <Button label="Sign in with GitHub" variant="primary" loading={starting} onPress={start} />
            <Button label="Explore the demo" variant="plain" disabled={starting} onPress={demo} />
            <Text style={[text.footnote, styles.center, { color: colors.muted }]}>No computer yet? The demo shows sample computers and tasks, with nothing sent anywhere.</Text>
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function NotConfigured({ onDemo }: { onDemo: () => void }) {
  const colors = useColors();
  return (
    <Card style={styles.notice}>
      <Text style={[text.bodyMedium, { color: colors.text }]}>PandaCode Connect is not configured in this build.</Text>
      <Text style={[text.footnote, { color: colors.muted }]}>{configProblem} Put PANDACODE_RELAY_URL and PANDACODE_GITHUB_CLIENT_ID in mobile/.env (or the shell), then restart Metro with npx expo start --clear.</Text>
      <Button label="Explore the demo" variant="plain" onPress={onDemo} />
    </Card>
  );
}

/** The checkmark wipes in from its short stroke, like a pen. */
function DrawnCheck({ color }: { color: string }) {
  const drawn = useSharedValue(0);
  useEffect(() => { drawn.set(withTiming(CHECK_SIZE, { duration: CHECK_DRAW_MS, easing: Easing.out(Easing.cubic) })); }, [drawn]);
  const wipe = useAnimatedStyle(() => ({ width: drawn.get() }));
  return (
    <View style={styles.check}>
      <Animated.View style={[styles.checkClip, wipe]}>
        <View style={styles.check}><Icon ios="checkmark" android="check" size={CHECK_SIZE} color={color} /></View>
      </Animated.View>
    </View>
  );
}

function CodeCard({ code, onCancel }: { code: SignInCode; onCancel: () => void }) {
  const colors = useColors();
  const { enter } = useMotion();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    await Clipboard.setStringAsync(code.userCode);
    haptic('selection');
    setCopied(true);
  };
  const open = () => {
    copy().catch(() => undefined); // The page opens either way, and the code stays on screen to type.
    void WebBrowser.openBrowserAsync(code.verificationUri);
  };
  const footer = (
    <View style={styles.codeActions}>
      <Button label="Open GitHub" variant="primary" icon={{ ios: 'arrow.up.right', android: 'north_east' }} onPress={open} />
      <View style={styles.waiting}>
        <ActivityIndicator size="small" />
        <Text style={[text.footnote, { color: colors.muted }]}>Waiting for GitHub…</Text>
      </View>
    </View>
  );
  return (
    <View style={styles.actions}>
      <CardSection title="Enter this code on GitHub" footer={footer}>
        <PressScale onPress={() => { copy().catch(() => undefined); }} accessibilityLabel={`Code ${code.userCode}. ${copied ? 'Copied' : 'Copy'}`} style={styles.code}>
          <View style={styles.digits}>
            {[...code.userCode].map((digit, i) => (
              <Animated.Text key={i} entering={enter(Math.min(i, STAGGER_CAP - 1))} maxFontSizeMultiplier={CODE_FONT_SCALE} style={[styles.codeText, { color: colors.text }]}>{digit}</Animated.Text>
            ))}
          </View>
          <View style={styles.copy}>
            {copied ? <DrawnCheck color={colors.success} /> : <Animated.View entering={crossFadeIn}><Icon ios="doc.on.doc" android="content_copy" size={CHECK_SIZE} color={colors.muted} /></Animated.View>}
            <CrossFadeText text={copied ? 'Copied' : 'Copy code'} style={[text.footnoteMedium, { color: colors.muted }]} />
          </View>
        </PressScale>
      </CardSection>
      <Button label="Cancel" variant="plain" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'space-between', padding: 24, gap: 32 },
  hero: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  mark: { width: MARK, height: MARK, borderRadius: 16, borderCurve: 'continuous', borderWidth: geometry.hairline, marginBottom: 6 },
  center: { textAlign: 'center' },
  actions: { gap: 10 },
  notice: { padding: 16, gap: 10 },
  code: { alignItems: 'center', gap: 8, paddingVertical: 18, paddingHorizontal: 12 },
  digits: { flexDirection: 'row' },
  check: { width: CHECK_SIZE, height: CHECK_SIZE, alignItems: 'center', justifyContent: 'center' },
  checkClip: { height: CHECK_SIZE, overflow: 'hidden', alignSelf: 'flex-start' },
  codeText: { fontFamily: mono, fontSize: CODE_SIZE, fontWeight: '600', letterSpacing: CODE_TRACKING },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  codeActions: { gap: 10 },
  waiting: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
});
