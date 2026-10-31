// Attachments in a thread: the image grid in user bubbles, document/folder chips that open their
// context text, and workspace images inside agent replies. Bytes come through connect.attachment
// (src/connect/attachments.ts); a tap opens the full-screen viewer (ImageViewer.tsx).
import { Image } from 'expo-image';
import { createContext, useContext, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { attachmentsUnsupported } from '../connect/attachments.ts';
import type { Attachment } from '../store/attachments.ts';
import { Icon } from './Icon.tsx';
import { openViewer } from './ImageViewer.tsx';
import { useAttachment, type ViewerImage } from './useAttachment.ts';
import { mono, useColors } from './theme.ts';

/** The thread a transcript row belongs to (set by Transcript). */
export const ThreadContext = createContext<{ deviceId: string; sessionId: string } | null>(null);

const GRID = 240;
const GAP = 4;
const aspect = (a: { width?: number; height?: number }) => (a.width && a.height ? Math.min(1.8, Math.max(0.6, a.width / a.height)) : 4 / 3);

/** A user bubble's images: one large, or two to four in a grid (the fourth says +N for more). */
export function ImageGrid({ images }: { images: Attachment[] }) {
  const thread = useContext(ThreadContext);
  if (!thread || !images.length) return null;
  const all: ViewerImage[] = images.map(a => ({ ...thread, id: a.id, name: a.name, width: a.width, height: a.height }));
  const shown = all.slice(0, 4);
  const half = (GRID - GAP) / 2;
  const tile = (i: number, style: object) => (
    <Tile key={all[i].id} image={all[i]} style={style} more={i === 3 ? all.length - 4 : 0} onPress={() => openViewer(all, i)} />
  );
  return (
    <View style={styles.grid}>
      {shown.length === 1 && tile(0, { width: GRID, aspectRatio: aspect(images[0]) })}
      {shown.length === 2 && shown.map((_, i) => tile(i, { width: half, height: half }))}
      {shown.length === 3 && <>{tile(0, { width: GRID, height: GRID / 2 })}{tile(1, { width: half, height: half })}{tile(2, { width: half, height: half })}</>}
      {shown.length === 4 && shown.map((_, i) => tile(i, { width: half, height: half }))}
    </View>
  );
}

function Tile({ image, style, more, onPress }: { image: ViewerImage; style: object; more: number; onPress: () => void }) {
  const colors = useColors();
  const { uri, error } = useAttachment(image, 'thumb');
  return (
    <Pressable onPress={onPress} style={[styles.tile, style, { backgroundColor: colors.fill }]} accessibilityRole="imagebutton" accessibilityLabel={`Image: ${image.name}`} accessibilityHint="Opens the image">
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        : error ? <Failed name={image.name} /> : <ActivityIndicator style={StyleSheet.absoluteFill} />}
      {more > 0 && <View style={styles.more}><Text style={styles.moreText}>+{more}</Text></View>}
    </Pressable>
  );
}

function Failed({ name }: { name: string }) {
  const colors = useColors();
  return (
    <View style={styles.failed}>
      <Icon ios="photo" android="image" size={18} color={colors.secondary} />
      <Text style={[styles.failedText, { color: colors.secondary }]} numberOfLines={2}>{name}</Text>
    </View>
  );
}

const chipIcon = (kind: string) =>
  kind.startsWith('Attached') ? ['photo', 'image'] as const : kind === 'Folder context' ? ['folder', 'folder'] as const : ['doc', 'description'] as const;

/** Document, folder and file chips; a chip with context text opens it in a sheet. */
export function Chips({ chips }: { chips: { kind: string; name: string; text?: string }[] }) {
  const colors = useColors();
  const [open, setOpen] = useState<{ name: string; text: string } | null>(null);
  if (!chips.length) return null;
  return (
    <View style={styles.chips}>
      {chips.map((chip, i) => {
        const [ios, android] = chipIcon(chip.kind);
        const text = chip.text;
        return (
          <Pressable key={i} disabled={!text} onPress={() => text && setOpen({ name: chip.name, text })} style={[styles.chip, { backgroundColor: colors.fill }]}
            accessibilityRole={text ? 'button' : undefined} accessibilityLabel={`${chip.kind}: ${chip.name}`} accessibilityHint={text ? 'Shows the attached text' : undefined}>
            <Icon ios={ios} android={android} size={13} color={colors.tint} />
            <Text style={[styles.chipText, { color: colors.tint }]} numberOfLines={1}>{chip.name}</Text>
          </Pressable>
        );
      })}
      <ContextSheet item={open} onClose={() => setOpen(null)} />
    </View>
  );
}

/** The context text a message carries, monospace and scrollable. */
function ContextSheet({ item, onClose }: { item: { name: string; text: string } | null; onClose: () => void }) {
  const colors = useColors();
  return (
    <Modal visible={!!item} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={[styles.sheetHead, { borderColor: colors.separator }]}>
          <Text style={[styles.sheetTitle, { color: colors.text }]} numberOfLines={1}>{item?.name}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={[styles.done, { color: colors.tint }]}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <ScrollView horizontal>
            <Text selectable style={[styles.code, { color: colors.text }]}>{item?.text}</Text>
          </ScrollView>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A workspace image in an agent reply (`![alt](relative/path)`): its thumbnail, tappable to the viewer. */
export function ReplyImage({ alt, path }: { alt: string; path: string }) {
  const thread = useContext(ThreadContext);
  const colors = useColors();
  const [ratio, setRatio] = useState(4 / 3);
  const image: ViewerImage = { deviceId: thread?.deviceId ?? '', sessionId: thread?.sessionId ?? '', path, name: alt || path };
  const { uri, error } = useAttachment(image, 'thumb', !!thread);
  if (!thread || error || attachmentsUnsupported(thread.deviceId, { path })) {
    return (
      <View style={styles.missing}>
        <Icon ios="photo" android="image" size={14} color={colors.secondary} />
        <Text style={[styles.missingText, { color: colors.secondary }]} numberOfLines={2}>{alt ? `${alt} (${path})` : path}</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={() => openViewer([image], 0)} style={[styles.replyImage, { aspectRatio: ratio, backgroundColor: colors.fill }]} accessibilityRole="imagebutton" accessibilityLabel={alt || path} accessibilityHint="Opens the image">
      {uri
        ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150}
          onLoad={e => { if (e.source.width && e.source.height) setRatio(Math.min(2.4, Math.max(0.5, e.source.width / e.source.height))); }} />
        : <ActivityIndicator style={StyleSheet.absoluteFill} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: { width: GRID, flexDirection: 'row', flexWrap: 'wrap', gap: GAP, marginBottom: 8, marginTop: 2 },
  tile: { borderRadius: 14, overflow: 'hidden', borderCurve: 'continuous' },
  more: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  moreText: { color: '#fff', fontSize: 22, fontWeight: '600' },
  failed: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8 },
  failedText: { fontSize: 12, textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 220, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5, borderCurve: 'continuous' },
  chipText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  sheet: { flex: 1 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  done: { fontSize: 17, fontWeight: '600' },
  sheetBody: { padding: 18 },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  replyImage: { width: 300, borderRadius: 12, overflow: 'hidden', marginVertical: 6, borderCurve: 'continuous' },
  missing: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 4 },
  missingText: { fontSize: 14, flexShrink: 1 },
});
