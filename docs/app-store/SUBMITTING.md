# Submitting PandaCode for iPhone to the App Store

A first submission, start to finish. You need an Apple Developer Program membership (paid,
active) and admin access to it, a Mac with Node 22, and this repository.

The app: `mobile/`, Expo SDK 58, bundle ID `com.aicodeking.pandacode`, iPhone only. It is a viewer
and controller for tasks running in the PandaCode desktop app, over PandaCode Connect
([docs/remote-access.md](../remote-access.md)). It never runs or downloads code.

Store text, review notes and privacy answers: [metadata.md](metadata.md). Screenshot sizes and
captions: [screenshots.md](screenshots.md).

## 0. Set your domain (done)

The store needs a privacy policy URL and a support URL that open. The site is live at
https://pandacode.bambooed.ai, served by the `pandacode-site-bambooed` Worker
(`website/wrangler.bambooed.jsonc`, custom domain `pandacode.bambooed.ai`):

- Privacy policy: https://pandacode.bambooed.ai/privacy/
- Support: https://pandacode.bambooed.ai/support/

To redeploy after a change: `cd website && npm ci && ASTRO_TELEMETRY_DISABLED=1 npm run build && npx wrangler deploy -c wrangler.bambooed.jsonc`.
Open both pages in a browser before you submit. The app's own Privacy Policy link is the `SITE`
constant in `mobile/src/app/(tabs)/settings/index.tsx`; it is set to `https://pandacode.bambooed.ai`.

## 0b. Deploy the relay's account deletion

The app's **Settings → Delete account** calls the relay's `DELETE /v1/account`, which is in
`relay/` but not yet on the live relay. Deploy it once before submitting (it only adds a route;
signed-in devices stay signed in):

```sh
cd relay && npm ci && npm test && npx wrangler deploy
```

Then check it answers: `curl -i -X DELETE https://relay.bambooed.ai/v1/account` should return
`401` (no token), not `404`.

## 1. Find your Team ID

1. Open <https://developer.apple.com/account> and sign in.
2. Scroll to **Membership details**. Copy **Team ID** (10 characters, like `AB12CD34EF`).

You need it for `eas.json` (`appleTeamId`) and EAS asks for it at the first build.

## 2. Register the bundle ID

EAS can do this for you at the first build. To do it by hand:

1. <https://developer.apple.com/account/resources/identifiers/list> → **+**.
2. Choose **App IDs** → Continue → **App** → Continue.
3. Description: `PandaCode`. Bundle ID: **Explicit**, `com.aicodeking.pandacode`.
4. Capabilities: tick **App Groups** only (the Live Activity extension reads the shared panda mark
   from `group.com.aicodeking.pandacode`). The app uses no push, iCloud or Sign in with Apple.
5. Continue → Register.
6. The Live Activity extension has its own App ID, `com.aicodeking.pandacode.LiveActivity`, with
   the same App Group, and the group itself is `group.com.aicodeking.pandacode`. EAS creates all
   three at the first build after Live Activities were added (`expo-widgets` in `app.json`, see
   [live-activities.md](live-activities.md)).

## 3. Create the app record in App Store Connect

