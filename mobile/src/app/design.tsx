// One artboard (?device=&project= or &session=, &name=): the computer's rendered preview, which
// pinches to zoom on iOS (Android, whose ScrollView can't zoom, has a 2× toggle that scrolls sideways), with the comments pinned on it; a tap drops a new pin and opens a field
// for the comment (design.comment). Below, the artboard's comments, open first, each with Resolve
// or Reopen (design.resolve). The desktop's Design canvas and the agent see the same comments.
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useHostAllows, useHostSupports } from '../connect/api/capabilities.ts';
import { AccessNote } from '../ui/AccessNote.tsx';
import { addComment, listComments, previewArtboard, setCommentStatus, type DesignComment } from '../connect/api/design.ts';
import { outdated } from '../connect/rpc.ts';
import { Banner, Button, Card, EmptyState, geometry, haptic, InnerCard, Row, type } from '../ui/ds/index.ts';
import { artboardTitle, pinPoint, tapToArtboard, threadOrder, whereLabel, type Point, type PreviewSize } from '../ui/design/geometry.ts';
import { CardTitled, Failed, glyph, Loading, styles as hub, useComputerName, useLoad } from '../ui/hub/common.tsx';
import { HeaderActions } from '../ui/HeaderActions.tsx';
import { PUSHED_HEADER, PushedScroll, usePushedScroll } from '../ui/PushedScroll.tsx';
import { useColors } from '../ui/theme.ts';
import { useDiscardGuard } from '../ui/useDiscardGuard.ts';

const DESIGN_ICON = glyph({ ios: 'paintbrush.pointed', android: 'brush' });
const PIN_SIZE = 22;
const MAX_ZOOM = 4;
/** The toggle's zoom where pinching isn't available. */
const TOGGLE_ZOOM = 2;
const PINCH_ZOOM = Platform.OS === 'ios';
const MAX_COMMENT = 4000;

function Pin({ at, number, tone, selected }: { at: Point; number: number | string; tone: string; selected?: boolean }) {
  const colors = useColors();
  return (
    <View pointerEvents="none" style={[styles.pin, { left: at.x - PIN_SIZE / 2, top: at.y - PIN_SIZE / 2, backgroundColor: tone, borderColor: selected ? colors.text : colors.page }]}>
      <Text style={[type.caption, styles.pinText, { color: colors.onTint }]}>{number}</Text>
    </View>
  );
}

