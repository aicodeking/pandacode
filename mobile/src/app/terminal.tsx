// A terminal on the computer (?device=&session=&terminal=): without a terminal, pick one of the
// computer's terminals or open a shell in the task's checkout (or a project's); with one, its
// output (polled, store/terminal.ts) above an input bar and a row of keys that rides the keyboard.
// Every terminal method needs Full access (a terminal shows anything on the computer) and the host's
// "Full access for remote tasks" switch; useHostBlock says which is missing, and the screen shows that
// note instead of the terminals.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHostAllows, useHostBlock, useHostSupports } from '../connect/api/capabilities.ts';
import { closeTerminal, listTerminals, openTerminal, resizeTerminal, writeTerminal, type TerminalInfo } from '../connect/api/terminal.ts';
import { outdated } from '../connect/rpc.ts';
import { terminalSubtitle } from '../store/terminal.ts';
import { Banner, Button, EmptyState, geometry, haptic, Row } from '../ui/ds/index.ts';
import { useToastClearance } from '../ui/ds/Toast.tsx';
import { CardTitled, Failed, glyph, Loading, ProjectRows, styles as hub, useComputerName, useLoad, useProjects } from '../ui/hub/common.tsx';
import { hasGlass } from '../ui/Glass.tsx';
import { AccessNote } from '../ui/AccessNote.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { TerminalInput } from '../ui/terminal/TerminalInput.tsx';
import { TerminalOutput } from '../ui/terminal/TerminalOutput.tsx';
import { useKeyboardLift } from '../ui/terminal/useKeyboardLift.ts';
import { useTerminalPoll } from '../ui/terminal/useTerminalPoll.ts';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { usePaneInsets } from '../ui/split.tsx';

const TERMINAL_ICON = glyph({ ios: 'apple.terminal', android: 'terminal' });
/** The size a shell opens at before the view has measured itself. */
const OPEN_COLS = 40;
const OPEN_ROWS = 20;
/** What a phone without Full access, or a computer with the Full access switch off, shows in place of the terminals. */
function NeedsFull({ computer, reason }: { computer: string; reason: 'access' | 'switch' }) {
  return reason === 'switch' ? (
    <EmptyState icon={TERMINAL_ICON} title="Terminals are off" body={`Turn on Full access for remote tasks on ${computer} to use terminals from this phone.`} style={hub.empty} />
  ) : (
    <EmptyState icon={TERMINAL_ICON} title="Terminals need Full access"
      body={`A terminal can show anything on ${computer}, so only a phone with Full access can see one. Change it for this phone in PandaCode Settings → Connect on ${computer}.`} style={hub.empty} />
  );
}

/** Waits for the measured size to settle before telling the computer. */
const RESIZE_DEBOUNCE_MS = 250;

function TerminalRow({ terminal, onPick }: { terminal: TerminalInfo; onPick: () => void }) {
  const colors = useColors();
  return (
    <Row title={terminal.title || 'Terminal'} subtitle={terminalSubtitle(terminal)} onPress={onPick}
      leading={<Icon ios="apple.terminal" android="terminal" size={20} color={terminal.running ? colors.text : colors.faint} />} />
  );
}

/** The computer's terminals as the screen loaded them (pull to refresh, and again on focus). */
interface TerminalList { value?: TerminalInfo[]; error?: string; reload: () => Promise<void> }

