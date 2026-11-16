// Menus. iOS: a SwiftUI menu (`Menu`) or the system action sheet (`showActions`). Android: a card
// (`MenuHost`, mounted once in the root layout) that grows from the trigger when it has one, else
// rises as a sheet.
import { Button as SwiftButton, HStack, Host, RNHostView, Image as SwiftImage, Menu as SwiftMenu, Section, Text as SwiftText } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, font, foregroundStyle, type ModifierConfig } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'expo-symbols';
import { type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ColorValue, type GestureResponderEvent, type ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { Easing, Keyframe, ReduceMotion } from 'react-native-reanimated';
import { create } from 'zustand';
import { FADE_MS, geometry, LARGE_TEXT_SCALE, PressScale, type as dsText, useMotion } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { useColors } from './theme.ts';

type Android = ComponentProps<typeof Icon>['android'];

export interface MenuItem { label: string; /** A secondary line under the label (Android's card; iOS menus pass their own). */ subtitle?: string; /** Items with the same section are grouped under its title (iOS). */ section?: string; ios?: SFSymbol; android?: Android; destructive?: boolean; checked?: boolean; onPress: () => void }

type Anchor = { x: number; y: number };

// Items stay while closing, so the modal fades out with its content.
const useSheet = create<{ open: boolean; title?: string; items: MenuItem[]; anchor?: Anchor }>(() => ({ open: false, items: [] }));

const SCRIM = 'rgba(0, 0, 0, 0.32)';
const POPOVER_WIDTH = 260;
const EDGE = 12;
const TRIGGER_GAP = 10;
const GROW_FROM = 0.92;
const easing = Easing.out(Easing.cubic);
const GROW = new Keyframe({ from: { opacity: 0, transform: [{ scale: GROW_FROM }] }, to: { opacity: 1, transform: [{ scale: 1 }], easing } }).duration(FADE_MS).reduceMotion(ReduceMotion.Never);
const RISE = new Keyframe({ from: { opacity: 0, transform: [{ translateY: 12 }] }, to: { opacity: 1, transform: [{ translateY: 0 }], easing } }).duration(FADE_MS).reduceMotion(ReduceMotion.Never);

/** Where a popover sits beside its trigger, opening away from the nearest screen edges and growing from that corner. */
function popoverFrame({ x, y }: Anchor, width: number, height: number, content: number): ViewStyle {
  // Downward whenever it fits; upward only when the room below is too short and above is longer.
  const below = y + TRIGGER_GAP + content + EDGE <= height || height - y >= y;
  const rightward = x < width / 2;
  const left = Math.min(Math.max(EDGE, rightward ? x - EDGE : x + EDGE - POPOVER_WIDTH), width - POPOVER_WIDTH - EDGE);
  return {
    position: 'absolute', left, width: POPOVER_WIDTH,
    maxHeight: (below ? height - y : y) - TRIGGER_GAP - EDGE,
    ...(below ? { top: y + TRIGGER_GAP } : { bottom: height - y + TRIGGER_GAP }),
    transformOrigin: `${rightward ? 'left' : 'right'} ${below ? 'top' : 'bottom'}`,
  };
}

/** A one-off list of actions (long press, a row's "more"). On Android `anchor` is where the trigger was pressed. */
export function showActions(title: string | undefined, items: MenuItem[], anchor?: Anchor) {
  // The system action sheet can't mark a choice, so a list with one uses the card with a real check.
  if (Platform.OS !== 'ios' || items.some(i => i.checked)) return useSheet.setState({ open: items.length > 0, title, items, anchor });
  const labels = [...items.map(i => i.label), 'Cancel'];
  const destructive = items.map((i, n) => (i.destructive ? n : -1)).filter(n => n >= 0);
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: labels, cancelButtonIndex: items.length, destructiveButtonIndex: destructive },
    index => items[index]?.onPress(),
  );
}

