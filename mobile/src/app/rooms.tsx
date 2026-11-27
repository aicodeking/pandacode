// Shared bot channels (?device=&room=): the desktop Bots view's room list, and one room's timeline
// with a composer. A post wakes the bots whose turns run on that computer, so posting needs Full
// access (rooms.post) while reading is View; a phone whose grant or the Full access switch keeps
// posting off still reads the timeline, with an AccessNote saying why.
//
// This screen existed only as host methods and demo data before, so a group of bots was invisible to
// every phone. Nothing here is a new host capability: it is the UI for `rooms.*`.
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { listRooms, postToRoom, roomMessages, type Room, type RoomMessage } from '../connect/api/rooms.ts';
import { outdated } from '../connect/rpc.ts';
import { useConnect } from '../store/index.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { BotAvatar } from '../ui/BotRow.tsx';
import { Banner, Button, Card, Chip, EmptyState, geometry, haptic, InnerCard, PressScale, type as text, type Tone } from '../ui/ds/index.ts';
import { Markdown } from '../ui/Markdown.tsx';
import { Failed, Loading, glyph, styles as hub, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { useColors } from '../ui/theme.ts';

const ROOMS_ICON = glyph({ ios: 'bubble.left.and.bubble.right', android: 'forum' });
const POST_ICON = { ios: 'paperplane.fill', android: 'send' } as const;
/** A room timeline opens with this many rows; "Load earlier" asks again with a bigger page. */
const PAGE = 60;
const PAGE_STEP = 60;
/** The longest post (the room composer's own limit on the desktop). */
const MAX_POST = 32 * 1024;

/** A reply's run status, toned as the desktop chips it. */
const STATUS_TONE: Record<string, Tone> = { Queued: 'info', 'In progress': 'running', Completed: 'success', Failed: 'danger', Stopped: 'warning' };

/** When a row was posted, short: "now", "5m", "2h", "3d". */
function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Bot id → name, so a reply is signed; an id this phone's bot list lacks reads as "Bot". */
function useBotNames(device: string): (id: string) => string {
  const bots = useConnect(s => s.bots[device]);
  return useCallback((id: string) => bots?.find(b => b.id === id)?.name ?? 'Bot', [bots]);
}

/** A reply's author: the bot's avatar and name. */
function Author({ device, id, fallback }: { device: string; id: string | null; fallback: (id: string) => string }) {
  const colors = useColors();
  const bot = useConnect(s => s.bots[device]?.find(b => b.id === id));
  if (!id) return null;
  return (
    <View style={styles.author}>
      <BotAvatar bot={{ name: bot?.name ?? fallback(id), avatar: bot?.avatar ?? null }} size={16} />
      <Text numberOfLines={1} style={[text.caption, { color: colors.muted }]}>{bot?.name ?? fallback(id)}</Text>
    </View>
  );
}

/** One timeline row: a post at the trailing edge, a bot's reply at the leading one, an assignment a quiet line. */
function MessageRow({ device, message, now, names }: { device: string; message: RoomMessage; now: number; names: (id: string) => string }) {
  const colors = useColors();
  if (message.kind === 'assigned') {
    return (
      <View style={styles.system} accessible accessibilityLabel={message.text}>
        <Icon ios="arrow.turn.down.right" android="subdirectory_arrow_right" size={11} color={colors.faint} />
        <Text numberOfLines={2} style={[text.caption, styles.systemText, { color: colors.faint }]}>{message.text}</Text>
      </View>
    );
  }
  const mine = message.kind === 'user';
  const tone = message.status ? STATUS_TONE[message.status] : undefined;
  return (
    <View style={[styles.row, mine ? styles.mine : styles.theirs]}>
      <InnerCard style={styles.bubble}>
        {!mine && <Author device={device} id={message.authorBotId} fallback={names} />}
        <Markdown text={message.text} />
        <View style={styles.meta}>
          {!!message.status && !!tone && <Chip label={message.status} tone={tone} />}
          <Text style={[text.caption, { color: colors.faint }]}>{age(message.createdAt, now)}</Text>
        </View>
      </InnerCard>
    </View>
  );
}

/** Posts into a room, or says why this phone can't (hidden when the host lacks rooms.post). */
function Composer({ device, room, canPost }: { device: string; room: Room; canPost: boolean }) {
  const colors = useColors();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!canPost) return <AccessNote device={device} methods={['rooms.post']} style={styles.notePads} />;
  const send = async () => {
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    haptic('light');
    try {
      await postToRoom(device, room.id, value);
      setDraft('');
      haptic('success');
    } catch (e) {
      haptic('error');
      setError((e as Error).message || 'That post did not go through.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <View style={styles.compose}>
        <TextInput value={draft} onChangeText={handleChange(setDraft, setError)} multiline placeholder={`Message ${room.name}…`} accessibilityLabel={`Message ${room.name}`}
          maxLength={MAX_POST} placeholderTextColor={colors.faint} style={[styles.input, { color: colors.text, backgroundColor: colors.fill, borderColor: colors.border }]} />
        <Button label="Post" variant="primary" icon={POST_ICON} loading={busy} disabled={!draft.trim() || busy} onPress={() => void send()} />
      </View>
      {!!error && <Text accessibilityRole="alert" style={[text.footnote, styles.composeError, { color: colors.danger }]}>{error}</Text>}
    </Card>
  );
}

/** Typing clears the last failure, so a corrected post isn't shown under a stale error. */
const handleChange = (set: (value: string) => void, setError: (value: string) => void) => (value: string) => { set(value); setError(''); };

/** A chosen room's timeline, in the page's one scroll view. */
function RoomBody({ device, room }: { device: string; room: Room }) {
  const colors = useColors();
  const names = useBotNames(device);
  const canPost = useHostAllows(device, 'rooms.post');
  const [limit, setLimit] = useState(PAGE);
  const load = useCallback(() => roomMessages(device, room.id, limit), [device, room.id, limit]);
  const { value, error, reload } = useLoad(load, `${device}/${room.id}/${limit}`);
  const [now, setNow] = useState(() => Date.now());
  // Ages are relative: one tick a minute keeps them honest without re-reading the room.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!value) return error ? <Failed title="Couldn’t open the room" error={error} retry={() => void reload()} /> : <Loading rows={5} />;
  return (
    <>
      {value.archived && <Banner visible tone="info" title="Archived" body="A new post wakes nobody in an archived room." />}
      {value.truncated && <Banner visible tone="info" title="Some messages were left out" body="The computer cut this timeline to fit. Read all of it from the desktop." />}
      <Card>
        <View style={styles.summary}>
          <Text style={[text.footnote, { color: colors.muted }]}>
            {`${value.memberIds.length} member${value.memberIds.length === 1 ? '' : 's'}${value.leadBotId ? ' · has a lead' : ''}`}
          </Text>
          {value.hasMore && (
            <PressScale onPress={() => setLimit(current => current + PAGE_STEP)} accessibilityLabel="Load earlier messages" hitSlop={8} style={styles.more}>
              <Text style={[text.footnoteMedium, { color: colors.text }]}>Load earlier messages</Text>
            </PressScale>
          )}
        </View>
        {value.messages.length === 0
          ? <Text style={[text.footnote, styles.emptyRoom, { color: colors.muted }]}>No messages yet.</Text>
          : value.messages.map(m => <MessageRow key={m.id} device={device} message={m} now={now} names={names} />)}
      </Card>
      <Composer device={device} room={value} canPost={canPost} />
    </>
  );
}

/** The room list, each row opening its timeline in place. */
function RoomRow({ room, now, on: onPress }: { room: Room; now: number; on: () => void }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={`${room.name}, ${room.memberIds.length} members`}>
      <InnerCard style={styles.room}>
        <Icon ios="bubble.left.and.bubble.right" android="forum" size={18} color={colors.muted} />
        <View style={styles.roomText}>
          <View style={styles.roomTitle}>
            <Text numberOfLines={1} style={[text.bodyMedium, { color: colors.text }]}>{room.name}</Text>
            {room.archived && <Chip label="Archived" />}
          </View>
          <Text numberOfLines={1} style={[text.footnote, { color: colors.muted }]}>
            {`${room.memberIds.length} member${room.memberIds.length === 1 ? '' : 's'} · ${age(room.updatedAt, now)}`}
          </Text>
        </View>
        <Icon ios="chevron.right" android="chevron_right" size={13} color={colors.glyphFaint} />
      </InnerCard>
    </PressScale>
  );
}

export default function RoomsScreen() {
  const params = useLocalSearchParams<{ device: string; room?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'rooms.list');
  // Hooks stay unconditional: the loader is only *asked* to run when the host serves rooms.
  const load = useCallback(() => listRooms(device), [device]);
  const { value, error, reload } = useLoad(supported ? load : null, device);
  // The room in the URL is the one shown; picking another rewrites it (the Duo's pane keeps it).
  const [picked, setPicked] = useState(params.room || '');
  const [refreshing, setRefreshing] = useState(false);
  const open = params.room || picked;
  const refresh = async () => {
    setRefreshing(true);
    try { await reload(); } finally { setRefreshing(false); }
  };
  const rooms = value ?? [];
  const room = rooms.find(item => item.id === open);
  // One clock for every relative age on the screen, so they agree with each other.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: room?.name ?? 'Rooms' }} />
      <HeaderActions />
      {!supported && <EmptyState icon={ROOMS_ICON} title={outdated(computer)} style={hub.empty} />}
      {supported && !!error && !value && <Failed title="Couldn’t list the rooms" error={error} retry={() => void reload()} />}
      {supported && !value && !error && <Loading rows={3} />}
      {supported && !!value && !rooms.length && <EmptyState icon={ROOMS_ICON} title="No shared rooms" body={`Make one in the desktop’s Bots view on ${computer}.`} style={hub.empty} />}
      {supported && !!room && <RoomBody device={device} room={room} />}
      {supported && !!value && !room && rooms.map(item => <RoomRow key={item.id} room={item} now={now} on={() => setPicked(item.id)} />)}
      {supported && !!value && !room && !!error && <Banner visible tone="danger" title="Couldn’t refresh the rooms" body={error} />}
    </PushedScroll>
  );
}

const styles = StyleSheet.create({
  room: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: geometry.rowInset, paddingVertical: 10, marginBottom: 8 },
  roomText: { flex: 1, gap: 2 },
  roomTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: geometry.cardPadding, paddingTop: geometry.cardPadding, paddingBottom: 4 },
  more: { minHeight: 28, justifyContent: 'center' },
  row: { paddingHorizontal: geometry.cardPadding, paddingVertical: 3 },
  mine: { alignItems: 'flex-end' },
  theirs: { alignItems: 'flex-start' },
  bubble: { maxWidth: '92%', paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  author: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'flex-end' },
  system: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: geometry.cardPadding + 8, paddingVertical: 4 },
  systemText: { flex: 1 },
  compose: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: geometry.cardPadding },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderRadius: geometry.controlRadius, borderWidth: geometry.hairline, paddingHorizontal: 12, paddingVertical: 9, fontSize: text.callout.fontSize, borderCurve: 'continuous' },
  composeError: { paddingHorizontal: geometry.cardPadding, paddingBottom: 8 },
  emptyRoom: { padding: geometry.cardPadding },
  notePads: { marginHorizontal: geometry.screenMargin },
});
