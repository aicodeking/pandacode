// The system tab bar (a real UITabBarController on iOS, Material bottom navigation on Android):
// Inbox, Computers and Settings. Tasks and sheets live in the root Stack and cover it.
import { NativeTabs } from 'expo-router/native-tabs';
import { useEffect } from 'react';
import { needsYouCount } from '../../store/inbox.ts';
import { useAppBadge } from '../../ui/push.ts';
import { useAttention, useInbox } from '../../ui/useInbox.ts';

// The tab controller paints systemBackground by default; clear lets the root layout's page tone
// show through.
const CLEAR = { nativeContainerStyle: { backgroundColor: 'transparent' } };

/** Follows Needs you for the tab and app icon badges, so only this re-renders with the inbox. */
function AttentionTracker() {
  const count = needsYouCount(useInbox().inbox);
  useEffect(() => useAttention.setState({ count }), [count]);
  useAppBadge(count);
  return null;
}

export default function TabsLayout() {
  const attention = useAttention(s => s.count);
  return (
    <>
      <AttentionTracker />
      <NativeTabs minimizeBehavior="onScrollDown" unstable_nativeProps={CLEAR}>
        <NativeTabs.Trigger name="inbox">
          <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="forum" />
          <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Badge hidden={!attention}>{String(attention)}</NativeTabs.Trigger.Badge>
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
    </>
  );
}
