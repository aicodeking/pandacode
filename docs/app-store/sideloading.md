# Installing the PandaCode iPhone app with SideStore or AltStore

The iPhone app ships to beta testers through [TestFlight](https://testflight.apple.com/join/TpY9PjJe).
This page covers the other route: a SideStore or AltStore source that installs an
unsigned IPA built from this repository. SideStore and AltStore sign that IPA with your
own Apple ID when you install it, so you do not need a developer account or a build of
your own.

It is the same app as the TestFlight build, built from `mobile/`. It is not an App Store
build and does not carry Apple's signature.

## Add the source

1. Install [SideStore](https://sidestore.io) or [AltStore](https://altstore.io) and finish
   its setup (it needs your Apple ID once, and SideStore needs its pairing file).
2. Open **Sources**, tap **+**, and paste one of these URLs:
   - While testing a pull request or a fork:
     `https://raw.githubusercontent.com/hongkongkiwi/pandacode/feat/sidestore-source/appstore/source.json`
   - After this work is merged upstream and the mobile release workflow has run once:
     `https://raw.githubusercontent.com/aicodeking/pandacode/main/appstore/source.json`
3. Open the **PandaCode** listing and tap **Get**. Choose **Free** when asked and sign in
   with your Apple ID so SideStore can sign the app.
4. When the install finishes, open PandaCode and connect it to the desktop app the same
   way as the TestFlight build.

SideStore refreshes sideloaded apps in the background before their 7-day signing
expires; if your phone has been off for a while, open SideStore and refresh PandaCode by
hand.

## Where the IPA comes from

There are two workflows, and either can publish the `ios-v<version>` release and refresh
`appstore/source.json`:

- [`mobile-release.yml`](../../.github/workflows/mobile-release.yml) builds an unsigned
  IPA on a `macos-latest` runner with no Apple credentials: `npx expo prebuild`, an
  `xcodebuild` archive with signing disabled, and the archive's `Payload/PandaCode.app`
  zipped into `PandaCode.ipa`. Use it for forks and for testing.
- [`mobile-testflight.yml`](../../.github/workflows/mobile-testflight.yml) builds once
  with EAS, downloads that build's `.ipa`, saves it on the release, and then submits the
  same build to TestFlight. The stored IPA is signed for App Store distribution, which
  SideStore and AltStore replace with your own Apple ID on install. It needs the
  `EXPO_TOKEN` repository secret and App Store Connect credentials configured in EAS.

Both run `scripts/release/mobile-source.mjs`, which writes `appstore/source.json` with the
version, build number, release date, byte size and the `ios-v<version>` download URL. The
updated `appstore/source.json` is committed back to `main` so the raw URL above always
names the newest build.

SideStore compares the source's version with the app's `CFBundleShortVersionString`, so
that field stays the plain version (`1.0.0`). The build number (`CFBundleVersion`, from
`ios.buildNumber` in `mobile/app.json`) is shown as the version's description, `Build 1`,
the same way TestFlight shows `1.0.0 (1)`.

## Building a release

Push a tag that matches the version in `mobile/app.json` (this uses the unsigned
workflow):

```sh
git tag ios-v1.0.0
git push origin ios-v1.0.0
```

Or run a workflow manually:

- **Mobile release (unsigned IPA)** — leave `publish` unchecked to only build the IPA as
  a workflow artifact; check it to create the release and commit the updated source.
- **Mobile TestFlight (EAS) and SideStore IPA** — builds with EAS, publishes the IPA, and
  (with `submit` checked) uploads the same build to TestFlight.

The unsigned build needs the repository variables `PANDACODE_RELAY_URL` and
`PANDACODE_GITHUB_CLIENT_ID`, the same public values the desktop release uses. Without
them the app installs but its sign-in screen reports the missing configuration. The EAS
workflow reads those values from the `production` environment in EAS instead, where
[`mobile/README.md`](../../mobile/README.md) says to create them.
