// A transient notice with one action (Undo after an archive): a Banner floating near the bottom, above
// the composer or tab bar (and above the keyboard while it's up), clear of the home indicator,
// gone after TOAST_MS (TOAST_READER_MS with a screen reader on, which also hears it; never while
// `sticky`, which waits for hideToast(id)) or once its action runs. `onDismiss` runs when it goes any
// other way (timed out, replaced, hidden), so work an Undo can cancel commits there and not on a timer. One at a time; a new one replaces the last. The root layout mounts the one ToastHost, over every
// screen and tab (an Undo after Archive in a task shows wherever the user lands), so a toast shows once.
// With no ToastHost mounted (before the app is ready) a toast is dropped rather than kept to pop up stale
// later; one with an action falls back to an alert so it isn't lost.
import { NavigationContext } from 'expo-router/react-navigation';
import { useVerticalBarEdgeIOS } from 'expo-status-bar';
import { use, useEffect, useState } from 'react';
import { AccessibilityInfo, Alert, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaListener, useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { sidebarWidth } from '../sidebar-width.ts';
import { useSidebar, useSplit } from '../split.tsx';
import { Banner } from './Banner.tsx';
import type { Tone } from './palette.ts';
import { dismissal, fallbackClearance, tabBarClearance, toastClearance, toastDuration, withClearance, type Clearances } from './toast-clearance.ts';
import { geometry, type IconName } from './type.ts';

export const TOAST_MS = 6000;
/** Long enough to hear it out and reach its action with a screen reader. */
export const TOAST_READER_MS = 10_000;
/** Room left under a toast above the safe area when no focused screen registered its bottom dock
 * (useToastClearance) or tab bar (useTabBarClearance): enough for an unmeasured composer or tab bar.
 * Never used on the iPhone Duo, whose tab bar sits in the side rail (fallbackClearance). */
export const BOTTOM_CLEARANCE = Platform.OS === 'ios' ? 64 : 72;

export interface ToastSpec {
  title: string;
  body?: string;
  tone?: Tone;
  icon?: IconName;
  action?: { label: string; onPress: () => void };
  /** Runs once when the toast goes away without its action tapped (timed out, replaced, hidden). */
  onDismiss?: () => void;
  /** Stays until hideToast(id) (a load in progress): no timeout. */
  sticky?: boolean;
}

interface ToastState { toast: (ToastSpec & { id: number }) | null }

const useToastStore = create<ToastState>(() => ({ toast: null }));
const useClearances = create<{ registered: Clearances }>(() => ({ registered: {} }));
let nextClearanceId = 1;

/** Whether this view's screen is focused; views outside a route (the root layout's) count as focused. */
function useScreenFocused(): boolean {
  const navigation = use(NavigationContext);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!navigation) return undefined;
    const sync = () => setFocused(navigation.isFocused());
    sync();
    const unsubscribers = [navigation.addListener('focus', sync), navigation.addListener('blur', sync)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [navigation]);
  return focused;
}

/** Call from a view with a bottom dock (a composer, a pane's bar): while its screen is focused,
 * toasts sit `height` points above the safe area (or the keyboard) instead of BOTTOM_CLEARANCE. With
 * several registered the tallest wins; pass 0 or less (an unmeasured dock) to register nothing. */
export function useToastClearance(height: number): void {
  useRegisteredClearance(Number.isFinite(height) && height > 0 ? height : null);
}

/** Call from a page with no bottom dock (PushedScroll, PushedList): toasts sit just above the safe
 * area, not BOTTOM_CLEARANCE (a tab bar a pushed screen covers). A screen's own dock still wins. */
export function useNoDockClearance(): void {
  useRegisteredClearance(0);
}

/** Registers `height` (0 included) while this view's screen is focused; null registers nothing. */
function useRegisteredClearance(height: number | null): void {
  const focused = useScreenFocused();
  const [id] = useState(() => nextClearanceId++);
  const value = focused && height !== null && Number.isFinite(height) && height >= 0 ? height : null;
  useEffect(() => {
    useClearances.setState(s => ({ registered: withClearance(s.registered, id, value) }));
  }, [id, value]);
  useEffect(() => () => useClearances.setState(s => ({ registered: withClearance(s.registered, id, null) })), [id]);
}

/** Call from a tab's layout with the bottom inset measured inside the tab controller (which includes
 * the system tab bar) and the window's: while the tab is focused, toasts clear the real tab bar, and
 * nothing on the Duo, where it sits in the side rail (a measured 0 still registers). Null (unmeasured
 * yet, or off iOS where the inset isn't measured) leaves the fallback. */
