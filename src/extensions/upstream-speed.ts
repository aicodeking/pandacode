/** Provider speed tiers, live part: binds the pure arrangement in `upstream-speed-core.ts` to the extension state
 * (safe mode) and the user's layout (hide, reorder, restore). The model picker takes `liveSpeedView` as its
 * `speedView` option; without it the picker draws the upstream list. */
import { extensionsSnapshot } from './manager';
import { layout, layoutProject, orderedControls } from './layout-host';
import { speedView, type SpeedChoice, type SpeedView } from './upstream-speed-core';

export * from './upstream-speed-core';

const live = {
  safe: () => extensionsSnapshot().safeMode,
  order: (location: string, ids: readonly string[]) => orderedControls(location, ids),
  isHidden: (id: string) => layout.isHidden(id, layoutProject()),
};

/** The arranged choices of a model under the live layout. */
export function liveSpeedView(provider: string, model: string, tiers: readonly SpeedChoice[], chosen: string | null): SpeedView {
  return speedView(provider, model, tiers, chosen, live);
}
