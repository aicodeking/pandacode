// Run & servers for a project (?device=&project=, or &session=): the project's run script (what
// the desktop's Run button starts) with Start, and the local servers listening on the computer with
// their ports. Starting runs the project's own script in a terminal on the computer, so it needs
// Full access on this device; Stop ends the terminal it started (runScript.stop, gated the same way).
// A server's address is the computer's localhost, which the phone can't open, so its row copies it.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo, Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote, useAccessNote } from '../ui/AccessNote.tsx';
import { hostCall } from '../connect/client.ts';
import { localServers, runScriptStart, runScriptStop, type RunScript } from '../connect/api/tools.ts';
import { outdated } from '../connect/rpc.ts';
import { Banner, Button, EmptyState, geometry, haptic, Row, showToast, type } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, ProjectPicker, styles as hub, useComputerName, useLoad, useProjects } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { mono, useColors } from '../ui/theme.ts';
import { runningTerminal, scriptState } from '../store/run-script.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const RUN_ICON = glyph({ ios: 'play.rectangle', android: 'play_circle' });
/** The listeners change as servers start: look again a moment after a start. */
const AFTER_START_MS = 2500;

const getScript = (device: string, projectId?: string, sessionId?: string) =>
  hostCall<unknown>(device, 'runScript.get', sessionId ? { sessionId } : { projectId }).then(reply => scriptState<RunScript>(reply));

