// A screen's header buttons and menus, one description for both platforms. iOS draws them as native bar
// button items (Stack.Toolbar), so on the iPhone Duo they move into the side rail. On Android the
// installed expo-router's Stack.Toolbar.Button and Stack.Toolbar.Menu render nothing unless their icon is
// an image (no SF Symbols, no text), so Android gets headerLeft/headerRight with the ds Button and the app's
// Menu, as TaskHeader and the Inbox do. tests/header-actions.test.ts keeps routes from using
// Stack.Toolbar.Button/Menu directly.
//
// Render it unconditionally and hide items with `hidden`: on Android a side's views stay in the screen's
// options until this sets them again. A side left out (`left` undefined) is never touched, so the system
// back button stays; an empty or all-hidden side clears it.
//
// On the iPhone Duo (useSplit) a pushed screen leads with the sidebar toggle the task header uses, so
// the sidebar can come back from any screen: on by default when `left` is left out (a pushed screen
// keeping its back button), off for sheets, which pass their own left side (Cancel) or `sidebar={false}`.
import { Stack } from 'expo-router';
import type { SFSymbol } from 'expo-symbols';
import { Platform, StyleSheet, View } from 'react-native';
import { Button, geometry, PressScale, type IconName } from './ds/index.ts';
import { Icon } from './Icon.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { toggleSidebar, useSidebar, useSplit } from './split.tsx';
import { useColors } from './theme.ts';

/** A bar button: an icon (`label` is then its accessibility label) or, without one, its label as text. */
export interface HeaderButton {
  kind?: 'button';
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  /** The sheet's confirming action (Save, Start): iOS's done style, Android's primary button. */
  primary?: boolean;
  hidden?: boolean;
  /** Overrides `label` for VoiceOver/TalkBack (a text button whose label is terse). */
  accessibilityLabel?: string;
}

/** One choice in a header menu; `checked` marks the current one. */
export interface HeaderMenuItem { label: string; subtitle?: string; checked?: boolean; onPress: () => void }

/** An icon that opens a list of choices; `label` names it for screen readers. */
export interface HeaderMenu {
  kind: 'menu';
  label: string;
  icon: IconName;
  items: HeaderMenuItem[];
  hidden?: boolean;
}

export type HeaderItem = HeaderButton | HeaderMenu;

export interface HeaderActionsProps {
  left?: HeaderItem[];
  right?: HeaderItem[];
  /** Lead with the Duo's sidebar toggle while split; defaults to true when `left` is left out. */
  sidebar?: boolean;
}

const SIDEBAR_ICON = { ios: 'sidebar.left', android: 'menu' } as const;

/** The left side with the Duo's sidebar toggle first, or `left` unchanged when it doesn't apply. */
export function withSidebarToggle(left: HeaderItem[] | undefined, show: boolean, collapsed: boolean): HeaderItem[] | undefined {
  if (!show) return left;
  const toggle: HeaderButton = { label: collapsed ? 'Show sidebar' : 'Hide sidebar', icon: SIDEBAR_ICON, onPress: toggleSidebar };
  return [toggle, ...(left ?? [])];
}

const isMenu = (item: HeaderItem): item is HeaderMenu => item.kind === 'menu';
const visible = (items: HeaderItem[] | undefined) => (items ?? []).filter(i => !i.hidden);
const keyOf = (item: HeaderItem, n: number) => `${n}/${item.label}`;

export function HeaderActions({ left: own, right, sidebar }: HeaderActionsProps) {
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  const left = withSidebarToggle(own, split && (sidebar ?? own === undefined), collapsed);
  if (Platform.OS === 'ios') return <><IosToolbar placement="left" items={visible(left)} /><IosToolbar placement="right" items={visible(right)} /></>;
  const shown = { left: visible(left), right: visible(right) };
  const side = (items: HeaderItem[]) => (items.length ? () => <AndroidSide items={items} /> : undefined);
  return (
    <Stack.Screen options={{
      ...(left !== undefined ? { headerLeft: side(shown.left) } : {}),
      ...(right !== undefined ? { headerRight: side(shown.right) } : {}),
    }} />
  );
}

function IosToolbar({ placement, items }: { placement: 'left' | 'right'; items: HeaderItem[] }) {
  const colors = useColors();
  if (!items.length) return null;
  return (
    <Stack.Toolbar placement={placement}>
      {items.map((item, n) => {
        if (isMenu(item)) {
          return (
            <Stack.Toolbar.Menu key={keyOf(item, n)} icon={item.icon.ios as SFSymbol} accessibilityLabel={item.label}>
              {item.items.map((choice, c) => (
                <Stack.Toolbar.MenuAction key={`${c}/${choice.label}`} isOn={choice.checked} {...(choice.subtitle ? { subtitle: choice.subtitle } : {})} onPress={choice.onPress}>{choice.label}</Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          );
        }
        const a11y = item.accessibilityLabel ?? item.label;
        if (item.icon) return <Stack.Toolbar.Button key={keyOf(item, n)} icon={item.icon.ios as SFSymbol} accessibilityLabel={a11y} disabled={item.disabled} onPress={item.onPress} />;
        const done = item.primary ? { variant: 'done' as const, ...(!item.disabled && { tintColor: colors.primary, style: { color: colors.onPrimary } }) } : {};
        return <Stack.Toolbar.Button key={keyOf(item, n)} {...done} accessibilityLabel={a11y} disabled={item.disabled} onPress={item.onPress}>{item.label}</Stack.Toolbar.Button>;
      })}
    </Stack.Toolbar>
  );
}

function AndroidSide({ items }: { items: HeaderItem[] }) {
  return <View style={styles.side}>{items.map((item, n) => <AndroidItem key={keyOf(item, n)} item={item} />)}</View>;
}

function AndroidItem({ item }: { item: HeaderItem }) {
  const colors = useColors();
  if (isMenu(item)) {
    const items: MenuItem[] = item.items.map(choice => ({ label: choice.label, subtitle: choice.subtitle, checked: choice.checked, onPress: choice.onPress }));
    return <Menu ios={item.icon.ios} android={item.icon.android} color={colors.text} items={items} label={item.label}>{icon => <View style={styles.icon}>{icon}</View>}</Menu>;
  }
  const a11y = item.accessibilityLabel ?? item.label;
  if (item.icon) {
    return (
      <PressScale onPress={item.onPress} disabled={item.disabled} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ disabled: !!item.disabled }} hitSlop={4} style={[styles.icon, item.disabled && styles.off]}>
        <Icon {...item.icon} size={22} color={colors.text} />
      </PressScale>
    );
  }
  return <Button label={item.label} accessibilityLabel={a11y} size="small" variant={item.primary ? 'primary' : 'plain'} disabled={item.disabled} onPress={item.onPress} />;
}

const DISABLED_OPACITY = 0.45;

const styles = StyleSheet.create({
  side: { flexDirection: 'row', alignItems: 'center', gap: geometry.cardPadding / 2 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: DISABLED_OPACITY },
});
