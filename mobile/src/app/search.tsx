// Search a checkout (?device=&project= or &session=): the bar's native search field, File names
// (files.search, as you type) or Text (files.grep, on Search or after a pause). A name opens the
// file or folder; a text hit opens file.tsx at its line.
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { grepFiles, searchFiles, type FileEntry, type GrepResult } from '../connect/api/files.ts';
import { outdated } from '../connect/rpc.ts';
import { fileIcon, fileName, highlight, matchCount, parentOf, type GrepMatch } from '../store/files.ts';
import { EmptyState, geometry, PressScale, Row, Segmented, type } from '../ui/ds/index.ts';
import { CardTitled, Failed, glyph, Loading, ProjectPicker, styles as hub, useComputerName } from '../ui/hub/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { CardSlice, PUSHED_HEADER, PushedList, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { mono, useColors } from '../ui/theme.ts';
import { useIconSize } from '../ui/usePagePadding.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { fileSearchPhase, moreLabel, rerunQuery, searchPending, textMinTitle, type FileSearchMode } from '../ui/file-search.ts';
import { useReloadOnReconnect } from '../ui/useReloadOnReconnect.ts';

type Mode = FileSearchMode;
const MODES = [{ value: 'names', label: 'File names' }, { value: 'text', label: 'Text' }] as const;
const SEARCH_ICON = glyph({ ios: 'magnifyingglass', android: 'search' });
const NAME_DELAY_MS = 200;
const TEXT_DELAY_MS = 600;
/** Match lines shown per file before "N more". */
const LINES_PER_FILE = 5;

type Result =
  | { mode: 'names'; query: string; entries: FileEntry[] }
  | { mode: 'text'; query: string; result: GrepResult };

function MatchLine({ match, onPress }: { match: GrepMatch; onPress: () => void }) {
  const colors = useColors();
  const parts = highlight(match.text.trim() ? match.text : ' ', match.ranges);
  return (
    <PressScale onPress={onPress} style={styles.match} accessibilityLabel={`Line ${match.line}: ${match.text.trim()}`}>
      <Text style={[styles.lineNo, { color: colors.faint }]}>{match.line}</Text>
      <Text numberOfLines={2} style={[styles.matchText, { color: colors.muted }]}>
        {parts.map((part, i) => (part.hit ? <Text key={i} style={{ color: colors.text, backgroundColor: colors.warningFill }}>{part.text}</Text> : part.text))}
      </Text>
    </PressScale>
  );
}

