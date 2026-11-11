// Find in a thread: the query comes from the task screen's native header search field (a native
// item, so the iPhone Duo's rail keeps it); this holds the matches (pure matcher in src/store/find.ts),
// the bar above the composer that steps between them and asks for older pages, and the mark the
// transcript draws on matching rows. The transcript scrolls to the current match (transcript.tsx).
// A search hit opened with a `message` (useMessageJump) uses the same scroll and mark, briefly.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { connect } from '../connect/client.ts';
import { findHits, hitLabel, jumpStep, keepHit, stepHit, type FindHit } from '../store/find.ts';
import { taskKey, useConnect, useHistory, useLoaded, useMessages, useOlder } from '../store/index.ts';
import { turnRows } from '../store/turns.ts';
import { alpha, crossFadeIn, crossFadeOut, geometry, haptic, PressScale, type as textStyle } from './ds/index.ts';
import { Glass } from './Glass.tsx';
import { Icon } from './Icon.tsx';
import { useColors } from './theme.ts';

/** What the transcript marks: every matching row lightly, the current one clearly. */
export interface FindMarks { current?: string; hits: ReadonlySet<string> }
const NO_MARKS: FindMarks = { hits: new Set() };
export const FindContext = createContext<FindMarks>(NO_MARKS);

/** One transcript row, outlined when it's the current match and tinted when it's any match. The wrapper
 * stays put either way, so marking a row never remounts it, and the mark fades in and out. */
export function FindMark({ id, children }: { id: string; children: ReactNode }) {
  const marks = useContext(FindContext);
  const colors = useColors();
  const hit = marks.hits.has(id);
  const current = marks.current === id;
  return (
    <View>
      {children}
      {hit && <Animated.View entering={crossFadeIn} exiting={crossFadeOut} pointerEvents="none" style={[styles.mark, { borderColor: current ? colors.warning : 'transparent', backgroundColor: alpha(colors.warning, current ? 0.12 : 0.06) }]} />}
    </View>
  );
}

/** How long a jumped-to message stays marked. */
export const JUMP_HIGHLIGHT_MS = 1800;

/** Opens a thread at message `messageId` (a search hit): once its row is loaded (asking for a bounded number
 * of older pages after the thread's copy settles), marks it as the current find match, which the
 * transcript scrolls to, then lets the mark fade. Nothing without an id. */
export function useMessageJump(deviceId: string, sessionId: string, messageId: number | undefined): FindMarks {
  const messages = useMessages(deviceId, sessionId);
  const loaded = useLoaded(deviceId, sessionId);
  const history = useHistory(deviceId, sessionId);
  const older = useOlder(deviceId, sessionId);
  const target = `${taskKey(deviceId, sessionId)}#${messageId ?? ''}`;
  // One jump per target: older pages seen starting while it looked (`seen`: the last older state),
  // the row it marks, and how it ended.
  type Jump = { target: string; seen: typeof older; pages: number; rowId?: string; outcome?: 'shown' | 'missing' };
  const [jump, setJump] = useState<Jump>({ target, seen: older, pages: 0 });
  let next: Jump = jump.target === target ? jump : { target, seen: older, pages: 0 };
  const searching = messageId !== undefined && !next.outcome;
  if (next.seen !== older) next = { ...next, seen: older, pages: next.pages + (searching && older === 'loading' ? 1 : 0) };
  const rows = useMemo(() => (searching ? turnRows(messages) : []), [searching, messages]);
  const step = searching ? jumpStep(messageId, { rows, oldest: messages[0]?.id, ready: loaded && history !== null, older, pages: next.pages }) : undefined;
  if (step?.kind === 'show') next = { ...next, rowId: step.rowId, outcome: 'shown' };
  else if (step?.kind === 'missing') next = { ...next, outcome: 'missing' };
  if (next !== jump) setJump(next);

  const wantsOlder = step?.kind === 'older';
  useEffect(() => {
    // The live store, not this render's: the screen's own copy may have started since.
    if (wantsOlder && useConnect.getState().history[taskKey(deviceId, sessionId)] !== null) void connect.loadOlder(deviceId, sessionId);
  }, [wantsOlder, deviceId, sessionId, next.pages]);

  const outcome = next.outcome;
  useEffect(() => {
    if (outcome) AccessibilityInfo.announceForAccessibility(outcome === 'shown' ? 'Showing the matching message' : 'The matching message could not be shown');
  }, [outcome, target]);

  // The mark lasts a moment, then fades.
  const shown = next.rowId;
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setJump(previous => (previous.target === target ? { ...previous, rowId: undefined } : previous)), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [shown, target]);

  return useMemo<FindMarks>(() => (shown ? { current: shown, hits: new Set([shown]) } : NO_MARKS), [shown]);
}

