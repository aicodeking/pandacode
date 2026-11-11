// The side insets a pane screen keeps clear of on the iPhone Duo's split view. Pure (no React Native),
// so it is testable: usePaneInsets in split.tsx feeds it the safe area and the split state.

export interface SideInsets { left: number; right: number }

/** `insets` less the side the sidebar covers: the sidebar (Sidebar.tsx, always on the left) already
 * takes the left inset, so a pane beside it adds none; collapsed or single-column, it keeps both. */
export function paneInsets(insets: SideInsets, sidebarShown: boolean): SideInsets {
  return { left: sidebarShown ? 0 : insets.left, right: insets.right };
}
