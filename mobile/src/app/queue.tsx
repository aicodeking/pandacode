// The host's message queue for one task (queue.list): messages typed while the agent works, sent in
// order once the run finishes. Edit a message's text, move it up or down, remove it from the row's menu or
// with a swipe (removed on the computer at once, with Undo in a toast: `queue.restore` puts the exact
// entry back; older hosts re-add it with task.send, see connect/api/queue.ts). Attachments
// stay as the desktop queued them. Pushed from the composer's queue chip with ?device=&session=.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo, Alert, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';
import { loadQueue, removeQueued, reorderQueue, restoreRemoved, updateQueued, useHostQueues } from '../connect/api/composer.ts';
import { useHostAllows, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { outdated, promptMaybeRan } from '../connect/rpc.ts';
import { taskKey, useConnect } from '../store/index.ts';
import { moved, type QueuedEntry } from '../store/slash.ts';
import { editorState, removalUndo, sendAllowed } from '../store/queue-order.ts';
import { isActive } from '../ui/status.tsx';
import { restoreQueued } from '../connect/api/queue.ts';
import { Banner, Button, Card, EmptyState, geometry, haptic, InnerCard, PressScale, showToast, Skeleton, type as textStyle, useMotion, useStagger } from '../ui/ds/index.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, type MenuItem } from '../ui/Menu.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

const POLL_MS = 5_000;
const EMPTY_ICON = { ios: 'tray', android: 'inbox' } as const;
const ERROR_ICON = { ios: 'exclamationmark.triangle', android: 'warning' } as const;
const SWIPE_WIDTH = 88;
const REMOVED_ICON = { ios: 'trash', android: 'delete' } as const;

function Move({ label, up, disabled, onPress }: { label: string; up: boolean; disabled: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} disabled={disabled} accessibilityLabel={label} hitSlop={4} style={[styles.move, disabled && styles.off]}>
      <Icon ios={up ? 'chevron.up' : 'chevron.down'} android={up ? 'keyboard_arrow_up' : 'keyboard_arrow_down'} size={15} color={colors.muted} />
    </PressScale>
  );
}

function Remove({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityLabel="Remove" style={[styles.remove, { backgroundColor: colors.danger }]}>
      <Icon ios="trash.fill" android="delete" size={18} color={colors.onPrimary} />
      <Text style={[textStyle.footnoteMedium, { color: colors.onPrimary }]}>Remove</Text>
    </PressScale>
  );
}

/** What this phone may change in the queue there: each is its own method (grant, Full access switch). */
interface QueueRights { edit: boolean; remove: boolean; reorder: boolean }

/** The row's menu: Edit (when the phone can edit it) and Remove (when it may remove). */
function rowMenu(entry: QueuedEntry, busy: boolean, rights: QueueRights, onEdit: () => void, onRemove: () => void): MenuItem[] {
  return [
    ...(!rights.edit || busy || entry.truncated ? [] : [{ label: 'Edit', ios: 'pencil', android: 'edit', onPress: onEdit } as const]),
    ...(rights.remove ? [{ label: 'Remove', ios: 'trash', android: 'delete', destructive: true, onPress: onRemove } as const] : []),
  ];
}

