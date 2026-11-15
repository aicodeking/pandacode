// Attachments the composer adds: the tray's + menu (Photo library, Camera, Files), the pending chips
// above the input, and the send that carries them. Images go through the normal send path
// (store/local.ts sendOrQueue → client.ts sendMessage), which uploads them with `image.put` and
// sends task.send `imageIds`, or keeps their uris in the outbox; text documents travel inline as the desktop's Document context block
// (pure rules in src/store/attach.ts). Hidden when the host lacks image.put. The New task sheet and
// the Duo's New thread pane use the same menu and chips, and `uploadAttached` puts their images up
// before task.start / chat.start / team.start, which take the ids as `imageIds`.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { capabilitiesOf, useHostCapabilities, useHostSupports } from '../connect/api/capabilities.ts';
import { hostCall } from '../connect/client.ts';
import { uuid } from '../connect/crypto.ts';
import { maybeRan } from '../connect/rpc.ts';
import {
  attachLimits, composeText, uploadImages, documentPending, DOCUMENT_READ_MAX, imageKind, imageName, imageRefusal,
  looksLikeText, textRefusal, withoutPending, withPending, type Pending, type SendImage,
} from '../store/attach.ts';
import { crossFadeIn, crossFadeOut, geometry, haptic, PressScale, type as textStyle, useMotion } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { useColors } from './theme.ts';
import { TRAY_ICON_WIDTH } from './tray-fit.ts';

/** JPEG quality for picked photos: keeps a phone photo well under the host's 5 MB. */
const PHOTO_QUALITY = 0.8;
const THUMB = 44;

/** A send's text (typed words plus document blocks) and the images it carries, which upload with the send. */
export interface AttachSend { text: string; images: SendImage[] }

/** Uploads a new task's images (image.put in chunks) to `deviceId`: their ids, in order. */
export function uploadAttached(deviceId: string, images: readonly SendImage[]): Promise<string[]> {
  const caps = capabilitiesOf(deviceId);
  return uploadImages(images, {
    read: async uri => { const file = new File(uri); return file.exists ? file.base64() : null; },
    put: chunk => hostCall<{ imageId?: unknown }>(deviceId, 'image.put', chunk),
    uploadId: uuid,
    lost: maybeRan,
    imageChunk: attachLimits(caps?.kind === 'hello' ? caps.limits : undefined).imageChunk,
  });
}

/** The composer's pending attachments for one task, the + menu's items and the upload. */
export function useComposerAttach(deviceId: string, bot: boolean) {
  const caps = useHostCapabilities(deviceId);
  const limits = attachLimits(caps?.kind === 'hello' ? caps.limits : undefined);
  const supported = useHostSupports(deviceId, 'image.put');
  const [pending, setPending] = useState<Pending[]>([]);

  const addImages = (assets: ImagePicker.ImagePickerAsset[]) => {
    let list = pending;
    for (const [index, asset] of assets.entries()) {
      const base64 = asset.base64 ?? '';
      const refusal = imageRefusal(list, base64, limits);
      if (refusal) {
        Alert.alert('Can’t attach this image', refusal);
        break;
      }
      const kind = imageKind(base64) ?? 'jpeg';
      list = withPending(list, { kind: 'image', id: uuid(), name: imageName(asset.fileName, kind, list.length + index), uri: asset.uri, base64, bytes: asset.fileSize ?? 0, width: asset.width, height: asset.height });
    }
    if (list !== pending) haptic('selection');
    setPending(list);
  };
  const imagesLeft = limits.maxImages - pending.filter(p => p.kind === 'image').length;
  const pickPhotos = async () => {
    if (imagesLeft <= 0) return void Alert.alert('Can’t attach more images', `Attach up to ${limits.maxImages} images per message.`);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', allowsMultipleSelection: true, selectionLimit: imagesLeft, quality: PHOTO_QUALITY, base64: true });
      if (!result.canceled) addImages(result.assets);
    } catch (error) {
      Alert.alert('Couldn’t open your photos', (error as Error).message);
    }
  };
  const takePhoto = async () => {
    if (imagesLeft <= 0) return void Alert.alert('Can’t attach more images', `Attach up to ${limits.maxImages} images per message.`);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return void Alert.alert('Camera access is off', 'Allow PandaCode to use the camera in Settings to take a photo here.');
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: PHOTO_QUALITY, base64: true });
      if (!result.canceled) addImages(result.assets);
    } catch (error) {
      Alert.alert('Couldn’t open the camera', (error as Error).message);
    }
  };
  const pickFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      let list = pending;
      for (const asset of result.assets) {
        if (!looksLikeText(asset.name, asset.mimeType) || (asset.size ?? 0) > DOCUMENT_READ_MAX) {
          Alert.alert('Can’t attach this file', `${asset.name} isn't a text file. Only text documents can be sent from the phone; send images from Photo Library.`);
          continue;
        }
        const doc = documentPending(uuid(), asset.name, await new File(asset.uri).text());
        if (typeof doc === 'string') {
          Alert.alert('Can’t attach this file', doc);
          continue;
        }
        list = withPending(list, doc);
      }
      if (list !== pending) haptic('selection');
      setPending(list);
    } catch (error) {
      Alert.alert('Couldn’t read that file', (error as Error).message);
    }
  };

  const items: MenuItem[] = supported ? [
    ...(bot ? [] : [
      { label: 'Photo Library', ios: 'photo.on.rectangle' as const, android: 'photo_library' as const, onPress: () => void pickPhotos() },
      { label: 'Camera', ios: 'camera' as const, android: 'photo_camera' as const, onPress: () => void takePhoto() },
    ]),
    { label: 'Files', ios: 'folder' as const, android: 'folder' as const, onPress: () => void pickFiles() },
  ] : [];

  const remove = (id: string) => {
    haptic('selection');
    setPending(list => withoutPending(list, id));
  };

  /** The text and images for a send of `typed`; throws with a message the user can act on. Null with nothing to send. */
  const prepare = (typed: string): AttachSend | null => {
    const text = composeText(typed, pending);
    if (text === null) return null;
    const refusal = textRefusal(text, limits);
    if (refusal) throw new Error(refusal);
    const images = pending.flatMap(p => (p.kind === 'image' ? [{ uri: p.uri, name: p.name, base64: p.base64 }] : []));
    return { text, images };
  };

  return { pending, items, remove, prepare, clear: () => setPending([]), hasImages: pending.some(p => p.kind === 'image') };
}

