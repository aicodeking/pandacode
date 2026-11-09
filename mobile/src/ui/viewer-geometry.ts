// Where the viewer's image sits: pure, and runnable as worklets (tested in node).

export interface Rect { x: number; y: number; width: number; height: number }

/** The rect a `contain` image of this aspect (width / height) fills in a window. */
export function fitRect(aspect: number, width: number, height: number): Rect {
  'worklet';
  const fitted = width / height > aspect ? { width: height * aspect, height } : { width, height: width / aspect };
  return { ...fitted, x: (width - fitted.width) / 2, y: (height - fitted.height) / 2 };
}

/** How far a zoomed image may pan each way: it keeps covering the screen where it's big enough, and stays centred where it isn't, so it never pans into black. */
export function panBounds(aspect: number, scale: number, width: number, height: number): { x: number; y: number } {
  'worklet';
  const fitted = fitRect(aspect, width, height);
  return { x: Math.max(0, (fitted.width * scale - width) / 2), y: Math.max(0, (fitted.height * scale - height) / 2) };
}

/** `rect` scaled about the window's centre, then moved down by `dragY`: where a dragged image is on screen. */
export function draggedRect(rect: Rect, scale: number, dragY: number, width: number, height: number): Rect {
  'worklet';
  return {
    x: width / 2 + (rect.x - width / 2) * scale,
    y: height / 2 + (rect.y - height / 2) * scale + dragY,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** A thumbnail wholly off screen (or never laid out) has nothing to grow from. */
export function isOnScreen(rect: Rect, width: number, height: number): boolean {
  'worklet';
  return rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.x < width && rect.y + rect.height > 0 && rect.y < height;
}