export default function SearchScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string }>();
  const device = params.device ?? '';
  const session = params.session || undefined;
  const scroll = usePushedScroll();
  const colors = useColors();
  const size = useIconSize(20);
  const computer = useComputerName(device);
  const names = useHostSupports(device, 'files.search');
  const text = useHostSupports(device, 'files.grep');
  const [project, setProject] = useState(params.project || undefined);
  const [mode, setMode] = useState<Mode>('names');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(0);
  const base = { device, ...(project ? { project } : {}), ...(session ? { session } : {}) };

  const run = async (q: string, m: Mode) => {
    const clean = q.trim();
    const ticket = ++asked.current;
    if (!clean || (!project && !session)) { setResult(null); setBusy(false); return; }
    setBusy(true);
    try {
      const target = { projectId: project, sessionId: session };
      const next: Result = m === 'names'
        ? { mode: m, query: clean, entries: await searchFiles(device, target, clean) }
        : { mode: m, query: clean, result: await grepFiles(device, target, q) };
      if (ticket === asked.current) { setResult(next); setError(''); }
    } catch (e) {
      if (ticket === asked.current) setError((e as Error).message);
    } finally {
      if (ticket === asked.current) setBusy(false);
    }
  };
  // Names as you type; text once the typing pauses (a text search walks the whole checkout).
  const phase = fileSearchPhase(mode, query);
  // A Text query under TEXT_MIN never runs: typing below it drops older results and any search still answering.
  const changeQuery = (next: string) => {
    setQuery(next);
    if (fileSearchPhase(mode, next) !== 'short') return;
    asked.current += 1;
    setResult(null);
    setBusy(false);
    setError('');
  };
  useEffect(() => {
    if (phase === 'short') return;
    const timer = setTimeout(() => void run(query, mode), mode === 'names' ? NAME_DELAY_MS : TEXT_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, project]);
  // Back online: the current query again, so a search that failed or went stale while away refreshes.
  useReloadOnReconnect(device, () => {
    const again = rerunQuery(mode, query);
    if (again !== null) void run(again, mode);
  });

  const openFile = (path: string, line?: number) => router.push({ pathname: '/file', params: { ...base, path, ...(line ? { line: String(line) } : {}) } });
  const header = (<>
    <Stack.Screen options={{
      ...PUSHED_HEADER, title: 'Search',
      headerSearchBarOptions: project || session ? {
        placeholder: mode === 'names' ? 'Find a file' : 'Find text in files', autoCapitalize: 'none', autoFocus: true, hideWhenScrolling: false,
        onChangeText: event => changeQuery(event.nativeEvent.text),
        onSearchButtonPress: event => { if (fileSearchPhase(mode, event.nativeEvent.text) === 'search') void run(event.nativeEvent.text, mode); },
        onCancelButtonPress: () => { setQuery(''); setResult(null); },
      } : undefined,
    }} />
    <HeaderActions />
  </>);
  const page = (children: React.ReactNode) => <PushedScroll scroll={scroll}>{header}{children}</PushedScroll>;

  if (!names) return page(<EmptyState icon={SEARCH_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project && !session) return page(<ProjectPicker device={device} onPick={setProject} purpose={`Search a project on ${computer}`} />);

  const modes = text ? <Segmented options={MODES} value={mode} onChange={m => { asked.current += 1; setMode(m); setResult(null); setBusy(false); setError(''); }} accessibilityLabel="Search by" /> : null;
  // Older results stay while a new search answers, under a line that says so.
  const searching = phase === 'search' && result && searchPending(result, query, busy)
    ? <Text style={[type.footnote, styles.summary, { color: colors.muted }]} accessibilityLiveRegion="polite">Searching…</Text>
    : null;
  const top = <>{header}{modes}{searching}</>;
  const state = (children: React.ReactNode) => page(<>{modes}{searching}{children}</>);

  if (error) return state(<Failed title="Couldn’t search" error={error} retry={() => void run(query, mode)} />);
  if (phase === 'short') return state(<EmptyState icon={SEARCH_ICON} title={textMinTitle} body="Text search looks through every file, so it needs a few characters." style={hub.empty} />);
  if (phase === 'empty') return state(<EmptyState icon={SEARCH_ICON} title={mode === 'names' ? 'Find a file by name' : 'Find text in every file'} body={mode === 'text' ? 'Results show the matching lines; tap one to open the file there.' : undefined} style={hub.empty} />);
  if (!result || result.mode !== mode || (busy && !result)) return state(<Loading rows={5} />);
  // Results run to hundreds of rows: lists mount only those on screen.
  if (result.mode === 'names') {
    const entries = result.entries;
    if (!entries.length) return state(<EmptyState icon={SEARCH_ICON} title={`No files match “${result.query}”`} style={hub.empty} />);
    return (
      <PushedList scroll={scroll} data={entries} keyExtractor={entry => entry.path} header={top}
        renderItem={({ item: entry, index }) => (
          <CardSlice first={index === 0} last={index === entries.length - 1}>
            <Row title={entry.name || fileName(entry.path)} subtitle={parentOf(entry.path) || undefined} chevron={entry.dir}
              leading={<Icon {...glyph(fileIcon(entry.name, entry.dir))} size={size} color={entry.dir ? colors.info : colors.muted} />}
              onPress={() => (entry.dir ? router.push({ pathname: '/files', params: { ...base, path: entry.path } }) : openFile(entry.path))} />
          </CardSlice>
        )} />
    );
  }
  const files = result.result.files;
  if (!files.length) return state(<EmptyState icon={SEARCH_ICON} title={`No text matches “${result.query}”`} style={hub.empty} />);
  const total = matchCount(files);
  const moreFooter = (label: string | null, onPress: () => void) => (label === null ? undefined : (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={MORE_HIT_SLOP}>
      <Text style={[type.footnote, { color: colors.muted }]}>{label}</Text>
    </PressScale>
  ));
  const summary = (
    <Text style={[type.footnote, styles.summary, { color: colors.muted }]}>
      {`${total} ${total === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}${result.result.truncated ? ' (first results only)' : ''}`}
    </Text>
  );
  return (
    <PushedList scroll={scroll} data={files} keyExtractor={file => file.path} header={<>{top}{summary}</>} gap
      renderItem={({ item: file }) => (
        <CardTitled title={file.path} trailing={<Text style={[type.footnote, { color: colors.faint }]}>{file.matches.length}</Text>}
          footer={moreFooter(moreLabel(file.matches.length, LINES_PER_FILE), () => openFile(file.path, file.matches[LINES_PER_FILE].line))}>
          {file.matches.slice(0, LINES_PER_FILE).map(match => <MatchLine key={match.line} match={match} onPress={() => openFile(file.path, match.line)} />)}
        </CardTitled>
      )} />
  );
}

/** A match row's vertical padding: a compact line under the row inset. */
const MATCH_PAD = 8;
/** The "N more" link is one footnote line: reach past it to a comfortable target. */
const MORE_HIT_SLOP = 12;

const styles = StyleSheet.create({
  summary: { paddingHorizontal: geometry.rowInset },
  match: { flexDirection: 'row', gap: geometry.sectionGap, paddingHorizontal: geometry.rowInset, paddingVertical: MATCH_PAD },
  lineNo: { fontFamily: mono, fontSize: 12, minWidth: 28, textAlign: 'right', paddingTop: 1 },
  matchText: { flex: 1, fontFamily: mono, fontSize: 13 },
});

