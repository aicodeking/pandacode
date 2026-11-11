// A task's fast check (?device=&session=; without a task, pick one): what the checkout declares
// (npm test, else cargo check), Run, and the result with the failing output's tail. The same
// check the desktop offers after a clean turn; it runs in the task's own checkout, bounded to 2 min.
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { checksPlan, runChecks, type CheckReport } from '../connect/api/tools.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import { Banner, Button, EmptyState, geometry, haptic, Row, type } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, styles as hub, TaskPicker, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { mono, useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const CHECK_ICON = glyph({ ios: 'checkmark.shield', android: 'verified' });

/** The check's output, monospace and selectable, in a box that scrolls both ways and opens at
 * its end, where a failure is; Copy puts all of it on the clipboard. */
function Output({ text }: { text: string }) {
  const colors = useColors();
  const vertical = useRef<ComponentRef<typeof ScrollView>>(null);
  const [copied, setCopied] = useState('');
  const copy = () => Clipboard.setStringAsync(text).then(
    () => { haptic('success'); AccessibilityInfo.announceForAccessibility('Copied'); setCopied('Copied'); },
    () => { haptic('error'); setCopied('Copy failed'); },
  );
  return (
    <View>
      <ScrollView ref={vertical} nestedScrollEnabled style={[styles.output, { backgroundColor: colors.cardInner, borderColor: colors.borderInner }]}
        onContentSizeChange={() => vertical.current?.scrollToEnd({ animated: false })} accessibilityLabel="Check output">
        <ScrollView horizontal nestedScrollEnabled contentContainerStyle={styles.outputInner}>
          <Text selectable style={[styles.code, { color: colors.text }]}>{text}</Text>
        </ScrollView>
      </ScrollView>
      <View style={styles.copy}>
        <Button label={copied || 'Copy output'} size="small" icon={{ ios: 'doc.on.doc', android: 'content_copy' }} onPress={() => void copy()} />
      </View>
    </View>
  );
}

function Result({ report }: { report: CheckReport }) {
  const colors = useColors();
  if (!report.checked) return <Banner visible tone="info" title="Nothing to check" body={report.reason} />;
  return (
    <CardTitled title={report.ok ? 'Passed' : 'Failed'}>
      <Row title={report.name} subtitle={report.ok ? 'Every check passed' : 'The check failed'} tone={report.ok ? 'success' : 'danger'}
        leading={<Icon ios={report.ok ? 'checkmark.circle.fill' : 'xmark.octagon.fill'} android={report.ok ? 'check_circle' : 'error'} size={20} color={report.ok ? colors.success : colors.danger} />} />
      {!!report.output && <Output text={report.output} />}
      {report.truncated && <Text style={[type.footnote, styles.note, { color: colors.faint }]}>The output was long; this is its end.</Text>}
    </CardTitled>
  );
}

export default function ChecksScreen() {
  const params = useLocalSearchParams<{ device: string; session?: string; project?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'checks.plan');
  const canRun = useHostAllows(device, 'checks.run');
  const runNote = useAccessNote(device, ['checks.run']);
  const [session, setSession] = useState(params.session || '');
  const title = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session)?.title);
  const load = useCallback(() => checksPlan(device, session), [device, session]);
  const { value, error, reload } = useLoad(supported && session ? load : null, `${device}/${session}`);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [runError, setRunError] = useState('');
  const run = async () => {
    setRunning(true); setRunError(''); setReport(null);
    try {
      const result = await runChecks(device, session);
      setReport(result);
      haptic(result.checked && result.ok ? 'success' : 'warning');
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Checks' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={CHECK_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!session) return page(<TaskPicker device={device} projectId={params.project || undefined} onPick={id => { setSession(id); setReport(null); }} purpose="Check the work of" />);
  if (!value) return page(error ? <Failed title="Couldn’t read the checkout" error={error} retry={() => void reload()} /> : <Loading rows={2} />);
  return page(
    <>
      <CardTitled title={title ?? 'Task'} footer={value.name && runNote ? <AccessNote device={device} methods={['checks.run']} /> : value.name && canRun ? <Button label={running ? 'Running…' : report ? 'Run again' : `Run ${value.name}`} variant="primary" loading={running} onPress={() => void run()} icon={{ ios: 'play.fill', android: 'play_arrow' }} /> : undefined}>
        <Row title={value.name ?? 'No fast check'} subtitle={value.name ? 'Runs in the task’s checkout, for up to 2 minutes' : 'This project declares no npm test script and has no Cargo.toml.'}
          leading={<Icon ios="terminal" android="terminal" size={20} color={colors.muted} />} />
      </CardTitled>
      <Banner visible={!!runError} tone="danger" title="Couldn’t run the check" body={runError} />
      {report && <Result report={report} />}
    </>,
  );
}

const styles = StyleSheet.create({
  output: { maxHeight: 360, marginHorizontal: geometry.rowInset, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline },
  outputInner: { padding: geometry.rowInset },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  copy: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: geometry.rowInset, paddingVertical: geometry.cardPadding },
  note: { paddingHorizontal: geometry.rowInset, paddingBottom: 8 },
});
