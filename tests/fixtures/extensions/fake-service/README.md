# Fake API connection

Package only `extension.json` and `main.cjs` into a ZIP. The separate `service.cjs` is
a manual loopback fixture, not extension code. Start it explicitly with
`node tests/fixtures/extensions/fake-service/service.cjs`, then stop it with Ctrl+C.
It never reads real credentials, and deliberately echoes the dummy Bearer input in
an ignored response field (and a 401 body). The native `json-summary` adapter must
return neither. The browser preview is synthetic and makes no HTTP requests.

Install, review executable trust and enable the package. Click **Open fake service**,
enter a dummy credential in the host-owned password form, authorize the displayed
operation, then click **Run broker request**. Save/status do not contact the service.
Use summary, wait, redirect, large and failure to exercise typed responses. Closing,
revoking or disabling ends managed authorization; it does not undo remote effects.

The initial adapter supports exact GET endpoints, Bearer authorization, HTTPS (or
numeric loopback HTTP), no redirects, no request bodies/headers/query signing and
only a boolean `accepted` plus integer `count` (0–1,000,000) response projection.
Credentials are invocation-scoped opaque handles, not SDK values. Trusted executable
code still has normal user-account OS authority, including independent access to
credentials available to that account. No confinement claim is made.