/** Matches for `query` in the loaded messages and the current one (the newest at first). */
export function useThreadFind(deviceId: string, sessionId: string, query: string) {
  const messages = useMessages(deviceId, sessionId);
  const active = query.trim().length > 0;
  const rows = useMemo(() => (active ? turnRows(messages) : []), [active, messages]);
  const hits: FindHit[] = useMemo(() => findHits(rows, query), [rows, query]);
  // The current row by id, so an older page or a new message keeps it; a new query starts over.
  const [picked, setPicked] = useState<{ query: string; id?: string }>({ query });
  const id = picked.query === query ? picked.id : undefined;
  const index = keepHit(id, hits);
  const current = index >= 0 ? hits[index]?.rowId : undefined;
  const marks = useMemo<FindMarks>(() => (active ? { current, hits: new Set(hits.map(h => h.rowId)) } : NO_MARKS), [active, current, hits]);
  const older = useOlder(deviceId, sessionId);
  const step = (direction: -1 | 1) => {
    // Past the oldest loaded match, an older page may hold more.
    if (direction < 0 && index <= 0 && older === 'more') {
      void connect.loadOlder(deviceId, sessionId);
      AccessibilityInfo.announceForAccessibility('Loading older messages');
      return;
    }
    const next = stepHit(index, hits.length, direction);
    if (next < 0) return;
    haptic('selection');
    setPicked({ query, id: hits[next].rowId });
    AccessibilityInfo.announceForAccessibility(hitLabel(next, hits, query));
  };
  const loadOlder = () => void connect.loadOlder(deviceId, sessionId);
  return { active, hits, index, current, marks, step, older, loadOlder, label: hitLabel(index, hits, query) };
}

/** Above the composer while finding: "3 of 7", older and newer, and a way to search further back. */
export function FindBar({ find }: { find: ReturnType<typeof useThreadFind> }) {
  const colors = useColors();
  if (!find.active || !find.label) return null;
  const none = !find.hits.length;
  const canOlder = find.older === 'more';
  const loading = find.older === 'loading';
  return (
    <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={styles.frame}>
      <Glass style={styles.bar} accessible={false}>
        <Icon ios="magnifyingglass" android="search" size={14} color={colors.muted} />
        <Text style={[textStyle.subheadMedium, styles.label, { color: none ? colors.muted : colors.text }]} accessibilityLiveRegion="polite" numberOfLines={1}>
          {none && canOlder ? 'No matches loaded' : find.label}
        </Text>
        {loading && <ActivityIndicator size="small" accessibilityLabel="Loading older messages" />}
        {none && canOlder && !loading && (
          <PressScale onPress={find.loadOlder} accessibilityLabel="Search older messages" hitSlop={6} style={styles.textButton}>
            <Text style={[textStyle.subheadMedium, { color: colors.tint }]}>Search older</Text>
          </PressScale>
        )}
        {!none && (
          <>
            <PressScale onPress={() => find.step(-1)} accessibilityLabel={find.index <= 0 && canOlder ? 'Search older messages' : 'Older match'} hitSlop={6} style={styles.arrow}>
              <Icon ios="chevron.up" android="keyboard_arrow_up" size={16} color={colors.text} />
            </PressScale>
            <PressScale onPress={() => find.step(1)} accessibilityLabel="Newer match" hitSlop={6} style={styles.arrow}>
              <Icon ios="chevron.down" android="keyboard_arrow_down" size={16} color={colors.text} />
            </PressScale>
          </>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { flexDirection: 'row', justifyContent: 'center', paddingBottom: geometry.sectionGap, paddingHorizontal: geometry.screenMargin },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, borderRadius: 20, paddingLeft: 14, paddingRight: 4, borderCurve: 'continuous' },
  label: { fontVariant: ['tabular-nums'], flexShrink: 1 },
  arrow: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  textButton: { paddingHorizontal: 10, minHeight: 36, justifyContent: 'center' },
  mark: { position: 'absolute', top: -4, bottom: -4, left: -6, right: -6, borderRadius: geometry.innerRadius, borderWidth: 1.5, borderCurve: 'continuous' },
});