export function useTabBarClearance(tabInset: number | null, windowInset: number): void {
  useRegisteredClearance(tabInset === null ? null : tabBarClearance(tabInset, windowInset));
}
/** Mount in each tab's layout (after its Stack): an invisible full-size view inside the tab controller
 * whose safe area includes the system tab bar, so toasts clear the bar's real height, whatever iOS
 * draws (Liquid Glass, larger text, the Duo's rail: 0). iOS only; elsewhere the fallback stays. */
export function TabBarProbe() {
  const window = useSafeAreaInsets();
  const [inset, setInset] = useState<number | null>(null);
  useTabBarClearance(inset, window.bottom);
  if (Platform.OS !== 'ios') return null;
  return <SafeAreaListener pointerEvents="none" style={StyleSheet.absoluteFill} onChange={({ insets }) => setInset(insets.bottom)} />;
}

let nextId = 1;
/** ToastHosts mounted now. */
let hosts = 0;

/** Shows `spec`, replacing (and dismissing) the last; resolves its id for hideToast. */
export function showToast(spec: ToastSpec): number | undefined {
  if (hosts > 0) {
    // Once, however many hosts show it; a no-op without a screen reader.
    AccessibilityInfo.announceForAccessibility([spec.title, spec.body, spec.action && `${spec.action.label} available`].filter(Boolean).join('. '));
    const id = nextId++;
    const gone = useToastStore.getState().toast;
    useToastStore.setState({ toast: { ...spec, id } });
    gone?.onDismiss?.();
    return id;
  }
  const action = spec.action;
  if (action) {
    Alert.alert(spec.title, spec.body, [
      { text: 'OK', style: 'cancel', onPress: spec.onDismiss },
      { text: action.label, onPress: action.onPress },
    ], { cancelable: true, onDismiss: spec.onDismiss });
  } else {
    spec.onDismiss?.();
  }
  return undefined;
}

/** Whether a screen reader is on, kept current. */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled().then(value => { if (live) setOn(value); }, () => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => { live = false; sub.remove(); };
  }, []);
  return on;
}

/** Hides toast `id` (a stale id hides nothing), or whichever shows; runs its onDismiss. */
export function hideToast(id?: number): void {
  const { next, gone } = dismissal(useToastStore.getState().toast, id);
  if (!gone) return;
  useToastStore.setState({ toast: next });
  gone.onDismiss?.();
}

/** Clears toast `id` because its action ran: no onDismiss. */
function acted(id: number): void {
  if (useToastStore.getState().toast?.id === id) useToastStore.setState({ toast: null });
}

/** Mount once, in the root layout (inside the KeyboardProvider). `bottom`: the space to leave under it;
 * by default the focused screen's registered dock (useToastClearance) or BOTTOM_CLEARANCE, over the
 * safe area, or over the keyboard while it's up. */
export function ToastHost({ bottom }: { bottom?: number }) {
  const toast = useToastStore(s => s.toast);
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState(state => (state.isVisible ? state.height : 0));
  const railed = useVerticalBarEdgeIOS() != null;
  const fallback = fallbackClearance(railed, BOTTOM_CLEARANCE);
  const clearance = useClearances(s => toastClearance(s.registered, fallback));
  const above = bottom ?? Math.max(insets.bottom, keyboard) + clearance;
  const reader = useScreenReader();
  // The Duo's split view: the toast belongs to the task pane, clear of the sidebar (drawn with the left inset).
  const { width } = useWindowDimensions();
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  const sidebar = split && !collapsed;
  const left = (sidebar ? sidebarWidth(width) : 0) + insets.left + geometry.screenMargin;
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      if (hosts === 0) hideToast();
    };
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const ms = toastDuration(toast.sticky, reader, TOAST_MS, TOAST_READER_MS);
    if (ms === null) return undefined;
    const timer = setTimeout(() => hideToast(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast, reader]);
  const action = toast?.action;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: above + geometry.sectionGap, left, right: geometry.screenMargin + insets.right }]}>
      <Banner key={toast?.id} visible={!!toast} title={toast?.title ?? ''} body={toast?.body} tone={toast?.tone ?? 'info'} icon={toast?.icon}
        action={action ? { label: action.label, onPress: () => { if (toast) acted(toast.id); action.onPress(); } } : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute' },
});
