// A project's moodboards (?device=&project=, or &session=): each board's reference images as a grid
// that fits the pane (two columns on a phone, more when wider). Tap one for the full image with its
// caption. Boards are made on the computer; Add photo (camera or library) uploads one with image.put
// and adds it to that board with moodboards.add (Full access and the Full access switch).
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { capabilitiesOf, useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import type { FileTarget } from '../connect/api/files.ts';
import { addMoodboardImage, moodboardImage, moodboardsList, type Moodboard, type MoodboardImage } from '../connect/api/settings.ts';
import { outdated } from '../connect/rpc.ts';
import { attachLimits, imageKind, imageName, imageRefusal } from '../store/attach.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { uploadAttached } from '../ui/ComposerAttach.tsx';
import { Button, EmptyState, geometry, haptic, InnerCard, PressScale, showToast, type } from '../ui/ds/index.ts';
import { showActions } from '../ui/Menu.tsx';
import { CardTitled, Failed, glyph, Loading, ProjectPicker, styles as hub, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { ImageModal } from '../ui/hub/ImageModal.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { HeaderActions } from '../ui/HeaderActions.tsx';

const BOARD_ICON = glyph({ ios: 'square.grid.2x2', android: 'dashboard' });
/** The narrowest tile: two fit on the smallest phone, more on wider panes. */
const MIN_TILE = 140;

/** As the composer's photos (ComposerAttach.tsx). */
const PHOTO_QUALITY = 0.8;
const ADD_METHODS = ['moodboards.add', 'image.put'] as const;

/** Camera or library, then the photo's bytes checked against the host's image limits; null when cancelled or refused (said why). */
async function pickPhoto(camera: boolean, device: string): Promise<ImagePicker.ImagePickerAsset | null> {
  try {
    if (camera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        // Once refused, iOS and Android stop asking: Settings is the only way back.
        Alert.alert('Camera access is off', 'Allow PandaCode to use the camera in Settings to take a photo here.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings().catch(() => undefined) },
        ]);
        return null;
      }
    }
    const options = { mediaTypes: 'images', quality: PHOTO_QUALITY, base64: true } as const;
    const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    const caps = capabilitiesOf(device);
    const refusal = imageRefusal([], asset.base64 ?? '', attachLimits(caps?.kind === 'hello' ? caps.limits : undefined));
    if (refusal) { Alert.alert('Can’t add this image', refusal); return null; }
    return asset;
  } catch (error) {
    Alert.alert(camera ? 'Couldn’t open the camera' : 'Couldn’t open your photos', (error as Error).message);
    return null;
  }
}

