# B4 fake browser

Spawn `node fake-browser.mjs <url>` with piped stdin kept open. It makes HTTP
requests without opening a desktop browser, follows at most **five redirects**
(six requests), including a loopback callback, then exits. It checks the initial
URL and every redirect before fetching: numeric HTTP `127.0.0.1` only, no user
info. Each request has a ten-second timeout. An HTTP error, outside redirect
or sixth redirect exits 1; success exits 0, with no stdout ready/result line.
`runBrowser()` and the transport-free `core/fake-browser.mjs` are exportable.

Environment `FAKE_BROWSER=follow` (default), `ignore` (no request and exits),
or `record` (append the URL plus newline to `FAKE_BROWSER_LOG`, no request and
exits). Record requires a fixture-owned log path. A hung follow request is
cancelled on stdin EOF or termination. This finite helper opens no HTTP control
server. Controls are the environment of the spawned process.

Sign-in provider (6): follow reaches B3 then the host's callback; ignore models
a user never completing; record lets a test inspect the intended authorization
URL. It can follow approval or denial callbacks. It does not evaluate HTML,
complete forms, paste a redirect or inject a host opener. The manual path uses
B3's page mode plus a subsequent approve request. Wiring the host's browser
replacement seam remains later product work; no system-browser test ran here.

Test: `node --test fake-browser.test.mjs` (two tests).
