# T3 Code analytics payload capture (2026-10-30)

T3 Code 0.1.3-nightly.20261026.3717, server from the installed bundle, 45 s, 1 request(s) to the sink: POST /batch/.

## Verdict

**No email address and no plain account id was sent.** No canary string appeared in any body in plain, base64 or base64url form.
- `@` anywhere in the bodies: none.
- `email` (any case) anywhere in the bodies: none.
- Paths, user name, hostname: none found.
- What is sent instead: unsalted SHA-256 hex of account identifiers (table below). These are stable pseudonyms, not anonymous: anyone who knows an account id can recompute the hash and match it.

## Canary → SHA-256 → where it appeared

| Canary | Value | SHA-256 (hex) | Hash sent in | Plain/base64 in body |
| --- | --- | --- | --- | --- |
| codexAccountId | `canary-codex-account-1234` | `3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a` | server.boot.heartbeat: distinct_id<br>install.owner_observed: distinct_id | no |
| openaiUserId | `user-canaryOpenAI5678` | `9a1ec07819133ae492391e158f870f2dcaae0403fad1e06d38b7a38ab9f704a6` | install.owner_observed: properties.ownerId | no |
| codexEmail | `canary.user@example.invalid` | `291cd770fd0930d53f33c79e11d51383dbda0e6d58d98e0a189e057b4bd6dce5` | — | no |
| codexName | `Canary Codex Name` | `6bf2a952c9227706eac4c67acb8639275babd8dc2cc6fac3cc1da94133080903` | — | no |
| claudeUserId | `canary-claude-userid-9999` | `abfe23dc6df7909ca372b4bddb7a9d122702c42ec427856d4015f1ca31ef7db4` | — | no |
| claudeAccountUuid | `canary-claude-uuid-4242` | `311049fede980dc9c10b444a76620a57438ab32e3854b55b6e76822189cdd06b` | install.owner_observed: properties.ownerId | no |
| claudeEmail | `canary.claude@example.invalid` | `2c0d6098f7ef533f82d7bcc7a957f7afca60ec3dd5ea75757a7611e786cd4373` | — | no |
| claudeDisplayName | `Canary` | `bd6617f00a64af4a5fa955f29eb1fcf18a651ccfe39fa7a30fb97b4482341ff1` | — | no |
| connectUserId | `canary-connect-user-7777` | `3c5392709af4aad9d1ae4dc098348b8c57eba821688a54910b8d35d82e055b3f` | install.owner_observed: properties.ownerId | no |
| anonymousInstallId | `canary-install-anon-1111` | `e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89` | server.boot.heartbeat: properties.installId<br>install.owner_observed: properties.installId | no |
| accessToken | `canary-access-token-abcd` | `625148b5d2fb97757ae820c587c7e0d8d3061dc41aa8fcacea3071bec1961a8d` | — | no |
| refreshToken | `canary-refresh-token-efgh` | `b6b18ac5e6f25c1692660e3e18266b5994135a99fdf3ea9895b4a846abd8cc05` | — | no |

## Events

- `server.boot.heartbeat` × 1
- `install.owner_observed` × 3

## Every property key and the values seen

| Key | Values |
| --- | --- |
| `distinct_id` | `"3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a"` |
| `event` | `"server.boot.heartbeat"`, `"install.owner_observed"` |
| `properties.$process_person_profile` | `false` |
| `properties.arch` | `"x64"` |
| `properties.clientType` | `"cli-web-client"` |
| `properties.installId` | `"e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89"` |
| `properties.observedBy` | `"server"` |
| `properties.ownerId` | `"3c5392709af4aad9d1ae4dc098348b8c57eba821688a54910b8d35d82e055b3f"`, `"9a1ec07819133ae492391e158f870f2dcaae0403fad1e06d38b7a38ab9f704a6"`, `"311049fede980dc9c10b444a76620a57438ab32e3854b55b6e76822189cdd06b"` |
| `properties.ownerSource` | `"connect"`, `"openai"`, `"claude"` |
| `properties.platform` | `"linux"` |
| `properties.projectCount` | `1` |
| `properties.serverAppVersion` | `"0.1.3-nightly.20261026.3717"` |
| `properties.serverArch` | `"x64"` |
| `properties.serverMode` | `"web"` |
| `properties.serverOs` | `"Linux"` |
| `properties.t3CodeVersion` | `"0.1.3-nightly.20261026.3717"` |
| `properties.telemetryChannel` | `"nightly"` |
| `properties.threadCount` | `1` |

## Evidence lines