/** Add photo for one board: picks, uploads with image.put, adds it with moodboards.add, then `done` (a reload). */
function AddPhoto({ device, board, done }: { device: string; board: Moodboard; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const add = async (camera: boolean) => {
    const asset = await pickPhoto(camera, device);
    if (!asset) return;
    setBusy(true);
    try {
      const name = imageName(asset.fileName, imageKind(asset.base64 ?? '') ?? 'jpeg', board.images.length);
      const [imageId] = await uploadAttached(device, [{ uri: asset.uri, name, base64: asset.base64 ?? undefined }]);
      if (!imageId) throw new Error('The computer sent no image.');
      await addMoodboardImage(device, board.projectId, board.id, imageId, name);
      haptic('success');
      showToast({ title: 'Photo added', body: board.name });
      await done();
    } catch (error) {
      haptic('error');
      Alert.alert('Couldn’t add the photo', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = () => showActions('Add photo', [
    { label: 'Take photo', ios: 'camera', android: 'photo_camera', onPress: () => void add(true) },
    { label: 'Choose from library', ios: 'photo.on.rectangle', android: 'photo_library', onPress: () => void add(false) },
  ]);
  return <Button label="Add photo" size="small" icon={{ ios: 'plus', android: 'add' }} loading={busy} onPress={choose} style={styles.add} />;
}

interface Picked { board: Moodboard; image: MoodboardImage; uri: string | null }

function Tile({ device, target, board, image, width, onOpen }: { device: string; target: FileTarget; board: Moodboard; image: MoodboardImage; width: number; onOpen: (b: Moodboard, i: MoodboardImage) => void }) {
  const colors = useColors();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { projectId, sessionId } = target;
  useEffect(() => {
    let live = true;
    moodboardImage(device, { projectId, sessionId }, board.id, image.id, false).then(u => { if (live) setUri(u); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [device, projectId, sessionId, board.id, image.id]);
  const label = image.caption || image.name;
  return (
    <PressScale onPress={() => onOpen(board, image)} style={{ width }} accessibilityRole="imagebutton" accessibilityLabel={label} accessibilityHint="Opens the full image">
      <InnerCard style={styles.tile}>
        <View style={[styles.thumb, { backgroundColor: colors.fill }]}>
          {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : failed ? <Text style={[type.footnote, { color: colors.faint }]}>No image</Text> : <ActivityIndicator />}
        </View>
        {!!label && <Text numberOfLines={2} style={[type.footnote, styles.caption, { color: colors.muted }]}>{label}</Text>}
      </InnerCard>
    </PressScale>
  );
}

export default function MoodboardsScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string }>();
  const device = params.device ?? '';
  const session = params.session || undefined;
  const scroll = usePushedScroll();
  const colors = useColors();
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'moodboards.list');
  // Hidden on a host without moodboards.add; disabled with the access note when this phone's grant or the switch keeps it off.
  const servesAdd = useHostSupports(device, 'moodboards.add');
  const servesPut = useHostSupports(device, 'image.put');
  const allowsAdd = useHostAllows(device, 'moodboards.add');
  const allowsPut = useHostAllows(device, 'image.put');
  const canOffer = servesAdd && servesPut;
  const canAdd = allowsAdd && allowsPut;
  const [project, setProject] = useState(params.project || undefined);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<Picked | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const target: FileTarget = { projectId: project, sessionId: session };
  const load = useCallback(() => moodboardsList(device, { projectId: project, sessionId: session }), [device, project, session]);
  const { value, error, reload } = useLoad(supported && (project || session) ? load : null, `${device}/${project}/${session}`);
  const refresh = async () => { setRefreshing(true); await reload(); setRefreshing(false); };
  const show = (board: Moodboard, image: MoodboardImage) => {
    setOpen({ board, image, uri: null });
    moodboardImage(device, target, board.id, image.id, true)
      .then(uri => setOpen(o => (o?.image.id === image.id ? { board, image, uri } : o)), () => setOpen(null));
  };
  const columns = Math.max(2, Math.floor((width + geometry.sectionGap) / (MIN_TILE + geometry.sectionGap)));
  const tile = width ? (width - geometry.sectionGap * (columns - 1)) / columns : 0;

  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={project || session ? <RefreshControl refreshing={refreshing} onRefresh={refresh} /> : undefined}>
      <Stack.Screen options={{ ...PUSHED_HEADER, title: 'Moodboards' }} />
      <HeaderActions />
      {children}
    </PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={BOARD_ICON} title={outdated(computer)} style={hub.empty} />);
  if (!project && !session) return page(<ProjectPicker device={device} onPick={setProject} purpose={`Show the moodboards of a project on ${computer}`} />);
  if (!value) return page(error ? <Failed title="Couldn’t load the moodboards" error={error} retry={() => void reload()} /> : <Loading rows={4} />);
  if (!value.boards.length) return page(<EmptyState icon={BOARD_ICON} title="No moodboards yet" body="Make one on the computer to collect reference images for agents." style={hub.empty} />);
  return page(
    <>
      {canOffer && <AccessNote device={device} methods={ADD_METHODS} />}
      {value.boards.map(board => (
        <CardTitled key={board.id} title={board.name} trailing={<Text style={[type.footnote, { color: colors.faint }]}>{board.imageCount}</Text>}>
          {board.images.length ? (
            <View style={styles.grid} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - GRID_PAD * 2)}>
              {tile > 0 && board.images.map(image => <Tile key={image.id} device={device} target={target} board={board} image={image} width={Math.floor(tile)} onOpen={show} />)}
            </View>
          ) : <Text style={[type.footnote, styles.empty, { color: colors.muted }]}>No images on this board yet.</Text>}
          {canOffer && canAdd && <AddPhoto device={device} board={board} done={reload} />}
        </CardTitled>
      ))}
      {value.truncated && <Text style={[type.footnote, { color: colors.faint }]}>More boards are on the computer.</Text>}
      {open && !open.uri && <ActivityIndicator />}
      <ImageModal uri={open?.uri ?? null} title={open?.image.name} note={open?.image.caption || undefined} onClose={() => setOpen(null)} />
    </>,
  );
}

/** The grid's own padding inside its card. */
const GRID_PAD = 8;

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: geometry.sectionGap, padding: GRID_PAD },
  tile: { padding: 6, gap: 4 },
  thumb: { width: '100%', aspectRatio: 1, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  caption: { paddingHorizontal: 4, paddingBottom: 2 },
  empty: { padding: geometry.rowInset },
  add: { alignSelf: 'flex-start', margin: GRID_PAD },
});
