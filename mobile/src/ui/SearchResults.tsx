// The inbox search's "In conversations" card: tasks whose conversation text mentions the query, from
// every online computer that serves `search.threads` (src/connect/api/search.ts), under the title
// matches. Debounced; each computer's hits arrive on their own, and title matches aren't repeated.
// Tapping a hit opens its task at the matching message (the task screen's `message` param).
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCapabilities } from '../connect/api/capabilities.ts';
import { supports } from '../connect/api/hello.ts';
import { searchQuery, searchThreads, withoutShown, matchParts, type ThreadHit } from '../connect/api/search.ts';
import { useHosts } from '../store/index.ts';
import { geometry, PressScale, type } from './ds/index.ts';
import { CardSlice, ROW_PRESS_DELAY_MS, SectionHead } from './InboxCard.tsx';
import { ago } from './status.tsx';
import type { SidebarOpen } from './sidebar-nav.ts';
import { openFromSidebar } from './sidebar-open.ts';
import { useColors } from './theme.ts';

/** How long typing must pause before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 350;
const SNIPPET_LINES = 3;

export interface ConversationHit { key: string; deviceId: string; computer: string; hit: ThreadHit }

/**
 * Conversation hits for `query` (none below three characters), from every online computer serving
 * search.threads, or only `computer`. `shown`: `device/session` keys the title matches already list.
 */
export function useThreadSearch(query: string, computer: string | undefined, shown: ReadonlySet<string>): { hits: ConversationHit[]; searching: boolean } {
  const hosts = useHosts();
  const caps = useCapabilities();
  const clean = searchQuery(query);
  const targets = useMemo(
    () => hosts.filter(h => h.online && (!computer || h.id === computer) && supports(caps[h.id], 'search.threads') !== false).map(h => ({ id: h.id, name: h.name })),
    [hosts, caps, computer],
  );
  const targetKey = targets.map(t => t.id).join(',');
  const key = `${clean ?? ''}|${targetKey}`;
  // `key`: the query and computers these hits answer; `done`: how many of those computers answered.
  const [found, setFound] = useState<{ key: string; query: string; hits: ConversationHit[]; done: number }>({ key: '', query: '', hits: [], done: 0 });
  const generation = useRef(0);

  useEffect(() => {
    const run = ++generation.current;
    if (!clean || !targets.length) return;
    const ids = new Set(targets.map(t => t.id));
    const timer = setTimeout(() => {
      for (const target of targets) {
        searchThreads(target.id, clean)
          .then(reply => reply.results.map(hit => ({ key: `${target.id}/${hit.sessionId}`, deviceId: target.id, computer: target.name, hit })))
          // A computer that fails (offline, outdated, refused) just adds nothing: the title matches still show.
          .catch(() => [] as ConversationHit[])
          .then(hits => {
            if (generation.current !== run) return;
            setFound(previous => {
              // The first answer for a new key keeps the same query's other hits until their computers answer.
              const base = previous.key === key ? previous : { key, query: clean, hits: previous.query === clean ? previous.hits.filter(h => ids.has(h.deviceId)) : [], done: 0 };
              const merged = [...base.hits.filter(h => h.deviceId !== target.id), ...hits].sort((a, b) => b.hit.at - a.hit.at);
              return { ...base, hits: merged, done: base.done + 1 };
            });
          });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // key stands for clean and targets: a new array with the same computers needn't search again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const active = !!clean && targets.length > 0;
  const hits = useMemo(() => (active && found.query === clean ? withoutShown(found.hits, shown) : []), [active, found, clean, shown]);
  return { hits, searching: active && (found.key !== key || found.done < targets.length) };
}

/** Opens the hit's task at its message; from the Duo's sidebar as its rows do (`how`), else a push. */
const open = (hit: ConversationHit, how: SidebarOpen | undefined) => {
  const href = { pathname: '/task/[device]/[session]', params: { device: hit.deviceId, session: hit.hit.sessionId, message: String(hit.hit.messageId) } } as const;
  openFromSidebar(href, how);
};

function HitRow({ item, query, showComputer, how }: { item: ConversationHit; query: string; showComputer: boolean; how?: SidebarOpen }) {
  const colors = useColors();
  const { hit } = item;
  const title = hit.title || 'Untitled task';
  const meta = [hit.projectName, showComputer ? item.computer : undefined, hit.at ? ago(hit.at) : undefined].filter(Boolean).join(' · ');
  return (
    <PressScale scale={1} unstable_pressDelay={ROW_PRESS_DELAY_MS} onPress={() => open(item, how)} accessibilityRole="button" accessibilityHint="Opens the task at this message"
      accessibilityLabel={[title, hit.snippet, meta].filter(Boolean).join(', ')} style={styles.row}>
      <Text numberOfLines={2} style={[type.calloutMedium, { color: colors.text }]}>{title}</Text>
      <Text numberOfLines={SNIPPET_LINES} style={[type.footnote, { color: colors.muted }]}>
        {matchParts(hit.snippet, query).map((part, index) => (
          <Text key={index} style={part.hit ? [type.footnoteMedium, { color: colors.text }] : undefined}>{part.text}</Text>
        ))}
      </Text>
      {!!meta && <Text numberOfLines={1} style={[type.caption, { color: colors.faint }]}>{meta}</Text>}
    </PressScale>
  );
}

/** The card under the title matches; nothing when there are no hits. `how`: the Duo sidebar's decision
 * (sidebar-nav.ts); left out (the inbox) a hit pushes. */
export function SearchResults({ hits, query, searching, how }: { hits: readonly ConversationHit[]; query: string; searching: boolean; how?: SidebarOpen }) {
  const colors = useColors();
  if (!hits.length) {
    return searching ? <Text style={[type.footnote, styles.note, { color: colors.faint }]} accessibilityLiveRegion="polite">Searching conversations…</Text> : null;
  }
  const computers = new Set(hits.map(h => h.deviceId));
  const showComputer = computers.size > 1;
  return (
    <View style={styles.card}>
      <SectionHead section="conversations" count={hits.length} computer={showComputer ? undefined : hits[0].computer} />
      {hits.map((item, index) => (
        <CardSlice key={item.key} first={index === 0} last={index === hits.length - 1}>
          <HitRow item={item} query={query} showComputer={showComputer} how={how} />
        </CardSlice>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: geometry.sectionGap },
  row: { paddingHorizontal: geometry.rowInset, paddingVertical: geometry.sectionGap, gap: 3 },
  note: { marginTop: geometry.sectionGap, textAlign: 'center' },
});
