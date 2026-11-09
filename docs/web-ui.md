# Browser workspace (in development)

The browser entry reuses PandaCode's workspace components, design-system CSS,
color derivation, terminal and theme settings. It is not a second copy of the
agent engine. **Full feature parity is not implemented or accepted yet.**

## Runtime and authentication

Start a compatible native build with `--web-gateway`. The gateway defaults to
loopback `127.0.0.1:6082`; it is disabled without that flag. A production HTTPS
reverse proxy must preserve the configured Host and WebSocket Upgrade headers.
Set `--web-gateway-origin=https://your-host.example` to the exact external origin.
Do not expose the loopback listener directly or remove the existing access gate.

The native main window must remain open. Settings → Connections → Browser workspace
creates a one-time pairing code. Enter it on the browser pairing screen. Codes
expire after ten minutes and are never placed in URLs or browser storage.
The server issues a Secure, HttpOnly, SameSite=Strict session cookie and a
separate CSRF cookie. Mutations require the matching CSRF header. Host/Origin
checks apply to the HTTP/WebSocket boundary. HTTPS is required for Secure cookies
on real clients; localhost behavior differs between browser engines.

Only commands present in the checked-in registry may cross the native broker.
The broker invokes Tauri's existing typed wrappers in the main window; it does
not synthesize Invoke objects, evaluate JavaScript supplied by the network, or
expose gateway lifecycle/resolver commands to browser callers. Browser viewers
observe the same runtime and database. Automatic queue draining, turn checks,
limit resumes, model changes and software update timers belong to the native host.
Explicit user actions still use the host command APIs.

The `?web` flag is for development against a real same-origin gateway. It never
falls back to preview/sample data. An ordinary browser visit without web mode
retains upstream's explicit development preview. Gateway-served HTML marks web
mode before importing the entry module. Launcher and tray entry points stay
isolated from the full workspace.

## Appearance

Before importing the workspace, an authenticated browser loads the host's
revisioned appearance snapshot. Only theme, palette/VSIX theme, wallpaper
preferences, interface scale, legacy wallpaper toggle and compact layout cross
the bridge. Arbitrary localStorage, credentials and derived CSS caches do not.
Colors and metadata are validated and derived tokens are recomputed through the
same palette implementation. Accepted changes synchronize through the host;
imported browser preferences cannot export the host's storage wholesale.
The host additionally publishes a strict six-digit wallpaper accent seed as
read-only metadata. Bootstrap applies it before importing the palette; refresh
recomputes tokens rather than trusting an old browser CSS cache. Custom colors,
VSIX themes and the native sky-scene policy retain their existing precedence.

Browser interface sizing uses the existing CSS scaling path, without calling
Tauri webview zoom. Browser task export downloads Markdown to the client.
Native system tray/global shortcut/window decorations cannot exist literally
inside a web page; equivalent workspace actions and supported consoles still
need explicit acceptance. Existing host OS limitations remain visible.

## Verification

Run `npm run build` and `npm test`, then use the Playwright browser matrix.
Run the matrix with `PW_WEB_ENGINE=chromium npx playwright test -c
playwright.web.config.ts`, then repeat with `firefox` and `webkit`. Install
those engines first with `npx playwright install chromium firefox webkit`.
These browser tests use deterministic fixtures. Run `cargo test --locked
--manifest-path src-tauri/Cargo.toml --lib web_gateway` for the native
gateway tests, which also exercise real loopback HTTP and WebSocket traffic.
For the packaged native fixture, use `npm run web-e2e:build` and
`npm run test:web-e2e` with a desktop session and the Playwright Chromium browser installed. The
fixture uses its own application identifier and synthetic Git workspace.

The browser workspace is experimental. Its compatibility target is current
Chromium, Firefox, and WebKit browsers on desktop and touch layouts. Native
OS integrations and individual provider workflows have separate acceptance
requirements.

## Instance password sign-in

For an HTTPS instance, set `PANDACODE_WEB_PASSWORD_FILE` to the path of a
host-only credential file before starting PandaCode. Use a newly generated
32-byte random secret encoded as unpadded base64url (43 characters); keep it
in your password manager and restrict the file to the service account.
For example, create a new credential in a private directory without printing it:

```sh
(umask 077; set -C; openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > instance-password)
```

Never put the password in command arguments or a URL. The gateway rejects
a missing or malformed configured file and requires an HTTPS origin in
password mode. Without this setting, existing pairing remains available.

Enter the same instance password once in each browser. On the host, open
Settings → Connections → Browser workspace to choose 12 hours, 24 hours,
2 days, 1 week, or No limit for new sign-ins. The selection persists across
restarts. The host environment variable `PANDACODE_WEB_SESSION_LIMIT`
(`12h`, `24h`, `2d`, `7d`, or `none`) supplies the initial policy.
Changing the selection in Settings preserves existing sessions and their
original expiration. Timed sessions end at their deadline or a gateway restart.

No-limit sessions survive gateway restarts. PandaCode stores session and CSRF
hashes in `web-sessions.sqlite3` under the app data directory. A password or
origin change invalidates saved sessions. The browser cookie requests 400 days,
and browsers can expire it sooner or clear it. Each browser shows its session
label and expiration under Browser workspace. Match that label on the host to
revoke just that session, or use Sign out in the browser to revoke its own
session. Browser sessions cannot change the policy or revoke other sessions.
The gateway stays on loopback; retain your normal trusted HTTPS proxy and
access policy. No proxy-specific headers or integrations are required.
