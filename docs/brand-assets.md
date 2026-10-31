# Provider brand assets

Retrieved from provider-owned sources on September 12, 2026. These marks identify the corresponding integrations in PandaCode. They are not PandaCode branding and do not imply sponsorship or endorsement. The marks remain the property of their respective owners; the application's source license does not grant trademark rights.

| Local file | Original source | Preparation | Bytes |
| --- | --- | --- | ---: |
| `src/assets/providers/claude.svg` | [Claude's official website](https://claude.com/) — the orange spark path in its `ClaudeWordmark` SVG | Extracted the separate spark path, unchanged, into a 125 × 125 SVG canvas. Preserved the official `#D97757` fill. No tracing or redrawing. | 1,992 |
| `src/assets/providers/openai.svg` | [OpenAI's official logo archive](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip), `OpenAI-logos(new)/SVGs/OpenAI-black-monoblossom.svg`, provided through its [design guidelines](https://openai.com/brand/) | Copied byte for byte. Preserved the black Blossom and its original canvas/clear space. Used to identify the OpenAI Codex integration. | 2,969 |
| `src/assets/providers/kimi.png` | [MoonshotAI/kimi-cli, web/public/logo.png](https://github.com/MoonshotAI/kimi-cli/blob/main/web/public/logo.png) ([raw asset](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/web/public/logo.png)) | Copied byte for byte. The official repository provides this 128 × 128 PNG icon; it was not traced into an invented vector. Upstream Git blob: `033c0f4fb2e28a9daeca0205812d15bf3e547893`. | 11,486 |
| `src/assets/providers/github-copilot.svg` | [GitHub Primer Octicons, `copilot-16.svg`](https://github.com/primer/octicons/blob/main/icons/copilot-16.svg) | Preserves the official Copilot mark and canvas; the SVG uses `currentColor` so PandaCode can tint it with the active theme's text color. | 1,566 |

| `src/assets/providers/zcode.svg` | Drawn for PandaCode (not retrieved): a rounded square with a bold Z. ZCode ships no redistributable brand asset at the time of writing; this placeholder mark identifies the integration and should be replaced with the official mark when z.ai publishes one. |
| `mobile/assets/providers/zcode.svg` | Byte-identical copy of `src/assets/providers/zcode.svg` (the mobile app mirrors desktop provider marks). |

The helper in `src/provider-logos.ts` resolves a fixed provider-to-local-asset mapping. Vite bundles the assets; rendering performs no remote brand-asset requests. Decorative images have empty alt text and `aria-hidden="true"`; adjacent provider text supplies the accessible name. Keep the logos proportional and preserve their colors when changing the interface.

SHA-256 checksums:

```text
2c98c5e8bc7c72a8faccaf501225ffe3ba2eb3a554e6bfc127c5485db1be3baf  claude.svg
7be72f1fea831d3ba81a545cee79b7e0ae69449d5d7837c9571ccbfb4aa1e00b  openai.svg
dbd00e2ad61ea8832ef0b024662a4a8a5d1b66f0599d5d42e1c9688b9d4cfdf6  kimi.png
ff361d2db319ff823a8d5c2385e338e57d530477455e9407ad8dc8e824b93020  github-copilot.svg
1124530aea0008f485e80b3a27d51968f99d80e585913bc1437499b78fbb67dc  kilo.svg
1cb65e5df9037ec4f6664e033a82de53a209fa4e49130959ef56e6bd9deee730  omp.svg
```

## PandaCode artwork

The app icon (`public/icon.svg`), decorative bamboo grove (`public/bamboo-grove.svg`), and interface bamboo mark in `src/dom.ts` are original vector artwork created for PandaCode. Native icons are generated from the app SVG with the Tauri icon command. Decorative grove silhouettes use theme-aware CSS masks; they do not animate, receive pointer events, or appear in the accessibility tree. Other provider logos remain unchanged.

- OpenCode: `https://opencode.ai/favicon-96x96-v3.png` (official website favicon, retrieved 2026-09-16).
- Z.AI / GLM: `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` (official chat.z.ai logo, retrieved 2026-09-16).
- Antigravity: `https://antigravity.google/assets/image/antigravity-logo.png` (official website logo, retrieved 2026-09-16).
- Xiaomi MiMo: `https://platform.xiaomimimo.com/favicon.png` (official open-platform site icon, 535 × 534 PNG, copied byte for byte, retrieved 2026-09-22; SHA-256 `30f5305380e8a2f85c652b905ef5e155e0c00c7d56d7ab6bd8b1eb40dad61ba7`). Identifies the MiMo Token Plan integration; the mark remains Xiaomi's property.
- Cline: `cline-hub/webview/icon.svg` from the official `@cline/cli-darwin-arm64` 3.0.73 npm package (`cline-logo-filled.svg`, copied byte for byte, retrieved 2026-10-22; SHA-256 `6aab009bf089a8dc1b5452c05c471244a08595b78fd639835eacc0821b887c06`). `src/provider-logos.ts` inlines it and swaps its `#1C1C24` fill for `currentColor` so it follows the theme's text color. Identifies the Cline integration; the mark remains Cline Bot Inc.'s property.
- Command Code: `https://commandcode.ai/favicon/2024/android-chrome-192x192.png` (official commandcode.ai site icon, 192 × 192 PNG, copied byte for byte, retrieved 2026-10-22; SHA-256 `27eab59595aa7570a8b4cdab2d79cff894ab9f47d49e870e68b031ddc1c69e88`). Identifies the Command Code integration; the mark remains Command Code's property.
- Muse Code: `https://static.xx.fbcdn.net/rsrc.php/yf/r/-7pQO6hUGK_.svg` (the official Meta infinity mark, the SVG site icon of meta.com and about.meta.com, 32 × 32, copied byte for byte, retrieved 2026-10-22; SHA-256 `9c354dc7d40f7862df2dfb34df05ae08c3e956d55a450379803d6cac6878a63e`). Identifies the Muse Code integration, which is Meta's; the mark remains Meta's property.
- Devin CLI: `https://devin.ai/favicon.svg` (official devin.ai site icon, 425 × 425 SVG, copied byte for byte, retrieved 2026-10-25; SHA-256 `fe0753d2e3823bc1eb8a37943234fac63733b8c9e8abff0ca0402a6c7ddcd682`). `src/provider-logos.ts` inlines it and swaps its `black` fill for `currentColor` so it follows the theme's text color. Identifies the Devin CLI integration; the mark remains Cognition's property.
- Hermes Agent: `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/assets/icon-master.svg` (official Hermes Agent master icon from NousResearch/hermes-agent, 1024 × 1024 SVG; SHA-256 `178f041b3bb637dbcfb328aed8c674fa8e3bd68ea8d34e0de017c7215f7c119f`). Preserves the official Nous Girl mark on a white squircle canvas. Identifies the Hermes Agent integration; the mark remains Nous Research's property.
- Grok (xAI): `https://grok.com/images/android-chrome-192x192.png` (official grok.com site icon, 192 × 192 PNG, copied byte for byte, retrieved 2026-09-21; SHA-256 `768cbbf7a7528d6e7b3af8112d7cde43eb6c9c8989ad9b06be8047dae1227463`). Identifies the Grok Build integration; the mark remains xAI's property.
- Kilo Code: `packages/kilo-docs/public/img/logo.svg` from the official `Kilo-Org/kilocode` repository and `kilo.ai` website header (retrieved 2026-10-24; SHA-256 `1124530aea0008f485e80b3a27d51968f99d80e585913bc1437499b78fbb67dc`). `src/provider-logos.ts` inlines it with `currentColor` so it follows the active theme's text color. Identifies the Kilo Code integration; the mark remains Kilo's property.
- Oh My Pi: `packages/collab-web/public/favicon.svg` from the official `can1357/oh-my-pi` repository and `https://omp.sh/favicon.svg` (retrieved 2026-10-24; SHA-256 `1cb65e5df9037ec4f6664e033a82de53a209fa4e49130959ef56e6bd9deee730`). Identifies the Oh My Pi integration; the mark remains Stencil Labs's property.
