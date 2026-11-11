// "Resume at reset" for a task that hit a usage limit (usage.resumeAtReset), with "Continue now"
// (usage.clearLimit): on the task screen's limit banner (RunNotice in [session].tsx) and the Usage screen.
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { clearUsageLimit, setResumeAtReset, usageOverview } from '../connect/api/composer.ts';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote } from './AccessNote.tsx';
import { Button, geometry, haptic, Row, Toggle } from './ds/index.ts';

/** "Resume at reset" for a task that hit a usage limit, with "Continue now". Mount where the limit banner shows. */
export function UsageResumeToggle({ deviceId, sessionId, resetsAt }: { deviceId: string; sessionId: string; resetsAt?: number | null }) {
  const supported = useHostSupports(deviceId, 'usage.resumeAtReset');
  const canResume = useHostAllows(deviceId, 'usage.resumeAtReset');
  const canContinue = useHostAllows(deviceId, 'usage.clearLimit');
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    usageOverview(deviceId, sessionId).then(reply => { if (live) setOn(!!reply.task?.resumeAtReset); }, () => { if (live) setOn(false); });
    return () => { live = false; };
  }, [deviceId, sessionId, supported]);
  if (!supported) return null;
  const at = resetsAt ? new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const change = async (next: boolean) => {
    setBusy(true);
    setOn(next);
    try {
      const reply = await setResumeAtReset(deviceId, sessionId, next);
      setOn(reply.resumeAtReset);
      haptic('selection');
    } catch (error) {
      setOn(!next);
      Alert.alert('Couldn’t change this', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const continueNow = async () => {
    setBusy(true);
    try {
      await clearUsageLimit(deviceId, sessionId);
      haptic('light');
    } catch (error) {
      Alert.alert('Couldn’t continue', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <AccessNote device={deviceId} methods={METHODS} style={styles.note} />
      <Row title="Resume at reset" subtitle={at ? `Continues at ${at} when the limit resets` : 'Continues when the limit resets'}
        trailing={<Toggle value={!!on} onValueChange={next => void change(next)} disabled={busy || on === null || !canResume} accessibilityLabel="Resume at reset" />} />
      <View style={styles.continue}><Button label="Continue now" variant="plain" size="small" disabled={busy || !canContinue} onPress={() => void continueNow()} /></View>
    </View>
  );
}

const METHODS = ['usage.resumeAtReset', 'usage.clearLimit'] as const;

const styles = StyleSheet.create({
  note: { marginBottom: geometry.cardPadding },
  continue: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: geometry.cardPadding, paddingBottom: 4 },
});
