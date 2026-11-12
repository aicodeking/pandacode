// The Duo split view's sidebar width (Sidebar.tsx), shared with views that keep clear of it (ToastHost).
// Pure: no React Native imports.

/** The sidebar's share of the window's width. */
export const SIDEBAR_SHARE = 0.32;
/** The narrowest the sidebar gets. */
export const SIDEBAR_MIN_WIDTH = 300;

/** The sidebar's width for a window `windowWidth` points wide, before the left safe-area inset. */
export const sidebarWidth = (windowWidth: number) => Math.max(SIDEBAR_MIN_WIDTH, Math.round(windowWidth * SIDEBAR_SHARE));
