// How the composer's tray fits its row, from measured natural widths (pt). Pure, tested in node.
// The model's name and the Effort and Permissions words come first and stay whole; the branch only
// shows when it has room to be read (it's in Task info anyway); icons, then a shorter model name,
// only when nothing else fits. Full access is always named: nobody should have to guess at it.

export interface TrayWidths { model: number; effort: number; mode: number; branch: number }
export interface TrayFit { model: number; branch: number | null; effortIcon: boolean; modeIcon: boolean }

export const TRAY_GAP = 10;
export const TRAY_ICON_WIDTH = 36;
/** Narrower than this a branch name can't be read, so it's left out rather than cropped. */
export const BRANCH_MIN = 140;
/** The logo and a few letters: the model's floor when even icons don't make room. */
export const MODEL_FLOOR = 64;

const total = (...parts: number[]) => parts.filter(p => p > 0).reduce((sum, p, i) => sum + p + (i ? TRAY_GAP : 0), 0);

export function trayFit(available: number, w: TrayWidths, fullAccess: boolean): TrayFit {
  const stages: [boolean, boolean][] = [[false, false], [true, false], [true, !fullAccess]];
  for (const [effortIcon, modeIcon] of stages) {
    const effort = w.effort && effortIcon ? TRAY_ICON_WIDTH : w.effort;
    const mode = w.mode && modeIcon ? TRAY_ICON_WIDTH : w.mode;
    const settings = total(w.model, effort, mode);
    if (settings > available) continue;
    // The branch takes what's left, if that's enough to read; at its natural width when there's more.
    const left = available - settings - TRAY_GAP;
    const branch = w.branch && !effortIcon && left >= Math.min(BRANCH_MIN, w.branch) ? Math.min(w.branch, left) : null;
    return { model: w.model, branch, effortIcon: !!w.effort && effortIcon, modeIcon: !!w.mode && modeIcon };
  }
  // Last resort: icons for both (Full access keeps its word) and the model name gives way.
  const effort = w.effort ? TRAY_ICON_WIDTH : 0;
  const mode = w.mode && !fullAccess ? TRAY_ICON_WIDTH : w.mode;
  const model = Math.max(MODEL_FLOOR, Math.min(w.model, available - total(effort, mode) - TRAY_GAP));
  return { model, branch: null, effortIcon: !!w.effort, modeIcon: !!w.mode && !fullAccess };
}