export default function DesignScreen() {
  const params = useLocalSearchParams<{ device: string; project?: string; session?: string; name: string }>();
  const device = params.device ?? '';
  const name = params.name ?? '';
  const t = { projectId: params.project || undefined, sessionId: params.session || undefined };
  const scroll = usePushedScroll();
  const colors = useColors();
  const { width } = useWindowDimensions();
  // The preview's shown width: measured, with the screen's margins as the first guess.
  const [measured, setMeasured] = useState(0);
  const shownWidth = measured || width - geometry.screenMargin * 4;
  const computer = useComputerName(device);
  const supported = useHostSupports(device, 'design.comments');
  const canComment = useHostAllows(device, 'design.comment');
  const canResolve = useHostAllows(device, 'design.resolve');
  const key = `${device}/${t.projectId}/${t.sessionId}/${name}`;

  const loadPreview = useCallback(() => previewArtboard(device, t, name), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadComments = useCallback(() => listComments(device, t, name), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useLoad(supported ? loadPreview : null, key);
  const comments = useLoad(supported ? loadComments : null, key);
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(null);
  const [draft, setDraft] = useState<{ shown: Point; at: Point } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const release = useDiscardGuard(!!draft && !!text.trim(), { message: 'Your comment isn’t posted.' });

  const size: PreviewSize | null = preview.value && pixels ? { ...pixels, scale: preview.value.scale } : null;
  const shownHeight = pixels ? (pixels.height / pixels.width) * shownWidth : shownWidth;
  // The drawn size: the shown one, doubled while Android's zoom toggle is on.
  const zoom = !PINCH_ZOOM && zoomed ? TOGGLE_ZOOM : 1;
  const drawnWidth = shownWidth * zoom;
  const drawnHeight = shownHeight * zoom;
  const thread = threadOrder(comments.value?.comments ?? [], name);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([preview.reload(), comments.reload()]);
    setRefreshing(false);
  };
  const tap = (shown: Point) => {
    if (!size || !canComment) return;
    haptic('light');
    setSelected(null);
    setDraft({ shown, at: tapToArtboard(shown, size, drawnWidth) });
  };
  const submit = async () => {
    const body = text.trim();
    if (!draft || !body || busy) return;
    setBusy('new');
    setError('');
    try {
      await addComment(device, t, name, draft.at.x, draft.at.y, body);
      haptic('success');
      release();
      setDraft(null);
      setText('');
      await comments.reload();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (comment: DesignComment) => {
    if (busy) return;
    setBusy(comment.id);
    setError('');
    try {
      await setCommentStatus(device, t, comment.id, comment.status === 'open' ? 'resolved' : 'open');
      haptic('success');
      await comments.reload();
    } catch (e) {
      haptic('error');
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const header = <><Stack.Screen options={{ ...PUSHED_HEADER, title: artboardTitle(name) }} /><HeaderActions /></>;
  const page = (children: React.ReactNode) => (
    <PushedScroll scroll={scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>{header}{children}</PushedScroll>
  );
  if (!supported) return page(<EmptyState icon={DESIGN_ICON} title={outdated(computer)} style={hub.empty} />);

  const previewCard = preview.value ? (
    <Card>
      <InnerCard style={styles.previewCard} onLayout={e => setMeasured(Math.round(e.nativeEvent.layout.width))}>
        <ScrollView {...(PINCH_ZOOM ? { maximumZoomScale: MAX_ZOOM, minimumZoomScale: 1, pinchGestureEnabled: true, bouncesZoom: true, centerContent: true } : { horizontal: zoomed, nestedScrollEnabled: true })}
          showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} style={{ height: drawnHeight }}>
          <Pressable onPress={e => tap({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY })} accessibilityRole="image"
            accessibilityLabel={`Preview of ${artboardTitle(name)}`} accessibilityHint="Tap a spot to comment on it">
            <Image source={{ uri: preview.value.uri }} style={{ width: drawnWidth, height: drawnHeight }} contentFit="contain"
              onLoad={e => setPixels({ width: e.source.width, height: e.source.height })} />
            {size && thread.map(c => {
              const at = pinPoint(c.bbox, size, drawnWidth);
              return at ? <Pin key={c.id} at={at} number={c.number} selected={c.id === selected} tone={c.status === 'open' ? colors.orange : colors.faint} /> : null;
            })}
            {draft && <Pin at={draft.shown} number="+" tone={colors.info} selected />}
          </Pressable>
        </ScrollView>
      </InnerCard>
      {!PINCH_ZOOM && (
        <View style={styles.zoomBar}>
          <Button label={zoomed ? 'Fit' : `Zoom ${TOGGLE_ZOOM}×`} size="small" variant="raised" accessibilityState={{ selected: zoomed }}
            onPress={() => { haptic('selection'); setDraft(null); setZoomed(z => !z); }} />
        </View>
      )}
    </Card>
  ) : preview.error ? (
    <Banner visible tone="info" title="No preview" body={preview.error} action={{ label: 'Retry', onPress: () => void preview.reload() }} />
  ) : <Loading rows={5} />;

  const composer = draft && (
    <CardTitled title={`New comment at x ${draft.at.x}, y ${draft.at.y}`}>
      <TextInput value={text} onChangeText={setText} autoFocus multiline maxLength={MAX_COMMENT} placeholder="What should change here?"
        placeholderTextColor={colors.faint} accessibilityLabel="Comment" editable={busy !== 'new'}
        style={[type.body, styles.input, { color: colors.text, backgroundColor: colors.cardInner, borderColor: colors.borderInner }]} />
      <View style={styles.actions}>
        <Button label="Cancel" variant="plain" onPress={() => { setDraft(null); setText(''); }} />
        <Button label="Comment" variant="primary" loading={busy === 'new'} disabled={!text.trim()} onPress={() => void submit()} />
      </View>
    </CardTitled>
  );

  const list = comments.value ? (
    thread.length ? (
      <CardTitled title="Comments" footer={comments.value.truncated ? <Text style={[type.footnote, { color: colors.muted }]}>Showing the newest comments.</Text> : undefined}>
        {thread.map(c => (
          <Row key={c.id} title={`${c.number}. ${c.text}`} subtitle={[whereLabel(c), c.note].filter(Boolean).join(' · ')} onPress={() => setSelected(c.id === selected ? null : c.id)}
            accessibilityState={{ selected: c.id === selected }}
            trailing={canResolve ? <Button label={c.status === 'open' ? 'Resolve' : 'Reopen'} size="small" variant="raised" loading={busy === c.id} onPress={() => void toggle(c)} /> : undefined} />
        ))}
      </CardTitled>
    ) : <Text style={[type.footnote, styles.hint, { color: colors.muted }]}>{preview.value && canComment ? 'No comments yet. Tap the preview to add one.' : 'No comments yet.'}</Text>
  ) : comments.error ? <Failed title="Couldn’t load the comments" error={comments.error} retry={() => void comments.reload()} /> : null;

  return page(
    <>
      <Banner visible={!!error} tone="danger" title="Couldn’t save" body={error} />
      {previewCard}
      {composer}
      <AccessNote device={device} methods={['design.comment', 'design.resolve']} />
      {list}
    </>,
  );
}

const styles = StyleSheet.create({
  previewCard: { overflow: 'hidden', padding: 0 },
  pin: { position: 'absolute', width: PIN_SIZE, height: PIN_SIZE, borderRadius: PIN_SIZE / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  pinText: { fontWeight: '700' },
  input: { margin: geometry.cardPadding, minHeight: 72, paddingHorizontal: geometry.sectionGap, paddingVertical: geometry.sectionGap, borderRadius: geometry.innerRadius, borderCurve: 'continuous', borderWidth: geometry.hairline, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: geometry.cardPadding },
  hint: { paddingHorizontal: geometry.rowInset },
  zoomBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: geometry.cardPadding },
});
