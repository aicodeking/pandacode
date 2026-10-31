// Demo mode's attachment images (src/demo-data.ts names them): bundled assets, so the image
// grid and viewer work with no computer. Loaded only in demo mode (client.ts).
import { Asset } from 'expo-asset';

const IMAGES: Record<string, number> = {
  'demo-icon': require('../assets/images/icon.png'),
  'demo-splash': require('../assets/images/splash-icon.png'),
  'ws:docs/relay-diagram.png': require('../assets/images/splash-icon.png'),
};

/** The bundled image's local file URI, for any variant. */
export async function demoImage(id: string): Promise<string | undefined> {
  const module = IMAGES[id];
  if (module === undefined) return undefined;
  const asset = await Asset.fromModule(module).downloadAsync();
  return asset.localUri ?? asset.uri;
}