export default function ServersScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string }>();
  const device = params.device ?? '';
  const session = params.session || undefined;
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'runScript.get');
  const canStart = useHostAllows(device, 'runScript.start');
  const startNote = useAccessNote(device, ['runScript.start']);
  const canStop = useHostAllows(device, 'runScript.stop');
  const canList = useHostSupports(device, 'localServers.list');
  const { projects } = useProjects(device);
  const [project, setProject] = useState(params.project || undefined);
  const target = { projectId: project, sessionId: session };
  const loadScript = useCallback(() => getScript(device, project, session), [device, project, session]);
  const script = useLoad(supported && (project || session) ? loadScript : null, `${device}/${project}/${session}`);
  const loadServers = useCallback(() => localServers(device), [device]);
  const servers = useLoad(canList ? loadServers : null, device);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  /** The terminal the last Start opened there, until it is stopped: only for hosts that don't report `running`. */
  const [opened, setOpened] = useState<string | null>(null);
  /** The running script's terminal: the host's word whenever it gives one (null = it ended), else this Start's. */
  const terminal = runningTerminal(script.value, opened);
  /** 'Started' holds only while the script still runs (or the host can't say). */
  const startedShown = started && (!!terminal || !script.value?.reportsRunning);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState('');
  const [startError, setStartError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  /** The reloads queued AFTER_START_MS after a Start or Stop, cleared when the screen goes. */
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);
  const reloadServersSoon = () => {
    const timer = setTimeout(() => { timers.current.delete(timer); void servers.reload(); }, AFTER_START_MS);
    timers.current.add(timer);
  };
  const refresh = async () => { setRefreshing(true); await Promise.all([script.reload(), servers.reload()]); setRefreshing(false); };
  const start = async () => {
    if (terminal) return; // one copy at a time: Stop it first
    setStarting(true); setStartError('');
    try {
      const reply = await runScriptStart(device, target);
      haptic('success');
      setStarted(true);
      setOpened(reply.terminalId || null);
      void script.reload();
      reloadServersSoon();
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!terminal) return;
    setStopping(true); setStartError('');
    try {
      await runScriptStop(device, terminal);
      haptic('success');
      setOpened(null);
      setStarted(false);
      await script.reload();
      reloadServersSoon();
    } catch (e) {
      haptic('error');
      setStartError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };
  // As End terminal does: stopping ends the shell and whatever it runs on the computer.
  const confirmStop = () => Alert.alert('Stop the run script?', 'This ends its terminal and anything running in it on the computer.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Stop', style: 'destructive', onPress: () => void stop() },
  ]);
  const copy = (url: string) => Clipboard.setStringAsync(url).then(() => {
    haptic('success'); setCopied(url); AccessibilityInfo.announceForAccessibility('Copied');
  }, () => haptic('error'));
  /** The preview address: copied with a toast, since it may be long and only opens on the computer. */
  const copyPreview = (preview: string) => Clipboard.setStringAsync(preview).then(() => {
    haptic('success');
    showToast({ title: 'Preview address copied', body: preview, tone: 'success', icon: { ios: 'doc.on.doc', android: 'content_copy' } });
  }, () => {
    haptic('error');
    showToast({ title: 'Couldn’t copy the address', tone: 'danger' });
  });

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Run & servers' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={RUN_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project && !session) return page(<ProjectPicker device={device} onPick={setProject} purpose={`Run a project on ${computer}`} />);

  const name = projects?.find(p => p.id === project)?.name ?? 'Project';
  const runCard = () => {
    if (script.value === undefined) return script.error ? <Failed title="Couldn’t read the run script" error={script.error} retry={() => void script.reload()} /> : <Loading rows={2} />;
    if (!script.value.script) {
      return (
        <CardTitled title={name}>
          <Row title="No run script" subtitle="Ask an agent to add one (the desktop’s Run button sets it up)." leading={<Icon ios="play.slash" android="block" size={20} color={colors.muted} />} />
        </CardTitled>
      );
    }
    const { path, previewUrl, previewPath } = script.value.script;
    const preview = previewUrl ?? previewPath;
    return (
      <CardTitled title={name} footer={startNote ? <AccessNote device={device} methods={['runScript.start']} /> : canStart ? (
        <View style={styles.actions}>
          <Button label={terminal ? 'Running' : started ? 'Start again' : 'Start'} variant="primary" loading={starting} disabled={!!terminal} icon={{ ios: 'play.fill', android: 'play_arrow' }} onPress={() => void start()} style={styles.grow} />
          {!!terminal && canStop && <Button label="Stop" variant="raised" loading={stopping} icon={{ ios: 'stop.fill', android: 'stop' }} onPress={confirmStop} style={styles.grow} />}
        </View>
      ) : undefined}>
        <Row title={path} subtitle="Run script" leading={<Icon ios="doc.plaintext" android="description" size={20} color={colors.muted} />} />
        {!!preview && <Row title={preview} subtitle="Preview · tap to copy" onPress={() => void copyPreview(preview)} onLongPress={() => void copyPreview(preview)}
          leading={<Icon ios="globe" android="public" size={20} color={colors.muted} />} trailing={<Icon ios="doc.on.doc" android="content_copy" size={16} color={colors.muted} />}
          accessibilityLabel={`Preview, ${preview}`} accessibilityHint="Copies the preview address" />}
      </CardTitled>
    );
  };
  return page(
    <>
      {runCard()}
      {!!terminal && !canStop && <AccessNote device={device} methods={['runScript.stop']} />}
      <Banner visible={!!startError} tone="danger" title={terminal ? 'Couldn’t stop it' : 'Couldn’t start it'} body={startError} />
      <Banner visible={startedShown} tone="success" title="Started on the computer" body="It runs in a terminal there; its servers appear below once they listen." icon={{ ios: 'checkmark.circle', android: 'check_circle' }} />
      {canList && (
        servers.value === undefined ? (servers.error ? <Failed title="Couldn’t list the servers" error={servers.error} retry={() => void servers.reload()} /> : <Loading rows={2} />) : (
          <CardTitled title="Local servers" trailing={<Text style={[type.footnote, { color: colors.faint }]}>{servers.value.length}</Text>}
            footer={servers.value.length ? <Text style={[type.footnote, { color: colors.muted }]}>{`These addresses open on ${computer}, not this phone. Tap one to copy it.`}</Text> : undefined}>
            {servers.value.length ? servers.value.map(s => (
              <Row key={`${s.port}/${s.process}`} title={s.process} subtitle={copied === s.url ? 'Copied' : s.url} onPress={() => void copy(s.url)}
                trailing={<View style={styles.server}><Text style={[styles.port, { color: colors.text }]}>{`:${s.port}`}</Text><Icon ios="doc.on.doc" android="content_copy" size={16} color={colors.muted} /></View>}
                leading={<Icon ios="network" android="lan" size={20} color={colors.success} />} accessibilityLabel={`${s.process} on port ${s.port}, ${s.url}`}
                accessibilityHint="Copies the address; it opens on the computer, not on this phone" />
            )) : <Row title="Nothing is listening" subtitle={`No local servers on ${computer} right now.`} />}
          </CardTitled>
        )
      )}
    </>,
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: geometry.cardPadding },
  grow: { flex: 1 },
  server: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding },
  port: { fontFamily: mono, fontSize: 14 },
});
