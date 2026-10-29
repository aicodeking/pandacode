// Harness names and logos. Logos are the desktop's originals (assets/providers/README.md),
// mapped as in the repository's src/provider-logos.ts (codex uses the OpenAI mark).
import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';

/** `mono` marks take a tint; `black` ones are dark tiles that sit on a light chip in dark mode. */
interface Harness { name: string; logo?: number; mono?: boolean; black?: boolean }

export const HARNESSES: Record<string, Harness> = {
  claude: { name: 'Claude Code', logo: require('../../assets/providers/claude.svg') },
  codex: { name: 'Codex', logo: require('../../assets/providers/openai.svg'), mono: true },
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
  nanobot: { name: 'Nanobot', logo: require('../../assets/providers/nanobot.svg') },
};

export const harnessName = (id: string) => HARNESSES[id]?.name ?? id;

/** A decorative harness mark; the row around it carries the name. Monochrome marks take `color`. */
export const HarnessLogo = memo(function HarnessLogo({ id, size = 14, color }: { id: string; size?: number; color?: string }) {
  const dark = useColorScheme() === 'dark';
  const harness = HARNESSES[id];
  if (!harness?.logo) return null;
  const image = <Image source={harness.logo} style={{ width: size, height: size }} contentFit="contain" tintColor={harness.mono ? (color ?? (dark ? '#ffffff' : '#000000')) : undefined} accessible={false} />;
  // A black tile vanishes on a dark surface; a white rim (the logo's own corner radius) keeps its edge.
  if (!harness.black || !dark || color) return image;
  return <View style={[styles.chip, { borderRadius: size * 0.28 }]}>{image}</View>;
});

const styles = StyleSheet.create({
  chip: { padding: 1, backgroundColor: 'rgba(255, 255, 255, 0.85)', overflow: 'hidden' },
});
