// Harness names and logos. Logos are the desktop's originals (assets/providers/README.md),
// mapped as in the repository's src/provider-logos.ts (codex uses the OpenAI mark).
import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';

/** `mono` marks take a tint; `black` ones are dark tiles that sit on a light chip in dark mode. */
interface Harness { name: string; logo?: number; mono?: boolean; black?: boolean; /** Scale inside the box, for artwork with more margin than its neighbours: marks should read the same size. */ optical?: number }

export const HARNESSES: Record<string, Harness> = {
  claude: { name: 'Claude Code', logo: require('../../assets/providers/claude.svg') },
  codex: { name: 'Codex', logo: require('../../assets/providers/openai.svg'), mono: true, optical: 1.35 },
  opencode: { name: 'OpenCode', logo: require('../../assets/providers/opencode.png'), black: true },
  kimi: { name: 'Kimi', logo: require('../../assets/providers/kimi.png'), black: true },
  glm: { name: 'GLM', logo: require('../../assets/providers/glm.svg'), black: true },
  antigravity: { name: 'Antigravity', logo: require('../../assets/providers/antigravity.png') },
  grok: { name: 'Grok', logo: require('../../assets/providers/grok.png'), black: true },
  mimo: { name: 'MiMo', logo: require('../../assets/providers/mimo.png'), black: true },
  pi: { name: 'Pi', logo: require('../../assets/providers/pi.png') },
  deepseek: { name: 'DeepSeek', logo: require('../../assets/providers/deepseek.png') },
  commandcode: { name: 'Command Code', logo: require('../../assets/providers/commandcode.png'), black: true },
  cline: { name: 'Cline', logo: require('../../assets/providers/cline.svg'), mono: true },
  'github-copilot': { name: 'GitHub Copilot', logo: require('../../assets/providers/github-copilot.svg'), mono: true },
  muse: { name: 'Muse Code', logo: require('../../assets/providers/muse.svg') },
  devin: { name: 'Devin', logo: require('../../assets/providers/devin.svg'), mono: true },
  kilo: { name: 'Kilo Code', logo: require('../../assets/providers/kilo.svg'), mono: true },
  omp: { name: 'Oh My Pi', logo: require('../../assets/providers/omp.svg'), black: true },
  zcode: { name: 'ZCode', logo: require('../../assets/providers/zcode.svg'), mono: true },
  hermes: { name: 'Hermes', logo: require('../../assets/providers/hermes.svg') },
  cursor: { name: 'Cursor', logo: require('../../assets/providers/cursor.svg') },
};

export const harnessName = (id: string) => HARNESSES[id]?.name ?? id;

/** A decorative harness mark; the row around it carries the name. Monochrome marks take `color`. */
export const HarnessLogo = memo(function HarnessLogo({ id, size = 14, color }: { id: string; size?: number; color?: string }) {
  const dark = useColorScheme() === 'dark';
  const harness = HARNESSES[id];
  if (!harness?.logo) return null;
  // In dark, a black tile's rim comes out of its size, so the tile isn't bigger than its neighbours.
  const rimmed = harness.black && dark && !color;
  const drawn = (rimmed ? size - RIM * 2 : size) * (harness.optical ?? 1);
  const image = <Image source={harness.logo} style={{ width: drawn, height: drawn, margin: ((rimmed ? size - RIM * 2 : size) - drawn) / 2 }} contentFit="contain" tintColor={harness.mono ? (color ?? (dark ? '#ffffff' : '#000000')) : undefined} accessible={false} />;
  // A black tile vanishes on a dark surface; a white rim (the logo's own corner radius) keeps its edge.
  if (!rimmed) return image;
  return <View style={[styles.chip, { borderRadius: size * 0.28 }]}>{image}</View>;
});

const RIM = 1;

const styles = StyleSheet.create({
  chip: { padding: RIM, backgroundColor: 'rgba(255, 255, 255, 0.85)', overflow: 'hidden' },
});
