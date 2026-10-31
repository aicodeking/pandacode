# PandaCode website

The static PandaCode website: the landing page (desktop app and iPhone app), the changelog,
the privacy policy, mobile app support and the PandaCode License (MIT-based). PandaCode is free, open source and collects nothing,
and the site follows suit: no cookies, no analytics, no remote fonts or scripts, and no
third-party requests of any kind. Downloads link to
[GitHub Releases](https://github.com/aicodeking/pandacode/releases/latest); the source is at
[github.com/aicodeking/pandacode](https://github.com/aicodeking/pandacode).

## Development

```sh
npm --prefix website ci
ASTRO_TELEMETRY_DISABLED=1 npm run site:dev
```

The site runs at `http://127.0.0.1:4173`. Node 22.12 or later is required. Stop a
background dev server with `npm --prefix website exec astro -- dev stop`.

## Structure

- `src/pages/index.astro` is the landing page. Links to the repository, releases, issues
  and security policy come from `project` in `src/lib/distribution.ts`, next to the
  unsigned-build notes shown under the download buttons (`DistributionNote.astro`).
- `src/components/MobileApp.astro` presents the iPhone app (PandaCode Connect) with resized
  copies of `docs/app-store/screenshots` in `public/assets/mobile-*.webp`.
- `src/components/OpenSource.astro` explains the license, no account, no telemetry and
  how to build from source. Keep its commands in step with the repository README.
- `src/components/NewFeatures.astro` is the What's New bento: each card's scene plays its
  `[data-step]` elements in order while on screen (`src/scripts/new-features.ts`).
- Page-wide motion lives in `src/motion.css` and `src/scripts/motion.ts` (hero entrance,
  leaves, parallax and tilt, scroll progress, staggered groups, fireflies). Steps are
  hidden only under `.motion-ready`, so without JavaScript or with reduced motion every
  scene shows its finished state; `public/static-motion.css` turns the hero entrance off
  when scripts are disabled. Never animate something people click on continuously:
  Playwright (and people) need it to hold still.

## Reading pages

`/changelog/`, `/privacy/`, `/support/` and `/license/` share `src/layouts/Page.astro`, `src/pages.css`
and `src/scripts/pages.ts` (reveals and the contents rail); the footer is
`src/components/SiteFooter.astro`. The changelog is built from `../releases/X.Y.Z.md` by
`src/lib/changelog.ts`, dated from `src/data/release-dates.json` (filled in by
`npm run release:version`), so redeploy the site after each release.

The privacy policy describes what the app actually sends (agent version checks, the
public price list, the services you connect). Change it whenever the app's network
behavior changes. The license page must match `LICENSE` in the repository root.

## Content Security Policy

`public/_headers` sets a strict CSP: `'self'` only, with no inline scripts or styles.
Write styles in `.css` files or Astro `<style>` blocks (bundled into external CSS),
never `style=""` attributes or inline `<script>` bodies. After a build, check that
`dist/**/*.html` contains no `<style` or ` style="`.

## Build and deploy

```sh
ASTRO_TELEMETRY_DISABLED=1 npm run site:build
```

Output is `website/dist`. `verify-assets.mjs` rejects app archives, installers,
signatures and checksum files in static assets: **builds belong on GitHub Releases,
never in `website/public` or `website/dist`.**

The site deploys as a static-assets-only Cloudflare Worker (`wrangler.jsonc`, Worker
name `pandacode-site`, serving `./dist` with `_headers` applied). From `website/`:

```sh
ASTRO_TELEMETRY_DISABLED=1 npm run build
npx wrangler login        # once; or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npx wrangler deploy
```

The public site, https://pandacode.bambooed.ai (the App Store privacy and support URLs:
`/privacy/` and `/support/`), is a second Worker, `pandacode-site-bambooed`, with the same
assets and a custom-domain route in `wrangler.bambooed.jsonc`. It is separate so that
deploying it never changes `pandacode-site` or the relay at `relay.bambooed.ai`:

```sh
ASTRO_TELEMETRY_DISABLED=1 npm run build
npx wrangler deploy -c wrangler.bambooed.jsonc
```

Redeploy it after every content change, and check that `/`, `/privacy/` and `/support/`
return 200. No account ID or secret is stored in the repository. Any other static host works too:
serve `dist/` and apply the headers from `public/_headers`.

## Tests

```sh
cd website
ASTRO_TELEMETRY_DISABLED=1 npx playwright test
```

Tests cover Chrome and WebKit, desktop and mobile, and reduced motion: the landing
page's controls and copy, download and source links, the What's New scenes, the reading
pages, pages without JavaScript, phone-width overflow, and that every request the site
makes is same-origin. Set `PANDACODE_SITE_URL` to test another server (for example a
production preview or a dev server on another port). Screenshots and traces go under
`/private/tmp/pandacode-landing-checks`.
