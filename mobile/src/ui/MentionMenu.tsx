// The composer's file mention menu (docs/file-mentions.md): typing `@` lists the task's files
// (files.search on its checkout) inside the composer's glass above the input, where SlashMenu sits,
// so it moves with the keyboard and keeps the dock's insets. Searches are debounced, recent results
// are reused briefly and stale answers are ignored. Taps never dismiss the keyboard; picking a row
// puts the desktop's reference text in the draft (store/mentions.ts).
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { searchFiles } from '../connect/api/files.ts';
import { mentionCache, mentionRows, mentionToken, type MentionEntry, type MentionToken } from '../store/mentions.ts';
import { useColors } from './theme.ts';
import { crossFadeIn, crossFadeOut, geometry, PressScale, Skeleton, type as textStyle } from './ds/index.ts';
import { Icon } from './Icon.tsx';

/** The desktop waits this long after a keystroke before searching. */
const DEBOUNCE_MS = 110;
/** As SlashMenu: the menu never covers more than this share of the window. */
const MAX_SHARE = 0.32;
const MAX_HEIGHT = 280;

interface Selection { start: number; end: number }
interface Found { key: string; rows: MentionEntry[]; error: string }

/**
 * The mention under the caret and its matches. `selection` comes from the TextInput; `enabled`
 * is false where the host has no files.search (or in a bot's conversation).
 */
export function useMentionMenu(deviceId: string, sessionId: string, text: string, selection: Selection, enabled: boolean) {
  const token: MentionToken | null = enabled ? mentionToken(text, selection.start, selection.end) : null;
  const open = token !== null;
  const query = open ? token.query.trim() : '';
  const context = `${deviceId}\u0000${sessionId}`;
  const key = `${context}\u0000${query}`;
  const [found, setFound] = useState<Found>({ key: '', rows: [], error: '' });
  const [attempt, setAttempt] = useState(0);
  // Keyed by task and query, so a different task never sees this one's results.
  const cache = useRef(mentionCache());

  useEffect(() => {
    if (!open || !query) return;
    const hit = cache.current.get(key, Date.now());
    if (hit) return void setFound({ key, rows: hit, error: '' });
    let live = true;
    const timer = setTimeout(() => {
      searchFiles(deviceId, { sessionId }, query).then(
        entries => {
          if (!live) return;
          const rows = mentionRows(entries);
          cache.current = cache.current.set(key, rows, Date.now());
          setFound({ key, rows, error: '' });
        },
        (error: Error) => { if (live) setFound({ key, rows: [], error: error.message }); },
      );
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [open, query, key, deviceId, sessionId, attempt]);

  const current = found.key === key;
  return {
    open,
    token,
    /** files.search needs at least one character: an empty `@` asks for one. */
    empty: open && !query,
    rows: open && current ? found.rows : [],
    loading: open && !!query && !current,
    error: open && current ? found.error : '',
    retry: () => { cache.current = mentionCache(); setFound({ key: '', rows: [], error: '' }); setAttempt(a => a + 1); },
  };
}

function EntryRow({ entry, onPick }: { entry: MentionEntry; onPick: (entry: MentionEntry) => void }) {
  const colors = useColors();
  const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  return (
    <PressScale onPress={() => onPick(entry)} accessibilityRole="button" accessibilityLabel={`${entry.dir ? 'Folder' : 'File'} ${entry.path}`} accessibilityHint="Mentions it in your message" style={styles.row}>
      <Icon ios={entry.dir ? 'folder' : 'doc'} android={entry.dir ? 'folder' : 'description'} size={15} color={colors.muted} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[textStyle.subhead, styles.name, { color: colors.text }]}>{entry.dir ? `${entry.name}/` : entry.name}</Text>
        {!!folder && <Text numberOfLines={1} ellipsizeMode="head" style={[textStyle.footnote, { color: colors.muted }]}>{folder}</Text>}
      </View>
    </PressScale>
  );
}

function Note({ text, onPress }: { text: string; onPress?: () => void }) {
  const colors = useColors();
  const body = <Text numberOfLines={2} style={[textStyle.footnote, styles.note, { color: colors.muted }]}>{text}</Text>;
  return onPress ? <PressScale onPress={onPress} accessibilityRole="button" accessibilityHint="Tries again">{body}</PressScale> : body;
}

export function MentionMenu({ rows, loading, empty, error, onPick, onRetry }: { rows: readonly MentionEntry[]; loading: boolean; empty: boolean; error: string; onPick: (entry: MentionEntry) => void; onRetry: () => void }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const maxHeight = Math.min(MAX_HEIGHT, Math.round(height * MAX_SHARE));
  return (
    <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={[styles.menu, { maxHeight, borderColor: colors.border, backgroundColor: colors.cardInner }]}
      accessibilityLabel="Project files">
      {empty ? (
        <Note text="Type to search this task’s files" />
      ) : loading && !rows.length ? (
        <View style={styles.loading}><Skeleton width="45%" /><Skeleton width="70%" /></View>
      ) : error ? (
        <Note text={`Couldn’t search files: ${error} Tap to retry.`} onPress={onRetry} />
      ) : !rows.length ? (
        <Note text="No matching files in this project." />
      ) : (
        <ScrollView keyboardShouldPersistTaps="always" keyboardDismissMode="none" nestedScrollEnabled contentContainerStyle={styles.list}>
          {rows.map(entry => <EntryRow key={entry.path} entry={entry} onPick={onPick} />)}
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  menu: { borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, marginBottom: 6, overflow: 'hidden' },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 7 },
  text: { flex: 1, gap: 1 },
  name: { fontWeight: '600' },
  loading: { padding: 12, gap: 8 },
  note: { padding: 12 },
});