1. <https://appstoreconnect.apple.com> → **Apps** → **+** → **New App**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Platforms | **iOS** |
   | Name | `PandaCode` (if taken: `PandaCode Connect`) |
   | Primary Language | **English (U.S.)** |
   | Bundle ID | `com.aicodeking.pandacode` (pick it from the list; it appears after step 2 or the first EAS build) |
   | SKU | `pandacode-ios` (any unique string you won't reuse; never shown to users) |
   | User Access | **Full Access** |

3. Create.
4. Open the app → **General → App Information**. Under **General Information**, copy
   **Apple ID** (a number like `6741234567`). That is the **ascAppId** for `eas submit`.

## 4. Install EAS and link the project

All commands run in `mobile/`.

```sh
cd mobile
npm ci
npm i -g eas-cli
eas login            # your Expo account; create one at https://expo.dev/signup
eas init             # creates the EAS project and writes extra.eas.projectId into the app config
```

`eas init` writes the project id. `app.config.ts` spreads the config from `app.json`, so commit
whatever file it changes.

`mobile/eas.json` already has the production profile. Replace the two placeholders
(`ASC_APP_ID`, `APPLE_TEAM_ID`) with your ids; the parts that matter:

```json
{
  "build": {
    "production": { "environment": "production", "autoIncrement": true }
  },
  "submit": {
    "production": {
      "ios": { "ascAppId": "6741234567", "appleTeamId": "AB12CD34EF" }
    }
  }
}
```

Use your own numbers from steps 1 and 3. Neither is secret; both may be committed.

## 5. Set the Connect build values

The app reads the relay URL and the GitHub OAuth client ID at build time (`app.config.ts`,
`src/connect/config.ts`). Without them the sign-in screen says Connect is not configured, and
App Review will reject a build that can't sign in.

Use the same values as the desktop release build (`PANDACODE_RELAY_URL`,
`PANDACODE_GITHUB_CLIENT_ID`). The relay is `https://relay.bambooed.ai` unless you run your own
(`relay/README.md`). The client ID is the GitHub OAuth App's, with **Enable Device Flow** on.

```sh
eas env:create --environment production --visibility plaintext \
  --name EXPO_PUBLIC_PANDACODE_RELAY_URL --value https://relay.bambooed.ai
eas env:create --environment production --visibility plaintext \
  --name EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID --value <your OAuth App client ID>
eas env:list --environment production
```

Both values end up inside the app bundle, so they are not secrets: `plaintext` is correct.
The relay URL must be `https://host` with no path or trailing slash.

Never set `EXPO_PUBLIC_PANDACODE_DEMO` in the production environment: it skips sign-in. The
reviewer demo is a button on the sign-in screen and needs no variable.

## 6. Build

```sh
eas build -p ios --profile production
```

The first time, EAS asks to sign in to your Apple account and offers to create the
distribution certificate and provisioning profile. Answer **Yes**.

The first build with Live Activities also lists a second target, `ExpoWidgetsTarget`
(`com.aicodeking.pandacode.LiveActivity`), and asks to register its App ID, the App Group
`group.com.aicodeking.pandacode` and a provisioning profile for it. Accept each prompt; a build
from an older binary's credentials fails to sign the extension otherwise. When it's done it prints a
link to the build on expo.dev; the `.ipa` stays there.

EAS keeps the build number (`appVersionSource: remote`) and raises it each build
(`autoIncrement`). The version shown in the store is `version` in `app.json` (`1.0.0`).

## 7. Upload to App Store Connect

```sh
eas submit -p ios --profile production --latest
```

It uploads the latest build to the app with `ascAppId`. EAS asks for an App Store Connect API
key the first time and can make one for you (or create one in App Store Connect → Users and
Access → Integrations → App Store Connect API, role **App Manager**).

After 5–30 minutes the build shows under **TestFlight → iOS Builds**, first as Processing.

## 8. Export compliance

`mobile/app.json` sets `"ios": { "config": { "usesNonExemptEncryption": false } }`
(`ITSAppUsesNonExemptEncryption = NO`). The app uses only standard, published algorithms
(X25519, XChaCha20-Poly1305) to protect its own users' data, and is free and publicly available,
which is the usual case for the mass-market exemption in Category 5, Part 2 of the US EAR. With
`NO`, App Store Connect asks no encryption questions per build and needs no encryption
documents or compliance code. Leave **App Information → App Encryption Documentation** empty.

Why not `YES`: `YES` tells Apple the app needs approved encryption documentation, and every
build must then carry the code Apple issues (`ITSEncryptionExportComplianceCode`). Without it
the upload is rejected with ITMS-90592.

The mass-market exemption usually comes with an annual self-classification report to the US
Bureau of Industry and Security (BIS), due each February for the previous year. See
[Export compliance](#export-compliance) below. This is not legal advice; confirm it for your
own situation.

## 9. TestFlight internal testing

Test on a real iPhone before you submit.

1. **TestFlight → Internal Testing → +** → group name `Team` → Create.
2. Add yourself and anyone on your team (they must be users in App Store Connect).
3. Add the build to the group. Paste the What to Test text from [metadata.md](metadata.md).
4. Install **TestFlight** on the phone, accept the invite, install PandaCode.
5. Check, on the phone:
   - [ ] **Explore the demo** works with Wi-Fi and cellular off, and leaves cleanly.
   - [ ] Sign in with GitHub. The computer you signed in to on the desktop (same GitHub account,
     Settings → Remote access → **Allow remote control** on) shows under Computers.
   - [ ] Its tasks show in the Inbox. A running task streams. An approval can be answered.
   - [ ] Start a new task; it runs on the computer.
   - [ ] Settings → **Delete account** removes the account and signs the phone out; the desktop
     shows itself signed out once its socket closes.
   - [ ] Light, dark and Reduce Transparency look right.

Internal builds need no review. External testing (people outside your team) needs a short
TestFlight review; skip it for 1.0 unless you want outside testers.

## 10. Fill in the store listing

Every field, where it lives, and what to put. Values are in [metadata.md](metadata.md).

**General → App Information**

| Field | Value |
|---|---|
| Name, Subtitle | metadata.md |
| Category | Primary Developer Tools, Secondary Productivity |
| Content Rights | Doesn't contain third-party content |
| Age Rating | Edit → answers in metadata.md → 4+ |
| License Agreement | Apple's standard EULA (leave as is) |
| App Encryption Documentation | step 8 |

**General → App Privacy**

| Field | Value |
|---|---|
| Privacy Policy URL | `https://pandacode.bambooed.ai/privacy/` |
| Data collection | metadata.md → App Privacy. Click **Publish** when done; it is separate from the version. |

**Monetization → Pricing and Availability**

| Field | Value |
|---|---|
| Price | Free |
| Availability | All countries (minus France if you answered No in step 8) |
| Pre-orders | Off |

**iOS App → 1.0 Prepare for Submission**

| Field | Value |
|---|---|
| iPhone 6.3" Display screenshots (required) | `docs/app-store/screenshots/iphone-6.3/01-inbox.png` … `06-settings.png`, in that order (screenshots.md) |
| iPhone 6.9" Display screenshots | `docs/app-store/screenshots/iphone-6.9/`, same six, same order |
| iPhone Duo screenshots (optional; badge) | outer display: `iphone-duo-outer/01` … `04`; inner display: `iphone-duo-inner/01` … `05` |
| Promotional Text, Description, Keywords | metadata.md |
| Support URL | `https://pandacode.bambooed.ai/support/` |
| Marketing URL | `https://pandacode.bambooed.ai/` |
| Version | `1.0.0` |
| Copyright | `2026 PandaCode contributors` |
| Routing App Coverage File | none |
| Build | **+** → pick the TestFlight build |
| Game Center | off |
| App Review Information → Sign-in required | **unticked** (the demo needs no account) |
| App Review Information → Contact, Notes | metadata.md |
| Attachment | optional: a 30 s screen recording of a real sign-in and an approval helps 4.8/2.1 questions |
| App Store Version Release | **Manually release this version** (you choose the day) |

**Phased release** (same page, below): choose **Release update over 7-day phased release**.
For a 1.0 it only applies to automatic updates, so it does nothing for new installs; leave it on
for 1.0.1 and later.

## 11. Submit for review

1. Top right: **Add for Review** → **Submit to App Review**.
2. Status goes Waiting for Review → In Review (usually within 24–48 h) → Pending Developer
   Release (or Rejected).
3. Keep the review contact phone and email answered. Reply to questions in **App Review →
   Messages**, not with a new build, unless they ask for one.

## 12. Release and go public

1. When the status is **Pending Developer Release**, open the version and click
   **Release This Version**. It appears on the App Store within a few hours (search takes up
   to a day).
2. Check the listing link (App Information → **View on App Store**) and put it on the website and
   in the README.
3. For every later version: bump `version` in `app.json`, run steps 6, 7, 9, 10 (new
   screenshots only if the UI changed: new captures, then `node docs/app-store/mockups/render.mjs` (re-renders every set); fill **What's New**), 11 and 12. Use phased release.

## Rejection checklist

What reviewers flag for an app like this, and what we did.

### 2.1 App completeness: the reviewer can't use it

Risk: the app is useless without a PandaCode desktop computer signed in to the same account, and
the reviewer has none. That reads as "can't access content" and is the most common rejection
for companion apps.

Done: **Explore the demo** on the sign-in screen opens the full app with sample computers and
tasks, no account, no network. The review notes give steps through it and offer a live call.
Never submit a build where the demo is missing or broken; check it in step 9.

### 4.8 Login services: GitHub sign-in without Sign in with Apple

Rule: an app that uses a third-party login for the user's primary account must also offer an
equal login option (Sign in with Apple or another that limits data to name and email, lets
the user hide email, and doesn't track).

Our position: 4.8 lists exceptions, among them an app that uses only its own account
system, and a client app for a specific third-party service whose users must sign in to that
service directly (read the current wording at
<https://developer.apple.com/app-store/review/guidelines/#login-services>). PandaCode has no accounts of its own. GitHub sign-in here is not a
convenience login: it is the identity that ties the phone to the user's own desktop app,
which signs in with the same GitHub account, and the relay uses it only to find that user's
devices. A Sign in with Apple account could never reach any computer, because the desktop app
can't sign in with it. The sign-in asks for no scopes (no email, no repositories) and nothing
is used for tracking. Put this in the review notes (it is in metadata.md).

Risk: medium. Reviewers sometimes apply 4.8 to any third-party login.

If rejected: reply in App Review → Messages with the paragraph above, and a recording showing
the desktop and phone signing in with the same account. If they hold the rejection, add
Sign in with Apple as an equal account: that needs the relay to accept an Apple identity token
and the desktop app to offer the same sign-in, so the two can still meet. That is real work in
`relay/`, `src-tauri/src/remote/` and `mobile/src/connect/`; plan it before arguing a second
round.

### 5.1.1(v) Account deletion

Rule: an app that lets you create an account must let you delete it in the app.

Done: **Settings → Delete account**. It calls the relay's `DELETE /v1/account`, which removes
the account and every device on it and closes their sockets; the phone signs out and forgets
its keys. The review notes say where it is. It does not touch the user's GitHub account; the
support page (`/support/#delete`) says how to also revoke the OAuth app in GitHub settings.

### 2.5.2 Downloading or executing code

Rule: apps may not download, install or execute code that changes the app's features.

Done: the app runs no code it downloads. Prompts and replies are text and Markdown, drawn as
text. Coding agents run on the user's own computer, and the phone only sends requests and shows
results. No OTA JavaScript updates are enabled in the store build (no `expo-updates`). Say it in
the notes; the "never runs code" line is in the description too.

### 4.2 Minimum functionality

Risk: "just a web view" or "a thin remote". Done: native screens throughout (native tab bar,
headers, sheets, Liquid Glass), an inbox across computers, live streaming, approvals,
questions, steering, new tasks, an offline outbox, and per-task model and permission settings.
The demo shows all of it.

### 2.3 Accurate metadata

Screenshots are the real app in demo mode. The description says what it needs (the desktop app
and a GitHub account). Keywords hold no other companies' trademarks.

### 5.1.1 Privacy policy and data

The privacy policy URL works and covers the mobile app and the relay. The App Privacy answers
match it and the code (metadata.md).

### Export compliance

The app encrypts messages end to end itself with standard, published algorithms (X25519,
HKDF-SHA256, XChaCha20-Poly1305, from the open-source `@noble/*` libraries), in addition to
HTTPS. That is not exempt "uses only Apple's encryption" use, so the answer is **standard
encryption algorithms** (step 8).

> **Not legal advice.** The following is our understanding. Confirm it with your own advice
> before you rely on it.

- US export rules (EAR): a free consumer app that uses standard encryption for its own data is
  usually **mass market**, ECCN **5D992.c**, under License Exception **ENC §740.17(b)(1)**.
  That needs no license for most countries.
- Since BIS's March 2021 rule, mass-market software like this usually needs **no annual
  self-classification report**; the report remains for some items (chips, components, kits).
  Check the current text of §740.17(b)(1) and Supplement 8 to Part 740 when you submit; if a
  report is needed, it goes to BIS and the NSA by **February 1** for the prior year.
- The source is public on GitHub. Publicly available encryption source code is generally not
  subject to the EAR (§734.3(b)(3), §742.15(b)), but the compiled App Store binary is still
  an export, which is why Apple asks.
- **France** requires a declaration (ANSSI) to supply products with encryption there. Either file
  it and answer Yes in step 8, or leave France out of availability for 1.0.
- Apple only needs a CCATS or other documents for proprietary or non-standard encryption. We
  use none.

## Android and Google Play (brief)

Same app, package `com.aicodeking.pandacode`.

1. Play Console → **Create app**: name PandaCode, App, Free, accept the declarations.
2. The two variables from step 5 already apply: EAS environments are shared across
   platforms.
3. `eas build -p android --profile production` makes an `.aab`. Upload the first one by hand
   (Testing → Internal testing → Create release), because Play needs one manual upload before
   the API works. Later: `eas submit -p android` with a Google service account key
   (Play Console → Setup → API access).
4. **App content**: Privacy policy `https://pandacode.bambooed.ai/privacy/`; Ads: No; App access: choose
   **All or some functionality is restricted** and give the demo steps (Explore the demo, no
   credentials); Data safety: the same data as the
   App Privacy table (User IDs, Device or other IDs; collected, not shared, encrypted in
   transit, deletable in the app); Account deletion: in-app path plus the URL
   `https://pandacode.bambooed.ai/support/#delete` for the web form question; Target audience: 18+, not for
   children.
5. New personal developer accounts must run a **closed test with at least 12 testers for 14
   days** before production access. Start that early.
6. Store listing: reuse the name, short description (80 max; `See and answer the coding agents on your computers.`, 52), full description, and phone screenshots (1080 × 1920 or larger, 16:9 or 9:16).
