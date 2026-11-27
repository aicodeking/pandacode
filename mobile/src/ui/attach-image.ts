// Fitting a picked photo to the host before upload. A modern phone camera is 12–48 MP, so the bytes
// routinely exceed the host's 5 MB limit and the image would simply be refused; instead it is
// downscaled to PHOTO_MAX_EDGE and re-encoded as JPEG, stepping the quality down until it fits.
//
// The decision itself is pure (store/attach.ts fitPlan/nextQuality/needsFit, unit-tested in node);
// this module only drives expo-image-manipulator. SDK 58's API is contextual: `manipulate(source)`
// builds a context, `renderAsync()` applies it, `saveAsync()` writes the result. `maxWidth`/
// `maxHeight` down-sample while decoding, so a huge photo is never fully loaded into memory.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { base64Size, fitPlan, needsFit, nextQuality, PHOTO_MAX_EDGE, type AttachLimits } from '../store/attach.ts';

/** The bytes that ride the upload: the picked image, or a fitted copy when it would not fit. */
export interface Fitted {
  base64: string;
  width: number;
  height: number;
}

/** Tries one resize+encode at `quality` and returns its base64 (with the encoded size). */
async function encode(uri: string, width: number, quality: number): Promise<Fitted | null> {
  try {
    const size = { width, height: null };
    const context = ImageManipulator.manipulate(uri, { maxWidth: PHOTO_MAX_EDGE, maxHeight: PHOTO_MAX_EDGE }).resize(size);
    const image = await context.renderAsync();
    const result = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG, base64: true });
    return result.base64 ? { base64: result.base64, width: result.width, height: result.height } : null;
  } catch {
    // A codec the device lacks, or a broken file: the caller keeps the picked bytes and the existing
    // refusal message explains them, which is better than failing the attach outright.
    return null;
  }
}

/**
 * The picked image's bytes, fitted when they need to be. `base64` and `width`/`height` come from the
 * picker; the result keeps the original bytes whenever they already fit, so a screenshot is never
 * re-compressed for no reason.
 */
export async function fitImage(uri: string, base64: string, width: number, height: number, limits: AttachLimits): Promise<Fitted> {
  const bytes = base64Size(base64);
  if (bytes <= 0 || !needsFit(bytes, width, height, limits)) return { base64, width, height };
  const plan = fitPlan(width, height);
  let scaledWidth = plan.kind === 'resize' ? plan.width : width;
  let quality: number | null = plan.kind === 'resize' ? plan.quality : null;
  // A small image that is merely too many bytes still needs re-encoding: start at the top quality.
  if (quality === null) quality = 0.8;
  while (quality !== null) {
    const fitted = await encode(uri, scaledWidth, quality);
    if (fitted && base64Size(fitted.base64) <= limits.maxImageBytes) return fitted;
    const lower = nextQuality(quality);
    if (lower === null) break;
    quality = lower;
    scaledWidth = Math.max(1, Math.round((scaledWidth * 3) / 4));
  }
  // Nothing fit: hand back the pick so the caller's refusal says why, rather than a silent failure.
  return { base64, width, height };
}
