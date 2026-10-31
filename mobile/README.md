# PandaCode mobile

Expo app (iOS + Android) that views and controls tasks running on your computers through
PandaCode Connect ([docs/remote-access.md](../docs/remote-access.md)). The phone never runs tasks.

```bash
npm install
EXPO_PUBLIC_PANDACODE_RELAY_URL=https://… EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID=… npx expo start
npm test          # node:test (crypto, request framing, message merge, live events, inbox, outbox, turns)
npx tsc --noEmit
npx expo lint
```

Put the two values in `mobile/.env` (`EXPO_PUBLIC_PANDACODE_RELAY_URL=https://your-relay`, `EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID=…`; the desktop names `PANDACODE_RELAY_URL`/`PANDACODE_GITHUB_CLIENT_ID` work too) and restart Metro with `npx expo start --clear`: the values are read when Metro starts, so an already-running Metro keeps the old ones. Without them the sign-in screen says which value is missing or invalid (the relay must be `https://host`, no path). Connect API for screens:
[src/connect/README.md](src/connect/README.md).

Screens: the inbox (`src/app/inbox.tsx`, sections from `src/store/inbox.ts`) lists every
computer's tasks; a task (`src/app/task/[device]/[session].tsx`) has a native Stack header (its
actions are bar button items, which iOS moves into the iPhone Duo's side rail) and a glass composer. Snoozes, phone-only pins and the outbox (`src/store/local.ts`, `outbox.ts`) live in
SecureStore; unsent messages go out in order when the relay reconnects or the computer comes online.

Demo mode (`src/demo.ts`): sign-in's **Explore the demo** seeds fake computers and tasks
(`src/demo-data.ts`); a fake host (`src/demo-host.ts`) answers sends, steers, approvals and stops
with a canned reply, and nothing touches the network. It stays on across launches until Settings →
Leave demo. App Review uses it, since reviewers have no desktop. For screenshots,
`EXPO_PUBLIC_PANDACODE_DEMO=1 npx expo start --clear` starts every launch in it. Never ship that flag on.

Settings → Account → Delete account… calls the relay's `DELETE /v1/account` (App Store guideline
5.1.1(v)), then erases this phone's secrets, snoozes, outbox and icon cache and signs out.

## App Store builds (EAS)

`app.json` holds the store values: version `1.0.0`, `ios.buildNumber` `1` and `android.versionCode` `1`
(starting points: `eas.json` uses remote app versions and `autoIncrement` for production), iPhone only
(`supportsTablet: false`), and `ios.privacyManifests` with the required-reason APIs React Native and the
Expo modules use (UserDefaults CA92.1, file timestamps C617.1, system boot time 35F9.1, disk space
E174.1; the app's own code uses SecureStore, which is the Keychain, and one cache file).

`ios.config.usesNonExemptEncryption` is `false`: the app's end-to-end encryption (X25519 + XChaCha20-Poly1305, `src/connect/crypto.ts`) uses only standard algorithms for its own users' data, the usual mass-market exemption case, so no encryption documentation or compliance code is needed. `true` would require Apple's `ITSEncryptionExportComplianceCode` in every build (ITMS-90592 otherwise). Details and the yearly BIS self-classification note are in `docs/app-store/SUBMITTING.md` step 8.

Fill in before building or submitting:

- EAS environment variables (`eas env:create`) in the `development`, `preview` and `production`
  environments: `EXPO_PUBLIC_PANDACODE_RELAY_URL` and `EXPO_PUBLIC_PANDACODE_GITHUB_CLIENT_ID`.
  Never put them in `eas.json`.
- `eas.json` → `submit.production.ios`: `ascAppId` (the app's Apple ID number in App Store Connect →
  App Information) and `appleTeamId` (developer.apple.com → Membership).
- `eas init` once, which writes `extra.eas.projectId` (and `owner`) into the app config.
- The website domain in `src/app/(tabs)/settings/index.tsx` (`SITE`, used for the Privacy Policy link).

The `development` profile is a simulator build; for a dev client, `npx expo install expo-dev-client`
and add `"developmentClient": true`.
