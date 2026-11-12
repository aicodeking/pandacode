// Pieces the Bot settings and Machines screens share: a state dot that also has a muted tone, a memory row
// that swipes to forget, a pair of Approve/Deny buttons and a full-screen VM screenshot.
import { Image } from 'expo-image';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Tone } from '../../store/admin.ts';
import { Button, geometry, PressScale, StatusDot, type as textStyle, VIEWER } from '../ds/index.ts';
import { Icon } from '../Icon.tsx';
import { useColors } from '../theme.ts';

const SWIPE_WIDTH = 88;
const DOT = 8;

export function ToneDot({ tone, label }: { tone: Tone; label?: string }) {
  const colors = useColors();
  if (tone === 'muted') return <View accessibilityLabel={label} style={[styles.dot, { backgroundColor: colors.faint }]} />;
  return <StatusDot tone={tone} pulse={tone === 'running'} size={DOT} accessibilityLabel={label} />;
}

function Forget({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <PressScale onPress={onPress} accessibilityLabel="Forget" style={[styles.forget, { backgroundColor: colors.danger }]}>
      <Icon ios="trash.fill" android="delete" size={18} color={colors.onPrimary} />
      <Text style={[textStyle.footnoteMedium, { color: colors.onPrimary }]}>Forget</Text>
    </PressScale>
  );
}

/** A memory; swipe left (or the accessibility action) to forget it when `onForget` is given. */
export function MemoryRow({ content, meta, onForget }: { content: string; meta: string; onForget?: () => void }) {
  const colors = useColors();
  const body = (
    <View style={styles.memory} accessible accessibilityLabel={`${content}. ${meta}`}
      accessibilityActions={onForget ? [{ name: 'delete', label: 'Forget' }] : undefined} onAccessibilityAction={() => onForget?.()}>
      <Text style={[textStyle.subhead, { color: colors.text }]}>{content}</Text>
      <Text numberOfLines={1} style={[textStyle.footnote, { color: colors.muted }]}>{meta}</Text>
    </View>
  );
  if (!onForget) return body;
  return (
    <Swipeable renderRightActions={() => <Forget onPress={onForget} />} rightThreshold={SWIPE_WIDTH / 2} friction={1} childrenContainerStyle={{ backgroundColor: colors.cardInner }}>
      {body}
    </Swipeable>
  );
}

/** Approve / Deny for one waiting decision. */
export function Decide({ yes, no, busy, onYes, onNo }: { yes: string; no: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <View style={styles.decide}>
      <Button label={no} size="small" variant="raised" disabled={busy} onPress={onNo} />
      <Button label={yes} size="small" variant="primary" loading={busy} onPress={onYes} />
    </View>
  );
}

/** A VM's screenshot over everything, black around it; tap or Done closes. */
export function FrameViewer({ uri, title, onClose }: { uri: string | null; title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!uri} animationType="fade" transparent onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <Pressable style={styles.viewer} onPress={onClose} accessibilityLabel={`${title} screen`} accessibilityHint="Closes the screenshot">
        {!!uri && <Image source={{ uri }} style={styles.frame} contentFit="contain" accessibilityIgnoresInvertColors />}
        <View style={[styles.close, { top: insets.top + 8 }]}>
          <Button label="Done" size="small" variant="raised" onPress={onClose} />
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  forget: { width: SWIPE_WIDTH, alignItems: 'center', justifyContent: 'center', gap: 4 },
  memory: { paddingHorizontal: geometry.rowInset, paddingVertical: 10, gap: 3 },
  decide: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', paddingHorizontal: geometry.rowInset, paddingBottom: 10 },
  viewer: { flex: 1, backgroundColor: VIEWER.page, justifyContent: 'center' },
  frame: { flex: 1 },
  close: { position: 'absolute', right: 16 },
});
