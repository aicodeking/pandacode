// A task's progress snapshots (?device=&session=; without a task, pick one): the screenshots and
// ideas its agent posted, newest first, as a grid that fits the pane (two columns on a phone, more
// in a wide Duo pane). Tap one for the full image with its title and note.
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useHostSupports } from '../connect/api/capabilities.ts';
import { progressImage, progressList, type Snapshot } from '../connect/api/tools.ts';
import { outdated } from '../connect/rpc.ts';
import { EmptyState, geometry, InnerCard, PressScale, type } from '../ui/ds/index.ts';
import { Failed, glyph, Loading, styles as hub, TaskPicker, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { ImageModal } from '../ui/hub/ImageModal.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { ago } from '../ui/status.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const PROGRESS_ICON = glyph({ ios: 'photo.on.rectangle', android: 'photo_library' });
/** The narrowest tile: two fit on the smallest phone, more on wider panes. */
const MIN_TILE = 150;

function Tile({ device, session, snapshot, width, onOpen }: { device: string; session: string; snapshot: Snapshot; width: number; onOpen: (s: Snapshot) => void }) {
  const colors = useColors();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    progressImage(device, session, snapshot.id, false).then(u => { if (live) setUri(u); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [device, session, snapshot.id]);
  const label = [`Iteration ${snapshot.iteration}`, snapshot.title, ago(snapshot.createdAt)].join(', ');
  return (
    <PressScale onPress={() => onOpen(snapshot)} style={{ width }} accessibilityRole="imagebutton" accessibilityLabel={label} accessibilityHint="Opens the full image">
      <InnerCard style={styles.tile}>
        <View style={[styles.thumb, { backgroundColor: colors.fill }]}>
          {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : failed ? <Text style={[type.footnote, { color: colors.faint }]}>No image</Text> : <ActivityIndicator />}
        </View>
        <Text numberOfLines={2} style={[type.subhead, styles.title, { color: colors.text }]}>{snapshot.title}</Text>
        <Text numberOfLines={1} style={[type.footnote, styles.meta, { color: colors.muted }]}>{`#${snapshot.iteration} · ${ago(snapshot.createdAt)}`}</Text>
      </InnerCard>
    </PressScale>
  );
}

export default function ProgressScreen() {
  const params = useLocalSearchParams<{ device: string; session?: string; project?: string }>();
  const device = params.device ?? '';
  const scroll = usePushedScroll();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'progress.list');
  const [session, setSession] = useState(params.session || '');
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<{ snapshot: Snapshot; uri: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => progressList(device, session), [device, session]);
  const { value, error, reload } = useLoad(supported && session ? load : null, `${device}/${session}`);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };
  const show = (snapshot: Snapshot) => {
    setOpen({ snapshot, uri: null });
    progressImage(device, session, snapshot.id, true).then(uri => setOpen(o => (o?.snapshot.id === snapshot.id ? { snapshot, uri } : o)), () => setOpen(null));
  };
  const columns = Math.max(2, Math.floor((width + geometry.sectionGap) / (MIN_TILE + geometry.sectionGap)));
  const tile = width ? (width - geometry.sectionGap * (columns - 1)) / columns : 0;

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={session ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Progress' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={PROGRESS_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!session) return page(<TaskPicker device={device} projectId={params.project || undefined} onPick={setSession} purpose="Show the progress of" />);
  if (!value) return page(error ? <Failed title="Couldn’t load the snapshots" error={error} retry={() => void reload()} /> : <Loading rows={4} />);
  if (!value.snapshots.length) return page(<EmptyState icon={PROGRESS_ICON} title="No snapshots yet" body="Agents post screenshots here as they work on a visual change." style={hub.empty} />);
  return page(
    <>
      <View style={styles.grid} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {tile > 0 && value.snapshots.map(s => <Tile key={s.id} device={device} session={session} snapshot={s} width={tile} onOpen={show} />)}
      </View>
      {open && !open.uri && <ActivityIndicator />}
      <ImageModal uri={open?.uri ?? null} title={open?.snapshot.title} note={open?.snapshot.note} onClose={() => setOpen(null)} />
    </>,
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: geometry.sectionGap },
  tile: { padding: 6, gap: 4 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  title: { paddingHorizontal: 4 },
  meta: { paddingHorizontal: 4, paddingBottom: 2 },
});
