import type { ConfigContext, ExpoConfig } from 'expo/config';

// Connect build config. The app reads EXPO_PUBLIC_PANDACODE_RELAY_URL and
// EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID, which Metro inlines into the bundle. The desktop's
// names (PANDACODE_RELAY_URL, PANDACODE_GITHUB_CLIENT_ID), from the shell or mobile/.env, work too.
const ALIASES = { EXPO_PUBLIC_PANDACODE_RELAY_URL: 'PANDACODE_RELAY_URL', EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID: 'PANDACODE_GITHUB_CLIENT_ID' };
for (const [expo, desktop] of Object.entries(ALIASES)) {
  if (!process.env[expo] && process.env[desktop]) process.env[expo] = process.env[desktop];
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'PandaCode',
  slug: config.slug ?? 'pandacode',
  extra: {
    ...config.extra,
    relayUrl: process.env.EXPO_PUBLIC_PANDACODE_RELAY_URL ?? '',
    githubClientId: process.env.EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID ?? '',
  },
});