/** The tray's + button: a native menu of where to attach from. */
export function AttachButton({ items, disabled }: { items: MenuItem[]; disabled?: boolean }) {
  const colors = useColors();
  if (!items.length) return null;
  return (
    <View style={[styles.button, disabled && styles.dim]} pointerEvents={disabled ? 'none' : 'auto'}>
      <Menu ios="plus" android="add" size={17} color={colors.muted} label="Attach" items={items}>
        {icon => <View style={styles.buttonFrame}>{icon}</View>}
      </Menu>
    </View>
  );
}

/** Pending attachments above the input, each with a remove button. */
export function AttachChips({ pending, onRemove, uploading }: { pending: Pending[]; onRemove: (id: string) => void; uploading: boolean }) {
  const colors = useColors();
  const { layout } = useMotion();
  if (!pending.length) return null;
  return (
    <Animated.View entering={crossFadeIn} exiting={crossFadeOut} style={[styles.chipsRow, uploading && styles.dim]} accessibilityLabel={uploading ? 'Uploading attachments' : undefined}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        {pending.map(item => (
          <Animated.View key={item.id} layout={layout} entering={crossFadeIn} exiting={crossFadeOut}
            style={[styles.chip, { backgroundColor: colors.fill, borderColor: colors.chipBorder }]}>
            {item.kind === 'image'
              ? <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" accessibilityIgnoresInvertColors />
              : <View style={[styles.thumb, styles.docThumb, { backgroundColor: colors.cardInner }]}><Icon ios="doc.text" android="description" size={18} color={colors.muted} /></View>}
            <View style={styles.chipText}>
              <Text numberOfLines={1} ellipsizeMode="middle" style={[textStyle.footnote, { color: colors.text }]}>{item.name}</Text>
              <Text numberOfLines={1} style={[textStyle.caption, { color: colors.muted }]}>{item.kind === 'image' ? 'Image' : item.truncated ? 'Text, first 32 KB' : 'Text'}</Text>
            </View>
            <PressScale onPress={() => onRemove(item.id)} disabled={uploading} accessibilityLabel={`Remove ${item.name}`} hitSlop={8} style={styles.remove}>
              <Icon ios="xmark.circle.fill" android="cancel" size={16} color={colors.muted} />
            </PressScale>
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: { width: TRAY_ICON_WIDTH, alignItems: 'center', justifyContent: 'center' },
  buttonFrame: { width: TRAY_ICON_WIDTH, height: TRAY_ICON_WIDTH, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.5 },
  chipsRow: { paddingBottom: 6 },
  chips: { gap: 6, paddingHorizontal: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 220, padding: 4, paddingRight: 6, borderRadius: geometry.innerRadius, borderWidth: geometry.hairline, borderCurve: 'continuous' },
  thumb: { width: THUMB, height: THUMB, borderRadius: geometry.innerRadius - 4, borderCurve: 'continuous' },
  docThumb: { alignItems: 'center', justifyContent: 'center' },
  chipText: { flexShrink: 1 },
  remove: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
});
