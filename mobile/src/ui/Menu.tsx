// Menus. iOS: a SwiftUI menu (`Menu`) or the system action sheet (`showActions`). Android: a
// solid Material-style sheet (`MenuHost`, mounted once in the root layout).
import { Button as SwiftButton, HStack, Host, RNHostView, Image as SwiftImage, Menu as SwiftMenu, Section, Text as SwiftText } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, font, foregroundStyle, type ModifierConfig } from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'expo-symbols';
import { type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { create } from 'zustand';
import { Icon } from './Icon.tsx';
import { useColors } from './theme.ts';

type Android = ComponentProps<typeof Icon>['android'];

export interface MenuItem { label: string; /** Items with the same section are grouped under its title (iOS). */ section?: string; ios?: SFSymbol; android?: Android; destructive?: boolean; checked?: boolean; onPress: () => void }

const useSheet = create<{ title?: string; items: MenuItem[] }>(() => ({ items: [] }));

/** A one-off list of actions (long press, a row's "more"). */
export function showActions(title: string | undefined, items: MenuItem[]) {
  if (Platform.OS !== 'ios') return useSheet.setState({ title, items });
  const labels = [...items.map(i => (i.checked ? `✓ ${i.label}` : i.label)), 'Cancel'];
  const destructive = items.map((i, n) => (i.destructive ? n : -1)).filter(n => n >= 0);
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: labels, cancelButtonIndex: items.length, destructiveButtonIndex: destructive },
    index => items[index]?.onPress(),
  );
}

/** Android's action sheet; renders nothing on iOS. */
export function MenuHost() {
  const colors = useColors();
  const { title, items } = useSheet();
  if (Platform.OS === 'ios') return null;
  const close = () => useSheet.setState({ title: undefined, items: [] });
  return (
    <Modal visible={items.length > 0} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.scrim} onPress={close} accessibilityLabel="Close menu">
        <View style={[styles.sheet, { backgroundColor: colors.card }]}>
          {!!title && <Text style={[styles.title, { color: colors.secondary }]} numberOfLines={2}>{title}</Text>}
          {items.map(item => (
            <Pressable key={item.label} onPress={() => { close(); item.onPress(); }} accessibilityRole="menuitem"
              style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.fill }]}>
              {!!item.android && <Icon ios="circle" android={item.android} size={20} color={item.destructive ? colors.red : colors.secondary} />}
              <Text style={[styles.label, { color: item.destructive ? colors.red : colors.text }]}>{item.label}</Text>
              {item.checked && <Icon ios="checkmark" android="check" size={18} color={colors.tint} />}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * A button that opens a menu. On iOS the SwiftUI menu draws `ios` as its label inside
 * `children` (the button's frame); on Android the frame is pressable and opens the sheet.
 */
export function Menu({ ios, android, color, size = 17, items, label, modifiers, children }: { ios: SFSymbol; android: Android; color: ColorValue; size?: number; items: MenuItem[]; label: string; modifiers?: ModifierConfig[]; children?: (icon: ReactNode) => ReactNode }) {
  const frame = children ?? ((icon: ReactNode) => icon);
  if (Platform.OS === 'ios') {
    return frame(
      <Host matchContents>
        <SwiftMenu modifiers={modifiers} label={<SwiftImage systemName={ios} size={size} color={color} />}>
          {swiftItems(items)}
        </SwiftMenu>
      </Host>,
    );
  }
  return (
    <Pressable onPress={() => showActions(undefined, items)} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
      {frame(<Icon ios={ios} android={android} size={size + 3} color={color} />)}
    </Pressable>
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
        <SwiftMenu modifiers={[buttonStyle('plain')]} label={(
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
    <Pressable onPress={() => showActions(label, items)} accessibilityRole="button" accessibilityLabel={`${label}: ${text}`} hitSlop={6} style={styles.textMenu}>
      {!!ios && !!android && <Icon ios={ios} android={android} size={size + 2} color={color} />}
      <Text style={{ color: colors.text, fontSize: size + 1 }}>{text}</Text>
      <Icon ios="chevron.down" android="expand_more" size={size} color={colors.secondary} />
    </Pressable>
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
  return <Pressable onPress={() => showActions(label, items)} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>{children}</Pressable>;
}

const styles = StyleSheet.create({
  textMenu: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingVertical: 12, paddingBottom: 28 },
  title: { fontSize: 14, paddingHorizontal: 24, paddingVertical: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 24, minHeight: 52 },
  label: { flex: 1, fontSize: 16 },
});