/** The menu card: every menu on Android, and on iOS only a list with a checked choice. */
export function MenuHost() {
  const colors = useColors();
  const { open, title, items, anchor } = useSheet();
  const { width, height, fontScale } = useWindowDimensions();
  const { reduced, enter } = useMotion();
  const close = () => useSheet.setState({ open: false });
  const entering = reduced ? enter() : anchor ? GROW : RISE;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      {/* A Modal is its own native root: PressScale's gesture needs one here too. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM }]} onPress={close} accessibilityLabel="Close menu" />
      <Animated.View entering={entering} style={[styles.sheet, anchor ? [styles.popover, popoverFrame(anchor, width, height, items.reduce((sum, i) => sum + geometry.rowHeight * (i.subtitle ? 1.5 : 1), 0) + (title ? geometry.rowHeight : 0))] : styles.bottom, { backgroundColor: colors.raised, borderColor: colors.border, boxShadow: colors.shadowCard }]}>
        <ScrollView bounces={false}>
          {!!title && <Text style={[dsText.subhead, styles.title, { color: colors.muted }]} numberOfLines={2}>{title}</Text>}
          {items.map((item, i) => (
            <PressScale key={`${i}/${item.label}`} onPress={() => { close(); item.onPress(); }} accessibilityRole="menuitem" accessibilityState={{ checked: !!item.checked }} style={styles.item}>
              {(!!item.ios || !!item.android) && <Icon ios={item.ios ?? 'circle'} android={item.android} size={20} color={item.destructive ? colors.danger : colors.muted} />}
              <View style={styles.label}>
                <Text numberOfLines={fontScale > LARGE_TEXT_SCALE ? 3 : 1} style={[dsText.body, { color: item.destructive ? colors.danger : colors.text }]}>{item.label}</Text>
                {!!item.subtitle && <Text numberOfLines={fontScale > LARGE_TEXT_SCALE ? 4 : 2} style={[dsText.footnote, { color: colors.secondary }]}>{item.subtitle}</Text>}
              </View>
              {item.checked && <Icon ios="checkmark" android="check" size={18} color={colors.text} />}
            </PressScale>
          ))}
        </ScrollView>
      </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const anchorOf = ({ nativeEvent: { pageX, pageY } }: GestureResponderEvent): Anchor => ({ x: pageX, y: pageY });

/**
 * A button that opens a menu. On iOS the SwiftUI menu draws `ios` as its label inside
 * `children` (the button's frame); on Android the frame is pressable and opens the sheet.
 */
export function Menu({ ios, android, color, size = 17, items, label, modifiers, children }: { ios: SFSymbol; android: Android; color: ColorValue; size?: number; items: MenuItem[]; label: string; modifiers?: ModifierConfig[]; children?: (icon: ReactNode) => ReactNode }) {
  const frame = children ?? ((icon: ReactNode) => icon);
  if (Platform.OS === 'ios') {
    return frame(
      <Host matchContents>
        <SwiftMenu modifiers={[...(modifiers ?? []), accessibilityLabel(label)]} label={<SwiftImage systemName={ios} size={size} color={color} />}>
          {swiftItems(items)}
        </SwiftMenu>
      </Host>,
    );
  }
  return (
    <PressScale onPress={event => showActions(undefined, items, anchorOf(event))} accessibilityLabel={label} hitSlop={6}>
      {frame(<Icon ios={ios} android={android} size={size + 3} color={color} />)}
    </PressScale>
  );
}

const swiftButton = (i: MenuItem, n: number) => <SwiftButton key={`${n}/${i.label}`} label={i.label} systemImage={i.checked ? 'checkmark' : i.ios} role={i.destructive ? 'destructive' : 'default'} onPress={i.onPress} />;

/** Buttons, with consecutive items of one section in a titled SwiftUI Section. */
function swiftItems(items: MenuItem[]): ReactNode[] {
  const groups: { section?: string; items: MenuItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.section === item.section) last.items.push(item);
    else groups.push({ section: item.section, items: [item] });
  }
  return groups.map((g, n) => (g.section ? <Section key={`${n}/${g.section}`} title={g.section}>{g.items.map(swiftButton)}</Section> : g.items.map(swiftButton)));
}

/** A menu whose trigger is an icon, a text value and a chevron (the New thread pickers). */
/** Without `ios`/`android` the caller draws its own leading view. */
export function TextMenu({ ios, android, text, items, label, color, size = 15 }: { ios?: SFSymbol; android?: Android; text: string; items: MenuItem[]; label: string; color: ColorValue; size?: number }) {
  const colors = useColors();
  if (Platform.OS === 'ios') {
    return (
      <Host matchContents>
        <SwiftMenu modifiers={[buttonStyle('plain'), accessibilityLabel(`${label}: ${text}`)]} label={(
          <HStack spacing={6}>
            {!!ios && <SwiftImage systemName={ios} size={size} color={color} />}
            <SwiftText modifiers={[font({ size: size + 1 }), foregroundStyle({ type: 'hierarchical', style: 'primary' })]}>{text}</SwiftText>
            <SwiftImage systemName="chevron.down" size={size - 4} color={colors.secondary} />
          </HStack>
        )}>
          {swiftItems(items)}
        </SwiftMenu>
      </Host>
    );
  }
  return (
    <PressScale onPress={event => showActions(label, items, anchorOf(event))} accessibilityLabel={`${label}: ${text}`} hitSlop={6} style={styles.textMenu}>
      {!!ios && !!android && <Icon ios={ios} android={android} size={size + 2} color={color} />}
      <Text style={[dsText.callout, { color: colors.text }]}>{text}</Text>
      <Icon ios="chevron.down" android="expand_more" size={size} color={colors.secondary} />
    </PressScale>
  );
}

/** A menu whose trigger is React Native content (a harness logo); `label` names it for VoiceOver. */
export function ViewMenu({ items, label, children }: { items: MenuItem[]; label: string; children: ReactElement }) {
  if (Platform.OS === 'ios') {
    return (
      <Host matchContents>
        <SwiftMenu label={<RNHostView matchContents>{children}</RNHostView>} modifiers={[accessibilityLabel(label)]}>{swiftItems(items)}</SwiftMenu>
      </Host>
    );
  }
  return <PressScale onPress={event => showActions(label, items, anchorOf(event))} accessibilityLabel={label} hitSlop={6}>{children}</PressScale>;
}

const styles = StyleSheet.create({
  textMenu: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sheet: { borderWidth: geometry.hairline, borderCurve: 'continuous', overflow: 'hidden' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%', paddingBottom: 28, paddingTop: 8, borderTopLeftRadius: geometry.cardRadius, borderTopRightRadius: geometry.cardRadius },
  popover: { borderRadius: geometry.innerRadius, paddingVertical: 4 },
  title: { paddingHorizontal: 16, paddingVertical: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 6, minHeight: geometry.rowHeight },
  label: { flex: 1, gap: 2 },
});