/** Pick a terminal, or open a new one in the task's checkout or a project. */
function Picker({ device, session, list, onPick }: { device: string; session: string; list: TerminalList; onPick: (id: string) => void }) {
  const canOpen = useHostAllows(device, 'terminal.open');
  const { value, error, reload } = list;
  const { projects } = useProjects(device);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const open = async (target: { sessionId?: string; projectId?: string }) => {
    setOpening(true); setOpenError('');
    try {
      const id = await openTerminal(device, target, OPEN_COLS, OPEN_ROWS);
      haptic('success');
      onPick(id);
    } catch (e) {
      setOpenError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };
  if (!value) return error ? <Failed title="Couldn’t list terminals" error={error} retry={() => void reload()} /> : <Loading rows={2} />;
  const shown = session ? value.filter(t => t.sessionId === session || !t.sessionId) : value;
  return (
    <>
      <Banner visible={!!openError} tone="danger" title="Couldn’t open a terminal" body={openError} />
      {canOpen && session ? (
        <Button label={opening ? 'Opening…' : 'New terminal in this task'} variant="primary" loading={opening} icon={{ ios: 'plus', android: 'add' }} onPress={() => void open({ sessionId: session })} />
      ) : null}
      {shown.length ? (
        <CardTitled title="Terminals">
          {shown.map(t => <TerminalRow key={t.id} terminal={t} onPick={() => onPick(t.id)} />)}
        </CardTitled>
      ) : (
        <EmptyState icon={TERMINAL_ICON} title="No terminals open" body={canOpen ? 'Open one to run commands on this computer.' : 'Terminals opened on the computer show up here.'} style={hub.empty} />
      )}
      {canOpen && !session && !!projects?.length && (
        <CardTitled title="New terminal in">
          <ProjectRows projects={projects.filter(p => !p.chat)} max={12} onPick={id => void open({ projectId: id })} />
        </CardTitled>
      )}
    </>
  );
}

/** One terminal: output, the input bar, and the keyboard lift. */
function TerminalPane({ device, terminalId, title }: { device: string; terminalId: string; title: string }) {
  const insets = useSafeAreaInsets();
  // Side insets less the left one beside the Duo's sidebar, which takes it itself.
  const side = usePaneInsets();
  const header = useHeaderHeight();
  const canWrite = useHostAllows(device, 'terminal.write');
  const [grid, setGrid] = useState({ cols: OPEN_COLS, rows: OPEN_ROWS });
  const poll = useTerminalPoll(device, terminalId, grid.cols, grid.rows);
  const bottom = Math.max(insets.bottom, 8);
  const { lift, settled } = useKeyboardLift(bottom);
  // Toasts sit above the input and keys (0 until laid out). The host measures from the safe area or
  // the keyboard, so the dock's own safe-area padding isn't counted twice.
  const [dock, setDock] = useState(0);
  useToastClearance(dock > 0 ? dock - insets.bottom : 0);
  const measureDock = (event: LayoutChangeEvent) => setDock(event.nativeEvent.layout.height);
  const [sendError, setSendError] = useState('');
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { resize, nudge, ended } = poll;

  const onGrid = useCallback((cols: number, rows: number) => {
    setGrid({ cols, rows });
    resize(cols, rows);
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      // A View grant reads only; the computer keeps its size.
      if (canWrite && !ended) resizeTerminal(device, terminalId, cols, rows).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }, [canWrite, device, terminalId, resize, ended]);
  useEffect(() => () => { if (resizeTimer.current) clearTimeout(resizeTimer.current); }, []);

  const send = useCallback(async (data: string) => {
    try {
      await writeTerminal(device, terminalId, data);
      setSendError('');
      nudge();
    } catch (e) {
      setSendError((e as Error).message);
      throw e;
    }
  }, [device, terminalId, nudge]);

  const end = () => Alert.alert(`End ${title}?`, 'This stops the shell and anything running in it on the computer.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'End', style: 'destructive', onPress: () => void closeTerminal(device, terminalId).then(() => router.setParams({ terminal: '' }), (e: Error) => setSendError(e.message)) },
  ]);

  const status = poll.ended ? (poll.exitCode === undefined ? 'This terminal has ended.' : `Exited with code ${poll.exitCode}.`) : '';
  return (
    <View style={[styles.fill, { paddingLeft: side.left, paddingRight: side.right }]}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title }} />
      <HeaderActions right={[
        { label: 'All terminals', icon: { ios: 'list.bullet', android: 'list' }, onPress: () => router.setParams({ terminal: '' }) },
        { label: 'End terminal', icon: { ios: 'xmark.circle', android: 'cancel' }, hidden: !canWrite || poll.ended, onPress: end },
      ]} />
      <Animated.View style={[styles.fill, lift]}>
        <TerminalOutput screen={poll.screen} onGrid={onGrid} topInset={(hasGlass ? header : 0) + settled} bottomInset={0} />
        <Banner visible={!!(poll.error || sendError || status)} tone={poll.error || sendError ? 'danger' : 'info'}
          title={sendError ? 'Couldn’t send that' : poll.error ? 'Can’t reach the terminal' : status} body={sendError || poll.error || undefined} style={styles.banner} />
        {canWrite ? (
          <View style={{ paddingBottom: bottom }} onLayout={measureDock}>
            <TerminalInput onSend={send} disabled={poll.ended} />
          </View>
        ) : (
          <View style={[styles.readOnly, { paddingBottom: bottom }]} onLayout={measureDock}>
            <AccessNote device={device} methods={['terminal.write']} />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

export default function TerminalScreen() {
  const params = useLocalSearchParams<{ device: string; session?: string; terminal?: string }>();
  const device = params.device ?? '';
  const session = params.session ?? '';
  const terminalId = params.terminal ?? '';
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'terminal.read');
  const block = useHostBlock(device, 'terminal.read');
  const refused = block === 'access' || block === 'switch' ? block : null;
  const listLoad = useCallback(() => listTerminals(device), [device]);
  const list = useLoad(supported && !refused ? listLoad : null, device);
  const title = list.value?.find(t => t.id === terminalId)?.title || 'Terminal';
  // Terminals open and end on the computer: look again whenever the screen comes back into view.
  const { reload } = list;
  const seen = useRef(false);
  useFocusEffect(useCallback(() => {
    if (seen.current) void reload();
    seen.current = true;
  }, [reload]));
  // Opening a terminal (its title) or ending one (it leaves or reads ended): list again on the way in or out.
  const shownTerminal = useRef(terminalId);
  useEffect(() => {
    if (shownTerminal.current === terminalId) return;
    shownTerminal.current = terminalId;
    void reload();
  }, [terminalId, reload]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };

  if (supported && terminalId && !refused) return <View style={[styles.fill, { backgroundColor: colors.page }]}><TerminalPane device={device} terminalId={terminalId} title={title} /></View>;
  return (
    <PushedScroll scroll={scroll} refreshControl={supported && !refused ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Terminal' }} />
      {/* right={[]}: on Android a terminal's End terminal / All terminals would otherwise stay in the bar. */}
      <HeaderActions right={[]} />
      {refused ? <NeedsFull computer={computer} reason={refused} /> : supported
        ? <Picker device={device} session={session} list={list} onPick={id => router.setParams({ terminal: id })} />
        : <EmptyState icon={TERMINAL_ICON} title={outdated(computer)} style={hub.empty} />}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  banner: { marginHorizontal: geometry.screenMargin, marginBottom: 6 },
  readOnly: { paddingHorizontal: geometry.screenMargin, paddingTop: geometry.cardPadding },
});