function Entry({ entry, index, count, busy, rights, onMove, onEdit, onRemove }: {
  entry: QueuedEntry; index: number; count: number; busy: boolean; rights: QueueRights;
  onMove: (by: number) => void; onEdit: () => void; onRemove: () => void;
}) {
  const colors = useColors();
  const editable = rights.edit && !busy && !entry.truncated;
  const menu = rowMenu(entry, busy, rights, onEdit, onRemove);
  const actions = [
    ...(rights.remove ? [{ name: 'delete', label: 'Remove' }] : []),
    ...(rights.reorder && index > 0 ? [{ name: 'increment', label: 'Move up' }] : []),
    ...(rights.reorder && index < count - 1 ? [{ name: 'decrement', label: 'Move down' }] : []),
  ];
  const meta = [index === 0 ? 'Sends next' : `#${index + 1}`, entry.attachments ? `${entry.attachments} attachment${entry.attachments === 1 ? '' : 's'}` : '', entry.truncated ? 'Long: edit on your computer' : ''].filter(Boolean).join(' · ');
  return (
    // Off while a change is on the way, as the menu's and move buttons' actions are.
    <Swipeable enabled={rights.remove && !busy} renderRightActions={() => <Remove onPress={onRemove} />} rightThreshold={SWIPE_WIDTH / 2} friction={1} childrenContainerStyle={{ backgroundColor: colors.cardInner }}>
      <View style={styles.entry}>
        <PressScale onPress={onEdit} disabled={!editable} style={styles.entryText} accessibilityLabel={`${meta}. ${entry.text}`} accessibilityHint={editable ? 'Edits this message' : undefined}
          accessibilityActions={actions}
          onAccessibilityAction={e => (e.nativeEvent.actionName === 'delete' ? onRemove() : e.nativeEvent.actionName === 'increment' ? onMove(-1) : onMove(1))}>
          <Text numberOfLines={4} style={[textStyle.subhead, { color: colors.text }]}>{entry.text}</Text>
          <Text numberOfLines={1} style={[textStyle.footnote, { color: colors.muted }]}>{meta}</Text>
        </PressScale>
        {rights.reorder && <View style={styles.moves}>
          <Move label="Move up" up disabled={busy || index === 0} onPress={() => onMove(-1)} />
          <Move label="Move down" up={false} disabled={busy || index === count - 1} onPress={() => onMove(1)} />
        </View>}
        {/* Removing never needs the swipe: the row's menu has it too. */}
        {menu.length > 0 && <Menu ios="ellipsis.circle" android="more_vert" color={colors.muted} items={menu} label="Message actions">
          {icon => <View style={styles.more}>{icon}</View>}
        </Menu>}
      </View>
    </Swipeable>
  );
}

const SENT_ICON = { ios: 'paperplane', android: 'send' } as const;

/** The edit field. `sent`: the computer sent the message meanwhile, so the draft stays to copy, not save. */
function Editor({ entry, sent, onCancel, onSave }: { entry: QueuedEntry; sent: boolean; onCancel: () => void; onSave: (text: string) => void }) {
  const colors = useColors();
  const [text, setText] = useState(entry.text);
  // Leaving the screen with a changed draft asks first; Save and Cancel close the editor in place.
  useDiscardGuard(text !== entry.text, { message: sent ? 'Your draft isn’t copied.' : 'Your edit to this message isn’t saved.' });
  const copy = () => Clipboard.setStringAsync(text).then(() => {
    haptic('success'); AccessibilityInfo.announceForAccessibility('Copied');
  }, () => haptic('error'));
  return (
    <Card>
      <Banner visible={sent} tone="warning" title="This message was already sent" body="The computer sent it before your edit was saved. Copy your draft to send it again."
        icon={SENT_ICON} action={{ label: 'Copy', onPress: () => void copy() }} style={styles.sentNote} />
      <InnerCard style={styles.editor}>
        <TextInput value={text} onChangeText={setText} multiline autoFocus accessibilityLabel="Queued message" placeholderTextColor={colors.faint}
          style={[textStyle.body, styles.editorInput, { color: colors.text }]} />
      </InnerCard>
      <View style={styles.editorActions}>
        <Button label={sent ? 'Close' : 'Cancel'} variant="plain" size="small" onPress={onCancel} />
        {!sent && <Button label="Save" variant="primary" size="small" disabled={!text.trim() || text === entry.text} onPress={() => onSave(text)} />}
      </View>
    </Card>
  );
}

/** A `queue.remove` whose reply was lost (or an older host dropped late) may still have run: reload the
 * queue, and it landed if the entry is gone. Then Undo still applies; `queue.restore` is idempotent. */
async function removalLanded(device: string, session: string, id: string, error: unknown): Promise<boolean> {
  if (!promptMaybeRan(error)) return false;
  const entries = await loadQueue(device, session).catch(() => null);
  return !!entries && !entries.some(e => e.id === id);
}

