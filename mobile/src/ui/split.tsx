// The iPhone Duo's split view: the sidebar (Sidebar.tsx) beside the stack, only while iOS draws
// the side rail on a wide window. The sidebar's collapsed state; its toggle is a native header
// item on the New thread pane and in tasks.
import { useVerticalBarEdgeIOS } from 'expo-status-bar';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { paneInsets, type SideInsets } from './pane-insets.ts';

const SPLIT_WIDTH = 700;

export const useSidebar = create<{ collapsed: boolean }>(() => ({ collapsed: false }));
export const toggleSidebar = () => useSidebar.setState(s => ({ collapsed: !s.collapsed }));

/** True on the iPhone Duo while the rail is drawn on a wide window: the inbox is a sidebar and
 * tasks open beside it. Every other phone keeps the single column. */
export function useSplit(): boolean {
  const edge = useVerticalBarEdgeIOS();
  const { width } = useWindowDimensions();
  return edge != null && width >= SPLIT_WIDTH;
}

/** The side insets a pane screen keeps clear of: the safe area's, except the left one while the split
 * view's sidebar shows (it takes that inset itself, so adding it again doubled the gutter). */
export function usePaneInsets(): SideInsets {
  const { left, right } = useSafeAreaInsets();
  const split = useSplit();
  const collapsed = useSidebar(s => s.collapsed);
  return paneInsets({ left, right }, split && !collapsed);
}
