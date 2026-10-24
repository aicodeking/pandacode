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

Demo mode for screenshots: `EXPO_PUBLIC_PANDACODE_DEMO=1 npx expo start --clear` seeds fake
computers and tasks (`src/demo-data.ts`) and skips sign-in and the network. Never ship it on.