export default function QueueScreen() {
  const { device = '', session = '' } = useLocalSearchParams<{ device: string; session: string }>();
  const colors = useColors();
  const scroll = usePushedScroll();
  const { layout } = useMotion();
  const supported = useHostSupports(device, 'queue.list');
  const canEdit = useHostAllows(device, 'queue.update');
  const canRemove = useHostAllows(device, 'queue.remove');
  const canReorder = useHostAllows(device, 'queue.reorder');
  /** Hosts with `queue.restore` put any removal back; older ones need a re-send (connect/api/queue.ts). */
  const hostRestores = useHostSupports(device, 'queue.restore');
  const caps = useHostCapabilities(device);
  const mode = useConnect(s => s.tasks[device]?.tasks.find(t => t.sessionId === session)?.mode);
  const undoHost = { restore: hostRestores, sendAllowed: sendAllowed(mode, caps?.kind === 'hello' ? caps.remoteFullAccess : undefined) };
  const rights: QueueRights = { edit: canEdit, remove: canRemove, reorder: canReorder };
  /** The methods this phone may not call there, for the access note. */
  const blocked = ([['queue.update', canEdit], ['queue.remove', canRemove], ['queue.reorder', canReorder]] as const).filter(([, ok]) => !ok).map(([m]) => m);
  const computer = useConnect(s => s.devices.find(d => d.id === device)?.name ?? 'your computer');
  const running = useConnect(s => s.live[taskKey(device, session)]?.status === 'running');
  /** Running or waiting on you: either way the agent can take messages from the queue (as changes.tsx). */
  const active = useConnect(s => isActive(s.live[taskKey(device, session)]?.status ?? 'idle'));
  const entries = useHostQueues(s => s[taskKey(device, session)]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The message being edited, as it was when the editor opened (it outlives a send from the computer). */
  const [editing, setEditing] = useState<QueuedEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const enter = useStagger(!!entries);
  const load = useCallback(() => loadQueue(device, session).then(() => setError(''), (e: Error) => setError(e.message)), [device, session]);
  useEffect(() => { if (supported) void load(); }, [load, supported]);
  useReloadOnReconnect(device, () => (supported ? load() : undefined));
  useEffect(() => {
    if (!supported || !active) return undefined;
    // The agent takes messages from the front as runs finish, so poll only while it's active; the run's
    // end reloads once more through this cleanup.
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => { clearInterval(timer); void load(); };
  }, [load, supported, active]);

  const run = async (work: () => Promise<unknown>, success: 'light' | 'warning' = 'light') => {
    setBusy(true);
    try {
      await work();
      haptic(success);
    } catch (e) {
      haptic('error');
      Alert.alert('Couldn’t change the queue', (e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  // Remove reaches the computer at once, so a run ending meanwhile can't send the message. Undo puts
  // it back: with `queue.restore` the host returns the exact entry to its old place; an older host
  // gets it re-sent (connect/api/queue.ts), so one the phone can't rebuild (cut short, with
  // attachments, or in a mode it may not send in) asks first instead.
  /** Hidden while their removal is on the way, so a row goes at once. Replaced, never changed in place,
   *  so two quick removals can't bring each other's row back when the first finishes. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const putBack = async (entry: QueuedEntry, before: readonly string[]) => {
    const restored = await (hostRestores ? restoreRemoved(device, session, entry.id) : restoreQueued(device, session, entry, before));
    // Only an older host's re-send says 'sent': the run ended meanwhile, so it went out at once.
    if (restored === 'sent') showToast({ title: 'Sent now: the run had already finished.', icon: SENT_ICON });
  };
  const removeNow = (entry: QueuedEntry, undoable: boolean) => {
    const before = (entries ?? []).map(e => e.id);
    setRemoving(ids => new Set([...ids, entry.id]));
    setEditing(open => (open?.id === entry.id ? null : open));
    void run(async () => {
      try {
        await removeQueued(device, session, entry.id);
      } catch (e) {
        if (!(await removalLanded(device, session, entry.id, e))) throw e;
      } finally { setRemoving(ids => new Set([...ids].filter(id => id !== entry.id))); }
      if (!undoable) return;
      const undo = () => {
        haptic('selection');
        putBack(entry, before).catch((e: Error) => { haptic('error'); Alert.alert('Couldn’t put the message back', e.message); void load(); });
      };
      showToast({ title: 'Removed from the queue', body: entry.text.slice(0, 120), icon: REMOVED_ICON, action: { label: 'Undo', onPress: undo } });
    }, 'warning');
  };
  const remove = (entry: QueuedEntry) => {
    if (removalUndo(entry, undoHost) === 'undo') return removeNow(entry, true);
    const why = !undoHost.sendAllowed ? `Full access is off for remote tasks on ${computer}, so it can’t be added back from the phone.`
      : entry.attachments ? 'Its attachments can’t be added back from the phone.' : 'It’s too long to add back from the phone.';
    Alert.alert('Remove this message?', why, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeNow(entry, false) },
    ]);
  };
  const list = (entries ?? []).filter(e => !removing.has(e.id));
  const move = (index: number, by: number) => run(() => reorderQueue(device, session, moved(list.map(e => e.id), index, by)));
  const save = (entry: QueuedEntry, text: string) => run(async () => { await updateQueued(device, session, entry.id, text); setEditing(null); });
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const editor = editorState(editing?.id ?? null, entries);
  /** The open message: the queue's current copy, or the snapshot once it was sent. */
  const edited = editing && (list.find(e => e.id === editing.id) ?? (editor === 'sent' ? editing : undefined));

  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Queue' }} />
      <HeaderActions />
      {!supported && <EmptyState icon={ERROR_ICON} title="Queue unavailable" body={outdated(computer)} />}
      {supported && !entries && !error && <Card><InnerCard style={styles.loading}><Skeleton width="80%" /><Skeleton width="55%" /></InnerCard></Card>}
      {supported && !entries && !!error && <EmptyState icon={ERROR_ICON} title="Couldn’t load the queue" body={error} action={{ label: 'Retry', onPress: () => void load() }} />}
      <Banner visible={!!entries && !!error} title="Couldn’t refresh" body={error} action={{ label: 'Retry', onPress: () => void load() }} />
      {entries && blocked.length > 0 && <AccessNote device={device} methods={blocked} />}
      {entries && !list.length && <EmptyState icon={EMPTY_ICON} title="Nothing queued" body={running ? 'Messages you send while the agent works wait here.' : 'Messages sent while the agent works wait here until its run ends.'} />}
      {edited && <Animated.View layout={layout}><Editor key={edited.id} entry={edited} sent={editor === 'sent'} onCancel={() => setEditing(null)} onSave={text => void save(edited, text)} /></Animated.View>}
      {list.length > 0 && (
        <Animated.View entering={enter(0)} layout={layout}>
          <Card>
            <InnerCard style={styles.list}>
              {list.map((entry, index) => (
                <View key={entry.id}>
                  {index > 0 && <View style={[styles.separator, { backgroundColor: colors.separator }]} />}
                  <Entry entry={entry} index={index} count={list.length} busy={busy} rights={rights}
                    onMove={by => void move(index, by)} onEdit={() => setEditing(entry)} onRemove={() => void remove(entry)} />
                </View>
              ))}
            </InnerCard>
            <Text style={[textStyle.footnote, styles.footer, { color: colors.muted }]}>
              {`${running ? 'Sends in this order after the current run.' : 'Sends in this order when the agent next finishes.'}${canRemove ? ' Swipe left or use a message’s menu to remove it.' : ''}`}
            </Text>
          </Card>
        </Animated.View>
      )}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  loading: { padding: geometry.rowInset, gap: geometry.cardPadding },
  list: { paddingVertical: 0, overflow: 'hidden' },
  entry: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding, paddingLeft: geometry.rowInset, paddingRight: geometry.cardPadding / 2, paddingVertical: geometry.sectionGap },
  entryText: { flex: 1, gap: geometry.cardPadding / 2 },
  moves: { gap: geometry.cardPadding / 3 },
  more: { width: 36, height: geometry.rowHeight, alignItems: 'center', justifyContent: 'center' },
  move: { width: 36, height: 30, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.35 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: geometry.rowInset },
  remove: { width: SWIPE_WIDTH, alignItems: 'center', justifyContent: 'center', gap: geometry.cardPadding / 2 },
  footer: { paddingHorizontal: geometry.cardPadding, paddingTop: geometry.cardPadding },
  editor: { padding: geometry.cardPadding / 2 },
  editorInput: { minHeight: 88, maxHeight: 220, padding: geometry.cardPadding, textAlignVertical: 'top' },
  sentNote: { marginBottom: geometry.cardPadding },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: geometry.cardPadding, paddingTop: geometry.cardPadding },
});