```json
{"api_key":"phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m","batch":[{"uuid":"01a18bda-fa1d-7f4b-bd7d-687928542d3c","event":"server.boot.heartbeat","distinct_id":"3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a","properties":{"threadCount":1,"projectCount":1,"installId":"e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89","$process_person_profile":false,"platform":"linux","arch":"x64","t3CodeVersion":"0.1.3-nightly.20261026.3717","telemetryChannel":"nightly","clientType":"cli-web-client","serverOs":"Linux","serverArch":"x64","serverAppVersion":"0.1.3-nightly.20261026.3717","serverMode":"web"},"timestamp":"2026-10-30T08:09:06.333Z"},{"uuid":"01a18bda-fa1e-741b-868f-e0271d190eda","event":"install.owner_observed","distinct_id":"3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a","properties":{"ownerSource":"connect","ownerId":"3c5392709af4aad9d1ae4dc098348b8c57eba821688a54910b8d35d82e055b3f","observedBy":"server","installId":"e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89","$process_person_profile":false,"platform":"linux","arch":"x64","t3CodeVersion":"0.1.3-nightly.20261026.3717","telemetryChannel":"nightly","clientType":"cli-web-client","serverOs":"Linux","serverArch":"x64","serverAppVersion":"0.1.3-nightly.20261026.3717","serverMode":"web"},"timestamp":"2026-10-30T08:09:06.334Z"},{"uuid":"01a18bda-fa1e-7182-baee-a42b45e9f347","event":"install.owner_observed","distinct_id":"3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a","properties":{"ownerSource":"openai","ownerId":"9a1ec07819133ae492391e158f870f2dcaae0403fad1e06d38b7a38ab9f704a6","observedBy":"server","installId":"e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89","$process_person_profile":false,"platform":"linux","arch":"x64","t3CodeVersion":"0.1.3-nightly.20261026.3717","telemetryChannel":"nightly","clientType":"cli-web-client","serverOs":"Linux","serverArch":"x64","serverAppVersion":"0.1.3-nightly.20261026.3717","serverMode":"web"},"timestamp":"2026-10-30T08:09:06.334Z"},{"uuid":"01a18bda-fa1e-7844-827c-e919148c1495","event":"install.owner_observed","distinct_id":"3ec7084a37fa7e554d4d4dbe6ad92da2fb732706c1c2288860c3a3b6e6ff5b4a","properties":{"ownerSource":"claude","ownerId":"311049fede980dc9c10b444a76620a57438ab32e3854b55b6e76822189cdd06b","observedBy":"server","installId":"e75d17746ea02465e1ca8b89c9bc3d4b295281d5bb25cc1ee30b182037304b89","$process_person_profile":false,"platform":"linux","arch":"x64","t3CodeVersion":"0.1.3-nightly.20261026.3717","telemetryChannel":"nightly","clientType":"cli-web-client","serverOs":"Linux","serverArch":"x64","serverAppVersion":"0.1.3-nightly.20261026.3717","serverMode":"web"},"timestamp":"2026-10-30T08:09:06.334Z"}]}
```

## Method and scope

- Fresh empty `$HOME` in a temp dir with fake logins only: `~/.codex/auth.json` (account_id, unsigned id_token JWT carrying an email, a name and `https://api.openai.com/auth.user_id`, dummy access/refresh tokens), `~/.claude.json` (userID, oauthAccount with accountUuid, emailAddress, displayName), and T3 state `~/.t3/userdata/anonymous-id` plus a fake linked T3 Connect user id in the file secret store. The real ~/.codex, ~/.claude.json and ~/.t3 were never read.
- Linux: the bundle is the extracted AppImage (`squashfs-root`); the script ran the same app bundle's server (`app.asar/apps/server/dist/bin.mjs`) with the bundle's Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), `T3CODE_POSTHOG_HOST` set to a 127.0.0.1 sink, `T3CODE_NO_BROWSER=1`, and a minimal PATH so no provider CLI started. Telemetry identity, owners and `sendBatch` all live in this server process, so the payload is the same code path; the only expected difference is `clientType`/`serverMode` (`cli-web-client`/`web` instead of `desktop-app`/`desktop`).
- No client connected, so only boot-time events appear (`server.boot.heartbeat`, `install.owner_observed` observed by `server`). Client-side owners (`connect`/`device` from a connected UI) and turn/feature events were not exercised; per the bundle they carry the same hashed-owner shape.
- Scope: this shows what **T3 Code's server sends to its own PostHog** (default `https://ingest.t3.codes`). Telemetry sent by the provider CLIs themselves (Codex, Claude Code) is separate and out of scope.
- Processes: started 1 (own process group), left after kill: 0; temp HOME deleted: true. Raw bodies: capture.json (temp path and user name redacted).
