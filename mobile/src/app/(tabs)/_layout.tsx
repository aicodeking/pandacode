// The system tab bar (a real UITabBarController on iOS, Material bottom navigation on Android):
// Inbox, Computers and Settings. Tasks and sheets live in the root Stack and cover it.
import { NativeTabs } from 'expo-router/native-tabs';

// The tab controller paints systemBackground by default; clear lets the root layout's wallpaper
// (or its solid background) show through.
const CLEAR = { nativeContainerStyle: { backgroundColor: 'transparent' } };

export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown" unstable_nativeProps={CLEAR}>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="forum" />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Icon sf="desktopcomputer" md="computer" />
        <NativeTabs.Trigger.Label>Computers</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
